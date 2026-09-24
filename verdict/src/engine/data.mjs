// Keyless public-data layer: Yahoo chart/search, SEC EDGAR, Google News RSS, Cboe delayed
// options and FRED. Every result carries `source` metadata so claims can cite it; every
// failure is returned as an explicit gap instead of a guess.

import { fetchJson, fetchText } from "./http.mjs";
import { computeTechnicals } from "./technicals.mjs";

const today = () => new Date().toISOString().slice(0, 10);
const isoDate = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

export function normalizeSymbol(raw) {
  const s = String(raw || "").trim().toUpperCase().replace(/^\$/, "");
  if (!/^[\^A-Z0-9][A-Z0-9.\-=^]{0,19}$/.test(s)) throw new Error(`invalid symbol: ${raw}`);
  return s;
}

// ---------------------------------------------------------------- instrument

const TYPE_MAP = { EQUITY: "equity", ETF: "etf", MUTUALFUND: "fund", INDEX: "index", CRYPTOCURRENCY: "crypto", FUTURE: "future", CURRENCY: "fx" };

let secTickerMap = null;
async function secTickers() {
  if (!secTickerMap) {
    const raw = await fetchJson("https://www.sec.gov/files/company_tickers.json", { timeoutMs: 20000, ttlMs: 7 * 24 * 3600e3 });
    secTickerMap = new Map(Object.values(raw).map((r) => [String(r.ticker).toUpperCase(), { cik: String(r.cik_str).padStart(10, "0"), title: r.title }]));
  }
  return secTickerMap;
}

export function resetSecTickerCache() {
  secTickerMap = null;
}

export async function lookupCik(symbol) {
  const map = await secTickers();
  // SEC lists class shares with a dash (BRK-B); Yahoo uses the same form.
  return map.get(symbol) || map.get(symbol.replace(".", "-")) || null;
}

/** Classify a symbol before choosing research routes: company, fund or index. */
export async function resolveInstrument(query) {
  const symbol = normalizeSymbol(query);
  const out = { symbol, name: null, type: symbol.startsWith("^") ? "index" : "unknown", exchange: null, currency: null, cik: null, gaps: [] };
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=6&newsCount=0`;
    const data = await fetchJson(url, { ttlMs: 24 * 3600e3 });
    const quotes = data.quotes || [];
    const hit = quotes.find((q) => String(q.symbol).toUpperCase() === symbol) || null;
    if (hit) {
      out.name = hit.longname || hit.shortname || null;
      out.type = TYPE_MAP[hit.quoteType] || out.type;
      out.exchange = hit.exchDisp || hit.exchange || null;
    } else {
      out.gaps.push("instrument search returned no exact symbol match");
    }
  } catch (error) {
    out.gaps.push(`instrument search unavailable: ${error.message}`);
  }
  if (out.type === "equity" || out.type === "unknown") {
    try {
      const sec = await lookupCik(symbol);
      if (sec) {
        out.cik = sec.cik;
        out.name ||= sec.title;
        if (out.type === "unknown") out.type = "equity";
      }
    } catch (error) {
      out.sec_error = error.message;
      out.gaps.push(`SEC ticker map unavailable: ${error.message}`);
    }
  }
  out.route = out.type === "etf" || out.type === "fund" ? "fund_lookthrough" : out.type === "index" ? "index_aggregate" : "operating_company";
  return out;
}

// ---------------------------------------------------------------- prices

async function yahooChart(symbol, range = "2y") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&includePrePost=false&events=div%2Csplit`;
  const data = await fetchJson(url, { ttlMs: 3 * 60e3 });
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(data?.chart?.error?.description || "no chart result");
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const bars = ts.map((t, i) => ({
    date: isoDate(t),
    close: (adj && Number.isFinite(adj[i]) ? adj[i] : q.close?.[i]) ?? null,
    volume: q.volume?.[i] ?? null,
  })).filter((b) => Number.isFinite(b.close));
  const dividends = Object.values(result.events?.dividends || {}).map((d) => ({ date: isoDate(d.date), amount: d.amount }));
  return { meta: result.meta || {}, bars, dividends, url };
}

