import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR, LIMITS } from "./constants.mjs";
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
let nextAllowedCallAt = 0;
let throttleQueue = Promise.resolve();

/**
 * Serialize the limiter itself, not only each caller's delay.
 *
 * Promise.all previously let a whole ownership batch observe the same `lastCall`, sleep for
 * the same interval, then hit EDGAR together. That made an eight-document batch a burst even
 * though every individual request called `throttle()`. Chaining turns makes the 120 ms spacing
 * process-wide and removes the main source of the real Section 16 losses.
 */
async function throttle() {
  const turn = throttleQueue.then(async () => {
    const wait = nextAllowedCallAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    nextAllowedCallAt = Date.now() + MIN_INTERVAL_MS;
  });
  throttleQueue = turn.catch(() => {});
  return turn;
}

function filingCachePath(url, cacheDir = join(DATA_DIR, "cache", "sec-filings")) {
  const digest = createHash("sha256").update(url).digest("hex");
  return join(cacheDir, digest.slice(0, 2), `${digest}.txt`);
}

let cacheWriteSequence = 0;

function cachedFiling(url, cacheDir) {
  const path = filingCachePath(url, cacheDir);
  if (!existsSync(path)) return null;
  try {
    const size = statSync(path).size;
    if (size > MAX_FILING_DOCUMENT_TEXT_BYTES) {
      throw new Error(`cached SEC filing document exceeds the ${MAX_FILING_DOCUMENT_TEXT_BYTES}-byte text limit`);
    }
    const text = readFileSync(path, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_FILING_DOCUMENT_TEXT_BYTES) {
      throw new Error(`cached SEC filing document exceeds the ${MAX_FILING_DOCUMENT_TEXT_BYTES}-byte text limit`);
    }
    return text ? { url, text, cache_status: "hit", cache_path: path } : null;
  } catch (error) {
    // An oversized cache entry is not a miss. Treating it as one would hide a breached hard
    // limit behind a new network request while still having read untrusted bytes in other
    // processes. Corrupt or transiently unreadable small entries remain ordinary misses.
    if (/cached SEC filing document exceeds/u.test(String(error?.message || ""))) throw error;
    return null;
  }
}

function persistFiling(url, text, cacheDir) {
  if (typeof text !== "string" || !text) return null;
  const path = filingCachePath(url, cacheDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${cacheWriteSequence += 1}.tmp`;
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    // A concurrent request may have materialized the same immutable filing first. Keep the
    // successful cache entry; only surface errors when no usable final file exists.
    if (!existsSync(path)) throw error;
  }
  return path;
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
const MAX_FILING_DOCUMENT_TEXT_BYTES = 10_000_000;
const filingDocumentFlights = new Map();

function isRateLimited(status) {
  return status === 429 || status === 503;
}

function secAbortError(signal, fallback = "SEC request aborted") {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(fallback);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw secAbortError(signal);
}

async function abortableDelay(ms, signal) {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  throwIfAborted(signal);
  let timer;
  let onAbort;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(resolve, ms);
      onAbort = () => reject(secAbortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function withRateLimitRetry(attempt, { signal } = {}) {
  let lastError = null;
  for (let tries = 0; tries < RATE_LIMIT_ATTEMPTS; tries += 1) {
    throwIfAborted(signal);
    if (tries > 0) await abortableDelay(RATE_LIMIT_BACKOFF_MS * (2 ** (tries - 1)), signal);
    throwIfAborted(signal);
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
  }, { signal: upstreamSignal });
  return outcome.value;
}

const submissionsUrl = (paddedCik) => `https://data.sec.gov/submissions/CIK${paddedCik}.json`;

export function filingDocumentUrl(paddedCik, accession, primaryDocument) {
  if (!accession || !primaryDocument) return null;
  const registrant = String(paddedCik).replace(/^0+/u, "") || "0";
  const folder = String(accession).replace(/-/gu, "");
  const documentPath = String(primaryDocument).split("/").map(encodeURIComponent).join("/");
  return `https://www.sec.gov/Archives/edgar/data/${registrant}/${folder}/${documentPath}`;
}

/** Stable SEC filing-index URL for one accession. */
export function secFilingIndexUrl(cik, accession) {
  const registrant = String(cik || "").replace(/\D/gu, "").replace(/^0+/u, "") || "0";
  const canonicalAccession = String(accession || "").trim();
  if (!canonicalAccession) return null;
  const folder = canonicalAccession.replace(/-/gu, "");
  return `https://www.sec.gov/Archives/edgar/data/${registrant}/${folder}/${canonicalAccession}-index.html`;
}

/**
 * Resolve EDGAR's XSL-rendered XML alias to the machine-readable sibling document.
 *
 * The submissions feed commonly names Section 16 and ownership documents as
 * `xslF345X06/form4.xml`. That route is a rendered wrapper which browser/search tools may
 * refuse, while the actual filing bytes live beside it as `form4.xml`. HTML filings and
 * ordinary XML paths are returned unchanged.
 */
export function machineReadableFilingDocumentName(document) {
  const value = String(document || "").trim();
  return /\.xml$/iu.test(value) ? value.replace(/^xsl[^/]*\//iu, "") : value;
}

async function boundedResponseText(response, maxBytes = MAX_FILING_DOCUMENT_TEXT_BYTES) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`SEC filing document exceeds the ${maxBytes}-byte text limit`);
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.byteLength || 0;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`SEC filing document exceeds the ${maxBytes}-byte text limit`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new Error(`SEC filing document exceeds the ${maxBytes}-byte text limit`);
  }
  return text;
}

