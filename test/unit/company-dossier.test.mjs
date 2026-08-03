import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import {
  OPERATING_COMPANY_COVERAGE,
  buildCompanyDossier,
  companyDossierCoverageStatus,
  expectedCoverageItems,
  requiresOperatingCompanyDossier,
} from "../../mcp/lib/company-dossier.mjs";

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
    coverage_items: expectedCoverageItems(task).map((id) => ({
      id,
      status: "covered",
      source_ids: [sources[0].id],
      note: `Covered by ${sources[0].id}.`,
    })),
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
  return packet;
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
