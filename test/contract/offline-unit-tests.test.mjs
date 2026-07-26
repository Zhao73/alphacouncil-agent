import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, repoFile } from "../helpers/paths.mjs";

/**
 * Unit tests must not reach the network.
 *
 * A DART test called the live endpoint to check how a rejected key is reported. It
 * passed everywhere except the Node 18 runner, where fetch failed for reasons unrelated
 * to the code -- a red build that says nothing about correctness. Live behaviour belongs
 * in manual verification; unit tests assert the mapping, not the round trip.
 */
test("every unit test runs with the network disabled", () => {
  const dir = repoFile("test/unit");
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs"));
  assert.ok(files.length > 5);

  const result = spawnSync(process.execPath, ["--test", ...files.map((f) => join(dir, f))], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 180000,
    env: {
      ...process.env,
      // Any outbound request resolves to a dead address rather than the real host.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --dns-result-order=ipv4first`.trim(),
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALPHACOUNCIL_AGENT_DATA_DIR: process.env.ALPHACOUNCIL_AGENT_DATA_DIR || "/tmp/alphacouncil-offline-check",
    },
  });
  assert.equal(result.status, 0, `unit tests failed with the network blocked:\n${result.stdout?.slice(-3000)}`);
});