async function waitForFilingFlight(record, flightKey, signal) {
  if (signal?.aborted) throw secAbortError(signal, "SEC filing document wait aborted");
  record.waiters += 1;
  let onAbort;
  try {
    if (!signal) return await record.promise;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(secAbortError(signal, "SEC filing document wait aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([record.promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    record.waiters -= 1;
    if (!record.settled && record.waiters === 0) {
      // Once every caller has left, keeping the immutable download alive only creates an
      // orphan which can consume the process-wide SEC throttle after its run was cancelled.
      record.controller.abort(new Error("SEC filing document request aborted after all callers left"));
      if (filingDocumentFlights.get(flightKey) === record) filingDocumentFlights.delete(flightKey);
    }
  }
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
export async function fetchFilingDocument(cik, accession, document, {
  signal,
  cache = true,
  cacheDir = join(DATA_DIR, "cache", "sec-filings"),
} = {}) {
  throwIfAborted(signal);
  const stripped = String(cik).replace(/\D/gu, "").replace(/^0+/u, "");
  const folder = String(accession).replace(/-/gu, "");
  const resolvedDocument = machineReadableFilingDocumentName(document);
  const url = `https://www.sec.gov/Archives/edgar/data/${stripped}/${folder}/${resolvedDocument}`;
  if (cache) {
    const hit = cachedFiling(url, cacheDir);
    if (hit) return hit;
  }
  // Grounding and the ownership adapter may ask for the same immutable Form 4 concurrently.
  // Share that one SEC request instead of turning a fast evidence path into a duplicate burst.
  const flightKey = `${url}\0${cache ? cacheDir : "no-cache"}`;
  const existing = filingDocumentFlights.get(flightKey);
  if (existing) return waitForFilingFlight(existing, flightKey, signal);
  const controller = new AbortController();
  const record = {
    controller,
    promise: null,
    settled: false,
    waiters: 0,
  };
  record.promise = withRateLimitRetry(async () => {
    await throttle();
    // The shared immutable download owns its bounded transport timeout. A short-lived caller
    // may stop waiting without aborting another caller that joined the same flight.
    throwIfAborted(controller.signal);
    const abort = linkedAbort(LIMITS.QUOTE_FETCH_MS * 2, controller.signal);
    try {
      const res = await fetch(url, { signal: abort.signal, headers: { "User-Agent": UA } });
      if (isRateLimited(res.status)) {
        return { rateLimited: true, error: new Error(`HTTP ${res.status} for ${url}`) };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await boundedResponseText(res);
      const cachePath = cache ? persistFiling(url, text, cacheDir) : null;
      return {
        rateLimited: false,
        value: {
          url,
          text,
          cache_status: cache ? "miss" : "disabled",
          ...(cachePath ? { cache_path: cachePath } : {}),
        },
      };
    } finally {
      abort.cleanup();
    }
  }, { signal: controller.signal }).then((outcome) => outcome.value);
  filingDocumentFlights.set(flightKey, record);
  void record.promise.finally(() => {
    record.settled = true;
    if (filingDocumentFlights.get(flightKey) === record) filingDocumentFlights.delete(flightKey);
  }).catch(() => {});
  return waitForFilingFlight(record, flightKey, signal);
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
  // An instant share-count endpoint must never be backfilled with a duration-weighted average.
  // The dilution screen fails closed when the filer does not publish this point-in-time tag.
  sharesOutstanding: ["CommonStockSharesOutstanding"],
};

export const secUserAgent = () => UA;

/** Company metadata including SIC industry classification. Keyless. */
export async function fetchSubmissions(cik, { signal } = {}) {
  const padded = String(cik).replace(/\D/g, "").padStart(10, "0");
  if (padded.length !== 10) throw invalidParams(`invalid CIK: ${cik}`);
  const data = await secJson(submissionsUrl(padded), LIMITS.QUOTE_FETCH_MS * 2, signal);
  return parseSubmissionProfile(data, padded);
}
