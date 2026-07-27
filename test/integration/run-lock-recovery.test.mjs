import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

let dataDir;
let server;

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });
  await server.request("initialize", {});
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

function runLock(runId, ownerPid, token) {
  const runs = join(dataDir, "runs");
  mkdirSync(runs, { recursive: true });
  const path = join(runs, `.${runId}.lock`);
  const created = Date.now() - 10_000;
  writeFileSync(path, `${JSON.stringify({
    schema_version: 1,
    lock_kind: "alphacouncil_run_exclusive",
    resource_kind: "run",
    resource_id: runId,
    operation: "crashed_start_fixture",
    token,
    owner_pid: ownerPid,
    owner_hostname: os.hostname(),
    created_at: new Date(created).toISOString(),
    lease_expires_at: new Date(created + 1).toISOString(),
  }, null, 2)}\n`);
  return path;
}

test("RPC start recovers a dead same-host run lock and removes its successor lease", async () => {
  const selection = await confirmMasterSelection(server, { symbol: "AAPL" });
  const runId = `RUN-LOCK-DEAD-${process.pid}`;
  const path = runLock(runId, 2_147_483_647, "11111111-1111-4111-8111-111111111111");
  const response = await server.callTool("plan_visible_run", {
    symbol: "AAPL",
    run_id: runId,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  });
  assert.ok(structured(response).run);
  assert.equal(existsSync(path), false, "withSelectedRun must token-release the recovered successor lock");
});

test("RPC start never steals a live owner after lease expiry and does not burn the receipt", async () => {
  const selection = await confirmMasterSelection(server, { symbol: "MSFT" });
  const runId = `RUN-LOCK-ACTIVE-${process.pid}`;
  const path = runLock(runId, server.child.pid, "22222222-2222-4222-8222-222222222222");
  const args = {
    symbol: "MSFT",
    run_id: runId,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: selection.selection_receipt,
  };
  const blocked = await server.callTool("plan_visible_run", args);
  assert.equal(blocked.error?.data?.reason, "RUN_IN_PROGRESS");
  assert.equal(blocked.error?.data?.lock_owner_pid, server.child.pid);
  assert.equal(blocked.error?.data?.lock_owner_state, "alive");
  assert.equal(existsSync(path), true);

  unlinkSync(path);
  const retried = await server.callTool("plan_visible_run", args);
  assert.ok(structured(retried).run, "lock contention must not consume the one-run receipt");
});
