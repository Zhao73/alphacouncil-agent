import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, evaluateEligibility, evaluateVetoes, parseCondition, readPath, scoreMethod, stanceFromRatio } from "../../mcp/lib/personas-v2/policy.mjs";
import { ADMISSION_BAR, admissionShortfall, countAdmission, loadPack, loadPacks, validatePack } from "../../mcp/lib/personas-v2/loader.mjs";

const buffett = loadPacks().get("master_buffett");

/** A filer with everything the Buffett method wants to see. */
const goodFacts = {
  filer: { structured_financials: true },
  screen: {
    rules_computed: 7,
    metrics: { roe_10y: 0.22, debt_to_equity: 0.3, gross_margin: 0.55, ocf_over_ni: 1.2, dilution_5y: 0.01 },
  },
};

/** NOK as it actually arrived: a 20-F filer with nothing computable. */
const nokFacts = {
  filer: { structured_financials: false },
  screen: { rules_computed: 0, metrics: {} },
};

test("the pilot pack loads and its thresholds all carry provenance", () => {
  assert.ok(buffett, "master_buffett pack should load");
  for (const rule of buffett.decision_policy.scoring.rules) {
    assert.ok(rule.provenance && rule.provenance.length >= 8, `${rule.id} needs provenance`);
  }
});

test("a thin corpus cannot name itself after a person", () => {
  // The bar is enforced in code, not awarded by the manifest. The pilot pack is honest
  // about being under it; the loader would downgrade it even if it were not.
  const counts = countAdmission(buffett);
  const short = admissionShortfall(counts);
  assert.ok(Object.keys(short).length > 0, "pilot corpus is deliberately below the bar");
  assert.equal(buffett.kind, "operator_lens");
  assert.ok(short.propositions.required === ADMISSION_BAR.propositions);
});

test("a pack that clears the bar is promoted to a method model", () => {
  const rich = {
    ...buffett,
    doctrine: Array.from({ length: 25 }, (_, i) => ({ ...buffett.doctrine[0], rule_id: `buffett.x.${String(i).padStart(2, "0")}` })),
    sources: Array.from({ length: 5 }, (_, i) => ({ ...buffett.sources[0], id: `buffett:S${i}` })),
    decision_cases: Array.from({ length: 5 }, () => ({})),
    failure_cases: Array.from({ length: 3 }, () => ({})),
    counterfactuals: Array.from({ length: 10 }, () => ({})),
    decision_policy: { ...buffett.decision_policy, vetoes: Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, condition: "a > 1", source_ids: ["x"] })) },
  };
  assert.deepEqual(admissionShortfall(countAdmission(rich)), {});
});

test("a display name that reads as a person is rejected", () => {
  const errors = validatePack({ ...buffett, display_name: { en: "Warren Buffett" } }, "t");
  assert.ok(errors.some((e) => /must read as a method/.test(e)), errors.join("; "));
});

test("a doctrine rule with no grade A or B source cannot define anything", () => {
  const errors = validatePack({
    ...buffett,
    sources: [{ id: "x:S1", grade: "D", title: "t", url: "u", date: "d" }],
    doctrine: [{ ...buffett.doctrine[0], source_ids: ["x:S1"] }],
  }, "t");
  assert.ok(errors.some((e) => /cannot define a rule/.test(e)), errors.join("; "));
});

test("a memory leak rule missing its second clause is rejected", () => {
  const errors = validatePack({ ...buffett, memory_policy: { leak_rule: "public_at <= as_of" } }, "t");
  assert.ok(errors.some((e) => /reads the future/.test(e)), errors.join("; "));
});

test("condition parsing stays small and predictable", () => {
  assert.deepEqual(parseCondition("screen.rules_computed >= 4"), { path: "screen.rules_computed", op: ">=", value: 4 });
  assert.deepEqual(parseCondition("filer.structured_financials"), { path: "filer.structured_financials", op: "==", value: true });
  assert.deepEqual(parseCondition("!filer.structured_financials"), { path: "filer.structured_financials", op: "==", value: false });
  assert.equal(parseCondition("this is not a condition"), null);
  assert.equal(readPath({ a: { b: 2 } }, "a.b"), 2);
  assert.equal(readPath({ a: {} }, "a.b.c"), undefined);
});

