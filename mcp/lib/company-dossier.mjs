import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson } from "./personas-v3/canonical.mjs";
import { internalError, invalidParams } from "./errors.mjs";
import { isChineseLanguage, localized } from "./lang.mjs";

export const COMPANY_DOSSIER_CONTRACT_ID = "operating_company_dossier_v1";
export const COMPANY_DOSSIER_DECISION_PROJECTION_ID = "operating_company_dossier_decision_projection_v1";
export const COMPANY_DOSSIER_DECISION_PROJECTION_MAX_BYTES = 512 * 1024;
export const EVIDENCE_PACKET_ACK_STATUSES = Object.freeze([
  "used",
  "reviewed_not_relevant",
  "unavailable",
]);

// Missing one of these surfaces means the council cannot make a decision-grade company call.
// Other unavailable fields remain visible as limitations but do not erase otherwise usable
// evidence (for example, a company may have no listed options or no recent transaction).
export const CRITICAL_COMPANY_COVERAGE_IDS = Object.freeze([
  "market.identity_listing_currency",
  "market.quote_snapshot",
  "market.price_history_range",
  "financials.business_model",
  "financials.latest_reported_period",
  "financials.historical_statements",
  "financials.balance_sheet_liquidity",
  "financials.cash_flow_capex",
  "financials.segments_geography",
  // `expectations.consensus_revenue_eps` is deliberately NOT critical. Every other id here is
  // obtainable from a filing, an issuer page or a free market source, so a gap in one is a
  // research failure worth blocking on. Sell-side consensus is not: it lives behind FactSet /
  // Refinitiv / Bloomberg licensing, so a keyless council can almost never source it. Holding
  // the decision barrier on it made `insufficient` the standing outcome for operating
  // companies -- the seat honestly reported `unavailable`, was retroactively demoted to
  // `failed`, and that one demotion aborted the whole council before any method seat, the
  // debate or the PM ran. It stays a required, owned route, so the seat must still attempt it
  // and declare the outcome; an explicit unavailable now lands in `limited` and is published in
  // the report's data-gap section instead of silently costing the reader the entire run.
  "valuation.trading_multiples",
  "valuation.bear_base_bull",
  "news.regulator_timeline",
  "news.issuer_ir_newsroom",
  "news.recent_company_developments",
  "ownership.debt_liquidity_capital_allocation",
]);

const CRITICAL_COMPANY_COVERAGE = new Set(CRITICAL_COMPANY_COVERAGE_IDS);
const DYNAMIC_SOURCE_KIND = "dynamic_snapshot";
const COVERAGE_REQUIRING_DATED_SOURCE = (id) => (
  id.startsWith("news.") || (id.startsWith("events.") && id !== "events.event_calendar")
);

/**
 * Machine-checkable coverage owned by the eight mandatory full-council evidence roles.
 *
 * "All company information" cannot mean every page on the public internet. It means every
 * decision-relevant domain below is either sourced, explicitly unavailable after a named
 * attempt, or genuinely not applicable. A worker may not silently omit a domain.
 */
export const OPERATING_COMPANY_COVERAGE = Object.freeze({
  market_data: Object.freeze([
    "market.identity_listing_currency",
    "market.quote_snapshot",
    "market.price_history_range",
    "market.liquidity_volume",
    "market.technical_levels",
    "market.relative_performance",
  ]),
  earnings_deep_dive: Object.freeze([
    "financials.business_model",
    "financials.latest_reported_period",
    "financials.historical_statements",
    "financials.balance_sheet_liquidity",
    "financials.cash_flow_capex",
    "financials.segments_geography",
    "financials.margins_returns_quality",
    "financials.customer_supplier_concentration",
    "financials.guidance",
    "financials.earnings_call_qna",
  ]),
  forward_expectations: Object.freeze([
    "expectations.consensus_revenue_eps",
    "expectations.estimate_dispersion_revisions",
    "expectations.implied_beat_miss_thresholds",
    "expectations.ratings_target_changes",
    "expectations.next_reporting_date",
  ]),
  quant_factor: Object.freeze([
    "quant.momentum_trend_volatility",
    "quant.relative_strength_factors",
    "quant.liquidity_volume_regime",
    "quant.short_interest_borrow",
    "quant.options_iv_skew_expected_move",
    "quant.peer_cross_section",
  ]),
  valuation_long_short: Object.freeze([
    "valuation.trading_multiples",
    "valuation.peer_comparables",
    "valuation.dcf_reverse_dcf",
    "valuation.bear_base_bull",
    "valuation.catalysts_invalidation",
    "valuation.long_short_asymmetry",
  ]),
  news_industry_management: Object.freeze([
    "news.regulator_timeline",
    "news.issuer_ir_newsroom",
    "news.recent_company_developments",
    "news.industry_competition",
    "news.customers_suppliers_partners",
    "news.management_board_changes",
    "news.regulation_litigation",
    "news.disconfirming_search",
  ]),
  insider_sec: Object.freeze([
    "ownership.insider_transactions",
    "ownership.ownership_control",
    "ownership.buybacks_dilution",
    "ownership.debt_liquidity_capital_allocation",
    "ownership.governance_related_parties",
    "ownership.accounting_controls_restatements",
  ]),
  ib_event_analysis: Object.freeze([
    "events.mna_strategic_transactions",
    "events.capital_markets_financing",
    "events.restructuring_spinoff",
    "events.material_contracts_commitments",
    "events.event_calendar",
  ]),
});

export function requiresOperatingCompanyDossier(run = {}) {
  if (run.council_mode === "quick" || run.dry_run === true) return false;
  // Task-selective evidence diagnostics cannot publish a dossier-backed investment decision.
  // Keep them usable for repair and provenance checks without weakening a real full council.
  if (run.decision_requested === false || run.entry_tool === "collect_evidence") return false;
  const researchModel = run?.grounding?.instrument?.research_model;
  if (researchModel === "operating_company") return true;
  if (["fund_lookthrough", "index_aggregate"].includes(researchModel)) return false;
  // Public selected runs carry entry_tool. Unknown classification must fail closed into the
  // company dossier contract rather than letting a caller omit `instrument` to bypass it.
  // Direct library tests may still construct minimal run objects without entry_tool.
  return Boolean(run.entry_tool);
}

export function expectedCoverageItems(task) {
  return OPERATING_COMPANY_COVERAGE[task] || [];
}

export function normalizeCompanyCoverageItems(items, task, sourceIdMap = new Map()) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    ...(item && typeof item === "object" ? item : {}),
    id: String(item?.id || "").trim(),
    status: typeof item?.status === "string" ? item.status.trim() : item?.status,
    source_ids: Array.isArray(item?.source_ids)
      ? [...new Set(item.source_ids.map((id) => {
        const raw = String(id || "").trim();
        if (!raw) return "";
        return sourceIdMap.get(raw) || (raw.includes(":") ? raw : `${task}:${raw}`);
      }).filter(Boolean))]
      : [],
    note: typeof item?.note === "string" ? item.note : "",
    attempted: typeof item?.attempted === "string" ? item.attempted : "",
    attempted_urls: Array.isArray(item?.attempted_urls)
      ? [...new Set(item.attempted_urls.map((value) => String(value || "").trim()).filter(Boolean))]
      : [],
    gap: typeof item?.gap === "string" ? item.gap : "",
  }));
}

function packetSourceMap(packet) {
  return new Map((packet?.sources || [])
    .map((source) => [String(source?.id || "").trim(), source])
    .filter(([id]) => Boolean(id)));
}

function methodOnlyEvidenceSource(source) {
  const id = String(source?.id || "").trim();
  const kind = String(source?.source_kind || "").trim().toLowerCase();
  return /^proxy:/iu.test(id)
    || /^(?:method|methodology|persona_method)(?:_|$)/u.test(kind)
    || new Set([
      "derived_proxy", "editorial_choice", "method_definition", "method_provenance",
      "method_rule", "method_source", "methodology_definition", "persona_method_definition",
    ]).has(kind);
}

