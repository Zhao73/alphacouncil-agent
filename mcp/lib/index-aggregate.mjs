/**
 * Aggregate index facts: valuation, breadth, positioning and volatility history.
 *
 * An index or index ETF cannot be valued the way an operating company is. There is no filer,
 * no Company Facts screen and no single earnings statement, so the seats that need a valuation
 * level, a cycle reading or a factor input have nothing to stand on unless the aggregate is
 * fetched as its own dated fact. That is what this module supplies.
 *
 * TWO RULES ARE LOAD-BEARING HERE AND ARE ENCODED, NOT JUST DOCUMENTED.
 *
 * 1. BASIS. Index P/E is quoted on mutually incompatible bases. On 2026-07-24 the same S&P 500
 *    was 25.17x on WSJ's index basis, 28.53x on multpl.com's GAAP as-reported trailing basis,
 *    and 29.80x on iShares' IVV portfolio harmonic mean. None of those is wrong; they answer
 *    different questions. A fact therefore carries exactly one `basis` and names it, sources are
 *    never blended for one metric, and a percentile is refused unless its history declares the
 *    same basis. See `PE_BASIS` and `PE_BASIS_DIVERGENCE`.
 *
 * 2. LICENSING. S&P 500 and DJIA constituents and weights are licensed assets of S&P Dow Jones
 *    Indices. Scraping a constituent list and presenting it as the index is not a supported free
 *    path. The supported free path is the tracking ETF's published holdings, used as an explicit
 *    proxy and LABELLED as one (`^GSPC` -> IVV, `^NDX` -> QQQ, `^DJI` -> DIA). Holdings fetching
 *    belongs to another module; this one exposes the proxy mapping and accepts holdings passed
 *    in, and always stamps `is_proxy: true` on the result. See `INDEX_PROXIES`.
 *
 * Two of the upstreams (WSJ peyields, WSJ markets diary) are undocumented internal APIs. They
 * can change shape without notice and without a version, so every field is validated for
 * presence, type AND plausible magnitude before it becomes a number. A shape change must
 * degrade to a named gap in `unavailable`; it must never become a silently wrong number.
 */

import { LIMITS } from "./constants.mjs";
import { fetchText, resolveMarketSymbol } from "./quotes.mjs";

// ---- Sources ---------------------------------------------------------------

export const SOURCE_URLS = Object.freeze({
  // Undocumented WSJ internal APIs. Both need a non-default User-Agent, which `fetchText`
  // already sends. Note this is the opposite of the api.nasdaq.com rule below, so there is
  // deliberately no single global UA policy in this module.
  wsj_index_valuation:
    "https://www.wsj.com/market-data/stocks/peyields?id=%7B%22indexType%22%3A%22OTHERS%22%7D&type=mdc_peAndYields",
  wsj_market_breadth:
    "https://www.wsj.com/market-data/stocks/marketsdiary?id=%7B%22application%22%3A%22WSJ%22%2C%22marketsDiaryType%22%3A%22diaries%22%7D&type=mdc_marketsdiary",
  // Daily file keyed by trade date; 403 on any non-trading day AND on the current session
  // before it is published, hence the walk-back in `fetchPutCallRatios`.
  cboe_put_call_daily: "https://cdn.cboe.com/data/us/options/market_statistics/daily/",
  cboe_vix_history: "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv",
  // Nasdaq publishes its own index membership, so this one is not S&P-licensed. It is exposed
  // rather than fetched because constituent/holdings fetching is another module's job. TRAP if
  // it is ever wired: a default curl/node User-Agent gets HTTP/2 INTERNAL_ERROR from this host.
  nasdaq_100_constituents: "https://api.nasdaq.com/api/quote/list-type/nasdaq100",
});

/**
 * Damodaran's implied ERP is the natural input for an equity-risk-premium seat, and both files
 * are reachable. Neither is parsed: `.xlsx` is a zip of XML whose sheet layout is undocumented
 * and moves between vintages, and `.xls` is the pre-2007 BIFF binary format. Hand-rolling a
 * reader for either on Node built-ins would produce a number nobody can check, which is strictly
 * worse than a named gap. The URLs are published here so a human can open them.
 */
