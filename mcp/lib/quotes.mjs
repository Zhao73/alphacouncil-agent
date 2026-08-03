import { LIMITS } from "./constants.mjs";
import { linkedAbort } from "./abort.mjs";
import { invalidParams } from "./errors.mjs";

// ---- Keyless delayed market data (Yahoo primary, Stooq fallback) ------------
export const MARKET_ALIASES = {
  kospi: "^KS11", "韩股": "^KS11", "韩国综合": "^KS11", kospi200: "^KS200",
  "标普": "^GSPC", "标普500": "^GSPC", sp500: "^GSPC", spx: "^GSPC",
  "纳指": "^IXIC", "纳斯达克": "^IXIC", "道指": "^DJI", "道琼斯": "^DJI",
  "罗素2000": "^RUT", "恒生": "^HSI", "恒指": "^HSI",
  "上证": "000001.SS", "上证指数": "000001.SS", "深证": "399001.SZ",
  "沪深300": "000300.SS", "创业板": "399006.SZ",
  "日经": "^N225", "日经225": "^N225", "台股": "^TWII", "台湾加权": "^TWII",
  "德指": "^GDAXI", dax: "^GDAXI", "富时100": "^FTSE", ftse: "^FTSE",
  "标普期货": "ES=F", "纳指期货": "NQ=F", "道指期货": "YM=F", "罗素期货": "RTY=F",
  "原油": "CL=F", wti: "CL=F", "布伦特": "BZ=F", "黄金": "GC=F", "白银": "SI=F",
  "天然气": "NG=F", "铜": "HG=F",
  vix: "^VIX", "恐慌指数": "^VIX", "10年美债": "^TNX", "美债10年": "^TNX",
  "美债30年": "^TYX", "美元指数": "DX-Y.NYB", dxy: "DX-Y.NYB",
  "美元日元": "JPY=X", "欧元美元": "EURUSD=X", "美元人民币": "CNY=X",
  "比特币": "BTC-USD", btc: "BTC-USD", "以太坊": "ETH-USD",
};

export function resolveMarketSymbol(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const key = raw.toLowerCase();
  return Object.prototype.hasOwnProperty.call(MARKET_ALIASES, key) ? MARKET_ALIASES[key] : raw;
}

const CLOSED_MARKET_STATES = new Set(["CLOSED", "PRE", "PREPRE", "POST", "POSTPOST"]);
const CLOSE_BEARING_INSTRUMENTS = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND"]);

/**
 * Attach an observation-time contract to a quote.
 *
 * A provider's generic delay label is not evidence that a particular observation is only
 * fifteen minutes old.  On a weekend Yahoo's `regularMarketPrice` can be Friday's close,
 * while the same payload is gathered on Monday.  Consumers therefore get the measured age
 * and the price basis separately and can render the actual 60.84h (or other) age rather than
 * repeating a fixed provider slogan.
 */
export function withQuoteFreshness(quote, gatheredAt = new Date().toISOString()) {
  const gatheredTime = Date.parse(gatheredAt);
  const rawQuoteTime = String(quote?.quote_time || "");
  // A zone-less provider timestamp must not be interpreted in the machine's local zone.
  // Stooq's CSV fallback is explicitly EOD and carries no zone, so its age stays unknown.
  const quoteTime = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(rawQuoteTime) ? Date.parse(rawQuoteTime) : NaN;
  const ageSeconds = Number.isFinite(gatheredTime) && Number.isFinite(quoteTime)
    ? Math.max(0, Math.round((gatheredTime - quoteTime) / 1000))
    : null;
  const source = String(quote?.source || "").toLowerCase();
  const marketState = String(quote?.market_state || "").toUpperCase();
  const instrumentType = String(quote?.instrument_type || "").toUpperCase();
  const quoteBasis = source === "stooq" ? "end_of_day_close" : "regular_market_price";
  const isRealtime = quote?.is_realtime === true;
  let quoteStatus = "last_regular_trade";

  if (isRealtime) quoteStatus = "real_time";
  else if (quoteBasis === "end_of_day_close") quoteStatus = "end_of_day_close";
  else if (marketState === "REGULAR") quoteStatus = "regular_session_delayed";
  else if (CLOSED_MARKET_STATES.has(marketState)
    || (CLOSE_BEARING_INSTRUMENTS.has(instrumentType) && ageSeconds >= 6 * 3600)) {
    quoteStatus = "regular_close";
  }

  return {
    ...quote,
    gathered_at: Number.isFinite(gatheredTime) ? new Date(gatheredTime).toISOString() : null,
    stale_age_seconds: ageSeconds,
    stale_age_hours: ageSeconds === null ? null : Number((ageSeconds / 3600).toFixed(2)),
    quote_basis: quoteBasis,
    quote_status: quoteStatus,
    is_realtime: isRealtime,
  };
}