export async function getQuote(symbol) {
  symbol = normalizeSymbol(symbol);
  const { meta, bars, dividends, url } = await yahooChart(symbol, "1y");
  const price = meta.regularMarketPrice ?? bars.at(-1)?.close ?? null;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? bars.at(-2)?.close ?? null;
  const cutoff = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const ttmDividends = dividends.filter((d) => d.date >= cutoff).reduce((a, d) => a + d.amount, 0);
  return {
    symbol,
    price: round(price, 4),
    currency: meta.currency || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    change_pct: prev ? round(((price - prev) / prev) * 100) : null,
    market_time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    high_52w: round(meta.fiftyTwoWeekHigh ?? Math.max(...bars.map((b) => b.close))),
    low_52w: round(meta.fiftyTwoWeekLow ?? Math.min(...bars.map((b) => b.close))),
    dividends_ttm: round(ttmDividends, 4),
    dividend_yield_pct: price && ttmDividends ? round((ttmDividends / price) * 100) : null,
    delayed: true,
    source: { title: `Yahoo Finance chart ${symbol}`, url, retrieved: today() },
  };
}

export async function getHistory(symbol, range = "2y") {
  symbol = normalizeSymbol(symbol);
  const { bars, url } = await yahooChart(symbol, range);
  return {
    symbol,
    technicals: computeTechnicals(bars),
    recent_bars: bars.slice(-10),
    // ~1 year of closes, every other session: enough for a sparkline and a chart.
    series: bars.slice(-252).filter((_, i, a) => (a.length - 1 - i) % 2 === 0).map((b) => [b.date, round(b.close)]),
    source: { title: `Yahoo Finance daily history ${symbol} (${range})`, url, retrieved: today() },
  };
}

// ---------------------------------------------------------------- SEC fundamentals

const TAGS = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"],
  gross_profit: ["GrossProfit"],
  operating_income: ["OperatingIncomeLoss"],
  net_income: ["NetIncomeLoss", "ProfitLoss"],
  eps_diluted: ["EarningsPerShareDiluted"],
  operating_cash_flow: ["NetCashProvidedByUsedInOperatingActivities"],
  capex: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
  rnd: ["ResearchAndDevelopmentExpense"],
  interest_expense: ["InterestExpense", "InterestExpenseNonoperating"],
  dividends_paid: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock"],
  buybacks: ["PaymentsForRepurchaseOfCommonStock"],
  cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
  long_term_debt: ["LongTermDebtNoncurrent", "LongTermDebt"],
  current_debt: ["LongTermDebtCurrent", "DebtCurrent", "ShortTermBorrowings"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
  total_assets: ["Assets"],
  current_assets: ["AssetsCurrent"],
  current_liabilities: ["LiabilitiesCurrent"],
};
const INSTANT = new Set(["cash", "long_term_debt", "current_debt", "equity", "total_assets", "current_assets", "current_liabilities"]);
const DAY = 864e5;
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / DAY;

function unitEntries(facts, tag) {
  const node = facts?.["us-gaap"]?.[tag];
  if (!node) return [];
  const units = node.units || {};
  const list = units.USD || units["USD/shares"] || Object.values(units)[0] || [];
  return list.filter((e) => Number.isFinite(e.val) && e.end && /^(10-K|10-Q|20-F|40-F)/.test(e.form || ""));
}

/** Latest filed value per (start,end) period so restatements win. */
function dedupe(entries) {
  const byPeriod = new Map();
  for (const e of entries) {
    const key = `${e.start || ""}|${e.end}`;
    const prev = byPeriod.get(key);
    if (!prev || String(e.filed) > String(prev.filed)) byPeriod.set(key, e);
  }
  return [...byPeriod.values()].sort((a, b) => a.end.localeCompare(b.end));
}

function pickTag(facts, tags) {
  // Prefer the tag with the most recent data; issuers switch tags over time.
  let best = null;
  for (const tag of tags) {
    const entries = dedupe(unitEntries(facts, tag));
    if (!entries.length) continue;
    if (!best || entries.at(-1).end > best.entries.at(-1).end) best = { tag, entries };
  }
  return best;
}

