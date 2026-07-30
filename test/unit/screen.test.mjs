import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, explainResult } from "../../mcp/lib/screen.mjs";

/**
 * Minimal companyfacts shape, so the rules can be tested without touching the network.
 *
 * Share counts go under the `shares` unit, as XBRL actually reports them. This fixture used
 * to put everything under USD, which matched a bug in the reader and made the dilution test
 * pass against behaviour that never worked on a real filing.
 */
const SHARE_TAGS = /Shares(Outstanding)?$/;
const facts = (concepts) => ({
  facts: {
    "us-gaap": Object.fromEntries(Object.entries(concepts).map(([tag, vals]) => [
      tag,
      {
        units: {
          [SHARE_TAGS.test(tag) ? "shares" : "USD"]: vals.map((val, i) => ({
            val,
            start: `${2016 + i}-01-01`,
            end: `${2016 + i}-12-31`,
            filed: `${2017 + i}-02-15`,
            form: "10-K",
          })),
        },
      },
    ])),
  },
});

const rule = (result, id) => result.rules.find((r) => r.id === id);

test("a rule with no inputs is skipped, never passed", () => {
  const result = evaluateRules(facts({}));
  assert.ok(result.rules.every((r) => r.skipped), "nothing is computable from empty filings");
  assert.equal(result.evaluated_count, 0);
  // This is the distinction that matters: nothing failed, but nothing passed either.
  assert.equal(result.verdict, "survives");
  assert.match(explainResult(result, "X"), /were NOT treated as passes/);
});

test("negative cumulative free cash flow eliminates", () => {
  const result = evaluateRules(facts({
    NetCashProvidedByUsedInOperatingActivities: [10, 10, 10, 10, 10],
    PaymentsToAcquirePropertyPlantAndEquipment: [30, 30, 30, 30, 30],
  }));
  const fcf = rule(result, "fcf_5y");
  assert.equal(fcf.passed, false);
  // 5 x (10 - 30) = -100, in raw dollars. Reporting billions to two decimals used to
  // round this to zero, and with it every small-cap's cash flow.
  assert.equal(fcf.value, -100);
  assert.equal(fcf.unit, "USD");
  assert.equal(result.verdict, "eliminated");
});

test("thin interest cover eliminates and reports the multiple", () => {
  const result = evaluateRules(facts({
    OperatingIncomeLoss: [100],
    InterestExpense: [80],
  }));
  const cover = rule(result, "interest_cover");
  assert.equal(cover.passed, false);
  assert.equal(cover.value, 1.25);
  assert.equal(cover.threshold, 2);
});

test("an elimination always names metric, value and threshold", () => {
  const result = evaluateRules(facts({ OperatingIncomeLoss: [10], InterestExpense: [100] }));
  for (const failure of result.failures) {
    assert.ok(failure.label, "a failure needs a human label");
    assert.ok(failure.value !== undefined, "a failure needs the measured value");
    assert.ok(failure.threshold !== undefined, "a failure needs the threshold it was judged against");
  }
  assert.match(explainResult(result, "X"), /measured .* against a threshold of/);
});

test("computed rules retain the filing dates and concept lineage used by the value", () => {
  const result = evaluateRules(facts({
    NetCashProvidedByUsedInOperatingActivities: [10, 20, 30],
    NetIncomeLoss: [5, 10, 15],
  }));
  const conversion = rule(result, "ocf_over_ni");
  assert.equal(conversion.public_at, "2019-02-15");
  assert.equal(conversion.period_start, "2016-01-01");
  assert.equal(conversion.period_end, "2018-12-31");
  assert.equal(conversion.fiscal_year, 2018);
  assert.ok(conversion.source_records.some((source) => source.tag === "NetCashProvidedByUsedInOperatingActivities"));
  assert.ok(conversion.source_records.some((source) => source.tag === "NetIncomeLoss"));
});