export const DAMODARAN_SOURCES = Object.freeze([
  Object.freeze({
    id: "implied_erp_monthly",
    label: "Damodaran implied equity risk premium, monthly",
    url: "https://pages.stern.nyu.edu/~adamodar/pc/implprem/ERPbymonth.xlsx",
    format: "xlsx",
    parser_implemented: false,
    // The /pc/datasets/ sibling path 404s for this file; /pc/implprem/ is the live one.
    reason: "xlsx is a zip of undocumented sheet XML; no dependency-free parser is trustworthy here",
  }),
  Object.freeze({
    id: "implied_erp_annual",
    label: "Damodaran implied equity risk premium, annual history",
    url: "https://pages.stern.nyu.edu/~adamodar/pc/datasets/histimpl.xls",
    format: "xls_biff",
    parser_implemented: false,
    reason: "legacy BIFF binary workbook; not readable with Node built-ins",
  }),
]);

// ---- Basis ------------------------------------------------------------------

export const PE_BASIS = Object.freeze({
  /** WSJ's own index-level aggregation, as published on the peyields endpoint. */
  WSJ_INDEX: "wsj_index_basis",
  /** GAAP as-reported trailing twelve months (multpl.com and similar). */
  GAAP_AS_REPORTED_TTM: "gaap_as_reported_ttm",
  /** Fund-sponsor portfolio harmonic mean (iShares/Invesco fact sheets). */
  ETF_PORTFOLIO_HARMONIC: "etf_portfolio_harmonic_mean",
});

/**
 * One observed day where all three bases disagree by more than 18%, kept as data so the
 * no-blending rule is checkable rather than folklore. A dashboard that mixes these looks broken.
 */
export const PE_BASIS_DIVERGENCE = Object.freeze({
  index: "^GSPC",
  trade_date: "2026-07-24",
  readings: Object.freeze([
    Object.freeze({ basis: PE_BASIS.WSJ_INDEX, pe_trailing: 25.17, source: "WSJ peyields" }),
    Object.freeze({ basis: PE_BASIS.GAAP_AS_REPORTED_TTM, pe_trailing: 28.53, source: "multpl.com" }),
    Object.freeze({ basis: PE_BASIS.ETF_PORTFOLIO_HARMONIC, pe_trailing: 29.8, source: "iShares IVV" }),
  ]),
});

// ---- Index proxies (licensing) ----------------------------------------------

export const PROXY_LICENSE_NOTE =
  "Index membership and weights are licensed by the index provider. This is the tracking ETF's "
  + "published holdings used as an explicit proxy for the index, not the index itself.";

export const INDEX_PROXIES = Object.freeze({
  "^GSPC": Object.freeze({
    index_name: "S&P 500",
    etf: "IVV",
    alternates: Object.freeze(["SPY", "VOO"]),
    licensor: "S&P Dow Jones Indices",
    why: "S&P 500 constituents and weights are a licensed S&P DJI asset; the free path is a tracking ETF's published holdings, labelled as a proxy",
  }),
  "^NDX": Object.freeze({
    index_name: "Nasdaq-100",
    etf: "QQQ",
    alternates: Object.freeze(["QQQM"]),
    licensor: "Nasdaq, Inc.",
    why: "Nasdaq publishes NDX membership itself, but weights still come from the tracking ETF, so the same proxy labelling applies",
  }),
  "^SOX": Object.freeze({
    index_name: "PHLX Semiconductor Sector",
    etf: "SOXX",
    alternates: Object.freeze(["SMH", "SOXQ"]),
    licensor: "Nasdaq, Inc.",
    why: "PHLX Semiconductor membership and its modified-cap weights are a licensed Nasdaq asset; the free path is a tracking ETF's published holdings, labelled as a proxy",
  }),
  "^RUT": Object.freeze({
    index_name: "Russell 2000",
    etf: "IWM",
    alternates: Object.freeze(["VTWO"]),
    licensor: "FTSE Russell",
    why: "Russell 2000 membership and weights are a licensed FTSE Russell asset; the free path is a tracking ETF's published holdings, labelled as a proxy",
  }),
  "^DJI": Object.freeze({
    index_name: "Dow Jones Industrial Average",
    etf: "DIA",
    alternates: Object.freeze([]),
    licensor: "S&P Dow Jones Indices",
    why: "DJIA constituents and its divisor are licensed S&P DJI assets; the free path is DIA's published holdings, labelled as a proxy",
  }),
});

const INDEX_ALIASES = Object.freeze({
  GSPC: "^GSPC", "^GSPC": "^GSPC", SPX: "^GSPC", "^SPX": "^GSPC", SP500: "^GSPC",
  NDX: "^NDX", "^NDX": "^NDX", NASDAQ100: "^NDX",
  DJI: "^DJI", "^DJI": "^DJI", DJIA: "^DJI",
  RUT: "^RUT", "^RUT": "^RUT", RUSSELL2000: "^RUT",
  SOX: "^SOX", "^SOX": "^SOX", SOXX: "^SOX", PHLXSEMI: "^SOX",
  IXIC: "^IXIC", "^IXIC": "^IXIC",
});

