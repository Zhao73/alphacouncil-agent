import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CBOE_MAX_TRADING_DAY_LOOKBACK,
  INDEX_PROXIES,
  PE_BASIS,
  WSJ_INDEX_TICKERS,
  earningsYield,
  normalizeIndexSymbol,
  parseCboeDailyOptions,
  parseVixHistoryCsv,
  parseWsjMarketsDiary,
  parseWsjPeYields,
  percentileRank,
  proxyConstituents,
  tradingDayCandidates,
  valuationPercentile,
} from "../../mcp/lib/index-aggregate.mjs";

// Fixtures are trimmed copies of real 2026-07-27/28 responses. Nothing here touches the network.

const PE_PAYLOAD = () => ({
  id: "{\"indexType\":\"OTHERS\"}",
  type: "mdc_peAndYields",
  data: {
    timestamp: "Friday, July 24, 2026",
    tradeDate: "2026-07-24T00:00:00",
    instruments: [
      { instrumentId: "343303", name: "Russell 2000 Index", ticker: "RUT", priceEarningsRatio: "37.27", priceEarningsRatioEstimate: "31.57", priceEarningsRatio52WeekAgo: "33.62", yield: "1.38" },
      { instrumentId: "343343", name: "NASDAQ 100 Index", ticker: "RIXF", priceEarningsRatio: "33.05", priceEarningsRatioEstimate: "25.12", priceEarningsRatio52WeekAgo: "32.72", yield: "0.58" },
      { instrumentId: "497001", name: "S&P 500 Index", ticker: "INX", priceEarningsRatio: "25.17", priceEarningsRatioEstimate: "21.1", priceEarningsRatio52WeekAgo: "24.85", yield: "1.11" },
    ],
    formattedTradeDate: "7/24/26",
  },
});

const DIARY_PAYLOAD = () => ({
  id: "{\"application\":\"WSJ\"}",
  type: "mdc_marketsdiary",
  data: {
    timestamp: "Monday, July 27, 2026",
    instrumentSets: [
      {
        headerFields: [{ value: "name", label: "NYSE" }, { value: "latestClose", label: "Latest Close" }],
        instruments: [
          { id: "issuestraded", name: "Issues traded", latestClose: "2,833", previousClose: "2,833", weekAgo: "2,842" },
          { id: "advances", name: "Advances", latestClose: "1,729", previousClose: "1,652", weekAgo: "1,021" },
          { id: "declines", name: "Declines", latestClose: "1,022", previousClose: "1,073", weekAgo: "1,734" },
          { id: "unchanged", name: "Unchanged", latestClose: "82", previousClose: "108", weekAgo: "87" },
          { id: "newhighs", name: "New highs", latestClose: "109", previousClose: "88", weekAgo: "53" },
          { id: "newlows", name: "New lows", latestClose: "52", previousClose: "73", weekAgo: "48" },
          // The NYSE table really does repeat these ids: starred rows are primary market, the
          // unstarred repeats are composite. Neither is extracted, so neither may break parsing.
          { id: "advvolume", name: "Adv. volume*", latestClose: "829,128,349", previousClose: "642,713,838", weekAgo: "422,371,583" },
          { id: "closingarmstrin", name: "Closing Arms (TRIN)†", latestClose: "0.65", previousClose: "1.18", weekAgo: "0.74" },
          { id: "advvolume", name: "Adv. volume", latestClose: "3,626,095,086", previousClose: "2,732,140,150", weekAgo: "2,248,840,912" },
        ],
      },
      {
        headerFields: [{ value: "name", label: "NASDAQ" }, { value: "latestClose", label: "Latest Close" }],
        instruments: [
          { id: "advances", name: "Advances", latestClose: "2,982", previousClose: "2,124", weekAgo: "1,718" },
          { id: "declines", name: "Declines", latestClose: "1,858", previousClose: "2,751", weekAgo: "3,111" },
          { id: "newhighs", name: "New highs", latestClose: "151", previousClose: "108", weekAgo: "64" },
          { id: "newlows", name: "New lows", latestClose: "230", previousClose: "262", weekAgo: "232" },
          { id: "closingarmstrin", name: "Closing Arms (TRIN)†", latestClose: "1.02", previousClose: "1.37", weekAgo: "0.69" },
        ],
      },
    ],
  },
});

