import { createHash } from "node:crypto";
import { internalError, invalidParams } from "./errors.mjs";
import { OPERATING_COMPANY_COVERAGE, requiresOperatingCompanyDossier } from "./company-dossier.mjs";
import { applyRecencyGate, filingsFeed, parseFeed, queryNewsFeed, tickerNewsFeed } from "./feeds.mjs";
import { marketFor } from "./markets.mjs";
import {
  PublicHttpError,
  isReservedHttpHostname,
  normalizePublicHttpUrl,
  retrievePublicHttpText,
} from "./public-http.mjs";
import { fetchQuote } from "./quotes.mjs";
import {
  fetchFilingDocument,
  fetchFilingIndex,
  fetchSubmissions,
  fetchUniverse,
  secUserAgent,
} from "./sec.mjs";

export const COMPANY_SOURCE_ACQUISITION_POLICY_ID = "company_source_acquisition_v1";

export const COMPANY_DATA_OUTCOMES = Object.freeze([
  "reported_actual",
  "recomputed_proxy",
  "modeled_estimate",
  "unavailable",
  "not_applicable",
]);

export const SOURCE_ATTEMPT_RESULTS = Object.freeze([
  "succeeded",
  "not_found",
  "not_disclosed",
  "unreachable",
  "blocked",
  "not_applicable",
]);

const OUTCOMES = new Set(COMPANY_DATA_OUTCOMES);
const ATTEMPT_RESULTS = new Set(SOURCE_ATTEMPT_RESULTS);
const MAX_OFFICIAL_DETAIL_PAGES = 10;
const MAX_OFFICIAL_LEAD_PAGES = 6;
const MAX_STARTER_NEWS_ITEMS = 80;
const MIN_STARTER_NEWS_ITEMS_PER_TOPIC = 6;
const MAX_SOURCE_BODY_BYTES = 1_500_000;
const GENERIC_IDENTITY_WORDS = new Set([
  "and", "company", "corporation", "corp", "inc", "incorporated", "limited", "ltd",
  "holdings", "holding", "group", "plc", "class", "common", "stock", "the",
]);
const EXCLUDED_DISCOVERY_SITES = new Set([
  "facebook.com", "instagram.com", "linkedin.com", "tiktok.com", "x.com", "twitter.com",
  "youtube.com", "youtu.be", "sec.gov", "w3.org", "xbrl.org", "fasb.org",
]);
const MARKET_SOURCE_ROUTES = Object.freeze({
  US: Object.freeze({
    regulator_entry: "https://www.sec.gov/edgar/search/",
    regulator_domains: ["sec.gov"],
    market_domains: ["nasdaqtrader.com", "cboe.com", "finra.org", "nyse.com"],
  }),
  TW: Object.freeze({
    regulator_entry: "https://mops.twse.com.tw/mops/web/index",
    regulator_domains: ["mops.twse.com.tw", "twse.com.tw"],
    market_domains: ["twse.com.tw", "tpex.org.tw"],
  }),
  KR: Object.freeze({
    regulator_entry: "https://englishdart.fss.or.kr/",
    regulator_domains: ["dart.fss.or.kr", "fss.or.kr"],
    market_domains: ["global.krx.co.kr", "data.krx.co.kr"],
  }),
  JP: Object.freeze({
    regulator_entry: "https://disclosure2.edinet-fsa.go.jp/",
    regulator_domains: ["edinet-fsa.go.jp", "fsa.go.jp"],
    market_domains: ["jpx.co.jp"],
  }),
  HK: Object.freeze({
    regulator_entry: "https://www1.hkexnews.hk/search/titlesearch.xhtml?lang=en",
    regulator_domains: ["hkexnews.hk", "sfc.hk"],
    market_domains: ["hkex.com.hk"],
  }),
  CN: Object.freeze({
    regulator_entry: "https://www.cninfo.com.cn/new/index",
    regulator_domains: ["cninfo.com.cn", "csrc.gov.cn"],
    market_domains: ["sse.com.cn", "szse.cn"],
  }),
});
const OFFICIAL_SUCCESS_STAGES = new Set([
  "regulator_filing",
  "issuer_ir",
  "issuer_product_docs",
  "market_official",
  "customer_official",
  "supplier_official",
  "competitor_official",
  "other_regulator",
  "court_record",
  "peer_filing",
  "ownership_filing",
  "counterparty_official",
]);

const GENERIC_STAGES = Object.freeze({
  market: ["market_official", "issuer_ir", "local_observation"],
  financials: ["regulator_filing", "issuer_ir", "derived_proxy"],
  expectations: ["issuer_ir", "public_consensus", "local_observation", "derived_proxy"],
  quant: ["market_official", "local_observation", "derived_proxy"],
  valuation: ["regulator_filing", "market_official", "peer_filing", "derived_proxy"],
  news: ["regulator_filing", "issuer_ir", "disconfirming_search"],
  ownership: ["regulator_filing", "ownership_filing", "issuer_ir", "derived_proxy"],
  events: ["regulator_filing", "issuer_ir", "counterparty_official"],
});

const SPECIFIC_STAGES = Object.freeze({
  "financials.cash_flow_capex": ["regulator_filing", "issuer_ir", "derived_proxy"],
  "financials.customer_supplier_concentration": [
    "regulator_filing", "issuer_ir", "customer_official", "supplier_official", "derived_proxy",
  ],
  "financials.guidance": ["issuer_ir", "regulator_filing", "customer_official", "disconfirming_search"],
  "financials.earnings_call_qna": [
    "issuer_ir", "regulator_filing", "public_market_data", "disconfirming_search",
  ],
  "expectations.consensus_revenue_eps": [
    "issuer_ir", "public_consensus", "local_observation", "disconfirming_search",
  ],
  "expectations.estimate_dispersion_revisions": [
    "public_consensus", "local_observation", "issuer_ir", "disconfirming_search", "derived_proxy",
  ],
  "expectations.ratings_target_changes": [
    "public_consensus", "local_observation", "issuer_ir", "disconfirming_search",
  ],
  "expectations.next_reporting_date": [
    "issuer_ir", "public_consensus", "local_observation",
  ],
  "quant.short_interest_borrow": [
    "market_official", "local_observation", "public_market_data", "disconfirming_search", "derived_proxy",
  ],
  "quant.options_iv_skew_expected_move": [
    "market_official", "local_observation", "derived_proxy",
  ],
  "news.issuer_ir_newsroom": ["issuer_ir", "issuer_product_docs", "regulator_filing"],
  "news.industry_competition": [
    "competitor_official", "customer_official", "supplier_official", "disconfirming_search",
  ],
  "news.customers_suppliers_partners": [
    "customer_official", "supplier_official", "issuer_ir", "regulator_filing", "derived_proxy",
  ],
  "news.regulation_litigation": [
    "other_regulator", "court_record", "regulator_filing", "issuer_ir", "disconfirming_search",
  ],
  "news.disconfirming_search": [
    "disconfirming_search", "competitor_official", "customer_official", "other_regulator",
  ],
  "ownership.insider_transactions": ["ownership_filing", "regulator_filing", "issuer_ir"],
  "ownership.ownership_control": ["ownership_filing", "regulator_filing", "issuer_ir"],
  "events.mna_strategic_transactions": [
    "regulator_filing", "counterparty_official", "other_regulator", "court_record",
  ],
  "events.material_contracts_commitments": [
    "regulator_filing", "issuer_ir", "counterparty_official", "customer_official", "derived_proxy",
  ],
});

// Public, cited market-data pages are useful direct observations, but they are neither an
// exchange/regulator surface nor a derivation step. Keep that distinction explicit so a
// worker cannot promote StockAnalysis/Yahoo-style pages to `market_official`, while still
// retaining the source as an auditable supplement after the frozen terminal ladder ran.
const SUPPLEMENTAL_ACQUISITION_STAGES = new Set(["public_market_data"]);
const ACQUISITION_STAGE_ALIASES = new Map([
  ["market_data_provider", "public_market_data"],
  ["market_data", "public_market_data"],
]);
const KNOWN_ACQUISITION_STAGES = new Set([
  ...Object.values(GENERIC_STAGES).flat(),
  ...Object.values(SPECIFIC_STAGES).flat(),
  ...SUPPLEMENTAL_ACQUISITION_STAGES,
]);
const DIRECT_OBSERVATION_PREFIXES = new Set(["market", "expectations", "quant"]);
const PUBLIC_MARKET_DATA_PREFIXES = new Set(["market", "quant"]);
// A speaker-labelled public earnings-call transcript is a permitted direct observation only
// for the dedicated Q&A coverage row, after the issuer and regulator ladder has been attempted.
// Do not widen this to all financial fields: a secondary transcript cannot replace filings.
const PUBLIC_DIRECT_OBSERVATION_COVERAGE_IDS = new Set(["financials.earnings_call_qna"]);
const DERIVATION_SUCCESS_STAGES = new Set(["derived_proxy", "local_observation"]);

const RECOVERY_RECIPES = Object.freeze({
  "financials.cash_flow_capex": {
    mode: "recomputed_proxy",
    formula: "rolling_free_cash_flow = operating_cash_flow - cash_capex; also show working-capital delta and margin",
    inputs: ["operating cash flow", "cash capital expenditure", "revenue", "working-capital change"],
  },
  "financials.customer_supplier_concentration": {
    mode: "modeled_estimate",
    formula: "bound exposure from disclosed customer shares, commitments, customer capex and supplier commentary; never identify an anonymous customer as fact",
    inputs: ["issuer concentration disclosure", "customer capex", "commitments", "supplier disclosures"],
  },
  "expectations.consensus_revenue_eps": {
    mode: "modeled_estimate",
    formula: "use a clearly labelled public-sample range plus issuer guidance; never call an incomplete sample full consensus",
    inputs: ["dated public analyst estimates", "issuer guidance", "estimate sample count"],
  },
  "expectations.estimate_dispersion_revisions": {
    mode: "recomputed_proxy",
    formula: "compare like-for-like locally saved estimate snapshots; report sample count and dates",
    inputs: ["current estimate snapshot", "prior like-for-like snapshots"],
  },
  "expectations.next_reporting_date": {
    mode: "reported_actual",
    formula: "record an issuer-confirmed date when available; otherwise record the actually observed public-calendar estimate and label it not issuer-confirmed",
    inputs: ["issuer event calendar", "dated public earnings calendar observation"],
  },
  "quant.short_interest_borrow": {
    mode: "modeled_estimate",
    formula: "keep reported short interest separate; borrow pressure proxy may combine utilisation, availability and public fee observations",
    inputs: ["reported short interest", "public borrow observations", "float", "volume"],
  },
  "quant.options_iv_skew_expected_move": {
    mode: "recomputed_proxy",
    formula: "recompute IV/skew/expected move from a dated option snapshot and rank only against saved like-for-like history",
    inputs: ["option prices", "spot", "expiry", "rates/dividends assumptions", "local IV observations"],
  },
  "news.customers_suppliers_partners": {
    mode: "modeled_estimate",
    formula: "triangulate a range from issuer, customer and supplier disclosures; keep actual vendor allocation null unless disclosed",
    inputs: ["issuer disclosure", "customer disclosure", "supplier disclosure", "dated product evidence"],
  },
  "events.material_contracts_commitments": {
    mode: "modeled_estimate",
    formula: "separate reported commitments from disclosed prepayments/orders; scenario-test the uncovered portion",
    inputs: ["commitments", "contract liabilities", "customer deposits/prepayments", "binding order disclosures"],
  },
});

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function safeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const normalized = normalizePublicHttpUrl(value);
    if (isReservedHttpHostname(new URL(normalized).hostname)) return null;
    return normalized;
  } catch {
    return null;
  }
}

