import { test } from "node:test";
import assert from "node:assert/strict";

import { factsInCondition, readableValue, voiceFromDecision, voiceFromDecline } from "../../mcp/lib/voice-from-decision.mjs";

const fact = (fact_id, value, unit = "decimal") => ({ fact_id, value, unit });

test("the fields are derived from the decision, so they cannot contradict it", () => {
  const result = {
    common_projection: { stance: "opposed", score_ratio: 0.25 },
    computations: { trace: [{ output_id: "valuation.owner_earnings_yield", value: 0.0123, status: "computed" }] },
    score: {
      hits: [{ rule_id: "anon_a" }],
      misses: [{ rule_id: "anon_b" }, { rule_id: "anon_c" }],
      uncomputable: [],
    },
    vetoes_triggered: [],
  };
  const policy = {
    scoring: {
      rules: [
        { rule_id: "buffett_owner_earnings_beat_the_bond", condition: { left: { fact_id: "financial.owner_earnings" } } },
        { rule_id: "buffett_returns_are_durable", condition: { left: { fact_id: "financial.return_on_equity_10y" } } },
        { rule_id: "buffett_no_borrowed_money", condition: { left: { fact_id: "financial.leverage" } } },
      ],
    },
    hard_vetoes: [],
    eligibility: { all: [] },
  };
  const factPack = { facts: [fact("financial.owner_earnings", 0.08), fact("financial.leverage", 0.4)] };
  const voice = voiceFromDecision({ result, policy, factPack, language: "English" });

  // Every field is present and none is a stub.
  for (const [field, text] of Object.entries(voice)) {
    assert.equal(typeof text, "string", field);
    assert.ok(text.length > 20, `${field} must say something: ${text}`);
  }
  // What it read, with values -- the thing a one-line statement never showed.
  assert.match(voice.what_i_see, /financial\.owner_earnings = 8\.0%/u);
  assert.match(voice.what_i_see, /valuation\.owner_earnings_yield = 0\.0123/u);
  // The counts come from the executor's own split, so they cannot drift from the verdict.
  assert.match(voice.how_my_method_reads_it, /1 of 3 scoring conditions held/u);
  assert.match(voice.how_my_method_reads_it, /opposed band/u);
  // Anonymous rule ids are mapped back to the seat's readable names for the reader.
  assert.match(voice.how_my_method_reads_it, /buffett_owner_earnings_beat_the_bond/u);
  assert.doesNotMatch(voice.how_my_method_reads_it, /anon_/u);
  // What would change it is exactly what did not hold.
  assert.match(voice.what_changes_my_mind, /buffett_returns_are_durable/u);
});

test("a fired veto is reported as the thing that decided it", () => {
  const voice = voiceFromDecision({
    result: {
      common_projection: { stance: "opposed", score_ratio: null },
      computations: { trace: [] },
      score: { hits: [], misses: [], uncomputable: [] },
      vetoes_triggered: [{ veto_id: "graham_no_asset_floor" }],
    },
    policy: { scoring: { rules: [] }, hard_vetoes: [], eligibility: { all: [] } },
    factPack: { facts: [] },
    language: "English",
  });
  assert.match(voice.how_my_method_reads_it, /hard veto decided this before scoring: graham_no_asset_floor/u);
  assert.match(voice.what_changes_my_mind, /graham_no_asset_floor/u);
});

test("an abstention is readable: what was there, what was needed, why no substitute", () => {
  const voice = voiceFromDecline({
    eligibility: {
      present_required_fact_types: ["market.price"],
      missing_required_fact_types: ["financial.owner_earnings", "capital_allocation.share_count"],
    },
    language: "English",
  });
  assert.match(voice.what_i_see, /market\.price/u);
  assert.match(voice.how_my_method_reads_it, /financial\.owner_earnings/u);
  assert.match(voice.where_i_disagree, /substituting a proxy/u);
  for (const text of Object.values(voice)) assert.ok(text.length > 20);
});

test("every locale composes real sentences rather than falling back to English", () => {
  const args = {
    result: {
      common_projection: { stance: "cautious", score_ratio: 0.5 },
      computations: { trace: [] },
      score: { hits: [{ rule_id: "a" }], misses: [{ rule_id: "b" }], uncomputable: [] },
      vetoes_triggered: [],
    },
    policy: { scoring: { rules: [{ rule_id: "rule_one" }, { rule_id: "rule_two" }] }, hard_vetoes: [], eligibility: { all: [] } },
    factPack: { facts: [] },
  };
  for (const [language, marker] of [["中文", /条评分条件中有/u], ["日本語", /件の採点条件のうち/u], ["한국어", /채점 조건/u]]) {
    const voice = voiceFromDecision({ ...args, language });
    assert.match(voice.how_my_method_reads_it, marker, language);
  }
});

test("values read the way a person reads them, and conditions surrender their fact ids", () => {
  assert.equal(readableValue({ value: 0.0815, unit: "decimal" }), "8.2%");
  assert.equal(readableValue({ value: 4.2e9, unit: "currency_units" }), "4.20B");
  assert.equal(readableValue({ value: 12.5, unit: "multiple" }), "12.5");
  assert.equal(readableValue({ value: null }), "—");
  assert.deepEqual(
    factsInCondition({ op: "any", conditions: [{ left: { fact_id: "a.b" } }, { left: { fact_id: "c.d" } }] }),
    ["a.b", "c.d"],
  );
});
