import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  AUTHORITY_FILES,
  checkInstallDocs,
} from "../../scripts/check-install-docs.mjs";
import { repoRoot } from "../helpers/paths.mjs";

function stagedAuthority() {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-install-docs-"));
  for (const path of AUTHORITY_FILES) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repoRoot, path), target);
  }
  return root;
}

test("current install authority satisfies the four-host Skill-first contract", () => {
  assert.deepEqual(checkInstallDocs(), { files: 5, hosts: 4, slashHosts: 3 });
});

test("install documentation gate excludes historical records", () => {
  assert.deepEqual(AUTHORITY_FILES, [
    "README.md",
    "README.zh-CN.md",
    "README.ja.md",
    "docs/INSTALL.md",
    "AGENTS.md",
  ]);
  assert.ok(!AUTHORITY_FILES.some((path) => (
    path === "CHANGELOG.md" || path.startsWith("docs/releases/") || path.startsWith("docs/plans/")
  )));
});

for (const violation of [
  "| Codex | `/alpha AAPL` |",
  "mkdir -p ~/.codex/prompts && cp commands/alpha.md ~/.codex/prompts/",
  "full headless is <=30m",
  "curl https://raw.githubusercontent.com/example/repo/main/install.sh | sh",
]) {
  test(`install documentation gate rejects: ${violation}`, () => {
    const root = stagedAuthority();
    try {
      appendFileSync(join(root, "README.md"), `\n${violation}\n`);
      assert.throws(() => checkInstallDocs(root), /install documentation contract failed/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