/** Annual series + trailing-twelve-month value for a duration metric. */
export function durationMetric(entries) {
  const annual = entries.filter((e) => e.start && days(e.start, e.end) > 330 && days(e.start, e.end) < 400);
  const fy = annual.at(-1) || null;
  let ttm = fy ? { val: fy.val, end: fy.end, basis: "latest fiscal year" } : null;
  if (fy) {
    const ytd = entries
      .filter((e) => e.start && e.end > fy.end && days(e.start, e.end) > 80 && days(e.start, e.end) < 300)
      .sort((a, b) => a.end.localeCompare(b.end) || days(a.start, a.end) - days(b.start, b.end))
      .at(-1);
    if (ytd) {
      const span = days(ytd.start, ytd.end);
      const prior = entries.find((e) => e.start
        && Math.abs(days(e.start, e.end) - span) < 12
        && Math.abs(days(e.end, ytd.end) - 365) < 20);
      if (prior) ttm = { val: fy.val + ytd.val - prior.val, end: ytd.end, basis: `FY ${fy.end} + YTD ${ytd.end} - prior YTD ${prior.end}` };
    }
  }
  const series = annual.slice(-5).map((e) => ({ fiscal_year_end: e.end, value: e.val }));
  return { ttm, series };
}

function growth(series) {
  if (series.length < 2) return null;
  const [a, b] = series.slice(-2).map((s) => s.value);
  return a > 0 ? round(((b - a) / Math.abs(a)) * 100, 1) : null;
}

function cagr(series, years = 3) {
  if (series.length < years + 1) return null;
  const a = series.at(-1 - years).value;
  const b = series.at(-1).value;
  return a > 0 && b > 0 ? round(((b / a) ** (1 / years) - 1) * 100, 1) : null;
}

