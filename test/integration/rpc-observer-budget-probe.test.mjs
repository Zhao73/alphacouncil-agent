import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import {
  observerBudget,
  startServer,
  structured,
} from "../helpers/rpc-client.mjs";

const PROBE_CEILING_MS = 1_500;
const PROBE_LEGACY_MS = 2_000;
const PROBE_DELAY_MS = PROBE_LEGACY_MS + 500;
const PROBE_CONTRACT_MS = observerBudget(PROBE_CEILING_MS);

test("a scaled delayed RPC response proves the legacy observer loses a valid result that the contract budget receives", {
  timeout: observerBudget(PROBE_DELAY_MS) + 10_000,
}, async () => {
  assert.equal(PROBE_LEGACY_MS * 15_000, PROBE_CEILING_MS * 20_000);
  assert.equal(PROBE_DELAY_MS - PROBE_LEGACY_MS, 500);
  assert.equal(PROBE_CONTRACT_MS, 16_500);

  const dataDir = makeDataDir();
  const delayedServer = join(dataDir, "delayed-observer-budget-rpc-server.mjs");
  writeFileSync(delayedServer, `
import { createInterface } from "node:readline";
const delayMs = Number(process.env.ALPHACOUNCIL_TEST_RPC_DELAY_MS || 0);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  const respond = () => process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: request.method === "initialize"
      ? {}
      : { structuredContent: { status: "delayed_response_received" } },
  }) + "\\n");
  if (request.method === "initialize") respond();
  else setTimeout(respond, delayMs);
}
`);
  const server = startServer({
    dataDir,
    entry: delayedServer,
    env: { ALPHACOUNCIL_TEST_RPC_DELAY_MS: String(PROBE_DELAY_MS) },
  });
  try {
    await server.request("initialize", {}, { timeoutMs: 5_000 });

    const rejectedBelowContract = assert.rejects(
      server.callTool("delayed_probe", {}, { timeoutMs: PROBE_LEGACY_MS }),
      /timed out after 2000ms waiting for tools\/call/u,
    );
    const receivedWithinContract = server.callTool("delayed_probe", {}, {
      timeoutMs: PROBE_CONTRACT_MS,
    });
    const [, recovered] = await Promise.all([rejectedBelowContract, receivedWithinContract]);
    assert.equal(structured(recovered).status, "delayed_response_received");
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
