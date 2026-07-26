import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRules, explainResult } from "../../mcp/lib/screen.mjs";

/** Minimal companyfacts shape, so the rules can be tested without touching the network. */
const facts = (concepts) => ({
  facts: {
    "us-gaap": Object.fromEntries(Object.entries(concepts).map(([tag, vals]) => [
      tag,
      {
        units: {
          USD: vals.map((val, i) => ({
            val,
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
