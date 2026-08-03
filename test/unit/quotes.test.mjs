import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";
import { withQuoteFreshness } from "../../mcp/lib/quotes.mjs";

const { resolveMarketSymbol, parseYahooChart, parseStooqCsv } = __test__;

// Offline only: the selfcheck and the test suite must never hit the network.

test("resolveMarketSymbol maps aliases and passes raw tickers through", () => {
  assert.equal(resolveMarketSymbol("KOSPI"), "^KS11");
  assert.equal(resolveMarketSymbol("纳指期货"), "NQ=F");
  assert.equal(resolveMarketSymbol("AAPL"), "AAPL");
});

test("parseYahooChart computes price/change/change_pct from chart meta", () => {
  const quote = parseYahooChart({
    chart: {
      result: [{
        meta: {
          symbol: "^KS11",
          regularMarketPrice: 2500,
          chartPreviousClose: 2450,
          currency: "KRW",
          marketState: "POST",
          regularMarketTime: 1700000000,
          instrumentType: "INDEX",
          shortName: "KOSPI Composite Index",
          longName: "Korea Composite Stock Price Index",
          exchangeTimezoneName: "Asia/Seoul",
        },
      }],
    },
  }, "^KS11");
  assert.equal(quote.price, 2500);
  assert.equal(quote.previous_close, 2450);
  assert.equal(quote.change, 50);
  assert.equal(quote.change_pct, 2.04);
  assert.equal(quote.source, "yahoo");
  assert.equal(quote.instrument_type, "INDEX");
  assert.equal(quote.short_name, "KOSPI Composite Index");
  assert.equal(quote.long_name, "Korea Composite Stock Price Index");
  assert.equal(quote.exchange_timezone, "Asia/Seoul");
});

test("parseYahooChart throws when no price is present", () => {
  assert.throws(() => parseYahooChart({ chart: { result: [{ meta: {} }] } }, "X"));
});

test("parseStooqCsv parses the close from the CSV row", () => {
  const quote = parseStooqCsv(
    "Symbol,Date,Time,Open,High,Low,Close,Volume\n^spx,2026-06-22,21:00:00,5000,5050,4990,5030,0",
    "^spx",
  );
  assert.equal(quote.price, 5030);
  assert.equal(quote.source, "stooq");
  const stamped = withQuoteFreshness(quote, "2026-06-23T12:00:00.000Z");
  assert.equal(stamped.quote_status, "end_of_day_close");
  assert.equal(stamped.stale_age_seconds, null, "a zone-less fallback time must not inherit the machine timezone");
});

test("quote freshness measures a weekend regular close instead of claiming a fixed delay", () => {
  const quote = withQuoteFreshness({
    source: "yahoo",
    instrument_type: "EQUITY",
    market_state: null,
    quote_time: "2026-07-31T20:00:01.000Z",
  }, "2026-08-03T08:50:27.762Z");

  assert.equal(quote.stale_age_seconds, 219027);
  assert.equal(quote.stale_age_hours, 60.84);
  assert.equal(quote.quote_status, "regular_close");
  assert.equal(quote.quote_basis, "regular_market_price");
  assert.equal(quote.is_realtime, false);
});

test("freshness distinguishes a delayed regular-session observation from real-time", () => {
  const quote = withQuoteFreshness({
    source: "yahoo",
    instrument_type: "EQUITY",
    market_state: "REGULAR",
    quote_time: "2026-08-03T14:45:00.000Z",
  }, "2026-08-03T15:00:00.000Z");

  assert.equal(quote.stale_age_seconds, 900);
  assert.equal(quote.quote_status, "regular_session_delayed");
  assert.equal(quote.is_realtime, false);
});
