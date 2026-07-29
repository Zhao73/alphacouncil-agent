/**
 * XBRL series plumbing shared by every derived fundamental.
 *
 * Nothing here knows what a metric means. It answers four mechanical questions about SEC
 * Company Facts documents -- which periods exist for a concept, which of them align, when the
 * newest input became public, and how a computed number is packaged with its lineage -- and
 * `fundamentals.mjs` builds the operating figures on top. Separating them keeps the alignment
 * rules in one place: a metric that quietly aligned differently from its neighbours would be
 * the kind of defect no test asks about.
 *
 * All network access goes through sec.mjs, which owns the throttle and the User-Agent.
 */

import { CONCEPTS, annualSeries } from "./sec.mjs";
import { sha256 } from "./personas-v3/canonical.mjs";

export const TOOL_ID = "sec_fundamentals";
export const TOOL_VERSION = "1.0.0";
const HASH_DOMAIN = "alphacouncil.fundamentals.sec-companyfacts.v1";

const finite = (value) => typeof value === "number" && Number.isFinite(value);
export const decimal = (value) => Number(value.toFixed(6));
const DAY_MS = 86_400_000;
export const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/** Two facts claiming the same period may not disagree by more than this. */
export const MAX_ALIGNMENT_DRIFT_DAYS = 45;

/**
 * Concept aliases, ordered by preference, on top of the ones sec.mjs already publishes.
 *
 * Aliases inside one entry are the same economic quantity under different taxonomies. They
 * are never a fallback to a different concept: total liabilities is not reconstructed from
 * an equity subtraction, and a missing depreciation tag stays missing.
 */
export const FUNDAMENTAL_CONCEPTS = Object.freeze({
  revenue: { tags: CONCEPTS.revenue, unit: "USD" },
  net_income: { tags: CONCEPTS.netIncome, unit: "USD" },
  operating_income: { tags: CONCEPTS.operatingIncome, unit: "USD" },
  capex: { tags: CONCEPTS.capex, unit: "USD" },
  equity: { tags: CONCEPTS.equity, unit: "USD" },
  depreciation_amortisation: {
    tags: [
      "DepreciationDepletionAndAmortization",
      "DepreciationAmortizationAndAccretionNet",
      "DepreciationAndAmortization",
      "Depreciation",
    ],
    unit: "USD",
  },
  current_assets: { tags: ["AssetsCurrent"], unit: "USD" },
  total_liabilities: { tags: ["Liabilities"], unit: "USD" },
  goodwill: { tags: ["Goodwill"], unit: "USD" },
  intangibles: { tags: ["IntangibleAssetsNetExcludingGoodwill", "FiniteLivedIntangibleAssetsNet"], unit: "USD" },
  cash: {
    tags: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
    unit: "USD",
  },
  // Debt buckets are non-overlapping by construction so they can be summed. `debt_combined`
  // is the whole of it in one tag and wins outright when a filer publishes it.
  debt_combined: { tags: ["DebtLongtermAndShorttermCombinedAmount"], unit: "USD" },
  debt_long_term_noncurrent: { tags: ["LongTermDebtNoncurrent", "LongTermDebtAndCapitalLeaseObligations"], unit: "USD" },
  debt_long_term_current: { tags: ["LongTermDebtCurrent", "LongTermDebtAndCapitalLeaseObligationsCurrent"], unit: "USD" },
  debt_short_term: { tags: ["ShortTermBorrowings", "OtherShortTermBorrowings", "CommercialPaper"], unit: "USD" },
  tax_expense: { tags: ["IncomeTaxExpenseBenefit"], unit: "USD" },
  pretax_income: {
    tags: [
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
      "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments",
    ],
    unit: "USD",
  },
  diluted_shares: {
    tags: ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfDilutedSharesOutstandingBasicAndDiluted"],
    // Share concepts are filed under `shares`, not USD. Asking for USD returns nothing, which
    // is how the screen's dilution rule once reported "skipped" for every company alive.
    unit: "shares",
  },
});

export const DEBT_BUCKETS = Object.freeze(["debt_long_term_noncurrent", "debt_long_term_current", "debt_short_term"]);