test("NOK is declined before any model is called", () => {
  // The run this release came from: every master received "0/7 computable" and wrote an
  // essay anyway. A method that cannot reach the security should say so and stop.
  const result = decide(buffett, nokFacts);
  assert.equal(result.stance, "out_of_scope");
  assert.equal(result.reason, "eligibility");
  assert.equal(result.narratable, false, "an ineligible method has nothing for a model to say");
  assert.ok(result.eligibility.unmet.length >= 1);
});

test("a qualifying business scores and is narratable", () => {
  const result = decide(buffett, goodFacts);
  assert.equal(result.narratable, true);
  assert.equal(result.stance, "constructive");
  assert.equal(result.score.uncomputable.length, 0);
  assert.equal(result.score.coverage, 1);
  assert.ok(result.score.hits.length === 5, "all five rules should hit on these numbers");
});

test("a missing metric is uncomputable, never a miss and never a hit", () => {
  // The screen_ticker lesson, restated: reporting 6/7 without naming the seventh
  // misrepresents the screen. Here it must not silently become a failing rule either.
  const partial = {
    filer: { structured_financials: true },
    screen: { rules_computed: 4, metrics: { roe_10y: 0.22, debt_to_equity: 0.3 } },
  };
  const scored = scoreMethod(buffett, partial);
  assert.equal(scored.hits.length, 2);
  assert.equal(scored.misses.length, 0);
  assert.equal(scored.uncomputable.length, 3);
  assert.equal(scored.max_possible, 5, "max excludes what could not be measured");
  assert.ok(scored.coverage < 1);
});

test("a method that could only evaluate a fraction of itself declines", () => {
  const sparse = {
    filer: { structured_financials: true },
    screen: { rules_computed: 4, metrics: { roe_10y: 0.22 } },
  };
  const result = decide(buffett, sparse);
  assert.equal(result.stance, "out_of_scope");
  assert.equal(result.reason, "insufficient_coverage");
  assert.equal(result.narratable, false);
});

test("a veto overrides a good score rather than being averaged into it", () => {
  const levered = {
    filer: { structured_financials: true },
    screen: {
      rules_computed: 7,
      metrics: { roe_10y: 0.4, debt_to_equity: 3, gross_margin: 0.6, ocf_over_ni: 1.3, dilution_5y: 0 },
    },
  };
  const triggered = evaluateVetoes(buffett, levered);
  assert.ok(triggered.some((v) => v.id === "leveraged_roe"));
  const result = decide(buffett, levered);
  assert.equal(result.stance, "opposed");
  assert.equal(result.reason, "veto");
});

test("eligibility distinguishes a missing input from an unmet one", () => {
  const missing = evaluateEligibility(buffett, { filer: {}, screen: { metrics: {} } });
  assert.ok(missing.unmet.some((u) => u.reason === "missing_input"));
  const unmet = evaluateEligibility(buffett, { filer: { structured_financials: true }, screen: { rules_computed: 1 } });
  assert.ok(unmet.unmet.some((u) => u.reason === "not_met" && u.actual === 1));
});

test("stance bands map ratios to the highest band cleared", () => {
  assert.equal(stanceFromRatio(buffett, 0.9), "constructive");
  assert.equal(stanceFromRatio(buffett, 0.5), "cautious");
  assert.equal(stanceFromRatio(buffett, 0.1), "opposed");
});

test("the decision is pure: identical facts give an identical decision", () => {
  const a = JSON.stringify(decide(buffett, goodFacts));
  const b = JSON.stringify(decide(buffett, structuredClone(goodFacts)));
  assert.equal(a, b);
});
