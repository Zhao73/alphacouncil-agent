import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

import { repoFile } from "../helpers/paths.mjs";

import {
  DAILY_SHARES_ISSUERS,
  FUND_REGISTRY,
  LOOK_THROUGH_METRICS,
  MIN_LOOK_THROUGH_COVERAGE,
  assertInvescoQuery,
  asYield,
  checkWeightSum,
  fundFlow,
  invescoHoldingsUrl,
  isharesHoldingsUrl,
  isoDate,
  lookThroughAggregate,
  parseIsharesHoldingsCsv,
  parseInvescoHoldings,
  parseSsgaHoldingsXlsx,
  parseVanguardHoldings,
  resolveFund,
  topHoldingsCoverage,
  vanguardHoldingsUrl,
} from "../../mcp/lib/funds.mjs";

const holdings = (rows) => rows.map(([ticker, weight]) => ({ ticker, weight, name: ticker, units: 1 }));

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("every registered fund names an issuer and that issuer's own identifier", () => {
  // Each issuer keys on something different and the wrong key fails differently, so the
  // identifier is stored rather than derived from the ticker.
  for (const ticker of ["QQQ", "QQQM", "SPY", "IVV", "IWM", "EFA", "AGG", "TLT", "HYG", "VOO", "VTI"]) {
    const fund = resolveFund(ticker);
    assert.ok(fund.supported, `${ticker} must be registered`);
    assert.ok(fund.issuer, `${ticker} must name an issuer`);
    const key = { ishares: "product_id", ssga: "slug", invesco: "cusip", vanguard: "ticker" }[fund.issuer];
    assert.ok(fund[key], `${ticker} must carry the ${fund.issuer} identifier (${key})`);
  }
  assert.equal(FUND_REGISTRY.QQQ.cusip, "46090E103");
  // QQQM is a separate share class with its own CUSIP; reusing QQQ's, or guessing a
  // neighbouring one, resolves to a different fund entirely rather than failing.
  assert.notEqual(FUND_REGISTRY.QQQM.cusip, FUND_REGISTRY.QQQ.cusip);
});

test("an unregistered ticker is unsupported, never a constructed URL", () => {
  const fund = resolveFund("ARKK");
  assert.equal(fund.supported, false);
  assert.match(fund.reason, /not in the fund registry/);
  assert.ok(fund.supported_symbols.includes("SPY"));
  assert.equal(resolveFund("").supported, false);
});

// ---------------------------------------------------------------------------
// iShares: HTML body behind a CSV content-type and HTTP 200
// ---------------------------------------------------------------------------

const IVV_CSV = [
  "iShares Core S&P 500 ETF",
  'Fund Holdings as of,"Jul 27, 2026"',
  'Inception Date,"May 15, 2000"',
  'Shares Outstanding,"1,167,700,000.00"',
  "",
  "Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price",
  '"AAPL","APPLE INC","Information Technology","Equity","67,107,838,139.86","60.00","67,107,838,139.86","199,186,246.00","336.91"',
  '"SCND","SECOND HOLDING CORP","Information Technology","Equity","64,548,339,668.62","39.95","64,548,339,668.62","328,473.00","196.51"',
  '"ESU6","S&P500 EMINI SEP 26","Cash and/or Derivatives","Futures","0.00","0.05","1,907,496,825.00","5,122.00","7,448.25"',
  "",
  "The content contained herein is owned or licensed by BlackRock.",
].join("\n");

test("an HTML body served as text/csv at HTTP 200 is rejected on content, not status", () => {
  // The retired `.ajax?fileType=csv` holdings path answers 200 with Content-Type text/csv and
  // a 2.2MB product page as the body, for every User-Agent. Nothing in the response envelope
  // reveals that, so only the first bytes of the body can.
  const page = '<!DOCTYPE html>\n<html lang="en-US">\n<head><title>iShares Core S&P 500 ETF</title>';
  assert.throws(() => parseIsharesHoldingsCsv(page), /HTML document with a CSV content-type/);
  assert.throws(() => parseIsharesHoldingsCsv("  \n<html><body>nope</body></html>"), /HTML document/);
  assert.throws(() => parseIsharesHoldingsCsv(""), /empty/);
});

