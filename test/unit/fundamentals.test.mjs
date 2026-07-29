import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FUNDAMENTAL_FACT_IDS,
  MAINTENANCE_CAPEX_PROXY,
  deriveFundamentals,
  quarterlySeries,
} from "../../mcp/lib/fundamentals.mjs";

/**
 * Offline fixtures shaped like SEC Company Facts. Nothing here touches the network, and no
 * assertion may depend on the clock: every date a metric reports has to come out of the
 * fixture's `filed` field.
 */
const DAY_MS = 86_400_000;
const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + (days * DAY_MS)).toISOString().slice(0, 10);
const accession = (end) => `0001234567-${String(end).slice(2, 4)}-000001`;
/** A 10-K lands about a month after the period it reports on -- that lag is the whole point. */
const filedFor = (end) => shift(end, 32);

const flowRows = (pairs, { form = "10-K", days = 364 } = {}) => pairs.map(([end, value]) => ({
  start: shift(end, -days),
  end,
  val: value,
  accn: accession(end),
  fy: Number(end.slice(0, 4)),
  fp: "FY",
  form,
  filed: filedFor(end),
}));

const instantRows = (pairs) => pairs.map(([end, value]) => ({
  end,
  val: value,
  accn: accession(end),
  fy: Number(end.slice(0, 4)),
  fp: "FY",
  form: "10-K",
  filed: filedFor(end),
}));

const usd = (rows) => ({ units: { USD: rows } });
const shares = (rows) => ({ units: { shares: rows } });
const zip = (ends, values) => ends.map((end, index) => [end, values[index]]);

const YEARS = ["2019-12-31", "2020-12-31", "2021-12-31", "2022-12-31", "2023-12-31", "2024-12-31"];

/**
 * A complete filer. Numbers are chosen so every derivation lands on a round figure:
 *   owner earnings  500 + 200 - 70            = 630
 *   NCAV            900 - 400                 = 500
 *   tangible book   1000 - 300 - 100          = 600
 *   downside asset  600 + 250 - 450           = 400
 *   leverage        450 / 1000                = 0.45
 *   incremental ROIC (500-200) / (1200-600)   = 0.5
 */
function baseFacts(overrides = {}, { drop = [] } = {}) {
  const facts = {
    Revenues: usd(flowRows(zip(YEARS, [1000, 1100, 1210, 1331, 1464.1, 1610.51]))),
    NetIncomeLoss: usd(flowRows(zip(YEARS, [200, 250, 300, 350, 400, 500]))),
    OperatingIncomeLoss: usd(flowRows(zip(YEARS, [250, 300, 350, 400, 500, 600]))),
    DepreciationDepletionAndAmortization: usd(flowRows(zip(YEARS, [120, 130, 140, 150, 180, 200]))),
    PaymentsToAcquirePropertyPlantAndEquipment: usd(flowRows(zip(YEARS, [90, 100, 100, 100, 300, 300]))),
    AssetsCurrent: usd(instantRows(zip(YEARS, [400, 500, 600, 700, 800, 900]))),
    Liabilities: usd(instantRows(zip(YEARS, [300, 320, 340, 360, 380, 400]))),
    StockholdersEquity: usd(instantRows(zip(YEARS, [500, 600, 700, 800, 900, 1000]))),
    Goodwill: usd(instantRows(zip(YEARS, [300, 300, 300, 300, 300, 300]))),
    IntangibleAssetsNetExcludingGoodwill: usd(instantRows(zip(YEARS, [100, 100, 100, 100, 100, 100]))),
    CashAndCashEquivalentsAtCarryingValue: usd(instantRows(zip(YEARS, [100, 120, 150, 180, 200, 250]))),
    LongTermDebtNoncurrent: usd(instantRows(zip(YEARS, [200, 220, 250, 300, 350, 400]))),
    LongTermDebtCurrent: usd(instantRows(zip(YEARS, [0, 10, 20, 30, 40, 50]))),
    WeightedAverageNumberOfDilutedSharesOutstanding:
      shares(flowRows(zip(YEARS, [1_200_000, 1_180_000, 1_150_000, 1_100_000, 1_050_000, 1_000_000]))),
    ...overrides,
  };
  for (const tag of drop) delete facts[tag];
  return { cik: 1234567, entityName: "FIXTURE INC", facts: { "us-gaap": facts } };
}

