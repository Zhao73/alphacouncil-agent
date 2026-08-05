import test from "node:test";
import assert from "node:assert/strict";

import { loadCompiledPersonaPacks } from "../../mcp/lib/personas-v3/registry.mjs";
import { buildFactPack } from "../../mcp/lib/personas-v3/typed-facts.mjs";
import { completedMasterOpinion, planMasterSeats } from "../../mcp/lib/personas/engine.mjs";

const AS_OF = "2026-08-05";
const packs = loadCompiledPersonaPacks({ buildProfile: "solo_test" });

function fact(factId, value, {
  valueKind = "ratio",
  unit = "decimal",
  sourceId = `fixture:${factId}`,
} = {}) {
  return {
    schema_version: 1,
    fact_id: factId,
    value_kind: valueKind,
    value,
    unit: ["boolean", "text", "date"].includes(valueKind) ? null : unit,
    currency: valueKind === "monetary" ? "USD" : null,
    scale: valueKind === "monetary" ? 1 : null,
    ...(valueKind === "ratio" ? { ratio_denominator: "fixture_denominator" } : {}),
    period_start: null,
    period_end: null,
    fiscal_year: null,
    as_of: AS_OF,
    public_at: AS_OF,
    source_ids: [sourceId],
    derivation: "reported",
    confidence: 1,
    restatement_policy: "frozen fixture",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  };
}

function plan(personaId, facts) {
  return planMasterSeats({
    symbol: "VRT",
    as_of: AS_OF,
    grounding: { typed_fact_pack: buildFactPack(facts, { asOf: AS_OF }) },
  }, [personaId], {
    v3Registry: packs,
    legacyPlanner: () => { throw new Error("a physical v3 seat must not fall through"); },
  });
}

function completeDamodaranFacts(indexEarningsYield) {
  return [
    fact("valuation.cash_flow", 1_000_000_000, { valueKind: "monetary", unit: "currency_units" }),
    fact("valuation.implied_story", 0.18),
    fact("valuation.revenue_growth", 0.12),
    fact("valuation.target_margin", 0.22),
    fact("valuation.reinvestment_rate", 0.45),
    fact("valuation.cost_of_capital", 0.09),
    fact("valuation.failure_probability", 0.03),
    fact("index.aggregate_earnings_yield", indexEarningsYield),
    fact("macro.long_bond_yield", 0.047),
  ];
}

function completeTalebFacts({ ruinPossible = false } = {}) {
  return [
    fact("payoff.max_loss", 1, { unit: "decimal_of_invested_capital" }),
    fact("payoff.convexity", 0.2),
    fact("risk.ruin_possible", ruinPossible, { valueKind: "boolean" }),
    fact("risk.hidden_leverage", 0),
    fact("options.implied_volatility", 0.35, { unit: "decimal_annualized_volatility" }),
    fact("options.realized_volatility", 0.3, { unit: "decimal_annualized_volatility" }),
    fact("options.skew_25d", 0.04, { unit: "decimal_volatility_difference" }),
    fact("execution.round_trip_cost", 0.01, { unit: "decimal_of_mid" }),
    fact("event.expiry_coverage", true, { valueKind: "boolean" }),
    fact("valuation.downside_floor", -2_000_000_000, { valueKind: "monetary", unit: "currency_units" }),
  ];
}

test("Damodaran declines an operating company when only an index valuation proxy exists", () => {
  const result = plan("master_damodaran", [
    fact("index.aggregate_pe_ttm", 25, { unit: "multiple" }),
    fact("index.aggregate_earnings_yield", 0.04),
    fact("macro.long_bond_yield", 0.047),
    fact("valuation.implied_erp", 0.0423),
  ]);

  assert.equal(result.completed.length, 0);
  assert.equal(result.declined.length, 1);
  assert.equal(result.declined[0].decision.stance, "out_of_scope");
  assert.deepEqual(
    result.declined[0].preDecision.eligibility.missing_required_fact_types,
    ["valuation.cash_flow", "valuation.implied_story"],
  );
});

test("Damodaran's operating-company result is invariant to a broad-index earnings yield", () => {
  const lowYield = plan("master_damodaran", completeDamodaranFacts(0.01)).completed[0].decision;
  const highYield = plan("master_damodaran", completeDamodaranFacts(0.2)).completed[0].decision;

  for (const decision of [lowYield, highYield]) {
    assert.equal(decision.stance, "cautious");
    assert.equal(decision.reason, "score");
    assert.equal(decision.ratio, 1);
    assert.deepEqual(decision.vetoes_triggered, []);
    assert.equal(decision.native_decision.state, "provisional_company_valuation_review_required");
  }
  assert.deepEqual(lowYield.native_decision, highYield.native_decision);
  assert.deepEqual(lowYield.common_projection, highYield.common_projection);
});

test("Taleb declines when accounting downside is negative but the actual payoff is missing", () => {
  const result = plan("master_taleb", [
    fact("valuation.downside_floor", -2_000_000_000, { valueKind: "monetary", unit: "currency_units" }),
    fact("risk.hidden_leverage", 0),
    fact("options.implied_volatility", 0.35, { unit: "decimal_annualized_volatility" }),
    fact("options.skew_25d", 0.04, { unit: "decimal_volatility_difference" }),
  ]);

  assert.equal(result.completed.length, 0);
  assert.equal(result.declined.length, 1);
  assert.equal(result.declined[0].decision.stance, "out_of_scope");
  assert.deepEqual(
    result.declined[0].preDecision.eligibility.missing_required_fact_types,
    ["payoff.max_loss", "payoff.convexity"],
  );
});

test("negative NCAV does not create unbounded downside for a fully specified unlevered long payoff", () => {
  const result = plan("master_taleb", completeTalebFacts()).completed[0].decision;

  assert.equal(result.stance, "cautious");
  assert.equal(result.reason, "score");
  assert.equal(result.ratio, 1);
  assert.deepEqual(result.vetoes_triggered, []);
  assert.equal(result.native_decision.state, "provisional_convex_opportunity");
});

test("Taleb's absorbing-barrier veto independently overrides a full 2/2 score", () => {
  const completed = plan("master_taleb", completeTalebFacts({ ruinPossible: true })).completed[0];
  const result = completed.decision;
  const opinion = completedMasterOpinion({ symbol: "VRT", as_of: AS_OF, language: "English" }, completed);

  assert.equal(result.stance, "opposed");
  assert.equal(result.reason, "veto");
  assert.equal(result.score.score, 2);
  assert.equal(result.ratio, 1);
  assert.equal(result.vetoes_triggered.length, 1);
  assert.deepEqual(opinion.common_projection.veto_ids, ["master_taleb.absorbing_barrier"]);
  assert.equal(result.native_decision.state, "provisional_no_trade");
});

test("physical manifests advertise the authored executable veto ids", () => {
  for (const personaId of ["master_damodaran", "master_taleb"]) {
    const pack = packs.get(personaId);
    assert.deepEqual(
      pack.manifest.decision.hard_vetoes,
      pack.components.decision_policy.hard_vetoes.map((veto) => veto.veto_id),
    );
  }
});
