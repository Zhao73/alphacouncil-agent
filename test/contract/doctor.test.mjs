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
    for (const section of ["install", "personas", "persona v3", "manifests", "host parity", "data dir"]) {
      assert.match(result.stdout, new RegExp(`^${section}$`, "m"), `missing section: ${section}`);
    }
    assert.match(result.stdout, /personas load/, "doctor must verify the persona set");
    assert.match(result.stdout, /corpus inventory/, "doctor must verify PersonaPack v3 admission inventory");
    assert.match(result.stdout, /runtime build profile\s+solo_test/, "doctor must identify the provisional runtime channel");
    assert.match(result.stdout, /solo-test runtime\s+26 physical provisional operator_lens; 52 derived-proxy tools; 0 method_model/, "doctor must report the exact solo-test maturity boundary");
    assert.match(result.stdout, /Formal PersonaPack v3 production GA is not passed/, "doctor must not imply formal GA");
    assert.match(result.stdout, /mcp\/server\.mjs present/, "doctor must verify the entry point");
    assert.match(result.stdout, /static four-host contract/, "doctor must validate the static host contract");
    assert.match(result.stdout, /live E2E not run/, "doctor must not imply a live host execution");
  } finally {
    removeDataDir(dataDir);
  }
});