const derive = (options = {}) => deriveFundamentals({ companyFacts: baseFacts(), asOf: null, ...options });
const gapsFor = (result, factId) => result.unavailable.filter((item) => item.metric === factId);

test("owner earnings is estimated, never rederived, and carries its maintenance-capex proxy", () => {
  // Maintenance capex is not a reported line item anywhere in US GAAP. Labelling this
  // "rederived" would tell a seat the filing says something it does not say.
  const owner = derive().metrics["financial.owner_earnings"];
  assert.equal(owner.derivation, "estimated");
  // min(capex 300, 5-year median 100) * 0.7 = 70; 500 + 200 - 70 = 630.
  assert.equal(owner.value, 630);
  assert.equal(owner.inputs.maintenance_capex, 70);
  assert.equal(owner.inputs.capex_median, 100);
  assert.deepEqual(owner.inputs.proxy, { ...MAINTENANCE_CAPEX_PROXY });
  assert.ok(
    owner.assumptions.some((line) => line.includes(MAINTENANCE_CAPEX_PROXY.formula)),
    "the exact proxy formula must travel with the number",
  );
  assert.ok(owner.assumptions.some((line) => line.includes("derivation=estimated")));
  // A derived fact needs all three lineage fields or the typed-fact contract rejects it.
  assert.equal(owner.tool_id, "sec_fundamentals");
  assert.match(owner.calculation_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(owner.currency, "USD");
  assert.equal(owner.scale, 1);
});

test("a different maintenance-capex factor changes the number and the stated assumption", () => {
  // The proxy is configuration, not a constant buried in the arithmetic: a seat that
  // disagrees with 0.7 should be arguing with a parameter it can see.
  const owner = derive({ maintenanceCapexProxy: { ...MAINTENANCE_CAPEX_PROXY, factor: 1, formula: "min(capex_fy, median) * 1" } })
    .metrics["financial.owner_earnings"];
  assert.equal(owner.inputs.maintenance_capex, 100);
  assert.equal(owner.value, 600);
  assert.ok(owner.assumptions.some((line) => line.includes("* 1 = 100 USD")));
});

test("a missing depreciation tag is a named gap, not a zero add-back", () => {
  // Treating an absent D&A tag as 0 would quietly turn owner earnings into net income minus
  // capex and still report it as a computed figure.
  const result = deriveFundamentals({
    companyFacts: baseFacts({}, { drop: ["DepreciationDepletionAndAmortization"] }),
  });
  assert.equal(result.metrics["financial.owner_earnings"], null);
  const [gap] = gapsFor(result, "financial.owner_earnings");
  assert.equal(gap.code, "missing_tag");
  assert.match(gap.detail, /depreciation_amortisation/);
  assert.ok(gap.missing_tags.includes("DepreciationDepletionAndAmortization"));
  assert.ok(gap.missing_tags.includes("DepreciationAndAmortization"), "every alias tried is named");
  // The gap is confined to the metrics that actually needed the tag.
  assert.equal(result.metrics["financial.net_current_asset_value"].value, 500);
});

test("an unknown debt balance is a gap, because unknown debt is not zero debt", () => {
  const result = deriveFundamentals({
    companyFacts: baseFacts({}, { drop: ["LongTermDebtNoncurrent", "LongTermDebtCurrent"] }),
  });
  assert.equal(result.metrics["financial.leverage"], null);
  assert.equal(result.metrics["valuation.downside_asset_value"], null);
  for (const factId of ["financial.leverage", "valuation.downside_asset_value"]) {
    const [gap] = gapsFor(result, factId);
    assert.equal(gap.code, "missing_tag");
    assert.ok(gap.missing_tags.includes("ShortTermBorrowings"));
  }
});

test("NCAV is current assets less all liabilities, and the floor names the binding term", () => {
  const metrics = derive().metrics;
  assert.equal(metrics["financial.net_current_asset_value"].value, 900 - 400);
  assert.equal(metrics["financial.net_current_asset_value"].derivation, "rederived");
  // tangible book = 1000 equity - 300 goodwill - 100 intangibles = 600; NCAV 500 is lower.
  const floor = metrics["valuation.downside_floor"];
  assert.equal(floor.value, 500);
  assert.equal(floor.components.bound_by, "net_current_asset_value");
  assert.deepEqual(floor.components.terms, [
    { term: "net_current_asset_value", value: 500 },
    { term: "tangible_book_value", value: 600 },
  ]);
  // tangible book + cash - total debt = 600 + 250 - (400 + 50).
  assert.equal(metrics["valuation.downside_asset_value"].value, 400);
});

test("the floor reports tangible book when tangible book is the lower term", () => {
  // Which term bound the floor is the informative half of the answer; a bare minimum hides it.
  const rich = baseFacts({ AssetsCurrent: usd(instantRows(zip(YEARS, [400, 500, 600, 700, 800, 1200]))) });
  const floor = deriveFundamentals({ companyFacts: rich }).metrics["valuation.downside_floor"];
  assert.equal(floor.inputs.net_current_asset_value, 800);
  assert.equal(floor.value, 600);
  assert.equal(floor.components.bound_by, "tangible_book_value");
});

test("goodwill absent from every period is stated as an assumption, not assumed away", () => {
  const noGoodwill = baseFacts({}, { drop: ["Goodwill", "IntangibleAssetsNetExcludingGoodwill"] });
  const floor = deriveFundamentals({ companyFacts: noGoodwill }).metrics["valuation.downside_floor"];
  assert.equal(floor.value, 500, "tangible book is now the full 1000 of equity, so NCAV still binds");
  assert.ok(floor.assumptions.some((line) => line.includes("goodwill is not tagged in any period")));
});

test("a revenue CAGR uses the measured day span, not the count of filings", () => {
  // 52/53-week fiscal calendars mean "five annual filings" and "five years" are different
  // numbers; using the period count as the exponent quietly biases every growth rate.
  const ends = ["2019-06-29", "2020-06-27", "2021-06-26", "2022-07-02", "2023-07-01", "2024-06-29"];
  const irregular = baseFacts({ Revenues: usd(flowRows(zip(ends, [1000, 1150, 1300, 1500, 1750, 2000]))) });
  const growth = deriveFundamentals({ companyFacts: irregular }).metrics["valuation.revenue_growth"];

  const spanDays = Math.round((Date.parse("2024-06-29") - Date.parse("2019-06-29")) / DAY_MS);
  assert.equal(spanDays, 1827, "five calendar years across two leap years");
  assert.equal(growth.inputs.span_days, spanDays);
  const expected = (2000 / 1000) ** (1 / (spanDays / 365.25)) - 1;
  assert.equal(growth.value, Number(expected.toFixed(6)));
  // The naive "five intervals" exponent is a visibly different answer.
  const naive = (2000 / 1000) ** (1 / 5) - 1;
  assert.notEqual(Number(naive.toFixed(6)), growth.value);
  assert.equal(growth.period_end, "2024-06-29");
  assert.equal(growth.components.cagr_years, Number((spanDays / 365.25).toFixed(6)));
});

test("a CAGR across a non-positive base is refused rather than produced", () => {
  const loss = baseFacts({ Revenues: usd(flowRows(zip(YEARS, [0, 100, 200, 300, 400, 500]))) });
  const result = deriveFundamentals({ companyFacts: loss });
  assert.equal(result.metrics["valuation.revenue_growth"], null);
  assert.equal(gapsFor(result, "valuation.revenue_growth")[0].code, "non_positive_base");
});

test("trailing-four-quarter growth is computed when eight quarters exist, and gapped when they do not", () => {
  const quarterEnds = [
    "2023-03-31", "2023-06-30", "2023-09-30", "2023-12-31",
    "2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31",
  ];
  const quarterRows = quarterEnds.map((end, index) => {
    const start = index === 0 ? "2023-01-01" : shift(quarterEnds[index - 1], 1);
    return {
      start,
      end,
      val: index < 4 ? 100 : 110,
      accn: accession(end),
      fy: Number(end.slice(0, 4)),
      fp: `Q${(index % 4) + 1}`,
      form: index % 4 === 3 ? "10-K" : "10-Q",
      filed: shift(end, 35),
    };
  });
  const withQuarters = baseFacts({
    Revenues: usd([...flowRows(zip(YEARS, [1000, 1100, 1210, 1331, 1464.1, 1610.51])), ...quarterRows]),
  });
  const growth = deriveFundamentals({ companyFacts: withQuarters }).metrics["valuation.revenue_growth"];
  // 440 against 400 is 10%, expressed as 0.1 rather than 10.
  assert.equal(growth.components.yoy_ttm, 0.1);
  assert.equal(growth.components.yoy_ttm_latest, 440);
  assert.equal(growth.components.yoy_ttm_prior, 400);
  // The annual rows must not be mistaken for quarters, and vice versa.
  assert.equal(quarterlySeries(withQuarters, ["Revenues"], {}).length, 8);

  // Without quarterly tags the CAGR still stands and the YoY is a named component gap.
  const annualOnly = deriveFundamentals({ companyFacts: baseFacts() });
  assert.ok(annualOnly.metrics["valuation.revenue_growth"].value > 0);
  assert.equal(annualOnly.metrics["valuation.revenue_growth"].components.yoy_ttm, null);
  const [gap] = gapsFor(annualOnly, "valuation.revenue_growth");
  assert.equal(gap.component, "yoy_ttm");
  assert.equal(gap.code, "insufficient_history");
});

test("incremental return on capital returns null when the denominator barely moves", () => {
  // A near-flat invested-capital base produces an enormous ratio that reads as a wonderful
  // business and is really just a small divisor.
  const flat = baseFacts({
    StockholdersEquity: usd(instantRows(zip(YEARS, [500, 520, 540, 560, 580, 502]))),
    CashAndCashEquivalentsAtCarryingValue: usd(instantRows(zip(YEARS, [100, 100, 100, 100, 100, 100]))),
    LongTermDebtNoncurrent: usd(instantRows(zip(YEARS, [200, 200, 200, 200, 200, 200]))),
    LongTermDebtCurrent: usd(instantRows(zip(YEARS, [0, 0, 0, 0, 0, 0]))),
  });
  const result = deriveFundamentals({ companyFacts: flat });
  assert.equal(result.metrics["financial.incremental_return_on_capital"], null);
  const [gap] = gapsFor(result, "financial.incremental_return_on_capital");
  assert.equal(gap.code, "denominator_near_zero");
  assert.match(gap.detail, /below the 1% floor/);
});

test("incremental return on capital says which profit basis it used", () => {
  // The base fixture files no tax or pre-tax tags, so NOPAT is not computable and the metric
  // has to name net income as the substitute rather than imply it rebuilt NOPAT.
  const metric = derive().metrics["financial.incremental_return_on_capital"];
  assert.equal(metric.inputs.profit_basis, "net_income");
  assert.ok(metric.assumptions.some((line) => line.includes("NOPAT inputs")));
  // invested capital 600 -> 1200, profit 200 -> 500.
  assert.equal(metric.inputs.invested_capital_change, 600);
  assert.equal(metric.value, 0.5);
  assert.equal(metric.inputs.window_years, 5);
  assert.equal(metric.ratio_denominator, "change_in_invested_capital_fy2019_to_fy2024");

  const withTax = baseFacts({
    IncomeTaxExpenseBenefit: usd(flowRows(zip(YEARS, [50, 60, 70, 80, 100, 125]))),
    IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
      usd(flowRows(zip(YEARS, [250, 300, 350, 400, 500, 625]))),
  });
  const nopat = deriveFundamentals({ companyFacts: withTax }).metrics["financial.incremental_return_on_capital"];
  assert.equal(nopat.inputs.profit_basis, "nopat");
  // 20% effective rate at both ends: (600*0.8 - 250*0.8) / 600.
  assert.equal(nopat.value, Number((((600 * 0.8) - (250 * 0.8)) / 600).toFixed(6)));
});

test("every ratio is a decimal, never a percent", () => {
  const metrics = derive().metrics;
  const leverage = metrics["financial.leverage"];
  assert.equal(leverage.value, 0.45, "450 of debt on 1000 of equity is 0.45, not 45");
  assert.equal(leverage.unit, "decimal");
  assert.equal(leverage.value_kind, "ratio");
  assert.equal(leverage.ratio_denominator, "book_equity");
  // EBITDA 600 + 200 = 800; net debt 450 - 250 = 200.
  assert.equal(leverage.components.net_debt_to_ebitda, 0.25);
  for (const factId of ["valuation.revenue_growth", "financial.incremental_return_on_capital"]) {
    assert.equal(metrics[factId].unit, "decimal");
    assert.ok(Math.abs(metrics[factId].value) < 1, `${factId} must not be expressed in percentage points`);
  }
});

test("negative book equity refuses a debt/equity ratio instead of printing a negative multiple", () => {
  const deficit = baseFacts({ StockholdersEquity: usd(instantRows(zip(YEARS, [500, 400, 300, 200, 100, -50]))) });
  const result = deriveFundamentals({ companyFacts: deficit });
  assert.equal(result.metrics["financial.leverage"], null);
  assert.equal(gapsFor(result, "financial.leverage")[0].code, "non_positive_base");
});

test("net debt / EBITDA is a component gap and does not take the whole metric down", () => {
  const noDepreciation = baseFacts({}, { drop: ["DepreciationDepletionAndAmortization"] });
  const result = deriveFundamentals({ companyFacts: noDepreciation });
  assert.equal(result.metrics["financial.leverage"].value, 0.45);
  assert.equal(result.metrics["financial.leverage"].components.net_debt_to_ebitda, null);
  const [gap] = gapsFor(result, "financial.leverage");
  assert.equal(gap.component, "net_debt_to_ebitda");
  assert.ok(result.metrics["financial.leverage"].assumptions.some((line) => line.includes("reported as a gap rather than defaulted")));
});

test("public_at comes from the filing date and never from the clock", () => {
  // This is the property the whole point-in-time pipeline rests on: FY2024 ended
  // 2024-12-31 but was not knowable until the 10-K was filed on 2025-02-01.
  const result = derive();
  const today = new Date().toISOString().slice(0, 10);
  for (const factId of FUNDAMENTAL_FACT_IDS) {
    const metric = result.metrics[factId];
    assert.ok(metric, `${factId} should be computable from the complete fixture`);
    assert.equal(metric.public_at, "2025-02-01T00:00:00.000Z", `${factId} must be stamped with the filing`);
    assert.notEqual(metric.public_at.slice(0, 10), today);
    // A count is a point-in-time quantity and deliberately carries no interval: it exists to
    // denominate a market capitalisation, where the number of shares matters and the window
    // they were averaged over does not. Its basis stays stated in `assumptions`.
    if (factId === "capital_allocation.share_count") {
      assert.equal(metric.period_end, null, "a share count must not claim to cover a span");
      assert.ok(
        metric.assumptions.some((note) => /weighted average|point-in-time/u.test(note)),
        "a share count must still state its measurement basis",
      );
    } else {
      assert.ok(metric.period_end, `${factId} must report the period it covers`);
    }
    assert.ok(Number.isInteger(metric.fiscal_year), `${factId} must report a fiscal year`);
    if (metric.period_end) {
      assert.ok(Date.parse(metric.public_at) > Date.parse(metric.period_end), "a filing follows the period it reports");
    }
  }
});

test("an as_of before the latest filing never carries the newer period forward", () => {
  // FY2024 was filed 2025-02-01, so a run cut off on 2025-01-15 has to see FY2023 -- with
  // FY2023's period end and FY2023's filing date, not FY2024's figures backdated.
  const asOf = deriveFundamentals({ companyFacts: baseFacts(), asOf: "2025-01-15" });
  const ncav = asOf.metrics["financial.net_current_asset_value"];
  assert.equal(ncav.period_end, "2023-12-31");
  assert.equal(ncav.fiscal_year, 2023);
  assert.equal(ncav.public_at, "2024-02-01T00:00:00.000Z");
  assert.equal(ncav.value, 800 - 380);
  assert.equal(asOf.metrics["capital_allocation.share_count"].value, 1_050_000);
});

test("the latest diluted share count is reported, so it carries no calculation hash", () => {
  const shareCount = derive().metrics["capital_allocation.share_count"];
  assert.equal(shareCount.derivation, "reported");
  assert.equal(shareCount.value_kind, "count");
  assert.equal(shareCount.unit, "shares");
  assert.equal(shareCount.value, 1_000_000);
  // The typed-fact contract only demands tool/version/hash of a *derived* fact.
  assert.equal(shareCount.calculation_hash, null);
  assert.equal(shareCount.tool_id, null);
  assert.ok(shareCount.assumptions.some((line) => line.includes("weighted average diluted count")));
});

test("lineage carries the exact tags, accession and period each metric was built from", () => {
  const ncav = derive().metrics["financial.net_current_asset_value"];
  assert.deepEqual(ncav.source_records.map((record) => record.tag).sort(), ["AssetsCurrent", "Liabilities"]);
  for (const record of ncav.source_records) {
    assert.equal(record.period_end, "2024-12-31");
    assert.equal(record.accession, "0001234567-24-000001");
  }
  // The id format the typed-fact adapter parses back into a filing locator.
  assert.deepEqual([...ncav.source_ids].sort(), [
    "sec:companyfacts:0001234567:AssetsCurrent:0001234567-24-000001:2024-12-31",
    "sec:companyfacts:0001234567:Liabilities:0001234567-24-000001:2024-12-31",
  ]);
});

test("the calculation hash is a function of the inputs alone, not of when it ran", () => {
  const first = derive().metrics["financial.owner_earnings"];
  const second = derive().metrics["financial.owner_earnings"];
  assert.equal(first.calculation_hash, second.calculation_hash);
  const changed = deriveFundamentals({
    companyFacts: baseFacts({ NetIncomeLoss: usd(flowRows(zip(YEARS, [200, 250, 300, 350, 400, 501]))) }),
  }).metrics["financial.owner_earnings"];
  assert.notEqual(changed.calculation_hash, first.calculation_hash);
});

test("an empty filer yields every fact id as null with a gap for each", () => {
  // Silence is the failure mode to avoid: a caller must be able to see that 8 of 8 metrics
  // were unavailable rather than find 8 missing keys.
  const empty = deriveFundamentals({ companyFacts: { cik: 1, entityName: "EMPTY", facts: { "us-gaap": {} } } });
  for (const factId of FUNDAMENTAL_FACT_IDS) {
    assert.equal(empty.metrics[factId], null);
    assert.ok(gapsFor(empty, factId).length >= 1, `${factId} must name its gap`);
  }
  assert.ok(empty.unavailable.every((item) => item.code && item.detail));
});

test("a malformed companyFacts fails closed at the boundary", () => {
  assert.throws(() => deriveFundamentals({ companyFacts: null }), /needs a companyFacts object/);
  assert.throws(() => deriveFundamentals({ companyFacts: [] }), /needs a companyFacts object/);
  assert.throws(() => deriveFundamentals({ companyFacts: baseFacts(), asOf: "not-a-date" }), /asOf is not a date/);
});
