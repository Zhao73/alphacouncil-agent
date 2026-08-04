import { createHash } from "node:crypto";
import { internalError, invalidParams } from "./errors.mjs";
import { OPERATING_COMPANY_COVERAGE, requiresOperatingCompanyDossier } from "./company-dossier.mjs";
import { applyRecencyGate, filingsFeed, parseFeed, queryNewsFeed, tickerNewsFeed } from "./feeds.mjs";
import { marketFor } from "./markets.mjs";
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
const MAX_OFFICIAL_DETAIL_PAGES = 6;
const MAX_STARTER_NEWS_ITEMS = 80;
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
  "financials.earnings_call_qna": ["issuer_ir", "regulator_filing", "disconfirming_search"],
  "expectations.consensus_revenue_eps": [
    "issuer_ir", "public_consensus", "local_observation", "disconfirming_search",
  ],
  "expectations.estimate_dispersion_revisions": [
    "public_consensus", "local_observation", "issuer_ir", "disconfirming_search", "derived_proxy",
  ],
  "expectations.ratings_target_changes": [
    "public_consensus", "local_observation", "issuer_ir", "disconfirming_search",
  ],
  "quant.short_interest_borrow": [
    "market_official", "local_observation", "disconfirming_search", "derived_proxy",
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

function safeUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    const host = parsed.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || /^127\./u.test(host)
      || host === "::1" || /^10\./u.test(host) || /^192\.168\./u.test(host)
      || /^169\.254\./u.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)) return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
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