function packetCoverageStatus(packet, expected = expectedCoverageItems(packet?.task), asOfDate = null) {
  const supplied = Array.isArray(packet?.coverage_items) ? packet.coverage_items : [];
  const byId = new Map();
  const duplicates = [];
  const unexpected = [];
  for (const item of supplied) {
    const id = String(item?.id || "").trim();
    if (!expected.includes(id)) {
      if (id) unexpected.push(id);
      continue;
    }
    if (byId.has(id)) duplicates.push(id);
    else byId.set(id, item);
  }
  const sourceById = packetSourceMap(packet);
  const missing = expected.filter((id) => !byId.has(id));
  const invalid = [];
  let covered = 0;
  let unavailable = 0;
  let notApplicable = 0;
  for (const id of expected) {
    const item = byId.get(id);
    if (!item) continue;
    const status = item.status;
    const ids = Array.isArray(item.source_ids)
      ? [...new Set(item.source_ids.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
    const unknown = ids.filter((sourceId) => !sourceById.has(sourceId));
    if (unknown.length) invalid.push({ id, reason: "unknown_source_ids", source_ids: unknown });
    if (status === "covered") {
      covered += 1;
      if (!ids.length) invalid.push({ id, reason: "covered_without_source" });
      let validDatedSourceCount = 0;
      for (const sourceId of ids.filter((value) => sourceById.has(value))) {
        const source = sourceById.get(sourceId);
        if (!sourceId.startsWith(`${packet.task}:`)) {
          invalid.push({ id, reason: "covered_source_wrong_task_scope", source_id: sourceId });
        }
        if (methodOnlyEvidenceSource(source)) {
          invalid.push({ id, reason: "covered_source_not_in_evidence_domain", source_id: sourceId });
        }
        let urlValid = false;
        try {
          const parsed = new URL(String(source?.url || ""));
          urlValid = parsed.protocol === "http:" || parsed.protocol === "https:";
        } catch {
          urlValid = false;
        }
        if (!urlValid) invalid.push({ id, reason: "covered_source_without_valid_url", source_id: sourceId });
        const publishedAt = Date.parse(String(source?.published_at || ""));
        const observedAt = Date.parse(String(source?.observed_at || ""));
        const dynamicSnapshot = String(source?.source_kind || "").trim().toLowerCase() === DYNAMIC_SOURCE_KIND;
        const sourceTime = Number.isFinite(publishedAt)
          ? publishedAt
          : dynamicSnapshot ? observedAt : NaN;
        const timeField = Number.isFinite(publishedAt) ? "published_at" : "observed_at";
        if (!Number.isFinite(publishedAt) && !dynamicSnapshot) {
          invalid.push({ id, reason: "covered_undated_source_not_dynamic_snapshot", source_id: sourceId });
        } else if (!Number.isFinite(sourceTime)) {
          invalid.push({ id, reason: "covered_source_without_publication_or_observation_time", source_id: sourceId });
        } else if (asOfDate) {
          const cutoff = Date.parse(`${asOfDate}T23:59:59.999Z`);
          if (Number.isFinite(cutoff) && sourceTime > cutoff) {
            invalid.push({
              id,
              reason: "covered_source_after_as_of",
              source_id: sourceId,
              time_field: timeField,
              source_time: source?.[timeField],
              as_of: asOfDate,
            });
          } else if (Number.isFinite(publishedAt)) {
            validDatedSourceCount += 1;
          }
        } else if (Number.isFinite(publishedAt)) {
          validDatedSourceCount += 1;
        }
      }
      if (COVERAGE_REQUIRING_DATED_SOURCE(id) && ids.length && validDatedSourceCount === 0) {
        invalid.push({ id, reason: "covered_event_or_news_without_dated_source" });
      }
      continue;
    }
    if (status === "unavailable") {
      unavailable += 1;
      const attempted = String(item.attempted || "").trim();
      const attemptedUrls = Array.isArray(item.attempted_urls)
        ? [...new Set(item.attempted_urls.map((value) => String(value || "").trim()).filter(Boolean))]
        : [];
      const gap = String(item.gap || "").trim();
      if (!attempted) invalid.push({ id, reason: "unavailable_without_attempt" });
      if (!attemptedUrls.length || attemptedUrls.some((value) => {
        try {
          const parsed = new URL(value);
          return parsed.protocol !== "http:" && parsed.protocol !== "https:";
        } catch {
          return true;
        }
      })) {
        invalid.push({ id, reason: "unavailable_without_valid_attempted_urls" });
      }
      if (!gap) invalid.push({ id, reason: "unavailable_without_gap" });
      if (gap && !(packet.open_questions || []).includes(gap)) {
        invalid.push({ id, reason: "gap_not_in_open_questions" });
      }
      continue;
    }
    if (status === "not_applicable") {
      notApplicable += 1;
      if (!String(item.note || "").trim()) invalid.push({ id, reason: "not_applicable_without_reason" });
      continue;
    }
    invalid.push({ id, reason: "invalid_status" });
  }
  const complete = missing.length === 0 && duplicates.length === 0
    && unexpected.length === 0 && invalid.length === 0;
  return {
    task: packet?.task || null,
    expected_count: expected.length,
    supplied_count: supplied.length,
    covered_count: covered,
    unavailable_count: unavailable,
    not_applicable_count: notApplicable,
    missing,
    duplicates: [...new Set(duplicates)],
    unexpected: [...new Set(unexpected)],
    invalid,
    status: complete ? "complete" : "incomplete",
  };
}

export function companyDossierCoverageStatus(run = {}) {
  if (!requiresOperatingCompanyDossier(run)) {
    return {
      contract_id: COMPANY_DOSSIER_CONTRACT_ID,
      required: false,
      status: "not_applicable",
      retrieval_status: "not_applicable",
      sufficiency: "not_applicable",
      decision_barrier_ready: true,
      expected_count: 0,
      covered_count: 0,
      unavailable_count: 0,
      not_applicable_count: 0,
      missing: [],
      invalid: [],
      tasks: [],
    };
  }
  const packets = new Map((run.packets || []).map((packet) => [packet.task, packet]));
  // The contract owns the mandatory task list. It must not become weaker if a caller mutates
  // run.tasks or replays an older run that planned only a subset.
  const taskStatuses = Object.keys(OPERATING_COMPANY_COVERAGE)
    .map((task) => packetCoverageStatus(
      packets.get(task) || { task },
      expectedCoverageItems(task),
      run.as_of,
    ));
  const missing = taskStatuses.flatMap((entry) => entry.missing.map((id) => ({ task: entry.task, id })));
  const invalid = taskStatuses.flatMap((entry) => [
    ...entry.duplicates.map((id) => ({ task: entry.task, id, reason: "duplicate" })),
    ...entry.unexpected.map((id) => ({ task: entry.task, id, reason: "unexpected" })),
    ...entry.invalid.map((item) => ({ task: entry.task, ...item })),
  ]);
  const expectedCount = taskStatuses.reduce((sum, entry) => sum + entry.expected_count, 0);
  const coveredCount = taskStatuses.reduce((sum, entry) => sum + entry.covered_count, 0);
  const unavailableCount = taskStatuses.reduce((sum, entry) => sum + entry.unavailable_count, 0);
  const notApplicableCount = taskStatuses.reduce((sum, entry) => sum + entry.not_applicable_count, 0);
  const complete = taskStatuses.length > 0 && taskStatuses.every((entry) => entry.status === "complete");
  const unavailableItems = taskStatuses.flatMap((entry) => {
    const packet = packets.get(entry.task);
    return (packet?.coverage_items || [])
      .filter((item) => item?.status === "unavailable")
      .map((item) => ({ task: entry.task, id: String(item.id || "") }));
  });
  const criticalUnavailable = unavailableItems.filter((item) => CRITICAL_COMPANY_COVERAGE.has(item.id));
  const criticalNotApplicable = taskStatuses.flatMap((entry) => {
    const packet = packets.get(entry.task);
    return (packet?.coverage_items || [])
      .filter((item) => item?.status === "not_applicable" && CRITICAL_COMPANY_COVERAGE.has(String(item.id || "")))
      .map((item) => ({ task: entry.task, id: String(item.id || ""), status: "not_applicable" }));
  });
  const criticalGaps = [
    ...criticalUnavailable.map((item) => ({ ...item, status: "unavailable" })),
    ...criticalNotApplicable,
  ];
  const sufficiency = !complete
    ? "insufficient"
    : criticalGaps.length
      ? "insufficient"
      : unavailableItems.length
        ? "limited"
        : "sufficient";
  return {
    contract_id: COMPANY_DOSSIER_CONTRACT_ID,
    required: true,
    status: complete ? "complete" : "incomplete",
    retrieval_status: complete
      ? (unavailableCount ? "complete_with_explicit_unavailable_data" : "complete")
      : "incomplete",
    sufficiency,
    decision_barrier_ready: complete && sufficiency !== "insufficient",
    expected_count: expectedCount,
    covered_count: coveredCount,
    unavailable_count: unavailableCount,
    not_applicable_count: notApplicableCount,
    missing,
    invalid,
    critical_unavailable: criticalUnavailable,
    critical_not_applicable: criticalNotApplicable,
    critical_gaps: criticalGaps,
    tasks: taskStatuses,
  };
}

export function assertCompanyCoveragePacket(packet, run, { client = false } = {}) {
  if (!requiresOperatingCompanyDossier(run)) return packet;
  const status = packetCoverageStatus(packet, expectedCoverageItems(packet?.task), run?.as_of);
  if (status.status === "complete") return packet;
  const error = `${packet.task} did not satisfy ${COMPANY_DOSSIER_CONTRACT_ID}`;
  const data = {
    reason: "COMPANY_DOSSIER_COVERAGE_MISMATCH",
    contract_id: COMPANY_DOSSIER_CONTRACT_ID,
    task: packet.task,
    coverage: status,
  };
  throw (client ? invalidParams(error, data) : internalError(error, data));
}

function withoutRawText(packet) {
  // Hash exactly the JSON value that can be persisted. Runtime objects may carry optional
  // properties with value `undefined`; those are absent from a JSON artifact and must not turn
  // an otherwise valid quick/company packet into a canonicalization exception.
  const copy = JSON.parse(JSON.stringify(packet || {}));
  delete copy.raw_text;
  return copy;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function hashCanonical(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/** Stable evidence identity used to make visible packet recording append-only. */
export function companyEvidencePacketHash(packet) {
  const normalized = withoutRawText(packet);
  delete normalized.thread_id;
  delete normalized.thread_title;
  delete normalized.execution_mode;
  return hashCanonical(normalized);
}

function packetManifest(packet) {
  const normalized = withoutRawText(packet);
  return {
    task: packet?.task || null,
    packet_hash: hashCanonical(normalized),
    claim_count: Array.isArray(packet?.claims) ? packet.claims.length : 0,
    source_count: Array.isArray(packet?.sources) ? packet.sources.length : 0,
    coverage_item_count: Array.isArray(packet?.coverage_items) ? packet.coverage_items.length : 0,
    acquisition_item_count: Array.isArray(packet?.acquisition_ledger?.items)
      ? packet.acquisition_ledger.items.length
      : 0,
  };
}

export function companyDossierPacketAckTemplate(run, { includePacketHash = true } = {}) {
  if (!requiresOperatingCompanyDossier(run)) return [];
  return (run.packets || []).map(packetManifest).map((manifest) => ({
    task: manifest.task,
    ...(includePacketHash ? { packet_hash: manifest.packet_hash } : {}),
    status: "reviewed_not_relevant",
    source_ids: [],
    note: "<replace with the method-specific reason, or mark used and cite packet-local source IDs>",
  }));
}

function claimLedger(packets) {
  return packets.flatMap((packet) => (packet?.claims || []).map((claim, index) => ({
    claim_id: `${packet.task}:C${index + 1}`,
    task: packet.task,
    claim_index: index,
    claim: claim?.claim || "",
    evidence: claim?.evidence || "",
    confidence: claim?.confidence || packet?.confidence || "low",
    source_ids: Array.isArray(claim?.source_ids) ? claim.source_ids : [],
  })));
}

function sourceLedger(sourceManifest) {
  return (sourceManifest?.sources || []).map((source) => {
    const normalized = jsonClone(source);
    return {
      ...normalized,
      // This hashes the stored source record and locator, not the remote page body. The dossier
      // never claims to have archived a webpage it did not actually persist.
      source_record_hash: hashCanonical(normalized),
    };
  });
}

function dossierInputBinding(run) {
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    language: run.language,
    tasks: Array.isArray(run.tasks) ? run.tasks : [],
    masters: Array.isArray(run.masters) ? run.masters : [],
    grounding: jsonClone(run.grounding || null),
    packets: (run.packets || []).map(withoutRawText),
  };
}

export function buildCompanyDossier(run, sourceManifest = null) {
  const coverage = companyDossierCoverageStatus(run);
  const packets = (run.packets || []).map(withoutRawText);
  const grounding = jsonClone(run.grounding || null);
  const normalizedSourceManifest = jsonClone(sourceManifest || null);
  const inputBindingHash = hashCanonical(dossierInputBinding(run));
  const content = {
    schema_version: 1,
    contract_id: COMPANY_DOSSIER_CONTRACT_ID,
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    language: run.language,
    input_binding_hash: inputBindingHash,
    instrument: grounding?.instrument || null,
    coverage,
    grounding,
    typed_fact_pack: grounding?.typed_fact_pack || null,
    packets,
    packet_manifest: packets.map(packetManifest),
    claim_ledger: claimLedger(packets),
    source_ledger: sourceLedger(normalizedSourceManifest),
    source_manifest: normalizedSourceManifest,
    consumer_contract: {
      method_seats: Array.isArray(run.masters) ? run.masters.length : null,
      evidence_roles: Object.keys(OPERATING_COMPANY_COVERAGE),
      downstream_roles: ["bull_researcher", "bear_researcher", "portfolio_manager"],
      read_mode: "role_scoped_verified_consumption",
      method_read_mode: "verified_decision_projection_bound_to_full_dossier",
      method_projection_contract: COMPANY_DOSSIER_DECISION_PROJECTION_ID,
      decision_read_mode: "verified_decision_projection_bound_to_full_dossier",
      decision_projection_contract: COMPANY_DOSSIER_DECISION_PROJECTION_ID,
      decision_projection_max_bytes: COMPANY_DOSSIER_DECISION_PROJECTION_MAX_BYTES,
      acknowledgement_field: "company_dossier_hash_ack",
      method_packet_acknowledgement_field: "evidence_packet_acks",
      method_packet_acknowledgement_statuses: EVIDENCE_PACKET_ACK_STATUSES,
      source_acquisition_policy_id: run?.grounding?.source_acquisition_plan?.policy_id || null,
      core_packet_acknowledgement_count: Object.keys(OPERATING_COMPANY_COVERAGE).length,
      selected_packet_acknowledgement_count: packets.length,
    },
  };
  const contentHash = hashCanonical(content);
  return { ...content, content_hash: contentHash };
}

export function companyCoverageInstruction(task, run) {
  if (!requiresOperatingCompanyDossier(run)) return "";
  const ids = expectedCoverageItems(task);
  if (!ids.length) return "";
  const chinese = isChineseLanguage(run.language);
  const instructions = localized(run.language, {
    zh: [
      "## 公司资料覆盖契约（强制）",
      "这不是可选摘要。完成检索后，在顶层返回 `coverage_items`，下列每个 ID 必须恰好出现一次，不得增删或改名。",
      "每项必须带齐 `{id,status,source_ids,note,attempted,attempted_urls,gap}`；`note`、`attempted`、`gap` 必须是单个字符串（不用时写空字符串，绝不能写成数组），只有 `source_ids` 与 `attempted_urls` 是数组（不用时写空数组）。例如：`{\"attempted\":\"检索公司 IR 与 SEC 原文\",\"attempted_urls\":[\"https://example.com/ir\"]}`。`status` 只能是 `covered|unavailable|not_applicable`。",
      "- `covered`：至少一个 `source_ids`，并且都存在于本包 `sources`。来源必须是本席实际访问的 http(s) 证据，不得引用方法/代理来源；静态文件要给不晚于 as_of 的 `published_at`。动态行情、历史表、实时共识/申报索引若确实没有发布日期，保留 `published_at: \"unknown\"`，并在该 source 增加 `source_kind: \"dynamic_snapshot\"` 与本次实际观察的 `observed_at`（ISO 日期/时间且不晚于 as_of）；不得把普通无日期文章标成动态快照。news.* 和除 event_calendar 外的 events.* 每项仍至少引用一条有真实 `published_at` 的来源。",
      "- `unavailable`：只有实际检索过仍无法取得时才可使用；必须填写具体 `attempted`、至少一个实际访问的 http(s) `attempted_urls` 与 `gap`，并把完全相同的 gap 写进 `open_questions`。没有检索不等于 unavailable。",
      "- `not_applicable`：必须写明具体原因。不得用它逃避应查项目。",
      "任何遗漏都会让 full run 在证据门失败，后续方法视角、多空和 PM 不会运行。",
    ].join("\n"),
    en: [
      "## Mandatory company-dossier coverage contract",
      "This is not an optional recap. After research, return top-level `coverage_items`; every ID below must appear exactly once, unchanged, with no extras.",
      "Every item must include `{id,status,source_ids,note,attempted,attempted_urls,gap}`. `note`, `attempted`, and `gap` are single strings (empty when unused; never arrays). Only `source_ids` and `attempted_urls` are arrays (empty when unused). Example: `{\"attempted\":\"Searched issuer IR and SEC originals\",\"attempted_urls\":[\"https://example.com/ir\"]}`. Status is only `covered|unavailable|not_applicable`.",
      "- `covered`: cite at least one packet-local http(s) evidence source, never a method/proxy source. Static documents need `published_at` no later than as_of. For a dynamic quote, history table, live consensus or filing index with no publication date, keep `published_at: \"unknown\"` and add `source_kind: \"dynamic_snapshot\"` plus the actual `observed_at` (ISO date/time no later than as_of). Never label an ordinary undated article as dynamic. Every news.* row and every events.* row except event_calendar still needs at least one genuinely dated source.",
      "- `unavailable`: only after an actual retrieval attempt; include concrete `attempted`, at least one http(s) URL actually attempted in `attempted_urls`, and `gap`; repeat the exact gap in `open_questions`. Not researched is not unavailable.",
      "- `not_applicable`: give a concrete reason. Never use it to avoid an applicable check.",
      "Any omission fails the full evidence barrier, so methods, debate and PM will not run.",
    ].join("\n"),
    ja: "会社資料カバレッジ契約：以下の全 ID を coverage_items に一度ずつ記録してください。note、attempted、gap は単一文字列（配列不可）、source_ids と attempted_urls のみ配列です。covered は本 packet の出典 ID、unavailable は具体的な attempted、実際に試した HTTP(S) URL を1件以上含む attempted_urls、gap と完全一致する open_questions、not_applicable は具体的理由が必須です。欠落時は full run を停止します。",
    ko: "회사 자료 커버리지 계약: 아래 모든 ID를 coverage_items에 정확히 한 번 기록하십시오. note, attempted, gap은 단일 문자열이며 배열이 아니고, source_ids와 attempted_urls만 배열입니다. covered는 이 packet의 출처 ID, unavailable은 구체적인 attempted, 실제 시도한 HTTP(S) URL이 하나 이상인 attempted_urls, gap과 완전히 같은 open_questions, not_applicable은 구체적 사유가 필수입니다. 누락 시 full run을 중단합니다.",
  });
  const marketHistory = run?.grounding?.market_history;
  const taskSpecific = task === "market_data" && marketHistory?.available
    ? localized(run.language, {
      zh: "- 本次服务器已给出带来源的同步日线 market_history。必须直接使用其 subject、benchmarks、relative_performance 与 source_records 覆盖 market.price_history_range、market.liquidity_volume 和 market.relative_performance；不得因为另一个网页打不开而把已提供的数据改写成 unavailable。复制实际使用的 source_records 时，保留 title、url、published_at、retrieved_at、observed_at 与 source_kind，但不要复制服务器 id；把每个服务器 id 一一映射为本包内唯一、无冒号的本地别名（如 S1/S2），写入 sources[].id。claims、coverage_items 与 acquisition_ledger（包括 attempts）里的所有 source_ids 只能引用这些别名；record_visible_packet 会在入库时加上 market_data: 作用域。绝不能把 market_history:* 服务器 ID 原样放进 packet。",
      en: "- The server supplied sourced, aligned daily market_history for this run. Use its subject, benchmarks, relative_performance, and source_records to cover market.price_history_range, market.liquidity_volume, and market.relative_performance. A different web page being blocked cannot turn supplied data into unavailable. Copy each source_record actually used into packet sources, preserving title, url, published_at, retrieved_at, observed_at, and source_kind, but do not copy its server id. Map every server id one-to-one to a unique colon-free packet-local alias (for example S1/S2) and use that alias as sources[].id. Every source_ids entry in claims, coverage_items, and acquisition_ledger (including attempts) must cite those aliases; record_visible_packet applies the market_data: scope at ingestion. Never put a market_history:* server ID verbatim in the packet.",
      ja: "- サーバー提供の出典付き同期日次 market_history を使用し、価格履歴、流動性、相対パフォーマンスをカバーしてください。別サイトの取得失敗を理由に、提供済みデータを unavailable にしてはいけません。実際に使用する source_records は title、url、published_at、retrieved_at、observed_at、source_kind を保持して packet の sources にコピーしますが、サーバー id はコピーしません。各サーバー id を、本 packet 内で一意かつコロンを含まないローカル別名（例 S1/S2）へ 1 対 1 で対応させ、sources[].id に設定してください。claims、coverage_items、acquisition_ledger（attempts を含む）の全 source_ids はその別名だけを参照します。record_visible_packet が保存時に market_data: スコープを付けるため、market_history:* のサーバー ID を packet にそのまま入れてはいけません。",
      ko: "- 서버가 제공한 출처 포함 동기화 일별 market_history로 가격 이력, 유동성, 상대성과를 커버하십시오. 다른 웹페이지 접근 실패를 이유로 이미 제공된 데이터를 unavailable로 바꾸면 안 됩니다. 실제로 사용하는 source_records는 title, url, published_at, retrieved_at, observed_at, source_kind를 보존해 packet sources에 복사하되 서버 id는 복사하지 마십시오. 각 서버 id를 packet 안에서 고유하고 콜론이 없는 로컬 별칭(예: S1/S2)에 일대일로 매핑하고 sources[].id에 사용하십시오. claims, coverage_items, acquisition_ledger(attempts 포함)의 모든 source_ids는 그 별칭만 참조해야 합니다. record_visible_packet이 저장할 때 market_data: 범위를 붙이므로 market_history:* 서버 ID를 packet에 그대로 넣지 마십시오.",
    })
    : task === "forward_expectations"
      ? localized(run.language, {
        zh: "- expectations.next_reporting_date 同时区分两层：发行人确认日期与公开日历预计日期。若发行人尚未公告，但本席实际打开的公开日历给出带观察日期的预计值，则该领域是 covered；明确写成‘第三方预计、非发行人确认’，并将 reported_actual 仅解释为‘实际观察到该日历所发布的估计’，绝不能冒充公司公告。只有确认日期和带来源预计日期都取不到时才是 unavailable。",
        en: "- For expectations.next_reporting_date, separate an issuer-confirmed date from a public-calendar estimate. If the issuer has not announced it but a calendar you actually opened provides a dated estimate, the domain is covered. Label it third-party estimated / not issuer-confirmed; reported_actual means the calendar estimate was actually observed, never that the issuer confirmed the event. Use unavailable only when neither a confirmed nor a sourced estimated date exists.",
        ja: "- 次回決算日は、発行体確認日と公開カレンダー予想日を分けます。発行体未発表でも、実際に確認した公開カレンダーに観測日時付き予想があれば covered とし、第三者予想・未確認と明記します。",
        ko: "- 다음 실적 발표일은 발행사 확정일과 공개 캘린더 예상일을 분리합니다. 발행사 미공개라도 실제 확인한 공개 캘린더에 관측 시점이 있는 예상일이 있으면 covered로 기록하고 제3자 예상·미확정임을 명시합니다.",
      })
      : task === "news_industry_management"
        ? localized(run.language, {
          zh: "- 对 starter pack 中 management_changes 的每条带日期线索，必须用标题在发行人官网域名内核对原文；若 issuer_documents 已给出标题匹配且带发布日期的官网正文，直接把该官网原文纳入 sources 并覆盖 news.management_board_changes。Google/Yahoo 等 feed 链接只负责发现，不得在已有官网原文时把该项降为 unavailable。",
          en: "- For every dated management_changes lead in the starter pack, verify the exact title on an issuer-owned domain. When issuer_documents already supplies a title-matched, dated issuer page, add that original to sources and cover news.management_board_changes. Google/Yahoo feed links are discovery only; do not downgrade the row to unavailable when the dated issuer original is supplied.",
          ja: "- management_changes の日付付き手掛かりは発行体公式ドメインの原文で確認し、issuer_documents に日付付き公式原文があれば sources に採用して management_board_changes を covered としてください。",
          ko: "- management_changes의 날짜 있는 단서는 발행사 공식 도메인 원문으로 확인하고 issuer_documents에 날짜 있는 공식 원문이 제공되면 sources에 넣어 management_board_changes를 covered로 처리하십시오.",
        })
        : task === "earnings_deep_dive"
          ? localized(run.language, {
            zh: "- financials.earnings_call_qna 优先发行人逐字稿/回放。若发行人未发布，但实际打开的公开转录页含可核验的发言人标注与 Q&A 正文，可把‘电话会 Q&A 领域’标为 covered，同时注明二级转录来源、不得冒充官方逐字稿；若不能逐句核验，再按完整来源梯标 unavailable。",
            en: "- For financials.earnings_call_qna, prefer an issuer transcript or replay. If none exists but a public transcript you actually opened has speaker-labelled, verifiable Q&A text, the Q&A domain may be covered while clearly labelling the secondary transcript and never presenting it as issuer-authored. If sentences cannot be verified, exhaust the ladder and mark unavailable.",
            ja: "- 決算通話 Q&A は発行体の逐語録・録画を優先し、なければ話者付きで検証可能な公開転記を二次資料と明記して利用できます。検証不能なら unavailable とします。",
            ko: "- 실적발표 Q&A는 발행사 녹취록·재생본을 우선하며, 없을 경우 화자 표시와 검증 가능한 본문이 있는 공개 전사본을 2차 자료로 명시해 사용할 수 있습니다. 검증할 수 없으면 unavailable로 기록합니다.",
          })
          : "";
  return `${instructions}${taskSpecific ? `\n${taskSpecific}` : ""}\n\nRequired coverage IDs JSON: ${JSON.stringify(ids)}\nReader language: ${run.language}; task: ${task}; contract: ${COMPANY_DOSSIER_CONTRACT_ID}; chinese=${chinese}`;
}

export function companyDossierPromptBlock(run, { consumer = "full" } = {}) {
  const ref = run?.company_dossier;
  if (!requiresOperatingCompanyDossier(run) || !ref?.path || !ref?.content_hash) return "";
  verifyCompanyDossierArtifact(run);
  if (consumer === "hash_ack_only") {
    return localized(run.language, {
      zh: `服务端已重新校验冻结公司资料包。修复后的完整对象中，\`company_dossier_hash_ack\` 必须原样保持为 \`${ref.content_hash}\`；这是格式修复，不得重读资料包或重新分析。`,
      en: `The server revalidated the frozen company dossier. In the complete repaired object, preserve \`company_dossier_hash_ack\` exactly as \`${ref.content_hash}\`. This is transport repair; do not reopen the dossier or redo the analysis.`,
      ja: `サーバーは凍結済み会社資料を再検証しました。修復後の完全な object で company_dossier_hash_ack を ${ref.content_hash} のまま保持し、資料の再読込や再分析は行わないでください。`,
      ko: `서버가 동결된 회사 자료를 다시 검증했습니다. 복구된 전체 object에서 company_dossier_hash_ack를 ${ref.content_hash}로 그대로 유지하고 자료를 다시 읽거나 분석하지 마십시오.`,
    });
  }
  if (consumer === "method_projection") {
    const manifests = run.packets.map(packetManifest);
    const ackContract = JSON.stringify(Object.fromEntries(
      companyDossierPacketAckTemplate(run, { includePacketHash: false })
        .map(({ task, ...ack }) => [task, ack]),
    ));
    return localized(run.language, {
      zh: [
        "## 统一公司资料包（服务端验证的方法投影）",
        `内容哈希：${ref.content_hash}`,
        "服务端已在启动本方法视角前重读并校验完整冻结资料包，并从校验后的磁盘内容生成下方有界投影。只使用该投影；不要打开任何运行产物，也不要重新处理包含原始采集记录和时间序列的多 MB 审计文件。",
        "投影保留全部决策论断及其引用来源、52 项覆盖结果、每项冻结采集结论与数据、完整指标、明确缺口、逐包哈希和完整资料包哈希。不得用模型记忆或外部资料补足投影之外的信息。",
        `输出必须原样带回 \`company_dossier_hash_ack\`: \`${ref.content_hash}\`。哈希缺失或不一致会使该席位失败。`,
        `还必须逐包返回 \`evidence_packet_acks\`，本轮共 ${manifests.length} 包（其中核心包固定 8 个）。每个 task 必须恰好出现一次；不要手抄 packet_hash，服务器会在验证 status、source_ids 与 note 后绑定冻结清单中的精确哈希。`,
        "status 只能是 used / reviewed_not_relevant / unavailable：used 必须列出本包实际使用且同时出现在顶层 source_ids 的来源；reviewed_not_relevant 必须写明本方法为何未使用；unavailable 只能用于本包确实没有任何可用论断时，并写明原因。",
        `逐包回执模板：${ackContract}`,
      ].join("\n"),
      en: [
        "## Shared company dossier (server-verified method projection)",
        `Content hash: ${ref.content_hash}`,
        "The server re-read and re-hashed the complete frozen dossier immediately before launching this method lens, then generated the bounded projection in the Evidence JSON below from those verified disk bytes. Use only that projection; do not open any run artifact or reprocess the multi-megabyte audit file containing raw acquisition records and time series.",
        "The projection retains every decision claim and its referenced sources, all 52 coverage outcomes, every frozen acquisition disposition and its data, complete packet metrics, explicit gaps, packet hashes, and the full dossier hash. Never fill anything outside the projection from model memory or external information.",
        `Return \`company_dossier_hash_ack\` exactly as \`${ref.content_hash}\`; a missing or different hash fails this worker.`,
        `Also return \`evidence_packet_acks\` for all ${manifests.length} packets (exactly eight are core packets). Every task must occur exactly once. Do not transcribe packet_hash; after validating status, source_ids, and note, the server binds the exact hash from the frozen manifest.`,
        "Status is only used / reviewed_not_relevant / unavailable. used requires packet-local source IDs that also appear in top-level source_ids; reviewed_not_relevant requires a method-specific reason; unavailable is allowed only when the packet contains no usable claim and requires a reason.",
        `Per-packet acknowledgement template: ${ackContract}`,
      ].join("\n"),
      ja: `サーバーは完全な凍結済み会社資料（${ref.content_hash}）を再検証し、その検証済み内容から以下の限定的なメソッド投影を生成しました。この投影だけを使い、複数 MB の監査ファイルを再処理しないでください。company_dossier_hash_ack に同じハッシュを返し、全${manifests.length}件の evidence_packet_acks を task ごとに一度だけ返してください。テンプレート: ${ackContract}`,
      ko: `서버가 완전한 동결 회사 자료(${ref.content_hash})를 다시 검증하고 그 내용에서 아래의 제한된 방법론 투영을 생성했습니다. 이 투영만 사용하고 수 MB 감사 파일을 다시 처리하지 마십시오. company_dossier_hash_ack에 같은 해시를 반환하고 ${manifests.length}개 evidence_packet_acks를 task별로 정확히 한 번 반환하십시오. 템플릿: ${ackContract}`,
    });
  }
  if (consumer === "decision_projection") {
    return localized(run.language, {
      zh: [
        "## 统一公司资料包（服务端验证的决策投影）",
        `内容哈希：${ref.content_hash}`,
        "服务端已在启动本席位前重新读取并校验完整冻结资料包，并从校验后的磁盘内容生成有界、服务端验证的决策投影，注入下方 Evidence JSON。辩论和组合经理必须只使用该投影；不要打开任何运行产物，也不得粘贴或附加 Evidence JSON 或其他证据/资料包产物。",
        "该投影保留全部决策论断及其引用来源、52 项覆盖结果、每项已冻结的采集结论与数据、完整指标、明确数据缺口、逐包哈希和完整资料包哈希；未被决策证据引用的原始传输内容只保留在审计资料包中。不得用模型记忆或外部资料补足投影之外的信息。",
        `输出必须原样带回 \`company_dossier_hash_ack\`: \`${ref.content_hash}\`。哈希缺失或不一致会使该席位失败。`,
      ].join("\n"),
      en: [
        "## Shared company dossier (server-verified decision projection)",
        `Content hash: ${ref.content_hash}`,
        "The server re-read and re-hashed the complete frozen dossier immediately before launching this worker, then generated the bounded, server-verified decision projection in the Evidence JSON below from those verified disk bytes. Debate and portfolio-manager workers must use that projection. Do not open any run artifact, and do not paste or append Evidence JSON or another evidence/dossier artifact.",
        "The projection retains every decision claim and its referenced sources, all 52 coverage outcomes, every frozen acquisition disposition and its data, complete packet metrics, explicit gaps, packet hashes, and the full dossier hash. Raw transport content not referenced by decision evidence remains only in the audit dossier. Never fill anything outside the projection from model memory or external information.",
        `Return \`company_dossier_hash_ack\` exactly as \`${ref.content_hash}\`; a missing or different hash fails this worker.`,
      ].join("\n"),
      ja: `完全な監査用会社資料（${ref.content_hash}）は、実行直前にサーバーが再読込・再ハッシュし、その検証済みディスク内容から以下の限定的な意思決定投影を生成しました。この Evidence JSON だけを使用し、他の実行成果物を開かず、Evidence JSON やその他の証拠・資料成果物を貼り付けたり追加したりしないでください。投影には全ての意思決定クレームと参照元、52 項目の結果、凍結済み取得結果とデータ、完全な packet 指標、明示的 gap、packet hash と資料全体の hash が含まれます。company_dossier_hash_ack に同じハッシュを返してください。`,
      ko: `전체 감사용 회사 자료(${ref.content_hash})는 실행 직전에 서버가 다시 읽고 해시를 검증했으며, 검증된 디스크 내용에서 아래 제한형 의사결정 투영을 생성했습니다. 이 Evidence JSON만 사용하고 다른 실행 산출물을 열거나 Evidence JSON 또는 다른 증거·자료 산출물을 붙여 넣거나 추가하지 마십시오. 투영에는 모든 의사결정 주장과 참조 출처, 52개 결과, 동결된 수집 결론과 데이터, 전체 packet 지표, 명시적 공백, packet hash와 전체 자료 hash가 포함됩니다. company_dossier_hash_ack에 같은 해시를 반환하십시오.`,
    });
  }
  const manifests = run.packets.map(packetManifest);
  const ackContract = JSON.stringify(Object.fromEntries(
    companyDossierPacketAckTemplate(run, { includePacketHash: false })
      .map(({ task, ...ack }) => [task, ack]),
  ));
  return localized(run.language, {
    zh: [
      "## 统一公司资料包（强制读取）",
      `完整资料包：${ref.path}`,
      `内容哈希：${ref.content_hash}`,
      "下面内嵌的 bounded evidence 只是索引，不是完整资料。回答前必须读取上述 JSON 全文；不得只依据被截断的索引。",
      `输出必须原样带回 \`company_dossier_hash_ack\`: \`${ref.content_hash}\`。哈希缺失或不一致会使该席位失败。`,
      `每个方法席还必须逐包返回 \`evidence_packet_acks\`，本轮共 ${manifests.length} 包（其中核心包固定 8 个）。原生结构化输出以 task 为对象键，每个 task 必须恰好出现一次；不要手抄 packet_hash，服务器会在验证 status、source_ids 与 note 后绑定冻结清单中的精确哈希。`,
      "status 只能是 used / reviewed_not_relevant / unavailable：used 必须列出本包实际使用且同时出现在顶层 source_ids 的来源；reviewed_not_relevant 必须写明本方法为何未使用；unavailable 只能用于本包确实没有任何可用论断时，并写明原因。",
      `逐包回执模板：${ackContract}`,
    ].join("\n"),
    en: [
      "## Shared company dossier (mandatory read)",
      `Full dossier: ${ref.path}`,
      `Content hash: ${ref.content_hash}`,
      "The bounded evidence embedded below is an index, not the full dossier. Read the JSON file in full before answering; do not reason only from the truncated index.",
      `Return \`company_dossier_hash_ack\` exactly as \`${ref.content_hash}\`; a missing or different hash fails this worker.`,
      `Every method seat must also return \`evidence_packet_acks\` for all ${manifests.length} packets (exactly eight are core packets). Native structured output keys this object by task, and every task must occur exactly once. Do not transcribe packet_hash; after validating status, source_ids, and note, the server binds the exact hash from the frozen manifest.`,
      "Status is only used / reviewed_not_relevant / unavailable. used requires packet-local source IDs that also appear in top-level source_ids; reviewed_not_relevant requires a method-specific reason; unavailable is allowed only when the packet contains no usable claim and requires a reason.",
      `Per-packet acknowledgement template: ${ackContract}`,
    ].join("\n"),
    ja: `完全な会社資料 ${ref.path}（${ref.content_hash}）を回答前に全文読み、company_dossier_hash_ack に同じハッシュを返してください。さらに全${manifests.length}件の evidence_packet_acks を task ごとに一度だけ返し、status は used / reviewed_not_relevant / unavailable のいずれかにしてください。packet_hash は書かず、サーバーが凍結済みハッシュを結合します。テンプレート: ${ackContract}`,
    ko: `답변 전에 전체 회사 자료 ${ref.path} (${ref.content_hash})를 모두 읽고 company_dossier_hash_ack에 같은 해시를 반환하십시오. 또한 ${manifests.length}개 전체 evidence_packet_acks를 task별로 정확히 한 번 반환하고 status는 used / reviewed_not_relevant / unavailable 중 하나여야 합니다. packet_hash는 쓰지 말고 서버가 동결된 해시를 결합합니다. 템플릿: ${ackContract}`,
  });
}

/** Re-hash the frozen on-disk artifact before any downstream worker consumes or acknowledges it. */
export function verifyCompanyDossierArtifact(run, { client = false } = {}) {
  if (!requiresOperatingCompanyDossier(run)) return null;
  const ref = run?.company_dossier;
  let parsed = null;
  let failure = null;
  if (!ref?.path || !ref?.content_hash) {
    failure = "company dossier reference is missing";
  } else {
    try {
      parsed = JSON.parse(readFileSync(ref.path, "utf8"));
      const { content_hash: embeddedHash, ...content } = parsed;
      const computed = hashCanonical(content);
      if (embeddedHash !== computed || ref.content_hash !== computed) {
        failure = "company dossier content hash does not match the frozen reference";
      } else if (parsed.run_id !== run.run_id || parsed.symbol !== run.symbol || parsed.as_of !== run.as_of) {
        failure = "company dossier identity does not match the run";
      } else if (parsed.contract_id !== COMPANY_DOSSIER_CONTRACT_ID) {
        failure = "company dossier contract id is invalid";
      } else if (parsed.input_binding_hash !== hashCanonical(dossierInputBinding(run))) {
        failure = "current run evidence no longer matches the frozen company dossier input binding";
      }
    } catch (error) {
      failure = `company dossier cannot be read: ${error.message}`;
    }
  }
  if (!failure) return parsed;
  const data = {
    reason: "COMPANY_DOSSIER_ARTIFACT_INTEGRITY_FAILURE",
    contract_id: COMPANY_DOSSIER_CONTRACT_ID,
    path: ref?.path || null,
    expected_company_dossier_hash: ref?.content_hash || null,
    diagnostic: failure,
  };
  throw (client ? invalidParams(failure, data) : internalError(failure, data));
}

function decisionProjectionFailure(message, details = {}) {
  throw internalError(message, {
    reason: "COMPANY_DOSSIER_DECISION_PROJECTION_INVALID",
    contract_id: COMPANY_DOSSIER_DECISION_PROJECTION_ID,
    ...details,
  });
}

function uniqueRowsBy(rows, key, label) {
  const result = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = row?.[key];
    if (typeof value !== "string" || !value || result.has(value)) {
      decisionProjectionFailure(`${label} must contain unique non-empty ${key} values`, {
        label,
        key,
        duplicate_or_invalid_value: value ?? null,
      });
    }
    result.set(value, row);
  }
  return result;
}

function collectDecisionProjectionSourceIds(value, target = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectDecisionProjectionSourceIds(item, target);
    return target;
  }
  if (!value || typeof value !== "object") return target;
  for (const [key, item] of Object.entries(value)) {
    if ((key === "source_ids" || key.endsWith("_source_ids")) && Array.isArray(item)) {
      for (const id of item) if (typeof id === "string" && id) target.add(id);
      continue;
    }
    if (key === "source_id" && typeof item === "string" && item) {
      target.add(item);
      continue;
    }
    collectDecisionProjectionSourceIds(item, target);
  }
  return target;
}

function bindDecisionProjectionSourceIds(value, task, sourceLedgerById) {
  const resolve = (id) => {
    if (typeof id !== "string" || !id) return id;
    if (sourceLedgerById.has(id)) return id;
    const scoped = `${task}:${id}`;
    return sourceLedgerById.has(scoped) ? scoped : id;
  };
  if (Array.isArray(value)) {
    return value.map((item) => bindDecisionProjectionSourceIds(item, task, sourceLedgerById));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if ((key === "source_ids" || key.endsWith("_source_ids")) && Array.isArray(item)) {
      // Scope first, then deduplicate: a worker may mix `S1` and `task:S1`, which are
      // different strings before binding but the same frozen source afterwards.
      return [key, [...new Set(item.map(resolve))]];
    }
    if (key === "source_id" && typeof item === "string") return [key, resolve(item)];
    return [key, bindDecisionProjectionSourceIds(item, task, sourceLedgerById)];
  }));
}