/** Normalise an index identifier. Unknown input passes through unchanged rather than being guessed at. */
export function normalizeIndexSymbol(input) {
  const resolved = String(resolveMarketSymbol(input) || "").trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(INDEX_ALIASES, resolved) ? INDEX_ALIASES[resolved] : resolved;
}

/**
 * The proxy record for an index, optionally carrying holdings fetched elsewhere.
 * `is_proxy` is unconditional: the caller must never be able to read this as the index itself.
 */
export function proxyConstituents(symbol, holdings = null) {
  const normalized = normalizeIndexSymbol(symbol);
  const proxy = INDEX_PROXIES[normalized];
  if (!proxy) return null;
  const rows = Array.isArray(holdings) ? Object.freeze([...holdings]) : null;
  return Object.freeze({
    is_proxy: true,
    proxy_for: normalized,
    index_name: proxy.index_name,
    proxy_etf: proxy.etf,
    proxy_alternates: proxy.alternates,
    licensor: proxy.licensor,
    proxy_reason: proxy.why,
    license_note: PROXY_LICENSE_NOTE,
    holdings: rows,
    holdings_source: rows ? "caller_supplied_etf_holdings" : null,
    holdings_count: rows ? rows.length : null,
  });
}

// ---- Strict validation helpers ----------------------------------------------

/**
 * Magnitude bands. Presence and type checks catch a renamed field; only a band catches the
 * nastier case where a field keeps its name but changes meaning (a ratio becoming a percentage,
 * a level becoming a decimal fraction).
 */
const BANDS = Object.freeze({
  PE: Object.freeze({ min: 1, max: 1000 }),
  YIELD_PCT: Object.freeze({ min: 0, max: 25 }),
  PUT_CALL: Object.freeze({ min: 0, max: 20 }),
  VIX: Object.freeze({ min: 1, max: 250 }),
  COUNT: Object.freeze({ min: 0, max: 1e6 }),
  TRIN: Object.freeze({ min: 0, max: 50 }),
});

const MONTHS = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});

function requireObject(value, what) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what}: expected an object`);
  return value;
}

function requireArray(value, what) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${what}: expected a non-empty array`);
  return value;
}

