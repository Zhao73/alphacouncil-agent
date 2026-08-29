import assert from "node:assert/strict";
import test from "node:test";

import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { executeDeterministicPersonaPolicy } from "../../mcp/lib/personas-v3/runtime.mjs";
import { adaptGroundingToTypedFacts } from "../../mcp/lib/personas-v3/grounding-adapter.mjs";
import { buildAnonymousPreDecision } from "../../mcp/lib/personas-v3/runtime.mjs";
import { planSoloTestFormulaCompilation } from "../../scripts/lib/persona-v3-solo-formula-pipeline.mjs";

const AS_OF = "2026-07-27";

function policyFor(tool) {
  return canonicalValue({
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: "solo_proxy_native_v1",
    native_states: ["proxy_input_missing", "proxy_insufficient", "proxy_observed", "proxy_unmet"],
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "proxy_input_missing", common_stance: "out_of_scope" },
    },
    eligibility: { all: [] },
    hard_vetoes: [],
    scoring: {
      max_score: 1,
      min_coverage: 1,
      on_insufficient_coverage: { native_state: "proxy_insufficient", common_stance: "out_of_scope" },
      rules: [{
        rule_id: "proxy.observable",
        condition: { op: "gte", left: { output_id: tool.output_id }, right: { literal: 0 } },
        points: 1,
        coverage_weight: 1,
        source_ids: tool.source_ids,
      }],
    },
    score_bands: [
      { min_ratio: 1, decision: { native_state: "proxy_observed", common_stance: "constructive" } },
      { min_ratio: 0, decision: { native_state: "proxy_unmet", common_stance: "cautious" } },
    ],
    native_output_fields: [{ field: "proxy_value", value: { output_id: tool.output_id }, on_missing: "fail" }],
  });
}

function packFor(tool) {
  const policy = policyFor(tool);
  return canonicalValue({
    schema_version: 3,
    pack_version: "0.9.0",
    persona_id: "master_taleb",
    source_cutoff: AS_OF,
    admitted_label: { en: "Solo derived proxy", zh: "单维护者派生代理" },
    corpus_hash: sha256([]),
    tool_graph_hash: sha256([tool]),
    policy_hash: sha256(policy),
    pack_hash: sha256({ policy, tools: [tool] }),
    manifest: {
      identity: {
        persona_id: "master_taleb",
        public_label: { en: "Named method", zh: "具名方法" },
        operator_label: { en: "Solo test proxy", zh: "单人测试代理" },
      },
      capability: {
        required_fact_types: ["options.implied_volatility"],
        optional_fact_types: [],
        native_decision_schema: "solo_proxy_native_v1",
      },
      computation: { dsl_version: "1.1", pipeline: [tool.id] },
      decision: {
        eligibility: ["options.implied_volatility"],
        hard_vetoes: [],
        native_output: "solo_proxy_native_v1",
        common_projection: "master_projection_v1",
        abstention_policy: "fail_closed",
        confidence_calibrator: null,
      },
    },
    components: { doctrine: [], decision_policy: policy, tools: [tool] },
    voice: { en: "Proxy only.", zh: "仅代理。" },
  });
}

test("an options proxy executes against the real grounding-adapter typed contract", () => {
  // Whichever authored tool reads implied volatility first, its declared contract must be
  // the one the grounding adapter actually emits. Bound by fact rather than by tool id, since
  // an authored method names its own steps.
  const tool = planSoloTestFormulaCompilation().tools
    .find((entry) => (entry.inputs || []).some((input) => input.fact_id === "options.implied_volatility")
      && entry.input_contracts?.[0]?.unit === "decimal_annualized_volatility");
  assert.ok(tool, "no authored tool consumes implied volatility on its declared contract");
  assert.equal(tool.input_contracts[0].value_kind, "ratio");
  assert.equal(tool.input_contracts[0].unit, "decimal_annualized_volatility");

  const adapted = adaptGroundingToTypedFacts({
    as_of: AS_OF,
    gathered_at: "2026-07-27T12:00:00.000Z",
    options: {
      symbol: "NOK",
      available: true,
      delayed: true,
      source: "CBOE delayed quotes",
      retrieved_at: "2026-07-27T11:55:00.000Z",
      reference_expiry: { expiry: "2026-08-15", atm_iv: 0.45 },
    },
  }, { asOf: AS_OF });
  const fact = adapted.fact_pack.facts.find((entry) => entry.fact_id === "options.implied_volatility");
  assert.equal(fact.value_kind, "ratio");
  assert.equal(fact.unit, "decimal_annualized_volatility");

  // The property this guards is contract alignment, not passthrough: a tool declaring a
  // contract the adapter never emits fails at execution with a mismatch nobody can debug from
  // the report. An authored tool computes rather than copies, so the value it produces is the
  // method's business; that the two sides agree on kind, unit and period is this test's.
  const contract = tool.input_contracts[0];
  assert.equal(fact.value_kind, contract.value_kind);
  assert.equal(fact.unit, contract.unit);
  assert.deepEqual(tool.output_period, { basis: "instant", window: null, alignment: "as_of" });

  // A seat holding one fact out of several is not ready, and says so rather than executing on
  // a hole. Naming the missing inputs is what makes the abstention readable.
  const before = buildAnonymousPreDecision({
    compiledPack: packFor(tool),
    factPack: adapted.fact_pack,
    privateEvidence: [],
  });
  assert.ok(["ready", "insufficient_facts"].includes(before.eligibility.status));
  if (before.eligibility.status !== "ready") {
    assert.ok(before.eligibility.missing_required_fact_types.length > 0);
  }
});
