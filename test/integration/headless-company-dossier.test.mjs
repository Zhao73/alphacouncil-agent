import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { verifyCompanyDossierArtifact } from "../../mcp/lib/company-dossier.mjs";
import { buildCompanySourceAcquisitionPlan } from "../../mcp/lib/company-source-acquisition.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import {
  SETTLEMENT_HEADROOM_MS,
  confirmMasterSelection,
  observerBudget,
  startServer,
  structured,
} from "../helpers/rpc-client.mjs";

const AS_OF = "2026-08-03";
const SELECTED_MASTER = "master_buffett";
const USER_PROMPT = "Run the complete operating-company council against the bounded integration fixture.";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function fakeHeadlessCompanyCodex(dataDir) {
  const driver = join(dataDir, "fake-headless-company-codex.mjs");
  const log = join(dataDir, "headless-company-workers.jsonl");
  writeFileSync(driver, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const tasks = ${JSON.stringify(DEFAULT_TASKS)};
const regularTask = tasks.find((id) => prompt.includes("Task:" + id) || prompt.includes("Task: " + id)) || null;
const repairTask = /Target task:\\s*([a-z_]+)/u.exec(prompt)?.[1] || null;
const task = regularTask || (tasks.includes(repairTask) ? repairTask : null);
const originalMaster = /dedicated, isolated method-seat explanation worker[^\\n]*\\((master_[a-z0-9_]+)\\)/iu.exec(prompt)?.[1] || null;
const repairMaster = /Master ID:\\s*(master_[a-z0-9_]+)/u.exec(prompt)?.[1] || null;
const master = originalMaster || repairMaster;
const role = /You are the portfolio_manager|Role:\\s*portfolio_manager/iu.test(prompt) ? "portfolio_manager"
  : /You are the bull_researcher|Role:\\s*bull_researcher/iu.test(prompt) ? "bull_researcher"
  : /You are the bear_researcher|Role:\\s*bear_researcher/iu.test(prompt) ? "bear_researcher"
  : master || task || "unknown";
const round = Number(/Debate round:\\s*(\\d+)/u.exec(prompt)?.[1] || 0);
const ledgerRepair = prompt.includes("SOURCE-ACQUISITION LEDGER TRANSPORT REPAIR ONLY");
const dossierHash = /Content hash:\\s*(sha256:[a-f0-9]{64})/u.exec(prompt)?.[1]
  || /company_dossier_hash_ack[^a-f0-9]*(sha256:[a-f0-9]{64})/u.exec(prompt)?.[1]
  || null;
const lineJson = (prefix) => {
  const line = prompt.split("\\n").find((item) => item.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : [];
};
const evidencePrefixes = ["Evidence JSON: ", "Bounded shared evidence JSON: "];
const evidenceLine = prompt.split("\\n").find((item) => evidencePrefixes.some((prefix) => item.startsWith(prefix)));
const evidencePrefix = evidenceLine ? evidencePrefixes.find((prefix) => evidenceLine.startsWith(prefix)) : null;
const promptEvidence = evidenceLine ? JSON.parse(evidenceLine.slice(evidencePrefix.length)) : null;

appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  role,
  task,
  master,
  round,
  dossier_hash: dossierHash,
  requires_full_dossier_read: /Read the JSON file in full before answering/iu.test(prompt),
  uses_server_verified_projection: /server-verified decision projection/iu.test(prompt),
  uses_server_verified_method_projection: /server-verified method projection/iu.test(prompt),
  has_dossier_path: /company_dossier\\.json/iu.test(prompt),
  has_evidence_path: /evidence\\.json/iu.test(prompt),
  projection_contract: promptEvidence?.projection_contract || null,
  projection_route_count: (promptEvidence?.packets || [])
    .reduce((total, packet) => total + (packet.routes || []).length, 0),
  prompt_chars: prompt.length,
  search: args.includes("--search"),
  outputSchema: args.includes("--output-schema"),
  ledger_repair: ledgerRepair,
}) + "\\n");

