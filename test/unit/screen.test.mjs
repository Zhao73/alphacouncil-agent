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