function pinnedResponse(result) {
  return {
    ok: result.status >= 200 && result.status <= 299,
    status: result.status,
    url: result.final_url,
    headers: {
      get(name) {
        const value = result.headers?.[String(name).toLowerCase()];
        if (Array.isArray(value)) return value.length ? String(value[0]) : null;
        return value === undefined ? null : String(value);
      },
    },
    text: async () => result.text,
  };
}

async function requestPublicText(url, {
  fetchImpl,
  headers,
  lookupImpl,
  maxRedirects = 5,
  redirectPolicy,
  requestImpl,
  signal,
  timeoutMs,
}) {
  // Existing unit and integration fixtures inject a Response-shaped fetch function. The
  // production path deliberately does not default to global fetch: it uses the pinned
  // node:http/node:https transport below. Injected fetches receive manual redirects so
  // tests cannot accidentally assert the insecure production behavior.
  if (fetchImpl) {
    return fetchImpl(url, {
      signal,
      headers,
      redirect: "manual",
    });
  }
  return pinnedResponse(await retrievePublicHttpText(url, {
    headers,
    lookupImpl,
    maxBytes: MAX_SOURCE_BODY_BYTES,
    maxRedirects,
    redirectPolicy,
    requestImpl,
    signal,
    timeoutMs,
  }));
}

function baseSite(host) {
  const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
  const secondLevel = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);
  const count = parts.at(-1)?.length === 2 && secondLevel.has(parts.at(-2)) ? 3 : 2;
  return parts.length >= count ? parts.slice(-count).join(".") : parts.join(".");
}

function sameOfficialSite(left, right) {
  const a = safeUrl(left);
  const b = safeUrl(right);
  if (!a || !b) return false;
  return baseSite(new URL(a).hostname) === baseSite(new URL(b).hostname);
}