// Exemptions are the only way past a failure, and they must be earned by the numbers.
test("a heavy non-cash charge exempts a thin net margin", () => {
  const result = evaluateRules(facts({
    Revenues: [100, 100, 100],
    NetIncomeLoss: [1, 1, 1],
    NetCashProvidedByUsedInOperatingActivities: [10, 10, 10],
  }));
  assert.equal(rule(result, "net_margin").passed, false);
  assert.ok(result.exemptions.some((e) => e.rule === "net_margin"), "OCF/NI of 10x should exempt");
  assert.ok(!result.failures.some((f) => f.id === "net_margin"), "an exempted rule is not a failure");
});

test("dilution beyond the threshold eliminates", () => {
  const result = evaluateRules(facts({ CommonStockSharesOutstanding: [100, 120, 150] }));
  const dilution = rule(result, "dilution");
  assert.equal(dilution.passed, false);
  assert.equal(dilution.value, 50);
});

test("a restated period uses the most recently filed value", () => {
  const withRestatement = {
    facts: {
      "us-gaap": {
        OperatingIncomeLoss: {
          units: {
            USD: [
              { val: 100, end: "2023-12-31", filed: "2024-02-15", form: "10-K" },
              { val: 40, end: "2023-12-31", filed: "2025-02-15", form: "10-K" },
            ],
          },
        },
        InterestExpense: { units: { USD: [{ val: 30, end: "2023-12-31", filed: "2024-02-15", form: "10-K" }] } },
      },
    },
  };
  // 40/30 = 1.33 fails; the superseded 100/30 = 3.33 would have passed.
  assert.equal(rule(evaluateRules(withRestatement), "interest_cover").value, 1.33);
});

test("as_of excludes filings that were not public yet", () => {
  const result = evaluateRules(facts({ OperatingIncomeLoss: [100], InterestExpense: [80] }), { asOf: "2016-01-01" });
  assert.ok(rule(result, "interest_cover").skipped, "nothing was filed by that date");
});


test("every rule names what it measures, in both languages, with a direction", () => {
  const result = evaluateRules(facts({
    Revenues: [100, 100, 100], NetIncomeLoss: [10, 10, 10],
    OperatingIncomeLoss: [20], InterestExpense: [5],
    NetCashProvidedByUsedInOperatingActivities: [15, 15, 15],
    PaymentsToAcquirePropertyPlantAndEquipment: [5, 5, 5],
    StockholdersEquity: [50, 50, 50, 50, 50], CommonStockSharesOutstanding: [100, 100, 100],
    GrossProfit: [40, 40, 40],
  }));
  for (const r of result.rules) {
    assert.equal(typeof r.label, "object", `${r.id} label must be {en, zh}`);
    assert.ok(r.label.en && r.label.zh, `${r.id} needs both languages`);
    // The label names the measure; the direction says which way passes. Naming a rule
    // after its failure condition made "long-run gross margin below 15%: pass" read as a
    // contradiction.
    assert.ok(!/below|above|more than/.test(r.label.en), `${r.id} label should name the measure, not the failure`);
    if (!r.skipped) assert.ok(["min", "max"].includes(r.direction), `${r.id} needs a direction`);
  }
});

// The tool schema offers `ticker`, so callers pass one. Demanding a cik anyway turned a
// documented argument into an error and sent the caller off to look up an identifier the
// universe file already holds -- found by calling the tool the way its schema advertises.
test("screen_ticker's schema and its implementation agree on what identifies a company", async () => {
  const { tools } = await import("../../mcp/lib/rpc.mjs");
  const schema = tools().find((t) => t.name === "screen_ticker").inputSchema;
  const offered = Object.keys(schema.properties);
  assert.ok(offered.includes("ticker"), "the schema offers ticker");
  assert.ok(offered.includes("cik"));
  // Requiring cik while offering ticker is the contradiction that produced the bug.
  assert.ok(!(schema.required || []).includes("cik"),
    "cik must not be required while ticker is offered as an alternative");

  const { screenTicker } = await import("../../mcp/lib/screen.mjs");
  await assert.rejects(() => screenTicker({}), /needs a cik or a ticker/,
    "with neither identifier the error must name both options");
});