let packet;
if (task) {
  const coverageLine = prompt.split("\\n")
    .find((line) => line.startsWith("Required coverage IDs JSON: "));
  const acquisitionRoutes = lineJson("Frozen source plan: ");
  const coverageIds = coverageLine
    ? JSON.parse(coverageLine.slice("Required coverage IDs JSON: ".length))
    : acquisitionRoutes.length
      ? acquisitionRoutes.map((item) => item.coverage_id)
      : [];
  const source = {
    id: "S1",
    title: task + " dated operating-company fixture source",
    url: "https://example.com/headless-company/" + task,
    published_at: ${JSON.stringify(AS_OF)},
    retrieved_at: ${JSON.stringify(AS_OF)},
  };
  const officialItem = {
    title: source.title,
    published_at: source.published_at,
    url: source.url,
    source_id: "S1",
  };
  const officialStages = new Set([
    "regulator_filing", "issuer_ir", "issuer_product_docs", "market_official",
    "customer_official", "supplier_official", "competitor_official", "other_regulator",
    "court_record", "peer_filing", "ownership_filing",
  ]);
  const validAcquisitionLedger = {
    policy_id: "worker_metadata_is_server_bound",
    task: "worker_task_is_server_bound",
    items: acquisitionRoutes.map((route) => ({
      coverage_id: route.coverage_id,
      outcome: "reported_actual",
      source_ids: ["S1"],
      attempts: [{
        stage: route.required_terminal_stages.find((stage) => officialStages.has(stage)),
        locator_type: "url",
        locator: source.url,
        result: "succeeded",
        source_ids: ["S1"],
        note: "The dated fixture source is the authorised disclosure for this integration row.",
      }],
      data: {
        period: ${JSON.stringify(AS_OF)},
        fixture_primary_count: 1,
        fixture_secondary_pct: 2,
      },
    })),
  };
  packet = {
    summary: task + " completed every owned company-dossier item from one dated fixture source and retained its limits.",
    claims: [{
      claim: task + " records one bounded operating-company fact for the full council.",
      claim_type: "event_or_observation",
      evidence: "The dated fixture source supports this integration-only observation.",
      confidence: "medium",
      source_ids: ["S1"],
    }],
    metrics: task === "market_data" ? { price: 101.25, currency: "USD" } : { fixture_value: 1 },
    sources: [source],
    open_questions: [],
    coverage_items: coverageIds.map((id) => ({
      id,
      status: "covered",
      source_ids: ["S1"],
      note: "The dated fixture source covers this bounded integration item.",
    })),
    acquisition_ledger: validAcquisitionLedger,
    confidence: "medium",
    information_richness: "B",
    ...(task === "news_industry_management" ? {
      official_source_coverage: {
        status: "complete",
        regulator: {
          status: "complete",
          entry_url: "https://example.com/headless-company/regulator",
          checked_through: ${JSON.stringify(AS_OF)},
          latest_dated_item: { ...officialItem, record_id: "fixture-regulator-record" },
          dated_items_checked: [{ ...officialItem, record_id: "fixture-regulator-record" }],
          gap: null,
        },
        issuer: {
          status: "complete",
          entry_url: "https://example.com/headless-company/issuer",
          checked_through: ${JSON.stringify(AS_OF)},
          latest_dated_item: officialItem,
          dated_items_checked: [officialItem],
          gap: null,
        },
      },
    } : {}),
  };
  if (ledgerRepair) {
    packet = { acquisition_ledger: validAcquisitionLedger };
  } else if (task === "ib_event_analysis") {
    packet.acquisition_ledger.items[0].attempts = "Reviewed issuer filings and event calendars.";
  }
} else if (master) {
  const frozenLine = prompt.split("\\n")
    .find((line) => line.startsWith("Frozen method result JSON: "));
  const frozen = frozenLine
    ? JSON.parse(frozenLine.slice("Frozen method result JSON: ".length))
    : null;
  const stance = frozen?.stance
    || /required acknowledged stance:\\s*(constructive|cautious|opposed|out_of_scope)/u.exec(prompt)?.[1]
    || "out_of_scope";
  const ackLine = prompt.split("\\n").find((line) => line.startsWith("Per-packet acknowledgement template: "));
  const ackTemplate = ackLine
    ? JSON.parse(ackLine.slice("Per-packet acknowledgement template: ".length))
    : [];
  packet = {
    transport: "segmented_method_voice_v1",
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
      would_i_act: "I would preserve the frozen action exactly. I would not manufacture a different vote from this fixture.",
      what_i_see: "I see the complete hash-bound operating-company dossier. I see its dated facts and explicit limits together.",
      how_my_method_reads_it: "I apply my method only to the frozen evidence. I keep missing inputs separate from directional evidence.",
      where_i_disagree: "I disagree with any uncited extension of the record. I also reject changing the already frozen stance.",
      what_changes_my_mind: "I would reassess after a dated primary source changes a method-critical fact. I would then require a newly frozen dossier revision.",
    },
    key_findings: ["The method remains bound to the shared frozen dossier."],
    disagreements: ["No evidence outside the frozen dossier may change this explanation."],
    what_would_change_my_mind: ["A new dated primary source would require a new dossier revision."],
    source_ids: ["market_data:S1"],
    confidence: "medium",
    company_dossier_hash_ack: dossierHash,
    evidence_packet_acks: Object.fromEntries(Object.entries(ackTemplate).map(([task, ack]) => [task,
      task === "market_data"
        ? { ...ack, status: "used", source_ids: ["market_data:S1"], note: "I used this packet's cited market evidence." }
        : { ...ack, status: "reviewed_not_relevant", source_ids: [], note: "I reviewed this packet and my frozen method did not use it." },
    ])),
  };
} else if (role === "portfolio_manager") {
  packet = {
    verdict: "Hold while the bounded operating-company fixture remains unchanged.",
    rating: "Hold",
    winner: "balanced",
    summary: "All eight evidence roles, the selected method, and all three debate rounds acknowledged one dossier hash.",
    long_thesis: ["The operating evidence supports a conditional constructive case."],
    short_thesis: ["Valuation and execution risk keep the position bounded."],
    valuation_range: "A conditional range tied to the cited operating evidence.",
    catalysts: ["The next dated primary filing."],
    risks: ["Execution, financing, and contradictory primary evidence."],
    position: "Keep a bounded position until the next primary filing.",
    invalidation: ["A contradictory dated filing invalidates the fixture conclusion."],
    source_ids: ["market_data:S1", "earnings_deep_dive:S1"],
    confidence: "medium",
    price_levels: [
      { label: "Avoid", range: "above the supported range", lower_bound: 200, upper_bound: null, currency: "USD", meaning: "poor risk reward", action: "do not initiate", basis: "conditional valuation", source_ids: ["market_data:S1"] },
      { label: "Watch", range: "inside the supported range", lower_bound: 100, upper_bound: 200, currency: "USD", meaning: "balanced evidence", action: "keep exposure small", basis: "conditional valuation", source_ids: ["market_data:S1"] },
      { label: "Reassess", range: "below the supported range", lower_bound: null, upper_bound: 100, currency: "USD", meaning: "potential margin of safety", action: "recheck the thesis first", basis: "operating evidence", source_ids: ["earnings_deep_dive:S1"] },
    ],
    horizon_views: {
      short_term: "Wait for a dated catalyst and keep sizing bounded.",
      medium_term: "Require measurable operating progress from primary evidence.",
      long_term: "Require durable economics and financing discipline.",
    },
    data_gaps: ["No critical data gaps were found in the completed integration fixture."],
    verification_findings_ack: [],
    company_dossier_hash_ack: dossierHash,
  };
} else if (role === "bull_researcher" || role === "bear_researcher") {
  const ownQuestions = [role + " question 1", role + " question 2", role + " question 3"];
  const preserved = round === 3
    ? lineJson("Your round 2 questions to preserve JSON: ")
    : round === 2 ? ownQuestions : [];
  const opponent = round === 3
    ? lineJson("Questions you must answer JSON: ")
    : [];
  packet = {
    verdict: role + " completed round " + round + " against the frozen dossier.",
    rating: "Hold",
    winner: "unknown",
    summary: role + " kept every round bound to the same operating-company evidence snapshot.",
    long_thesis: ["The cited operating evidence supports the bounded long case."],
    short_thesis: ["The cited valuation and execution evidence supports the bounded short case."],
    valuation_range: "A conditional range only.",
    catalysts: ["The next dated primary filing."],
    risks: ["Execution and contradictory primary evidence."],
    position: "Keep exposure bounded.",
    invalidation: ["A contradictory primary filing invalidates this round."],
    source_ids: ["market_data:S1"],
    confidence: "medium",
    questions: preserved,
    questions_answered: opponent.map((question, index) => ({
      question,
      answer: role + " exact answer " + (index + 1) + " remains bounded by the cited dossier.",
    })),
    report_markdown: "",
    company_dossier_hash_ack: dossierHash,
  };
} else {
  process.exit(19);
}

