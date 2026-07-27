import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../helpers/paths.mjs";
import { buildTestPlan, sourceTestFiles } from "../../scripts/run-tests.mjs";

function portableUnitTestFiles(root) {
  const plan = buildTestPlan(root);
  const allUnitFiles = sourceTestFiles(root).filter((file) => file.startsWith("test/unit/") && file.endsWith(".test.mjs"));
  assert.ok(allUnitFiles.length > 5, "expected a non-empty unit-test suite");

  if (plan.mode === "source_with_staging") {
    return allUnitFiles;
  }

  assert.equal(plan.mode, "source_portable", `unexpected source test mode: ${plan.mode}`);
  const selected = new Set(plan.args.slice(1));
  const selectedUnitFiles = allUnitFiles.filter((file) => selected.has(file));
  const excludedUnitFiles = plan.excluded.filter((file) => file.startsWith("test/unit/"));

  assert.equal(selectedUnitFiles.length, allUnitFiles.length - excludedUnitFiles.length);
  for (const file of excludedUnitFiles) {
    assert.ok(!selected.has(file), `source_portable must exclude private-staging unit test: ${file}`);
  }
  return selectedUnitFiles;
}

/**
 * Unit tests must not reach the network.
 *
 * A DART test called the live endpoint to check how a rejected key is reported. It
 * passed everywhere except the Node 18 runner, where fetch failed for reasons unrelated
 * to the code -- a red build that says nothing about correctness. Live behaviour belongs
 * in manual verification; unit tests assert the mapping, not the round trip.
 */
test("every unit test runs with the network disabled", () => {
  const files = portableUnitTestFiles(repoRoot);
  const dataDir = mkdtempSync(join(tmpdir(), "alphacouncil-offline-check-"));
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...parentEnv } = process.env;
  const env = {
    ...parentEnv,
    // A parent node --test process sets this internal flag. Passing it to a
    // child makes recent Node versions skip the nested suite instead of running it.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --dns-result-order=ipv4first`.trim(),
    // Any outbound request resolves to a dead address rather than the real host.
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    no_proxy: "",
    NO_PROXY: "",
    ALPHACOUNCIL_AGENT_DATA_DIR: dataDir,
  };
  assert.equal(Object.hasOwn(env, "NODE_TEST_CONTEXT"), false, "nested unit suite must not inherit Node test context");

  try {
    const result = spawnSync(process.execPath, ["--test", ...files], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 180000,
      env,
    });
    assert.equal(
      result.status,
      0,
      `unit tests failed with the network blocked:\n${result.stdout?.slice(-3000)}\n${result.stderr?.slice(-3000)}`,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
