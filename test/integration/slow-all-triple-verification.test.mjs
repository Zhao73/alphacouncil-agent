import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ALL_ANALYST_TASKS, DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { expectedCoverageItems } from "../../mcp/lib/company-dossier.mjs";
import { buildCompanySourceAcquisitionPlan } from "../../mcp/lib/company-source-acquisition.mjs";
import { CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";
import { REQUIRED_VERIFIER_IDS } from "../../mcp/lib/verification.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

const AS_OF = "2026-08-03";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  const text = readFileSync(path, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function slowAllCodex(dataDir, { failVerifiers = false, semanticFidelityRetry = false } = {}) {
  const driver = join(dataDir, "fake-slow-all-codex.mjs");
  const log = join(dataDir, "slow-all-workers.jsonl");
  writeFileSync(driver, `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;

const tasks = ${JSON.stringify(ALL_ANALYST_TASKS)};
const verifier = /isolated (source_fidelity|rederivation|refuter) worker/u.exec(prompt)?.[1]
  || /Verifier:\\s*(source_fidelity|rederivation|refuter)/u.exec(prompt)?.[1]
  || null;
const coverageRetry = prompt.includes("VERIFIER COVERAGE RETRY");
const acquisitionRepair = prompt.includes("SOURCE-ACQUISITION LEDGER TRANSPORT REPAIR ONLY");
const transportRepair = prompt.includes("PARSE-ONLY TRANSPORT REPAIR.");
const task = tasks.find((id) => prompt.includes("Task:" + id) || prompt.includes("Task: " + id))
  || /Target task:\\s*([a-z_]+)/u.exec(prompt)?.[1]
  || null;
const master = /dedicated, isolated method-seat explanation worker[^\\n]*\\((master_[a-z0-9_]+)\\)/iu.exec(prompt)?.[1]
  || /Master ID:\\s*(master_[a-z0-9_]+)/u.exec(prompt)?.[1]
  || null;
const role = verifier || (/You are the portfolio_manager|Role:\\s*portfolio_manager/iu.test(prompt) ? "portfolio_manager"
  : /You are the bull_researcher|Role:\\s*bull_researcher/iu.test(prompt) ? "bull_researcher"
  : /You are the bear_researcher|Role:\\s*bear_researcher/iu.test(prompt) ? "bear_researcher"
  : master || task || "unknown");
const round = Number(/Debate round:\\s*(\\d+)/u.exec(prompt)?.[1] || 0);
const dossierHash = /Content hash:\\s*(sha256:[a-f0-9]{64})/u.exec(prompt)?.[1]
  || /company_dossier_hash_ack[^a-f0-9]*(sha256:[a-f0-9]{64})/u.exec(prompt)?.[1]
  || null;
const lineJson = (prefix) => {
  const line = prompt.split("\\n").find((item) => item.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : [];
};

appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  role, task, verifier, master, round, coverageRetry, acquisitionRepair, transportRepair,
  search: args.includes("--search"), outputSchema: args.includes("--output-schema"),
  requiredUrlChecklist: prompt.includes("REQUIRED checked_urls BY CLAIM (binding work checklist)"),
  pid: process.pid, at: Date.now(),
}) + "\\n");

if (verifier && ${JSON.stringify(failVerifiers)}) process.exit(17);

let packet;
if (verifier) {
  const inputPath = /frozen verification input at ([^\\n]+?)\\. Its claim_count/u.exec(prompt)?.[1]
    || /same frozen input again at ([^\\n]+?)\\. Return/u.exec(prompt)?.[1];
  if (!inputPath) process.exit(18);
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const verifierRows = input.claims.map((claim) => {
      if (verifier === "source_fidelity") {
        return {
          claim_id: claim.claim_id,
          verdict: "supported",
          note: "The cited fixture source directly supports this frozen material claim.",
          checked_urls: ${JSON.stringify(semanticFidelityRetry)} && !coverageRetry
            ? []
            : claim.cited_sources.map((source) => source.url),
          queries: [],
          excerpt: "Fixture evidence directly supports the bounded material observation.",
          rederivation: "",
        };
      }
      if (verifier === "rederivation") {
        return {
          claim_id: claim.claim_id,
          verdict: "agree",
          note: "An independent fixture calculation reaches the same bounded result.",
          checked_urls: ["https://independent.example/rederive/" + encodeURIComponent(claim.claim_id)],
          queries: ["independently rederive " + claim.claim_id],
          excerpt: "",
          rederivation: "Recomputed the fixture observation from an independent dated input and obtained the same value.",
        };
      }
      return {
        claim_id: claim.claim_id,
        verdict: "stands",
        note: "A concrete search for contrary fixture evidence found no contradiction.",
        checked_urls: [],
        queries: ["contradict disconfirm supersede " + claim.claim_id],
        excerpt: "",
        rederivation: "",
      };
    });
  packet = {
    verifier,
    run_id: input.run_id,
    results: args.includes("--output-schema")
      ? Object.fromEntries(verifierRows.map(({ claim_id, ...row }) => [claim_id, row]))
      : verifierRows,
  };
} else if (task) {
  const coverageIds = lineJson("Required coverage IDs JSON: ");
  const acquisitionRoutes = lineJson("Frozen source plan: ");
  const source = {
    id: "S1",
    title: task + " dated slow-all fixture source",
    url: "https://example.com/slow-all/" + task,
    published_at: ${JSON.stringify(AS_OF)},
    retrieved_at: ${JSON.stringify(AS_OF)},
  };
  const source2 = {
    id: "S2",
    title: task + " second dated slow-all fixture source",
    url: "https://example.com/slow-all/" + task + "/second",
    published_at: ${JSON.stringify(AS_OF)},
    retrieved_at: ${JSON.stringify(AS_OF)},
  };
  const official = { title: source.title, published_at: source.published_at, url: source.url, source_id: "S1" };
  const officialStages = new Set([
    "regulator_filing", "issuer_ir", "issuer_product_docs", "market_official",
    "customer_official", "supplier_official", "competitor_official", "other_regulator",
    "court_record", "peer_filing", "ownership_filing",
  ]);
  const validAcquisitionLedger = acquisitionRoutes.length ? {
    // Deliberately wrong worker-owned metadata: the runtime, not the model, must bind these.
    policy_id: "worker_must_not_choose_policy",
    task: "worker_must_not_reassign_task",
    items: acquisitionRoutes.map((route) => {
      const stage = route.required_terminal_stages.find((candidate) => officialStages.has(candidate));
      return {
        coverage_id: route.coverage_id,
        outcome: "reported_actual",
        source_ids: ["S1"],
        attempts: [{
          stage,
          locator_type: "url",
          locator: source.url,
          result: "succeeded",
          source_ids: ["S1"],
          note: "The bounded fixture source is the authorised disclosure for this integration row.",
        }],
        // Mirrors the VSH failure shape: one coverage row can legitimately contain several
        // reported metrics instead of one artificial value/unit/scope tuple.
        data: {
          period: ${JSON.stringify(AS_OF)},
          fixture_primary_count: 1,
          fixture_secondary_pct: 2,
        },
      };
    }),
  } : null;
  if (acquisitionRepair) {
    packet = { acquisition_ledger: validAcquisitionLedger };
  } else {
    const initialAcquisitionLedger = validAcquisitionLedger
      ? JSON.parse(JSON.stringify(validAcquisitionLedger))
      : null;
    // Exercise the exact production failure path once. The retry may repair only this ledger;
    // it must not regenerate the already-valid evidence packet around it.
    if (task === "earnings_deep_dive" && initialAcquisitionLedger?.items?.length) {
      delete initialAcquisitionLedger.items[0].data;
    }
    // Reproduce the real VSH chain: attempt 1 needs a general packet-shape repair, and the
    // repaired packet then reveals a disjoint acquisition-ledger semantic defect.
    if (task === "market_data" && transportRepair && initialAcquisitionLedger?.items?.length) {
      delete initialAcquisitionLedger.items[0].data;
    }
    packet = {
    summary: task + " completed its full slow-all assignment with dated evidence and explicit limits.",
    claims: [
      {
        claim: task + " records one material slow-all fixture observation.",
        claim_type: "event_or_observation",
        evidence: "The dated fixture source directly supports this bounded observation.",
        confidence: "medium",
        source_ids: ["S1", "S2"],
      },
      {
        claim: task + " records a second material observation to exercise verifier chunking.",
        claim_type: "event_or_observation",
        evidence: "The same dated fixture source directly supports the second bounded observation.",
        confidence: "medium",
        source_ids: ["S1", "S2"],
      },
    ],
    metrics: task === "market_data" ? { price: 101.25, currency: "USD" } : { fixture_value: 1 },
    sources: [source, source2],
    open_questions: [],
    coverage_items: coverageIds.map((id) => ({
      id, status: "covered", source_ids: ["S1"], note: "The packet-local source covers this fixture item.",
    })),
    confidence: "medium",
    information_richness: "B",
    ...(initialAcquisitionLedger ? { acquisition_ledger: initialAcquisitionLedger } : {
      // The three supplemental seats may echo an irrelevant malformed ledger. The runtime
      // strips it because only the eight core evidence seats own the fixed 52 routes.
      acquisition_ledger: { policy_id: "irrelevant", task: "irrelevant", items: [{ malformed: true }] },
    }),
    ...(task === "news_industry_management" ? {
      official_source_coverage: {
        status: "complete",
        regulator: {
          status: "complete", entry_url: "https://example.com/slow-all/regulator", checked_through: ${JSON.stringify(AS_OF)},
          latest_dated_item: { ...official, record_id: "slow-all-regulator" },
          dated_items_checked: [{ ...official, record_id: "slow-all-regulator" }], gap: null,
        },
        issuer: {
          status: "complete", entry_url: "https://example.com/slow-all/issuer", checked_through: ${JSON.stringify(AS_OF)},
          latest_dated_item: official, dated_items_checked: [official], gap: null,
        },
      },
    } : {}),
    };
    if (task === "market_data" && !transportRepair) packet.claims[0].source_ids = [];
  }
} else if (master) {
  const frozenLine = prompt.split("\\n").find((line) => line.startsWith("Frozen method result JSON: "));
  const frozen = frozenLine ? JSON.parse(frozenLine.slice("Frozen method result JSON: ".length)) : null;
  const stance = frozen?.stance
    || /required acknowledged stance:\\s*(constructive|cautious|opposed|out_of_scope)/u.exec(prompt)?.[1]
    || "out_of_scope";
  const ackTemplate = lineJson("Per-packet acknowledgement template: ");
  packet = {
    transport: "segmented_method_voice_v1",
    master,
    acknowledged_stance: stance,
    voice_mode: "first_person_public_method_simulation_v1",
    disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
    position_intent: ({
      constructive: "would_buy", cautious: "would_hold", opposed: "would_pass", out_of_scope: "not_in_my_circle",
    })[stance],
    voice: {
      would_i_act: "I would preserve the frozen action. I would not manufacture a different vote.",
      what_i_see: "I see all eleven frozen analyst packets. I keep their facts and gaps separate.",
      how_my_method_reads_it: "I apply my public method sequence to this dossier. I do not add facts from memory.",
      where_i_disagree: "I reject any uncited extension of the record. I also reject changing the frozen stance.",
      what_changes_my_mind: "I would reassess after a dated primary source changes a critical fact. I would require a new dossier hash.",
    },
    key_findings: ["The shared dossier contains eight core packets and three supplemental analyst packets."],
    disagreements: ["No evidence outside the frozen dossier may alter this method statement."],
    what_would_change_my_mind: ["A newly dated contradictory primary source would require a fresh run."],
    source_ids: ["market_data:S1"],
    confidence: "medium",
    company_dossier_hash_ack: dossierHash,
    evidence_packet_acks: Object.fromEntries(Object.entries(ackTemplate).map(([task, ack]) => [task,
      task === "market_data"
        ? { ...ack, status: "used", source_ids: ["market_data:S1"], note: "I used this packet's market evidence." }
        : { ...ack, status: "reviewed_not_relevant", source_ids: [], note: "I reviewed this packet and did not use it in the frozen method result." },
    ])),
  };
} else if (role === "portfolio_manager") {
  packet = {
    verdict: "Hold while the bounded slow-all fixture remains unchanged.",
    rating: "Hold",
    winner: "balanced",
    summary: "Eleven analyst packets, three complete verifier batches, and all method voices passed their gates.",
    long_thesis: ["The verified operating evidence supports a conditional constructive case."],
    short_thesis: ["Valuation and execution risk keep the position bounded."],
    valuation_range: "A conditional range tied to the cited evidence.",
    catalysts: ["The next dated primary filing."],
    risks: ["Execution risk and unavailable proprietary operating data."],
    position: "Keep a bounded position until the next primary filing.",
    invalidation: ["A contradictory dated filing invalidates the fixture conclusion."],
    source_ids: ["market_data:S1", "earnings_deep_dive:S1"],
    confidence: "medium",
    price_levels: [
      { label: "Avoid", range: "above", lower_bound: 200, upper_bound: null, currency: "USD", meaning: "poor risk reward", action: "do not initiate", basis: "conditional valuation", source_ids: ["market_data:S1"] },
      { label: "Watch", range: "middle", lower_bound: 100, upper_bound: 200, currency: "USD", meaning: "balanced evidence", action: "keep exposure small", basis: "conditional valuation", source_ids: ["market_data:S1"] },
      { label: "Reassess", range: "below", lower_bound: null, upper_bound: 100, currency: "USD", meaning: "possible margin of safety", action: "recheck the thesis", basis: "operating evidence", source_ids: ["earnings_deep_dive:S1"] },
    ],
    horizon_views: {
      short_term: "Wait for a dated catalyst and keep sizing bounded.",
      medium_term: "Require measurable operating progress from primary evidence.",
      long_term: "Require durable economics and financing discipline.",
    },
    data_gaps: ["Proprietary customer acceptance, yield, allocation, borrow-fee and capacity data remain unavailable."],
    verification_findings_ack: [],
    company_dossier_hash_ack: dossierHash,
  };
} else if (role === "bull_researcher" || role === "bear_researcher") {
  const own = [role + " question 1", role + " question 2", role + " question 3"];
  const questions = round === 3 ? lineJson("Your round 2 questions to preserve JSON: ") : (round === 2 ? own : []);
  const opponent = round === 3 ? lineJson("Questions you must answer JSON: ") : [];
  packet = {
    verdict: role + " completed round " + round + " against the verified frozen dossier.",
    rating: "Hold", winner: "unknown", summary: role + " kept the argument inside the verified record.",
    long_thesis: ["The verified operating evidence supports the bounded long case."],
    short_thesis: ["The verified valuation evidence supports the bounded short case."],
    valuation_range: "A conditional range only.", catalysts: ["The next filing."], risks: ["Execution."],
    position: "Keep exposure bounded.", invalidation: ["Contradictory primary evidence."],
    source_ids: ["market_data:S1"], confidence: "medium", questions,
    questions_answered: opponent.map((question, index) => ({
      question, answer: role + " exact answer " + (index + 1) + " remains bounded by the dossier.",
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
  const wrapper = join(dataDir, "fake-slow-all-codex.cmd");
  writeFileSync(wrapper, `@"${process.execPath}" "${driver}" %*\r\n`);
  return { driver: wrapper, log };
}

async function runSlowAll(t, { failVerifiers = false, semanticFidelityRetry = false } = {}) {
  const dataDir = makeDataDir();
  const fake = slowAllCodex(dataDir, { failVerifiers, semanticFidelityRetry });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  t.after(async () => {
    await server.close();
    removeDataDir(dataDir);
  });
  await server.request("initialize", {});
  const symbol = "ACME";
  const prompt = failVerifiers
    ? "Prove that zero verifier verdicts fail closed before every method and decision stage."
    : "Run the complete slow council with all method seats, all analyst seats and triple verification.";
  const selection = await confirmMasterSelection(server, {
    symbol,
    language: "English",
    prompt,
    select_all: true,
    analyst_scope: "all",
    council_pace: "slow",
  });
  const runId = `SLOW-ALL-${failVerifiers ? "ZERO" : "PASS"}-${process.pid}`;
  const result = structured(await server.callTool("analyze_symbol", {
    symbol,
    run_id: runId,
    as_of: AS_OF,
    language: "English",
    prompt,
    wait_for_completion: true,
    selection_receipt: selection.selection_receipt,
    total_timeout_ms: 60 * 60 * 1000,
    grounding: {
      gathered_at: `${AS_OF}T12:00:00Z`,
      facts_unavailable: true,
      instrument: {
        symbol,
        name: "Acme Slow-All Fixture Corporation",
        asset_type: "equity",
        research_model: "operating_company",
        exchange: "NASDAQ",
        currency: "USD",
      },
      quote: { symbol, price: 101.25, currency: "USD", timestamp: `${AS_OF}T15:30:00Z` },
      source_acquisition_plan: buildCompanySourceAcquisitionPlan({
        symbol,
        asOf: AS_OF,
        profile: { name: "Acme Slow-All Fixture Corporation", cik: "0000000001" },
      }),
    },
  // WP-4c: path_bounded_observer — the 60-minute pace total is not the exercised path; a contract-derived budget would permit a 60-minute hang. Needs a path-derived ceiling in a later package.
  }, { timeoutMs: 120_000 }));
  return { dataDir, fake, result, runId, selection };
}

test("slow + all runs 11 analysts, all 26 methods and all three claim-complete verifier batches", { timeout: 120_000 }, async (t) => {
  const { dataDir, fake, result, runId, selection } = await runSlowAll(t);
  const dir = join(dataDir, "runs", runId);
  const persisted = readJson(join(dir, "evidence.json"));
  const status = readJson(join(dir, "status.json"));
  const dossier = readJson(join(dir, "company_dossier.json"));
  const launches = readJsonl(fake.log);

  assert.equal(selection.selected_count, CANONICAL_MASTER_IDS.length);
  assert.equal(selection.selected_analyst_count, 11);
  assert.equal(selection.analyst_scope, "all");
  assert.equal(selection.council_pace, "slow");
  assert.deepEqual(persisted.tasks, ALL_ANALYST_TASKS);
  assert.equal(persisted.packets.length, 11);
  assert.equal(persisted.masters.length, CANONICAL_MASTER_IDS.length);
  assert.equal(persisted.status, "complete", JSON.stringify({
    task_status: persisted.task_status,
    dossier_coverage: persisted.company_dossier?.coverage,
  }, null, 2));
  assert.equal(status.status, "complete");

  for (const packet of persisted.packets.filter((item) => DEFAULT_TASKS.includes(item.task))) {
    assert.equal(packet.acquisition_ledger.policy_id, "company_source_acquisition_v1");
    assert.equal(packet.acquisition_ledger.task, packet.task);
    assert.equal(packet.acquisition_ledger.items.length, expectedCoverageItems(packet.task).length);
    assert.ok(packet.acquisition_ledger.items.every((item) => item.data.observations.length === 2));
  }
  for (const packet of persisted.packets.filter((item) => !DEFAULT_TASKS.includes(item.task))) {
    assert.equal(Object.hasOwn(packet, "acquisition_ledger"), false);
  }
  const events = readJsonl(join(dir, "events.jsonl"));
  const acquisitionRetry = events.find((event) => event.type === "task_retry"
    && event.task === "earnings_deep_dive");
  const acquisitionRepair = events.find((event) => event.type === "task_repair_succeeded"
    && event.task === "earnings_deep_dive");
  assert.equal(acquisitionRetry.repair_scope, "acquisition_ledger_only");
  assert.equal(acquisitionRepair.repair_scope, "acquisition_ledger_only");
  assert.match(
    persisted.packets.find((packet) => packet.task === "earnings_deep_dive").summary,
    /completed its full slow-all assignment/u,
  );
  const repairLaunch = launches.find((entry) => entry.task === "earnings_deep_dive" && entry.acquisitionRepair);
  assert.ok(repairLaunch);
  assert.equal(repairLaunch.search, false);

  const marketRetries = events.filter((event) => event.type === "task_retry"
    && event.task === "market_data");
  const marketRepair = events.find((event) => event.type === "task_repair_succeeded"
    && event.task === "market_data");
  assert.deepEqual(marketRetries.map(({ attempt, max_attempts, repair_scope }) => ({
    attempt, max_attempts, repair_scope,
  })), [
    { attempt: 2, max_attempts: 3, repair_scope: "evidence_packet_transport" },
    { attempt: 3, max_attempts: 3, repair_scope: "acquisition_ledger_only" },
  ]);
  assert.deepEqual(marketRepair.repair_chain, [
    "evidence_packet_transport", "acquisition_ledger_only",
  ]);
  assert.equal(persisted.task_status.market_data.attempts, 3);

  assert.equal(persisted.verification_policy.required, true);
  assert.equal(persisted.verification_policy.status, "passed");
  assert.equal(status.verifier_required, true);
  assert.equal(status.verifier_zero, false);
  assert.equal(status.verifier_material_claim_count, 22);
  assert.equal(status.verifier_expected_count, 66);
  assert.equal(status.verifier_verdict_count, 66);
  assert.equal(persisted.verifier_verdicts.length, 66);
  assert.ok(REQUIRED_VERIFIER_IDS.every((id) => persisted.verifier_status[id]?.status === "completed"));

  assert.equal(persisted.master_opinions.length, CANONICAL_MASTER_IDS.length);
  assert.equal(
    readJson(join(dir, "master_taleb.deterministic.json")).voice_status,
    "deterministic_only",
    "the pre-worker deterministic artifact is not counted as a worker-failure fallback",
  );
  const frozenPacketHashes = new Map(dossier.packet_manifest.map((entry) => [
    entry.task, entry.packet_hash,
  ]));
  for (const opinion of persisted.master_opinions) {
    assert.equal(opinion.company_dossier_hash_ack, persisted.company_dossier.content_hash);
    assert.equal(opinion.evidence_packet_acks.length, 11);
    assert.equal(opinion.evidence_packet_acks.filter((ack) => DEFAULT_TASKS.includes(ack.task)).length, 8);
    assert.deepEqual(opinion.evidence_packet_acks.map((ack) => ack.task), ALL_ANALYST_TASKS);
    assert.ok(opinion.evidence_packet_acks.every((ack) => [
      "used", "reviewed_not_relevant", "unavailable",
    ].includes(ack.status)));
    assert.ok(opinion.evidence_packet_acks.every((ack) => (
      ack.packet_hash === frozenPacketHashes.get(ack.task)
    )), "the server must bind every worker disposition to the frozen packet hash");
  }

  const evidenceLaunches = launches.filter((entry) => ALL_ANALYST_TASKS.includes(entry.role));
  const initialEvidenceLaunches = evidenceLaunches.filter((entry) => !entry.acquisitionRepair && !entry.transportRepair);
  const transportRepairLaunches = evidenceLaunches.filter((entry) => entry.transportRepair);
  const acquisitionRepairLaunches = evidenceLaunches.filter((entry) => entry.acquisitionRepair);
  const verifierLaunches = launches.filter((entry) => REQUIRED_VERIFIER_IDS.includes(entry.role));
  const masterLaunches = launches.filter((entry) => CANONICAL_MASTER_IDS.includes(entry.role));
  assert.equal(initialEvidenceLaunches.length, 11);
  assert.equal(transportRepairLaunches.length, 1);
  assert.equal(acquisitionRepairLaunches.length, 2);
  assert.equal(verifierLaunches.filter((entry) => entry.role === "source_fidelity").length, 4,
    "22 claims with two cited URLs each require four URL-weighted fidelity chunks");
  assert.equal(verifierLaunches.filter((entry) => entry.role === "rederivation").length, 2);
  assert.equal(verifierLaunches.filter((entry) => entry.role === "refuter").length, 2);
  assert.equal(verifierLaunches.length, 8);
  assert.equal(masterLaunches.length, CANONICAL_MASTER_IDS.length);
  assert.ok(initialEvidenceLaunches.every((entry) => entry.search));
  assert.ok(initialEvidenceLaunches.every((entry) => entry.outputSchema));
  assert.ok(transportRepairLaunches.every((entry) => !entry.search));
  assert.ok(transportRepairLaunches.every((entry) => entry.outputSchema));
  assert.ok(acquisitionRepairLaunches.every((entry) => !entry.search));
  assert.ok(acquisitionRepairLaunches.every((entry) => !entry.outputSchema));
  assert.ok(verifierLaunches.every((entry) => entry.search));
  assert.ok(verifierLaunches.filter((entry) => entry.role === "source_fidelity")
    .every((entry) => entry.requiredUrlChecklist));
  assert.ok(masterLaunches.every((entry) => !entry.search));
  assert.ok(masterLaunches.every((entry) => entry.outputSchema));
  assert.equal(result.run.status, "complete");
});

test("slow + all with zero verifier verdicts is needs_verification and launches no method or debate worker", { timeout: 120_000 }, async (t) => {
  const { dataDir, fake, result, runId } = await runSlowAll(t, { failVerifiers: true });
  const dir = join(dataDir, "runs", runId);
  const persisted = readJson(join(dir, "evidence.json"));
  const status = readJson(join(dir, "status.json"));
  const launches = readJsonl(fake.log);

  assert.equal(result.run.status, "needs_verification");
  assert.equal(persisted.status, "needs_verification");
  assert.equal(status.status, "needs_verification");
  assert.equal(status.verifier_required, true);
  assert.equal(status.verifier_zero, true);
  assert.equal(status.verifier_verdict_count, 0);
  assert.ok(REQUIRED_VERIFIER_IDS.every((id) => persisted.verifier_status[id]?.status === "failed"));
  assert.equal(launches.filter((entry) => CANONICAL_MASTER_IDS.includes(entry.role)).length, 0);
  assert.equal(launches.filter((entry) => ["bull_researcher", "bear_researcher", "portfolio_manager"].includes(entry.role)).length, 0);
});

test("a semantic fidelity miss gets one real-search verifier retry and then crosses the exact gate", { timeout: 120_000 }, async (t) => {
  const { dataDir, fake, result, runId } = await runSlowAll(t, { semanticFidelityRetry: true });
  const status = readJson(join(dataDir, "runs", runId, "status.json"));
  const launches = readJsonl(fake.log);
  const fidelity = launches.filter((entry) => entry.role === "source_fidelity");
  assert.equal(result.run.status, "complete");
  assert.equal(status.verifier_verdict_count, status.verifier_expected_count);
  assert.equal(fidelity.filter((entry) => !entry.coverageRetry).length, 4);
  assert.equal(fidelity.filter((entry) => entry.coverageRetry).length, 4);
  assert.ok(fidelity.filter((entry) => !entry.coverageRetry).every((entry) => entry.requiredUrlChecklist));
  assert.ok(fidelity.filter((entry) => entry.coverageRetry).every((entry) => entry.search));
});
