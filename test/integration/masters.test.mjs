import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";
import { RpcCode } from "../../mcp/lib/errors.mjs";

let dataDir;
let server;
const runId = `MASTERS-${process.pid}`;
let runDir;
let plan;
let selectionReceipt;
let productionDataDir;
let productionServer;
let productionRunDir;
let productionPlan;
let productionSelectionReceipt;
const productionRunId = `MASTERS-PRODUCTION-${process.pid}`;

const selectedMasters = ["master_buffett", "master_munger", "master_duan_yongping", "master_li_lu"];

before(async () => {
  dataDir = makeDataDir();
  runDir = join(dataDir, "runs", runId);
  server = startServer({ dataDir });
  await server.request("initialize", {});
  const selection = await confirmMasterSelection(server, {
    symbol: "0700.HK",
    selected_master_ids: selectedMasters,
  });
  selectionReceipt = selection.selection_receipt;
  plan = structured(await server.callTool("plan_visible_run", {
    symbol: "0700.HK",
    run_id: runId,
    tasks: ["market_data"],
    selection_receipt: selectionReceipt,
  }));

  productionDataDir = makeDataDir();
  productionRunDir = join(productionDataDir, "runs", productionRunId);
  productionServer = startServer({
    dataDir: productionDataDir,
    env: { ALPHACOUNCIL_PERSONA_BUILD_PROFILE: "production" },
  });
  await productionServer.request("initialize", {});
  const productionSelection = await confirmMasterSelection(productionServer, {
    symbol: "0700.HK",
    selected_master_ids: selectedMasters,
  });
  productionSelectionReceipt = productionSelection.selection_receipt;
  productionPlan = structured(await productionServer.callTool("plan_visible_run", {
    symbol: "0700.HK",
    run_id: productionRunId,
    tasks: ["market_data"],
    selection_receipt: productionSelectionReceipt,
  }));
  for (const [targetServer, targetRunId] of [[server, runId], [productionServer, productionRunId]]) {
    structured(await targetServer.callTool("record_visible_packet", {
      run_id: targetRunId,
      task: "market_data",
      packet: {
        summary: "The market-data fixture records sufficient English evidence for the visible method-stage barrier.",
        claims: [], metrics: {}, sources: [], open_questions: [], confidence: "medium",
      },
    }));
  }
});

after(async () => {
  await server.close();
  await productionServer.close();
  removeDataDir(dataDir);
  removeDataDir(productionDataDir);
});

// 0700.HK is a Hong Kong listing, so the SEC screen computes nothing. Methods that need a
// long-run financial series genuinely cannot evaluate it, and spawning an agent to write an
// essay about numbers that do not exist is the waste this release removes. Every selected
// seat is still accounted for: the deterministic decline freezes the stance and the
// returned visible worker explains it without voting again.
test("a roster returns one explanation agent and one frozen record for every v3 seat", () => {
  const spawned = plan.master_agents.map((a) => a.role);
  const declined = plan.masters_declined.map((d) => d.master);
  assert.deepEqual(spawned.sort(), [...selectedMasters].sort());
  assert.deepEqual(declined.sort(), [...selectedMasters].sort());
  assert.ok(declined.length > 0, "a HK filer with no computable screen must decline somewhere");
  for (const d of plan.masters_declined) {
    assert.equal(d.stance, "out_of_scope");
    assert.ok(d.unmet.length > 0, `${d.master} must say which requirement was unmet`);
  }
});

test("a declined v3 seat has a fallback record but waits for its visible explanation worker", () => {
  const run = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
  for (const { master } of plan.masters_declined) {
    const agent = plan.master_agents.find((candidate) => candidate.role === master);
    assert.equal(agent?.worker_kind, "visible_method_voice");
    assert.equal(agent?.frozen_stance, "out_of_scope");
    const opinion = (run.master_opinions || []).find((o) => o.master === master);
    assert.ok(opinion, `${master} must still be recorded or the completeness gate can never pass`);
    assert.equal(opinion.stance, "out_of_scope");
    assert.equal(opinion.engine, "v3_method_runtime");
    assert.ok(opinion.voice_statement.length > 20);
    assert.equal(run.master_status[master].status, "waiting");
    assert.equal(run.master_status[master].voice_required, true);
  }
});

