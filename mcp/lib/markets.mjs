import { LIMITS } from "./constants.mjs";
import { invalidParams } from "./errors.mjs";
import { fetchQuote } from "./quotes.mjs";
import { linkedAbort } from "./abort.mjs";
import { fetchDartFinancials, fetchEdinetFilings } from "./markets-kr-jp.mjs";

/**
 * Where structured financials come from, per market, and what to do when they do not.
 *
 * The pipeline was US-only in everything but name: an industry map could list SK hynix
 * and Kioxia, and then nothing could fetch a number for them. This declares the real
 * capability of each market and degrades in a stated order rather than silently
 * producing a US-only answer dressed as a global one.
 *
 * Tiers, in the order they are tried:
 *   1. keyless regulator feed  -- SEC (US), TWSE (TW)
 *   2. regulator feed needing a free key -- DART (KR), EDINET (JP); reported as
 *      not_configured rather than pretended away
 *   3. quotes, which work everywhere, plus search -- always labelled as such, because a
 *      price is not a financial statement
 */

export const MARKETS = {
  US: {
    id: "US",
    suffixes: [""],
    regulator: "SEC EDGAR",
    tier: "keyless",
    capability: "full",
    note: "companyfacts XBRL: full statements with filing dates.",
  },
  TW: {
    id: "TW",
    suffixes: [".TW", ".TWO"],
    regulator: "TWSE OpenAPI",
    tier: "keyless",
    capability: "summary",
    note: "quarterly income-statement summary for listed companies; no full XBRL history.",
  },
  KR: {
    id: "KR",
    suffixes: [".KS", ".KQ"],
    regulator: "DART (opendart.fss.or.kr)",
    tier: "free_key",
    env: "ALPHACOUNCIL_DART_KEY",
    capability: "full",
    note: "full filings, but requires a free API key. Register at opendart.fss.or.kr.",
  },
  JP: {
    id: "JP",
    suffixes: [".T"],
    regulator: "EDINET v2 (api.edinet-fsa.go.jp)",
    tier: "free_key",
    env: "ALPHACOUNCIL_EDINET_KEY",
    capability: "full",
    note: "full filings, but requires a free subscription key from the EDINET portal.",
  },
  HK: {
    id: "HK",
    suffixes: [".HK"],
    regulator: "HKEXnews",
    tier: "none",
    capability: "documents_only",
    note: "no machine-readable financial API; filings are PDFs. Use search plus WebFetch on hkexnews.hk.",
  },
  CN: {
    id: "CN",
    suffixes: [".SS", ".SZ"],
    regulator: "cninfo / 巨潮资讯",
    tier: "none",
    capability: "documents_only",
    note: "no stable public API; filings are PDFs. Use search plus WebFetch on cninfo.com.cn.",
  },
};

export function marketFor(symbol) {
  const text = String(symbol || "").trim().toUpperCase();
  if (!text) return null;
  for (const market of Object.values(MARKETS)) {
    if (market.id === "US") continue;
    if (market.suffixes.some((s) => s && text.endsWith(s))) return market;
  }
  // No recognised suffix means a plain US ticker.
  return /^[A-Z0-9.\-]{1,10}$/.test(text) ? MARKETS.US : null;
}

/** Is a market's primary feed actually usable right now? */
export function feedStatus(market) {
  if (!market) return { available: false, reason: "unrecognised market" };
  if (market.tier === "keyless") return { available: true, tier: "keyless" };
  if (market.tier === "free_key") {
    const configured = Boolean(process.env[market.env]);
    return {
      available: configured,
      tier: "free_key",
      env: market.env,
      reason: configured ? undefined : `${market.regulator} needs ${market.env}; ${market.note}`,
    };
  }
  return { available: false, tier: "none", reason: market.note };
}

// ---- Taiwan: the one non-US feed that needs no key -------------------------

let twseCache = null;
let twseCachedAt = 0;
const TWSE_TTL_MS = 6 * 60 * 60 * 1000;