// Three defects in the XBRL layer, each of which produced numbers that looked fine.
//
// A 10-K carries quarterly and stub periods alongside annual ones. Keying only on the end
// date made Lumentum's fiscal 2015 into ten separate "years" -- nine quarters and stubs plus
// the real 363-day period -- so every multi-year rule averaged quarterly income against
// annual equity. LITE's ten-year ROE read 2.26%; it is -1.64%.
test("annualSeries keeps annual periods and drops quarters and stubs", async () => {
  const { annualSeries } = await import("../../mcp/lib/sec.mjs");
  const facts = { facts: { "us-gaap": { X: { units: { USD: [
    { form: "10-K", start: "2014-06-29", end: "2015-06-27", val: 100, filed: "2015-08-01" },
    { form: "10-K", start: "2015-03-29", end: "2015-06-27", val: 25, filed: "2015-08-01" },
    { form: "10-K", start: "2015-06-28", end: "2015-08-01", val: 9, filed: "2015-09-01" },
    { form: "10-K", start: "2015-06-28", end: "2016-06-25", val: 120, filed: "2016-08-01" },
    { form: "10-Q", start: "2016-06-26", end: "2017-06-24", val: 999, filed: "2017-08-01" },
  ] } } } } };
  const r = annualSeries(facts, ["X"]);
  assert.deepEqual(r.series.map((e) => e.val), [100, 120], "only the ~365-day 10-K periods");
});

// annualSeries returned at the first alias with data. Revenue moved to the ASC 606 tag in
// 2022, so a company public since 2013 looked like it had four years of history -- which
// then fired a "listed under ten years" exemption on a decade-old filer.
test("annualSeries merges every alias instead of stopping at the first", async () => {
  const { annualSeries } = await import("../../mcp/lib/sec.mjs");
  const facts = { facts: { "us-gaap": {
    New: { units: { USD: [
      { form: "10-K", start: "2022-01-01", end: "2022-12-31", val: 22, filed: "2023-02-01" },
      { form: "10-K", start: "2023-01-01", end: "2023-12-31", val: 23, filed: "2024-02-01" },
    ] } },
    Old: { units: { USD: [
      { form: "10-K", start: "2020-01-01", end: "2020-12-31", val: 20, filed: "2021-02-01" },
      { form: "10-K", start: "2021-01-01", end: "2021-12-31", val: 21, filed: "2022-02-01" },
      // Both aliases cover 2022; the preferred one must win.
      { form: "10-K", start: "2022-01-01", end: "2022-12-31", val: 999, filed: "2023-02-01" },
    ] } },
  } } };
  const r = annualSeries(facts, ["New", "Old"]);
  assert.deepEqual(r.series.map((e) => e.val), [20, 21, 22, 23]);
  assert.deepEqual(r.tags, ["New", "Old"]);
});

// Share counts live under the `shares` unit. Asking for USD returned nothing, so the
// dilution rule reported `skipped` for every company ever screened -- and a skip is
// indistinguishable from a genuine data gap.
test("the dilution rule actually computes, rather than skipping forever", async () => {
  const { evaluateRules } = await import("../../mcp/lib/screen.mjs");
  const year = (y, val, unit) => ({ form: "10-K", start: `${y}-01-01`, end: `${y}-12-31`, val, filed: `${y + 1}-02-01` });
  const facts = { facts: { "us-gaap": {
    CommonStockSharesOutstanding: { units: { shares: [2020, 2021, 2022, 2023, 2024].map((y, i) => year(y, 1000 + i * 100)) } },
  } } };
  const result = evaluateRules(facts, {});
  const dilution = result.rules.find((r) => r.id === "dilution");
  assert.equal(dilution.skipped, undefined, "the rule must compute when share history exists");
  // 1000 to 1400 is 40% dilution, past the 20% threshold.
  assert.equal(dilution.value, 40);
  assert.equal(dilution.passed, false);
});

// Two-series rules paired by array position, not by fiscal period. A gap in one series --
// a tag the filer stopped using, a year reported under an out-of-catalog alias -- shifted
// every later year onto the wrong counterpart, and the provenance block still showed a
// clean year range. The ratio looked exactly like a computed one because it was computed,
// just from two different years.
const rowsFor = (concepts) => ({
  facts: {
    "us-gaap": Object.fromEntries(Object.entries(concepts).map(([tag, rows]) => [
      tag,
      { units: { USD: rows.map(([y, val]) => ({ val, start: `${y}-01-01`, end: `${y}-12-31`, filed: `${y + 1}-02-15`, form: "10-K" })) } },
    ])),
  },
});

