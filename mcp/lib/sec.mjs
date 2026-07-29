import { LIMITS } from "./constants.mjs";
import { invalidParams } from "./errors.mjs";
import { linkedAbort } from "./abort.mjs";

/**
 * Keyless SEC client.
 *
 * SEC requires a descriptive User-Agent with a contact and rate-limits to ~10 req/s.
 * Everything here comes from filings, so a figure is what the company actually reported,
 * not a vendor's adjusted version of it.
 *
 * The field that matters most is `filed`. A fiscal year ending 2024-09-28 was not public
 * until 2024-11-01, so anything that reasons "as of" a date must filter on `filed`, not
 * on the period end. Getting this wrong is the single easiest way to build a screen or a
 * backtest that looks brilliant and is measuring the future.
 */
// SEC's User-Agent rules are stricter than the published guidance and were established
// by testing, not by reading: it wants `Name/version (email)`, and it returns 403 with an
// HTML body when the contact contains a URL or a domain it associates with crawlers --
// including a github.com noreply address. Anyone running this at volume should set
// ALPHACOUNCIL_SEC_USER_AGENT to a real contact of their own.
const UA = process.env.ALPHACOUNCIL_SEC_USER_AGENT
  || "AlphaCouncil-Agent/0.4 (alphacouncil@runbox.com)";

const MIN_INTERVAL_MS = 120; // stay under SEC's ~10 req/s guidance
let lastCall = 0;