function decisionProjectionSource(record) {
  const selected = {};
  for (const key of [
    "id",
    "title",
    "url",
    "published_at",
    "public_at",
    "retrieved_at",
    "observed_at",
    "source_kind",
    "source_record_hash",
  ]) {
    if (record?.[key] !== undefined) selected[key] = jsonClone(record[key]);
  }
  return selected;
}

function decisionProjectionRoute(coverage, acquisition) {
  const attempts = Array.isArray(acquisition?.attempts) ? acquisition.attempts : [];
  const route = {
    id: coverage.id,
    status: coverage.status,
    coverage_source_ids: jsonClone(coverage.source_ids || []),
    outcome: acquisition?.outcome || "not_recorded",
    outcome_source_ids: jsonClone(acquisition?.source_ids || []),
    // A successful acquisition may cite a source used only to prove how the fact was
    // obtained (for example, the dated endpoint actually queried) rather than the fact's
    // final value. Keep those bindings without copying the full successful-attempt prose.
    attempt_source_ids: [...new Set(attempts
      .flatMap((attempt) => Array.isArray(attempt?.source_ids) ? attempt.source_ids : []))],
  };
  for (const key of ["note", "attempted", "attempted_urls", "gap", "reason"]) {
    if (coverage?.[key] !== undefined) route[key] = jsonClone(coverage[key]);
  }
  if (acquisition?.data !== undefined) route.data = jsonClone(acquisition.data);
  if (acquisition?.reason !== undefined) route.outcome_reason = jsonClone(acquisition.reason);
  if (coverage.status === "unavailable" || acquisition?.outcome === "unavailable") {
    route.attempts = jsonClone(attempts);
  }
  return route;
}