test("a CSV with no holdings table fails closed rather than returning zero holdings", () => {
  assert.throws(() => parseIsharesHoldingsCsv("Some Fund\nFund Holdings as of,\"Jul 27, 2026\"\n"), /no `Ticker,Name` holdings header/);
});

test("iShares weights are normalised to decimals and the header block is read", () => {
  const parsed = parseIsharesHoldingsCsv(IVV_CSV, { symbol: "IVV" });
  assert.equal(parsed.as_of, "2026-07-27");
  assert.equal(parsed.shares_outstanding, 1167700000);
  assert.equal(parsed.holdings.length, 3);
  // "60.00" is sixty percent of the fund, which is 0.6 -- not 60.
  assert.equal(parsed.holdings[0].weight, 0.6);
  assert.equal(parsed.holdings[0].units, 199186246);
  // Quoted fields contain commas; a naive split would shear every row.
  assert.equal(parsed.holdings[1].name, "SECOND HOLDING CORP");
  // Index futures and cash sleeves sit in the same table as common stock.
  assert.equal(parsed.holdings[2].asset_class, "Futures");
});

// ---------------------------------------------------------------------------
// Invesco: silent truncation and the load-bearing query string
// ---------------------------------------------------------------------------

test("a truncated Invesco response is caught by the count it states about itself", () => {
  // `loadType=initial` returns the first 10 holdings while totalNumberOfHoldings still says
  // 108. Every weight computed from that file is wrong and nothing in it looks wrong.
  const truncated = {
    cusip: "46090E103",
    effectiveDate: "2026-07-27",
    totalNumberOfHoldings: 108,
    holdings: [{ ticker: "AAPL", issuerName: "Apple Inc", units: 1, percentageOfTotalNetAssets: 8.26 }],
  };
  assert.throws(() => parseInvescoHoldings(truncated), /returned 1 holdings but declares 108.*truncated/s);
});

test("the Invesco query string is asserted, because both parameters fail silently", () => {
  const url = invescoHoldingsUrl("46090E103");
  assert.equal(assertInvescoQuery(url), url);
  assert.match(url, /dng-api\.invesco\.com/);
  // Omitting interval=daily can serve a stale cached date.
  assert.throws(() => assertInvescoQuery(url.replace("&interval=daily", "")), /interval=daily/);
  // loadType truncates to 10 holdings at HTTP 200.
  assert.throws(() => assertInvescoQuery(`${url}&loadType=initial`), /loadType/);
  // idType=ticker resolves QQQ and nothing else; QQQM answers HTTP 500.
  assert.throws(() => assertInvescoQuery(url.replace("idType=cusip", "idType=ticker")), /CUSIP/);
});

test("Invesco percentages become decimals and a missing date fails closed", () => {
  const parsed = parseInvescoHoldings({
    cusip: "46090E103",
    effectiveDate: "2026-07-27",
    totalNumberOfHoldings: 2,
    holdings: [
      { ticker: "AAPL", issuerName: "Apple Inc", units: 110916203, percentageOfTotalNetAssets: 60, securityTypeName: "Common Stock" },
      { ticker: "-", issuerName: "Cash", units: 0, percentageOfTotalNetAssets: 40, securityTypeName: "Uninvestible Cash" },
    ],
  }, { symbol: "QQQ" });
  assert.equal(parsed.as_of, "2026-07-27");
  assert.equal(parsed.holdings[0].weight, 0.6);
  assert.equal(parsed.holdings[1].asset_class, "Uninvestible Cash");
  assert.throws(() => parseInvescoHoldings({ totalNumberOfHoldings: 1, holdings: [{ ticker: "A", percentageOfTotalNetAssets: 100 }] }), /no parseable effectiveDate/);
});