test("solo-test v3 seats use frozen explanation workers, never legacy judgment agents", () => {
  assert.deepEqual(plan.master_agents.map((agent) => agent.role).sort(), [...selectedMasters].sort());
  assert.ok(plan.master_agents.every((agent) => agent.engine === "v3_method_runtime"));
  assert.ok(plan.master_agents.every((agent) => agent.worker_kind === "visible_method_voice"));
  assert.equal(plan.masters_declined.length, selectedMasters.length);
  assert.ok(plan.masters_declined.every((seat) => seat.engine === "v3_method_runtime"));
});

test("the explicit production profile retains the legacy v1 prompt and v2 deterministic fallback", () => {
  assert.deepEqual(productionPlan.master_agents.map((agent) => agent.role).sort(), ["master_li_lu", "master_munger"]);
  assert.ok(productionPlan.master_agents.every((agent) => agent.engine === "v1_prompt"));
  assert.deepEqual(productionPlan.masters_declined.map((seat) => seat.master).sort(), ["master_buffett", "master_duan_yongping"]);
  assert.ok(productionPlan.masters_declined.every((seat) => seat.engine === "v2_method_model"));
});

test("a production-profile legacy master prompt carries evidence, walk-away conditions and out_of_scope", () => {
  const munger = productionPlan.master_agents.find((a) => a.role === "master_munger");
  assert.match(munger.prompt_template, /Evidence JSON:/);
  assert.match(munger.prompt_template, /Walk-away conditions you must check/);
  assert.match(munger.prompt_template, /out_of_scope/);
  // A master judges; it must not be told to go and search.
  assert.doesNotMatch(munger.prompt_template, /WebSearch|live web search/);
});

test("masters never appear among the evidence or debate agents", () => {
  const evidence = productionPlan.evidence_agents.map((a) => a.role);
  const debate = productionPlan.debate_agents.map((a) => a.role);
  for (const spec of productionPlan.master_agents) {
    assert.ok(!evidence.includes(spec.role));
    assert.ok(!debate.includes(spec.role));
  }
});

test("an unselected master is rejected", async () => {
  const response = await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_simons",
    packet: { verdict: "x" },
  });
  assert.equal(response.error?.code, RpcCode.INVALID_PARAMS);
  assert.match(response.error.message, /was not selected for this run/);
});

test("out_of_scope is preserved as a stance rather than coerced", async () => {
  const result = structured(await productionServer.callTool("record_master_opinion", {
    run_id: productionRunId,
    master: "master_buffett",
    packet: {
      verdict: "Outside the circle of competence",
      stance: "out_of_scope",
      summary: "Cannot explain how this business earns in one paragraph.",
      what_would_change_my_mind: ["a segment disclosure that shows unit economics"],
      confidence: "medium",
    },
  }));
  assert.equal(result.opinion.stance, "out_of_scope");
  // Seats that declined deterministically were already recorded during planning, so this
  // is not the first opinion on the run.
  assert.ok(result.recorded >= 1);
  assert.equal(result.expected, 4);
  assert.ok(existsSync(join(productionRunDir, "master_buffett.json")));
});

// This used to fall back to "cautious", which is a real stance carrying real weight: a
// caller's typo became a seat that looked deliberate and voted. Ten of them render as a
// unanimity no master produced. Declining to score an unrecognised value is the safe
// failure; inventing a confident one is not.
test("an unrecognised stance is recorded as out_of_scope, not as a vote", async () => {
  const result = structured(await productionServer.callTool("record_master_opinion", {
    run_id: productionRunId,
    master: "master_munger",
    packet: {
      verdict: "The evidence does not support a scored method decision.",
      stance: "wildly bullish",
      summary: "This fixture supplies valid English prose while testing stance normalization only.",
    },
  }));
  assert.equal(result.opinion.stance, "out_of_scope");
});