export function parseYahooChart(json, requested) {
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") throw new Error("no price in chart payload");
  const prev = typeof meta.chartPreviousClose === "number" ? meta.chartPreviousClose
    : (typeof meta.previousClose === "number" ? meta.previousClose : null);
  const price = meta.regularMarketPrice;
  const change = prev != null ? price - prev : null;
  const changePct = prev ? (change / prev) * 100 : null;
  return {
    query: requested,
    symbol: meta.symbol || requested,
    price,
    previous_close: prev,
    change: change != null ? Number(change.toFixed(4)) : null,
    change_pct: changePct != null ? Number(changePct.toFixed(2)) : null,
    currency: meta.currency || null,
    exchange: meta.exchangeName || null,
    instrument_type: meta.instrumentType || null,
    short_name: meta.shortName || null,
    long_name: meta.longName || null,
    exchange_timezone: meta.exchangeTimezoneName || null,
    market_state: meta.marketState || null,
    quote_time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    source: "yahoo",
    note: "not certified real-time; compare quote_time with gathered_at for the measured age",
  };
}

export function parseStooqCsv(csv, requested) {
  const lines = String(csv || "").trim().split("\n");
  if (lines.length < 2) throw new Error("empty stooq csv");
  const cols = lines[1].split(",");
  const close = Number(cols[6]);
  if (!Number.isFinite(close)) throw new Error("no stooq close");
  return {
    query: requested, symbol: cols[0] || requested, price: close,
    previous_close: null, change: null, change_pct: null,
    currency: null, exchange: "stooq", market_state: null,
    instrument_type: null, short_name: null, long_name: null, exchange_timezone: null,
    quote_time: (cols[1] && cols[2]) ? `${cols[1]}T${cols[2]}` : null,
    source: "stooq", note: "delayed / EOD fallback, not real-time",
  };
}

export async function fetchText(url, timeoutMs = LIMITS.QUOTE_FETCH_MS, upstreamSignal) {
  const abort = linkedAbort(timeoutMs, upstreamSignal);
  try {
    const res = await fetch(url, { signal: abort.signal, headers: { "User-Agent": "Mozilla/5.0 (AlphaCouncil)" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    abort.cleanup();
  }
}

export async function fetchQuote(input, { signal } = {}) {
  const sym = resolveMarketSymbol(input);
  if (!sym) return { query: input, error: "empty symbol" };
  try {
    const sourceUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
    const txt = await fetchText(sourceUrl, LIMITS.QUOTE_FETCH_MS, signal);
    return withQuoteFreshness({ ...parseYahooChart(JSON.parse(txt), sym), source_url: sourceUrl });
  } catch (e1) {
    try {
      const sourceUrl = `https://stooq.com/q/l/?s=${encodeURIComponent(sym.toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
      const txt = await fetchText(sourceUrl, LIMITS.QUOTE_FETCH_MS, signal);
      return withQuoteFreshness({ ...parseStooqCsv(txt, sym), source_url: sourceUrl });
    } catch (e2) {
      return { query: input, symbol: sym, error: `live data unavailable (${e1.message}; ${e2.message})`, note: "fall back to WebSearch and mark open_questions" };
    }
  }
}

export async function getQuotes(args) {
  const list = Array.isArray(args?.symbols) ? args.symbols : (args?.symbol ? [args.symbol] : []);
  if (list.length === 0) throw invalidParams("get_quote requires symbols[] or symbol.");
  const gatheredAt = new Date().toISOString();
  const quotes = await Promise.all(
    list.slice(0, LIMITS.QUOTE_MAX_SYMBOLS).map((s) => fetchQuote(s).then((quote) => (
      quote?.error ? quote : withQuoteFreshness(quote, gatheredAt)
    )).catch((e) => ({ query: s, error: String((e && e.message) || e) }))),
  );
  return {
    as_of: gatheredAt,
    quotes,
    disclaimer: "Keyless Yahoo/Stooq observations are not certified real-time. Read each quote's stale_age_hours and quote_status; Stooq is an EOD fallback. Missing/errored symbols are data gaps -> open_questions.",
  };
}