/** A date-only SEC field becomes an explicit UTC instant; anything unparseable becomes null. */
export function toInstant(value) {
  if (typeof value !== "string" || value.length < 10) return null;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** The fiscal year a period belongs to, taken from its end date -- the sec.mjs convention. */
export const fiscalYearOf = (end) => Number(String(end).slice(0, 4));

/* -------------------------------------------------------------- series and alignment -- */

/** One concept's annual history, flattened the way screen.mjs flattens it. */
export function conceptSeries(companyFacts, concept, asOf) {
  const spec = FUNDAMENTAL_CONCEPTS[concept];
  const found = annualSeries(companyFacts, spec.tags, { asOf, unit: spec.unit });
  if (!found) return [];
  return found.series.map((entry) => Object.freeze({
    concept,
    tag: entry.tag || found.tag,
    unit: spec.unit,
    start: entry.start || null,
    end: entry.end,
    filed: entry.filed || null,
    accession: entry.accn || null,
    value: entry.val,
    fiscal_year: fiscalYearOf(entry.end),
  }));
}

export function loadSeries(companyFacts, asOf) {
  return Object.freeze(Object.fromEntries(Object.keys(FUNDAMENTAL_CONCEPTS)
    .map((concept) => [concept, conceptSeries(companyFacts, concept, asOf)])));
}

/**
 * Quarterly history for a concept. sec.mjs only merges annual periods, so this mirrors its
 * rules for ~quarter-length durations: alias preference decides a period, a later filing of
 * the same alias supersedes an earlier one, and nothing filed after `asOf` is visible.
 */
export function quarterlySeries(companyFacts, tags, { asOf = null, unit = "USD" } = {}) {
  const cutoff = asOf ? new Date(asOf).getTime() : null;
  const byEnd = new Map();
  for (const tag of tags) {
    const entries = companyFacts?.facts?.["us-gaap"]?.[tag]?.units?.[unit];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry.form !== "10-Q" && entry.form !== "10-K") continue;
      if (!entry.start || !entry.end || !Number.isFinite(entry.val)) continue;
      const days = daysBetween(entry.start, entry.end);
      if (days < 80 || days > 100) continue;
      if (cutoff && new Date(entry.filed).getTime() > cutoff) continue;
      const prior = byEnd.get(entry.end);
      if (!prior) {
        byEnd.set(entry.end, { ...entry, tag });
      } else if (prior.tag === tag && new Date(entry.filed) > new Date(prior.filed)) {
        byEnd.set(entry.end, { ...entry, tag });
      }
    }
  }
  if (!byEnd.size) return null;
  return [...byEnd.values()].sort((left, right) => Date.parse(left.end) - Date.parse(right.end));
}

/** The newest filing instant across a set of entries -- the moment the metric became public. */
export function publicInstant(entries) {
  const instants = entries.map((entry) => toInstant(entry.filed)).filter(Boolean);
  if (instants.length !== entries.length) return null;
  return instants.sort().at(-1);
}

/**
 * The most recent fiscal year in which every named concept has a value.
 *
 * Aligning matters more than it looks: pairing this year's net income with last year's
 * balance sheet because one tag stopped being filed is exactly the stale-period carry-forward
 * this module exists to refuse.
 */
export function alignLatest(series, concepts) {
  const missing = concepts.filter((concept) => !series[concept]?.length);
  if (missing.length) return { ok: false, reason: "missing_tag", missing };

  const byYear = concepts.map((concept) => new Map(series[concept].map((entry) => [entry.fiscal_year, entry])));
  const shared = [...byYear[0].keys()].filter((year) => byYear.every((map) => map.has(year)));
  if (!shared.length) return { ok: false, reason: "no_common_period", missing: [] };

  const fiscalYear = Math.max(...shared);
  const entries = concepts.map((concept, index) => byYear[index].get(fiscalYear));
  return finishAlignment(entries, concepts, fiscalYear);
}

/** The same alignment, pinned to a stated fiscal year rather than to the newest one. */
export function alignYear(series, concepts, fiscalYear) {
  const picked = concepts.map((concept) => series[concept]?.find((entry) => entry.fiscal_year === fiscalYear));
  const missing = concepts.filter((concept, index) => !picked[index]);
  if (missing.length) return { ok: false, reason: "no_common_period", missing };
  return finishAlignment(picked, concepts, fiscalYear);
}

export function finishAlignment(entries, concepts, fiscalYear) {
  const ends = entries.map((entry) => Date.parse(entry.end));
  if (Math.max(...ends) - Math.min(...ends) > MAX_ALIGNMENT_DRIFT_DAYS * DAY_MS) {
    return { ok: false, reason: "period_misaligned", missing: [] };
  }
  const publicAt = publicInstant(entries);
  if (!publicAt) return { ok: false, reason: "missing_filing_date", missing: [] };

  const starts = entries.map((entry) => entry.start).filter(Boolean).sort();
  return {
    ok: true,
    fiscal_year: fiscalYear,
    period_start: starts[0] || null,
    period_end: entries.map((entry) => entry.end).sort().at(-1),
    public_at: publicAt,
    entries: Object.fromEntries(concepts.map((concept, index) => [concept, entries[index]])),
    used: entries,
  };
}

/** Merge alignments that must describe the same balance sheet or the same fiscal year. */
export function combineAlignments(alignments) {
  const ends = alignments.map((alignment) => Date.parse(alignment.period_end));
  if (Math.max(...ends) - Math.min(...ends) > MAX_ALIGNMENT_DRIFT_DAYS * DAY_MS) {
    return { ok: false, reason: "period_misaligned", missing: [] };
  }
  const used = alignments.flatMap((alignment) => alignment.used);
  const starts = used.map((entry) => entry.start).filter(Boolean).sort();
  return {
    ok: true,
    fiscal_year: Math.max(...alignments.map((alignment) => alignment.fiscal_year)),
    period_start: starts[0] || null,
    period_end: alignments.map((alignment) => alignment.period_end).sort().at(-1),
    public_at: alignments.map((alignment) => alignment.public_at).sort().at(-1),
    entries: Object.assign({}, ...alignments.map((alignment) => alignment.entries)),
    used,
  };
}

