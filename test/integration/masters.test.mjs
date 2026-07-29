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
// seat is still accounted for by its deterministic decline record; only a seat that actually
// reached a decision is worth a sequential model turn to explain.
test("a decline is recorded, accounts for itself, and costs no explanation worker", () => {
  const spawned = plan.master_agents.map((a) => a.role);
  const declined = plan.masters_declined.map((d) => d.master);
  // Not every selected seat declines any more, and that is the point: a seat holding SOME of
  // its required facts runs its own policy, where its authored vetoes decide. What must hold is
  // that a seat which declined has nothing to run, says what it lacked, and is never handed to
  // a model to write an essay about numbers that do not exist.
  assert.ok(declined.length > 0, "a HK filer with no computable screen must decline somewhere");
  assert.ok(declined.every((master) => selectedMasters.includes(master)), "a decline names a selected seat");
  for (const d of plan.masters_declined) {
    assert.equal(d.stance, "out_of_scope");
    assert.ok(d.unmet.length > 0, `${d.master} must say which requirement was unmet`);
    assert.equal(
      spawned.includes(d.master),
      false,
      `${d.master} abstained and has no stance to explain, so it must spawn nothing`,
    );
  }
});

test("a declined v3 seat completes on its deterministic record", () => {
  const run = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
  for (const { master } of plan.masters_declined) {
    assert.equal(
      plan.master_agents.find((candidate) => candidate.role === master),
      undefined,
      `${master} declined, so no worker may be scheduled for it`,
    );
    const opinion = (run.master_opinions || []).find((o) => o.master === master);
    assert.ok(opinion, `${master} must still be recorded or the completeness gate can never pass`);
    assert.equal(opinion.stance, "out_of_scope");
    assert.equal(opinion.engine, "v3_method_runtime");
    // The reader-facing guarantee is unchanged: every seat still carries a readable statement.
    assert.ok(opinion.voice_statement.length > 20);
    assert.equal(run.master_status[master].status, "completed");
    assert.equal(run.master_status[master].voice_required, false);
  }
});

test("solo-test v3 seats never fall back to legacy judgment agents", () => {
  assert.ok(plan.master_agents.every((agent) => agent.engine === "v3_method_runtime"));
  assert.ok(plan.master_agents.every((agent) => agent.worker_kind === "visible_method_voice"));
  // Every seat is accounted for -- as a decline or as a worker -- and none of them by a legacy
  // engine. The split between the two moves with the data and is not what this test pins.
  // Four buckets, and a seat lands in exactly one: it declined, it completed, it is being
  // explained, or its policy could not execute. The split moves with the data; what this pins
  // is that nothing falls out of all four.
  const accounted = new Set([
    ...plan.masters_declined.map((seat) => seat.master),
    ...(plan.masters_completed || []).map((seat) => seat.master),
    ...(plan.masters_blocked || []).map((seat) => seat.master),
    ...plan.master_agents.map((agent) => agent.role),
  ]);
  assert.deepEqual([...accounted].sort(), [...selectedMasters].sort(),
    "every selected seat is declined, completed or explained -- never dropped");
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
  assert.deepEqual(replan.master_agents, [], "every seat on this fixture declined, so none is worth a turn");
  assert.equal(replan.masters_declined.length, 4);
  assert.ok(run.master_opinions.some((opinion) => opinion.master === "master_li_lu"));
});

// The completeness gate is satisfied by the deterministic record itself. An all-declined
// roster therefore reaches the debate with zero method-seat model turns spent, instead of one
// per seat spent explaining that there was nothing to decide.
test("a roster where nothing was computable is still complete and accounted for", async () => {
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
  assert.equal(status.missing_evidence_count, 0);
  assert.equal(status.missing_debate_count, 3);
  assert.equal(status.selected_master_count, selectedMasters.length);
  assert.equal(status.missing_master_count, 0);
  assert.deepEqual(status.pending_masters, []);
  assert.equal(status.master_selection_status, "consumed");
});
