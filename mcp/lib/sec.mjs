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

/**
 * SEC answers 429 when a client outruns its guidance, and the throttle above only paces a
 * single process -- a second one, or a burst of look-through fetches, still crosses the line.
 * Without a backoff the whole evidence chain for a run collapses on one rate-limited response,
 * which is indistinguishable in the report from the data not existing.
 *
 * Deliberately short and bounded: three attempts over about a second and a half. A caller that
 * is genuinely over budget should fail fast and be told, not stall a research run.
 */
const RATE_LIMIT_ATTEMPTS = 3;
const RATE_LIMIT_BACKOFF_MS = 400;

function isRateLimited(status) {
  return status === 429 || status === 503;
}

async function withRateLimitRetry(attempt) {
  let lastError = null;
  for (let tries = 0; tries < RATE_LIMIT_ATTEMPTS; tries += 1) {
    if (tries > 0) await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS * (2 ** (tries - 1))));
    const outcome = await attempt();
    if (!outcome.rateLimited) return outcome;
    lastError = outcome.error;
  }
  throw lastError;
}

async function secJson(url, timeoutMs = LIMITS.QUOTE_FETCH_MS * 2, upstreamSignal) {
  const outcome = await withRateLimitRetry(async () => {
    await throttle();
    const abort = linkedAbort(timeoutMs, upstreamSignal);
    try {
      const res = await fetch(url, {
        signal: abort.signal,
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (isRateLimited(res.status)) {
        return { rateLimited: true, error: new Error(`HTTP ${res.status} for ${url}`) };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      if (text.trimStart().startsWith("<")) throw new Error(`SEC returned HTML rather than JSON for ${url} (rate limited or blocked)`);
      return { rateLimited: false, value: JSON.parse(text) };
    } finally {
      abort.cleanup();
    }
  });
  return outcome.value;
}

const submissionsUrl = (paddedCik) => `https://data.sec.gov/submissions/CIK${paddedCik}.json`;

function filingDocumentUrl(paddedCik, accession, primaryDocument) {
  if (!accession || !primaryDocument) return null;
  const registrant = String(paddedCik).replace(/^0+/u, "") || "0";
  const folder = String(accession).replace(/-/gu, "");
  const documentPath = String(primaryDocument).split("/").map(encodeURIComponent).join("/");
  return `https://www.sec.gov/Archives/edgar/data/${registrant}/${folder}/${documentPath}`;
}

/**
 * Preserve the SEC submissions recent feed as dated, directly fetchable records.
 *
 * The old profile adapter discarded `filings.recent` entirely.  A worker therefore knew the
 * issuer's SIC but still had to infer the latest filing from search results, which lagged the
 * live submissions feed in the production audit.  Keep a bounded newest-first slice plus the exact
 * feed URL so a negative "no later filing" claim can be checked against the authoritative
 * index rather than a search-engine cache.
 */
export function parseSubmissionProfile(data, cik, { retrievedAt = new Date().toISOString(), limit = 40 } = {}) {
  const padded = String(cik).replace(/\D/gu, "").padStart(10, "0");
  if (padded.length !== 10) throw invalidParams(`invalid CIK: ${cik}`);
  const recent = data?.filings?.recent || {};
  const rows = (recent.form || []).map((form, index) => {
    const accession = recent.accessionNumber?.[index] || null;
    const primaryDocument = recent.primaryDocument?.[index] || null;
    return {
      form,
      accession,
      primary_document: primaryDocument,
      filing_date: recent.filingDate?.[index] || null,
      report_date: recent.reportDate?.[index] || null,
      accepted_at: recent.acceptanceDateTime?.[index] || null,
      primary_document_url: filingDocumentUrl(padded, accession, primaryDocument),
    };
  }).filter((row) => row.accession && row.primary_document)
    .sort((a, b) => Date.parse(b.accepted_at || b.filing_date || 0) - Date.parse(a.accepted_at || a.filing_date || 0));
  const recentFilings = rows.slice(0, Math.max(0, limit));
  const sourceUrl = submissionsUrl(padded);
  return {
    cik: padded,
    name: data?.name || null,
    tickers: data?.tickers || [],
    exchanges: data?.exchanges || [],
    sic: data?.sic || null,
    sic_description: data?.sicDescription || null,
    state_of_incorporation: data?.stateOfIncorporation || null,
    fiscal_year_end: data?.fiscalYearEnd || null,
    website: data?.website || null,
    investor_website: data?.investorWebsite || null,
    submissions_url: sourceUrl,
    submissions_retrieved_at: retrievedAt,
    recent_filings_count: Array.isArray(recent.form) ? recent.form.length : 0,
    latest_filing: recentFilings[0] || null,
    recent_filings: recentFilings,
  };
}

/** Raw filing index for one registrant. Callers that need form types read this, not `fetchSubmissions`. */
export async function fetchFilingIndex(cik, { signal } = {}) {
  const padded = String(cik).replace(/\D/gu, "").padStart(10, "0");
  if (padded.length !== 10) throw invalidParams(`invalid CIK: ${cik}`);
  const sourceUrl = submissionsUrl(padded);
  const data = await secJson(sourceUrl, LIMITS.QUOTE_FETCH_MS * 2, signal);
  const profile = parseSubmissionProfile(data, padded, { limit: Number.MAX_SAFE_INTEGER });
  return {
    cik: padded,
    name: profile.name,
    submissions_url: sourceUrl,
    submissions_retrieved_at: profile.submissions_retrieved_at,
    latest_filing: profile.latest_filing,
    filings: profile.recent_filings,
  };
}

/**
 * One filing document, fetched as text. Same throttle, User-Agent and 429 backoff as the JSON
 * calls.
 *
 * The backoff was the part missing here. Every JSON endpoint retried a rate-limited response
 * while this one threw on the first 429, so the documents that carry the actual disclosure --
 * a Form 4's transaction table, an 8-K's item text -- were the easiest evidence in the run to
 * lose. `www.sec.gov/Archives` is also throttled harder than `data.sec.gov`, which makes this
 * the path most likely to be limited and was the least protected against it.
 */
export async function fetchFilingDocument(cik, accession, document, { signal } = {}) {
  const stripped = String(cik).replace(/\D/gu, "").replace(/^0+/u, "");
  const folder = String(accession).replace(/-/gu, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${stripped}/${folder}/${document}`;
  const outcome = await withRateLimitRetry(async () => {
    await throttle();
    const abort = linkedAbort(LIMITS.QUOTE_FETCH_MS * 2, signal);
    try {
      const res = await fetch(url, { signal: abort.signal, headers: { "User-Agent": UA } });
      if (isRateLimited(res.status)) {
        return { rateLimited: true, error: new Error(`HTTP ${res.status} for ${url}`) };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return { rateLimited: false, value: { url, text: await res.text() } };
    } finally {
      abort.cleanup();
    }
  });
  return outcome.value;
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
  // Most filers never tag GrossProfit -- ten of fifteen large caps tested do not -- and report
  // revenue and cost of revenue separately instead. The margin is derived from those when the
  // direct tag is absent, which is arithmetic the filer already published rather than an
  // estimate. Without this, a gross-margin rule was unavailable for two thirds of the market
  // and every seat that reads it fell silent.
  costOfRevenue: [
    "CostOfGoodsAndServicesSold",
    "CostOfRevenue",
    "CostOfGoodsSold",
    "CostOfServices",
    "CostOfGoodsAndServicesSoldExcludingDepreciationDepletionAndAmortization",
  ],
  operatingIncome: ["OperatingIncomeLoss", "OperatingIncomeLossIncludingEquityMethodInvestments"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
  // Capital expenditure has no single tag in practice. Corning files PaymentsForCapitalImprovements
  // and nothing this list previously contained, which alone removed owner earnings -- and with
  // it Buffett and Ackman -- for every issuer that tags it that way.
  capex: [
    "PaymentsToAcquirePropertyPlantAndEquipment",
    "PaymentsToAcquireProductiveAssets",
    "PaymentsForCapitalImprovements",
    "PaymentsForProceedsFromProductiveAssets",
    "PaymentsToAcquireOtherPropertyPlantAndEquipment",
    "PaymentsToAcquireMachineryAndEquipment",
  ],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  assets: ["Assets"],
  interestExpense: [
    "InterestExpense",
    "InterestIncomeExpenseNet",
    "InterestExpenseDebt",
    "InterestExpenseNonoperating",
    "InterestAndDebtExpense",
    "InterestIncomeExpenseNonoperatingNet",
    "InterestExpenseBorrowings",
  ],
  sharesOutstanding: ["CommonStockSharesOutstanding", "WeightedAverageNumberOfDilutedSharesOutstanding"],
};

export const secUserAgent = () => UA;

/** Company metadata including SIC industry classification. Keyless. */
export async function fetchSubmissions(cik, { signal } = {}) {
  const padded = String(cik).replace(/\D/g, "").padStart(10, "0");
  if (padded.length !== 10) throw invalidParams(`invalid CIK: ${cik}`);
  const data = await secJson(submissionsUrl(padded), LIMITS.QUOTE_FETCH_MS * 2, signal);
  return parseSubmissionProfile(data, padded);
}
