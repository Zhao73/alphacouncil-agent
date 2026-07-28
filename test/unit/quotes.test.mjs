import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";

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
});