/** Pure transform from an SEC companyfacts document (plus optional price) to typed facts. */
export function summarizeCompanyFacts(doc, { price = null, currency = "USD" } = {}) {
  const facts = doc?.facts || {};
  const out = { entity: doc?.entityName || null, currency: "USD", metrics: {}, annual: {}, ratios: {}, gaps: [] };
  for (const [key, tags] of Object.entries(TAGS)) {
    const pick = pickTag(facts, tags);
    if (!pick) {
      out.gaps.push(`${key}: no us-gaap fact`);
      continue;
    }
    if (INSTANT.has(key)) {
      const e = pick.entries.at(-1);
      out.metrics[key] = { value: e.val, as_of: e.end, tag: pick.tag };
    } else if (key === "eps_diluted") {
      const m = durationMetric(pick.entries);
      if (m.ttm) out.metrics[key] = { value: round(m.ttm.val), as_of: m.ttm.end, basis: m.ttm.basis, tag: pick.tag };
      out.annual[key] = m.series;
    } else {
      const m = durationMetric(pick.entries);
      if (m.ttm) out.metrics[key] = { value: m.ttm.val, as_of: m.ttm.end, basis: m.ttm.basis, tag: pick.tag };
      out.annual[key] = m.series;
    }
  }
  const sharesNode = facts?.dei?.EntityCommonStockSharesOutstanding?.units?.shares;
  if (sharesNode?.length) {
    const latest = [...sharesNode].sort((a, b) => a.end.localeCompare(b.end)).at(-1);
    out.metrics.shares_outstanding = { value: latest.val, as_of: latest.end, tag: "dei:EntityCommonStockSharesOutstanding" };
    const yearAgo = sharesNode.filter((s) => days(s.end, latest.end) > 300 && days(s.end, latest.end) < 430).sort((a, b) => a.end.localeCompare(b.end)).at(-1);
    if (yearAgo) out.ratios.share_count_change_pct = round(((latest.val - yearAgo.val) / yearAgo.val) * 100, 2);
  } else {
    out.gaps.push("shares_outstanding: no dei fact");
  }

  const v = (k) => out.metrics[k]?.value ?? null;
  const rev = v("revenue");
  const ni = v("net_income");
  const ocf = v("operating_cash_flow");
  const capex = v("capex");
  const fcf = ocf !== null ? ocf - (capex || 0) : null;
  const debt = (v("long_term_debt") || 0) + (v("current_debt") || 0);
  const r = out.ratios;
  if (fcf !== null) out.metrics.free_cash_flow = { value: fcf, basis: "operating cash flow - capex (TTM)" };
  if (rev) {
    if (v("gross_profit") !== null) r.gross_margin_pct = round((v("gross_profit") / rev) * 100, 1);
    if (v("operating_income") !== null) r.operating_margin_pct = round((v("operating_income") / rev) * 100, 1);
    if (ni !== null) r.net_margin_pct = round((ni / rev) * 100, 1);
    if (fcf !== null) r.fcf_margin_pct = round((fcf / rev) * 100, 1);
    if (v("rnd") !== null) r.rnd_intensity_pct = round((v("rnd") / rev) * 100, 1);
  }
  if (ni && v("equity") > 0) r.roe_pct = round((ni / v("equity")) * 100, 1);
  if (fcf !== null && ni > 0) r.fcf_conversion = round(fcf / ni, 2);
  if (v("equity") > 0) r.debt_to_equity = round(debt / v("equity"), 2);
  if (v("current_liabilities") > 0 && v("current_assets") !== null) r.current_ratio = round(v("current_assets") / v("current_liabilities"), 2);
  if (ocf > 0) r.debt_to_ocf = round(debt / ocf, 2);
  if (v("interest_expense") > 0 && v("operating_income") !== null) r.interest_coverage = round(v("operating_income") / v("interest_expense"), 1);
  r.net_cash = v("cash") !== null ? v("cash") - debt : null;
  r.revenue_growth_pct = growth(out.annual.revenue || []);
  r.revenue_cagr_3y_pct = cagr(out.annual.revenue || []);
  r.eps_growth_pct = growth(out.annual.eps_diluted || []);
  r.net_income_growth_pct = growth(out.annual.net_income || []);

  const shares = v("shares_outstanding");
  if (price && shares && currency === "USD") {
    const mcap = price * shares;
    const ev = mcap + debt - (v("cash") || 0);
    r.market_cap = round(mcap, 0);
    r.enterprise_value = round(ev, 0);
    if (ni > 0) r.pe_ttm = round(mcap / ni, 1);
    if (rev) r.ps_ttm = round(mcap / rev, 2);
    if (rev) r.ev_to_revenue = round(ev / rev, 2);
    if (v("equity") > 0) r.pb = round(mcap / v("equity"), 2);
    if (fcf !== null) r.fcf_yield_pct = round((fcf / mcap) * 100, 2);
    const payout = (v("dividends_paid") || 0) + (v("buybacks") || 0);
    if (payout) r.shareholder_yield_pct = round((payout / mcap) * 100, 2);
    const g = r.eps_growth_pct ?? r.net_income_growth_pct;
    if (r.pe_ttm && g > 0) r.peg = round(r.pe_ttm / g, 2);
  } else if (price && currency !== "USD") {
    out.gaps.push(`valuation multiples skipped: quote currency ${currency} differs from USD filings`);
  }
  return out;
}