async function throttle() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function secJson(url, timeoutMs = LIMITS.QUOTE_FETCH_MS * 2, upstreamSignal) {
  await throttle();
  const abort = linkedAbort(timeoutMs, upstreamSignal);
  try {
    const res = await fetch(url, {
      signal: abort.signal,
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    if (text.trimStart().startsWith("<")) throw new Error(`SEC returned HTML rather than JSON for ${url} (rate limited or blocked)`);
    return JSON.parse(text);
  } finally {
    abort.cleanup();
  }
}

/** Raw filing index for one registrant. Callers that need form types read this, not `fetchSubmissions`. */
export async function fetchFilingIndex(cik, { signal } = {}) {
  const padded = String(cik).replace(/\D/gu, "").padStart(10, "0");
  if (padded.length !== 10) throw invalidParams(`invalid CIK: ${cik}`);
  const data = await secJson(`https://data.sec.gov/submissions/CIK${padded}.json`, LIMITS.QUOTE_FETCH_MS * 2, signal);
  const recent = data?.filings?.recent || {};
  const rows = (recent.form || []).map((form, index) => ({
    form,
    accession: recent.accessionNumber?.[index] || null,
    primary_document: recent.primaryDocument?.[index] || null,
    filing_date: recent.filingDate?.[index] || null,
    report_date: recent.reportDate?.[index] || null,
  })).filter((row) => row.accession && row.primary_document);
  return { cik: padded, name: data?.name || null, filings: rows };
}

/** One filing document, fetched as text. Same throttle and User-Agent as every other call. */
export async function fetchFilingDocument(cik, accession, document, { signal } = {}) {
  await throttle();
  const stripped = String(cik).replace(/\D/gu, "").replace(/^0+/u, "");
  const folder = String(accession).replace(/-/gu, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${stripped}/${folder}/${document}`;
  const abort = linkedAbort(LIMITS.QUOTE_FETCH_MS * 2, signal);
  try {
    const res = await fetch(url, { signal: abort.signal, headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return { url, text: await res.text() };
  } finally {
    abort.cleanup();
  }
}

/** The full US listed universe: ~10k entries of {cik, ticker, title}. */
export async function fetchUniverse({ signal } = {}) {
  const raw = await secJson("https://www.sec.gov/files/company_tickers.json", LIMITS.QUOTE_FETCH_MS * 2, signal);
  return Object.values(raw).map((row) => ({
    cik: String(row.cik_str).padStart(10, "0"),
    ticker: row.ticker,
    title: row.title,
  }));
}

export async function fetchCompanyFacts(cik, { signal } = {}) {
  const padded = String(cik).replace(/\D/g, "").padStart(10, "0");
  if (padded.length !== 10) throw invalidParams(`invalid CIK: ${cik}`);
  return secJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`, LIMITS.QUOTE_FETCH_MS * 2, signal);
}

/**
 * Annual series for a concept, newest last, filtered to what was public by `asOf`.
 *
 * Tries several tags because the same economic quantity has different names depending on
 * when and under which taxonomy a company filed.
 */
/**
 * How long a reported period is, in days. Instant facts (balance-sheet items) have no start.
 */
const spanDays = (entry) =>
  entry.start ? Math.round((Date.parse(entry.end) - Date.parse(entry.start)) / 86400000) : null;

/**
 * Is this entry an annual figure?
 *
 * A 10-K carries quarterly and stub periods alongside the annual ones. Keying only on the
 * end date treated each as its own year: Lumentum's 2015 produced ten "years" from one
 * fiscal year -- nine quarters and stubs plus the real 363-day period. Every multi-year rule
 * then averaged quarterly income against annual equity, silently.
 *
 * Fiscal years run 52 or 53 weeks, so the window has to be wider than 365 exactly.
 */
const ANNUAL_MIN_DAYS = 300;
const ANNUAL_MAX_DAYS = 400;
const isAnnual = (entry) => {
  const days = spanDays(entry);
  // Instant facts have no duration: shares outstanding, equity, total assets.
  if (days === null) return true;
  return days >= ANNUAL_MIN_DAYS && days <= ANNUAL_MAX_DAYS;
};

/** The fiscal year a period belongs to, taken from its end date. */
const fiscalYear = (entry) => Number(String(entry.end).slice(0, 4));

/**
 * Annual history for a concept, merged across every alias.
 *
 * Merging matters as much as the annual filter. The function used to return at the first
 * alias with any data, and revenue moved to RevenueFromContractWithCustomerExcludingAssessedTax
 * when ASC 606 was adopted -- so a company reporting under the new tag since 2022 looked like
 * it had four years of history, which then fired a "listed under ten years" exemption on a
 * company that had been public for a decade.
 *
 * Aliases are ordered by preference, so an earlier alias wins where both cover a year.
 */
export function annualSeries(facts, tags, { asOf = null, unit = "USD" } = {}) {
  const cutoff = asOf ? new Date(asOf).getTime() : null;
  const byYear = new Map();
  let usedTags = [];

  for (const tag of tags) {
    const entries = facts?.facts?.["us-gaap"]?.[tag]?.units?.[unit];
    if (!Array.isArray(entries) || entries.length === 0) continue;
    let contributed = false;

    for (const entry of entries) {
      if (entry.form !== "10-K" || !entry.end || !Number.isFinite(entry.val)) continue;
      if (!isAnnual(entry)) continue;
      // Look-ahead guard: a filing is only usable once it was actually filed.
      if (cutoff && new Date(entry.filed).getTime() > cutoff) continue;

      const year = fiscalYear(entry);
      const prior = byYear.get(year);
      if (!prior) {
        byYear.set(year, { ...entry, tag });
        contributed = true;
        continue;
      }
      // An earlier alias always wins the year; within one alias, the latest filing wins,
      // because a restatement supersedes what it restates.
      if (prior.tag === tag && new Date(entry.filed) > new Date(prior.filed)) {
        byYear.set(year, { ...entry, tag });
      }
    }
    if (contributed) usedTags.push(tag);
  }

  if (byYear.size === 0) return null;
  const series = [...byYear.values()].sort((a, b) => new Date(a.end) - new Date(b.end));
  return { tag: usedTags[0], tags: usedTags, unit, series };
}

/** Concept aliases, ordered by preference. */
export const CONCEPTS = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
  ],
  netIncome: ["NetIncomeLoss", "ProfitLoss"],
  grossProfit: ["GrossProfit"],
  operatingIncome: ["OperatingIncomeLoss"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  assets: ["Assets"],
  interestExpense: ["InterestExpense", "InterestIncomeExpenseNet", "InterestExpenseDebt"],
  sharesOutstanding: ["CommonStockSharesOutstanding", "WeightedAverageNumberOfDilutedSharesOutstanding"],
};

export const secUserAgent = () => UA;

/** Company metadata including SIC industry classification. Keyless. */
export async function fetchSubmissions(cik, { signal } = {}) {
  const padded = String(cik).replace(/\D/g, "").padStart(10, "0");
  if (padded.length !== 10) throw invalidParams(`invalid CIK: ${cik}`);
  const data = await secJson(`https://data.sec.gov/submissions/CIK${padded}.json`, LIMITS.QUOTE_FETCH_MS * 2, signal);
  return {
    cik: padded,
    name: data.name,
    tickers: data.tickers || [],
    exchanges: data.exchanges || [],
    sic: data.sic || null,
    sic_description: data.sicDescription || null,
    state_of_incorporation: data.stateOfIncorporation || null,
    fiscal_year_end: data.fiscalYearEnd || null,
  };
}
