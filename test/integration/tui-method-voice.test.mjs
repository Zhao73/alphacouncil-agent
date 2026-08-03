import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoFile } from "../helpers/paths.mjs";

test("TUI labels the simulation once and renders the action-first method voice", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alphacouncil-tui-voice-"));
  const runId = "TUI-FIRST-PERSON";
  const runDir = join(dataDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "status.json"), JSON.stringify({
    run_id: runId,
    symbol: "TEST",
    council_mode: "full",
    status: "complete",
    masters: ["master_buffett"],
    agents: [{ role: "master_buffett", status: "completed", completed_at: "2026-08-03T00:00:01Z" }],
  }));
  writeFileSync(join(runDir, "master_buffett.json"), JSON.stringify({
    master: "master_buffett",
    stance: "cautious",
    voice: {
      would_i_act: "我会继续观察，不会立刻动手。",
      what_i_see: "我看到证据仍有关键缺口。",
      how_my_method_reads_it: "我先看能力圈，再看所有者收益。",
      where_i_disagree: "我不同意用故事替代现金。",
      what_changes_my_mind: "如果现金证据补齐，我会重新判断。",
    },
  }));
  try {
    const output = execFileSync(process.execPath, [repoFile("tui/tui.mjs"), runId, "--demo", "1", "--lang", "zh"], {
      env: { ...process.env, ALPHACOUNCIL_AGENT_DATA_DIR: dataDir },
      encoding: "utf8",
    });
    assert.equal((output.match(/AI 公开方法模拟，非本人原话。/gu) || []).length, 1);
    assert.ok(output.indexOf("我会不会动手") < output.indexOf("我看到的"));
    assert.match(output, /我会继续观察/u);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
