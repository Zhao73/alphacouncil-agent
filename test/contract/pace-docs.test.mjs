import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { COUNCIL_PACES, COUNCIL_PACE_STAGE_TOTAL } from "../../mcp/lib/constants.mjs";
import { repoFile } from "../helpers/paths.mjs";

const read = (path) => readFileSync(repoFile(path), "utf8");

test("public fast-pace contracts stay aligned with the executable budget", () => {
  const profile = COUNCIL_PACES.fast;
  const configuredMinutes = (COUNCIL_PACE_STAGE_TOTAL(profile) / 60_000).toFixed(1);
  const selectorMinutes = Math.round(COUNCIL_PACE_STAGE_TOTAL(profile) / 60_000);
  const methodMinutes = profile.master_ms / 60_000;
  const primarySeconds = (profile.master_ms - profile.master_repair_reserve_ms) / 1_000;
  const reserveSeconds = profile.master_repair_reserve_ms / 1_000;

  assert.equal(configuredMinutes, "14.3");
  assert.equal(selectorMinutes, 14);
  assert.equal(methodMinutes, 2);
  assert.equal(primarySeconds, 120);
  assert.equal(reserveSeconds, 0);

  const skill = read("skills/alphacouncil-agent/SKILL.md");
  assert.match(skill, /method 2\/3\/4\.25 minutes per seat/u);
  assert.match(skill, /rounded\s+configured stage totals returned\s+by the selector are 14\/25\/58 minutes/u);

  const contract = read("docs/report-contract.md");
  assert.ok(contract.includes(`| \`fast\` | 15 min | ${configuredMinutes} min | not validated | 4 min | ${methodMinutes} min | 1.4 min | 1.5 min |`));
  assert.ok(contract.includes(`\`${primarySeconds}s primary with no cold timeout retry\``));

  const install = read("docs/INSTALL.md");
  assert.match(install, new RegExp(`are ${selectorMinutes}, 25 and 58 minutes; observed successful completion remains unvalidated`, "u"));

  const command = read("commands/alpha.md");
  assert.match(command, /配置分段约 14 分钟；完整完成实测：尚未验证  每证据席 4 分钟，每方法席 2 分钟，每轮辩论每侧 85 秒/u);
  assert.match(command, /fast` gives each evidence seat 4 minutes, each method seat 2 minutes,[\s\S]*85 seconds per round/u);

  const claude = read("CLAUDE.md");
  assert.match(claude, /fast` gives each evidence seat 4 minutes,[\s\S]*each method seat 2 minutes,[\s\S]*85 seconds per round/u);

  for (const [path, marker] of [
    ["docs/reference/README.en.md", `15 min (${configuredMinutes} configured) | not validated`],
    ["docs/reference/README.zh-CN.md", `15 分钟（配置约 ${configuredMinutes} 分钟） | 尚未验证`],
    ["docs/reference/README.ja.md", `15 分（設定約 ${configuredMinutes} 分） | 未検証`],
  ]) {
    assert.ok(read(path).includes(marker), `${path} must match the executable fast budget`);
  }

  for (const path of [
    "skills/alphacouncil-agent/SKILL.md",
    "docs/report-contract.md",
    "docs/INSTALL.md",
    "commands/alpha.md",
    "CLAUDE.md",
    "docs/reference/README.en.md",
    "docs/reference/README.zh-CN.md",
    "docs/reference/README.ja.md",
  ]) {
    assert.doesNotMatch(read(path), /13\.5 configured|配置约 13\.5 分钟|設定約 13\.5 分|method 1\.6\/3\/4\.25|method `87s \+ 8s`/u,
      `${path} still exposes the retired fast method budget`);
  }
});