function requireString(value, what) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${what}: expected a non-empty string`);
  return text;
}

/**
 * A published number, or null when the field is absent. Absent secondary fields degrade to null;
 * a field that is present but implausible throws, because that is the shape change that would
 * otherwise become a confident wrong number.
 */
function boundedNumber(raw, what, { min, max, allowNull = false }) {
  if (raw === null || raw === undefined || raw === "") {
    if (allowNull) return null;
    throw new Error(`${what}: missing`);
  }
  const value = Number(String(raw).replace(/,/gu, ""));
  if (!Number.isFinite(value)) throw new Error(`${what}: not numeric (${JSON.stringify(raw)})`);
  if (value < min || value > max) throw new Error(`${what}: ${value} is outside the plausible band ${min}..${max}`);
  return value;
}

/** `2026-07-24T00:00:00` -> `2026-07-24`. */
function isoDateFromWsj(raw, what) {
  const match = /^(\d{4}-\d{2}-\d{2})(?:T|$)/u.exec(String(raw || "").trim());
  if (!match) throw new Error(`${what}: unrecognised date ${JSON.stringify(raw)}`);
  return match[1];
}

/** `Monday, July 27, 2026` -> `2026-07-27`, parsed explicitly rather than via `new Date`. */
function isoDateFromLongForm(raw, what) {
  const match = /^[A-Za-z]+,\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/u.exec(String(raw || "").trim());
  const month = match ? MONTHS[match[1].toLowerCase()] : null;
  if (!match || !month) throw new Error(`${what}: unrecognised date ${JSON.stringify(raw)}`);
  const day = Number(match[2]);
  if (day < 1 || day > 31) throw new Error(`${what}: impossible day in ${JSON.stringify(raw)}`);
  return `${match[3]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The trade date IS the publication anchor for these feeds; the run clock is never used. */
const publicAt = (isoDay) => `${isoDay}T00:00:00.000Z`;

const isoDay = (value) => {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : new Date().toISOString().slice(0, 10);
};

// ---- Index valuation (WSJ peyields) -----------------------------------------

/**
 * WSJ's internal instrument tickers, which are not exchange symbols: the NASDAQ 100 row is
 * published under `RIXF` and the S&P 500 under `INX`. This map exists precisely so nobody
 * matches on the display name, which WSJ is free to reword.
 */
export const WSJ_INDEX_TICKERS = Object.freeze({ INX: "^GSPC", RIXF: "^NDX", RUT: "^RUT" });

export function parseWsjPeYields(payload, { sourceUrl = SOURCE_URLS.wsj_index_valuation } = {}) {
  const root = requireObject(payload, "WSJ peyields");
  if (root.type !== "mdc_peAndYields") {
    throw new Error(`WSJ peyields: unexpected payload type ${JSON.stringify(root.type)}`);
  }
  const data = requireObject(root.data, "WSJ peyields data");
  const tradeDate = isoDateFromWsj(data.tradeDate, "WSJ peyields tradeDate");
  const rows = requireArray(data.instruments, "WSJ peyields instruments");
  const instruments = rows.map((row, index) => {
    const where = `WSJ peyields instrument #${index}`;
    const item = requireObject(row, where);
    const ticker = requireString(item.ticker, `${where} ticker`);
    return Object.freeze({
      symbol: WSJ_INDEX_TICKERS[ticker] || null,
      name: requireString(item.name, `${where} name`),
      ticker,
      pe_trailing: boundedNumber(item.priceEarningsRatio, `${where} priceEarningsRatio`, BANDS.PE),
      pe_forward: boundedNumber(item.priceEarningsRatioEstimate, `${where} priceEarningsRatioEstimate`, { ...BANDS.PE, allowNull: true }),
      pe_52w_ago: boundedNumber(item.priceEarningsRatio52WeekAgo, `${where} priceEarningsRatio52WeekAgo`, { ...BANDS.PE, allowNull: true }),
      dividend_yield: boundedNumber(item.yield, `${where} yield`, { ...BANDS.YIELD_PCT, allowNull: true }),
      // Units are spelled out because they differ inside one fact: the P/E fields are plain
      // ratios, the dividend yield is a percent as published, and `earningsYield` below returns
      // a decimal fraction. Reading any of the three as another is a 100x error.
      pe_unit: "ratio",
      dividend_yield_unit: "percent",
      basis: PE_BASIS.WSJ_INDEX,
      basis_note: "WSJ index-level aggregation; not comparable with GAAP as-reported TTM or an ETF portfolio harmonic mean",
      trade_date: tradeDate,
      public_at: publicAt(tradeDate),
      source_url: sourceUrl,
    });
  });
  return Object.freeze({
    trade_date: tradeDate,
    public_at: publicAt(tradeDate),
    basis: PE_BASIS.WSJ_INDEX,
    instruments: Object.freeze(instruments),
    source_url: sourceUrl,
  });
}

export async function fetchIndexValuation({ signal } = {}) {
  const url = SOURCE_URLS.wsj_index_valuation;
  const text = await fetchText(url, LIMITS.QUOTE_FETCH_MS, signal);
  return parseWsjPeYields(JSON.parse(text), { sourceUrl: url });
}

/** 1/pe as a decimal fraction. Null for an absent, zero or negative P/E, never a signed inverse. */
export function earningsYield(pe) {
  const value = Number(pe);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Number((1 / value).toFixed(6));
}

// ---- Market breadth (WSJ markets diary) --------------------------------------

const BREADTH_FIELDS = Object.freeze({
  issuestraded: Object.freeze({ key: "issues_traded", band: BANDS.COUNT, required: false }),
  advances: Object.freeze({ key: "advances", band: BANDS.COUNT, required: true }),
  declines: Object.freeze({ key: "declines", band: BANDS.COUNT, required: true }),
  unchanged: Object.freeze({ key: "unchanged", band: BANDS.COUNT, required: false }),
  newhighs: Object.freeze({ key: "new_highs", band: BANDS.COUNT, required: false }),
  newlows: Object.freeze({ key: "new_lows", band: BANDS.COUNT, required: false }),
  closingarmstrin: Object.freeze({ key: "trin", band: BANDS.TRIN, required: false }),
});

/**
 * Only the `latestClose` column is carried. WSJ also publishes `previousClose` and `weekAgo`,
 * but it does not publish the dates those columns belong to, and inferring them across holidays
 * would produce an undated number wearing a date. Those columns are deliberately dropped.
 */
function parseBreadthSet(set, index, tradeDate) {
  const where = `WSJ markets diary set #${index}`;
  const node = requireObject(set, where);
  const header = requireArray(node.headerFields, `${where} headerFields`);
  const first = requireObject(header[0], `${where} headerFields[0]`);
  if (first.value !== "name") throw new Error(`${where}: first header column is ${JSON.stringify(first.value)}, expected "name"`);
  const venue = requireString(first.label, `${where} venue label`);
  const rows = requireArray(node.instruments, `${where} instruments`);

  const values = {};
  for (const row of rows) {
    const item = requireObject(row, `${where} row`);
    const spec = BREADTH_FIELDS[item.id];
    if (!spec) continue;
    // The NYSE table repeats volume ids for primary-market and composite rows; those are not
    // extracted. A repeat of a field that IS extracted means the table changed meaning.
    if (Object.prototype.hasOwnProperty.call(values, spec.key)) {
      throw new Error(`${where}: duplicate row for ${item.id}`);
    }
    values[spec.key] = boundedNumber(item.latestClose, `${where} ${item.id}`, { ...spec.band, allowNull: true });
  }
  for (const spec of Object.values(BREADTH_FIELDS)) {
    if (spec.required && !Number.isFinite(values[spec.key])) throw new Error(`${where}: missing ${spec.key}`);
  }

  const { advances, declines, new_highs: highs, new_lows: lows } = values;
  return Object.freeze({
    venue,
    issues_traded: values.issues_traded ?? null,
    advances,
    declines,
    unchanged: values.unchanged ?? null,
    new_highs: highs ?? null,
    new_lows: lows ?? null,
    trin: values.trin ?? null,
    net_advances: advances - declines,
    advance_decline_ratio: declines > 0 ? Number((advances / declines).toFixed(4)) : null,
    net_new_highs: Number.isFinite(highs) && Number.isFinite(lows) ? highs - lows : null,
    unit: "issue_counts",
    trade_date: tradeDate,
    public_at: publicAt(tradeDate),
  });
}

export function parseWsjMarketsDiary(payload, { sourceUrl = SOURCE_URLS.wsj_market_breadth } = {}) {
  const root = requireObject(payload, "WSJ markets diary");
  if (root.type !== "mdc_marketsdiary") {
    throw new Error(`WSJ markets diary: unexpected payload type ${JSON.stringify(root.type)}`);
  }
  const data = requireObject(root.data, "WSJ markets diary data");
  const tradeDate = isoDateFromLongForm(data.timestamp, "WSJ markets diary timestamp");
  const sets = requireArray(data.instrumentSets, "WSJ markets diary instrumentSets");
  const venues = sets.map((set, index) => parseBreadthSet(set, index, tradeDate));
  return Object.freeze({
    trade_date: tradeDate,
    public_at: publicAt(tradeDate),
    venues: Object.freeze(venues),
    by_venue: Object.freeze(Object.fromEntries(venues.map((row) => [row.venue, row]))),
    source_url: sourceUrl,
  });
}

export async function fetchMarketBreadth({ signal } = {}) {
  const url = SOURCE_URLS.wsj_market_breadth;
  const text = await fetchText(url, LIMITS.QUOTE_FETCH_MS, signal);
  return parseWsjMarketsDiary(JSON.parse(text), { sourceUrl: url });
}

// ---- Put/call ratios (CBOE daily statistics) ---------------------------------

export const CBOE_MAX_TRADING_DAY_LOOKBACK = 5;

const CBOE_RATIOS = Object.freeze({
  "TOTAL PUT/CALL RATIO": "total",
  "INDEX PUT/CALL RATIO": "index",
  "EQUITY PUT/CALL RATIO": "equity",
  "EXCHANGE TRADED PRODUCTS PUT/CALL RATIO": "exchange_traded_products",
  "CBOE VOLATILITY INDEX (VIX) PUT/CALL RATIO": "vix",
  "SPX + SPXW PUT/CALL RATIO": "spx_spxw",
});

/**
 * Candidate trade dates, newest first, skipping weekends.
 *
 * The daily file 403s on any non-trading day and also on the current session until it is
 * published, so the most recent trading day has to be discovered by trying. Weekends are skipped
 * because CBOE never publishes one; holidays are NOT skipped, because no reliable US market
 * calendar is derivable here and a wrong one would silently skip a real trading day.
 */
export function tradingDayCandidates(asOf = null, maxAttempts = CBOE_MAX_TRADING_DAY_LOOKBACK) {
  const limit = Number.isFinite(maxAttempts) && maxAttempts > 0 ? Math.floor(maxAttempts) : 1;
  const cursor = new Date(`${isoDay(asOf)}T00:00:00Z`);
  const days = [];
  // Bounded so a pathological input cannot spin: at most two weekend days per five weekdays.
  for (let step = 0; step < limit * 2 + 7 && days.length < limit; step += 1) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return days;
}

/** A published ratio, or null. CBOE writes `0.00` for a product with no contracts traded that
 *  session; that is an absence, not a put/call ratio of zero, so it must not read as extreme
 *  call skew. */
function cboeRatio(raw, what) {
  const value = boundedNumber(raw, what, { ...BANDS.PUT_CALL, allowNull: true });
  return value === null || value === 0 ? null : value;
}

function cboeVolumeBlock(payload, key) {
  const rows = payload[key];
  if (rows === undefined) return null;
  const where = `CBOE daily options "${key}"`;
  const out = {};
  for (const row of requireArray(rows, where)) {
    const item = requireObject(row, `${where} row`);
    const slot = item.name === "VOLUME" ? "volume" : (item.name === "OPEN INTEREST" ? "open_interest" : null);
    if (!slot) continue;
    out[slot] = Object.freeze({
      call: boundedNumber(item.call, `${where} ${item.name} call`, { min: 0, max: 1e12 }),
      put: boundedNumber(item.put, `${where} ${item.name} put`, { min: 0, max: 1e12 }),
      total: boundedNumber(item.total, `${where} ${item.name} total`, { min: 0, max: 1e12 }),
    });
  }
  return Object.keys(out).length ? Object.freeze(out) : null;
}

export function parseCboeDailyOptions(payload, { tradeDate, sourceUrl, requestedAsOf = null, attempts = [] } = {}) {
  const root = requireObject(payload, "CBOE daily options");
  const rows = requireArray(root.ratios, "CBOE daily options ratios");
  const published = new Map();
  for (const row of rows) {
    const item = requireObject(row, "CBOE daily options ratio row");
    published.set(requireString(item.name, "CBOE daily options ratio name"), item.value);
  }
  if (!published.has("TOTAL PUT/CALL RATIO")) {
    throw new Error("CBOE daily options: TOTAL PUT/CALL RATIO is absent");
  }
  const ratios = {};
  for (const [name, key] of Object.entries(CBOE_RATIOS)) {
    ratios[key] = published.has(name) ? cboeRatio(published.get(name), `CBOE daily options "${name}"`) : null;
  }
  if (ratios.total === null) throw new Error("CBOE daily options: TOTAL PUT/CALL RATIO is not a usable number");
  return Object.freeze({
    trade_date: tradeDate,
    // The caller asked for `requestedAsOf` and got `tradeDate`; keeping both stops a Monday
    // reading from being presented as today's.
    requested_as_of: requestedAsOf,
    is_most_recent_available: true,
    public_at: publicAt(tradeDate),
    unit: "ratio_of_put_to_call_volume",
    ratios: Object.freeze(ratios),
    volume: Object.freeze({
      total: cboeVolumeBlock(root, "SUM OF ALL PRODUCTS"),
      index: cboeVolumeBlock(root, "INDEX OPTIONS"),
      equity: cboeVolumeBlock(root, "EQUITY OPTIONS"),
      exchange_traded_products: cboeVolumeBlock(root, "EXCHANGE TRADED PRODUCTS"),
    }),
    skipped_dates: Object.freeze([...attempts]),
    source_url: sourceUrl,
  });
}

export async function fetchPutCallRatios({ signal, asOf = null, maxAttempts = CBOE_MAX_TRADING_DAY_LOOKBACK } = {}) {
  const candidates = tradingDayCandidates(asOf, maxAttempts);
  const attempts = [];
  for (const date of candidates) {
    // An upstream cancellation must not be retried four more times.
    if (signal?.aborted) throw new Error("CBOE daily options: cancelled before a trading day was found");
    const url = `${SOURCE_URLS.cboe_put_call_daily}${date}_daily_options`;
    try {
      const text = await fetchText(url, LIMITS.QUOTE_FETCH_MS, signal);
      return parseCboeDailyOptions(JSON.parse(text), {
        tradeDate: date, sourceUrl: url, requestedAsOf: isoDay(asOf), attempts,
      });
    } catch (error) {
      attempts.push(`${date}: ${String(error?.message || error)}`);
    }
  }
  throw new Error(`CBOE daily options unavailable for the last ${candidates.length} weekdays (${attempts.join("; ")})`);
}

// ---- VIX history (CBOE) ------------------------------------------------------

const VIX_HEADER = Object.freeze(["DATE", "OPEN", "HIGH", "LOW", "CLOSE"]);

/**
 * A malformed or non-numeric row is dropped rather than carried forward, exactly as a missing
 * FRED observation is. The band check is applied to the latest value only: history is used for
 * ranking, but the latest close is the number that becomes a published fact.
 */
export function parseVixHistoryCsv(csv, { sourceUrl = SOURCE_URLS.cboe_vix_history, asOf = null } = {}) {
  const lines = String(csv || "").trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CBOE VIX history: empty CSV");
  const header = lines[0].trim().toUpperCase().split(",").map((cell) => cell.trim());
  if (VIX_HEADER.some((column, index) => header[index] !== column)) {
    throw new Error(`CBOE VIX history: unexpected header ${JSON.stringify(lines[0])}`);
  }
  const observations = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(String(cells[0] || "").trim());
    if (!match) continue;
    const close = Number(cells[4]);
    if (!Number.isFinite(close) || close <= 0) continue;
    observations.push({ date: `${match[3]}-${match[1]}-${match[2]}`, value: close });
  }
  if (!observations.length) throw new Error("CBOE VIX history: no numeric observations");
  const cutoff = asOf ? String(asOf).slice(0, 10) : null;
  const visible = cutoff ? observations.filter((row) => row.date <= cutoff) : observations;
  if (!visible.length) throw new Error(`CBOE VIX history: no observation at or before ${cutoff}`);
  const last = visible.at(-1);
  boundedNumber(last.value, "CBOE VIX history latest close", BANDS.VIX);
  return Object.freeze({
    id: "VIX",
    unit: "index_points",
    label: "CBOE Volatility Index, daily close",
    observations: visible,
    latest: last.value,
    observation_date: last.date,
    public_at: publicAt(last.date),
    source_url: sourceUrl,
  });
}

