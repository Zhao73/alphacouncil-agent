/**
 * Operating-company fundamentals derived from SEC Company Facts XBRL.
 *
 * screen.mjs eliminates on seven mechanical rules. The method seats need the operating
 * figures those rules never produce -- owner earnings, NCAV, an asset floor, revenue growth,
 * incremental returns, leverage, the share count -- so this module derives them from the
 * same filings, with the arithmetic and the assumptions returned alongside the number.
 *
 * Three properties are enforced in code, not asked for in a comment:
 *
 *   1. `public_at` is the FILING date of the newest input, never the clock. A fiscal year
 *      ending 2024-09-28 was not knowable until the 10-K was filed on 2024-11-01, and a
 *      metric stamped "now" silently converts a backtest into a measurement of the future.
 *   2. A missing tag is a named gap in `unavailable`, never a zero, never a silent switch to
 *      a neighbouring concept, and never a stale period carried forward. The metric is null.
 *   3. Units are explicit: ratios are decimals (0.15, not 15); money carries a currency and
 *      a scale; share counts carry the `shares` unit XBRL actually files them under.
 *
 * Tag resolution reuses `annualSeries` from sec.mjs -- the same alias merge, the same
 * 300-400 day annual window, the same look-ahead filter on `filed` that the screen uses.
 * Quarterly extraction is the one thing sec.mjs does not offer, so `quarterlySeries` below
 * is written with deliberately identical semantics rather than a second set of rules.
 *
 * All network access goes through sec.mjs, which owns the ~10 req/s throttle and the
 * User-Agent SEC requires. Nothing here calls fetch directly.
 */

import { CONCEPTS, annualSeries, fetchCompanyFacts, fetchUniverse } from "./sec.mjs";
import { sha256 } from "./personas-v3/canonical.mjs";
import { invalidParams } from "./errors.mjs";

export const TOOL_ID = "sec_fundamentals";
export const TOOL_VERSION = "1.0.0";
const HASH_DOMAIN = "alphacouncil.fundamentals.sec-companyfacts.v1";

const DAY_MS = 86_400_000;

/** Fact ids this module can produce, in the order they are derived. */
export const FUNDAMENTAL_FACT_IDS = Object.freeze([
  "financial.owner_earnings",
  "financial.net_current_asset_value",
  "valuation.downside_asset_value",
  "valuation.downside_floor",
  "valuation.revenue_growth",
  "financial.incremental_return_on_capital",
  "financial.leverage",
  "capital_allocation.share_count",
]);

/**
 * Maintenance capital expenditure is not a reported line item anywhere in US GAAP. Buffett's
 * owner earnings needs it, so it is proxied -- and because the maintenance/growth split is an
 * assumption rather than a recomputation, `financial.owner_earnings` is labelled `estimated`.
 * The proxy travels with the number so a seat can disagree with the factor instead of the
 * figure.
 */
export const MAINTENANCE_CAPEX_PROXY = Object.freeze({
  id: "min_of_current_and_median_capex_times_factor",
  median_window_years: 5,
  minimum_years: 3,
  factor: 0.7,
  formula: "maintenance_capex = min(capex_fy, median(capex over the last 5 fiscal years)) * 0.7",
});

/** Windows and floors that would otherwise be magic numbers inside the derivations. */
const WINDOWS = Object.freeze({
  revenue_cagr_max_years: 6,        // 6 annual points == a 5-year CAGR
  revenue_cagr_min_points: 3,
  incremental_roic_years: 5,
  incremental_roic_min_years: 3,
  /** |change in invested capital| must clear this share of the starting base to be a divisor. */
  incremental_roic_min_denominator_fraction: 0.01,
  /** Two facts claiming the same period may not disagree by more than this. */
  max_alignment_drift_days: 45,
});

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

const DEBT_BUCKETS = Object.freeze(["debt_long_term_noncurrent", "debt_long_term_current", "debt_short_term"]);

/* -------------------------------------------------------------------------- utilities -- */

const sum = (values) => values.reduce((total, value) => total + value, 0);

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

