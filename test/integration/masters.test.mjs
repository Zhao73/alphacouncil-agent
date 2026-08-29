import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";
import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { expectedCoverageItems } from "../../mcp/lib/company-dossier.mjs";
import { RpcCode } from "../../mcp/lib/errors.mjs";
import { loadFactProducerCatalog } from "../../mcp/lib/personas-v3/fact-producer-catalog.mjs";

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
let companyDossierHash;

const selectedMasters = ["master_buffett", "master_munger", "master_duan_yongping", "master_li_lu"];
const companyGrounding = {
  gathered_at: "2026-08-03T12:00:00Z",
  facts_unavailable: true,
  instrument: {
    symbol: "ACME",
    name: "Acme master-lifecycle fixture corporation",
    asset_type: "equity",
    research_model: "operating_company",
    exchange: "NASDAQ",
    currency: "USD",
    classification_source: "masters_fixture",
  },
};

function evidencePacket(task) {
  const packet = {
    summary: `The ${task} fixture records sufficient English fund evidence for the visible method-stage barrier.`,
    claims: [{
      claim: `The ${task} fixture records one bounded fund observation for the visible method-stage barrier.`,
      claim_type: "event_or_observation",
      evidence: "The dated fixture source directly supports this bounded fund observation.",
      confidence: "medium",
      source_ids: ["S1"],
    }],
    metrics: {},
    sources: [{
      id: "S1",
      title: `${task} visible fund fixture source`,
      url: `https://example.com/masters-${task}`,
      published_at: "2026-08-01",
      retrieved_at: "2026-08-03",
    }],
    open_questions: [],
    coverage_items: expectedCoverageItems(task).map((id) => ({
      id,
      status: "covered",
      source_ids: ["S1"],
      note: "The dated fixture source covers this operating-company dossier item for lifecycle testing.",
    })),
    confidence: "medium",
    information_richness: "B",
  };
  if (task === "news_industry_management") {
    const regulatorItem = {
      title: "Fund regulator fixture filing",
      published_at: "2026-08-01",
      url: "https://regulator.example/fund-filing",
      source_id: "S1",
    };
    const issuerItem = {
      title: "Fund sponsor fixture release",
      published_at: "2026-08-01",
      url: "https://issuer.example/fund-news",
      source_id: "S2",
    };
    packet.sources = [
      { ...regulatorItem, id: "S1", retrieved_at: "2026-08-03" },
      { ...issuerItem, id: "S2", retrieved_at: "2026-08-03" },
    ];
    packet.official_source_coverage = {
      status: "complete",
      regulator: {
        status: "complete",
        entry_url: "https://regulator.example/fund-filings",
        checked_through: "2026-08-03",
        latest_dated_item: regulatorItem,
        dated_items_checked: [regulatorItem],
        gap: null,
      },
      issuer: {
        status: "complete",
        entry_url: "https://issuer.example/fund-newsroom",
        checked_through: "2026-08-03",
        latest_dated_item: issuerItem,
        dated_items_checked: [issuerItem],
        gap: null,
      },
    };
  }
  return packet;
}

function methodVoicePacket(master, stance, dossier = null, sourceId = "market_data:S1") {
  const sourceTask = sourceId.split(":", 1)[0];
  return {
    master,
    acknowledged_stance: stance,
    voice_mode: "first_person_public_method_simulation_v1",
    disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
    position_intent: ({
      constructive: "would_buy",
      cautious: "would_hold",
      opposed: "would_pass",
      out_of_scope: "not_in_my_circle",
    })[stance],
    voice: {
      would_i_act: "I would not take a directional position because this company dossier does not open my typed method gate.",
      what_i_see: "I see the complete hash-bound operating-company dossier and its explicit 52-item coverage ledger.",
      how_my_method_reads_it: "I apply my declared method only to the frozen record and keep the out-of-scope stance unchanged.",
      where_i_disagree: "I disagree with turning dossier coverage into a typed fact that the deterministic policy never received.",
      what_changes_my_mind: "I would reassess after dated company evidence supplies the method-critical typed inputs.",
    },
    key_findings: ["All eight evidence seats contributed to the frozen operating-company dossier."],
    disagreements: ["A deterministic decline is not a directional vote."],
    what_would_change_my_mind: ["A source-bound typed company fact could reopen the method gate."],
    source_ids: [sourceId],
    confidence: "low",
    company_dossier_hash_ack: companyDossierHash,
    evidence_packet_acks: (dossier?.packet_manifest || []).map((manifest) => manifest.task === sourceTask
      ? { task: manifest.task, packet_hash: manifest.packet_hash, status: "used", source_ids: [sourceId], note: "This method used the cited packet." }
      : { task: manifest.task, packet_hash: manifest.packet_hash, status: "reviewed_not_relevant", source_ids: [], note: "This method reviewed the packet but did not use it." }),
  };
}

