import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";

test("the MCP diagnostic reads saved runs but keeps N_eff null", async () => {
  const dataDir = makeDataDir();
  const runId = "DIAGNOSTIC-RUN-1";
  const dir = join(dataDir, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "evidence.json"), `${JSON.stringify({
    run_id: runId,
    symbol: "NOK",
    as_of: "2026-07-27",
    masters: ["master_buffett", "master_taleb"],
    master_opinions: [
      { master: "master_buffett", stance: "cautious", source_ids: ["S1"] },
      { master: "master_taleb", stance: "out_of_scope", source_ids: ["S1"] },
    ],
  }, null, 2)}\n`);
  const server = startServer({ dataDir });
  try {
    await server.request("initialize", {});
    const listed = await server.request("tools/list", {});
    assert.ok(listed.result.tools.some((tool) => tool.name === "council_diagnostics"));
    const response = await server.callTool("council_diagnostics", { run_ids: [runId] });
    const result = structured(response);
    assert.equal(result.run_count, 1);
    assert.equal(result.descriptive_agreement[0].mean_pairwise_agreement, 0);
    assert.equal(result.behavioral_differentiation.verdict, null);
    assert.equal(result.independence.n_eff, null);
    assert.equal(result.independence.seat_count_is_independent_sample_count, false);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