// ---------------------------------------------------------------------------
// Vanguard: dead `next` link, month-end cadence
// ---------------------------------------------------------------------------

const vanguardPage = (entities, size) => ({
  size,
  asOfDate: "2026-06-30T00:00:00-04:00",
  next: { href: "http://api.vanguard.com/rs/ire/01/ind/fund/VOO/portfolio-holding/stock?start=501&count=500" },
  fund: { entity: entities },
});

test("a short Vanguard walk is caught against the size the payload declares", () => {
  // The payload's own `next` link points at the dead api.vanguard.com host, so a caller that
  // follows it stops at page one and sees a 504-name fund as a 500-name fund.
  const page = vanguardPage([
    { ticker: "SCND", longName: "Second Holding Corp.", sharesHeld: "629128862", percentWeight: "60.00" },
  ], 504);
  assert.throws(() => parseVanguardHoldings([page]), /returned 1 holdings but declares 504.*dead api\.vanguard\.com/s);
});

test("Vanguard holdings are month-end and say so", () => {
  const parsed = parseVanguardHoldings([vanguardPage([
    { ticker: "SCND", longName: "Second Holding Corp.", sharesHeld: "629128862", percentWeight: "60.00" },
    { ticker: "AAPL", longName: "Apple Inc.", sharesHeld: "100", percentWeight: "40.00" },
  ], 2)], { symbol: "VOO" });
  assert.equal(parsed.as_of, "2026-06-30");
  // Not daily. A reader comparing this against a daily iShares file has to know that.
  assert.equal(parsed.cadence, "month_end");
  assert.equal(parsed.holdings[0].weight, 0.6);
  assert.equal(parsed.holdings[0].units, 629128862);
  // Vanguard publishes no shares outstanding anywhere keyless.
  assert.equal(parsed.shares_outstanding, null);
});

test("pagination starts at the live host, not at the payload's dead next link", () => {
  assert.match(vanguardHoldingsUrl("VOO"), /^https:\/\/investor\.vanguard\.com\S+\/VOO\/portfolio-holding\/stock$/);
  assert.match(vanguardHoldingsUrl("VOO", 501), /investor\.vanguard\.com.*start=501&count=500/);
  assert.doesNotMatch(vanguardHoldingsUrl("VOO", 501), /api\.vanguard\.com/);
  assert.match(isharesHoldingsUrl("239726"), /\/us\/products\/239726\/x\/latest-holdings\.csv$/);
});

// ---------------------------------------------------------------------------
// SSGA: xlsx read with node builtins
// ---------------------------------------------------------------------------

/** Build a minimal ZIP the way SSGA's workbook is laid out, to exercise the reader. */
const zip = (files) => {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, "utf8");
    const raw = Buffer.from(content, "utf8");
    const body = deflateRawSync(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += header.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, eocd]);
};

const sheetCell = (ref, index) => `<c r="${ref}" t="s"><v>${index}</v></c>`;
const numberCell = (ref, value) => `<c r="${ref}"><v>${value}</v></c>`;

const SSGA_STRINGS = [
  "Fund Name:", "State Street® SPDR® S&P 500® ETF Trust", "Ticker Symbol:", "SPY",
  "Holdings:", "As of 27-Jul-2026", "Name", "Ticker", "Identifier", "Weight", "Sector",
  "Shares Held", "APPLE INC", "AAPL", "037833100", "Information Technology",
];
const stringIndex = (value) => SSGA_STRINGS.indexOf(value);

