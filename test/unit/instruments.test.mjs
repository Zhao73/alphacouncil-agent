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

// The Stooq quote fallback returns instrument_type: null, short_name: null, long_name: null.
// Every row below is a symbol that reached production classification through that path.
test("a bare ticker shape never asserts an operating company", () => {
  for (const symbol of ["SPY", "QQQ", "VOO", "IVV", "VTI", "BRK.B", "7203.T", "0700.HK", "600519.SS"]) {
    const instrument = classifyInstrument({ symbol });
    assert.equal(instrument.asset_type, "unknown", `${symbol} must not be guessed`);
    assert.equal(instrument.classification_source, "unresolved");
    assert.equal(instrument.research_model, "market_instrument");
    assert.equal(
      instrument.sec_companyfacts_applicable,
      false,
      `${symbol} must not be sent through an operating-company Company Facts screen`,
    );
  }
});

test("fund registrant SIC codes are not evidence of an operating company", () => {
  // 6722/6726 are exactly what ETF and closed-end-fund registrants file.
  const ivv = classifyInstrument({ symbol: "IVV", filer: { name: "iShares Trust", sic: "6726" } });
  assert.equal(ivv.asset_type, "etf");
  assert.equal(ivv.classification_source, "sec_filer_sic_fund");
  assert.equal(ivv.sec_companyfacts_applicable, false);

  const cef = classifyInstrument({
    symbol: "EVV",
    filer: { name: "Eaton Vance Enhanced Equity Income Fund", sic: "6726" },
  });
  assert.equal(cef.sec_companyfacts_applicable, false);

  // A REIT (6798) is an operating company with real filings and must keep its screen.
  const reit = classifyInstrument({ symbol: "O", filer: { name: "Realty Income Corp", sic: "6798" } });
  assert.equal(reit.asset_type, "equity");
  assert.equal(reit.sec_companyfacts_applicable, true);
});

test("a fund vehicle named after an index is a fund, not a cash index", () => {
  // "Vanguard Index Funds" previously matched the bare `index` token, which routed VOO as a
  // cash index and silently disabled its option chain.
  for (const name of ["Vanguard Index Funds", "Vanguard Total Stock Market Index Fund Admiral Shares"]) {
    const instrument = classifyInstrument({ symbol: "VOO", filer: { name } });
    assert.equal(instrument.index_like, false, `${name} must not be classified as a cash index`);
    assert.equal(instrument.fund_like, true);
    assert.equal(instrument.research_model, "fund_lookthrough");
  }
  // A genuine cash index name with no fund vehicle word still resolves as an index.
  assert.equal(classifyInstrument({ symbol: "SPX", quote: { long_name: "S&P 500 Index" } }).asset_type, "index");
});

test("the fund and index research contracts are available in every run language", () => {
  const etf = classifyInstrument({ symbol: "QQQ", quote: { instrument_type: "ETF" } });
  const index = classifyInstrument({ symbol: "^GSPC" });
  for (const language of ["English", "中文", "日本語", "한국어"]) {
    for (const instrument of [etf, index]) {
      const checklist = instrumentResearchChecklist(instrument, language);
      assert.ok(checklist.length > 80, `${language} checklist must not be empty`);
      // English text leaking into a localized run is the defect this guards.
      if (language !== "English") {
        assert.ok(
          !/This is not an operating company/i.test(checklist),
          `${language} checklist fell back to English`,
        );
      }
    }
  }
});
