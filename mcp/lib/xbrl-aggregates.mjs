/**
 * Fiscal-year aggregates assembled from an aligned XBRL series.
 *
 * These answer "what does this filer report for year N", not "is that good". Debt is summed
 * from non-overlapping buckets and names the ones a filer omits; tangible book deducts what
 * is tagged and records the reading when a concept is absent from the whole document; the
 * trailing-four-quarters window checks its own seams. Each returns null rather than zero when
 * the filings do not support the figure -- a company with unknown debt is not a debt-free one.
 */

import {
  DEBT_BUCKETS,
  FUNDAMENTAL_CONCEPTS,
  alignYear,
  daysBetween,
  decimal,
  fiscalYearOf,
  gap,
} from "./xbrl-series.mjs";

const sum = (values) => values.reduce((total, value) => total + value, 0);
const finite = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * Both endpoints on one profit basis. Pairing a NOPAT endpoint with a net-income endpoint
 * would difference two different quantities and call the result a return.
 */
/** Four contiguous quarters ending at `index`, or null when a quarter is missing or overlaps. */
/**
 * Profit for the incremental-return window: NOPAT when the tax inputs exist, otherwise net
 * income -- and the basis is named in the output rather than left for the reader to guess.
 */
/**
 * Tangible book value: equity less goodwill and intangibles.
 *
 * A filer with goodwill on its balance sheet must tag it, so a concept absent from every
 * period of the document is evidence of nil rather than a data gap -- and that reading is
 * still written into `assumptions`. A concept reported in other years but not this one is
 * treated as a genuine misalignment and refuses to compute.
 */
/**
 * Total debt for one fiscal year.
 *
 * A single combined tag wins outright. Otherwise the three non-overlapping buckets are summed
 * and the ones a filer does not report are named in `missing_buckets` rather than assumed
 * away silently. No bucket at all is null, never zero: a company with unknown debt is not a
 * debt-free company.
 */
export function totalDebtForYear(series, fiscalYear) {
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

export function tangibleBookForYear(series, fiscalYear) {
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

export function profitForYear(series, fiscalYear) {
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

export function fourQuarters(quarters, index) {
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

export function matchedProfits(series, startYear, endYear) {
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

export function investedCapital(series, fiscalYear) {
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

export function ebitdaForYear(series, fiscalYear) {
  const alignment = alignYear(series, ["operating_income", "depreciation_amortisation"], fiscalYear);
  if (!alignment.ok) return null;
  return {
    value: alignment.entries.operating_income.value + alignment.entries.depreciation_amortisation.value,
    entries: alignment.used,
  };
}