/**
 * Derive the bounded debate/PM input from the just-verified on-disk dossier, never from a
 * separately mutable runtime projection. The full artifact remains the audit source of truth.
 */
export function companyDossierDecisionProjection(run) {
  const dossier = verifyCompanyDossierArtifact(run);
  if (!dossier) return null;

  const packetByTask = uniqueRowsBy(dossier.packets, "task", "dossier packets");
  const manifestByTask = uniqueRowsBy(dossier.packet_manifest, "task", "packet manifest");
  if (packetByTask.size !== manifestByTask.size) {
    decisionProjectionFailure("packet manifest and packet list have different task counts", {
      packet_count: packetByTask.size,
      manifest_count: manifestByTask.size,
    });
  }

  const sourceLedgerById = uniqueRowsBy(dossier.source_ledger, "id", "source ledger");
  const acquisitionRequired = Boolean(dossier.consumer_contract?.source_acquisition_policy_id);
  let coreRouteCount = 0;
  const packets = [];

  for (const [task, packet] of packetByTask) {
    const manifest = manifestByTask.get(task);
    const actualManifest = packetManifest(packet);
    if (!manifest || manifest.packet_hash !== actualManifest.packet_hash) {
      decisionProjectionFailure("packet hash does not match the frozen manifest", {
        task,
        expected_packet_hash: manifest?.packet_hash || null,
        actual_packet_hash: actualManifest.packet_hash,
      });
    }

    const coverageById = uniqueRowsBy(packet.coverage_items || [], "id", `${task} coverage rows`);
    const expectedIds = expectedCoverageItems(task);
    const taskAcquisitionRequired = acquisitionRequired && expectedIds.length > 0;
    const acquisitionRows = packet.acquisition_ledger?.items;
    if (taskAcquisitionRequired && !Array.isArray(acquisitionRows)) {
      decisionProjectionFailure("acquisition rows must be an array under the frozen source policy", {
        task,
      });
    }
    // Legacy/replayed dossiers without a frozen source-acquisition policy never passed the
    // typed acquisition gate. Supplemental breadth packets also own no acquisition routes even
    // when the eight core packets share a run-level policy. Do not let either unverified surface
    // enter a decision prompt; coverage and cited evidence remain.
    const acquisitionById = uniqueRowsBy(
      taskAcquisitionRequired ? acquisitionRows : [],
      "coverage_id",
      `${task} acquisition rows`,
    );
    if (expectedIds.length) {
      const unexpectedCoverage = [...coverageById.keys()].filter((id) => !expectedIds.includes(id));
      const unexpectedAcquisition = [...acquisitionById.keys()].filter((id) => !expectedIds.includes(id));
      const missingCoverage = expectedIds.filter((id) => !coverageById.has(id));
      const missingAcquisition = taskAcquisitionRequired
        ? expectedIds.filter((id) => !acquisitionById.has(id))
        : [];
      if (unexpectedCoverage.length || unexpectedAcquisition.length || missingCoverage.length || missingAcquisition.length) {
        decisionProjectionFailure("coverage or acquisition routes do not match the frozen company roster", {
          task,
          unexpected_coverage: unexpectedCoverage,
          unexpected_acquisition: unexpectedAcquisition,
          missing_coverage: missingCoverage,
          missing_acquisition: missingAcquisition,
        });
      }
      coreRouteCount += expectedIds.length;
    }

    const routeIds = expectedIds.length ? expectedIds : [...coverageById.keys()];
    const routes = routeIds.map((id) => decisionProjectionRoute(
      coverageById.get(id),
      acquisitionById.get(id),
    ));
    const decisionContent = bindDecisionProjectionSourceIds({
      claims: jsonClone(packet.claims || []),
      metrics: jsonClone(packet.metrics || {}),
      official_source_coverage: jsonClone(packet.official_source_coverage || null),
      routes,
    }, task, sourceLedgerById);
    const referencedSourceIds = [...collectDecisionProjectionSourceIds(decisionContent)].sort();
    const unresolvedSourceIds = referencedSourceIds.filter((id) => !sourceLedgerById.has(id));
    if (unresolvedSourceIds.length) {
      decisionProjectionFailure("decision projection contains source references absent from the frozen source ledger", {
        task,
        unresolved_source_ids: unresolvedSourceIds,
      });
    }

    packets.push({
      task,
      packet_hash: manifest.packet_hash,
      summary: packet.summary || "",
      ...decisionContent,
      sources: referencedSourceIds.map((id) => decisionProjectionSource(sourceLedgerById.get(id))),
      open_questions: jsonClone(packet.open_questions || []),
      confidence: packet.confidence || "low",
      information_richness: packet.information_richness || null,
    });
  }

  const expectedCoreRouteCount = Object.values(OPERATING_COMPANY_COVERAGE)
    .reduce((total, ids) => total + ids.length, 0);
  if (coreRouteCount !== expectedCoreRouteCount || dossier.coverage?.expected_count !== expectedCoreRouteCount) {
    decisionProjectionFailure("decision projection does not contain the exact fixed company coverage roster", {
      expected_route_count: expectedCoreRouteCount,
      projected_route_count: coreRouteCount,
      dossier_expected_count: dossier.coverage?.expected_count ?? null,
    });
  }

  const content = {
    schema_version: 1,
    projection_contract: COMPANY_DOSSIER_DECISION_PROJECTION_ID,
    source_dossier: {
      contract_id: dossier.contract_id,
      run_id: dossier.run_id,
      symbol: dossier.symbol,
      as_of: dossier.as_of,
      language: dossier.language,
      input_binding_hash: dossier.input_binding_hash,
      content_hash: dossier.content_hash,
    },
    instrument: jsonClone(dossier.instrument || null),
    coverage: jsonClone(dossier.coverage),
    packet_manifest: jsonClone(dossier.packet_manifest),
    packets,
    consumer_contract: {
      read_mode: "verified_decision_projection_bound_to_full_dossier",
      acknowledgement_field: "company_dossier_hash_ack",
    },
  };
  const projection = { ...content, projection_hash: hashCanonical(content) };
  const bytes = Buffer.byteLength(JSON.stringify(projection));
  if (bytes > COMPANY_DOSSIER_DECISION_PROJECTION_MAX_BYTES) {
    throw internalError("company dossier decision projection exceeds its fail-closed byte limit", {
      reason: "COMPANY_DOSSIER_DECISION_PROJECTION_OVERSIZE",
      contract_id: COMPANY_DOSSIER_DECISION_PROJECTION_ID,
      bytes,
      max_bytes: COMPANY_DOSSIER_DECISION_PROJECTION_MAX_BYTES,
    });
  }
  return projection;
}

