import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import {
  COMPANY_DOSSIER_DECISION_PROJECTION_MAX_BYTES,
  OPERATING_COMPANY_COVERAGE,
  assertCompanyDossierPacketAcks,
  buildCompanyDossier,
  companyCoverageInstruction,
  companyDossierDecisionProjection,
  companyDossierPromptBlock,
  companyDossierCoverageStatus,
  expectedCoverageItems,
  requiresOperatingCompanyDossier,
} from "../../mcp/lib/company-dossier.mjs";
import { buildMethodVoiceHeadlessOutputSchema } from "../../mcp/lib/orchestrator.mjs";
import { methodVoiceAllowedSourceIds } from "../../mcp/lib/packets.mjs";

const AS_OF = "2026-08-03";

function source(task, index = 1) {
  return {
    id: `${task}:S${index}`,
    title: `${task} fixture source ${index}`,
    url: `https://example.test/${task}/source-${index}`,
    published_at: AS_OF,
    retrieved_at: AS_OF,
  };
}

function coveredPacket(task, { expanded = false } = {}) {
  const sources = Array.from({ length: expanded ? 14 : 1 }, (_, index) => source(task, index + 1));
  const coverageIds = expectedCoverageItems(task);
  const claims = Array.from({ length: expanded ? 10 : 1 }, (_, index) => ({
    claim: `${task} fixture claim ${index + 1}`,
    evidence: `${task} fixture evidence ${index + 1}`,
    confidence: "medium",
    source_ids: [sources[Math.min(index, sources.length - 1)].id],
  }));
  return {
    task,
    summary: `${task} completed its operating-company dossier checklist.`,
    claims,
    metrics: expanded
      ? { deep: { level_two: { level_three: { level_four: { value: "DEEP-A" } } } } }
      : {},
    sources,
    open_questions: [],
    coverage_items: coverageIds.map((id) => ({
      id,
      status: "covered",
      source_ids: [sources[0].id],
      note: `Covered by ${sources[0].id}.`,
    })),
    acquisition_ledger: {
      policy_id: "company_source_acquisition_v1",
      task,
      items: coverageIds.map((id) => ({
        coverage_id: id,
        outcome: "reported_actual",
        source_ids: [sources[0].id],
        attempts: [{
          stage: "fixture_source",
          locator_type: "url",
          locator: sources[0].url,
          result: "succeeded",
          source_ids: [sources[0].id],
          note: "The dated fixture source returned the recorded observation.",
        }],
        data: { observations: [{ value: 1, unit: "fixture", source_ids: [sources[0].id] }] },
      })),
    },
    confidence: "medium",
    information_richness: "B",
    raw_text: `RAW-${task}-A`,
  };
}

function companyRun(packets = DEFAULT_TASKS.map((task) => coveredPacket(task))) {
  return {
    run_id: "COMPANY-DOSSIER-UNIT",
    symbol: "ACME",
    as_of: AS_OF,
    language: "English",
    council_mode: "full",
    dry_run: false,
    tasks: packets.map((packet) => packet.task),
    packets,
    grounding: {
      instrument: {
        asset_type: "equity",
        research_model: "operating_company",
        classification_source: "unit_fixture",
      },
      quote: { price: 100, currency: "USD", source: "unit_fixture" },
    },
  };
}

function sourceManifest(run) {
  const sources = run.packets.flatMap((packet) => packet.sources.map((item) => ({
    task: packet.task,
    ...item,
    provenance_domain: "evidence",
  })));
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    source_count: sources.length,
    evidence_source_count: sources.length,
    method_provenance_source_count: 0,
    sources,
    missing_claim_source_ids: [],
  };
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, item]) => [key, reverseObjectKeys(item)]),
  );
}

function coverageForPacket(packet) {
  const packets = DEFAULT_TASKS.map((task) => (
    task === packet.task ? packet : coveredPacket(task)
  ));
  return companyDossierCoverageStatus(companyRun(packets));
}