export async function getFundamentals(symbol, { instrument = null, price = null, currency = "USD" } = {}) {
  symbol = normalizeSymbol(symbol);
  const inst = instrument || (await resolveInstrument(symbol));
  if (inst.route !== "operating_company") {
    return { symbol, available: false, route: inst.route, reason: `${inst.type} uses ${inst.route}; issuer financial statements do not apply` };
  }
  if (!inst.cik) {
    if (inst.sec_error) throw new Error(`SEC EDGAR unreachable (${inst.sec_error}); the CIK could not be looked up`);
    return { symbol, available: false, route: inst.route, reason: "no SEC CIK (non-US or unlisted filer); use company filings from its home regulator" };
  }
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${inst.cik}.json`;
  const doc = await fetchJson(url, { timeoutMs: 25000, ttlMs: 12 * 3600e3 });
  return {
    symbol,
    available: true,
    cik: inst.cik,
    ...summarizeCompanyFacts(doc, { price, currency }),
    source: { title: `SEC EDGAR companyfacts CIK${inst.cik}`, url, retrieved: today() },
  };
}

export async function getFilings(symbol, { forms = null, limit = 15, instrument = null } = {}) {
  symbol = normalizeSymbol(symbol);
  const inst = instrument || (await resolveInstrument(symbol));
  if (!inst.cik) {
    if (inst.sec_error) throw new Error(`SEC EDGAR unreachable (${inst.sec_error})`);
    return { symbol, available: false, reason: "no SEC CIK for this symbol (non-US or unlisted filer)" };
  }
  const url = `https://data.sec.gov/submissions/CIK${inst.cik}.json`;
  const doc = await fetchJson(url, { timeoutMs: 20000, ttlMs: 3600e3 });
  const r = doc.filings?.recent || {};
  const wanted = forms ? new Set(forms.map((f) => f.toUpperCase())) : null;
  const rows = [];
  for (let i = 0; i < (r.form || []).length && rows.length < limit; i += 1) {
    if (wanted && !wanted.has(String(r.form[i]).toUpperCase())) continue;
    const acc = String(r.accessionNumber[i]).replace(/-/g, "");
    rows.push({
      form: r.form[i],
      filed: r.filingDate[i],
      report_date: r.reportDate?.[i] || null,
      description: r.primaryDocDescription?.[i] || null,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(inst.cik)}/${acc}/${r.primaryDocument[i]}`,
    });
  }
  return { symbol, available: true, cik: inst.cik, entity: doc.name, filings: rows, source: { title: `SEC EDGAR submissions CIK${inst.cik}`, url, retrieved: today() } };
}

// ---------------------------------------------------------------- news

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .trim();
}

export function parseRss(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const block = m[0];
    const tag = (t) => decode(block.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`))?.[1]);
    const date = Date.parse(tag("pubDate"));
    items.push({
      title: tag("title"),
      url: tag("link"),
      publisher: tag("source") || null,
      date: Number.isFinite(date) ? new Date(date).toISOString().slice(0, 10) : null,
    });
  }
  return items;
}

export async function getNews(query, { days: windowDays = 30, limit = 20 } = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("news query is required");
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${windowDays}d`)}&hl=en-US&gl=US&ceid=US:en`;
  const cutoff = new Date(Date.now() - windowDays * DAY).toISOString().slice(0, 10);
  const all = parseRss(await fetchText(url, { ttlMs: 10 * 60e3 }));
  const dated = all.filter((i) => i.date && i.date >= cutoff && i.date <= today());
  return {
    query: q,
    window_days: windowDays,
    items: dated.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit),
    excluded_undated_or_out_of_window: all.length - dated.length,
    source: { title: `Google News RSS "${q}"`, url, retrieved: today() },
  };
}

// ---------------------------------------------------------------- options (Cboe delayed)

export function parseOcc(symbol) {
  const m = String(symbol).match(/^(.+?)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, ymd, cp, strike] = m;
  return { root, expiry: `20${ymd.slice(0, 2)}-${ymd.slice(2, 4)}-${ymd.slice(4, 6)}`, type: cp === "C" ? "call" : "put", strike: Number(strike) / 1000 };
}

/** Pure summary of a Cboe delayed-quotes options document. */
export function summarizeOptions(doc, asOf = today()) {
  const data = doc?.data || {};
  const spot = data.current_price ?? data.close ?? null;
  const rows = (data.options || []).map((o) => ({ ...parseOcc(o.option), iv: o.iv, oi: o.open_interest || 0, vol: o.volume || 0, delta: o.delta })).filter((o) => o.expiry);
  if (!rows.length || !spot) return { available: false, reason: "no option rows or spot price" };
  const sum = (arr, k) => arr.reduce((a, o) => a + (o[k] || 0), 0);
  const calls = rows.filter((o) => o.type === "call");
  const puts = rows.filter((o) => o.type === "put");
  const expiries = [...new Set(rows.map((o) => o.expiry))].filter((e) => e >= asOf).sort();
  const term = [];
  for (const expiry of expiries.slice(0, 8)) {
    const chain = rows.filter((o) => o.expiry === expiry && o.iv > 0);
    if (!chain.length) continue;
    const atmStrike = chain.reduce((best, o) => (Math.abs(o.strike - spot) < Math.abs(best - spot) ? o.strike : best), chain[0].strike);
    const atm = chain.filter((o) => o.strike === atmStrike);
    const iv = atm.reduce((a, o) => a + o.iv, 0) / atm.length;
    const near = (type, target) => chain.filter((o) => o.type === type && Number.isFinite(o.delta)).sort((a, b) => Math.abs(a.delta - target) - Math.abs(b.delta - target))[0];
    const p25 = near("put", -0.25);
    const c25 = near("call", 0.25);
    term.push({
      expiry,
      days: Math.round(days(asOf, expiry)),
      atm_iv_pct: round(iv * 100, 1),
      skew_25d_pct: p25 && c25 ? round((p25.iv - c25.iv) * 100, 1) : null,
    });
  }
  return {
    available: true,
    spot: round(spot),
    put_call_oi_ratio: sum(calls, "oi") ? round(sum(puts, "oi") / sum(calls, "oi")) : null,
    put_call_volume_ratio: sum(calls, "vol") ? round(sum(puts, "vol") / sum(calls, "vol")) : null,
    total_open_interest: sum(rows, "oi"),
    term_structure: term,
  };
}

