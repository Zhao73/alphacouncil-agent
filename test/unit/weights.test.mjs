import { test } from "node:test";
import assert from "node:assert/strict";
import { baseWeight, verificationAdjustment, resolveSeatWeights, weightTableMarkdown } from "../../mcp/lib/weights.mjs";
import { registry } from "../../mcp/lib/personas/registry.mjs";

const run = (over = {}) => ({
  master_opinions: [
    { master: "master_buffett", stance: "constructive" },
    { master: "master_munger", stance: "opposed" },
  ],
  verifier_verdicts: [],
  ...over,
});

test("every seat that can vote declares a weight", () => {
  const reg = registry();
  const voting = [
    ...reg.ids("debate").filter((id) => id !== "portfolio_manager"),
    ...reg.ids("master"),
  ];
  for (const id of voting) {
    assert.ok(Number.isFinite(reg.get(id).default_weight), `${id} must declare default_weight`);
    assert.ok(reg.get(id).default_weight > 0, `${id} weight must be positive`);
  }
  // The PM synthesises; it does not vote against itself.
  assert.equal(reg.get("portfolio_manager").default_weight, undefined);
});

test("an undeclared weight falls back to 1 rather than 0", () => {
  assert.equal(baseWeight({}), 1);
  assert.equal(baseWeight({ default_weight: 0 }), 1, "0 would silently mute a seat");
  assert.equal(baseWeight({ default_weight: 1.5 }), 1.5);
});

test("a seat with no verdicts is unadjusted", () => {
  assert.deepEqual(verificationAdjustment("x", []), { factor: 1, reasons: [] });
  assert.deepEqual(verificationAdjustment("x", [{ seat: "other", verdict: "contradicted" }]), { factor: 1, reasons: [] });
});

// The core rule: failing verification costs a seat its standing, but never erases it.
test("a contradicted seat is heavily down-weighted and never silenced", () => {
  const { factor } = verificationAdjustment("s", [{ seat: "s", verdict: "contradicted" }]);
  assert.ok(factor <= 0.2, `expected a heavy penalty, got ${factor}`);
  assert.ok(factor > 0, "a seat must never be reduced to zero by verification alone");
});

test("penalties scale with how many claims were checked", () => {
  const one = verificationAdjustment("s", [{ seat: "s", verdict: "contradicted" }]).factor;
  const oneOfTen = verificationAdjustment("s", [
    { seat: "s", verdict: "contradicted" },
    ...Array.from({ length: 9 }, () => ({ seat: "s", verdict: "supported" })),
  ]).factor;
  assert.ok(oneOfTen > one, "one bad verdict in ten must cost less than one in one");
});

test("softer verdicts cost less than contradictions", () => {
  const hard = verificationAdjustment("s", [{ seat: "s", verdict: "contradicted" }]).factor;
  const soft = verificationAdjustment("s", [{ seat: "s", verdict: "cannot_confirm" }]).factor;
  assert.ok(soft > hard, "cannot_confirm is a weaker signal than contradicted");
});

test("an out_of_scope master carries no weight into a verdict it declined to give", () => {
  const resolved = resolveSeatWeights(run({
    master_opinions: [
      { master: "master_buffett", stance: "out_of_scope" },
      { master: "master_munger", stance: "opposed" },
    ],
  }));
  const buffett = resolved.seats.find((s) => s.seat === "master_buffett");
  assert.equal(buffett.effective_weight, 0);
  assert.equal(buffett.share, 0);
  assert.ok(buffett.out_of_scope);
});

test("an override replaces the declared weight and is labelled as an override", () => {
  const resolved = resolveSeatWeights(run(), { master_buffett: 3 });
  const buffett = resolved.seats.find((s) => s.seat === "master_buffett");
  assert.equal(buffett.override_weight, 3);
  assert.equal(buffett.effective_weight, 3);
  assert.notEqual(buffett.declared_weight, 3, "the declared weight stays visible alongside the override");
});

test("shares sum to one so the table cannot hide a seat", () => {
  const resolved = resolveSeatWeights(run());
  const total = resolved.seats.reduce((sum, s) => sum + s.share, 0);
  assert.ok(Math.abs(total - 1) < 0.01, `shares summed to ${total}`);
});

test("the rendered table shows the adjustment reason, not just the number", () => {
  const resolved = resolveSeatWeights(run({
    verifier_verdicts: [{ seat: "master_buffett", verdict: "contradicted" }],
  }));
  const table = weightTableMarkdown(resolved, "English");
  assert.match(table, /master_buffett/);
  assert.match(table, /contradicted/, "the reason must be visible in the report");
  assert.match(table, /look-ahead bias/, "the honesty note about not being an optimum must survive");
  assert.match(weightTableMarkdown(resolved, "中文"), /前视偏差/);
});