function markUnavailable(packet, id, {
  attemptedUrls = ["https://example.test/retrieval-attempt"],
  gap = `No usable data was available for ${id} after the named retrieval attempt.`,
} = {}) {
  const item = packet.coverage_items.find((entry) => entry.id === id);
  assert.ok(item, `fixture must own ${id}`);
  Object.assign(item, {
    status: "unavailable",
    source_ids: [],
    attempted: `Queried the named provider for ${id} through the as-of date.`,
    attempted_urls: attemptedUrls,
    gap,
  });
  packet.open_questions.push(gap);
  const acquisition = packet.acquisition_ledger?.items?.find((entry) => entry.coverage_id === id);
  if (acquisition) {
    Object.assign(acquisition, {
      outcome: "unavailable",
      source_ids: [],
      attempts: attemptedUrls.map((url) => ({
        stage: "fixture_source",
        locator_type: "url",
        locator: url,
        result: "not_found",
        source_ids: [],
        note: gap,
      })),
      reason: gap,
    });
    delete acquisition.data;
  }
  return packet;
}

function freezeCompanyDossier(run) {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-company-projection-"));
  const path = join(dir, "company_dossier.json");
  const dossier = buildCompanyDossier(run, sourceManifest(run));
  writeFileSync(path, JSON.stringify(dossier));
  run.company_dossier = { path, content_hash: dossier.content_hash };
  return { dir, dossier };
}

test("the operating-company registry owns 52 unique items across the eight mandatory roles", () => {
  assert.deepEqual(Object.keys(OPERATING_COMPANY_COVERAGE), DEFAULT_TASKS);
  const entries = DEFAULT_TASKS.flatMap((task) => (
    expectedCoverageItems(task).map((id) => ({ task, id }))
  ));
  assert.equal(entries.length, 52);
  assert.equal(new Set(entries.map(({ id }) => id)).size, 52);
  assert.ok(entries.some(({ id }) => id === "ownership.accounting_controls_restatements"));
  assert.ok(!entries.some(({ id }) => id === "ownership.accounting_controls_restements"));
  for (const task of DEFAULT_TASKS) {
    assert.ok(expectedCoverageItems(task).length > 0, `${task} must own coverage items`);
    assert.deepEqual(expectedCoverageItems(task), OPERATING_COMPANY_COVERAGE[task]);
  }
});