before(async () => {
  dataDir = makeDataDir();
  runDir = join(dataDir, "runs", runId);
  server = startServer({ dataDir });
  await server.request("initialize", {});
  const selection = await confirmMasterSelection(server, {
    symbol: "ACME",
    selected_master_ids: selectedMasters,
  });
  selectionReceipt = selection.selection_receipt;
  plan = structured(await server.callTool("plan_visible_run", {
    symbol: "ACME",
    run_id: runId,
    as_of: "2026-08-03",
    tasks: DEFAULT_TASKS,
    grounding: companyGrounding,
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
    symbol: "ACME",
    selected_master_ids: selectedMasters,
  });
  productionSelectionReceipt = productionSelection.selection_receipt;
  productionPlan = structured(await productionServer.callTool("plan_visible_run", {
    symbol: "ACME",
    run_id: productionRunId,
    as_of: "2026-08-03",
    tasks: DEFAULT_TASKS,
    grounding: companyGrounding,
    selection_receipt: productionSelectionReceipt,
  }));
  for (const [targetServer, targetRunId] of [[server, runId], [productionServer, productionRunId]]) {
    for (const task of DEFAULT_TASKS) {
      structured(await targetServer.callTool("record_visible_packet", {
        run_id: targetRunId,
        task,
        packet: evidencePacket(task),
      }));
    }
  }
  companyDossierHash = JSON.parse(readFileSync(join(runDir, "company_dossier.json"), "utf8")).content_hash;
});

after(async () => {
  await server.close();
  await productionServer.close();
  removeDataDir(dataDir);
  removeDataDir(productionDataDir);
});

// This fixture exercises the company method-seat lifecycle, so it satisfies the real full
// evidence barrier: all eight roles and all 52 dossier coverage items are recorded first.
test("every declined v3 seat launches an independent first-person voice worker and waits", () => {
  const producerCatalog = loadFactProducerCatalog();
  const dossier = JSON.parse(readFileSync(join(runDir, "company_dossier.json"), "utf8"));
  assert.equal(dossier.coverage.expected_count, 52);
  assert.equal(dossier.coverage.covered_count, 52);
  assert.equal(dossier.content_hash, companyDossierHash);
  const spawned = plan.master_agents.map((agent) => agent.role);
  const declined = plan.masters_declined.map((d) => d.master);
  assert.deepEqual(declined, selectedMasters, "the evidence-light fund fixture must decline every selected company lens");
  assert.deepEqual(spawned, selectedMasters, "every selected v3 seat must receive exactly one worker");
  assert.equal(new Set(spawned).size, selectedMasters.length);
  for (const d of plan.masters_declined) {
    assert.equal(d.stance, "out_of_scope");
    assert.ok(d.unmet.length > 0, `${d.master} must say which requirement was unmet`);
    const agent = plan.master_agents.find((candidate) => candidate.role === d.master);
    assert.equal(agent.engine, "v3_method_runtime");
    assert.equal(agent.worker_kind, "visible_method_voice");
    assert.equal(agent.frozen_stance, "out_of_scope");
    assert.match(agent.output_contract, /five first-person voice fields/);
    assert.equal(plan.run.master_status[d.master].status, "waiting");
    assert.equal(plan.run.master_status[d.master].voice_required, true);
    const frozen = plan.run.master_opinions.find((opinion) => opinion.master === d.master);
    assert.equal(frozen.capability_status, "abstain_missing_fact");
    assert.ok(["estimated_only", "mixed", "recomputed", "not_evaluable"].includes(frozen.evidence_quality));
    assert.ok(Array.isArray(frozen.evidence_quality_basis));
    assert.equal(frozen.voice_status, "deterministic_only");
    assert.deepEqual(plan.run.master_status[d.master].evidence_quality_basis, frozen.evidence_quality_basis);
  }
  assert.equal(plan.run.fact_producer_catalog_hash, producerCatalog.catalog_hash);
});

test("each declined v3 seat completes only after its own first-person voice returns", async () => {
  for (const [index, master] of selectedMasters.entries()) {
    const beforeRecord = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
    const frozen = beforeRecord.master_opinions.find((opinion) => opinion.master === master);
    assert.ok(frozen, `${master} must have a frozen deterministic record before voice generation`);
    const threadId = `thread-${master}`;
    const voiceSourceId = index === 0 ? "news_industry_management:S2" : "market_data:S1";
    const recorded = structured(await server.callTool("record_master_opinion", {
      run_id: runId,
      master,
      thread_id: threadId,
      packet: methodVoicePacket(
        master,
        frozen.stance,
        JSON.parse(readFileSync(join(runDir, "company_dossier.json"), "utf8")),
        voiceSourceId,
      ),
    }));
    assert.equal(recorded.opinion.stance, "out_of_scope");
    assert.equal(recorded.opinion.voice_status, "model_voice");
    assert.equal(recorded.opinion.statement_origin, "visible_method_voice_worker");
    assert.equal(recorded.opinion.company_dossier_hash_ack, companyDossierHash);
    assert.equal(recorded.opinion.dedicated_worker.thread_id, threadId);
    assert.equal(recorded.opinion.capability_status, frozen.capability_status);
    assert.equal(recorded.opinion.evidence_quality, frozen.evidence_quality);
    assert.deepEqual(recorded.opinion.evidence_quality_basis, frozen.evidence_quality_basis);
    const frozenEvidenceSourceIds = Array.isArray(frozen.evidence_source_ids)
      ? frozen.evidence_source_ids
      : frozen.source_ids || [];
    assert.deepEqual(recorded.opinion.voice_source_ids, [voiceSourceId]);
    assert.ok(recorded.opinion.source_ids.includes(voiceSourceId));
    assert.deepEqual(recorded.opinion.evidence_source_ids, frozenEvidenceSourceIds);
    assert.equal(recorded.opinion.confidence, frozen.confidence);
    const persisted = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
    const persistedOpinion = persisted.master_opinions.find((opinion) => opinion.master === master);
    assert.deepEqual(persistedOpinion.voice_source_ids, [voiceSourceId]);
    assert.deepEqual(persistedOpinion.evidence_source_ids, frozenEvidenceSourceIds);
    assert.equal(persistedOpinion.confidence, frozen.confidence);
    assert.equal(persisted.master_status[master].status, "completed");
    assert.equal(persisted.master_status[master].voice_required, true);
    assert.equal(persisted.master_status[master].voice_status, "model_voice");
    assert.equal(persisted.master_status[master].capability_status, frozen.capability_status);
    assert.equal(persisted.master_status[master].evidence_quality, frozen.evidence_quality);
    assert.deepEqual(persisted.master_status[master].evidence_quality_basis, frozen.evidence_quality_basis);
    for (const pending of selectedMasters.slice(index + 1)) {
      assert.equal(persisted.master_status[pending].status, "waiting", `${pending} must wait for its own worker`);
    }
  }

  const run = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
  assert.ok(selectedMasters.every((master) => run.master_status[master].status === "completed"));
  assert.equal(new Set(run.master_opinions.map((opinion) => opinion.dedicated_worker?.thread_id)).size, selectedMasters.length);
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
  assert.equal(status.fact_producer_catalog_hash, loadFactProducerCatalog().catalog_hash);
});

test("solo-test v3 seats never fall back to legacy judgment agents", () => {
  assert.ok(plan.master_agents.every((agent) => agent.engine === "v3_method_runtime"));
  assert.ok(plan.master_agents.every((agent) => agent.worker_kind === "visible_method_voice"));
  // Every seat is accounted for in both the frozen decision ledger and the independent voice
  // roster, and none of them falls back to a legacy judgment engine.
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
  const prompt = munger.prompt_template || readFileSync(munger.prompt_file, "utf8");
  assert.match(prompt, /Evidence JSON:/);
  assert.match(prompt, /Walk-away conditions you must check/);
  assert.match(prompt, /out_of_scope/);
  // A master judges; it must not be told to go and search.
  assert.doesNotMatch(prompt, /WebSearch|live web search/);
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
        source_ids: ["market_data:S1"],
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
    symbol: "ACME",
    run_id: runId,
    tasks: DEFAULT_TASKS,
    grounding: companyGrounding,
    selection_receipt: selectionReceipt,
  }));
  // An idempotent re-plan returns the existing envelope; it must not erase opinions.
  const run = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
  assert.ok(Array.isArray(run.master_opinions));
  assert.deepEqual(replan.master_agents, [], "an idempotent replay must not launch a second voice worker");
  assert.equal(replan.masters_declined.length, 4);
  assert.ok(run.master_opinions.some((opinion) => opinion.master === "master_li_lu"));
});

// A deterministic decline remains pending until its selected seat's independent voice returns.
test("an all-declined roster is complete only after every selected voice returns", async () => {
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
  assert.equal(status.missing_evidence_count, 0);
  assert.equal(status.missing_debate_count, 3);
  assert.equal(status.selected_master_count, selectedMasters.length);
  assert.equal(status.missing_master_count, 0);
  assert.deepEqual(status.pending_masters, []);
  assert.equal(status.master_selection_status, "consumed");
});
