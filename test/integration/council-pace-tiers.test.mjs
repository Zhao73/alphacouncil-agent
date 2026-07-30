import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { COUNCIL_PACES } from "../../mcp/lib/constants.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

/**
 * Three depth tiers: fast 15 minutes, normal 30, slow 60.
 *
 * The tier has to move the per-stage caps as well as the total, because those are what bound
 * each worker. A 60-minute total with 150-second debate rounds finishes in twenty minutes and
 * wastes forty; a 15-minute total with 6-minute evidence caps starves the debate and terminates
 * incomplete. The budget also has to reach `status.json`, since two runs of one symbol at
 * different paces are not the same analysis.
 */

let dataDir;
let server;
let seq = 0;

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });
  await server.request("initialize", {});
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

async function plan(extra = {}) {
  seq += 1;
  const prompt = `Analyse AAPL with an explicit council pace (${seq}).`;
  // The tier is confirmed at the gate. Execution may repeat it but never change it, so a
  // fixture that wants a tier has to ask for it here.
  const confirmed = await confirmMasterSelection(server, {
    symbol: "AAPL", language: "en", prompt, selected_master_ids: ["master_buffett"],
    council_pace: extra.council_pace,
  });
  const runId = `PACE-TIER-${seq}-${process.pid}`;
  const response = await server.callTool("analyze_symbol", {
    symbol: "AAPL", language: "en", prompt, council_mode: "full", run_id: runId,
    dry_run: true, wait_for_completion: true,
    grounding: { facts_unavailable: true },
    selection_receipt: confirmed.selection_receipt,
    ...extra,
  }, { timeoutMs: 60_000 });
  return { runId, response };
}

test("each pace sets its own budget and records which tier produced the run", async () => {
  for (const [name, profile] of Object.entries(COUNCIL_PACES)) {
    const { runId, response } = await plan({ council_pace: name });
    const result = structured(response);
    assert.equal(result.run.council_pace, name);
    assert.equal(result.run.time_budget_ms, profile.total_ms, name);
    assert.equal(result.run.deadline_enforced, true, name);

    const status = JSON.parse(readFileSync(join(dataDir, "runs", runId, "status.json"), "utf8"));
    assert.equal(status.council_pace, name, `${name} must be auditable in status.json`);
    assert.equal(status.time_budget_ms, profile.total_ms, name);
    assert.equal(status.report_contract, "full_v2", "a pace changes depth, never the contract");
  }
});

test("an omitted pace is the 30-minute default", async () => {
  const { response } = await plan();
  const result = structured(response);
  assert.equal(result.run.council_pace, "normal");
  assert.equal(result.run.time_budget_ms, 30 * 60 * 1000);
});

test("a caller may lower its pace's budget but never exceed it", async () => {
  const lowered = structured((await plan({ council_pace: "slow", total_timeout_ms: 25 * 60 * 1000 })).response);
  assert.equal(lowered.run.time_budget_ms, 25 * 60 * 1000);
  assert.equal(lowered.run.council_pace, "slow", "lowering the budget does not change the tier");

  // Asking the fast tier for an hour is the mistake this rejection exists to catch: the caps
  // that bound each worker come from the tier, so the extra time would be idle.
  const { response } = await plan({ council_pace: "fast", total_timeout_ms: 40 * 60 * 1000 });
  assert.ok(response.error, "the fast tier must refuse an hour");
  assert.equal(response.error.data.reason, "FULL_TOTAL_TIMEOUT_EXCEEDS_MAX");
  assert.equal(response.error.data.council_pace, "fast");
  assert.equal(response.error.data.maximum_ms, COUNCIL_PACES.fast.total_ms);
  // The rejection has to say what the tiers cost, or the caller cannot pick the right one.
  assert.deepEqual(response.error.data.paces, {
    fast: COUNCIL_PACES.fast.total_ms,
    normal: COUNCIL_PACES.normal.total_ms,
    slow: COUNCIL_PACES.slow.total_ms,
  });
});

test("quick rejects a pace, because it is a smaller contract rather than a slower one", async () => {
  seq += 1;
  const prompt = "Quick read on AAPL.";
  const confirmed = await confirmMasterSelection(server, {
    symbol: "AAPL", language: "en", prompt, selected_master_ids: ["master_buffett"],
  });
  const response = await server.callTool("analyze_symbol", {
    symbol: "AAPL", language: "en", prompt, council_mode: "quick",
    run_id: `PACE-QUICK-${seq}-${process.pid}`, council_pace: "slow", dry_run: true,
    selection_receipt: confirmed.selection_receipt,
  });
  assert.ok(response.error);
  assert.equal(response.error.data.reason, "QUICK_PACE_FORBIDDEN");
});

test("an unrecognised pace is rejected rather than silently run at some other depth", async () => {
  // The gate rejects it first, which is the earlier and better place: nothing is approved, so
  // no receipt exists to execute. The execution-layer guard below is the second line.
  seq += 1;
  const prompt = `Analyse AAPL with a nonsense pace (${seq}).`;
  await assert.rejects(
    () => confirmMasterSelection(server, {
      symbol: "AAPL", language: "en", prompt, selected_master_ids: ["master_buffett"],
      council_pace: "glacial",
    }),
    /council_pace must be one of/,
  );

  // A caller that skips the gate's validation still cannot reach a run with a bogus tier.
  const confirmed = await confirmMasterSelection(server, {
    symbol: "AAPL", language: "en", prompt, selected_master_ids: ["master_buffett"],
  });
  const response = await server.callTool("analyze_symbol", {
    symbol: "AAPL", language: "en", prompt, council_mode: "full",
    run_id: `PACE-BOGUS-${seq}-${process.pid}`, dry_run: true, wait_for_completion: true,
    grounding: { facts_unavailable: true },
    selection_receipt: confirmed.selection_receipt,
    council_pace: "glacial",
  }, { timeoutMs: 60_000 });
  assert.ok(response.error);
  assert.equal(response.error.data.reason, "INVALID_COUNCIL_PACE");
  assert.deepEqual(response.error.data.allowed, ["fast", "normal", "slow"]);
});