/**
 * Exact citation scope exposed by the bounded decision projection.
 *
 * The frozen dossier may contain transport-only or otherwise unreferenced source records. A
 * downstream worker cannot truthfully cite those records because they were deliberately omitted
 * from its bounded prompt. Keep the task-local and aggregate views derived from the same verified
 * projection so prompt text, structured-output schemas, and acknowledgement validation agree.
 */
export function companyDossierDecisionProjectionSourceScope(run, projection = null) {
  const bounded = projection || companyDossierDecisionProjection(run);
  if (!bounded) return { source_ids: [], by_task: {} };
  const byTask = {};
  const all = new Set();
  for (const packet of bounded.packets || []) {
    const ids = [...new Set((packet.sources || [])
      .map((source) => source?.id)
      .filter((id) => typeof id === "string" && id.trim()))].sort();
    byTask[packet.task] = ids;
    for (const id of ids) all.add(id);
  }
  return { source_ids: [...all].sort(), by_task: byTask };
}

export function assertCompanyDossierAck(packet, run, label, { client = false } = {}) {
  if (!requiresOperatingCompanyDossier(run)) return packet;
  verifyCompanyDossierArtifact(run, { client });
  const expected = run?.company_dossier?.content_hash;
  const actual = packet?.company_dossier_hash_ack;
  if (expected && actual === expected) return packet;
  const data = {
    reason: "COMPANY_DOSSIER_HASH_ACK_MISMATCH",
    contract_id: COMPANY_DOSSIER_CONTRACT_ID,
    label,
    expected_company_dossier_hash: expected || null,
    supplied_company_dossier_hash: actual || null,
  };
  throw (client
    ? invalidParams(`${label} did not acknowledge the shared company dossier hash`, data)
    : internalError(`${label} did not acknowledge the shared company dossier hash`, data));
}

