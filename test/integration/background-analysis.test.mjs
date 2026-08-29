import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

async function completedRun(server, runId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await server.callTool("read_run", { run_id: runId });
    if (response.result) {
      const run = structured(response);
      if (["complete", "degraded", "incomplete", "needs_verification", "needs_revision", "failed"].includes(run.status?.status)) return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`background run ${runId} did not settle within ${timeoutMs}ms`);
}

test("analyze_symbol returns a pollable run handle instead of holding an MCP call open", async () => {
  const dataDir = makeDataDir();
  const server = startServer({ dataDir });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "AAPL",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `BACKGROUND-ANALYSIS-${process.pid}`;
    const response = await server.callTool("analyze_symbol", {
      symbol: "AAPL",
      run_id: runId,
      dry_run: true,
      wait_for_completion: false,
      tasks: ["market_data"],
      selection_receipt: selection.selection_receipt,
    });
    const accepted = structured(response);

    assert.equal(accepted.accepted, true);
    assert.equal(accepted.run_id, runId);
    assert.equal(accepted.symbol, "AAPL");
    assert.equal(accepted.poll_tool, "read_run");
    assert.equal(accepted.status_json, join(dataDir, "runs", runId, "status.json"));
    assert.equal("decision" in accepted, false, "the acceptance response must stay small");
    assert.match(response.result.content[0].text, /^Accepted AlphaCouncil Agent analysis/);
    assert.ok(response.result.content[0].text.length < 300, "a nonterminal acceptance must remain a small text ACK");

    const immediateResponse = await server.callTool("read_run", { run_id: runId });
    assert.ok(immediateResponse.result, "an accepted run must be pollable immediately");
    const immediate = structured(immediateResponse);
    assert.match(immediateResponse.result.content[0].text, new RegExp(runId));
    if (["queued", "running"].includes(immediate.status.status)) {
      assert.match(immediateResponse.result.content[0].text, /call read_run again with this same run_id/);
      assert.doesNotMatch(immediateResponse.result.content[0].text, /^Loaded AlphaCouncil Agent run/u);
    } else {
      assert.match(immediateResponse.result.content[0].text, /No investment rating was produced/);
    }
    assert.ok(
      ["queued", "running", "incomplete"].includes(immediate.status.status),
      `unexpected immediate status: ${immediate.status.status}`,
    );

    const completed = await completedRun(server, runId);
    assert.equal(completed.status.status, "incomplete");
    assert.equal(completed.status.terminal, "incomplete");
    assert.deepEqual(completed.status.missing, [
      { stage: "debate", id: "round_1", reason: "round_not_completed" },
      { stage: "debate", id: "round_2", reason: "round_not_completed" },
      { stage: "debate", id: "round_3", reason: "round_not_completed" },
      { stage: "portfolio_manager", id: "portfolio_manager", reason: "skipped_upstream_gate" },
    ]);
    assert.deepEqual(completed.status.notes, [
      { stage: "methods", id: "master_buffett", reason: "deterministic_fallback" },
    ]);
    assert.equal(completed.status.stage_outcomes.methods.status, "degraded");
    assert.equal(completed.decision.verdict, "DRY_RUN");
    assert.equal(
      completed.events_summary.type_counts.background_run_queued,
      1,
      "the durable queued lifecycle must be recorded before background work starts",
    );
    assert.equal("evidence" in completed, false, "the default read_run detail must be compact");
    assert.equal("events" in completed, false, "compact polling returns an event summary, not the full log");

    const full = structured(await server.callTool("read_run", { run_id: runId, detail: "full" }));
    assert.equal(full.events.filter((event) => event.type === "background_run_queued").length, 1);
    assert.equal(full.evidence.run_id, runId, "detail=full preserves the legacy complete payload");
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("a calibrated headless run with no quote stops before every model worker", async () => {
  const dataDir = makeDataDir();
  const server = startServer({ dataDir });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "NBIS",
      prompt: "Is NBIS worth buying for a one-year holding period?",
      language: "English",
      objective: "directional_rating",
      holding_horizon: "1_year",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `BACKGROUND-RATING-REFERENCE-${process.pid}`;
    const response = await server.callTool("analyze_symbol", {
      symbol: "NBIS",
      run_id: runId,
      prompt: "Is NBIS worth buying for a one-year holding period?",
      language: "English",
      wait_for_completion: true,
      grounding: {
        facts_unavailable: true,
        unavailable: ["fixture deliberately omits quote and currency"],
      },
      selection_receipt: selection.selection_receipt,
    });
    const analysis = structured(response);

    assert.equal(analysis.run.status, "incomplete");
    assert.equal(analysis.run.terminal_reason, "pm_rating_reference_unavailable");
    assert.deepEqual(analysis.run.pm_rating_reference, {
      status: "unavailable",
      missing_fields: ["grounding.quote.price", "grounding.quote.currency"],
      downstream_model_calls_started: false,
    });
    assert.equal(analysis.decision.decision_available, false);
    assert.equal(analysis.decision.rating, null);
    assert.ok(Object.values(analysis.run.task_status).every((state) => state.status === "skipped"));
    assert.ok(Object.values(analysis.run.master_status).every((state) => state.status === "skipped"));

    const full = structured(await server.callTool("read_run", { run_id: runId, detail: "full" }));
    assert.equal(full.events.filter((event) => event.type === "worker_attempt_started").length, 0);
    const barrier = full.events.find((event) => event.type === "pm_rating_reference_unavailable");
    assert.ok(barrier);
    assert.equal(barrier.downstream_model_calls_skipped, true);
    assert.deepEqual(barrier.missing_fields, ["grounding.quote.price", "grounding.quote.currency"]);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