export async function getOptions(symbol) {
  symbol = normalizeSymbol(symbol);
  const cboe = symbol.startsWith("^") ? `_${symbol.slice(1)}` : symbol.replace(/[.-]/g, "");
  const url = `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(cboe)}.json`;
  const doc = await fetchJson(url, { timeoutMs: 25000, ttlMs: 10 * 60e3 });
  return { symbol, ...summarizeOptions(doc), source: { title: `Cboe delayed options ${cboe}`, url, retrieved: today() } };
}

// ---------------------------------------------------------------- macro (FRED)

const FRED_SERIES = {
  DGS10: "US 10Y Treasury yield (%)",
  DGS2: "US 2Y Treasury yield (%)",
  FEDFUNDS: "Effective fed funds rate (%)",
  CPIAUCSL: "CPI index (YoY computed)",
  VIXCLS: "VIX",
  BAMLH0A0HYM2: "US high-yield OAS (%)",
  DTWEXBGS: "Broad trade-weighted USD index",
};

export function parseFredCsv(csv) {
  return String(csv).trim().split(/\r?\n/).slice(1)
    .map((line) => line.split(","))
    .map(([date, value]) => ({ date, value: Number(value) }))
    .filter((r) => r.date && Number.isFinite(r.value));
}

export async function getMacro() {
  const start = new Date(Date.now() - 800 * DAY).toISOString().slice(0, 10);
  const series = {};
  const gaps = [];
  await Promise.all(Object.entries(FRED_SERIES).map(async ([id, label]) => {
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${start}`;
    try {
      const rows = parseFredCsv(await fetchText(url, { timeoutMs: 20000, ttlMs: 6 * 3600e3 }));
      if (!rows.length) throw new Error("empty series");
      const last = rows.at(-1);
      const at = (d) => [...rows].reverse().find((r) => days(r.date, last.date) >= d);
      const m1 = at(28);
      const y1 = at(360);
      series[id] = {
        label,
        date: last.date,
        value: round(last.value, 3),
        change_1m: m1 ? round(last.value - m1.value, 3) : null,
        change_12m: y1 ? round(last.value - y1.value, 3) : null,
        url,
      };
      if (id === "CPIAUCSL" && y1) series[id].yoy_pct = round(((last.value - y1.value) / y1.value) * 100, 2);
    } catch (error) {
      gaps.push(`${id}: ${error.message}`);
    }
  }));
  if (series.DGS10 && series.DGS2) series.curve_10y_2y = { label: "10Y-2Y spread (pp)", value: round(series.DGS10.value - series.DGS2.value, 3) };
  return { series, gaps, source: { title: "FRED (St. Louis Fed) public CSV", url: "https://fred.stlouisfed.org", retrieved: today() } };
}

/** Free-text company search ("microsoft", "toyota") → best listed symbol, or null. */
export async function searchSymbol(text) {
  const q = String(text || "").trim();
  if (!q) return null;
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`;
  const data = await fetchJson(url, { ttlMs: 24 * 3600e3 });
  const hit = (data.quotes || []).find((x) => ["EQUITY", "ETF", "INDEX", "MUTUALFUND"].includes(x.quoteType));
  return hit ? { symbol: String(hit.symbol).toUpperCase(), name: hit.longname || hit.shortname || null } : null;
}