test("the debate projection is derived from the verified dossier without dropping routes or source bindings", () => {
  const market = coveredPacket("market_data", { expanded: true });
  const successfulAttemptOnlySource = source("market_data", 15);
  market.claims = market.sources.map((item, index) => ({
    claim: `decision claim ${index + 1}`,
    evidence: `decision evidence ${index + 1}`,
    confidence: "medium",
    source_ids: [item.id],
  }));
  market.metrics = {
    price: { value: 100, unit: "USD", source_ids: ["S14"] },
    nested: { formula: { inputs: [1, 2, 3], assumptions: ["bounded fixture"] } },
  };
  market.sources[13].source_kind = "dynamic_snapshot";
  market.sources[13].observed_at = `${AS_OF}T12:00:00Z`;
  market.sources.push(successfulAttemptOnlySource);
  const outcome = market.acquisition_ledger.items.find((item) => item.coverage_id === "market.quote_snapshot");
  outcome.source_ids = [market.sources[13].id];
  outcome.attempts = [{
    stage: "fixture_source",
    locator_type: "url",
    locator: successfulAttemptOnlySource.url,
    result: "succeeded",
    source_ids: [successfulAttemptOnlySource.id, "S15"],
    note: "The independent route established how the quote was acquired.",
  }];
  outcome.data = {
    observations: [{ value: 100, unit: "USD", source_ids: [market.sources[13].id] }],
    formula: "fixture_actual",
    inputs: [100],
    assumptions: ["No unstated input."],
  };
  markUnavailable(market, "market.liquidity_volume", {
    attemptedUrls: ["https://example.test/liquidity-attempt"],
    gap: "The liquidity route remained unavailable after the named fixture attempt.",
  });

  const packets = DEFAULT_TASKS.map((task) => task === market.task ? market : coveredPacket(task));
  const run = companyRun(packets);
  run.grounding.source_acquisition_plan = { policy_id: "company_source_acquisition_v1" };
  run.grounding.macro_series = { raw_transport_sentinel: "RAW-MACRO-SENTINEL".repeat(20_000) };
  const frozen = freezeCompanyDossier(run);
  try {
    const projection = companyDossierDecisionProjection(run);
    const serialized = JSON.stringify(projection);
    const projectedMarket = projection.packets.find((packet) => packet.task === market.task);
    assert.equal(projection.projection_contract, "operating_company_dossier_decision_projection_v1");
    assert.equal(projection.source_dossier.content_hash, frozen.dossier.content_hash);
    assert.match(projection.projection_hash, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Buffer.byteLength(serialized) <= COMPANY_DOSSIER_DECISION_PROJECTION_MAX_BYTES);
    assert.equal(projection.packets.reduce((total, packet) => total + packet.routes.length, 0), 52);
    assert.equal(projectedMarket.claims.length, 14);
    assert.equal(projectedMarket.sources.length, 15);
    assert.equal(projectedMarket.metrics.price.source_ids[0], "market_data:S14");
    assert.equal(projectedMarket.sources.find((item) => item.id === "market_data:S14").source_kind, "dynamic_snapshot");
    assert.equal(projectedMarket.sources.find((item) => item.id === "market_data:S14").observed_at, `${AS_OF}T12:00:00Z`);
    assert.ok(projectedMarket.sources.every((item) => /^sha256:[a-f0-9]{64}$/u.test(item.source_record_hash)));
    const quoteRoute = projectedMarket.routes.find((route) => route.id === "market.quote_snapshot");
    assert.equal(quoteRoute.outcome, "reported_actual");
    assert.deepEqual(quoteRoute.outcome_source_ids, ["market_data:S14"]);
    assert.deepEqual(quoteRoute.attempt_source_ids, ["market_data:S15"]);
    assert.ok(projectedMarket.sources.some((item) => item.id === "market_data:S15"));
    assert.deepEqual(quoteRoute.data.inputs, [100]);
    const unavailableRoute = projectedMarket.routes.find((route) => route.id === "market.liquidity_volume");
    assert.equal(unavailableRoute.outcome, "unavailable");
    assert.equal(unavailableRoute.attempts.length, 1);
    assert.equal(unavailableRoute.gap, "The liquidity route remained unavailable after the named fixture attempt.");
    assert.doesNotMatch(serialized, /RAW-MACRO-SENTINEL|\[nested object\]|\[\d+ items\]/u);

    const decisionPrompt = companyDossierPromptBlock(run, { consumer: "decision_projection" });
    assert.match(decisionPrompt, /server-verified decision projection/iu);
    assert.doesNotMatch(decisionPrompt, new RegExp(run.company_dossier.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    const methodPrompt = companyDossierPromptBlock(run, { consumer: "method_projection" });
    assert.match(methodPrompt, /server-verified method projection/iu);
    assert.match(methodPrompt, new RegExp(frozen.dossier.content_hash, "u"));
    assert.doesNotMatch(methodPrompt, /Read the JSON file in full|company_dossier\.json/iu);
    const repairPrompt = companyDossierPromptBlock(run, { consumer: "hash_ack_only" });
    assert.match(repairPrompt, new RegExp(frozen.dossier.content_hash, "u"));
    assert.doesNotMatch(repairPrompt, /decision projection|Read the JSON file in full|company_dossier\.json/iu);
  } finally {
    rmSync(frozen.dir, { recursive: true, force: true });
  }
});

test("method source scope and packet acknowledgements reject sources omitted from the projection", () => {
  const market = coveredPacket("market_data");
  const unused = source("market_data", 99);
  market.sources.push(unused);
  const run = companyRun(DEFAULT_TASKS.map((task) => (
    task === market.task ? market : coveredPacket(task)
  )));
  run.grounding.source_acquisition_plan = { policy_id: "company_source_acquisition_v1" };
  const frozen = freezeCompanyDossier(run);
  try {
    const projection = companyDossierDecisionProjection(run);
    const projectedMarket = projection.packets.find((packet) => packet.task === market.task);
    assert.ok(projectedMarket.sources.some((item) => item.id === "market_data:S1"));
    assert.ok(!projectedMarket.sources.some((item) => item.id === unused.id),
      "an unreferenced raw transport source must stay outside the worker projection");

    const frozenOpinion = {
      master: "master_buffett",
      stance: "cautious",
      source_ids: ["market_data:S1", unused.id],
      evidence_source_ids: ["market_data:S1", unused.id],
    };
    const allowed = methodVoiceAllowedSourceIds(run, frozenOpinion);
    assert.ok(allowed.includes("market_data:S1"));
    assert.ok(!allowed.includes(unused.id),
      "deterministic provenance or a raw dossier record cannot widen the rendered citation scope");

    const schema = buildMethodVoiceHeadlessOutputSchema(run, frozenOpinion.master, frozenOpinion);
    assert.ok(!schema.properties.source_ids.items.enum.includes(unused.id));
    assert.ok(!schema.properties.evidence_packet_acks.properties.market_data
      .properties.source_ids.items.enum.includes(unused.id));

    const ackRows = frozen.dossier.packet_manifest.map((manifest) => ({
      task: manifest.task,
      status: "reviewed_not_relevant",
      source_ids: [],
      note: "The bounded fixture packet was reviewed but not used by this method.",
    }));
    const rawOnlyPacket = {
      source_ids: [unused.id],
      evidence_packet_acks: ackRows.map((row) => row.task === "market_data"
        ? { ...row, status: "used", source_ids: [unused.id], note: "Used the raw-only source." }
        : row),
    };
    assert.throws(
      () => assertCompanyDossierPacketAcks(rawOnlyPacket, run, "raw-only source fixture"),
      (error) => error?.data?.reason === "COMPANY_DOSSIER_PACKET_ACK_MISMATCH"
        && error.data.problems.some((problem) => problem.reason === "top_level_source_outside_projection")
        && error.data.problems.some((problem) => problem.reason === "used_source_outside_packet"),
    );

    const dispositionConflict = {
      source_ids: ["market_data:S1"],
      evidence_packet_acks: ackRows,
    };
    assert.throws(
      () => assertCompanyDossierPacketAcks(dispositionConflict, run, "disposition conflict fixture"),
      (error) => error?.data?.reason === "COMPANY_DOSSIER_PACKET_ACK_MISMATCH"
        && error.data.problems.some((problem) => (
          problem.task === "market_data"
          && problem.reason === "top_level_source_conflicts_with_packet_disposition"
        )),
    );
  } finally {
    rmSync(frozen.dir, { recursive: true, force: true });
  }
});

test("a planless legacy dossier cannot project unverified acquisition values or malformed attempts", () => {
  const market = coveredPacket("market_data");
  market.acquisition_ledger.items[0].attempts = "Reviewed a provider in prose.";
  market.acquisition_ledger.items[0].data = { value: 999_999, unit: "fabricated_fixture" };
  const run = companyRun(DEFAULT_TASKS.map((task) => task === market.task ? market : coveredPacket(task)));
  const frozen = freezeCompanyDossier(run);
  try {
    assert.equal(frozen.dossier.consumer_contract.source_acquisition_policy_id, null);
    const projection = companyDossierDecisionProjection(run);
    const quote = projection.packets
      .find((packet) => packet.task === "market_data")
      .routes.find((route) => route.id === "market.quote_snapshot");
    assert.equal(quote.outcome, "not_recorded");
    assert.deepEqual(quote.outcome_source_ids, []);
    assert.deepEqual(quote.attempt_source_ids, []);
    assert.equal(Object.hasOwn(quote, "data"), false);
    assert.doesNotMatch(JSON.stringify(projection), /fabricated_fixture|999999|Reviewed a provider/u);
  } finally {
    rmSync(frozen.dir, { recursive: true, force: true });
  }
});

test("an oversized decision projection fails closed instead of silently truncating evidence", () => {
  const market = coveredPacket("market_data");
  market.claims[0].evidence = "X".repeat(COMPANY_DOSSIER_DECISION_PROJECTION_MAX_BYTES + 1);
  const run = companyRun(DEFAULT_TASKS.map((task) => task === market.task ? market : coveredPacket(task)));
  run.grounding.source_acquisition_plan = { policy_id: "company_source_acquisition_v1" };
  const frozen = freezeCompanyDossier(run);
  try {
    assert.throws(
      () => companyDossierDecisionProjection(run),
      (error) => error?.data?.reason === "COMPANY_DOSSIER_DECISION_PROJECTION_OVERSIZE",
    );
  } finally {
    rmSync(frozen.dir, { recursive: true, force: true });
  }
});

test("only a real full operating-company decision run requires the dossier", () => {
  const run = companyRun();
  assert.equal(requiresOperatingCompanyDossier({ ...run, entry_tool: "analyze_symbol" }), true);
  assert.equal(requiresOperatingCompanyDossier({ ...run, entry_tool: "collect_evidence" }), false);
  assert.equal(requiresOperatingCompanyDossier({ ...run, entry_tool: "analyze_symbol", decision_requested: false }), false);
  assert.equal(requiresOperatingCompanyDossier({ ...run, council_mode: "quick" }), false);
  assert.equal(requiresOperatingCompanyDossier({
    ...run,
    grounding: { instrument: { research_model: "fund_lookthrough" } },
  }), false);
});

test("missing, duplicate, extra, and unknown-source coverage items fail closed with exact diagnostics", () => {
  const task = "market_data";
  const base = coveredPacket(task);
  const firstId = expectedCoverageItems(task)[0];

  const missing = structuredClone(base);
  missing.coverage_items = missing.coverage_items.filter((item) => item.id !== firstId);
  const missingStatus = coverageForPacket(missing);
  assert.equal(missingStatus.status, "incomplete");
  assert.deepEqual(missingStatus.missing, [{ task, id: firstId }]);

  const duplicate = structuredClone(base);
  duplicate.coverage_items.push(structuredClone(duplicate.coverage_items[0]));
  const duplicateStatus = coverageForPacket(duplicate);
  assert.equal(duplicateStatus.status, "incomplete");
  assert.ok(duplicateStatus.invalid.some((item) => (
    item.task === task && item.id === firstId && item.reason === "duplicate"
  )));

  const extra = structuredClone(base);
  extra.coverage_items.push({
    id: "market.unregistered_extra",
    status: "covered",
    source_ids: [base.sources[0].id],
  });
  const extraStatus = coverageForPacket(extra);
  assert.equal(extraStatus.status, "incomplete");
  assert.ok(extraStatus.invalid.some((item) => (
    item.task === task && item.id === "market.unregistered_extra" && item.reason === "unexpected"
  )));

  const unknownSource = structuredClone(base);
  unknownSource.coverage_items[0].source_ids = [`${task}:UNKNOWN`];
  const unknownStatus = coverageForPacket(unknownSource);
  assert.equal(unknownStatus.status, "incomplete");
  assert.ok(unknownStatus.invalid.some((item) => (
    item.task === task
      && item.id === firstId
      && item.reason === "unknown_source_ids"
      && item.source_ids.includes(`${task}:UNKNOWN`)
  )));

  const futureSource = structuredClone(base);
  futureSource.sources[0].published_at = "2099-01-01";
  const futureStatus = coverageForPacket(futureSource);
  assert.equal(futureStatus.status, "incomplete");
  assert.ok(futureStatus.invalid.some((item) => (
    item.task === task && item.reason === "covered_source_after_as_of"
  )));

  const observedDynamicSource = structuredClone(base);
  observedDynamicSource.sources[0].published_at = "unknown";
  observedDynamicSource.sources[0].source_kind = "dynamic_snapshot";
  observedDynamicSource.sources[0].observed_at = `${AS_OF}T12:00:00Z`;
  const observedDynamicStatus = coverageForPacket(observedDynamicSource);
  assert.equal(observedDynamicStatus.status, "complete");

  const untypedObservedSource = structuredClone(observedDynamicSource);
  delete untypedObservedSource.sources[0].source_kind;
  const untypedObservedStatus = coverageForPacket(untypedObservedSource);
  assert.equal(untypedObservedStatus.status, "incomplete");
  assert.ok(untypedObservedStatus.invalid.some((item) => (
    item.task === task && item.reason === "covered_undated_source_not_dynamic_snapshot"
  )));

  const undatedSource = structuredClone(base);
  undatedSource.sources[0].published_at = "unknown";
  const undatedStatus = coverageForPacket(undatedSource);
  assert.equal(undatedStatus.status, "incomplete");
  assert.ok(undatedStatus.invalid.some((item) => (
    item.task === task && item.reason === "covered_undated_source_not_dynamic_snapshot"
  )));

  const undatedNews = coveredPacket("news_industry_management");
  undatedNews.sources[0].published_at = "unknown";
  undatedNews.sources[0].source_kind = "dynamic_snapshot";
  undatedNews.sources[0].observed_at = `${AS_OF}T12:00:00Z`;
  const undatedNewsStatus = coverageForPacket(undatedNews);
  assert.equal(undatedNewsStatus.status, "incomplete");
  assert.ok(undatedNewsStatus.invalid.some((item) => (
    item.task === "news_industry_management"
      && item.reason === "covered_event_or_news_without_dated_source"
  )));

  const invalidUrl = structuredClone(base);
  invalidUrl.sources[0].url = "memory://unsupported-source";
  const invalidUrlStatus = coverageForPacket(invalidUrl);
  assert.equal(invalidUrlStatus.status, "incomplete");
  assert.ok(invalidUrlStatus.invalid.some((item) => (
    item.task === task && item.reason === "covered_source_without_valid_url"
  )));

  const wrongScope = structuredClone(base);
  wrongScope.sources[0].id = "earnings_deep_dive:S1";
  for (const item of wrongScope.coverage_items) item.source_ids = [wrongScope.sources[0].id];
  const wrongScopeStatus = coverageForPacket(wrongScope);
  assert.equal(wrongScopeStatus.status, "incomplete");
  assert.ok(wrongScopeStatus.invalid.some((item) => (
    item.task === task && item.reason === "covered_source_wrong_task_scope"
  )));

  const methodOnly = structuredClone(base);
  methodOnly.sources[0].source_kind = "method_definition";
  const methodOnlyStatus = coverageForPacket(methodOnly);
  assert.equal(methodOnlyStatus.status, "incomplete");
  assert.ok(methodOnlyStatus.invalid.some((item) => (
    item.task === task && item.reason === "covered_source_not_in_evidence_domain"
  )));
});

test("unavailable coverage requires a named attempt, valid attempted URLs, and an identical explicit gap", () => {
  const task = "forward_expectations";
  const gap = "The dated consensus revision history was unavailable after the named provider lookup.";
  const packet = coveredPacket(task);
  markUnavailable(packet, "expectations.estimate_dispersion_revisions", {
    attemptedUrls: ["https://example.test/consensus/revisions"],
    gap,
  });

  const complete = coverageForPacket(packet);
  assert.equal(complete.status, "complete");
  assert.equal(complete.retrieval_status, "complete_with_explicit_unavailable_data");
  assert.equal(complete.unavailable_count, 1);
  assert.equal(complete.invalid.length, 0);

  const unavailableIndex = packet.coverage_items.findIndex((item) => (
    item.id === "expectations.estimate_dispersion_revisions"
  ));
  const cases = [
    ["unavailable_without_attempt", (candidate) => {
      candidate.coverage_items[unavailableIndex].attempted = "";
    }],
    ["unavailable_without_valid_attempted_urls", (candidate) => {
      delete candidate.coverage_items[unavailableIndex].attempted_urls;
    }],
    ["unavailable_without_valid_attempted_urls", (candidate) => {
      candidate.coverage_items[unavailableIndex].attempted_urls = [
        "ftp://example.test/consensus/revisions",
      ];
    }],
    ["unavailable_without_gap", (candidate) => {
      candidate.coverage_items[unavailableIndex].gap = "";
      candidate.open_questions = [];
    }],
    ["gap_not_in_open_questions", (candidate) => { candidate.open_questions = ["A different gap."]; }],
  ];
  for (const [reason, mutate] of cases) {
    const candidate = structuredClone(packet);
    mutate(candidate);
    const status = coverageForPacket(candidate);
    assert.equal(status.status, "incomplete", reason);
    assert.ok(status.invalid.some((item) => item.reason === reason), reason);
  }
});

test("paywalled sell-side consensus is a declared gap, not a decision barrier", () => {
  // Every other critical id is obtainable from a filing, an issuer page or a free market
  // source. Consensus revenue/EPS is licensed (FactSet/Refinitiv/Bloomberg), so holding the
  // barrier on it made `insufficient` the standing outcome for operating companies: the seat
  // honestly reported `unavailable`, was retroactively demoted to `failed`, and that single
  // demotion aborted the council before any method seat, the debate or the PM ran.
  const coverage = coverageForPacket(
    markUnavailable(coveredPacket("forward_expectations"), "expectations.consensus_revenue_eps"),
  );
  assert.equal(coverage.status, "complete");
  assert.equal(coverage.sufficiency, "limited", "a licensed-data gap limits the dossier");
  assert.equal(coverage.decision_barrier_ready, true, "it must not abort the council");
  assert.deepEqual(coverage.critical_gaps, [], "consensus is not a critical gap");
  // The route stays owned and required, so the seat must still attempt it and declare an outcome.
  assert.ok(
    OPERATING_COMPANY_COVERAGE.forward_expectations.includes("expectations.consensus_revenue_eps"),
  );
});

test("critical unavailable data blocks the decision while non-critical unavailable data remains usable", () => {
  const criticalTask = "market_data";
  const criticalId = "market.quote_snapshot";
  const critical = coverageForPacket(markUnavailable(coveredPacket(criticalTask), criticalId));
  assert.equal(critical.status, "complete");
  assert.equal(critical.retrieval_status, "complete_with_explicit_unavailable_data");
  assert.equal(critical.sufficiency, "insufficient");
  assert.equal(critical.decision_barrier_ready, false);
  assert.deepEqual(critical.critical_unavailable, [{ task: criticalTask, id: criticalId }]);
  assert.deepEqual(critical.critical_gaps, [{ task: criticalTask, id: criticalId, status: "unavailable" }]);

  const criticalNotApplicablePacket = coveredPacket(criticalTask);
  const criticalNotApplicableItem = criticalNotApplicablePacket.coverage_items
    .find((item) => item.id === criticalId);
  Object.assign(criticalNotApplicableItem, {
    status: "not_applicable",
    source_ids: [],
    note: "The fixture claims the critical quote is not applicable.",
  });
  const criticalNotApplicable = coverageForPacket(criticalNotApplicablePacket);
  assert.equal(criticalNotApplicable.status, "complete");
  assert.equal(criticalNotApplicable.sufficiency, "insufficient");
  assert.equal(criticalNotApplicable.decision_barrier_ready, false);
  assert.deepEqual(criticalNotApplicable.critical_not_applicable, [{
    task: criticalTask,
    id: criticalId,
    status: "not_applicable",
  }]);

  const nonCriticalTask = "market_data";
  const nonCriticalId = "market.liquidity_volume";
  const nonCritical = coverageForPacket(
    markUnavailable(coveredPacket(nonCriticalTask), nonCriticalId),
  );
  assert.equal(nonCritical.status, "complete");
  assert.equal(nonCritical.retrieval_status, "complete_with_explicit_unavailable_data");
  assert.equal(nonCritical.sufficiency, "limited");
  assert.equal(nonCritical.decision_barrier_ready, true);
  assert.deepEqual(nonCritical.critical_unavailable, []);
  assert.deepEqual(nonCritical.critical_gaps, []);

  const unannouncedDate = coverageForPacket(markUnavailable(
    coveredPacket("forward_expectations"),
    "expectations.next_reporting_date",
  ));
  assert.equal(unannouncedDate.status, "complete");
  assert.equal(unannouncedDate.sufficiency, "limited");
  assert.equal(unannouncedDate.decision_barrier_ready, true);
  assert.deepEqual(unannouncedDate.critical_gaps, []);
});

test("coverage instructions map supplied market-history provenance to packet-local aliases", () => {
  const run = companyRun();
  run.language = "中文";
  run.grounding.market_history = {
    available: true,
    source_records: [{ id: "market_history:VRT:2026-08-05" }],
  };
  const market = companyCoverageInstruction("market_data", run);
  assert.match(market, /必须直接使用其 subject、benchmarks、relative_performance/);
  assert.match(market, /不得因为另一个网页打不开而把已提供的数据改写成 unavailable/);
  assert.match(market, /保留 title、url、published_at、retrieved_at、observed_at 与 source_kind/);
  assert.match(market, /一一映射为本包内唯一、无冒号的本地别名（如 S1\/S2）/);
  assert.match(market, /claims、coverage_items 与 acquisition_ledger（包括 attempts）里的所有 source_ids 只能引用这些别名/);
  assert.match(market, /record_visible_packet 会在入库时加上 market_data: 作用域/);
  assert.match(market, /绝不能把 market_history:\* 服务器 ID 原样放进 packet/);

  run.language = "English";
  const englishMarket = companyCoverageInstruction("market_data", run);
  assert.match(englishMarket, /unique colon-free packet-local alias \(for example S1\/S2\)/);
  assert.match(englishMarket, /claims, coverage_items, and acquisition_ledger \(including attempts\)/);
  assert.match(englishMarket, /Never put a market_history:\* server ID verbatim in the packet/);

  run.language = "日本語";
  assert.match(companyCoverageInstruction("market_data", run), /コロンを含まないローカル別名（例 S1\/S2）/);
  run.language = "한국어";
  assert.match(companyCoverageInstruction("market_data", run), /콜론이 없는 로컬 별칭\(예: S1\/S2\)/);

  run.language = "中文";
  const expectations = companyCoverageInstruction("forward_expectations", run);
  assert.match(expectations, /第三方预计、非发行人确认/);
  assert.match(expectations, /绝不能冒充公司公告/);
  const earnings = companyCoverageInstruction("earnings_deep_dive", run);
  assert.match(earnings, /二级转录来源/);
  assert.match(earnings, /不得冒充官方逐字稿/);
});

test("the dossier hash is canonical, ignores raw transport text, and covers tail and deep evidence", () => {
  const packets = DEFAULT_TASKS.map((task) => coveredPacket(task, { expanded: task === "market_data" }));
  const run = companyRun(packets);
  const manifest = sourceManifest(run);
  const original = buildCompanyDossier(run, manifest);
  assert.match(original.content_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(original.coverage.expected_count, 52);
  assert.equal(original.coverage.status, "complete");

  const runtimeUndefined = structuredClone(run);
  runtimeUndefined.grounding.coverage = { rows: [{ id: "fixture", needs_env: null }] };
  runtimeUndefined.grounding.coverage.rows[0].needs_env = undefined;
  const manifestWithUndefined = structuredClone(manifest);
  manifestWithUndefined.sources[0].optional_runtime_field = undefined;
  assert.doesNotThrow(() => buildCompanyDossier(runtimeUndefined, manifestWithUndefined));

  const reorderedRun = reverseObjectKeys(structuredClone(run));
  const reorderedManifest = reverseObjectKeys(structuredClone(manifest));
  assert.equal(
    buildCompanyDossier(reorderedRun, reorderedManifest).content_hash,
    original.content_hash,
    "object key insertion order must not change the canonical dossier hash",
  );

  const rawTextOnly = structuredClone(run);
  rawTextOnly.packets[0].raw_text = "A completely different private transport transcript.";
  assert.equal(
    buildCompanyDossier(rawTextOnly, manifest).content_hash,
    original.content_hash,
    "raw worker transport text is not investment evidence",
  );

  const tailClaim = structuredClone(run);
  tailClaim.packets[0].claims[8].evidence = "TAIL-CLAIM-CHANGED";
  assert.notEqual(buildCompanyDossier(tailClaim, manifest).content_hash, original.content_hash);

  const tailSource = structuredClone(run);
  tailSource.packets[0].sources[12].title = "TAIL-SOURCE-CHANGED";
  assert.notEqual(buildCompanyDossier(tailSource, manifest).content_hash, original.content_hash);

  const deepMetric = structuredClone(run);
  deepMetric.packets[0].metrics.deep.level_two.level_three.level_four.value = "DEEP-B";
  assert.notEqual(buildCompanyDossier(deepMetric, manifest).content_hash, original.content_hash);

  const explicitGap = structuredClone(run);
  const item = explicitGap.packets[1].coverage_items[0];
  item.status = "unavailable";
  item.source_ids = [];
  item.attempted = "A named retrieval attempt completed without usable data.";
  item.attempted_urls = ["https://example.test/retrieval-attempt"];
  item.gap = "A newly explicit dossier gap.";
  explicitGap.packets[1].open_questions.push(item.gap);
  assert.notEqual(buildCompanyDossier(explicitGap, manifest).content_hash, original.content_hash);
});