async function twseIncomeStatements(upstreamSignal) {
  if (twseCache && Date.now() - twseCachedAt < TWSE_TTL_MS) return twseCache;
  const abort = linkedAbort(LIMITS.QUOTE_FETCH_MS * 2, upstreamSignal);
  try {
    const res = await fetch("https://openapi.twse.com.tw/v1/opendata/t187ap06_L_ci", {
      signal: abort.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    twseCache = await res.json();
    twseCachedAt = Date.now();
    return twseCache;
  } finally {
    abort.cleanup();
  }
}

/**
 * Read a TWSE field by name, returning null when the field is absent.
 *
 * TWSE uses full-width parentheses -- 營業毛利（毛損）, not 營業毛利(毛損). Getting that
 * wrong made gross profit and operating income read as 0 for every Taiwanese company:
 * a wrong number that looks like a real one, which is worse than a gap.
 */
const twField = (row, key) => {
  if (!(key in row)) throw new Error(`TWSE field "${key}" is not in the dataset; the schema changed`);
  const raw = String(row[key] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** Latest reported quarter for a Taiwan listed company, in TWD thousands as filed. */
export async function fetchTaiwanFinancials(symbol, { signal } = {}) {
  const code = String(symbol).toUpperCase().replace(/\.(TW|TWO)$/, "");
  const rows = await twseIncomeStatements(signal);
  const match = rows.filter((r) => String(r["公司代號"]) === code);
  if (!match.length) return null;
  const row = match[match.length - 1];
  return {
    market: "TW",
    source: "TWSE OpenAPI",
    company_code: code,
    company_name: row["公司名稱"],
    period: { year: row["年度"], quarter: row["季別"] },
    reported_at: row["出表日期"],
    currency: "TWD",
    unit: "thousands as filed",
    // TWSE reports the ROC calendar; 115 is 2026.
    calendar: "ROC",
    gregorian_year: Number(row["年度"]) + 1911,
    revenue: twField(row, "營業收入"),
    cost_of_revenue: twField(row, "營業成本"),
    gross_profit: twField(row, "營業毛利（毛損）"),
    operating_expenses: twField(row, "營業費用"),
    operating_income: twField(row, "營業利益（損失）"),
    pretax_income: twField(row, "稅前淨利（淨損）"),
    net_income: twField(row, "本期淨利（淨損）"),
    eps: twField(row, "基本每股盈餘（元）"),
    note: "Quarterly summary only. TWSE publishes no full XBRL history, so multi-year rules cannot be computed from this source.",
  };
}

/**
 * Structured financials for any market, degrading in a stated order.
 *
 * Never returns an empty result silently: when the primary feed is unavailable it says
 * which feed, why, and what the caller should do instead.
 */
export async function fetchMarketFinancials(symbol, extra = {}) {
  const market = marketFor(symbol);
  if (!market) throw invalidParams(`cannot identify a market for symbol "${symbol}"`);
  const status = feedStatus(market);

  const base = {
    symbol,
    market: market.id,
    regulator: market.regulator,
    feed: status,
  };

  if (market.id === "US") {
    return {
      ...base,
      financials: null,
      guidance: "US filer: use list_us_universe to resolve the CIK, then screen_ticker or compose_research_brief for full XBRL history.",
    };
  }

  if (market.id === "TW" && status.available) {
    const financials = await fetchTaiwanFinancials(symbol, { signal: extra.signal }).catch(() => null);
    if (financials) return { ...base, financials, guidance: financials.note };
    return { ...base, financials: null, guidance: `Not found in the TWSE dataset for ${symbol}. Fall back to the quote and to search.` };
  }

  if (market.id === "KR" && status.available) {
    const kr = await fetchDartFinancials({ corpCode: extra.corp_code, year: extra.year || new Date().getFullYear() - 1 })
      .catch((e) => ({ available: false, reason: String(e?.message || e) }));
    if (kr.available) return { ...base, financials: kr, guidance: kr.note };
    return { ...base, financials: null, guidance: kr.reason };
  }

  if (market.id === "JP" && status.available) {
    const jp = await fetchEdinetFilings({ secCode: symbol }).catch((e) => ({ available: false, reason: String(e?.message || e) }));
    if (jp.available) return { ...base, financials: null, filings: jp.filings, guidance: jp.note };
    return { ...base, financials: null, guidance: jp.reason };
  }

  // Everything else: say what is missing and fall back to what always works.
  const quote = await fetchQuote(symbol, { signal: extra.signal }).catch((e) => ({ error: String(e?.message || e) }));
  return {
    ...base,
    financials: null,
    fallback: {
      quote: quote && !quote.error ? quote : null,
      quote_error: quote?.error,
      // A price is not a financial statement and the report must not treat it as one.
      caveat: "A quote is market data, not a financial statement. Any statement about margins, "
        + "cash flow or leverage for this name has to come from search over primary documents, "
        + "and must be cited as such.",
    },
    guidance: status.available
      ? `No structured adapter for ${market.regulator} yet. Use search plus WebFetch on the regulator's site.`
      : `${status.reason} Until then, use search plus WebFetch on the regulator's site and label the figures as sourced from documents rather than a structured feed.`,
  };
}

/** What the pipeline can and cannot do for a set of symbols. Answers it up front. */
export function coverageFor(symbols = []) {
  const rows = symbols.map((symbol) => {
    const market = marketFor(symbol);
    const status = market ? feedStatus(market) : { available: false, reason: "unrecognised" };
    return {
      symbol,
      market: market?.id ?? "unknown",
      regulator: market?.regulator ?? "-",
      structured_financials: status.available ? (market.capability === "summary" ? "summary only" : "yes") : "no",
      reason: status.reason,
      needs_env: market?.env && !status.available ? market.env : undefined,
    };
  });
  return {
    rows,
    summary: {
      full: rows.filter((r) => r.structured_financials === "yes").length,
      summary_only: rows.filter((r) => r.structured_financials === "summary only").length,
      none: rows.filter((r) => r.structured_financials === "no").length,
    },
    note: "Names without structured financials are not excluded from research -- they are researched from "
      + "documents and search, and every figure taken that way must be labelled as such so a reader can tell "
      + "which numbers came from a filing feed and which came from a document someone read.",
  };
}