/**
 * Validate a method worker's declared disposition for every packet in the frozen dossier.
 * A single dossier hash proves snapshot integrity; this ledger binds every `used` declaration
 * to packet-local sources that the method actually cited. It does not claim to observe the
 * model's private attention or prove that every byte affected its reasoning.
 */
export function assertCompanyDossierPacketAcks(packet, run, label, { client = false } = {}) {
  if (!requiresOperatingCompanyDossier(run)) return [];
  const dossier = verifyCompanyDossierArtifact(run, { client });
  const projection = companyDossierDecisionProjection(run);
  const projectionScope = companyDossierDecisionProjectionSourceScope(run, projection);
  const supplied = packet?.evidence_packet_acks;
  const problems = [];
  if (!Array.isArray(supplied)) {
    problems.push({ reason: "missing_evidence_packet_acks" });
  }
  const rows = Array.isArray(supplied) ? supplied : [];
  const byTask = new Map();
  for (const row of rows) {
    const task = typeof row?.task === "string" ? row.task : "";
    if (!task) {
      problems.push({ reason: "ack_without_task" });
      continue;
    }
    if (byTask.has(task)) problems.push({ task, reason: "duplicate_ack" });
    else byTask.set(task, row);
  }
  const expectedTasks = new Set((dossier.packet_manifest || []).map((manifest) => manifest.task));
  for (const task of byTask.keys()) {
    if (!expectedTasks.has(task)) problems.push({ task, reason: "unexpected_ack" });
  }
  const topLevelSourceIds = new Set(Array.isArray(packet?.source_ids) ? packet.source_ids : []);
  const projectedPacketByTask = new Map((projection?.packets || []).map((entry) => [entry.task, entry]));
  const projectedSourceIds = new Set(projectionScope.source_ids);
  const outsideProjection = [...topLevelSourceIds].filter((id) => !projectedSourceIds.has(id));
  if (outsideProjection.length) {
    problems.push({ reason: "top_level_source_outside_projection", source_ids: outsideProjection });
  }
  const normalized = [];
  for (const manifest of dossier.packet_manifest || []) {
    const row = byTask.get(manifest.task);
    if (!row) {
      problems.push({ task: manifest.task, reason: "missing_ack" });
      continue;
    }
    const status = row.status;
    const sourceIds = Array.isArray(row.source_ids)
      ? [...new Set(row.source_ids.filter((id) => typeof id === "string" && id.trim()))]
      : [];
    const note = typeof row.note === "string" ? row.note.trim() : "";
    // The worker owns the per-packet disposition, not a 64-character server hash copy. Older
    // clients may still echo the hash and are checked strictly; new workers omit it and the
    // normalized persisted acknowledgement is bound to the frozen manifest below.
    if (row.packet_hash !== undefined && row.packet_hash !== manifest.packet_hash) {
      problems.push({
        task: manifest.task,
        reason: "packet_hash_mismatch",
        expected_packet_hash: manifest.packet_hash,
        supplied_packet_hash: row.packet_hash || null,
      });
    }
    if (!EVIDENCE_PACKET_ACK_STATUSES.includes(status)) {
      problems.push({ task: manifest.task, reason: "invalid_ack_status", status: status || null });
    }
    const evidencePacket = projectedPacketByTask.get(manifest.task) || {};
    const localSourceIds = new Set(projectionScope.by_task[manifest.task] || []);
    const outsidePacket = sourceIds.filter((id) => !localSourceIds.has(id));
    const outsideMethod = sourceIds.filter((id) => !topLevelSourceIds.has(id));
    const citedFromDisposedPacket = [...topLevelSourceIds].filter((id) => localSourceIds.has(id));
    if (status === "used") {
      if (!sourceIds.length) problems.push({ task: manifest.task, reason: "used_without_source_ids" });
      if (outsidePacket.length) problems.push({ task: manifest.task, reason: "used_source_outside_packet", source_ids: outsidePacket });
      if (outsideMethod.length) problems.push({ task: manifest.task, reason: "used_source_missing_from_method_source_ids", source_ids: outsideMethod });
    } else if (status === "reviewed_not_relevant") {
      if (!note) problems.push({ task: manifest.task, reason: "reviewed_not_relevant_without_note" });
      if (sourceIds.length) problems.push({ task: manifest.task, reason: "reviewed_not_relevant_with_source_ids" });
      if (citedFromDisposedPacket.length) problems.push({
        task: manifest.task,
        reason: "top_level_source_conflicts_with_packet_disposition",
        status,
        source_ids: citedFromDisposedPacket,
      });
    } else if (status === "unavailable") {
      if (!note) problems.push({ task: manifest.task, reason: "unavailable_without_note" });
      if (sourceIds.length) problems.push({ task: manifest.task, reason: "unavailable_with_source_ids" });
      if (citedFromDisposedPacket.length) problems.push({
        task: manifest.task,
        reason: "top_level_source_conflicts_with_packet_disposition",
        status,
        source_ids: citedFromDisposedPacket,
      });
      const usable = (evidencePacket.claims || []).length > 0 && (evidencePacket.sources || []).length > 0;
      if (usable) problems.push({ task: manifest.task, reason: "unavailable_but_packet_has_usable_evidence" });
    }
    normalized.push({
      task: manifest.task,
      packet_hash: manifest.packet_hash,
      status,
      source_ids: sourceIds,
      note,
    });
  }
  if (!problems.length && rows.length === (dossier.packet_manifest || []).length) return normalized;
  if (rows.length !== (dossier.packet_manifest || []).length) {
    problems.push({
      reason: "ack_count_mismatch",
      expected: (dossier.packet_manifest || []).length,
      supplied: rows.length,
    });
  }
  const data = {
    reason: "COMPANY_DOSSIER_PACKET_ACK_MISMATCH",
    contract_id: COMPANY_DOSSIER_CONTRACT_ID,
    label,
    expected_packet_count: (dossier.packet_manifest || []).length,
    supplied_packet_count: rows.length,
    core_packet_count: Object.keys(OPERATING_COMPANY_COVERAGE).length,
    problems,
  };
  throw (client
    ? invalidParams(`${label} did not acknowledge every frozen evidence packet`, data)
    : internalError(`${label} did not acknowledge every frozen evidence packet`, data));
}