test("roe pairs net income with the same year's equity even across a gap", () => {
  const years = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023];
  const result = evaluateRules(rowsFor({
    NetIncomeLoss: years.map((y) => [y, (y - 2015) * 10]),
    // 2019 equity is missing; every year's true ROE is exactly 10%.
    StockholdersEquity: years.filter((y) => y !== 2019).map((y) => [y, (y - 2015) * 100]),
  }));
  const roe = rule(result, "roe_10y");
  assert.equal(roe.value, 10, "each year's income must divide by the same year's equity");
  assert.equal(roe.years, 7, "the gap year is dropped, not matched to a neighbour");
});

test("interest cover is skipped when the latest EBIT year has no interest figure", () => {
  const result = evaluateRules(rowsFor({
    OperatingIncomeLoss: [[2021, 50], [2022, 60], [2023, 100]],
    // The filer stopped tagging InterestExpense after 2021. Dividing 2023 EBIT by
    // 2021 interest reported a confident 2.5x for a period nobody measured.
    InterestExpense: [[2020, 40], [2021, 40]],
  }));
  assert.ok(rule(result, "interest_cover").skipped, "a stale denominator is a gap, not a cover ratio");
});

test("gross margin pairs each year's profit with that year's revenue", () => {
  const result = evaluateRules(rowsFor({
    GrossProfit: [[2019, 40], [2020, 40], [2022, 40], [2023, 40]],
    Revenues: [[2019, 100], [2020, 100], [2021, 200], [2022, 200], [2023, 200]],
  }));
  const gm = rule(result, "gross_margin");
  // (40% + 40% + 20% + 20%) / 4. Position-based pairing read 25% instead.
  assert.equal(gm.value, 30);
  assert.equal(gm.years, 4);
});

test("cumulative rules sum over the same fiscal window on both sides", () => {
  const result = evaluateRules(rowsFor({
    NetCashProvidedByUsedInOperatingActivities: [[2019, 10], [2020, 10], [2021, 10], [2022, 10], [2023, 10]],
    PaymentsToAcquirePropertyPlantAndEquipment: [[2017, 3], [2018, 3], [2019, 3], [2020, 3], [2021, 3]],
  }));
  const fcf = rule(result, "fcf_5y");
  // Only 2019-2021 exist on both sides: 3 x (10 - 3). Independent five-entry slices
  // subtracted 2017-2021 capex from 2019-2023 cash flow and called it one window.
  assert.equal(fcf.value, 21);
  assert.equal(fcf.years, 3);
});

// Nothing in the reader caches one company's facts, so a second company cannot leak into a
// first. This pins that: fetchCompanyFacts takes a CIK and returns fresh data, and the
// module-level state that does exist is the SEC ticker list, the TWSE dataset and a rate
// limiter -- none of it per-company. Asserted on fixtures so it runs offline.
test("evaluating one company cannot leak into another", async () => {
  const { evaluateRules } = await import("../../mcp/lib/screen.mjs");
  const ten = (v) => Array.from({ length: 10 }, () => v);
  // Enough history that rules actually compute -- comparing two all-skip signatures would
  // pass no matter what the reader did.
  const A = facts({ NetIncomeLoss: ten(10), StockholdersEquity: ten(100), Revenues: ten(200) });
  const B = facts({ NetIncomeLoss: ten(90), StockholdersEquity: ten(100), Revenues: ten(200) });

  const first = evaluateRules(A, {});
  assert.ok(first.evaluated_count > 0, "the fixture must compute something to be worth comparing");
  evaluateRules(B, {});
  const again = evaluateRules(A, {});

  const signature = (r) => r.rules.map((x) => `${x.id}:${x.skipped ? "skip" : x.value}`).join("|");
  assert.equal(signature(first), signature(again),
    "the same filings must evaluate identically regardless of what ran in between");
  assert.notEqual(signature(first), signature(evaluateRules(B, {})),
    "and different filings must not evaluate the same");
});
