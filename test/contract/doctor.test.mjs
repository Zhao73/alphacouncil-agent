import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { repoRoot } from "../helpers/paths.mjs";

// doctor's exit code depends on the developer's machine (a second install, leaked files),
// so this asserts it runs and reports, not that it is clean.
test("doctor runs and reports on every area it covers", () => {
  const dataDir = makeDataDir();
  try {
    const result = spawnSync(process.execPath, ["scripts/doctor.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, ALPHACOUNCIL_AGENT_DATA_DIR: dataDir },
    });
    assert.ok(result.status === 0 || result.status === 1, `unexpected exit ${result.status}: ${result.stderr}`);
    for (const section of ["install", "personas", "manifests", "data dir"]) {
      assert.match(result.stdout, new RegExp(`^${section}$`, "m"), `missing section: ${section}`);
    }
    assert.match(result.stdout, /personas load/, "doctor must verify the persona set");
    assert.match(result.stdout, /mcp\/server\.mjs present/, "doctor must verify the entry point");
  } finally {
    removeDataDir(dataDir);
  }
});
