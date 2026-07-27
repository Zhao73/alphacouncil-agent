import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { declinedOpinion, factsFromRun, planMasters, reconcileOpinion } from "../../mcp/lib/personas-v2/bridge.mjs";

/** Frozen from the public-data shape that actually reached a NOK run; generated opinions removed. */
const nokGrounding = JSON.parse(readFileSync(
  new URL("../fixtures/nok-grounding-production-shape.json", import.meta.url),
  "utf8",
));
const nokRun = {
  symbol: "NOK",
  as_of: "2026-07-26",
  grounding: nokGrounding,
};

test("grounding maps onto the fact paths the packs address", () => {
  const facts = factsFromRun(nokRun);
  assert.equal(facts.screen.rules_computed, 0);
  // Zero computable rules is exactly what a 20-F filer yields, so the flag must follow it
  // rather than being asserted separately.
  assert.equal(facts.filer.structured_financials, false);
  assert.equal(facts.options.chain_available, true);
  assert.equal(facts.options.atm_iv, 0.6878);
  assert.equal(facts.options.skew_25d_points, 0.33);
  assert.equal(facts.quote.price, 9.1);
});

test("a field the grounding does not carry stays absent rather than being invented", () => {
  const facts = factsFromRun({ symbol: "X", grounding: {} });
  assert.equal(facts.options.atm_iv, undefined);
  assert.deepEqual(facts.screen.metrics, {});
});

// Two methods, one security, two different reasons for standing down -- which is the
// differentiation working. Buffett fails the entry test outright: a 20-F filer yields no
// financial series. Taleb passes the entry test (a chain exists) and then finds too little
// of its own rule set computable, because a chain snapshot carries no volatility history and
// so no implied-versus-realized gap and no friction-adjusted edge. Under the old design both
// would have written a confident essay.
test("on the frozen production-shaped NOK grounding, two methods stand down for different reasons", () => {
  const plan = planMasters(nokRun, ["master_buffett", "master_taleb"]);
  const reasons = Object.fromEntries(plan.declined.map((d) => [d.id, d.decision.reason]));
  assert.equal(reasons.master_buffett, "eligibility");
  assert.equal(reasons.master_taleb, "insufficient_coverage");
  assert.equal(plan.to_run.length, 0);
});

test("a synthetic calculator result carrying derived metrics lets the volatility method run", () => {
  const richer = {
    ...nokRun,
    grounding: {
      ...nokRun.grounding,
      options: {
        ...nokRun.grounding.options,
        realized_minus_implied_vol_points: 8,
        net_edge_vol_points: 2,
        expiry_covers_next_event: false,
      },
    },
  };
  const plan = planMasters(richer, ["master_buffett", "master_taleb"]);
  assert.deepEqual(plan.to_run.map((t) => t.id), ["master_taleb"]);
  assert.deepEqual(plan.declined.map((d) => d.id), ["master_buffett"]);
});

test("an ungrounded run runs every master as v1 rather than silencing the bench", () => {
  // No grounding is not the same as a screen that computed nothing: a run that was never
  // measured must not have its whole bench declined on the strength of missing data.
  const plan = planMasters({ symbol: "X", grounding: null }, ["master_buffett", "master_taleb"]);
  assert.equal(plan.declined.length, 0);
  assert.deepEqual(plan.to_run.map((t) => t.engine), ["v1_prompt", "v1_prompt"]);
});

test("a master with no v2 pack keeps running as a v1 prompt persona", () => {
  const plan = planMasters(nokRun, ["master_soros"]);
  assert.deepEqual(plan.to_run, [{ id: "master_soros", engine: "v1_prompt" }]);
  assert.equal(plan.declined.length, 0);
});

test("a declined opinion says which requirement was unmet and costs nothing", () => {
  const plan = planMasters(nokRun, ["master_buffett"]);
  const opinion = declinedOpinion(nokRun, "master_buffett", plan.declined[0].decision);
  assert.equal(opinion.stance, "out_of_scope");
  assert.equal(opinion.engine, "v2_method_model");
  assert.match(opinion.summary, /entry requirements are not met/);
  assert.match(opinion.summary, /without spending a model call/);
  assert.ok(opinion.disqualifiers_triggered.length > 0);
  assert.ok(opinion.what_would_change_my_mind.length > 0);
});

test("a narrated stance that contradicts the arithmetic does not win quietly", () => {
  const narrated = { master: "master_buffett", stance: "constructive", summary: "I like it" };
  const { opinion, overridden } = reconcileOpinion(nokRun, "master_buffett", narrated);
  assert.equal(overridden, true);
  assert.equal(opinion.stance, "out_of_scope", "the deterministic verdict governs");
  assert.equal(opinion.narrated_stance, "constructive", "and the disagreement is preserved, not erased");
  assert.match(opinion.override_reason, /does not govern/);
});

test("an agreeing narration is left alone and marked v2", () => {
  const narrated = { master: "master_buffett", stance: "out_of_scope", summary: "cannot look" };
  const { opinion, overridden } = reconcileOpinion(nokRun, "master_buffett", narrated);
  assert.equal(overridden, false);
  assert.equal(opinion.engine, "v2_method_model");
  assert.equal(opinion.deterministic_stance, "out_of_scope");
});

test("an ungrounded run has no arithmetic to reconcile against", () => {
  const { overridden, engine } = reconcileOpinion({ symbol: "X", grounding: null }, "master_buffett", { stance: "constructive" });
  assert.equal(overridden, false);
  assert.equal(engine, "v1_prompt");
});