async function fetchOfficialRoot(url, { signal, fetchImpl, timeoutMs }) {
  const safe = safeUrl(url);
  if (!safe) return { url, status: "blocked", reason: "unsafe_or_non_http_url", links: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort();
  signal?.addEventListener?.("abort", relayAbort, { once: true });
  try {
    const response = await fetchImpl(safe, {
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "AlphaCouncilAgent/1.0 public-equity research contact: github.com/Zhao73/alphacouncil-agent",
      },
      redirect: "follow",
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
      excerpt: htmlExcerpt(body),
      content_hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      retrieved_at: retrievedAt,
      links: extractOfficialLinks(body, finalUrl, [safe, finalUrl]),
      feeds: extractFeedLinks(body, finalUrl, [safe, finalUrl]),
    };
  } catch (error) {
    return {
      url: safe,
      status: "unreachable",
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
  fetchImpl = fetch,
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
  const rootAttempts = await Promise.all(roots.map((url) => fetchOfficialRoot(url, { signal, fetchImpl, timeoutMs })));
  const discoveredPages = unique(rootAttempts.flatMap((attempt) => attempt.links || []));
  const detailUrls = discoveredPages
    .filter((url) => !roots.includes(url))
    .slice(0, MAX_OFFICIAL_DETAIL_PAGES);
  const detailAttempts = await Promise.all(detailUrls.map((url) => fetchOfficialRoot(url, { signal, fetchImpl, timeoutMs })));
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
    { topic: "management_capital_allocation", ...queryNewsFeed(`${identity} management OR board OR insider OR buyback OR debt`) },
  ];
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

async function fetchStarterFeed(spec, { signal, fetchImpl, timeoutMs }) {
  const url = safeUrl(spec.url);
  if (!url) return { ...spec, url: spec.url, ok: false, reason: "unsafe_or_non_http_url", items: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener?.("abort", relayAbort, { once: true });
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/rss+xml,application/atom+xml,application/xml,text/xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": secUserAgent(),
      },
      redirect: "follow",
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
  fetchImpl = fetch,
  timeoutMs = 12_000,
  days = 45,
} = {}) {
  const specs = companyStarterFeedSpecs({ symbol, profile, issuerIndex });
  const attempts = await Promise.all(specs.map((spec) => fetchStarterFeed(spec, {
    signal, fetchImpl, timeoutMs,
  })));
  const allItems = attempts.flatMap((attempt) => attempt.items.map((item) => ({
    ...item,
    topic: attempt.topic,
    feed_url: attempt.url,
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
  const news = [];
  const seen = new Set();
  for (const item of recency.included) {
    const key = `${String(item.link || "").trim()}|${String(item.title || "").trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    news.push(item);
    if (news.length >= MAX_STARTER_NEWS_ITEMS) break;
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
    issuer_documents: issuerIndex?.documents || [],
    news,
    feed_attempts: attempts.map((attempt) => ({
      topic: attempt.topic,
      source: attempt.source,
      url: attempt.url,
      ok: attempt.ok,
      reason: attempt.reason || null,
      raw_item_count: attempt.items.length,
    })),
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
    issuerUrls, sicDescription,
  } = context;
  const quoted = `"${issuer}"`;
  const suffix = `${topic} ${asOf}`;
  const regulatorSites = domainQuery(regulatorDomains);
  const marketSites = domainQuery(marketDomains);
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
    public_consensus: [ `${symbol} analyst consensus revenue EPS target revision ${asOf}` ],
    local_observation: [ `local:${symbol}:${coverageIdSafe(topic)}` ],
    customer_official: [ `${quoted} customer capex orders acceptance deployment official ${suffix}` ],
    supplier_official: [ `${quoted} supplier capacity yield shipment official ${suffix}` ],
    competitor_official: [ `${quoted} competitor guidance ${sicDescription || "industry"} official ${suffix}` ],
    peer_filing: [ `${quoted} peer filing ${sicDescription || "industry"} ${suffix}` ],
    counterparty_official: [ `${quoted} counterparty material contract official ${suffix}` ],
    other_regulator: [ `${quoted} ${topic} site:ftc.gov OR site:justice.gov OR site:commerce.gov ${asOf}` ],
    court_record: [ `${quoted} ${topic} court docket official ${asOf}` ],
    disconfirming_search: [ `${quoted} guidance cut delay cancellation accounting concern litigation ${asOf}` ],
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

export function normalizeCompanySourceAcquisitionLedger(value, task, sourceIdMap = new Map()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return {
    policy_id: typeof value.policy_id === "string" ? value.policy_id.trim() : value.policy_id,
    task: typeof value.task === "string" ? value.task.trim() : value.task,
    items: Array.isArray(value.items) ? value.items.map((item) => ({
      ...(item && typeof item === "object" ? item : {}),
      coverage_id: typeof item?.coverage_id === "string" ? item.coverage_id.trim() : item?.coverage_id,
      outcome: typeof item?.outcome === "string" ? item.outcome.trim() : item?.outcome,
      source_ids: mappedSourceIds(item?.source_ids, sourceIdMap),
      attempts: Array.isArray(item?.attempts) ? item.attempts.map((attempt) => ({
        ...(attempt && typeof attempt === "object" ? attempt : {}),
        stage: typeof attempt?.stage === "string" ? attempt.stage.trim() : attempt?.stage,
        locator_type: typeof attempt?.locator_type === "string" ? attempt.locator_type.trim() : attempt?.locator_type,
        locator: typeof attempt?.locator === "string" ? attempt.locator.trim() : attempt?.locator,
        result: typeof attempt?.result === "string" ? attempt.result.trim() : attempt?.result,
        source_ids: mappedSourceIds(attempt?.source_ids, sourceIdMap),
      })) : item?.attempts,
      data: item?.data && typeof item.data === "object" && !Array.isArray(item.data)
        ? {
          ...item.data,
          source_ids: mappedSourceIds(item.data.source_ids, sourceIdMap),
          inputs: Array.isArray(item.data.inputs) ? item.data.inputs.map((input) => ({
            ...(input && typeof input === "object" ? input : {}),
            source_ids: mappedSourceIds(input?.source_ids, sourceIdMap),
          })) : item.data.inputs,
        }
        : item?.data,
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

function addIssue(issues, path, keyword, message) {
  issues.push({ path, keyword, message });
}

export function companySourceAcquisitionIssues(packet, run) {
  if (!requiresOperatingCompanyDossier(run)) return [];
  const task = packet?.task;
  const plan = run?.grounding?.source_acquisition_plan;
  const routes = plan?.tasks?.[task];
  const issues = [];
  // Legacy/replayed runs may carry a pre-1.2.1 grounding object with no frozen plan. Preserve
  // read/replay compatibility, but never claim the new acquisition policy ran. Every fresh
  // gatherGrounding path installs the plan and therefore takes the strict branch below.
  if (!plan) return issues;
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
    let officialSuccess = false;
    let derivedSuccess = false;
    for (let aIndex = 0; aIndex < item.attempts.length; aIndex += 1) {
      const attempt = item.attempts[aIndex];
      const aPath = `${path}/attempts/${aIndex}`;
      if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) {
        addIssue(issues, aPath, "type", "must be an object");
        continue;
      }
      if (!route.required_terminal_stages.includes(attempt.stage)) {
        addIssue(issues, `${aPath}/stage`, "enum", "stage is not in the frozen route");
      } else attemptedStages.add(attempt.stage);
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
      if (attempt.result === "succeeded" && OFFICIAL_SUCCESS_STAGES.has(attempt.stage) && ids.length) officialSuccess = true;
      if (attempt.result === "succeeded" && attempt.stage === "derived_proxy") derivedSuccess = true;
    }
    const itemSourceIds = Array.isArray(item.source_ids) ? item.source_ids : [];
    for (const sourceId of itemSourceIds) if (!sourceIds.has(sourceId)) addIssue(issues, `${path}/source_ids`, "source_resolution", `${sourceId} does not resolve to packet.sources`);
    const coverage = coverageById.get(id);
    if (coverage?.status === "covered" && ["unavailable", "not_applicable"].includes(item.outcome)) {
      addIssue(issues, `${path}/outcome`, "coverage_alignment", `coverage_items marks ${id} covered`);
    }
    if (coverage?.status === "unavailable" && item.outcome !== "unavailable") {
      addIssue(issues, `${path}/outcome`, "coverage_alignment", `coverage_items marks ${id} unavailable`);
    }
    if (coverage?.status === "not_applicable" && item.outcome !== "not_applicable") {
      addIssue(issues, `${path}/outcome`, "coverage_alignment", `coverage_items marks ${id} not_applicable`);
    }
    if (item.outcome === "reported_actual") {
      if (!officialSuccess) addIssue(issues, `${path}/attempts`, "official_source", "reported_actual requires a successful official-source stage");
      if (!itemSourceIds.length) addIssue(issues, `${path}/source_ids`, "minItems", "reported_actual requires cited source ids");
      if (!dataValuePresent(item.data)) addIssue(issues, `${path}/data/value`, "required", "reported_actual requires a non-null value");
      for (const field of ["unit", "period", "scope"]) if (!nonEmpty(item.data?.[field])) addIssue(issues, `${path}/data/${field}`, "required", `${field} is required`);
    }
    if (item.outcome === "recomputed_proxy") {
      if (!derivedSuccess) addIssue(issues, `${path}/attempts`, "derived_stage", "recomputed_proxy requires a successful derived_proxy stage");
      if (!officialSuccess) addIssue(issues, `${path}/attempts`, "official_input", "recomputed_proxy requires at least one successful official-source input stage");
      if (!itemSourceIds.length) addIssue(issues, `${path}/source_ids`, "minItems", "recomputed_proxy requires cited source ids");
      if (!dataValuePresent(item.data)) addIssue(issues, `${path}/data/value`, "required", "recomputed_proxy requires a non-null value");
      for (const field of ["unit", "period", "formula"]) if (!nonEmpty(item.data?.[field])) addIssue(issues, `${path}/data/${field}`, "required", `${field} is required`);
      if (!Array.isArray(item.data?.inputs) || !item.data.inputs.length) addIssue(issues, `${path}/data/inputs`, "minItems", "recomputed_proxy requires cited inputs");
    }
    if (item.outcome === "modeled_estimate") {
      if (!derivedSuccess) addIssue(issues, `${path}/attempts`, "derived_stage", "modeled_estimate requires a successful derived_proxy stage");
      if (!officialSuccess) addIssue(issues, `${path}/attempts`, "official_input", "modeled_estimate requires at least one successful official-source input stage");
      if (!itemSourceIds.length) addIssue(issues, `${path}/source_ids`, "minItems", "modeled_estimate requires cited source ids");
      const range = item.data?.range;
      if (!range || ![range.low, range.base, range.high].every(Number.isFinite) || !(range.low <= range.base && range.base <= range.high)) {
        addIssue(issues, `${path}/data/range`, "range", "modeled_estimate requires finite ordered low/base/high values");
      }
      for (const field of ["unit", "period", "formula"]) if (!nonEmpty(item.data?.[field])) addIssue(issues, `${path}/data/${field}`, "required", `${field} is required`);
      if (!Array.isArray(item.data?.assumptions) || !item.data.assumptions.length) addIssue(issues, `${path}/data/assumptions`, "minItems", "modeled_estimate requires explicit assumptions");
    }
    if (item.outcome === "unavailable") {
      if (item.attempts.some((attempt) => attempt?.result === "succeeded")) {
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
      "顶层必须返回 acquisition_ledger={policy_id,task,items}，items 与本席位 coverage_id 一一对应。每项记录 outcome、source_ids、attempts、data/reason。attempts 每行固定为 {stage,locator_type:url|query|local,locator,result:succeeded|not_found|not_disclosed|unreachable|blocked|not_applicable,source_ids,note}。",
      "outcome 只能是 reported_actual / recomputed_proxy / modeled_estimate / unavailable / not_applicable。reported_actual 只能来自有权主体正式披露；recomputed_proxy 必须给 value/unit/period/formula/inputs；modeled_estimate 必须给 unit/period/formula/assumptions 和数值 low/base/high；两者都不能冒充 actual。",
      "只有冻结 required_terminal_stages 全部留下实际 URL、查询或本地账本定位后，才允许 unavailable。只写‘未找到’而没有逐层尝试会被运行时拒绝。",
      `冻结来源计划：${JSON.stringify(compact)}`,
    ]
    : [
      "## Company-agnostic source-acquisition contract (mandatory)",
      "Fixed news feeds are discovery leads, not completion. Execute the frozen ladder for every coverage_id. A direct authorised disclosure may stop that item; otherwise continue through customer, supplier, peer, regulator, or reproducible-proxy stages.",
      "Return top-level acquisition_ledger={policy_id,task,items}, exactly one item per coverage_id. Each item records outcome, source_ids, attempts, and data/reason. Every attempt is {stage,locator_type:url|query|local,locator,result:succeeded|not_found|not_disclosed|unreachable|blocked|not_applicable,source_ids,note}.",
      "Outcome is only reported_actual / recomputed_proxy / modeled_estimate / unavailable / not_applicable. reported_actual needs an authorised official disclosure. recomputed_proxy needs value/unit/period/formula/inputs. modeled_estimate needs unit/period/formula/assumptions and numeric low/base/high. Neither may be labelled actual.",
      "unavailable is allowed only after every frozen required_terminal_stage records the URL, query, or local-ledger locator actually attempted. A bare 'not found' fails the runtime gate.",
      `Frozen source plan: ${JSON.stringify(compact)}`,
    ];
  return contract.join("\n");
}