const decimal = (value) => Number(value.toFixed(6));
const money = (value) => Math.round(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** A date-only SEC field becomes an explicit UTC instant; anything unparseable becomes null. */
function toInstant(value) {
  if (typeof value !== "string" || value.length < 10) return null;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** The fiscal year a period belongs to, taken from its end date -- the sec.mjs convention. */
const fiscalYearOf = (end) => Number(String(end).slice(0, 4));

/* -------------------------------------------------------------- series and alignment -- */

/** One concept's annual history, flattened the way screen.mjs flattens it. */
function conceptSeries(companyFacts, concept, asOf) {
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

function loadSeries(companyFacts, asOf) {
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
function publicInstant(entries) {
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
function alignLatest(series, concepts) {
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
function alignYear(series, concepts, fiscalYear) {
  const picked = concepts.map((concept) => series[concept]?.find((entry) => entry.fiscal_year === fiscalYear));
  const missing = concepts.filter((concept, index) => !picked[index]);
  if (missing.length) return { ok: false, reason: "no_common_period", missing };
  return finishAlignment(picked, concepts, fiscalYear);
}

function finishAlignment(entries, concepts, fiscalYear) {
  const ends = entries.map((entry) => Date.parse(entry.end));
  if (Math.max(...ends) - Math.min(...ends) > WINDOWS.max_alignment_drift_days * DAY_MS) {
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
function combineAlignments(alignments) {
  const ends = alignments.map((alignment) => Date.parse(alignment.period_end));
  if (Math.max(...ends) - Math.min(...ends) > WINDOWS.max_alignment_drift_days * DAY_MS) {
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

const tagsFor = (concepts) => concepts.flatMap((concept) => FUNDAMENTAL_CONCEPTS[concept]?.tags || []);

function gap({ factId, component = null, code, detail, missingTags = [] }) {
  return Object.freeze({
    metric: factId,
    component,
    code,
    detail,
    missing_tags: Object.freeze([...missingTags]),
  });
}

/** Turn a failed alignment into a gap that names the concept and every tag that was tried. */
function alignmentGap(factId, alignment, concepts, component = null) {
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
    period_misaligned: `${concepts.join(", ")} disagree on the period end by more than ${WINDOWS.max_alignment_drift_days} days`,
    missing_filing_date: `an input carries no filing date, so public_at cannot be taken from the filing`,
  }[alignment.reason] || `inputs unavailable for ${concepts.join(", ")}`;
  return gap({ factId, component, code: alignment.reason, detail, missingTags: tagsFor(concepts) });
}

/* --------------------------------------------------------------------- metric factory -- */

const CONFIDENCE = Object.freeze({ reported: 0.95, rederived: 0.9, estimated: 0.6 });

function sourceRecords(entries) {
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
function sourceIds(cik, entries) {
  return Object.freeze([...new Set(sourceRecords(entries)
    .map((record) => `sec:companyfacts:${cik}:${record.tag}:${record.accession || record.filed}:${record.period_end}`))]);
}

function buildMetric({
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
    period_start: alignment.period_start,
    period_end: alignment.period_end,
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

/**
 * Total debt for one fiscal year.
 *
 * A single combined tag wins outright. Otherwise the three non-overlapping buckets are summed
 * and the ones a filer does not report are named in `missing_buckets` rather than assumed
 * away silently. No bucket at all is null, never zero: a company with unknown debt is not a
 * debt-free company.
 */
function totalDebtForYear(series, fiscalYear) {
  const combined = series.debt_combined.find((entry) => entry.fiscal_year === fiscalYear);
  if (combined) {
    return { value: combined.value, entries: [combined], buckets: ["debt_combined"], missing_buckets: [] };
  }
  const present = DEBT_BUCKETS
    .map((bucket) => ({ bucket, entry: series[bucket].find((item) => item.fiscal_year === fiscalYear) }))
    .filter((item) => item.entry);
  if (!present.length) return null;
  return {
    value: sum(present.map((item) => item.entry.value)),
    entries: present.map((item) => item.entry),
    buckets: present.map((item) => item.bucket),
    missing_buckets: DEBT_BUCKETS.filter((bucket) => !present.some((item) => item.bucket === bucket)),
  };
}

/**
 * Tangible book value: equity less goodwill and intangibles.
 *
 * A filer with goodwill on its balance sheet must tag it, so a concept absent from every
 * period of the document is evidence of nil rather than a data gap -- and that reading is
 * still written into `assumptions`. A concept reported in other years but not this one is
 * treated as a genuine misalignment and refuses to compute.
 */
function tangibleBookForYear(series, fiscalYear) {
  const equity = series.equity.find((entry) => entry.fiscal_year === fiscalYear);
  if (!equity) return null;
  const deductions = [];
  const assumptions = [];
  const entries = [equity];
  for (const concept of ["goodwill", "intangibles"]) {
    const entry = series[concept].find((item) => item.fiscal_year === fiscalYear);
    if (entry) {
      deductions.push({ concept, tag: entry.tag, value: entry.value });
      entries.push(entry);
      continue;
    }
    if (series[concept].length) return { misaligned: concept };
    assumptions.push(`${concept} is not tagged in any period of this filer's Company Facts and is treated as 0`);
  }
  return {
    value: equity.value - sum(deductions.map((item) => item.value)),
    equity: equity.value,
    deductions,
    assumptions,
    entries,
  };
}

/**
 * Profit for the incremental-return window: NOPAT when the tax inputs exist, otherwise net
 * income -- and the basis is named in the output rather than left for the reader to guess.
 */
function profitForYear(series, fiscalYear) {
  const nopat = alignYear(series, ["operating_income", "tax_expense", "pretax_income"], fiscalYear);
  if (nopat.ok && nopat.entries.pretax_income.value > 0) {
    const rate = nopat.entries.tax_expense.value / nopat.entries.pretax_income.value;
    if (rate >= 0 && rate < 1) {
      return {
        basis: "nopat",
        value: nopat.entries.operating_income.value * (1 - rate),
        effective_tax_rate: decimal(rate),
        entries: nopat.used,
      };
    }
  }
  const netIncome = series.net_income.find((entry) => entry.fiscal_year === fiscalYear);
  if (!netIncome) return null;
  return { basis: "net_income", value: netIncome.value, effective_tax_rate: null, entries: [netIncome] };
}

/* ---------------------------------------------------------------------- derived facts -- */

/** 1. Buffett owner earnings: net income + D&A - maintenance capex (an estimate, by design). */
function ownerEarnings(series, cik, gaps, proxy) {
  const factId = "financial.owner_earnings";
  const concepts = ["net_income", "depreciation_amortisation", "capex"];
  const alignment = alignLatest(series, concepts);
  if (!alignment.ok) {
    gaps.push(alignmentGap(factId, alignment, concepts));
    return null;
  }
  const window = series.capex
    .filter((entry) => entry.fiscal_year <= alignment.fiscal_year)
    .slice(-proxy.median_window_years);
  if (window.length < proxy.minimum_years) {
    gaps.push(gap({
      factId,
      code: "insufficient_history",
      detail: `maintenance capex needs at least ${proxy.minimum_years} fiscal years of capex; found ${window.length}`,
      missingTags: FUNDAMENTAL_CONCEPTS.capex.tags,
    }));
    return null;
  }
  const capexNow = alignment.entries.capex.value;
  const capexMedian = median(window.map((entry) => entry.value));
  const maintenance = Math.min(capexNow, capexMedian) * proxy.factor;
  const netIncome = alignment.entries.net_income.value;
  const depreciation = alignment.entries.depreciation_amortisation.value;
  // The median window can contain a restatement filed after the aligned year's 10-K, so
  // public_at takes the newest filing across everything the number touched.
  const publicAt = [alignment.public_at, ...window.map((entry) => toInstant(entry.filed))]
    .filter(Boolean).sort().at(-1);

  return buildMetric({
    factId,
    valueKind: "monetary",
    value: money(netIncome + depreciation - maintenance),
    unit: "currency_units",
    currency: "USD",
    scale: 1,
    alignment: { ...alignment, public_at: publicAt, used: [...alignment.used, ...window] },
    cik,
    // Not "rederived": nothing in the filings states the maintenance/growth split, so this is
    // an estimate whose value moves with the proxy. Mislabelling it would let a seat treat an
    // assumption as a recomputation of something the company actually reported.
    derivation: "estimated",
    inputs: {
      net_income: netIncome,
      depreciation_amortisation: depreciation,
      depreciation_tag: alignment.entries.depreciation_amortisation.tag,
      capex_fiscal_year: capexNow,
      capex_median: capexMedian,
      capex_median_years: window.length,
      capex_median_from_fiscal_year: window[0].fiscal_year,
      maintenance_capex: money(maintenance),
      proxy: { ...proxy },
    },
    assumptions: [
      `maintenance capital expenditure is not a reported line item; proxied as ${proxy.formula}`,
      `for FY${alignment.fiscal_year}: min(capex ${money(capexNow)}, ${window.length}-year median ${money(capexMedian)}) * ${proxy.factor} = ${money(maintenance)} USD`,
      "the maintenance/growth split is an assumption, not a recomputation, so this fact is derivation=estimated",
      `depreciation and amortisation taken from ${alignment.entries.depreciation_amortisation.tag}`,
    ],
  });
}

/** 2. Graham NCAV: current assets - total liabilities. */
function netCurrentAssetValue(series, cik, gaps) {
  const factId = "financial.net_current_asset_value";
  const concepts = ["current_assets", "total_liabilities"];
  const alignment = alignLatest(series, concepts);
  if (!alignment.ok) {
    gaps.push(alignmentGap(factId, alignment, concepts));
    return null;
  }
  const currentAssets = alignment.entries.current_assets.value;
  const liabilities = alignment.entries.total_liabilities.value;
  return buildMetric({
    factId,
    valueKind: "monetary",
    value: money(currentAssets - liabilities),
    unit: "currency_units",
    currency: "USD",
    scale: 1,
    alignment,
    cik,
    derivation: "rederived",
    inputs: { current_assets: currentAssets, total_liabilities: liabilities },
    assumptions: [
      "Graham NCAV as filed: current assets less ALL liabilities, with no haircut applied to receivables or inventory",
      "an unclassified balance sheet (banks, insurers, many REITs) files no AssetsCurrent, which is reported as a gap rather than substituted",
    ],
  });
}

/** 3. Klarman-style asset floor: tangible book + cash - total debt. */
function downsideAssetValue(series, cik, gaps) {
  const factId = "valuation.downside_asset_value";
  const concepts = ["equity", "cash"];
  const alignment = alignLatest(series, concepts);
  if (!alignment.ok) {
    gaps.push(alignmentGap(factId, alignment, concepts));
    return null;
  }
  const tangible = tangibleBookForYear(series, alignment.fiscal_year);
  if (tangible?.misaligned) {
    gaps.push(gap({
      factId,
      code: "period_misaligned",
      detail: `${tangible.misaligned} is reported in other periods but not FY${alignment.fiscal_year}, so tangible book cannot be struck for this balance sheet`,
      missingTags: FUNDAMENTAL_CONCEPTS[tangible.misaligned].tags,
    }));
    return null;
  }
  const debt = totalDebtForYear(series, alignment.fiscal_year);
  if (!debt) {
    gaps.push(gap({
      factId,
      code: "missing_tag",
      detail: "no debt tag of any kind for the aligned fiscal year; total debt is unknown, which is not the same as zero",
      missingTags: tagsFor(["debt_combined", ...DEBT_BUCKETS]),
    }));
    return null;
  }
  const cash = alignment.entries.cash.value;
  const used = [...alignment.used, ...tangible.entries, ...debt.entries];
  return buildMetric({
    factId,
    valueKind: "monetary",
    value: money(tangible.value + cash - debt.value),
    unit: "currency_units",
    currency: "USD",
    scale: 1,
    alignment: { ...alignment, used },
    cik,
    derivation: "rederived",
    inputs: {
      tangible_book_value: money(tangible.value),
      equity: tangible.equity,
      tangible_deductions: tangible.deductions,
      cash,
      cash_tag: alignment.entries.cash.tag,
      total_debt: debt.value,
      debt_buckets: debt.buckets,
    },
    assumptions: [
      "construction is tangible book + cash - total debt, as specified for this fact",
      "cash is already inside tangible book, so this deliberately counts the cash balance twice: it is a downside cushion, not a balance-sheet identity",
      ...tangible.assumptions,
      debt.missing_buckets.length
        ? `total debt summed from ${debt.buckets.join(", ")}; ${debt.missing_buckets.join(", ")} not reported for this period`
        : `total debt summed from ${debt.buckets.join(", ")}`,
    ],
  });
}

/** Read an already-built metric back as an alignment so a second fact can combine with it. */
function alignmentOfMetric(metric) {
  return {
    ok: true,
    fiscal_year: metric.fiscal_year,
    period_start: metric.period_start,
    period_end: metric.period_end,
    public_at: metric.public_at,
    entries: {},
    used: metric.source_records.map((record) => ({
      concept: record.concept,
      tag: record.tag,
      unit: record.unit,
      start: null,
      end: record.period_end,
      filed: record.filed,
      accession: record.accession,
      value: record.value,
      fiscal_year: fiscalYearOf(record.period_end),
    })),
  };
}

/** 4. Pabrai-style floor: min(NCAV, tangible book), reporting which term bound it. */
function downsideFloor(series, cik, gaps, ncav) {
  const factId = "valuation.downside_floor";
  if (!ncav) {
    gaps.push(gap({
      factId,
      code: "missing_input",
      detail: "net current asset value could not be computed, and the minimum of an unknown is unknown",
      missingTags: tagsFor(["current_assets", "total_liabilities"]),
    }));
    return null;
  }
  const equityAlignment = alignLatest(series, ["equity"]);
  if (!equityAlignment.ok) {
    gaps.push(alignmentGap(factId, equityAlignment, ["equity"]));
    return null;
  }
  const tangible = tangibleBookForYear(series, equityAlignment.fiscal_year);
  if (tangible?.misaligned) {
    gaps.push(gap({
      factId,
      code: "period_misaligned",
      detail: `${tangible.misaligned} is reported in other periods but not FY${equityAlignment.fiscal_year}`,
      missingTags: FUNDAMENTAL_CONCEPTS[tangible.misaligned].tags,
    }));
    return null;
  }
  const tangibleAlignment = { ...equityAlignment, used: tangible.entries };
  const combined = combineAlignments([alignmentOfMetric(ncav), tangibleAlignment]);
  if (!combined.ok) {
    gaps.push(alignmentGap(factId, combined, ["current_assets", "equity"]));
    return null;
  }
  const terms = [
    { term: "net_current_asset_value", value: ncav.value },
    { term: "tangible_book_value", value: money(tangible.value) },
  ];
  const binding = terms.reduce((low, item) => (item.value < low.value ? item : low));
  return buildMetric({
    factId,
    valueKind: "monetary",
    value: binding.value,
    unit: "currency_units",
    currency: "USD",
    scale: 1,
    alignment: combined,
    cik,
    derivation: "rederived",
    inputs: {
      net_current_asset_value: ncav.value,
      tangible_book_value: money(tangible.value),
      bound_by: binding.term,
    },
    components: { bound_by: binding.term, terms },
    assumptions: [
      "floor is min(NCAV, tangible book value); the binding term is reported in components.bound_by",
      "no liquidation haircut and no EV/EBIT term is applied, so this is an accounting floor, not a realisable price",
      ...tangible.assumptions,
    ],
  });
}

/**
 * The compound annual growth rate across the available annual revenue history.
 *
 * The exponent is the measured day span, not the number of periods: 52/53-week fiscal
 * calendars and stub years make "five filings" and "five years" different numbers, and using
 * the filing count biases every growth rate in the same direction.
 */
function revenueCagr(annual, factId, gaps) {
  if (annual.length < WINDOWS.revenue_cagr_min_points) {
    gaps.push(gap({
      factId,
      code: annual.length ? "insufficient_history" : "missing_tag",
      detail: `a revenue CAGR needs at least ${WINDOWS.revenue_cagr_min_points} annual periods; found ${annual.length}`,
      missingTags: FUNDAMENTAL_CONCEPTS.revenue.tags,
    }));
    return null;
  }
  const first = annual[0];
  const last = annual.at(-1);
  if (!(first.value > 0) || !(last.value > 0)) {
    gaps.push(gap({
      factId,
      code: "non_positive_base",
      detail: `a CAGR is undefined across a non-positive revenue (${first.value} -> ${last.value})`,
    }));
    return null;
  }
  const spanDays = daysBetween(first.end, last.end);
  if (spanDays <= 0) {
    gaps.push(gap({ factId, code: "period_misaligned", detail: "revenue periods do not advance in time" }));
    return null;
  }
  const publicAt = publicInstant(annual);
  if (!publicAt) {
    gaps.push(gap({ factId, code: "missing_filing_date", detail: "a revenue period carries no filing date" }));
    return null;
  }
  const years = spanDays / 365.25;
  return { cagr: (last.value / first.value) ** (1 / years) - 1, first, last, spanDays, years, publicAt };
}

/** 5. Revenue growth: 5-year CAGR as the value, trailing-4-quarter YoY as a component. */
function revenueGrowth(companyFacts, series, cik, gaps, asOf) {
  const factId = "valuation.revenue_growth";
  const annual = series.revenue.slice(-WINDOWS.revenue_cagr_max_years);
  const compound = revenueCagr(annual, factId, gaps);
  if (!compound) return null;
  const { cagr, first, last, spanDays, years, publicAt } = compound;
  const yoy = trailingYearOverYear(companyFacts, asOf);
  if (yoy.value === null && yoy.gap) gaps.push(gap({ factId, component: "yoy_ttm", ...yoy.gap }));

  const alignment = {
    ok: true,
    fiscal_year: last.fiscal_year,
    period_start: first.start || first.end,
    period_end: last.end,
    public_at: [publicAt, yoy.public_at].filter(Boolean).sort().at(-1),
    entries: {},
    used: [...annual, ...(yoy.entries || [])],
  };
  return buildMetric({
    factId,
    valueKind: "ratio",
    value: decimal(cagr),
    unit: "decimal",
    ratioDenominator: "compound_annual_revenue_growth",
    alignment,
    cik,
    derivation: "rederived",
    inputs: {
      revenue_start: first.value,
      revenue_start_period_end: first.end,
      revenue_end: last.value,
      revenue_end_period_end: last.end,
      span_days: spanDays,
      years: decimal(years),
    },
    components: {
      cagr: decimal(cagr),
      cagr_years: decimal(years),
      yoy_ttm: yoy.value === null ? null : decimal(yoy.value),
      yoy_ttm_latest: yoy.latest ?? null,
      yoy_ttm_prior: yoy.prior ?? null,
    },
    assumptions: [
      `value is the compound annual growth rate over ${decimal(years)} years (${first.end} -> ${last.end}), expressed as a decimal`,
      "the exponent uses the measured day span, not the count of filings, because fiscal calendars are 52 or 53 weeks",
      yoy.value === null
        ? "trailing-four-quarter year-over-year is unavailable and reported as a gap rather than substituted for the CAGR"
        : "components.yoy_ttm is the sum of the latest four quarters against the four before them, as a decimal",
    ],
  });
}

/** Trailing-four-quarter revenue against the four quarters before it. */
function trailingYearOverYear(companyFacts, asOf) {
  const quarters = quarterlySeries(companyFacts, FUNDAMENTAL_CONCEPTS.revenue.tags, { asOf, unit: "USD" });
  const empty = { value: null, public_at: null, entries: [] };
  if (!quarters || quarters.length < 8) {
    return {
      ...empty,
      gap: {
        code: "insufficient_history",
        detail: `a trailing-four-quarter comparison needs 8 tagged quarters; found ${quarters?.length || 0}`,
        missingTags: FUNDAMENTAL_CONCEPTS.revenue.tags,
      },
    };
  }
  const latest = fourQuarters(quarters, quarters.length - 1);
  const prior = fourQuarters(quarters, quarters.length - 5);
  if (!latest || !prior) {
    return { ...empty, gap: { code: "period_misaligned", detail: "the eight most recent quarters are not contiguous four-quarter blocks" } };
  }
  if (!(prior.total > 0)) {
    return { ...empty, gap: { code: "non_positive_base", detail: `prior-year four-quarter revenue is ${prior.total}` } };
  }
  const entries = [...prior.window, ...latest.window].map((entry) => ({
    concept: "revenue",
    tag: entry.tag,
    unit: "USD",
    start: entry.start,
    end: entry.end,
    filed: entry.filed,
    accession: entry.accn || null,
    value: entry.val,
    fiscal_year: fiscalYearOf(entry.end),
  }));
  return {
    value: latest.total / prior.total - 1,
    latest: latest.total,
    prior: prior.total,
    public_at: publicInstant(entries),
    entries,
  };
}

/** Four contiguous quarters ending at `index`, or null when a quarter is missing or overlaps. */
function fourQuarters(quarters, index) {
  if (index < 3) return null;
  const window = quarters.slice(index - 3, index + 1);
  const span = daysBetween(window[0].start, window.at(-1).end);
  if (span < 330 || span > 400) return null;
  for (let position = 1; position < window.length; position += 1) {
    const seam = daysBetween(window[position - 1].end, window[position].start);
    if (seam < -5 || seam > 15) return null;
  }
  return { total: sum(window.map((entry) => entry.val)), window };
}

/**
 * The two endpoints of the incremental-return window, or null with a named gap.
 *
 * The window is stated rather than assumed: it reaches back `incremental_roic_years` and
 * settles for the oldest year available only while that is still at least
 * `incremental_roic_min_years` apart, because a one-year "incremental return" is noise.
 */
function incrementalEndpoints(series, factId, gaps) {
  const concepts = ["equity", "cash"];
  const latest = alignLatest(series, concepts);
  if (!latest.ok) {
    gaps.push(alignmentGap(factId, latest, concepts));
    return null;
  }
  const endYear = latest.fiscal_year;
  const wanted = endYear - WINDOWS.incremental_roic_years;
  const candidates = series.equity
    .map((entry) => entry.fiscal_year)
    .filter((year) => year <= wanted && endYear - year >= WINDOWS.incremental_roic_min_years);
  const startYear = candidates.length
    ? Math.max(...candidates)
    : Math.min(...series.equity.map((entry) => entry.fiscal_year));
  if (endYear - startYear < WINDOWS.incremental_roic_min_years) {
    gaps.push(gap({
      factId,
      code: "insufficient_history",
      detail: `an incremental return needs at least ${WINDOWS.incremental_roic_min_years} years between endpoints; FY${startYear} to FY${endYear} is ${endYear - startYear}`,
    }));
    return null;
  }
  const [start, end] = [startYear, endYear].map((year) => investedCapital(series, year));
  if (!start || !end) {
    gaps.push(gap({
      factId,
      code: "missing_tag",
      detail: `invested capital (equity + total debt - cash) is not computable for FY${startYear} and FY${endYear} together`,
      missingTags: tagsFor(["equity", "cash", "debt_combined", ...DEBT_BUCKETS]),
    }));
    return null;
  }
  const profits = matchedProfits(series, startYear, endYear);
  if (!profits) {
    gaps.push(gap({
      factId,
      code: "missing_tag",
      detail: `neither NOPAT nor net income is available for both FY${startYear} and FY${endYear}`,
      missingTags: tagsFor(["operating_income", "tax_expense", "pretax_income", "net_income"]),
    }));
    return null;
  }
  return { startYear, endYear, start, end, ...profits };
}

/**
 * Both endpoints on one profit basis. Pairing a NOPAT endpoint with a net-income endpoint
 * would difference two different quantities and call the result a return.
 */
function matchedProfits(series, startYear, endYear) {
  const profits = [startYear, endYear].map((year) => profitForYear(series, year));
  if (profits.some((profit) => !profit)) return null;
  if (profits.every((profit) => profit.basis === "nopat")) return { basis: "nopat", profits };
  const fallback = [startYear, endYear]
    .map((year) => series.net_income.find((entry) => entry.fiscal_year === year));
  if (fallback.some((entry) => !entry)) return null;
  return {
    basis: "net_income",
    profits: fallback.map((entry) => ({ basis: "net_income", value: entry.value, entries: [entry] })),
  };
}

/** 6. Incremental return on capital: change in profit over change in invested capital. */
function incrementalReturnOnCapital(series, cik, gaps) {
  const factId = "financial.incremental_return_on_capital";
  const window = incrementalEndpoints(series, factId, gaps);
  if (!window) return null;
  const { startYear, endYear, start, end, basis, profits } = window;

  const capitalChange = end.value - start.value;
  const floor = Math.max(Math.abs(start.value) * WINDOWS.incremental_roic_min_denominator_fraction, 1);
  if (Math.abs(capitalChange) < floor) {
    // A near-zero denominator produces an enormous ratio that reads as a spectacular business.
    gaps.push(gap({
      factId,
      code: "denominator_near_zero",
      detail: `invested capital changed by ${money(capitalChange)} against a FY${startYear} base of ${money(start.value)}, below the ${WINDOWS.incremental_roic_min_denominator_fraction * 100}% floor; a ratio here would be an artefact of the divisor`,
    }));
    return null;
  }
  const profitChange = profits[1].value - profits[0].value;
  const used = [...start.entries, ...end.entries, ...profits[0].entries, ...profits[1].entries];
  const publicAt = publicInstant(used);
  if (!publicAt) {
    gaps.push(gap({ factId, code: "missing_filing_date", detail: "an endpoint carries no filing date" }));
    return null;
  }
  return buildMetric({
    factId,
    valueKind: "ratio",
    value: decimal(profitChange / capitalChange),
    unit: "decimal",
    ratioDenominator: `change_in_invested_capital_fy${startYear}_to_fy${endYear}`,
    alignment: {
      ok: true,
      fiscal_year: endYear,
      period_start: start.period_end,
      period_end: end.period_end,
      public_at: publicAt,
      entries: {},
      used,
    },
    cik,
    derivation: "rederived",
    inputs: {
      profit_basis: basis,
      profit_start: money(profits[0].value),
      profit_end: money(profits[1].value),
      profit_change: money(profitChange),
      invested_capital_start: money(start.value),
      invested_capital_end: money(end.value),
      invested_capital_change: money(capitalChange),
      window_years: endYear - startYear,
    },
    assumptions: [
      `change in ${basis === "nopat" ? "NOPAT" : "net income"} over change in invested capital across FY${startYear} to FY${endYear} (${endYear - startYear} years)`,
      basis === "nopat"
        ? "NOPAT is operating income times (1 - effective tax rate), the rate taken from income tax expense over pre-tax income"
        : "NOPAT inputs (operating income, tax expense, pre-tax income) were unavailable at one or both endpoints, so net income is the profit basis",
      "invested capital is book equity + total debt - cash and equivalents",
      `a change in invested capital below ${WINDOWS.incremental_roic_min_denominator_fraction * 100}% of the starting base is refused rather than divided by`,
    ],
  });
}

function investedCapital(series, fiscalYear) {
  const alignment = alignYear(series, ["equity", "cash"], fiscalYear);
  if (!alignment.ok) return null;
  const debt = totalDebtForYear(series, fiscalYear);
  if (!debt) return null;
  return {
    value: alignment.entries.equity.value + debt.value - alignment.entries.cash.value,
    period_end: alignment.period_end,
    entries: [...alignment.used, ...debt.entries],
  };
}

/** 7. Leverage: total debt / equity, with net debt / EBITDA when its inputs exist. */
function leverage(series, cik, gaps) {
  const factId = "financial.leverage";
  const alignment = alignLatest(series, ["equity"]);
  if (!alignment.ok) {
    gaps.push(alignmentGap(factId, alignment, ["equity"]));
    return null;
  }
  const debt = totalDebtForYear(series, alignment.fiscal_year);
  if (!debt) {
    gaps.push(gap({
      factId,
      code: "missing_tag",
      detail: "no debt tag of any kind for the aligned fiscal year; unknown debt is not zero debt",
      missingTags: tagsFor(["debt_combined", ...DEBT_BUCKETS]),
    }));
    return null;
  }
  const equity = alignment.entries.equity.value;
  if (!(equity > 0)) {
    gaps.push(gap({
      factId,
      code: "non_positive_base",
      detail: `book equity is ${money(equity)}; debt/equity is uninterpretable at or below zero equity`,
    }));
    return null;
  }
  const multiple = netDebtToEbitda(series, alignment.fiscal_year, debt, factId, gaps);
  const { cash, ebitda } = multiple;
  const used = [...alignment.used, ...debt.entries, ...multiple.entries];
  const publicAt = publicInstant(used);
  if (!publicAt) {
    gaps.push(gap({ factId, code: "missing_filing_date", detail: "an input carries no filing date" }));
    return null;
  }
  return buildMetric({
    factId,
    valueKind: "ratio",
    value: decimal(debt.value / equity),
    unit: "decimal",
    ratioDenominator: "book_equity",
    alignment: { ...alignment, public_at: publicAt, used },
    cik,
    derivation: "rederived",
    inputs: {
      total_debt: debt.value,
      debt_buckets: debt.buckets,
      equity,
      cash: cash ? cash.value : null,
      ebitda: ebitda ? money(ebitda.value) : null,
      net_debt: cash ? debt.value - cash.value : null,
    },
    components: { debt_to_equity: decimal(debt.value / equity), net_debt_to_ebitda: multiple.value },
    assumptions: [
      "value is total debt divided by book equity, as a decimal (0.5 means half a turn, not 50)",
      debt.missing_buckets.length
        ? `total debt summed from ${debt.buckets.join(", ")}; ${debt.missing_buckets.join(", ")} not reported for this period`
        : `total debt summed from ${debt.buckets.join(", ")}`,
      "operating leases are included only where a filer tags them inside a capital-lease debt concept",
      multiple.value === null
        ? "net debt / EBITDA is unavailable and reported as a gap rather than defaulted"
        : "EBITDA is operating income plus depreciation and amortisation, not an adjusted figure",
    ],
  });
}

/**
 * Net debt / EBITDA, or null with a named component gap. Losing the multiple never takes the
 * whole leverage fact down -- debt/equity is still a figure the filing supports.
 */
function netDebtToEbitda(series, fiscalYear, debt, factId, gaps) {
  const cash = series.cash.find((entry) => entry.fiscal_year === fiscalYear) || null;
  const ebitda = ebitdaForYear(series, fiscalYear);
  const decline = (code, detail, missingTags = []) => {
    gaps.push(gap({ factId, component: "net_debt_to_ebitda", code, detail, missingTags }));
    return { value: null, cash, ebitda, entries: [] };
  };
  if (!cash) {
    return decline("missing_tag", "cash is not reported for the aligned fiscal year, so net debt cannot be struck", FUNDAMENTAL_CONCEPTS.cash.tags);
  }
  if (!ebitda) {
    return decline("missing_tag", "operating income and/or depreciation are not reported for the aligned fiscal year, so EBITDA cannot be struck", tagsFor(["operating_income", "depreciation_amortisation"]));
  }
  if (!(ebitda.value > 0)) {
    return decline("non_positive_base", `EBITDA is ${money(ebitda.value)}; a multiple against non-positive EBITDA is meaningless`);
  }
  return {
    value: decimal((debt.value - cash.value) / ebitda.value),
    cash,
    ebitda,
    entries: [cash, ...ebitda.entries],
  };
}

function ebitdaForYear(series, fiscalYear) {
  const alignment = alignYear(series, ["operating_income", "depreciation_amortisation"], fiscalYear);
  if (!alignment.ok) return null;
  return {
    value: alignment.entries.operating_income.value + alignment.entries.depreciation_amortisation.value,
    entries: alignment.used,
  };
}

/** 8. Latest diluted share count, exactly as filed. */
function shareCount(series, cik, gaps) {
  const factId = "capital_allocation.share_count";
  const alignment = alignLatest(series, ["diluted_shares"]);
  if (!alignment.ok) {
    gaps.push(alignmentGap(factId, alignment, ["diluted_shares"]));
    return null;
  }
  const entry = alignment.entries.diluted_shares;
  return buildMetric({
    factId,
    valueKind: "count",
    value: Math.round(entry.value),
    unit: "shares",
    alignment,
    cik,
    derivation: "reported",
    inputs: { diluted_shares: entry.value, tag: entry.tag },
    assumptions: [
      `${entry.tag} is the weighted average diluted count over the fiscal period, not a point-in-time count on the period end date`,
      "taken from the annual filing; it does not reflect issuance or buybacks after the period end",
    ],
  });
}

/* ---------------------------------------------------------------------------- exports -- */

function resolveCik(companyFacts) {
  const digits = String(companyFacts?.cik ?? "").replace(/\D/gu, "");
  return digits ? digits.padStart(10, "0") : "unknown";
}

/**
 * Derive every fundamental this module knows how to compute from one Company Facts document.
 *
 * Pure: no clock, no network, no mutation of the input. Returns one object so a caller can
 * wire `metrics` into the typed-fact adapter and surface `unavailable` as declared gaps.
 * Every fact id is always present in `metrics`; one that could not be computed is `null` and
 * has at least one matching entry in `unavailable`.
 */
export function deriveFundamentals({ companyFacts, asOf = null, maintenanceCapexProxy = MAINTENANCE_CAPEX_PROXY } = {}) {
  if (!companyFacts || typeof companyFacts !== "object" || Array.isArray(companyFacts)) {
    throw invalidParams("deriveFundamentals needs a companyFacts object from SEC Company Facts");
  }
  if (asOf !== null && !Number.isFinite(Date.parse(String(asOf)))) {
    throw invalidParams(`deriveFundamentals asOf is not a date: ${JSON.stringify(asOf)}`);
  }
  const series = loadSeries(companyFacts, asOf);
  const cik = resolveCik(companyFacts);
  const gaps = [];

  const ncav = netCurrentAssetValue(series, cik, gaps);
  const metrics = {
    "financial.owner_earnings": ownerEarnings(series, cik, gaps, maintenanceCapexProxy),
    "financial.net_current_asset_value": ncav,
    "valuation.downside_asset_value": downsideAssetValue(series, cik, gaps),
    "valuation.downside_floor": downsideFloor(series, cik, gaps, ncav),
    "valuation.revenue_growth": revenueGrowth(companyFacts, series, cik, gaps, asOf),
    "financial.incremental_return_on_capital": incrementalReturnOnCapital(series, cik, gaps),
    "financial.leverage": leverage(series, cik, gaps),
    "capital_allocation.share_count": shareCount(series, cik, gaps),
  };
  return Object.freeze({
    cik,
    entity: companyFacts.entityName || null,
    as_of: asOf,
    tool_id: TOOL_ID,
    tool_version: TOOL_VERSION,
    metrics: Object.freeze(metrics),
    unavailable: Object.freeze(gaps),
  });
}

/**
 * Thin fetching wrapper: resolve the filer, pull Company Facts through the throttled and
 * User-Agent-bearing sec.mjs client, then hand the JSON to the pure function above.
 */
export async function fetchFundamentals({ cik, ticker, asOf = null, signal, maintenanceCapexProxy } = {}) {
  let resolved = cik;
  if (!resolved && ticker) {
    const wanted = String(ticker).trim().toUpperCase();
    const universe = await fetchUniverse({ signal });
    const hit = universe.find((row) => String(row.ticker).toUpperCase() === wanted);
    if (!hit) {
      throw invalidParams(
        `no US filer with ticker "${ticker}" in the SEC universe. `
        + "Non-US listings are absent from it; supply a cik instead.",
      );
    }
    resolved = hit.cik;
  }
  if (!resolved) throw invalidParams("fetchFundamentals needs a cik or a ticker");
  const companyFacts = await fetchCompanyFacts(resolved, { signal });
  const derived = deriveFundamentals({ companyFacts, asOf, ...(maintenanceCapexProxy ? { maintenanceCapexProxy } : {}) });
  return Object.freeze({ ticker: ticker || derived.entity, ...derived });
}