function visibleDomainCandidates(html) {
  const visible = decodeHtml(html);
  const pattern = /\b(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[a-z0-9._~:/?#[\]@!$&'()*+,;=%-]*)?/giu;
  const found = new Map();
  let match;
  while ((match = pattern.exec(visible))) {
    const trimmed = String(match[0]).replace(/[),.;:]+$/gu, "");
    const parsedUrl = safeUrl(/^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
    let url = parsedUrl;
    if (url && new URL(url).protocol === "http:") {
      const secure = new URL(url);
      secure.protocol = "https:";
      url = safeUrl(secure.href);
    }
    if (!url || found.has(url)) continue;
    const prefix = visible.slice(Math.max(0, match.index - 180), match.index);
    found.set(url, {
      context: visible.slice(Math.max(0, match.index - 180), match.index + match[0].length + 180),
      prefix,
    });
  }
  return [...found].map(([url, detail]) => ({ url, ...detail }));
}

function identityTokens(profile = {}) {
  const words = String(profile.name || profile.title || "").toLowerCase().match(/[a-z0-9]+/gu) || [];
  const tickers = Array.isArray(profile.tickers) ? profile.tickers : [];
  return unique([
    ...words.filter((word) => word.length >= 3 && !GENERIC_IDENTITY_WORDS.has(word)),
    ...tickers.map((ticker) => String(ticker).toLowerCase()).filter((ticker) => ticker.length >= 3),
  ]);
}

function issuerDomainTokens(issuerIndex) {
  const ignored = new Set(["www", "investor", "investors", "ir", "blog", "blogs", "developer", "news", "press"]);
  return unique((issuerIndex?.roots || []).flatMap((url) => {
    const safe = safeUrl(url);
    if (!safe) return [];
    return new URL(safe).hostname.toLowerCase().split(".")
      .flatMap((label) => label.split("-"))
      .filter((label) => label.length >= 3 && !ignored.has(label));
  }));
}

function excludedDiscoverySite(url) {
  const host = new URL(url).hostname.toLowerCase();
  return [...EXCLUDED_DISCOVERY_SITES].some((site) => host === site || host.endsWith(`.${site}`));
}

function scoreIssuerCandidate(url, tokens, context = "", prefix = "") {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();
  const tokenMatch = tokens.some((token) => host.includes(token));
  const investorPath = /(?:^|\/)(?:investor|investors|ir)(?:\/|$)/u.test(path)
    || /^(?:investor|investors|ir)\./u.test(host);
  const editorialPath = /(?:blog|news|press|product|developer)/u.test(host + path);
  const prefixClause = String(prefix).split(/[.!?](?:\s|$)/u).at(-1) || "";
  const issuerOwnedContext = /(?:our|company|registrant).{0,80}(?:website|investor relations)|(?:website|investor relations).{0,80}(?:our|company|registrant)/iu.test(prefixClause)
    || /(?:our|company|registrant).{0,80}(?:website|investor relations)|(?:website|investor relations).{0,80}(?:our|company|registrant)/iu.test(context)
      && prefixClause.length < 20;
  if (!tokenMatch && !(investorPath && issuerOwnedContext)) return 0;
  return (investorPath ? 8 : 0) + (tokenMatch ? 5 : 0) + (issuerOwnedContext ? 3 : 0)
    + (editorialPath ? 2 : 0) - Math.min(path.split("/").length, 4);
}

export async function discoverIssuerRootsFromFilings(profile = {}, {
  asOf,
  signal,
  filingIndexImpl = fetchFilingIndex,
  filingDocumentImpl = fetchFilingDocument,
} = {}) {
  if (!profile.cik) return { status: "not_disclosed", roots: [], filings: [], attempts: [] };
  try {
    const index = await filingIndexImpl(profile.cik, { signal });
    const cutoff = asOf ? Date.parse(`${asOf}T23:59:59.999Z`) : Infinity;
    const eligible = (index.filings || []).filter((filing) => {
      const instant = Date.parse(filing.accepted_at || filing.filing_date || "");
      return ["10-K", "10-Q", "8-K"].includes(filing.form) && Number.isFinite(instant) && instant <= cutoff;
    });
    const selected = [];
    for (const form of ["10-K", "10-Q", "8-K"]) {
      const filing = eligible.find((row) => row.form === form);
      if (filing && !selected.some((row) => row.accession === filing.accession)) selected.push(filing);
      if (selected.length >= 2) break;
    }
    const attempts = await Promise.all(selected.map(async (filing) => {
      try {
        const document = await filingDocumentImpl(profile.cik, filing.accession, filing.primary_document, { signal });
        return {
          filing,
          status: "succeeded",
          source_url: document.url || filing.primary_document_url,
          candidates: visibleDomainCandidates(document.text),
        };
      } catch (error) {
        return { filing, status: "unreachable", reason: String(error?.message || error), candidates: [] };
      }
    }));
    const tokens = identityTokens(profile);
    const candidateByUrl = new Map();
    for (const candidate of attempts.flatMap((attempt) => attempt.candidates || [])) {
      if (!candidateByUrl.has(candidate.url)) candidateByUrl.set(candidate.url, candidate);
    }
    const ranked = [...candidateByUrl.values()]
      .filter((candidate) => !excludedDiscoverySite(candidate.url))
      .map((candidate) => ({
        ...candidate,
        score: scoreIssuerCandidate(candidate.url, tokens, candidate.context, candidate.prefix),
      }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url));
    const byHost = new Map();
    for (const row of ranked) {
      const host = new URL(row.url).hostname;
      const existing = byHost.get(host);
      if (!existing || row.score > existing.score) byHost.set(host, row);
    }
    // Preserve distinct issuer subdomains. An IR vendor may block automated HTML while the
    // issuer's official newsroom or product blog on the same base domain remains reachable.
    const roots = [...byHost.values()]
      .sort((left, right) => right.score - left.score || left.url.localeCompare(right.url))
      .slice(0, 6)
      .map((row) => row.url);
    return {
      status: roots.length ? "succeeded" : attempts.some((attempt) => attempt.status === "succeeded") ? "not_disclosed" : "unreachable",
      roots,
      filings: selected,
      attempts,
      source: "issuer domains printed in SEC filing text",
    };
  } catch (error) {
    return { status: "unreachable", roots: [], filings: [], attempts: [], reason: String(error?.message || error) };
  }
}

function extractOfficialLinks(html, pageUrl, rootUrls) {
  const found = [];
  const pattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    let url;
    try { url = safeUrl(new URL(match[1], pageUrl).href); } catch { url = null; }
    if (!url || !rootUrls.some((root) => sameOfficialSite(root, url))) continue;
    const parsed = new URL(url);
    const researchPath = `${parsed.pathname}${parsed.search}`;
    if (!/(?:invest|financial|quarter|annual|earnings|filing|sec|news|press|event|presentation|webcast|transcript|product|blog|regulat|governance)/iu.test(researchPath)) continue;
    found.push(url);
  }
  return unique(found).slice(0, 48);
}

function officialDetailPriority(url, asOf) {
  let path;
  try { path = `${new URL(url).pathname}${new URL(url).search}`.toLowerCase(); } catch { return -Infinity; }
  let score = 0;
  if (/(?:news-release-details|press-release-details|event-details|corporate-news|press-releases?|news-releases?|article|announcement)/u.test(path)) score += 90;
  // Newsroom indexes are often the only root-page link that exposes current dated detail URLs.
  // Rank them ahead of product/navigation pages so the bounded crawler can spend its second hop
  // on the actual issuer announcements instead of stopping at an undated index surface.
  if (/(?:news-and-events|newsroom|press-room)(?:\/(?:home)?)?\/?$/u.test(path)) score += 75;
  if (/(?:earnings|results?|quarter|annual|financial|guidance|trading-update)/u.test(path)) score += 80;
  if (/(?:presentation|webcast|transcript|static-files|download|\.pdf(?:\?|$))/u.test(path)) score += 45;
  if (/(?:quarterly-results|events-presentations|news-releases)/u.test(path)) score += 30;
  if (/(?:filing|sec)/u.test(path)) score += 20;
  if (/(?:governance|board|committee|faq|contact)/u.test(path)) score -= 30;
  const asOfYear = Number(String(asOf || "").slice(0, 4));
  const years = [...path.matchAll(/(?:^|[^0-9])((?:19|20)\d{2})(?:[^0-9]|$)/gu)]
    .map((match) => Number(match[1]));
  if (Number.isInteger(asOfYear) && years.includes(asOfYear)) score += 25;
  else if (Number.isInteger(asOfYear) && years.includes(asOfYear - 1)) score += 10;
  return score;
}

function prioritizeOfficialDetailUrls(urls, asOf) {
  return urls.map((url, index) => ({ url, index, score: officialDetailPriority(url, asOf) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((row) => row.url);
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<!--([\s\S]*?)-->/gu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#(\d+);/gu, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/\s+/gu, " ")
    .trim();
}

function htmlTitle(html) {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(String(html || ""));
  return match ? decodeHtml(match[1]).slice(0, 300) : null;
}

function normalizedPublishedDay(value) {
  const text = decodeHtml(value).trim();
  const numeric = /^((?:19|20)\d{2})[-/]([01]\d)[-/]([0-3]\d)/u.exec(text);
  if (numeric) {
    const day = `${numeric[1]}-${numeric[2]}-${numeric[3]}`;
    return new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day ? day : null;
  }
  const instant = Date.parse(text);
  return Number.isFinite(instant) ? new Date(instant).toISOString().slice(0, 10) : null;
}

function htmlPublishedAt(html) {
  const source = String(html || "");
  const candidates = [];
  const jsonLd = /["']datePublished["']\s*:\s*["']([^"']+)["']/giu;
  let match;
  while ((match = jsonLd.exec(source))) candidates.push(match[1]);
  for (const tag of source.match(/<meta\b[^>]*>/giu) || []) {
    if (!/(?:article:published_time|datepublished|publishdate|pubdate)/iu.test(tag)) continue;
    const content = /\bcontent\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1];
    if (content) candidates.push(content);
  }
  for (const tag of source.match(/<time\b[^>]*>/giu) || []) {
    const datetime = /\bdatetime\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1];
    if (datetime) candidates.push(datetime);
  }
  for (const candidate of candidates) {
    const day = normalizedPublishedDay(candidate);
    if (day) return day;
  }
  return null;
}

function htmlExcerpt(html) {
  const text = decodeHtml(html);
  return text ? text.slice(0, 2_400) : null;
}

function extractFeedLinks(html, pageUrl, rootUrls) {
  const found = [];
  const linkPattern = /<link\b[^>]*>/giu;
  for (const tag of String(html || "").match(linkPattern) || []) {
    if (!/\b(?:rss|atom|application\/rss\+xml|application\/atom\+xml)\b/iu.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1];
    if (!href) continue;
    let url;
    try { url = safeUrl(new URL(href, pageUrl).href); } catch { url = null; }
    if (url && rootUrls.some((root) => sameOfficialSite(root, url))) found.push(url);
  }
  const anchorPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/giu;
  let match;
  while ((match = anchorPattern.exec(String(html || "")))) {
    let url;
    try { url = safeUrl(new URL(match[1], pageUrl).href); } catch { url = null; }
    if (!url || !rootUrls.some((root) => sameOfficialSite(root, url))) continue;
    if (/(?:\/feed(?:\/|$)|rss|atom|\.xml(?:\?|$))/iu.test(new URL(url).pathname + new URL(url).search)) found.push(url);
  }
  return unique(found).slice(0, 16);
}

async function fetchOfficialRoot(url, {
  signal,
  fetchImpl,
  lookupImpl,
  requestImpl,
  timeoutMs,
}) {
  const safe = safeUrl(url);
  if (!safe) return { url, status: "blocked", reason: "unsafe_or_non_http_url", links: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener?.("abort", relayAbort, { once: true });
  try {
    const response = await requestPublicText(safe, {
      fetchImpl,
      lookupImpl,
      requestImpl,
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "AlphaCouncilAgent/1.0 public-equity research contact: github.com/Zhao73/alphacouncil-agent",
      },
      redirectPolicy: ({ to }) => sameOfficialSite(safe, to),
      timeoutMs,
    });
    const finalUrl = safeUrl(response.url || safe);
    if (!response.ok) return { url: safe, final_url: finalUrl, status: "unreachable", reason: `HTTP ${response.status}`, links: [] };
    if (!finalUrl || !sameOfficialSite(safe, finalUrl)) {
      return { url: safe, final_url: finalUrl, status: "blocked", reason: "redirect_left_official_site", links: [] };
    }
    const contentType = String(response.headers?.get?.("content-type") || "");
    const body = (await response.text()).slice(0, MAX_SOURCE_BODY_BYTES);
    const retrievedAt = new Date().toISOString();
    return {
      url: safe,
      final_url: finalUrl,
      status: "succeeded",
      content_type: contentType || null,
      title: htmlTitle(body),
      published_at: htmlPublishedAt(body),
      excerpt: htmlExcerpt(body),
      content_hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      retrieved_at: retrievedAt,
      links: extractOfficialLinks(body, finalUrl, [safe, finalUrl]),
      feeds: extractFeedLinks(body, finalUrl, [safe, finalUrl]),
    };
  } catch (error) {
    const blocked = error instanceof PublicHttpError
      && ["REDIRECT_BLOCKED", "UNSAFE_DESTINATION"].includes(error.code);
    return {
      url: safe,
      status: blocked ? "blocked" : "unreachable",
      reason: error?.name === "AbortError" ? "timed_out" : String(error?.message || error),
      links: [],
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", relayAbort);
  }
}

export async function discoverIssuerOfficialSources(profile = {}, {
  asOf,
  signal,
  fetchImpl,
  lookupImpl,
  requestImpl,
  timeoutMs = 12_000,
  filingIndexImpl = fetchFilingIndex,
  filingDocumentImpl = fetchFilingDocument,
} = {}) {
  const filingDiscovery = await discoverIssuerRootsFromFilings(profile, {
    asOf,
    signal,
    filingIndexImpl,
    filingDocumentImpl,
  });
  const roots = unique([
    safeUrl(profile.investor_website),
    safeUrl(profile.website),
    ...(filingDiscovery.roots || []),
  ]);
  if (!roots.length) {
    return {
      status: filingDiscovery.status === "unreachable" ? "unreachable" : "not_disclosed",
      roots: [], pages: [], feeds: [], documents: [], attempts: [], filing_discovery: filingDiscovery,
      reason: "SEC profile and inspected periodic/current reports supplied no verifiable issuer website",
    };
  }
  const requestOptions = { signal, fetchImpl, lookupImpl, requestImpl, timeoutMs };
  const rootAttempts = await Promise.all(roots.map((url) => fetchOfficialRoot(url, requestOptions)));
  const discoveredPages = unique(rootAttempts.flatMap((attempt) => attempt.links || []));
  // Reserve part of the fixed ten-page budget for one bounded second hop. Many issuer sites
  // expose current announcement URLs only from a newsroom index discovered on the home page.
  // Fetching all ten first-hop links would archive the index but never the dated detail pages.
  const firstHopLimit = Math.max(1, Math.ceil(MAX_OFFICIAL_DETAIL_PAGES * 0.6));
  const detailUrls = prioritizeOfficialDetailUrls(discoveredPages, asOf)
    .filter((url) => !roots.includes(url))
    .slice(0, firstHopLimit);
  const firstHopAttempts = await Promise.all(detailUrls.map((url) => fetchOfficialRoot(url, requestOptions)));
  const attempted = new Set([...roots, ...detailUrls]);
  const remaining = Math.max(0, MAX_OFFICIAL_DETAIL_PAGES - detailUrls.length);
  const secondHopUrls = prioritizeOfficialDetailUrls(
    unique(firstHopAttempts.flatMap((attempt) => attempt.links || [])),
    asOf,
  )
    .filter((url) => !attempted.has(url))
    .slice(0, remaining);
  const secondHopAttempts = await Promise.all(secondHopUrls.map((url) => fetchOfficialRoot(url, requestOptions)));
  const detailAttempts = [...firstHopAttempts, ...secondHopAttempts];
  const attempts = [...rootAttempts, ...detailAttempts];
  const pages = unique([
    ...roots,
    ...attempts.flatMap((attempt) => attempt.links || []),
  ]).slice(0, 64);
  return {
    status: rootAttempts.some((attempt) => attempt.status === "succeeded") ? "succeeded" : "unreachable",
    roots,
    pages,
    feeds: unique(attempts.flatMap((attempt) => attempt.feeds || [])).slice(0, 24),
    documents: attempts.filter((attempt) => attempt.status === "succeeded").map((attempt) => ({
      url: attempt.final_url || attempt.url,
      title: attempt.title,
      published_at: attempt.published_at,
      excerpt: attempt.excerpt,
      content_hash: attempt.content_hash,
      retrieved_at: attempt.retrieved_at,
    })),
    attempts,
    filing_discovery: filingDiscovery,
    observed_at: new Date().toISOString(),
  };
}

function adaptiveQuerySpecs({ symbol, issuer }) {
  const identity = issuer && issuer !== "unknown issuer" ? `"${issuer}"` : symbol;
  return [
    { topic: "company_core", ...queryNewsFeed(`${identity} ${symbol} earnings OR guidance OR revenue OR margin`) },
    { topic: "customers_suppliers_capacity", ...queryNewsFeed(`${identity} customer OR supplier OR order OR capacity OR shipment`) },
    { topic: "product_delivery_quality", ...queryNewsFeed(`${identity} product launch OR acceptance OR delay OR quality OR yield`) },
    { topic: "regulation_litigation", ...queryNewsFeed(`${identity} regulation OR antitrust OR lawsuit OR investigation`) },
    { topic: "management_changes", ...queryNewsFeed(`${identity} appoints OR appointed OR resignation OR executive OR "chief officer" OR director`) },
    { topic: "management_capital_allocation", ...queryNewsFeed(`${identity} management OR board OR insider OR buyback OR debt`) },
  ];
}

function starterNewsKey(item) {
  return `${String(item?.link || "").trim()}|${String(item?.title || "").trim().toLowerCase()}`;
}

/**
 * Preserve bounded breadth instead of letting one high-volume topic consume the whole starter
 * pack. The first pass gives every fetched topic an equal, small quota; the second pass fills
 * remaining capacity by global recency. Items are already date-sorted by applyRecencyGate.
 */
function selectBalancedStarterNews(items, {
  limit = MAX_STARTER_NEWS_ITEMS,
  perTopic = MIN_STARTER_NEWS_ITEMS_PER_TOPIC,
} = {}) {
  const topics = unique(items.map((item) => item.topic));
  const grouped = new Map(topics.map((topic) => [topic, items
    .filter((item) => item.topic === topic)
    // Query feeds are relevance-ranked. Preserve their top leads inside each topic even
    // though applyRecencyGate globally sorts the combined set by publication timestamp.
    .sort((left, right) => (
      (Number.isInteger(left.feed_rank) ? left.feed_rank : Number.MAX_SAFE_INTEGER)
        - (Number.isInteger(right.feed_rank) ? right.feed_rank : Number.MAX_SAFE_INTEGER)
      || Date.parse(right.published_at || 0) - Date.parse(left.published_at || 0)
    ))]));
  const selected = [];
  const seen = new Set();
  const selectedPerTopic = new Map(topics.map((topic) => [topic, 0]));
  const cursors = new Map(topics.map((topic) => [topic, 0]));
  let progressed = true;
  while (selected.length < limit && progressed) {
    progressed = false;
    for (const topic of topics) {
      if ((selectedPerTopic.get(topic) || 0) >= perTopic || selected.length >= limit) continue;
      const group = grouped.get(topic) || [];
      let cursor = cursors.get(topic) || 0;
      while (cursor < group.length) {
        const item = group[cursor];
        cursor += 1;
        const key = starterNewsKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(item);
        selectedPerTopic.set(topic, (selectedPerTopic.get(topic) || 0) + 1);
        progressed = true;
        break;
      }
      cursors.set(topic, cursor);
    }
  }
  for (const item of items) {
    if (selected.length >= limit) break;
    const key = starterNewsKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(item);
  }
  return selected;
}

function cleanLeadHeadline(title) {
  return String(title || "")
    .replace(/\s+-\s+[^-]{2,100}$/u, "")
    .replace(/[™®©]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function headlineSlug(title) {
  return cleanLeadHeadline(title)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 180);
}

function officialLeadCandidates(news, issuerIndex) {
  const templates = unique([
    ...(issuerIndex?.pages || []),
    ...(issuerIndex?.documents || []).map((document) => document.url),
  ]).filter((value) => {
    const url = safeUrl(value);
    if (!url) return false;
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const last = segments.at(-1) || "";
    return /(?:corporate-news|news-release-details|press-release-details|press-releases?|news-releases?)\//iu.test(pathname)
      && /(?:19|20)\d{2}/u.test(pathname)
      && !/(?:corporate-news|news-release-details|press-release-details|press-releases?|news-releases?|\$|%7b)/iu.test(last);
  });
  const leads = news.filter((item) => item.topic === "management_changes").slice(0, 3);
  const candidates = [];
  for (const lead of leads) {
    const slug = headlineSlug(lead.title);
    const year = String(lead.published_at || "").slice(0, 4);
    if (!slug || !/^(?:19|20)\d{2}$/u.test(year)) continue;
    for (const template of templates) {
      const parsed = new URL(template);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (!segments.length) continue;
      const yearIndex = segments.findIndex((segment) => /^(?:19|20)\d{2}$/u.test(segment));
      if (yearIndex >= 0) segments[yearIndex] = year;
      const last = segments.length - 1;
      const extension = /\.[a-z0-9]{2,5}$/iu.exec(segments[last])?.[0] || "";
      segments[last] = `${slug}${extension}`;
      parsed.pathname = `/${segments.join("/")}${extension ? "" : "/"}`;
      parsed.search = "";
      parsed.hash = "";
      candidates.push({ lead, url: parsed.href });
      if (/^[a-z]{2}(?:-[a-z]{2,}|-[a-z]+)$/iu.test(segments[0]) && segments[0].toLowerCase() !== "en-us") {
        const english = new URL(parsed.href);
        const englishSegments = english.pathname.split("/").filter(Boolean);
        englishSegments[0] = "en-us";
        english.pathname = `/${englishSegments.join("/")}${extension ? "" : "/"}`;
        candidates.push({ lead, url: english.href });
      }
    }
  }
  const seen = new Set();
  return candidates.filter(({ url }) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  }).slice(0, MAX_OFFICIAL_LEAD_PAGES);
}

function officialLeadMatches(attempt, lead) {
  if (attempt.status !== "succeeded") return false;
  const target = new Set(cleanLeadHeadline(lead.title).toLowerCase().match(/[a-z0-9]{4,}/gu) || []);
  const observed = new Set(`${attempt.title || ""} ${attempt.excerpt || ""}`.toLowerCase().match(/[a-z0-9]{4,}/gu) || []);
  const overlap = [...target].filter((token) => observed.has(token)).length;
  const leadDay = String(lead.published_at || "").slice(0, 10);
  const dateMatches = !attempt.published_at || !leadDay || attempt.published_at === leadDay;
  return target.size > 0 && overlap >= Math.min(3, target.size) && dateMatches;
}

async function resolveOfficialNewsLeads(news, issuerIndex, {
  signal,
  fetchImpl,
  lookupImpl,
  requestImpl,
  timeoutMs,
}) {
  const candidates = officialLeadCandidates(news, issuerIndex);
  const attempts = await Promise.all(candidates.map(async ({ lead, url }) => {
    const attempt = await fetchOfficialRoot(url, {
      signal, fetchImpl, lookupImpl, requestImpl, timeoutMs,
    });
    return { ...attempt, lead_title: lead.title, lead_published_at: lead.published_at, topic: lead.topic };
  }));
  const matched = attempts.filter((attempt) => officialLeadMatches(attempt, {
    title: attempt.lead_title,
    published_at: attempt.lead_published_at,
  }));
  return {
    documents: matched.map((attempt) => ({
      url: attempt.final_url || attempt.url,
      title: attempt.title,
      published_at: attempt.published_at,
      excerpt: attempt.excerpt,
      content_hash: attempt.content_hash,
      retrieved_at: attempt.retrieved_at,
      discovery_topic: attempt.topic,
      discovery_lead_title: attempt.lead_title,
    })),
    attempts: attempts.map((attempt) => ({
      topic: attempt.topic,
      lead_title: attempt.lead_title,
      lead_published_at: attempt.lead_published_at,
      url: attempt.url,
      final_url: attempt.final_url || null,
      status: attempt.status,
      reason: attempt.reason || null,
      matched: officialLeadMatches(attempt, {
        title: attempt.lead_title,
        published_at: attempt.lead_published_at,
      }),
    })),
  };
}

export function companyStarterFeedSpecs({ symbol, profile = {}, issuerIndex = null } = {}) {
  const upper = String(symbol || profile.tickers?.[0] || "").trim().toUpperCase();
  const issuer = profile.name || profile.title || upper || "unknown issuer";
  const specs = [
    ...(upper ? [{ topic: "ticker_news", ...tickerNewsFeed(upper) }] : []),
    ...adaptiveQuerySpecs({ symbol: upper, issuer }),
    ...(profile.cik ? [
      { topic: "material_filings", ...filingsFeed(profile.cik, "8-K") },
      { topic: "annual_filings", ...filingsFeed(profile.cik, "10-K") },
      { topic: "quarterly_filings", ...filingsFeed(profile.cik, "10-Q") },
    ] : []),
    ...(issuerIndex?.feeds || []).map((url, index) => ({
      topic: "issuer_feed",
      source: `Issuer official feed ${index + 1}`,
      url,
    })),
  ];
  return unique(specs.map((spec) => JSON.stringify(spec))).map((spec) => JSON.parse(spec));
}

async function fetchStarterFeed(spec, {
  signal,
  fetchImpl,
  lookupImpl,
  requestImpl,
  timeoutMs,
}) {
  const url = safeUrl(spec.url);
  if (!url) return { ...spec, url: spec.url, ok: false, reason: "unsafe_or_non_http_url", items: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener?.("abort", relayAbort, { once: true });
  try {
    const response = await requestPublicText(url, {
      fetchImpl,
      lookupImpl,
      requestImpl,
      signal: controller.signal,
      headers: {
        Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": secUserAgent(),
      },
      timeoutMs,
    });
    if (!response.ok) return { ...spec, url, ok: false, reason: `HTTP ${response.status}`, items: [] };
    const body = (await response.text()).slice(0, MAX_SOURCE_BODY_BYTES);
    return { ...spec, url, ok: true, items: parseFeed(body, { source: spec.source }) };
  } catch (error) {
    return {
      ...spec,
      url,
      ok: false,
      reason: error?.name === "AbortError" ? "timed_out_or_aborted" : String(error?.message || error),
      items: [],
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", relayAbort);
  }
}

export async function acquireCompanyStarterEvidence({
  symbol,
  asOf,
  profile = {},
  issuerIndex = null,
} = {}, {
  signal,
  fetchImpl,
  lookupImpl,
  requestImpl,
  timeoutMs = 12_000,
  days = 120,
} = {}) {
  const specs = companyStarterFeedSpecs({ symbol, profile, issuerIndex });
  const attempts = await Promise.all(specs.map((spec) => fetchStarterFeed(spec, {
    signal, fetchImpl, lookupImpl, requestImpl, timeoutMs,
  })));
  const allItems = attempts.flatMap((attempt) => attempt.items.map((item, index) => ({
    ...item,
    topic: attempt.topic,
    feed_url: attempt.url,
    feed_rank: index + 1,
  })));
  const tokens = unique([
    ...identityTokens({ ...profile, tickers: unique([...(profile.tickers || []), symbol]) }),
    ...issuerDomainTokens(issuerIndex),
  ]);
  const relevantItems = [];
  const irrelevantItems = [];
  for (const item of allItems) {
    const trustedScope = ["material_filings", "annual_filings", "quarterly_filings", "issuer_feed"].includes(item.topic);
    const titleWords = new Set(String(item.title || "").toLowerCase().match(/[a-z0-9]+/gu) || []);
    const relevant = trustedScope || tokens.some((token) => titleWords.has(token));
    (relevant ? relevantItems : irrelevantItems).push(item);
  }
  const recency = applyRecencyGate(relevantItems, { days, asOf });
  const news = selectBalancedStarterNews(recency.included);
  const officialLeadResolution = await resolveOfficialNewsLeads(news, issuerIndex, {
    signal, fetchImpl, lookupImpl, requestImpl, timeoutMs,
  });
  const issuerDocuments = [];
  const seenDocuments = new Set();
  for (const document of [...(issuerIndex?.documents || []), ...officialLeadResolution.documents]) {
    const key = safeUrl(document?.url);
    if (!key || seenDocuments.has(key)) continue;
    seenDocuments.add(key);
    issuerDocuments.push(document);
  }
  const cutoff = asOf ? Date.parse(`${asOf}T23:59:59.999Z`) : Infinity;
  const filings = (profile.recent_filings || []).filter((filing) => {
    const date = Date.parse(filing.accepted_at || filing.filing_date || "");
    return Number.isFinite(date) && date <= cutoff;
  });
  return {
    schema_version: 1,
    symbol: String(symbol || profile.tickers?.[0] || "").toUpperCase(),
    issuer: profile.name || profile.title || null,
    as_of: asOf || new Date().toISOString().slice(0, 10),
    window_days: days,
    source_status: attempts.some((attempt) => attempt.ok) || filings.length || issuerIndex?.documents?.length
      ? "succeeded"
      : "unreachable",
    filings,
    issuer_documents: issuerDocuments,
    news,
    feed_attempts: attempts.map((attempt) => ({
      topic: attempt.topic,
      source: attempt.source,
      url: attempt.url,
      ok: attempt.ok,
      reason: attempt.reason || null,
      raw_item_count: attempt.items.length,
    })),
    official_lead_attempts: officialLeadResolution.attempts,
    excluded_irrelevant: irrelevantItems.length,
    excluded_irrelevant_sample: irrelevantItems.slice(0, 8).map((item) => ({
      topic: item.topic,
      title: item.title,
      published_at: item.published_at,
    })),
    excluded_outside_window: recency.excluded.length,
    retrieved_at: new Date().toISOString(),
  };
}

function fallbackCompanyProfile(symbol, quote = null) {
  const market = marketFor(symbol);
  return {
    cik: null,
    name: quote?.long_name || quote?.short_name || symbol,
    tickers: [symbol],
    exchanges: quote?.exchange ? [quote.exchange] : [],
    market_id: market?.id || null,
    regulator: market?.regulator || null,
    website: null,
    investor_website: null,
    recent_filings: [],
  };
}

export async function getCompanySourceMap({ symbol, cik, asOf, signal } = {}) {
  const upper = String(symbol || "").trim().toUpperCase();
  let resolvedCik = String(cik || "").replace(/\D/gu, "");
  let profile = null;
  let identityResolution = null;
  if (!resolvedCik) {
    if (!upper) throw invalidParams("get_company_sources requires symbol or cik");
    try {
      const universe = await fetchUniverse({ signal });
      const match = universe.find((row) => String(row.ticker || "").toUpperCase() === upper);
      if (match) {
        resolvedCik = String(match.cik);
        identityResolution = { mode: "sec_ticker_mapping", status: "succeeded" };
      } else {
        identityResolution = { mode: "quote_identity_fallback", status: "sec_not_listed" };
      }
    } catch (error) {
      identityResolution = {
        mode: "quote_identity_fallback",
        status: "sec_mapping_unreachable",
        reason: String(error?.message || error),
      };
    }
  }
  if (resolvedCik) {
    profile = await fetchSubmissions(resolvedCik, { signal });
    identityResolution ||= { mode: "explicit_cik", status: "succeeded" };
  } else {
    const quote = await fetchQuote(upper, { signal }).catch((error) => ({ error: String(error?.message || error) }));
    profile = fallbackCompanyProfile(upper, quote && !quote.error ? quote : null);
    identityResolution = {
      ...identityResolution,
      quote_status: quote?.error ? "unreachable" : "succeeded",
      quote_reason: quote?.error || null,
      market_id: profile.market_id,
    };
  }
  const effectiveAsOf = asOf || new Date().toISOString().slice(0, 10);
  const issuerIndex = await discoverIssuerOfficialSources(profile, { asOf: effectiveAsOf, signal });
  const starterEvidence = await acquireCompanyStarterEvidence({
    symbol: upper || profile.tickers?.[0],
    asOf: effectiveAsOf,
    profile,
    issuerIndex,
  }, { signal });
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: upper || profile.tickers?.[0] || profile.name,
    asOf: effectiveAsOf,
    profile,
    issuerIndex,
  });
  return {
    schema_version: 1,
    policy_id: COMPANY_SOURCE_ACQUISITION_POLICY_ID,
    symbol: plan.symbol,
    cik: profile.cik || null,
    issuer: profile.name,
    identity_resolution: identityResolution,
    official_profile: {
      website: profile.website,
      investor_website: profile.investor_website,
      submissions_url: profile.submissions_url,
      latest_filing: profile.latest_filing,
      sic: profile.sic,
      sic_description: profile.sic_description,
      market_id: profile.market_id || marketFor(plan.symbol)?.id || null,
      regulator: profile.regulator || marketFor(plan.symbol)?.regulator || null,
    },
    issuer_source_index: issuerIndex,
    starter_evidence: starterEvidence,
    plan,
    coverage_item_count: Object.values(OPERATING_COMPANY_COVERAGE).flat().length,
  };
}

function topicFor(coverageId) {
  return String(coverageId).split(".").at(-1).replace(/_/gu, " ");
}

function stagesFor(coverageId) {
  const specific = SPECIFIC_STAGES[coverageId];
  if (specific) return [...specific];
  const prefix = String(coverageId).split(".")[0];
  return [...(GENERIC_STAGES[prefix] || ["issuer_ir", "regulator_filing", "disconfirming_search"])];
}

function domainQuery(domains) {
  const values = unique(domains || []);
  if (!values.length) return "official regulator";
  return values.map((domain) => `site:${domain}`).join(" OR ");
}

function stageLocators(stage, context, topic) {
  const {
    symbol, issuer, cik, asOf, regulatorUrl, regulatorDomains, marketDomains,
    issuerUrls, sicDescription, exchange,
  } = context;
  const quoted = `"${issuer}"`;
  const suffix = `${topic} ${asOf}`;
  const regulatorSites = domainQuery(regulatorDomains);
  const marketSites = domainQuery(marketDomains);
  const lowerSymbol = String(symbol || "").toLowerCase();
  const year = String(asOf || "").slice(0, 4);
  const exchangeSlug = coverageIdSafe(exchange || "");
  const publicMarketLocators = topic === "earnings call qna"
    ? unique([
      lowerSymbol ? `https://stockanalysis.com/stocks/${lowerSymbol}/transcripts/` : null,
      `site:stockanalysis.com/stocks/${lowerSymbol}/transcripts/ ${quoted} earnings call full transcript Q&A ${year}`,
    ])
    : topic === "short interest borrow"
      ? unique([
        exchangeSlug && lowerSymbol
          ? `https://www.marketbeat.com/stocks/${exchangeSlug.toUpperCase()}/${symbol}/short-interest/`
          : null,
        exchangeSlug && lowerSymbol
          ? `https://chartexchange.com/symbol/${exchangeSlug}-${lowerSymbol}/short-interest/`
          : null,
        `${symbol} short interest settlement shares short float days to cover ${asOf} site:marketbeat.com OR site:chartexchange.com`,
      ])
      : [`${symbol} ${topic} public market data ${asOf}`];
  const disconfirmingLocators = topic === "earnings call qna"
    ? [`${quoted} ${symbol} ${year} earnings call transcript Q&A speaker`]
    : topic === "short interest borrow"
      ? [`${symbol} short interest borrow fee availability utilisation ${asOf}`]
      : [`${quoted} guidance cut delay cancellation accounting concern litigation ${asOf}`];
  const byStage = {
    regulator_filing: unique([
      regulatorUrl,
      cik
        ? `site:sec.gov/Archives/edgar/data/${String(cik).replace(/^0+/u, "")} ${quoted} ${suffix}`
        : `(${regulatorSites}) ${quoted} filing disclosure ${suffix}`,
    ]),
    ownership_filing: unique([
      regulatorUrl,
      cik
        ? `site:sec.gov ${quoted} (Form 3 OR Form 4 OR Form 5 OR SC 13D OR SC 13G) ${asOf}`
        : `(${regulatorSites}) ${quoted} ownership directors substantial shareholder ${asOf}`,
    ]),
    issuer_ir: unique([...issuerUrls, `${quoted} investor relations ${suffix}`]),
    issuer_product_docs: unique([...issuerUrls, `${quoted} official product documentation ${suffix}`]),
    market_official: [ `${symbol} ${topic} (${marketSites}) ${asOf}` ],
    public_market_data: publicMarketLocators,
    public_consensus: [ `${symbol} analyst consensus revenue EPS target revision ${asOf}` ],
    local_observation: [ `local:${symbol}:${coverageIdSafe(topic)}` ],
    customer_official: [ `${quoted} customer capex orders acceptance deployment official ${suffix}` ],
    supplier_official: [ `${quoted} supplier capacity yield shipment official ${suffix}` ],
    competitor_official: [ `${quoted} competitor guidance ${sicDescription || "industry"} official ${suffix}` ],
    peer_filing: [ `${quoted} peer filing ${sicDescription || "industry"} ${suffix}` ],
    counterparty_official: [ `${quoted} counterparty material contract official ${suffix}` ],
    other_regulator: [ `${quoted} ${topic} site:ftc.gov OR site:justice.gov OR site:commerce.gov ${asOf}` ],
    court_record: [ `${quoted} ${topic} court docket official ${asOf}` ],
    disconfirming_search: disconfirmingLocators,
    derived_proxy: [ `derive:${coverageIdSafe(topic)}` ],
  };
  return byStage[stage] || [`${quoted} ${suffix} official`];
}

function coverageIdSafe(value) {
  return String(value || "unknown").trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "unknown";
}

export function buildCompanySourceAcquisitionPlan({
  symbol,
  asOf,
  profile = {},
  issuerIndex = null,
} = {}) {
  const issuer = profile.name || profile.title || symbol || "unknown issuer";
  const cik = profile.cik || null;
  const market = marketFor(symbol);
  const sourceRoute = MARKET_SOURCE_ROUTES[profile.market_id || market?.id || "US"] || MARKET_SOURCE_ROUTES.US;
  const issuerUrls = unique([
    ...(issuerIndex?.roots || []),
    ...(issuerIndex?.pages || []),
    safeUrl(profile.investor_website),
    safeUrl(profile.website),
  ]).slice(0, 64);
  const context = {
    symbol: String(symbol || "").toUpperCase(),
    issuer,
    cik,
    asOf,
    regulatorUrl: profile.submissions_url
      || profile.regulator_url
      || (cik ? `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json` : sourceRoute.regulator_entry),
    regulatorDomains: sourceRoute.regulator_domains,
    marketDomains: sourceRoute.market_domains,
    issuerUrls,
    sicDescription: profile.sic_description || null,
    exchange: Array.isArray(profile.exchanges) ? profile.exchanges[0] : null,
  };
  const tasks = Object.fromEntries(Object.entries(OPERATING_COMPANY_COVERAGE).map(([task, coverageIds]) => [
    task,
    coverageIds.map((coverageId) => {
      const stages = stagesFor(coverageId);
      const routeStages = stages.map((stage) => ({
        stage,
        locators: stageLocators(stage, context, topicFor(coverageId)).map((locator) => ({
          locator_type: safeUrl(locator) ? "url" : locator.startsWith("local:") || locator.startsWith("derive:") ? "local" : "query",
          locator,
        })),
      }));
      return {
        coverage_id: coverageId,
        topic: topicFor(coverageId),
        required_terminal_stages: stages,
        minimum_terminal_attempts: stages.length,
        stages: routeStages,
        recovery: RECOVERY_RECIPES[coverageId] || {
          mode: stages.includes("derived_proxy") ? "recomputed_proxy" : "actual_only",
          formula: stages.includes("derived_proxy") ? `derive ${topicFor(coverageId)} only from cited public inputs` : null,
          inputs: [],
        },
      };
    }),
  ]));
  return {
    schema_version: 1,
    policy_id: COMPANY_SOURCE_ACQUISITION_POLICY_ID,
    symbol: context.symbol,
    issuer,
    cik,
    as_of: asOf,
    issuer_official_roots: issuerUrls,
    regulator_entry_url: context.regulatorUrl,
    issuer_discovery_status: issuerIndex?.status || (issuerUrls.length ? "profile_only" : "not_disclosed"),
    tasks,
  };
}

function mappedSourceIds(values, sourceIdMap) {
  return unique((Array.isArray(values) ? values : []).map((value) => {
    const raw = String(value || "").trim();
    return sourceIdMap.get(raw) || raw;
  }));
}

const MAX_ACQUISITION_INPUT_ROWS = 64;

function strictFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/,/gu, "");
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeAcquisitionInputs(value, sourceIdMap) {
  const rows = Array.isArray(value)
    ? value.slice(0, MAX_ACQUISITION_INPUT_ROWS).map((input, index) => {
      if (input && typeof input === "object" && !Array.isArray(input)) return input;
      return { name: `input_${index + 1}`, value: input };
    })
    : value && typeof value === "object"
      ? Object.entries(value).slice(0, MAX_ACQUISITION_INPUT_ROWS).map(([name, input]) => (
        input && typeof input === "object" && !Array.isArray(input)
          ? { name, ...input }
          : { name, value: input }
      ))
      : value;
  return Array.isArray(rows) ? rows.map((input) => ({
    ...input,
    source_ids: mappedSourceIds(input?.source_ids, sourceIdMap),
  })) : rows;
}

function normalizeAcquisitionRange(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data?.range;
  const candidate = data.range && typeof data.range === "object" && !Array.isArray(data.range)
    ? data.range
    : ["low", "base", "high"].some((key) => Object.hasOwn(data, key))
      ? { low: data.low, base: data.base, high: data.high }
      : null;
  if (!candidate) return data.range;
  const low = strictFiniteNumber(candidate.low);
  const base = strictFiniteNumber(candidate.base);
  const high = strictFiniteNumber(candidate.high);
  return [low, base, high].every(Number.isFinite)
    ? { ...candidate, low, base, high }
    : candidate;
}

function normalizeAcquisitionData(data, sourceIdMap) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const range = normalizeAcquisitionRange(data);
  return {
    ...data,
    ...(range !== undefined ? { range } : {}),
    source_ids: mappedSourceIds(data.source_ids, sourceIdMap),
    inputs: normalizeAcquisitionInputs(data.inputs, sourceIdMap),
    observations: Array.isArray(data.observations) ? data.observations.map((observation) => (
      observation && typeof observation === "object" && !Array.isArray(observation)
        ? {
          ...observation,
          source_ids: mappedSourceIds(observation.source_ids, sourceIdMap),
          inputs: normalizeAcquisitionInputs(observation.inputs, sourceIdMap),
        }
        : observation
    )) : data.observations,
  };
}

function normalizeAcquisitionAttempt(attempt, sourceIdMap) {
  if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) return attempt;
  const proposedStage = typeof attempt.stage === "string" ? attempt.stage.trim() : attempt.stage;
  const stage = ACQUISITION_STAGE_ALIASES.get(proposedStage) || proposedStage;
  const sourceIds = mappedSourceIds(attempt.source_ids, sourceIdMap);
  const proposedResult = typeof attempt.result === "string" ? attempt.result.trim() : attempt.result;
  // Workers often use succeeded to mean "the page opened". Without a cited source this is
  // not evidence success, so bind it to the fail-closed semantic result the validator already
  // asks for. Local/derived stages may legitimately succeed against an in-process ledger.
  const result = proposedResult === "succeeded" && !sourceIds.length
    && !DERIVATION_SUCCESS_STAGES.has(stage)
    ? "not_disclosed"
    : proposedResult;
  return {
    ...attempt,
    stage,
    locator_type: typeof attempt.locator_type === "string" ? attempt.locator_type.trim() : attempt.locator_type,
    locator: typeof attempt.locator === "string" ? attempt.locator.trim() : attempt.locator,
    result,
    source_ids: sourceIds,
    ...(stage !== proposedStage ? { proposed_stage: proposedStage } : {}),
    ...(result !== proposedResult ? { proposed_result: proposedResult } : {}),
  };
}

export function normalizeCompanySourceAcquisitionLedger(value, task, sourceIdMap = new Map()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    // These are server-owned bindings. A worker may echo them, omit them, or mistype them,
    // but it may never select the policy or reassign a ledger to another analyst task.
    policy_id: COMPANY_SOURCE_ACQUISITION_POLICY_ID,
    task,
    items: Array.isArray(value.items) ? value.items.map((item) => ({
      ...(item && typeof item === "object" ? item : {}),
      coverage_id: typeof item?.coverage_id === "string" ? item.coverage_id.trim() : item?.coverage_id,
      outcome: typeof item?.outcome === "string" ? item.outcome.trim() : item?.outcome,
      source_ids: mappedSourceIds(item?.source_ids, sourceIdMap),
      attempts: Array.isArray(item?.attempts)
        ? item.attempts.map((attempt) => normalizeAcquisitionAttempt(attempt, sourceIdMap))
        : item?.attempts,
      data: normalizeAcquisitionData(item?.data, sourceIdMap),
    })) : value.items,
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function dataValuePresent(data) {
  return data && typeof data === "object" && !Array.isArray(data)
    && Object.hasOwn(data, "value") && data.value !== null && data.value !== "";
}

const REPORTED_DATA_METADATA_FIELDS = new Set([
  "value", "unit", "period", "scope", "metric", "label", "source_ids", "observations",
  "range", "formula", "inputs", "assumptions",
]);
const MAX_REPORTED_ACTUAL_OBSERVATIONS = 48;

function observationValuePresent(value) {
  return (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.trim().length > 0)
    || typeof value === "boolean";
}

function inferredObservationUnit(metric, value) {
  const key = String(metric || "").toLowerCase();
  if (/(?:^|[._])(?:pct|percent)$/u.test(key) || (typeof value === "string" && /%/u.test(value))) return "%";
  if (/(?:^|[._])bps$/u.test(key)) return "basis points";
  if (/(?:^|[._])usd_b$/u.test(key)) return "USD billion";
  if (/(?:^|[._])usd_m$/u.test(key)) return "USD million";
  if (/(?:^|[._])usd$/u.test(key)) return "USD";
  if (/(?:^|[._])shares?$/u.test(key)) return "shares";
  if (/(?:^|[._])days?$/u.test(key)) return "days";
  if (/(?:^|[._])(?:ratio|multiple)$/u.test(key)) return "ratio";
  if (/(?:^|[._])date$/u.test(key)) return "date";
  if (/(?:^|[._])count$/u.test(key)) return "count";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "text";
  // A generic numeric value has no inferable unit. Leave it absent so the semantic gate
  // requests a ledger-only repair instead of laundering missing metadata into completion.
  return null;
}

function inferredObservationPeriod(metric, fallback) {
  const key = String(metric || "");
  const quarter = /(?:^|[._-])((?:19|20)\d{2})[._-]?[qQ]([1-4])(?:$|[._-])/u.exec(key);
  if (quarter) return `${quarter[1]}Q${quarter[2]}`;
  const fiscal = /(?:^|[._-])[fF][yY][._-]?((?:19|20)\d{2})(?:$|[._-])/u.exec(key);
  if (fiscal) return `FY${fiscal[1]}`;
  return nonEmpty(fallback) ? fallback.trim() : null;
}

function flattenReportedActualData(value, prefix, rows, depth = 0) {
  if (rows.length >= MAX_REPORTED_ACTUAL_OBSERVATIONS || depth > 4) return;
  if (observationValuePresent(value)) {
    rows.push({ metric: prefix, value });
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, MAX_REPORTED_ACTUAL_OBSERVATIONS - rows.length)
      .forEach((entry, index) => flattenReportedActualData(entry, `${prefix}.${index + 1}`, rows, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (REPORTED_DATA_METADATA_FIELDS.has(key)) continue;
    flattenReportedActualData(entry, prefix ? `${prefix}.${key}` : key, rows, depth + 1);
    if (rows.length >= MAX_REPORTED_ACTUAL_OBSERVATIONS) break;
  }
}

function reportedActualObservations(data, coverageId) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const supplied = Array.isArray(data.observations)
    ? data.observations
    : dataValuePresent(data)
      ? [{
        metric: data.metric || data.label || coverageId,
        value: data.value,
        unit: data.unit,
        period: data.period,
        scope: data.scope,
      }]
      : (() => {
        const rows = [];
        flattenReportedActualData(data, "", rows);
        return rows;
      })();
  return supplied.slice(0, MAX_REPORTED_ACTUAL_OBSERVATIONS).flatMap((observation, index) => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) return [];
    if (!observationValuePresent(observation.value)) return [];
    const metric = nonEmpty(observation.metric) ? observation.metric.trim() : `${coverageId}.${index + 1}`;
    return [{
      ...observation,
      metric,
      unit: nonEmpty(observation.unit)
        ? observation.unit.trim()
        : inferredObservationUnit(metric, observation.value),
      // as_of is a retrieval boundary, not an accounting/operating period. Never substitute it.
      period: inferredObservationPeriod(metric, observation.period || data.period),
      scope: nonEmpty(observation.scope) ? observation.scope.trim() : coverageId,
    }];
  });
}

function acquisitionAttemptState(item, route) {
  const prefix = String(route?.coverage_id || "").split(".")[0];
  const attemptedStages = new Set((item?.attempts || []).map((attempt) => attempt?.stage));
  const terminalLadderRecorded = (route?.required_terminal_stages || [])
    .every((stage) => attemptedStages.has(stage));
  let officialSuccess = false;
  let directObservationSuccess = false;
  let citedInputSuccess = false;
  let derivedSuccess = false;
  for (const attempt of item?.attempts || []) {
    if (attempt?.result !== "succeeded") continue;
    const ids = Array.isArray(attempt.source_ids) ? attempt.source_ids : [];
    if (DERIVATION_SUCCESS_STAGES.has(attempt.stage)) derivedSuccess = true;
    if (!ids.length) continue;
    // A cited public market page is a fallback supplement, not an authorised source and not
    // a replacement for the frozen ladder. It contributes only after every required stage is
    // physically recorded for this row; otherwise fail-closed outcome normalization will make
    // the missing ladder visible to the validator.
    if (attempt.stage === "public_market_data") {
      if (terminalLadderRecorded) {
        if (PUBLIC_MARKET_DATA_PREFIXES.has(prefix)
          || PUBLIC_DIRECT_OBSERVATION_COVERAGE_IDS.has(route?.coverage_id)) {
          directObservationSuccess = true;
        }
        citedInputSuccess = true;
      }
      continue;
    }
    if (OFFICIAL_SUCCESS_STAGES.has(attempt.stage)) officialSuccess = true;
    if (attempt.stage === "public_consensus" && prefix === "expectations") directObservationSuccess = true;
    if (attempt.stage === "local_observation" && DIRECT_OBSERVATION_PREFIXES.has(prefix)) {
      directObservationSuccess = true;
    }
    if (attempt.stage !== "derived_proxy") citedInputSuccess = true;
  }
  return {
    officialSuccess,
    directObservationSuccess,
    reportedSourceSuccess: officialSuccess || directObservationSuccess,
    citedInputSuccess,
    derivedSuccess,
  };
}

function completeObservationRows(data, { derivation = false } = {}) {
  const observations = Array.isArray(data?.observations) ? data.observations : [];
  if (!observations.length) return false;
  return observations.every((observation) => {
    if (!observationValuePresent(observation?.value)) return false;
    if (!["metric", "unit", "period", "scope"].every((field) => nonEmpty(observation?.[field]))) return false;
    if (!derivation) return true;
    const formula = observation?.formula || data?.formula;
    const inputs = observation?.inputs || data?.inputs;
    return nonEmpty(formula) && Array.isArray(inputs) && inputs.length > 0;
  });
}

function completeActualData(data) {
  return (dataValuePresent(data) && ["unit", "period", "scope"].every((field) => nonEmpty(data?.[field])))
    || completeObservationRows(data);
}

function completeProxyData(data) {
  const inputs = data?.inputs;
  const scalar = dataValuePresent(data)
    && ["unit", "period", "formula"].every((field) => nonEmpty(data?.[field]))
    && Array.isArray(inputs) && inputs.length > 0;
  return scalar || completeObservationRows(data, { derivation: true });
}

function completeModeledData(data) {
  const range = data?.range;
  return Boolean(range)
    && [range.low, range.base, range.high].every(Number.isFinite)
    && range.low <= range.base && range.base <= range.high
    && ["unit", "period", "formula"].every((field) => nonEmpty(data?.[field]))
    && Array.isArray(data?.assumptions) && data.assumptions.length > 0;
}

function acquisitionOutcomeDeficiency(item, route) {
  if (!item || !["reported_actual", "recomputed_proxy", "modeled_estimate"].includes(item.outcome)) return null;
  const state = acquisitionAttemptState(item, route);
  const sourceIds = Array.isArray(item.source_ids) ? item.source_ids : [];
  const reasons = [];
  if (!sourceIds.length) reasons.push("no cited item source");
  if (item.outcome === "reported_actual") {
    if (!state.reportedSourceSuccess) reasons.push("no successful authorised or route-appropriate direct observation stage");
    if (!completeActualData(item.data)) reasons.push("actual data lacks a complete scalar or observation set");
  }
  if (item.outcome === "recomputed_proxy") {
    if (!state.derivedSuccess) reasons.push("no successful derived_proxy/local_observation stage");
    if (!state.citedInputSuccess) reasons.push("no successful cited input stage");
    if (!completeProxyData(item.data)) reasons.push("proxy data lacks complete value/formula/inputs or derived observations");
  }
  if (item.outcome === "modeled_estimate") {
    if (!state.derivedSuccess) reasons.push("no successful derived_proxy/local_observation stage");
    if (!state.citedInputSuccess) reasons.push("no successful cited input stage");
    if (!completeModeledData(item.data)) reasons.push("model data lacks a finite ordered range or required metadata");
  }
  return reasons.length ? reasons.join("; ") : null;
}

function failClosedAcquisitionOutcome(item, route) {
  const deficiency = acquisitionOutcomeDeficiency(item, route);
  if (!deficiency) return item;
  return {
    ...item,
    proposed_outcome: item.outcome,
    outcome: "unavailable",
    reason: nonEmpty(item.reason)
      ? item.reason
      : `Proposed ${item.outcome} was not publishable (${deficiency}); retained sourced partial coverage without publishing the unsupported value.`,
  };
}

/**
 * Bind worker-proposed acquisition metadata to the frozen server policy before validation.
 * The transformation may add labels around values the worker already returned, but never a
 * source, attempt, outcome, formula, assumption, range value, or external fact.
 */
export function canonicalizeCompanySourceAcquisitionPacket(packet, run) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return packet;
  if (!requiresOperatingCompanyDossier(run)) return packet;
  const plan = run?.grounding?.source_acquisition_plan;
  if (!plan) return packet;
  const task = packet.task;
  // The fixed 52-item roster belongs only to the eight core evidence roles. The three
  // all-scope breadth packets are still frozen into the dossier, but they do not own a
  // synthetic zero-row acquisition plan and must not be rejected for plan_missing.
  if (!Object.hasOwn(OPERATING_COMPANY_COVERAGE, task)) {
    delete packet.acquisition_ledger;
    return packet;
  }
  // The first-pass packet normalizer scopes worker IDs (S1 -> task:S1). A ledger-only repair
  // is intentionally merged after that pass, so accept either spelling and bind it back to
  // the already-frozen packet source. This cannot create a source: unresolved IDs still fail.
  const sourceIdMap = new Map();
  for (const source of packet.sources || []) {
    const id = typeof source?.id === "string" ? source.id.trim() : "";
    if (!id) continue;
    sourceIdMap.set(id, id);
    if (id.startsWith(`${task}:`)) sourceIdMap.set(id.slice(task.length + 1), id);
  }
  const ledger = normalizeCompanySourceAcquisitionLedger(packet.acquisition_ledger, task, sourceIdMap);
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return packet;
  const routeById = new Map((plan.tasks?.[task] || []).map((route) => [route.coverage_id, route]));
  const coverageById = new Map((packet.coverage_items || []).map((coverage) => [coverage?.id, coverage]));
  packet.acquisition_ledger = {
    ...ledger,
    items: Array.isArray(ledger.items) ? ledger.items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      let normalized = item;
      const coverage = coverageById.get(item.coverage_id);
      // The coverage row and ledger row describe the same server-owned domain. If the domain
      // is covered by resolved packet sources while the exact scalar is exhaustively marked
      // unavailable, bind those already-declared sources to the ledger row. This adds no fact,
      // URL or success claim; it removes a worker bookkeeping mismatch that otherwise discards
      // the whole packet despite the cited domain evidence remaining valid.
      if (item.outcome === "unavailable" && coverage?.status === "covered") {
        const coverageSourceIds = mappedSourceIds(coverage.source_ids, sourceIdMap);
        const existingSourceIds = Array.isArray(item.source_ids) ? item.source_ids : [];
        if (coverageSourceIds.length && !existingSourceIds.some((id) => coverageSourceIds.includes(id))) {
          normalized = { ...normalized, source_ids: unique([...existingSourceIds, ...coverageSourceIds]) };
        }
      }
      if (normalized.outcome === "unavailable" && coverage?.status !== "covered"
        && Array.isArray(normalized.attempts)) {
        normalized = {
          ...normalized,
          attempts: normalized.attempts.map((attempt) => (
            attempt?.result === "succeeded" && !DERIVATION_SUCCESS_STAGES.has(attempt.stage)
              ? { ...attempt, result: "not_disclosed", proposed_result: attempt.proposed_result || "succeeded" }
              : attempt
          )),
        };
      }
      if (normalized.outcome === "reported_actual" || (normalized.outcome === "recomputed_proxy" && Array.isArray(normalized.data?.observations))) {
        const observations = reportedActualObservations(normalized.data, normalized.coverage_id);
        if (observations.length) normalized = { ...normalized, data: { ...(normalized.data || {}), observations } };
      }
      return failClosedAcquisitionOutcome(normalized, routeById.get(normalized.coverage_id));
    }) : ledger.items,
  };
  return packet;
}