const CBOE_PAYLOAD = () => ({
  ratios: [
    { name: "TOTAL PUT/CALL RATIO", value: "0.94" },
    { name: "INDEX PUT/CALL RATIO", value: "1.02" },
    { name: "EXCHANGE TRADED PRODUCTS PUT/CALL RATIO", value: "1.14" },
    { name: "EQUITY PUT/CALL RATIO", value: "0.66" },
    { name: "CBOE VOLATILITY INDEX (VIX) PUT/CALL RATIO", value: "0.50" },
    { name: "SPX + SPXW PUT/CALL RATIO", value: "1.07" },
    { name: "OEX PUT/CALL RATIO", value: "0.00" },
  ],
  "SUM OF ALL PRODUCTS": [
    { name: "VOLUME", call: 7018459, put: 6618932, total: 13637391 },
    { name: "OPEN INTEREST", call: 337360276, put: 255825343, total: 593185619 },
  ],
  "EQUITY OPTIONS": [{ name: "VOLUME", call: 2197659, put: 1459922, total: 3657581 }],
});

const dailySeries = (start, values) => {
  const rows = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  for (const value of values) {
    rows.push({ date: cursor.toISOString().slice(0, 10), value });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return rows;
};

// ---- Index valuation ---------------------------------------------------------

test("a valuation fact always names exactly one basis, and its units", () => {
  // WSJ 25.17, multpl 28.53 and IVV 29.80 were all the S&P 500 on 2026-07-24. A fact that does
  // not say which basis it is on cannot be compared with anything.
  const parsed = parseWsjPeYields(PE_PAYLOAD());
  assert.equal(parsed.trade_date, "2026-07-24");
  assert.equal(parsed.public_at, "2026-07-24T00:00:00.000Z");
  assert.equal(parsed.instruments.length, 3);
  for (const fact of parsed.instruments) {
    assert.equal(fact.basis, PE_BASIS.WSJ_INDEX);
    assert.ok(fact.basis_note);
    // Three different units live in one fact; each is spelled out so none can be read as another.
    assert.equal(fact.pe_unit, "ratio");
    assert.equal(fact.dividend_yield_unit, "percent");
    assert.equal(fact.trade_date, "2026-07-24");
    assert.equal(fact.public_at, "2026-07-24T00:00:00.000Z");
    assert.match(fact.source_url, /^https:\/\/www\.wsj\.com\/market-data\/stocks\/peyields\?/u);
  }
});

test("WSJ internal tickers are mapped explicitly, never matched on display name", () => {
  // NASDAQ 100 ships under "RIXF" and the S&P 500 under "INX"; neither is an exchange symbol.
  const byTicker = Object.fromEntries(parseWsjPeYields(PE_PAYLOAD()).instruments.map((f) => [f.ticker, f]));
  assert.equal(byTicker.INX.symbol, "^GSPC");
  assert.equal(byTicker.RIXF.symbol, "^NDX");
  assert.equal(byTicker.RUT.symbol, "^RUT");
  assert.equal(byTicker.RIXF.pe_trailing, 33.05);
  assert.equal(byTicker.RIXF.pe_forward, 25.12);
  assert.equal(byTicker.RIXF.pe_52w_ago, 32.72);
  assert.equal(byTicker.RIXF.dividend_yield, 0.58);
  assert.deepEqual(Object.keys(WSJ_INDEX_TICKERS).sort(), ["INX", "RIXF", "RUT"]);
  // The Dow is simply not in this feed, which has to stay a visible gap rather than a lookalike.
  assert.equal(parseWsjPeYields(PE_PAYLOAD()).instruments.some((f) => f.symbol === "^DJI"), false);
});

test("an undocumented API changing shape fails closed instead of producing a number", () => {
  const mutate = (fn) => { const payload = PE_PAYLOAD(); fn(payload); return payload; };
  assert.throws(() => parseWsjPeYields(mutate((p) => { p.type = "mdc_peAndYieldsV2"; })), /unexpected payload type/u);
  assert.throws(() => parseWsjPeYields(mutate((p) => { p.data.tradeDate = "7/24/26"; })), /unrecognised date/u);
  assert.throws(() => parseWsjPeYields(mutate((p) => { p.data.instruments = {}; })), /expected a non-empty array/u);
  assert.throws(() => parseWsjPeYields(mutate((p) => { delete p.data.instruments[2].ticker; })), /ticker: expected a non-empty string/u);
  assert.throws(() => parseWsjPeYields(mutate((p) => { delete p.data.instruments[2].priceEarningsRatio; })), /priceEarningsRatio: missing/u);
  assert.throws(() => parseWsjPeYields(mutate((p) => { p.data.instruments[2].priceEarningsRatio = "n/a"; })), /not numeric/u);
  // The dangerous mutation: the field keeps its name but starts carrying an earnings yield.
  assert.throws(() => parseWsjPeYields(mutate((p) => { p.data.instruments[2].priceEarningsRatio = "0.0397"; })), /outside the plausible band/u);
  assert.throws(() => parseWsjPeYields(mutate((p) => { p.data.instruments[2].yield = "1100"; })), /outside the plausible band/u);
  assert.throws(() => parseWsjPeYields(null), /expected an object/u);
});

test("an absent secondary field is a null, not a reason to discard the primary one", () => {
  const payload = PE_PAYLOAD();
  delete payload.data.instruments[2].priceEarningsRatioEstimate;
  delete payload.data.instruments[2].yield;
  const sp = parseWsjPeYields(payload).instruments.find((f) => f.symbol === "^GSPC");
  assert.equal(sp.pe_trailing, 25.17);
  assert.equal(sp.pe_forward, null);
  assert.equal(sp.dividend_yield, null);
});

test("earnings yield is a decimal fraction and refuses a P/E that cannot be inverted", () => {
  assert.equal(earningsYield(25.17), Number((1 / 25.17).toFixed(6)));
  assert.equal(earningsYield("25"), 0.04);
  for (const bad of [0, -5, null, undefined, "", "n/a", NaN, Infinity, {}]) {
    assert.equal(earningsYield(bad), null, `earningsYield(${JSON.stringify(bad)}) must be null`);
  }
});

// ---- Breadth -----------------------------------------------------------------

test("breadth carries only the dated column and survives WSJ's repeated volume rows", () => {
  const diary = parseWsjMarketsDiary(DIARY_PAYLOAD());
  assert.equal(diary.trade_date, "2026-07-27");
  assert.equal(diary.public_at, "2026-07-27T00:00:00.000Z");
  const nyse = diary.by_venue.NYSE;
  assert.equal(nyse.advances, 1729);
  assert.equal(nyse.declines, 1022);
  assert.equal(nyse.new_highs, 109);
  assert.equal(nyse.new_lows, 52);
  assert.equal(nyse.trin, 0.65);
  assert.equal(nyse.net_advances, 707);
  assert.equal(nyse.net_new_highs, 57);
  assert.equal(nyse.advance_decline_ratio, Number((1729 / 1022).toFixed(4)));
  assert.equal(nyse.trade_date, "2026-07-27");
  assert.equal(diary.by_venue.NASDAQ.advances, 2982);
  // previousClose and weekAgo are published without their dates, so they are not carried.
  assert.equal("previous_close" in nyse, false);
});

test("a breadth table that changed meaning fails closed", () => {
  const duplicated = DIARY_PAYLOAD();
  duplicated.data.instrumentSets[0].instruments.push({ id: "advances", name: "Advances", latestClose: "9" });
  assert.throws(() => parseWsjMarketsDiary(duplicated), /duplicate row for advances/u);

  const missing = DIARY_PAYLOAD();
  missing.data.instrumentSets[1].instruments = missing.data.instrumentSets[1].instruments.filter((r) => r.id !== "declines");
  assert.throws(() => parseWsjMarketsDiary(missing), /missing declines/u);

  const reordered = DIARY_PAYLOAD();
  reordered.data.instrumentSets[0].headerFields[0] = { value: "latestClose", label: "Latest Close" };
  assert.throws(() => parseWsjMarketsDiary(reordered), /first header column/u);

  const undated = DIARY_PAYLOAD();
  undated.data.timestamp = "27/07/2026";
  assert.throws(() => parseWsjMarketsDiary(undated), /unrecognised date/u);
});

// ---- Put/call and the trading-day walk-back ----------------------------------

test("the walk-back skips weekends and keeps the newest candidate first", () => {
  // 2026-07-28 is a Tuesday; 07-26 is Sunday and 07-25 is Saturday.
  assert.deepEqual(tradingDayCandidates("2026-07-28"), [
    "2026-07-28", "2026-07-27", "2026-07-24", "2026-07-23", "2026-07-22",
  ]);
  // Asked for a Sunday, the first thing worth trying is the Friday before it.
  assert.deepEqual(tradingDayCandidates("2026-07-26"), [
    "2026-07-24", "2026-07-23", "2026-07-22", "2026-07-21", "2026-07-20",
  ]);
  assert.equal(tradingDayCandidates("2026-07-28").length, CBOE_MAX_TRADING_DAY_LOOKBACK);
  assert.deepEqual(tradingDayCandidates("2026-07-28", 1), ["2026-07-28"]);
  for (const day of tradingDayCandidates("2026-07-28", 5)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    assert.ok(weekday !== 0 && weekday !== 6, `${day} is a weekend and CBOE never publishes one`);
  }
  // A junk or absent as-of falls back to today rather than inventing a date, and stays bounded.
  assert.equal(tradingDayCandidates("not-a-date").length, CBOE_MAX_TRADING_DAY_LOOKBACK);
  assert.equal(tradingDayCandidates(null, 0).length, 1);
});

test("the answered trade date is kept distinct from the date that was asked for", () => {
  // Today's file 403s until it is published, so a Tuesday request is routinely served Monday.
  const parsed = parseCboeDailyOptions(CBOE_PAYLOAD(), {
    tradeDate: "2026-07-27", sourceUrl: "https://cdn.cboe.com/x", requestedAsOf: "2026-07-28", attempts: ["2026-07-28: HTTP 403"],
  });
  assert.equal(parsed.trade_date, "2026-07-27");
  assert.equal(parsed.requested_as_of, "2026-07-28");
  assert.equal(parsed.public_at, "2026-07-27T00:00:00.000Z");
  assert.deepEqual(parsed.skipped_dates, ["2026-07-28: HTTP 403"]);
  assert.equal(parsed.ratios.total, 0.94);
  assert.equal(parsed.ratios.index, 1.02);
  assert.equal(parsed.ratios.equity, 0.66);
  assert.equal(parsed.ratios.spx_spxw, 1.07);
  assert.equal(parsed.volume.total.volume.put, 6618932);
  assert.equal(parsed.volume.index, null);
});

test("a CBOE zero means no contracts traded, not a put/call ratio of zero", () => {
  const quiet = CBOE_PAYLOAD();
  quiet.ratios[1].value = "0.00";
  const parsed = parseCboeDailyOptions(quiet, { tradeDate: "2026-07-27", sourceUrl: "https://cdn.cboe.com/x" });
  assert.equal(parsed.ratios.index, null, "0.00 must not read as extreme call skew");
  assert.equal(parsed.ratios.total, 0.94);

  const noTotal = CBOE_PAYLOAD();
  noTotal.ratios = noTotal.ratios.filter((r) => r.name !== "TOTAL PUT/CALL RATIO");
  assert.throws(() => parseCboeDailyOptions(noTotal, { tradeDate: "2026-07-27" }), /TOTAL PUT\/CALL RATIO is absent/u);

  const zeroTotal = CBOE_PAYLOAD();
  zeroTotal.ratios[0].value = "0.00";
  assert.throws(() => parseCboeDailyOptions(zeroTotal, { tradeDate: "2026-07-27" }), /not a usable number/u);
  assert.throws(() => parseCboeDailyOptions({ ratios: [] }, { tradeDate: "2026-07-27" }), /expected a non-empty array/u);
});

// ---- VIX history --------------------------------------------------------------

test("VIX rows are parsed strictly and a broken row is dropped, never carried forward", () => {
  const csv = [
    "DATE,OPEN,HIGH,LOW,CLOSE",
    "07/22/2026,17.10,17.90,16.80,17.44",
    "bad row,1,2,3,4",
    "07/23/2026,17.670000,20.310000,17.320000,18.700000",
    "07/24/2026,18.960000,19.050000,17.410000,",
    "07/27/2026,17.620000,19.930000,17.530000,18.670000",
  ].join("\n");
  const series = parseVixHistoryCsv(csv);
  assert.deepEqual(series.observations.map((row) => row.date), ["2026-07-22", "2026-07-23", "2026-07-27"]);
  assert.equal(series.latest, 18.67);
  assert.equal(series.observation_date, "2026-07-27");
  assert.equal(series.public_at, "2026-07-27T00:00:00.000Z");
  assert.equal(series.unit, "index_points");
  // A historical cutoff must not see a close published after it.
  assert.equal(parseVixHistoryCsv(csv, { asOf: "2026-07-23" }).latest, 18.7);
  assert.throws(() => parseVixHistoryCsv("CLOSE,DATE\n1,2\n"), /unexpected header/u);
  assert.throws(() => parseVixHistoryCsv(""), /empty CSV/u);
  assert.throws(() => parseVixHistoryCsv("DATE,OPEN,HIGH,LOW,CLOSE\n07/27/2026,1,2,3,x\n"), /no numeric observations/u);
});

// ---- Percentiles ---------------------------------------------------------------

test("a percentile reports the sample it ranked against and refuses a short one", () => {
  const values = Array.from({ length: 400 }, (_, index) => index);
  const rank = percentileRank(dailySeries("2025-01-01", values));
  assert.equal(rank.percentile, Number(((values.length - 1) / values.length).toFixed(4)));
  assert.equal(rank.sample_size, values.length);
  assert.ok(rank.sample_start < rank.sample_end);
  // Same contract whether given a series object or a bare observation array.
  assert.deepEqual(percentileRank({ observations: dailySeries("2025-01-01", values) }), rank);
  // "the 92nd percentile" means nothing without saying percentile of what and since when.
  assert.equal(percentileRank(dailySeries("2026-07-01", [1, 2, 3])), null);
  assert.equal(percentileRank(null), null);
});

test("a valuation percentile is refused rather than fabricated from one point", () => {
  const fact = parseWsjPeYields(PE_PAYLOAD()).instruments.find((f) => f.symbol === "^GSPC");
  // No history at all: the only honest answer is null plus a named gap upstream.
  assert.equal(valuationPercentile(fact, { history: null }), null);
  assert.equal(valuationPercentile(fact, { history: [{ date: fact.trade_date, value: fact.pe_trailing }] }), null);

  const history = {
    basis: PE_BASIS.WSJ_INDEX,
    observations: dailySeries("2025-01-01", Array.from({ length: 400 }, (_, i) => 15 + (i / 100))),
  };
  const ranked = valuationPercentile(fact, { history });
  assert.equal(ranked.metric, "pe_trailing");
  assert.equal(ranked.basis, PE_BASIS.WSJ_INDEX);
  assert.equal(ranked.value, 25.17);
  assert.equal(ranked.sample_size, 400);

  // Ranking a WSJ-basis 25.17x inside a GAAP as-reported history would invent a cheap market.
  assert.equal(valuationPercentile(fact, { history: { ...history, basis: PE_BASIS.GAAP_AS_REPORTED_TTM } }), null);
  assert.equal(valuationPercentile(null, { history }), null);
});

// ---- Proxy mapping and licensing -------------------------------------------------

test("a constituent list is always labelled a proxy, because the index itself is licensed", () => {
  for (const [symbol, proxy] of Object.entries(INDEX_PROXIES)) {
    assert.ok(proxy.etf, `${symbol} must map to a tracking ETF`);
    assert.ok(proxy.licensor, `${symbol} must name its index licensor`);
    assert.ok(proxy.why, `${symbol} must say why a proxy is used`);
  }
  assert.equal(INDEX_PROXIES["^GSPC"].etf, "IVV");
  assert.equal(INDEX_PROXIES["^NDX"].etf, "QQQ");
  assert.equal(INDEX_PROXIES["^DJI"].etf, "DIA");
  assert.equal(INDEX_PROXIES["^GSPC"].licensor, "S&P Dow Jones Indices");

  const empty = proxyConstituents("^GSPC");
  assert.equal(empty.is_proxy, true);
  assert.equal(empty.proxy_etf, "IVV");
  assert.equal(empty.holdings, null);
  assert.ok(empty.license_note.includes("proxy"));

  const withHoldings = proxyConstituents("SPX", [{ symbol: "AAPL", weight: 0.071 }]);
  assert.equal(withHoldings.proxy_for, "^GSPC");
  assert.equal(withHoldings.is_proxy, true, "supplying holdings must never demote the proxy label");
  assert.equal(withHoldings.holdings_source, "caller_supplied_etf_holdings");
  assert.equal(withHoldings.holdings_count, 1);

  // An index with no mapped tracking ETF is a gap, not a silent fall-through to another index.
  // ^IXIC is the standing example: it has an alias so a caller can name it, and no proxy, so
  // naming it buys a stated gap rather than another index's holdings.
  assert.equal(proxyConstituents("^IXIC"), null);
  assert.equal(proxyConstituents("NOT_AN_INDEX"), null);

  // Newly mapped baskets carry the same proxy labelling as the originals rather than being
  // quietly exempt from it.
  for (const index of ["^SOX", "^RUT"]) {
    const mapped = proxyConstituents(index);
    assert.equal(mapped.is_proxy, true, index);
    assert.ok(mapped.license_note.includes("proxy"), index);
    assert.ok(mapped.licensor, index);
  }
});

test("index aliases resolve without guessing at unknown input", () => {
  for (const alias of ["^GSPC", "gspc", "SPX", "sp500", "标普500"]) {
    assert.equal(normalizeIndexSymbol(alias), "^GSPC", `${alias} should resolve to ^GSPC`);
  }
  assert.equal(normalizeIndexSymbol("ndx"), "^NDX");
  assert.equal(normalizeIndexSymbol("djia"), "^DJI");
  // Unknown input is passed through unchanged rather than being decorated into a fake index.
  assert.equal(normalizeIndexSymbol("QQQ"), "QQQ");
  assert.equal(normalizeIndexSymbol(""), "");
});