writeFileSync(output, JSON.stringify(packet));
`);
  if (process.platform !== "win32") {
    chmodSync(driver, 0o755);
    return { driver, log };
  }
  const wrapper = join(dataDir, "fake-headless-company-codex.cmd");
  writeFileSync(wrapper, `@"${process.execPath}" "${driver}" %*\r\n`);
  return { driver: wrapper, log };
}

test("headless operating-company full council freezes one dossier after typed grounding and binds every downstream consumer", { timeout: 60_000 }, async (t) => {
  const TOTAL_TIMEOUT_MS = 60_000;
  assert.equal(observerBudget(TOTAL_TIMEOUT_MS), 75_000);
  assert.equal(observerBudget(TOTAL_TIMEOUT_MS), TOTAL_TIMEOUT_MS + SETTLEMENT_HEADROOM_MS);
  const dataDir = makeDataDir();
  const fake = fakeHeadlessCompanyCodex(dataDir);
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver },
  });
  t.after(async () => {
    await server.close();
    removeDataDir(dataDir);
  });
  await server.request("initialize", {});

  const symbol = "ACME";
  const runId = `HEADLESS-COMPANY-DOSSIER-${process.pid}`;
  const selection = await confirmMasterSelection(server, {
    symbol,
    language: "English",
    prompt: USER_PROMPT,
    selected_master_ids: [SELECTED_MASTER],
  });
  const result = structured(await server.callTool("analyze_symbol", {
    symbol,
    run_id: runId,
    as_of: AS_OF,
    language: "English",
    prompt: USER_PROMPT,
    grounding: {
      instrument: {
        symbol,
        name: "Acme Fixture Corporation",
        asset_type: "equity",
        research_model: "operating_company",
        classification_source: "headless_company_fixture",
        exchange: "NASDAQ",
        currency: "USD",
      },
      quote: {
        symbol,
        price: 101.25,
        currency: "USD",
        timestamp: `${AS_OF}T15:30:00Z`,
        source: "headless_company_fixture",
      },
      source_acquisition_plan: buildCompanySourceAcquisitionPlan({
        symbol,
        asOf: AS_OF,
        profile: { name: "Acme Fixture Corporation", cik: "0000000001" },
      }),
    },
    wait_for_completion: true,
    selection_receipt: selection.selection_receipt,
    timeout_ms: 10_000,
    synthesis_timeout_ms: 10_000,
    total_timeout_ms: TOTAL_TIMEOUT_MS,
  }, { timeoutMs: observerBudget(TOTAL_TIMEOUT_MS) }));

  const dir = join(dataDir, "runs", runId);
  const dossierPath = join(dir, "company_dossier.json");
  const evidencePath = join(dir, "evidence.json");
  const dossier = readJson(dossierPath);
  const persisted = readJson(evidencePath);
  const status = readJson(join(dir, "status.json"));
  const bull = readJson(join(dir, "bull_researcher.json"));
  const bear = readJson(join(dir, "bear_researcher.json"));
  const manager = readJson(join(dir, "manager_synthesis.json"));
  const manifest = readJson(join(dir, "publication_manifest.json"));
  const workers = readJsonl(fake.log);
  const dossierHash = dossier.content_hash;

  assert.equal(result.run.status, "complete", JSON.stringify({
    task_status: result.run.task_status,
    agent_status: result.run.agent_status,
    missing: result.run.missing,
  }, null, 2));
  assert.equal(persisted.status, "complete");
  assert.equal(status.status, "complete");
  assert.equal(status.report_quality, "passed");
  assert.equal(status.company_dossier_decision_barrier_ready, true);
  assert.equal(status.company_dossier_hash, dossierHash);

  assert.equal(dossier.coverage.status, "complete");
  assert.equal(dossier.coverage.expected_count, 52);
  assert.equal(dossier.coverage.covered_count, 52);
  assert.equal(dossier.coverage.sufficiency, "sufficient");
  assert.equal(dossier.input_binding_hash.startsWith("sha256:"), true);
  assert.ok(persisted.grounding.typed_fact_pack, "the typed adapter must run before the dossier input binding freezes");
  assert.equal(
    dossier.grounding.typed_fact_pack.fact_pack_hash,
    persisted.grounding.typed_fact_pack.fact_pack_hash,
  );
  assert.equal(verifyCompanyDossierArtifact(persisted).content_hash, dossierHash);

  const opinion = persisted.master_opinions.find((item) => item.master === SELECTED_MASTER);
  assert.ok(opinion);
  assert.equal(opinion.company_dossier_hash, dossierHash);
  assert.equal(opinion.company_dossier_hash_ack, dossierHash);
  assert.equal(persisted.master_runtime_provenance[SELECTED_MASTER].company_dossier_hash, dossierHash);
  assert.equal(readJson(join(dir, `${SELECTED_MASTER}.json`)).company_dossier_hash_ack, dossierHash);

  for (const side of [bull, bear]) {
    assert.equal(side.company_dossier_hash_ack, dossierHash);
    assert.equal(side.debate_rounds.length, 3);
    assert.deepEqual(
      side.debate_rounds.map((round) => round.company_dossier_hash_ack),
      [dossierHash, dossierHash, dossierHash],
    );
  }
  assert.equal(manager.company_dossier_hash_ack, dossierHash);

  const evidenceWorkers = workers.filter((entry) => entry.task);
  assert.equal(evidenceWorkers.length, DEFAULT_TASKS.length + 1,
    "one malformed prose attempts value must receive exactly one ledger-only repair");
  assert.equal(evidenceWorkers.filter((entry) => entry.task === "ib_event_analysis").length, 2);
  assert.equal(evidenceWorkers.filter((entry) => entry.ledger_repair).length, 1);
  assert.equal(evidenceWorkers.find((entry) => entry.ledger_repair)?.task, "ib_event_analysis");
  assert.equal(evidenceWorkers.find((entry) => entry.ledger_repair)?.search, false);
  const downstreamWorkers = workers.filter((entry) => !entry.task);
  assert.equal(downstreamWorkers.length, 8, "one method, six debate sides, and one PM must run");
  assert.ok(downstreamWorkers.every((entry) => entry.dossier_hash === dossierHash));
  assert.deepEqual(
    downstreamWorkers.filter((entry) => entry.master).map((entry) => entry.master),
    [SELECTED_MASTER],
  );
  const methodWorkers = downstreamWorkers.filter((entry) => entry.master);
  const decisionWorkers = downstreamWorkers.filter((entry) => !entry.master);
  assert.ok(methodWorkers.every((entry) => entry.outputSchema));
  assert.ok(methodWorkers.every((entry) => entry.requires_full_dossier_read === false));
  assert.ok(methodWorkers.every((entry) => entry.uses_server_verified_projection === false));
  assert.ok(methodWorkers.every((entry) => entry.uses_server_verified_method_projection === true));
  assert.ok(methodWorkers.every((entry) => entry.has_dossier_path === false));
  assert.ok(methodWorkers.every((entry) => entry.has_evidence_path === false));
  assert.ok(methodWorkers.every((entry) => entry.projection_contract === "operating_company_dossier_decision_projection_v1"));
  assert.ok(methodWorkers.every((entry) => entry.projection_route_count === 52));
  assert.equal(decisionWorkers.length, 7, "six debate sides and one PM use the decision projection");
  assert.ok(decisionWorkers.every((entry) => entry.requires_full_dossier_read === false));
  assert.ok(decisionWorkers.every((entry) => entry.uses_server_verified_projection === true));
  assert.ok(decisionWorkers.every((entry) => entry.has_dossier_path === false));
  assert.ok(decisionWorkers.every((entry) => entry.has_evidence_path === false));
  assert.ok(decisionWorkers.every((entry) => entry.projection_contract === "operating_company_dossier_decision_projection_v1"));
  assert.ok(decisionWorkers.every((entry) => entry.projection_route_count === 52));
  assert.ok(decisionWorkers.every((entry) => entry.prompt_chars > 0));

  const events = readJsonl(join(dir, "events.jsonl"));
  assert.ok(events.some((event) => event.type === "task_retry"
    && event.task === "ib_event_analysis"
    && event.repair_scope === "acquisition_ledger_only"));
  assert.ok(events.some((event) => event.type === "task_repair_succeeded"
    && event.task === "ib_event_analysis"
    && event.repair_scope === "acquisition_ledger_only"));

  assert.ok(existsSync(join(dir, "final_report.md")));
  assert.equal(manifest.artifacts.company_dossier_json.path, dossierPath);
  assert.match(manifest.artifacts.company_dossier_json.sha256, /^[a-f0-9]{64}$/u);
});