test("stances a caller plausibly writes are mapped rather than discarded", async () => {
  const cases = [["long", "constructive"], ["avoid", "opposed"], ["hold", "cautious"], ["N/A", "out_of_scope"]];
  for (const [given, expected] of cases) {
    const result = structured(await productionServer.callTool("record_master_opinion", {
      run_id: productionRunId,
      master: "master_munger",
      packet: {
        verdict: "The evidence supports only the normalized stance in this test fixture.",
        stance: given,
        summary: "This fixture supplies valid English prose while testing stance aliases only.",
      },
    }));
    assert.equal(result.opinion.stance, expected, `${given} should normalize to ${expected}`);
  }
});

// A provisional v3 seat is settled only by its deterministic path. Narrative writes cannot
// replace it, and an idempotent re-plan must retain the already recorded v3 opinion.
test("legacy narrative writes cannot replace a frozen v3 opinion", async () => {
  const legacyWrite = await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_li_lu",
    packet: {
      verdict: "Ten-year certainty is low",
      stance: "opposed",
      summary: "s",
      disagreements: ["the evidence chain assumes the regulatory regime is stable"],
      confidence: "high",
    },
  });
  assert.equal(legacyWrite.error?.code, RpcCode.INVALID_PARAMS);
  assert.equal(legacyWrite.error?.data?.reason, "VISIBLE_MASTER_FROZEN_STANCE_MISMATCH");
  const replan = structured(await server.callTool("plan_visible_run", {
    symbol: "0700.HK",
    run_id: runId,
    tasks: ["market_data"],
    selection_receipt: selectionReceipt,
  }));
  // An idempotent re-plan returns the existing envelope; it must not erase opinions.
  const run = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
  assert.ok(Array.isArray(run.master_opinions));
  assert.deepEqual(replan.master_agents.map((agent) => agent.role).sort(), [...selectedMasters].sort());
  assert.equal(replan.masters_declined.length, 4);
  assert.ok(run.master_opinions.some((opinion) => opinion.master === "master_li_lu"));
});

test("every returned v3 explanation worker is required by the completeness gate", async () => {
  const beforeStatus = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
  assert.equal(beforeStatus.missing_evidence_count, 0);
  assert.equal(beforeStatus.missing_master_count, selectedMasters.length);
  assert.deepEqual(beforeStatus.pending_masters.sort(), [...selectedMasters].sort());

  for (const agent of plan.master_agents) {
    const result = structured(await server.callTool("record_master_opinion", {
      run_id: runId,
      master: agent.role,
      thread_id: `thread-${agent.role}`,
      packet: {
        master: agent.role,
        acknowledged_stance: agent.frozen_stance,
        statement: `The ${agent.role} visible explanation preserves its frozen stance and explains the missing method-critical evidence without manufacturing a vote.`,
        key_findings: ["The deterministic typed-fact gate did not have the required method input."],
        disagreements: [],
        what_would_change_my_mind: ["Provide the missing fact from a dated primary source."],
        source_ids: [],
        confidence: "low",
      },
    }));
    assert.equal(result.opinion.statement_origin, "visible_method_voice_worker");
  }
  const replan = structured(await server.callTool("plan_visible_run", {
    symbol: "0700.HK", run_id: runId, tasks: ["market_data"], selection_receipt: selectionReceipt,
  }));
  assert.equal(replan.master_agents.length, 0, "completed visible voices must not be respawned on replay");
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
  assert.equal(status.missing_debate_count, 3);
  assert.equal(status.selected_master_count, selectedMasters.length);
  assert.equal(status.missing_master_count, 0);
  assert.deepEqual(status.pending_masters, []);
  assert.equal(status.master_selection_status, "consumed");
});