/* ------------------------------------------------------------------------------- gaps -- */

export const tagsFor = (concepts) => concepts.flatMap((concept) => FUNDAMENTAL_CONCEPTS[concept]?.tags || []);

export function gap({ factId, component = null, code, detail, missingTags = [] }) {
  return Object.freeze({
    metric: factId,
    component,
    code,
    detail,
    missing_tags: Object.freeze([...missingTags]),
  });
}

/** Turn a failed alignment into a gap that names the concept and every tag that was tried. */
export function alignmentGap(factId, alignment, concepts, component = null) {
  if (alignment.reason === "missing_tag" || (alignment.reason === "no_common_period" && alignment.missing.length)) {
    const missingTags = tagsFor(alignment.missing);
    return gap({
      factId,
      component,
      code: alignment.reason,
      detail: alignment.reason === "missing_tag"
        ? `no XBRL tag for ${alignment.missing.join(", ")} in Company Facts (tried ${missingTags.join(", ")})`
        : `${alignment.missing.join(", ")} is not reported for the aligned fiscal year`,
      missingTags,
    });
  }
  const detail = {
    no_common_period: `no fiscal year in which all of ${concepts.join(", ")} are reported together`,
    period_misaligned: `${concepts.join(", ")} disagree on the period end by more than ${MAX_ALIGNMENT_DRIFT_DAYS} days`,
    missing_filing_date: `an input carries no filing date, so public_at cannot be taken from the filing`,
  }[alignment.reason] || `inputs unavailable for ${concepts.join(", ")}`;
  return gap({ factId, component, code: alignment.reason, detail, missingTags: tagsFor(concepts) });
}

/* --------------------------------------------------------------------- metric factory -- */

const CONFIDENCE = Object.freeze({ reported: 0.95, rederived: 0.9, estimated: 0.6 });

export function sourceRecords(entries) {
  const seen = new Set();
  const records = [];
  for (const entry of entries) {
    const key = `${entry.tag}:${entry.accession || entry.filed}:${entry.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(Object.freeze({
      concept: entry.concept,
      tag: entry.tag,
      accession: entry.accession,
      filed: entry.filed,
      period_end: entry.end,
      unit: entry.unit,
      value: entry.value,
    }));
  }
  return Object.freeze(records);
}

/**
 * `sec:companyfacts:<cik>:<tag>:<accession|filed>:<period_end>` -- the identity the typed-fact
 * adapter already knows how to parse back into a filing locator.
 */
export function sourceIds(cik, entries) {
  return Object.freeze([...new Set(sourceRecords(entries)
    .map((record) => `sec:companyfacts:${cik}:${record.tag}:${record.accession || record.filed}:${record.period_end}`))]);
}

export function buildMetric({
  factId,
  valueKind,
  value,
  unit,
  currency = null,
  scale = null,
  ratioDenominator = null,
  alignment,
  cik,
  derivation,
  inputs,
  assumptions,
  components = null,
}) {
  const derived = derivation !== "reported";
  const parameters = { hash_domain: HASH_DOMAIN, fact_id: factId, tool_id: TOOL_ID, tool_version: TOOL_VERSION };
  return Object.freeze({
    fact_id: factId,
    value_kind: valueKind,
    value,
    unit,
    currency,
    scale,
    ratio_denominator: ratioDenominator,
    // A metric may declare itself a point-in-time quantity, in which case the span its inputs
    // were aligned over is not the period it covers and stating one would be wrong.
    period_start: alignment.suppressInterval ? null : alignment.period_start,
    period_end: alignment.suppressInterval ? null : alignment.period_end,
    fiscal_year: Number.isInteger(alignment.fiscal_year) ? alignment.fiscal_year : null,
    // Never the clock: the newest filing among the inputs is the moment this became knowable.
    public_at: alignment.public_at,
    derivation,
    confidence: CONFIDENCE[derivation],
    source_ids: sourceIds(cik, alignment.used),
    source_records: sourceRecords(alignment.used),
    inputs: Object.freeze(inputs),
    components: components ? Object.freeze(components) : null,
    assumptions: Object.freeze([...assumptions]),
    tool_id: derived ? TOOL_ID : null,
    tool_version: derived ? TOOL_VERSION : null,
    // A reported figure is not a calculation, so it carries no calculation hash -- which is
    // exactly what the typed-fact contract requires of `derivation: "reported"`.
    calculation_hash: derived ? sha256({ ...parameters, inputs, assumptions, value }) : null,
  });
}

/* -------------------------------------------------------------- shared derived pieces -- */