function addIssue(issues, path, keyword, message) {
  issues.push({ path, keyword, message });
}

export function companySourceAcquisitionIssues(packet, run) {
  if (!requiresOperatingCompanyDossier(run)) return [];
  canonicalizeCompanySourceAcquisitionPacket(packet, run);
  const task = packet?.task;
  const plan = run?.grounding?.source_acquisition_plan;
  const routes = plan?.tasks?.[task];
  const issues = [];
  // Legacy/replayed runs may carry a pre-1.2.1 grounding object with no frozen plan. Preserve
  // read/replay compatibility, but never claim the new acquisition policy ran. Every fresh
  // gatherGrounding path installs the plan and therefore takes the strict branch below.
  if (!plan) return issues;
  if (!Object.hasOwn(OPERATING_COMPANY_COVERAGE, task)) return issues;
  if (!Array.isArray(routes)) {
    addIssue(issues, "/acquisition_ledger", "plan_missing", `source acquisition plan is missing for ${task}`);
    return issues;
  }
  const ledger = packet?.acquisition_ledger;
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) {
    addIssue(issues, "/acquisition_ledger", "required", "operating-company evidence requires acquisition_ledger");
    return issues;
  }
  if (ledger.policy_id !== COMPANY_SOURCE_ACQUISITION_POLICY_ID) {
    addIssue(issues, "/acquisition_ledger/policy_id", "const", `must equal ${COMPANY_SOURCE_ACQUISITION_POLICY_ID}`);
  }
  if (ledger.task !== task) addIssue(issues, "/acquisition_ledger/task", "const", `must equal ${task}`);
  if (!Array.isArray(ledger.items)) {
    addIssue(issues, "/acquisition_ledger/items", "type", "must be an array");
    return issues;
  }
  const routeById = new Map(routes.map((route) => [route.coverage_id, route]));
  const coverageById = new Map((packet?.coverage_items || []).map((item) => [item?.id, item]));
  const sourceIds = new Set((packet?.sources || []).map((source) => source?.id));
  const seen = new Set();
  for (let index = 0; index < ledger.items.length; index += 1) {
    const item = ledger.items[index];
    const path = `/acquisition_ledger/items/${index}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      addIssue(issues, path, "type", "must be an object");
      continue;
    }
    const id = item.coverage_id;
    const route = routeById.get(id);
    if (!route) {
      addIssue(issues, `${path}/coverage_id`, "enum", "is not owned by this task");
      continue;
    }
    if (seen.has(id)) addIssue(issues, `${path}/coverage_id`, "unique", "appears more than once");
    seen.add(id);
    if (!OUTCOMES.has(item.outcome)) addIssue(issues, `${path}/outcome`, "enum", `must be one of ${COMPANY_DATA_OUTCOMES.join("|")}`);
    if (!Array.isArray(item.attempts)) {
      addIssue(issues, `${path}/attempts`, "type", "must be an array");
      continue;
    }
    const attemptedStages = new Set();
    for (let aIndex = 0; aIndex < item.attempts.length; aIndex += 1) {
      const attempt = item.attempts[aIndex];
      const aPath = `${path}/attempts/${aIndex}`;
      if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) {
        addIssue(issues, aPath, "type", "must be an object");
        continue;
      }
      if (!KNOWN_ACQUISITION_STAGES.has(attempt.stage)) {
        addIssue(issues, `${aPath}/stage`, "enum", "stage is not a recognized acquisition stage");
      }
      if (route.required_terminal_stages.includes(attempt.stage)) attemptedStages.add(attempt.stage);
      if (!["url", "query", "local"].includes(attempt.locator_type)) {
        addIssue(issues, `${aPath}/locator_type`, "enum", "must be url|query|local");
      }
      if (!nonEmpty(attempt.locator)) addIssue(issues, `${aPath}/locator`, "required", "must record the actual URL, query, or local ledger locator attempted");
      if (attempt.locator_type === "url" && !safeUrl(attempt.locator)) addIssue(issues, `${aPath}/locator`, "format", "url locator must be a safe absolute http(s) URL");
      if (!ATTEMPT_RESULTS.has(attempt.result)) addIssue(issues, `${aPath}/result`, "enum", `must be one of ${SOURCE_ATTEMPT_RESULTS.join("|")}`);
      const ids = Array.isArray(attempt.source_ids) ? attempt.source_ids : [];
      for (const sourceId of ids) if (!sourceIds.has(sourceId)) addIssue(issues, `${aPath}/source_ids`, "source_resolution", `${sourceId} does not resolve to packet.sources`);
      if (attempt.result === "succeeded" && !ids.length && attempt.stage !== "local_observation" && attempt.stage !== "derived_proxy") {
        addIssue(issues, `${aPath}/source_ids`, "minItems", "a successful external attempt requires at least one source id");
      }
    }
    const itemSourceIds = Array.isArray(item.source_ids) ? item.source_ids : [];
    for (const sourceId of itemSourceIds) if (!sourceIds.has(sourceId)) addIssue(issues, `${path}/source_ids`, "source_resolution", `${sourceId} does not resolve to packet.sources`);
    const coverage = coverageById.get(id);
    const coverageSourceIds = Array.isArray(coverage?.source_ids) ? coverage.source_ids : [];
    const sourceOverlap = itemSourceIds.some((sourceId) => coverageSourceIds.includes(sourceId));
    const hasSucceededAttempt = item.attempts.some((attempt) => attempt?.result === "succeeded");
    // `coverage_items=covered` means the domain has usable evidence, not that every desired
    // scalar exists. Preserve that partial evidence while the ledger explicitly marks the
    // unsupported exact outcome unavailable/not-applicable. This is fail-closed, not a pass:
    // it requires shared cited domain sources and the exhaustive attempt checks below. The
    // exact scalar may legitimately have no succeeded attempt—that is why it is unavailable.
    const partialCoveredOutcome = coverage?.status === "covered"
      && ["unavailable", "not_applicable"].includes(item.outcome)
      && itemSourceIds.length > 0
      && sourceOverlap
      && item.attempts.length > 0;
    if (coverage?.status === "covered" && ["unavailable", "not_applicable"].includes(item.outcome) && !partialCoveredOutcome) {
      addIssue(issues, `${path}/outcome`, "coverage_alignment", `coverage_items marks ${id} covered`);
    }
    if (coverage?.status === "unavailable" && item.outcome !== "unavailable") {
      addIssue(issues, `${path}/outcome`, "coverage_alignment", `coverage_items marks ${id} unavailable`);
    }
    if (coverage?.status === "not_applicable" && item.outcome !== "not_applicable") {
      addIssue(issues, `${path}/outcome`, "coverage_alignment", `coverage_items marks ${id} not_applicable`);
    }
    const attemptState = acquisitionAttemptState(item, route);
    if (item.outcome === "reported_actual") {
      if (!attemptState.reportedSourceSuccess) {
        addIssue(issues, `${path}/attempts`, "official_source", "reported_actual requires a successful authorised source or route-appropriate direct observation stage");
      }
      if (!itemSourceIds.length) addIssue(issues, `${path}/source_ids`, "minItems", "reported_actual requires cited source ids");
      const legacyActual = dataValuePresent(item.data)
        && ["unit", "period", "scope"].every((field) => nonEmpty(item.data?.[field]));
      const observations = Array.isArray(item.data?.observations) ? item.data.observations : [];
      if (!legacyActual && !observations.length) {
        addIssue(issues, `${path}/data`, "required", "reported_actual requires value/unit/period/scope or at least one structured observation");
      }
      observations.forEach((observation, observationIndex) => {
        const observationPath = `${path}/data/observations/${observationIndex}`;
        if (!observationValuePresent(observation?.value)) addIssue(issues, `${observationPath}/value`, "required", "observation requires a finite number, non-empty string, or boolean");
        for (const field of ["metric", "unit", "period", "scope"]) {
          if (!nonEmpty(observation?.[field])) addIssue(issues, `${observationPath}/${field}`, "required", `${field} is required`);
        }
      });
    }
    if (item.outcome === "recomputed_proxy") {
      if (!attemptState.derivedSuccess) addIssue(issues, `${path}/attempts`, "derived_stage", "recomputed_proxy requires a successful derived_proxy or local_observation stage");
      if (!attemptState.citedInputSuccess) addIssue(issues, `${path}/attempts`, "cited_input", "recomputed_proxy requires at least one successful cited input stage");
      if (!itemSourceIds.length) addIssue(issues, `${path}/source_ids`, "minItems", "recomputed_proxy requires cited source ids");
      const legacyProxy = dataValuePresent(item.data)
        && ["unit", "period", "formula"].every((field) => nonEmpty(item.data?.[field]))
        && Array.isArray(item.data?.inputs) && item.data.inputs.length > 0;
      const observations = Array.isArray(item.data?.observations) ? item.data.observations : [];
      if (!legacyProxy && !observations.length) {
        addIssue(issues, `${path}/data`, "required", "recomputed_proxy requires value/unit/period/formula/inputs or derived observations");
      }
      observations.forEach((observation, observationIndex) => {
        const observationPath = `${path}/data/observations/${observationIndex}`;
        if (!observationValuePresent(observation?.value)) addIssue(issues, `${observationPath}/value`, "required", "observation requires a finite number, non-empty string, or boolean");
        for (const field of ["metric", "unit", "period", "scope"]) {
          if (!nonEmpty(observation?.[field])) addIssue(issues, `${observationPath}/${field}`, "required", `${field} is required`);
        }
        if (!nonEmpty(observation?.formula || item.data?.formula)) addIssue(issues, `${observationPath}/formula`, "required", "derived observation requires a formula");
        const inputs = observation?.inputs || item.data?.inputs;
        if (!Array.isArray(inputs) || !inputs.length) addIssue(issues, `${observationPath}/inputs`, "minItems", "derived observation requires cited inputs");
      });
    }
    if (item.outcome === "modeled_estimate") {
      if (!attemptState.derivedSuccess) addIssue(issues, `${path}/attempts`, "derived_stage", "modeled_estimate requires a successful derived_proxy or local_observation stage");
      if (!attemptState.citedInputSuccess) addIssue(issues, `${path}/attempts`, "cited_input", "modeled_estimate requires at least one successful cited input stage");
      if (!itemSourceIds.length) addIssue(issues, `${path}/source_ids`, "minItems", "modeled_estimate requires cited source ids");
      const range = item.data?.range;
      if (!range || ![range.low, range.base, range.high].every(Number.isFinite) || !(range.low <= range.base && range.base <= range.high)) {
        addIssue(issues, `${path}/data/range`, "range", "modeled_estimate requires finite ordered low/base/high values");
      }
      for (const field of ["unit", "period", "formula"]) if (!nonEmpty(item.data?.[field])) addIssue(issues, `${path}/data/${field}`, "required", `${field} is required`);
      if (!Array.isArray(item.data?.assumptions) || !item.data.assumptions.length) addIssue(issues, `${path}/data/assumptions`, "minItems", "modeled_estimate requires explicit assumptions");
    }
    if (item.outcome === "unavailable") {
      if (hasSucceededAttempt && !partialCoveredOutcome) {
        addIssue(issues, `${path}/attempts`, "terminal_result", "unavailable cannot contain succeeded; use not_disclosed for an opened source that did not disclose the field");
      }
      for (const stage of route.required_terminal_stages) {
        if (!attemptedStages.has(stage)) addIssue(issues, `${path}/attempts`, "exhaustive", `unavailable requires an attempt for frozen stage ${stage}`);
      }
      if (item.attempts.length < route.minimum_terminal_attempts) addIssue(issues, `${path}/attempts`, "minItems", `unavailable requires at least ${route.minimum_terminal_attempts} attempts`);
      if (!nonEmpty(item.reason)) addIssue(issues, `${path}/reason`, "required", "unavailable requires a concrete terminal reason");
    }
    if (item.outcome === "not_applicable" && !nonEmpty(item.reason)) {
      addIssue(issues, `${path}/reason`, "required", "not_applicable requires a concrete reason");
    }
  }
  for (const id of routeById.keys()) if (!seen.has(id)) addIssue(issues, "/acquisition_ledger/items", "required", `missing acquisition row for ${id}`);
  return issues;
}

export function assertCompanySourceAcquisition(packet, run, { client = false } = {}) {
  const issues = companySourceAcquisitionIssues(packet, run);
  if (!issues.length) return packet;
  const factory = client ? invalidParams : internalError;
  throw factory("evidence failed the company source-acquisition gate", {
    reason: client ? "VISIBLE_SOURCE_ACQUISITION_MISMATCH" : "WORKER_SOURCE_ACQUISITION_MISMATCH",
    schema_id: COMPANY_SOURCE_ACQUISITION_POLICY_ID,
    task: packet?.task || null,
    errors: issues.slice(0, 80),
  });
}

export function sourceAcquisitionPromptBlock(plan, task, language = "English") {
  const routes = plan?.tasks?.[task];
  if (!Array.isArray(routes) || !routes.length) return "";
  const chinese = /中文|chinese|zh/i.test(String(language));
  const compact = routes.map((route) => ({
    coverage_id: route.coverage_id,
    required_terminal_stages: route.required_terminal_stages,
    stages: route.stages,
    recovery: route.recovery,
  }));
  const contract = chinese
    ? [
      "## 公司无关来源获取契约（强制）",
      "固定新闻 feed 只是线索入口，不是完成条件。对本席位每个 coverage_id 按冻结来源梯逐层执行；找到实际披露可以停止该项，其余情况必须继续到客户、供应商、同业、监管或可复算代理阶段。",
      `顶层必须返回 acquisition_ledger={policy_id:"${COMPANY_SOURCE_ACQUISITION_POLICY_ID}",task:"${task}",items}，items 与本席位 coverage_id 一一对应。policy_id、task 和 coverage_id 是服务器冻结值，不得改名或自行选择。每项记录 outcome、source_ids、attempts、data/reason。attempts 每行固定为 {stage,locator_type:url|query|local,locator,result:succeeded|not_found|not_disclosed|unreachable|blocked|not_applicable,source_ids,note}。`,
      "outcome 只能是 reported_actual / recomputed_proxy / modeled_estimate / unavailable / not_applicable。reported_actual 来自有权主体正式披露，或该路由允许的带来源市场/共识/本地直接观测，并返回 data={value,unit,period,scope}；一个 coverage_id 含多个指标时改用 data={observations:[{metric,value,unit,period,scope}]}。recomputed_proxy 必须给 value/unit/period/formula/inputs，多个派生指标可用 observations 且逐项或顶层给 formula/inputs；modeled_estimate 必须把数值 low/base/high 放在 data.range 中，并给 unit/period/formula/assumptions。代理和模型都不能冒充 actual。",
      "引用非官方公开行情网页时，补充阶段必须准确写成 public_market_data。它不是 market_official，也不能替代任何冻结 required_terminal_stage；不得把任务名 market_data 当作阶段名。",
      "只有冻结 required_terminal_stages 全部留下实际 URL、查询或本地账本定位后，才允许 unavailable。网页成功打开但没有披露目标字段时，attempt.result 必须写 not_disclosed，即使 source_ids 保留该网页；不得把传输成功写成数据 succeeded。领域已有带来源证据、但精确目标值仍不可发布时，coverage_items 可保持 covered，账本必须保留共同 source_ids、完整逐层尝试和具体 unavailable reason；精确目标没有 succeeded 尝试本身不矛盾，因为该目标正是 unavailable。不得把缺失区间或缺失公式的估计冒充完整数值。只写‘未找到’而没有逐层尝试会被运行时拒绝。可记录冻结路由之外的已知补充来源阶段，但它不能替代 required_terminal_stages。",
      `固定账本外壳：${JSON.stringify({ policy_id: COMPANY_SOURCE_ACQUISITION_POLICY_ID, task, items: compact.map((route) => ({ coverage_id: route.coverage_id })) })}`,
      `冻结来源计划：${JSON.stringify(compact)}`,
    ]
    : [
      "## Company-agnostic source-acquisition contract (mandatory)",
      "Fixed news feeds are discovery leads, not completion. Execute the frozen ladder for every coverage_id. A direct authorised disclosure may stop that item; otherwise continue through customer, supplier, peer, regulator, or reproducible-proxy stages.",
      `Return top-level acquisition_ledger={policy_id:"${COMPANY_SOURCE_ACQUISITION_POLICY_ID}",task:"${task}",items}, exactly one item per coverage_id. policy_id, task and coverage_id are server-frozen bindings; never rename or choose them. Each item records outcome, source_ids, attempts, and data/reason. Every attempt is {stage,locator_type:url|query|local,locator,result:succeeded|not_found|not_disclosed|unreachable|blocked|not_applicable,source_ids,note}.`,
      "Outcome is only reported_actual / recomputed_proxy / modeled_estimate / unavailable / not_applicable. reported_actual needs an authorised disclosure or a route-appropriate sourced market/consensus/local direct observation and data={value,unit,period,scope}; when one coverage id contains several metrics, use data={observations:[{metric,value,unit,period,scope}]}. recomputed_proxy needs value/unit/period/formula/inputs, or observations with per-row/top-level formula and inputs. modeled_estimate needs data.range={low,base,high} plus unit/period/formula/assumptions. Neither may be labelled actual.",
      "For a cited non-official public market-data page, use the supplemental stage public_market_data exactly. It is not market_official and never replaces a frozen required_terminal_stage. Never use the task id market_data as a stage name.",
      "unavailable is allowed only after every frozen required_terminal_stage records the URL, query, or local-ledger locator actually attempted. If a page opened but did not disclose the target field, attempt.result must be not_disclosed even when source_ids retain that page; transport success is not data succeeded. When the domain has sourced partial evidence but the exact target is not publishable, coverage_items may remain covered only if the ledger retains the shared source_ids, the complete attempt ladder, and a concrete unavailable reason. No succeeded attempt for the exact target is inherently consistent with unavailable. Never publish an estimate with a missing range/formula. Known extra source stages may be recorded but do not replace required_terminal_stages. A bare 'not found' fails the runtime gate.",
      `Frozen ledger shell: ${JSON.stringify({ policy_id: COMPANY_SOURCE_ACQUISITION_POLICY_ID, task, items: compact.map((route) => ({ coverage_id: route.coverage_id })) })}`,
      `Frozen source plan: ${JSON.stringify(compact)}`,
    ];
  return contract.join("\n");
}