const ssgaWorkbook = () => zip({
  "xl/sharedStrings.xml": `<?xml version="1.0"?><sst>${SSGA_STRINGS.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`,
  "xl/worksheets/sheet1.xml": `<?xml version="1.0"?><worksheet><sheetData>`
    + `<row r="1">${sheetCell("A1", stringIndex("Fund Name:"))}${sheetCell("B1", stringIndex("State Street® SPDR® S&P 500® ETF Trust"))}</row>`
    + `<row r="2">${sheetCell("A2", stringIndex("Ticker Symbol:"))}${sheetCell("B2", stringIndex("SPY"))}</row>`
    + `<row r="3">${sheetCell("A3", stringIndex("Holdings:"))}${sheetCell("B3", stringIndex("As of 27-Jul-2026"))}</row>`
    + `<row r="4">${sheetCell("A4", stringIndex("Name"))}${sheetCell("B4", stringIndex("Ticker"))}`
    + `${sheetCell("C4", stringIndex("Identifier"))}${sheetCell("E4", stringIndex("Weight"))}`
    + `${sheetCell("F4", stringIndex("Sector"))}${sheetCell("G4", stringIndex("Shares Held"))}</row>`
    + `<row r="5">${sheetCell("A5", stringIndex("APPLE INC"))}${sheetCell("B5", stringIndex("AAPL"))}`
    + `${sheetCell("C5", stringIndex("037833100"))}${numberCell("E5", "100.0")}`
    + `${sheetCell("F5", stringIndex("Information Technology"))}${numberCell("G5", "1.81367013E8")}</row>`
    + `</sheetData></worksheet>`,
});

test("the SSGA workbook is read with node builtins and no dependency", () => {
  // Column D is deliberately absent from the fixture's header row, as it is in the real
  // workbook layout: xlsx cells are addressed, not ordered, so a reader that positioned by
  // sequence would read Weight out of the Sector column.
  const parsed = parseSsgaHoldingsXlsx(ssgaWorkbook(), { symbol: "SPY" });
  assert.equal(parsed.as_of, "2026-07-27");
  assert.equal(parsed.fund_name, "State Street® SPDR® S&P 500® ETF Trust");
  assert.equal(parsed.holdings.length, 1);
  assert.equal(parsed.holdings[0].ticker, "AAPL");
  assert.equal(parsed.holdings[0].weight, 1);
  // Shares arrive in scientific notation and must survive as an integer count.
  assert.equal(parsed.holdings[0].units, 181367013);
});

test("a non-xlsx or damaged SSGA response fails closed", () => {
  assert.throws(() => parseSsgaHoldingsXlsx(Buffer.from("<!DOCTYPE html><html>")), /not a ZIP\/xlsx container/);
  assert.throws(() => parseSsgaHoldingsXlsx(zip({ "xl/styles.xml": "<styleSheet/>" })), /no xl\/worksheets\/sheet1\.xml/);
});

// ---------------------------------------------------------------------------
// Weight sum
// ---------------------------------------------------------------------------

test("weights that do not sum to ~1 are a recorded gap, never rescaled", () => {
  // A file summing to 0.62 is a truncated download, not a concentrated fund. Rescaling it
  // would manufacture a plausible portfolio that does not exist.
  const short = checkWeightSum(holdings([["AAPL", 0.4], ["MSFT", 0.22]]));
  assert.equal(short.ok, false);
  assert.equal(short.sum, 0.62);
  assert.match(short.gap, /sum to 0\.6200, not ~1.*incomplete/s);

  // Published weights are rounded, so IVV really does land at 1.0005.
  const rounded = checkWeightSum(holdings([["AAPL", 0.6005], ["MSFT", 0.4]]));
  assert.equal(rounded.ok, true);
  assert.equal(rounded.gap, null);
});