export async function fetchVixHistory({ signal, asOf = null } = {}) {
  const url = SOURCE_URLS.cboe_vix_history;
  // A ~470KB CSV needs more headroom than a JSON snapshot, matching the FRED CSV budget.
  const text = await fetchText(url, LIMITS.QUOTE_FETCH_MS * 2, signal);
  return parseVixHistoryCsv(text, { sourceUrl: url, asOf });
}

// ---- Percentiles -------------------------------------------------------------

/** Value `windowDays` calendar days before the latest observation, or null when unavailable. */
export function valueBefore(observations, windowDays) {
  const rows = Array.isArray(observations) ? observations : observations?.observations;
  if (!Array.isArray(rows) || !rows.length) return null;
  const cutoff = new Date(`${rows.at(-1).date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);
  const target = cutoff.toISOString().slice(0, 10);
  const prior = rows.filter((row) => row.date <= target);
  return prior.length ? prior.at(-1) : null;
}

/**
 * Where the latest observation sits in its own history, as a 0-1 rank.
 *
 * Field-for-field the same contract as `fred.mjs` `percentileRank`, so a reader never has to ask
 * which percentile convention a given number follows. Accepts a series object or a bare
 * observation array. Returns null below `minSample`: "the 92nd percentile" means nothing without
 * saying percentile of what and since when.
 */
export function percentileRank(series, { sinceDays = 365 * 10, minSample = 30 } = {}) {
  const rows = Array.isArray(series) ? series : series?.observations;
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const start = valueBefore(rows, sinceDays);
  const sample = start ? rows.filter((row) => row.date >= start.date) : rows;
  if (sample.length < minSample) return null;
  const latest = rows.at(-1).value;
  const below = sample.filter((row) => row.value < latest).length;
  return {
    percentile: Number((below / sample.length).toFixed(4)),
    sample_size: sample.length,
    sample_start: sample[0].date,
    sample_end: rows.at(-1).date,
  };
}

export const VALUATION_PERCENTILE_GAP =
  "no same-basis index P/E history is available from an implemented source; a percentile computed "
  + "from one observation, or against a differently-based history, would be fabricated";

/**
 * A valuation percentile that always states its metric, its basis and its sample.
 *
 * Refuses in three cases, all of which are gaps rather than zeroes: no history at all, a sample
 * too short to rank against, or a history whose declared basis differs from the fact's. The last
 * one is the whole point -- ranking a WSJ-basis 25.17x inside a GAAP-basis history would look
 * like a cheap market when nothing about the market changed.
 */
export function valuationPercentile(fact, { metric = "pe_trailing", history = null, sinceDays = 365 * 10 } = {}) {
  const value = Number(fact?.[metric]);
  if (!Number.isFinite(value)) return null;
  const historyBasis = Array.isArray(history) ? null : history?.basis;
  if (historyBasis && fact?.basis && historyBasis !== fact.basis) return null;
  const rank = percentileRank(history, { sinceDays });
  if (!rank) return null;
  return Object.freeze({ metric, basis: fact?.basis ?? null, value, ...rank });
}

// ---- Orchestration -----------------------------------------------------------

async function settle(label, run, unavailable) {
  try {
    return await run();
  } catch (error) {
    unavailable.push(`${label}: ${String(error?.message || error)}`);
    return null;
  }
}

/** The one index the caller asked for. A feed that simply does not cover it is a named gap. */
function selectValuation(valuationSet, symbol, unavailable) {
  const valuation = valuationSet?.instruments.find((row) => row.symbol === symbol) || null;
  if (valuationSet && !valuation) {
    const covered = valuationSet.instruments.map((row) => row.symbol || row.ticker).join(", ");
    unavailable.push(`index valuation for ${symbol}: WSJ peyields publishes ${covered} only`);
  }
  return valuation;
}

/** Earnings yield inherits the P/E's basis and dates; it is a restatement, not a new observation. */
function earningsYieldFact(valuation) {
  const value = valuation ? earningsYield(valuation.pe_trailing) : null;
  if (!Number.isFinite(value)) return null;
  return Object.freeze({
    value,
    unit: "decimal_fraction",
    derived_from: "pe_trailing",
    basis: valuation.basis,
    trade_date: valuation.trade_date,
    public_at: valuation.public_at,
    source_url: valuation.source_url,
  });
}

/** Gaps that exist by design rather than by upstream failure, so they are stated every run. */
function recordStructuralGaps(symbol, constituents, unavailable) {
  if (!constituents) {
    unavailable.push(`constituent proxy for ${symbol}: no tracking-ETF proxy is mapped for this index`);
  } else if (!constituents.holdings) {
    unavailable.push(
      `constituents for ${symbol}: not fetched here; pass ${constituents.proxy_etf} holdings in. `
      + `Membership and weights are licensed by ${constituents.licensor} and must be labelled a proxy.`,
    );
  }
  for (const source of DAMODARAN_SOURCES) {
    if (!source.parser_implemented) unavailable.push(`${source.label} (${source.url}): ${source.reason}`);
  }
}

/**
 * Every aggregate fact available for one index, with a named gap for everything that is not.
 *
 * `holdings` is the hook for the ETF-proxy path: pass the tracking ETF's published holdings in
 * and they are attached, labelled as a proxy. Nothing here scrapes a constituent list.
 * `peHistory` is the hook for a same-basis P/E history; without one the valuation percentile
 * stays null rather than being computed from the single point this module can see.
 */
export async function fetchIndexAggregate({ symbol, signal, asOf = null, holdings = null, peHistory = null } = {}) {
  const normalized = normalizeIndexSymbol(symbol);
  if (!normalized) throw new Error("fetchIndexAggregate requires an index symbol");
  const unavailable = [];

  const [valuationSet, breadth, putCall, vix] = await Promise.all([
    settle("index valuation (WSJ peyields)", () => fetchIndexValuation({ signal }), unavailable),
    settle("market breadth (WSJ markets diary)", () => fetchMarketBreadth({ signal }), unavailable),
    settle("put/call ratios (CBOE daily)", () => fetchPutCallRatios({ signal, asOf }), unavailable),
    settle("VIX history (CBOE)", () => fetchVixHistory({ signal, asOf }), unavailable),
  ]);

  const valuation = selectValuation(valuationSet, normalized, unavailable);
  const percentile = valuation ? valuationPercentile(valuation, { history: peHistory }) : null;
  if (valuation && !percentile) unavailable.push(`index P/E valuation percentile for ${normalized}: ${VALUATION_PERCENTILE_GAP}`);
  const constituents = proxyConstituents(normalized, holdings);
  recordStructuralGaps(normalized, constituents, unavailable);

  return Object.freeze({
    symbol: normalized,
    as_of: asOf ? String(asOf) : new Date().toISOString(),
    valuation,
    earnings_yield: earningsYieldFact(valuation),
    valuation_percentile: percentile,
    breadth,
    put_call: putCall,
    vix,
    vix_percentile: vix ? percentileRank(vix) : null,
    constituents,
    equity_risk_premium: null,
    basis_warning: PE_BASIS_DIVERGENCE,
    sources: SOURCE_URLS,
    unimplemented_sources: DAMODARAN_SOURCES,
    unavailable,
  });
}
