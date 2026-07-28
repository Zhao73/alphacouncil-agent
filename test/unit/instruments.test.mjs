import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyInstrument,
  instrumentResearchChecklist,
  isFundOrIndex,
} from "../../mcp/lib/instruments.mjs";

test("Yahoo metadata routes QQQ and SPY through the ETF look-through model", () => {
  for (const symbol of ["QQQ", "SPY"]) {
    const instrument = classifyInstrument({
      symbol,
      quote: { symbol, instrument_type: "ETF", long_name: `${symbol} Exchange Traded Fund` },
    });
    assert.equal(instrument.asset_type, "etf");
    assert.equal(instrument.research_model, "fund_lookthrough");
    assert.equal(instrument.classification_source, "yahoo_chart_metadata");
    assert.equal(instrument.sec_companyfacts_applicable, false);
    assert.equal(isFundOrIndex(instrument), true);
  }
});

test("SEC registrant names preserve ETF routing when quote metadata is unavailable", () => {
  const qqq = classifyInstrument({
    symbol: "QQQ",
    filer: { title: "INVESCO QQQ TRUST, SERIES 1" },
  });
  const spy = classifyInstrument({
    symbol: "SPY",
    filer: { name: "SPDR S&P 500 ETF TRUST" },
  });
  for (const instrument of [qqq, spy]) {
    assert.equal(instrument.asset_type, "etf");
    assert.equal(instrument.classification_source, "sec_registrant_name_heuristic");
    assert.equal(instrument.sec_companyfacts_applicable, false);
  }
});

test("cash indices and operating companies receive different research contracts", () => {
  const index = classifyInstrument({ symbol: "^GSPC", quote: { instrument_type: "INDEX" } });
  const company = classifyInstrument({ symbol: "AAPL", quote: { instrument_type: "EQUITY" } });
  assert.deepEqual(
    [index.asset_type, index.research_model, index.sec_companyfacts_applicable],
    ["index", "index_aggregate", false],
  );
  assert.deepEqual(
    [company.asset_type, company.research_model, company.sec_companyfacts_applicable],
    ["equity", "operating_company", true],
  );
});

test("symbol conventions classify futures, FX and crypto without company financials", () => {
  assert.equal(classifyInstrument({ symbol: "NQ=F" }).asset_type, "future");
  assert.equal(classifyInstrument({ symbol: "JPY=X" }).asset_type, "fx");
  assert.equal(classifyInstrument({ symbol: "BTC-USD" }).asset_type, "crypto");
});

test("fund and index prompts forbid company-style financial fabrication", () => {
  const etf = classifyInstrument({ symbol: "QQQ", quote: { instrument_type: "ETF" } });
  const index = classifyInstrument({ symbol: "^GSPC", quote: { instrument_type: "INDEX" } });
  const etfEnglish = instrumentResearchChecklist(etf, "English");
  const etfChinese = instrumentResearchChecklist(etf, "中文");
  const indexEnglish = instrumentResearchChecklist(index, "English");
  assert.match(etfEnglish, /never add them into ETF revenue or EPS/i);
  assert.match(etfEnglish, /dated holdings\/weights/i);
  assert.match(etfChinese, /不得寻找基金自身营收/);
  assert.match(indexEnglish, /never add a few constituents together as index financials/i);
  assert.equal(instrumentResearchChecklist(classifyInstrument({ symbol: "AAPL" }), "English"), "");
});