test("issuer dates parse from all three published shapes, and never fall back to today", () => {
  assert.equal(isoDate("Jul 27, 2026"), "2026-07-27");   // iShares
  assert.equal(isoDate("As of 27-Jul-2026"), "2026-07-27"); // SSGA
  assert.equal(isoDate("2026-06-30"), "2026-06-30");     // Vanguard / Invesco
  // An unparseable date is a gap. Stamping the run time onto an issuer's file is how a
  // month-end holdings list starts passing for today's portfolio.
  assert.equal(isoDate("sometime last week"), null);
  assert.equal(isoDate(""), null);
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

test("coverage takes the smallest prefix by descending weight that reaches the target", () => {
  // Deliberately unsorted: the prefix is defined by weight rank, not by file order.
  const coverage = topHoldingsCoverage(
    holdings([["C", 0.15], ["A", 0.4], ["D", 0.05], ["B", 0.2]]),
    { minWeight: 0.6 },
  );
  assert.deepEqual(coverage.holdings.map((row) => row.ticker), ["A", "B"]);
  assert.equal(coverage.count, 2);
  assert.equal(coverage.coverage_weight, 0.6);
  assert.equal(coverage.reached, true);
});

test("coverage reports what it actually reached rather than what was asked for", () => {
  const coverage = topHoldingsCoverage(holdings([["A", 0.25], ["B", 0.15]]), { minWeight: 0.6 });
  assert.equal(coverage.reached, false);
  assert.equal(coverage.coverage_weight, 0.4);
  assert.match(coverage.unavailable[0], /reach only 0\.4000 of the fund, short of the requested 0\.6/);
});

// ---------------------------------------------------------------------------
// Look-through aggregation
// ---------------------------------------------------------------------------

test("an absolute currency amount cannot be aggregated at all", () => {
  // A fund does not earn its holdings' earnings. "ETF revenue" and "ETF EPS" are category
  // errors, so the whitelist makes them unrepresentable rather than discouraged.
  const wide = holdings([["AAPL", 0.5], ["MSFT", 0.5]]);
  for (const factId of ["fundamentals.revenue", "fundamentals.eps", "fundamentals.net_income", "valuation.market_cap"]) {
    const result = lookThroughAggregate({ holdings: wide, perHoldingFacts: { AAPL: 1e9, MSFT: 2e9 }, factId });
    assert.equal(result.value, null, `${factId} must not produce a value`);
    assert.match(result.unavailable[0], /absolute amount, not a ratio/);
    assert.ok(result.allowed_metrics.includes("valuation.pe_ratio"));
  }
  // Anything outside the whitelist is refused too, absolute-looking or not.
  const unknown = lookThroughAggregate({ holdings: wide, perHoldingFacts: { AAPL: 1 }, factId: "vendor.secret_score" });
  assert.equal(unknown.value, null);
  assert.match(unknown.unavailable[0], /not an aggregatable ratio metric/);
});

test("below half the fund's weight there is no aggregate, only a diagnostic", () => {
  const result = lookThroughAggregate({
    holdings: holdings([["AAPL", 0.3], ["MSFT", 0.15]]),
    perHoldingFacts: { AAPL: 30, MSFT: 20 },
    factId: "valuation.pe_ratio",
  });
  assert.equal(result.value, null);
  assert.equal(result.coverage_weight, 0.45);
  assert.equal(result.constituent_count, 2);
  assert.match(result.unavailable[0], /coverage 0\.4500 is below the 0\.5 floor.*sample, not the fund/s);
  assert.equal(MIN_LOOK_THROUGH_COVERAGE, 0.5);
});

test("coverage is measured from the constituents that supplied a fact, not the list length", () => {
  // 500 names in the file mean nothing if only two carried the metric.
  const result = lookThroughAggregate({
    holdings: holdings([["AAPL", 0.3], ["MSFT", 0.15], ["SCND", 0.4], ["AMZN", 0.15]]),
    perHoldingFacts: { AAPL: 30, MSFT: 20 },
    factId: "valuation.pe_ratio",
  });
  assert.equal(result.value, null);
  assert.equal(result.coverage_weight, 0.45);
});

test("a price multiple aggregates harmonically, and says so", () => {
  // portfolio P/E = 1 / sum(w_i / PE_i) = 1 / (0.5/10 + 0.5/30) = 15.
  // The arithmetic mean would say 20. The gap is the whole point: a near-zero-earnings
  // constituent contributes a huge P/E to an average and almost no earnings to the aggregate.
  const result = lookThroughAggregate({
    holdings: holdings([["AAPL", 0.5], ["MSFT", 0.5]]),
    perHoldingFacts: { AAPL: 10, MSFT: 30 },
    factId: "valuation.pe_ratio",
  });
  assert.equal(result.method, "weighted_harmonic_mean");
  assert.equal(result.value, 15);
  assert.notEqual(result.value, 20);
  assert.equal(result.coverage_weight, 1);
  assert.equal(result.constituent_count, 2);
  // The arithmetic must be checkable by hand rather than trusted.
  assert.deepEqual(result.inputs, [
    { ticker: "AAPL", weight: 0.5, value: 10 },
    { ticker: "MSFT", weight: 0.5, value: 30 },
  ]);

  // The yield is the reciprocal of the harmonic aggregate, taken in that order.
  const yielded = asYield(result);
  assert.equal(yielded.value, Number((1 / 15).toFixed(6)));
  assert.equal(yielded.fact_id, "valuation.earnings_yield");
  assert.match(yielded.method, /reciprocal_of_weighted_harmonic_mean/);
});

test("a rate aggregates arithmetically, and says so", () => {
  // Margins and yields already have the weights as their denominator.
  const result = lookThroughAggregate({
    holdings: holdings([["AAPL", 0.5], ["MSFT", 0.5]]),
    perHoldingFacts: { AAPL: 0.1, MSFT: 0.3 },
    factId: "profitability.net_margin",
  });
  assert.equal(result.method, "weighted_arithmetic_mean");
  assert.equal(result.value, 0.2);
  // A rate has no reciprocal view; asking for one yields nothing rather than a number.
  assert.equal(asYield(result), null);
});

test("every whitelisted metric declares which mean it takes", () => {
  for (const [factId, meta] of Object.entries(LOOK_THROUGH_METRICS)) {
    assert.ok(["weighted_harmonic_mean", "weighted_arithmetic_mean"].includes(meta.aggregation), `${factId} must declare an aggregation`);
    // Price-per-unit-of-fundamental multiples must never be averaged arithmetically.
    if (meta.kind === "price_multiple") assert.equal(meta.aggregation, "weighted_harmonic_mean", `${factId} is a multiple`);
  }
  assert.equal(LOOK_THROUGH_METRICS["valuation.pe_ratio"].aggregation, "weighted_harmonic_mean");
  assert.equal(LOOK_THROUGH_METRICS["valuation.earnings_yield"].aggregation, "weighted_arithmetic_mean");
});

test("partial coverage averages over what was covered, and reports the weight", () => {
  // Two thirds of the fund carried the metric; the aggregate is their weighted mean, not a
  // number diluted toward zero by the third that did not.
  const result = lookThroughAggregate({
    holdings: holdings([["AAPL", 0.4], ["MSFT", 0.4], ["SCND", 0.2]]),
    perHoldingFacts: { AAPL: 0.1, MSFT: 0.3 },
    factId: "profitability.net_margin",
    coverageWeight: 0.8,
  });
  assert.equal(result.value, 0.2);
  assert.equal(result.coverage_weight, 0.8);
  assert.equal(result.declared_coverage_weight, 0.8);
  assert.equal(result.constituent_count, 2);
});

test("a zero multiple is dropped from a harmonic mean and named, not silently included", () => {
  const result = lookThroughAggregate({
    holdings: holdings([["AAPL", 0.5], ["MSFT", 0.4], ["ZERO", 0.1]]),
    perHoldingFacts: { AAPL: 10, MSFT: 10, ZERO: 0 },
    factId: "valuation.pe_ratio",
  });
  assert.equal(result.value, 10);
  assert.equal(result.constituent_count, 2);
  assert.equal(result.coverage_weight, 0.9);
  assert.match(result.unavailable[0], /ZERO.*has no reciprocal/);
});

test("nothing to aggregate is null, not zero", () => {
  const result = lookThroughAggregate({
    holdings: holdings([["AAPL", 0.9]]),
    perHoldingFacts: {},
    factId: "valuation.pe_ratio",
  });
  assert.equal(result.value, null);
  assert.equal(result.coverage_weight, 0);
  assert.match(result.unavailable[0], /no constituent supplied/);
});

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

test("only issuers that publish daily shares can produce a flow", () => {
  assert.deepEqual([...DAILY_SHARES_ISSUERS], ["ishares", "ssga"]);
  for (const issuer of ["vanguard", "invesco"]) {
    // Even handed the inputs, these must refuse: the numbers cannot have come from the issuer,
    // and inferring flow from AUM change reports a flow on a day with none, because AUM moves
    // with the market as well as with creations.
    const flow = fundFlow({ sharesNow: 1_000_000, sharesPrior: 900_000, nav: 500, issuer });
    assert.equal(flow.value, null, `${issuer} must not produce a flow`);
    assert.match(flow.unavailable[0], /publishes no daily shares outstanding.*must not be estimated/s);
  }
});

test("a flow from daily shares is the share change priced at NAV", () => {
  const flow = fundFlow({ sharesNow: 1_167_700_000, sharesPrior: 1_167_000_000, nav: 742.4, issuer: "ishares" });
  assert.equal(flow.value, Number((700_000 * 742.4).toFixed(2)));
  assert.equal(flow.construction.share_change, 700_000);
  assert.match(flow.construction.formula, /shares_outstanding_now - shares_outstanding_prior/);
  assert.deepEqual(flow.unavailable, []);
});

test("a missing flow input is a named gap, never a substituted estimate", () => {
  const flow = fundFlow({ sharesNow: 1_000_000, sharesPrior: null, nav: null, issuer: "ssga" });
  assert.equal(flow.value, null);
  assert.match(flow.unavailable[0], /needs shares_outstanding_prior, nav; no estimate is substituted/);
  assert.equal(fundFlow({}).value, null);
});

/**
 * A module that re-exports a name without importing it publishes the name and still throws
 * `not defined` on every call. The parser unit tests import the parsers directly, so they stay
 * green while every live fetch path is broken -- which is exactly what happened when these
 * parsers moved into their own module. The check is not "does the parser work" but "can the
 * module that fetches actually reach it".
 */
test("every parser funds.mjs dispatches to is bound in its own scope, not merely re-exported", async () => {
  const source = readFileSync(repoFile("mcp/lib/funds.mjs"), "utf8");
  const called = [...source.matchAll(/\b(parse[A-Z]\w+|checkWeightSum|isoDate|numeric)\s*\(/gu)]
    .map((match) => match[1]);
  assert.ok(called.length >= 4, "expected funds.mjs to dispatch to the issuer parsers");
  // Only the names that live in the parser module have to be imported; the rest are defined
  // in funds.mjs itself and are already in scope.
  const parsers = await import("../../mcp/lib/fund-holdings-parsers.mjs");
  const borrowed = [...new Set(called)].filter((name) => typeof parsers[name] === "function");
  assert.ok(borrowed.length >= 4, "expected funds.mjs to dispatch to the issuer parsers");
  // The binding a re-export does not create: an imported name appears in an import statement.
  const imported = [...source.matchAll(/import \{([^}]*)\} from "\.\/fund-holdings-parsers\.mjs";/gu)]
    .map((match) => match[1]).join(",");
  for (const name of borrowed) {
    assert.ok(imported.includes(name), `${name} is called in funds.mjs but never imported there`);
  }
});
