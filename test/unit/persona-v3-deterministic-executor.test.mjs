import test from "node:test";
import assert from "node:assert/strict";

import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import {
  PersonaV3PolicyError,
  PROVISIONAL_DERIVED_PROXY_ASSURANCE,
  deterministicToolSchemaHashes,
  executeDeterministicPersonaPolicy,
  validateDeterministicPolicyArtifacts,
} from "../../mcp/lib/personas-v3/deterministic-executor.mjs";
import { buildAnonymousPreDecision, assertFrozenDecisionIntegrity } from "../../mcp/lib/personas-v3/runtime.mjs";
import { buildFactPack } from "../../mcp/lib/personas-v3/typed-facts.mjs";

const AS_OF = "2026-07-27";
const TEST_HASH = `sha256:${"1".repeat(64)}`;
const REQUIRED = ["finance.net_income", "finance.da", "finance.maintenance_capex", "finance.debt_ratio", "business.understood"];

function typedFact(factId, value) {
  const valueKind = typeof value === "boolean" ? "boolean" : "scalar";
  return {
    schema_version: 1,
    fact_id: factId,
    value_kind: valueKind,
    value,
    unit: valueKind === "boolean" ? null : "points",
    currency: null,
    scale: null,
    period_start: null,
    period_end: null,
    fiscal_year: null,
    as_of: AS_OF,
    public_at: AS_OF,
    source_ids: [`filing:${factId}`],
    derivation: "reported",
    confidence: 0.9,
    restatement_policy: "frozen snapshot",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  };
}

function facts(overrides = {}) {
  const values = {
    "finance.net_income": 100,
    "finance.da": 30,
    "finance.maintenance_capex": 20,
    "finance.debt_ratio": 0.4,
    "business.understood": true,
    ...overrides,
  };
  return buildFactPack(Object.entries(values).map(([id, value]) => typedFact(id, value)), { asOf: AS_OF });
}

function tool(value) {
  const record = {
    schema_version: 1,
    dsl_version: "1.1",
    version: "1.0.0",
    kind: "recomputation",
    on_missing: "fail",
    value_kind: "scalar",
    unit: "points",
    input_contracts: value.inputs.map(() => ({
      value_kind: "scalar",
      unit: "points",
      period: { basis: "instant", window: null, alignment: "as_of" },
      on_missing: value.on_missing || "fail",
    })),
    output_period: { basis: "instant", window: null, alignment: "as_of" },
    source_ids: ["source:primary"],
    formula_spec_id: `${value.id || "fixture.tool"}.formula_spec_v1`,
    formula_spec_hash: TEST_HASH,
    formula_review_subject_hash: TEST_HASH,
    approval_bundle_hash: TEST_HASH,
    ...value,
  };
  return { ...record, ...deterministicToolSchemaHashes(record) };
}

function provisionalTool(value) {
  const reviewed = tool(value);
  const {
    input_schema_hash: _inputHash,
    output_schema_hash: _outputHash,
    formula_spec_id: _formulaSpecId,
    formula_spec_hash: _formulaSpecHash,
    formula_review_subject_hash: _reviewSubjectHash,
    approval_bundle_hash: _approvalBundleHash,
    ...base
  } = reviewed;
  const record = {
    ...base,
    assurance_class: PROVISIONAL_DERIVED_PROXY_ASSURANCE,
    review_status: "not_human_reviewed",
    intended_use: "local_test_only",
    production_eligible: false,
    derivation_spec_id: `${value.id}.prototype_v1.derived_proxy_v1`,
    derivation_spec_hash: sha256({ tool_id: value.id, kind: "derived_proxy_spec" }),
    derivation_evidence_hash: sha256({ tool_id: value.id, kind: "derived_proxy_evidence" }),
  };
  return { ...record, ...deterministicToolSchemaHashes(record) };
}

function artifacts() {
  const tools = [
    tool({
      id: "cash.addback",
      operation: "add",
      inputs: [{ fact_id: "finance.net_income" }, { fact_id: "finance.da" }],
      output_id: "cash.pre_maintenance",
    }),
    tool({
      id: "cash.owner_earnings",
      operation: "subtract",
      inputs: [{ output_id: "cash.pre_maintenance" }, { fact_id: "finance.maintenance_capex" }],
      output_id: "cash.owner_earnings_value",
    }),
  ];
  const policy = {
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: "owner_method_native_v1",
    native_states: [
      "critical_facts_missing", "business_not_explainable", "business_evidence_missing",
      "leverage_reject", "leverage_unknown", "insufficient_evidence", "own_at_price",
      "watch_candidate", "reject_candidate",
    ],
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "critical_facts_missing", common_stance: "out_of_scope" },
    },
    eligibility: {
      all: [{
        condition_id: "business.explainable",
        condition: { op: "eq", left: { fact_id: "business.understood" }, right: { literal: true } },
        source_ids: ["source:primary"],
        on_false: { native_state: "business_not_explainable", common_stance: "out_of_scope" },
        on_uncomputable: { native_state: "business_evidence_missing", common_stance: "out_of_scope" },
      }],
    },
    hard_vetoes: [{
      veto_id: "leverage.ruin",
      condition: { op: "gt", left: { fact_id: "finance.debt_ratio" }, right: { literal: 2 } },
      source_ids: ["source:primary"],
      on_trigger: { native_state: "leverage_reject", common_stance: "opposed" },
      on_uncomputable: {
        action: "abstain",
        decision: { native_state: "leverage_unknown", common_stance: "out_of_scope" },
      },
    }],
    scoring: {
      max_score: 5,
      min_coverage: 1,
      on_insufficient_coverage: { native_state: "insufficient_evidence", common_stance: "out_of_scope" },
      rules: [
        {
          rule_id: "cash.threshold",
          condition: { op: "gte", left: { output_id: "cash.owner_earnings_value" }, right: { literal: 100 } },
          points: 3,
          coverage_weight: 3,
          source_ids: ["source:primary"],
        },
        {
          rule_id: "leverage.controlled",
          condition: { op: "lte", left: { fact_id: "finance.debt_ratio" }, right: { literal: 0.5 } },
          points: 2,
          coverage_weight: 2,
          source_ids: ["source:primary"],
        },
      ],
    },
    score_bands: [
      { min_ratio: 0.6, decision: { native_state: "own_at_price", common_stance: "constructive" } },
      { min_ratio: 0.3, decision: { native_state: "watch_candidate", common_stance: "cautious" } },
      { min_ratio: 0, decision: { native_state: "reject_candidate", common_stance: "opposed" } },
    ],
    native_output_fields: [{ field: "owner_earnings", value: { output_id: "cash.owner_earnings_value" }, on_missing: "fail" }],
  };
  return { policy, tools, pipeline: tools.map((record) => record.id) };
}

function pack({ policy, tools, pipeline, requiredFactTypes = REQUIRED, optionalFactTypes = [] } = artifacts()) {
  return {
    schema_version: 3,
    pack_version: "0.9.0",
    persona_id: "master_fixture",
    source_cutoff: AS_OF,
    admitted_label: { en: "Neutral Method", zh: "中性方法" },
    corpus_hash: sha256([]),
    tool_graph_hash: sha256(tools),
    policy_hash: sha256(policy),
    pack_hash: sha256({ policy, tools }),
    manifest: {
      identity: {
        persona_id: "master_fixture",
        public_label: { en: "Named Method", zh: "具名方法" },
        operator_label: { en: "Neutral Operator Lens", zh: "中性操作视角" },
      },
      capability: { required_fact_types: requiredFactTypes, optional_fact_types: optionalFactTypes, native_decision_schema: "owner_method_native_v1" },
      computation: { dsl_version: "1.1", pipeline },
      decision: {
        eligibility: requiredFactTypes.length ? requiredFactTypes : optionalFactTypes,
        hard_vetoes: ["leverage.ruin"],
        native_output: "owner_method_native_v1",
        common_projection: "master_projection_v1",
        abstention_policy: "fail_closed",
        confidence_calibrator: null,
      },
    },
    components: { doctrine: [], decision_policy: policy, tools },
    voice: { en: "Explain only after freeze.", zh: "仅在冻结后解释。" },
  };
}

function preDecision({ packValue = pack(), factPack = facts() } = {}) {
  return buildAnonymousPreDecision({ compiledPack: packValue, factPack, privateEvidence: [] });
}

test("executes the pure tool DAG, eligibility, veto, score, stance, and native projection", () => {
  const execution = executeDeterministicPersonaPolicy(preDecision());
  const result = execution.frozen_decision.structured_decision.result;
  assert.equal(execution.executor, "persona_v3_deterministic_dsl_v1_1");
  assert.equal(execution.decision_layer_called, true);
  assert.equal(result.computations.outputs["cash.pre_maintenance"], 130);
  assert.equal(result.computations.outputs["cash.owner_earnings_value"], 110);
  assert.equal(result.native_decision.metrics.owner_earnings, 110);
  assert.equal(result.native_decision.state, "own_at_price");
  assert.equal("stance" in result.native_decision, false);
  assert.equal(result.eligibility.eligible, true);
  assert.equal(result.vetoes_triggered.length, 0);
  assert.equal(result.score.score, 5);
  assert.equal(result.score.coverage, 1);
  assert.equal(result.ratio, 1);
  assert.equal(result.stance, "constructive");
  assert.equal(result.common_projection.confidence, "high");
  assert.equal(assertFrozenDecisionIntegrity(execution.frozen_decision), true);
});

test("executes an explicitly provisional proxy without treating it as a reviewed formula", () => {
  const value = artifacts();
  value.tools[0] = provisionalTool({
    id: "cash.addback",
    operation: "add",
    inputs: [{ fact_id: "finance.net_income" }, { fact_id: "finance.da" }],
    output_id: "cash.pre_maintenance",
  });
  const errors = validateDeterministicPolicyArtifacts({
    policy: value.policy,
    tools: value.tools,
    requiredFactTypes: REQUIRED,
    optionalFactTypes: [],
    pipeline: value.pipeline,
    dslVersion: "1.1",
    nativeDecisionSchema: "owner_method_native_v1",
  });
  assert.deepEqual(errors, []);
  const execution = executeDeterministicPersonaPolicy(preDecision({ packValue: pack(value) }));
  assert.equal(execution.frozen_decision.structured_decision.result.computations.outputs["cash.pre_maintenance"], 130);
  assert.equal("formula_spec_id" in value.tools[0], false);
  assert.equal("approval_bundle_hash" in value.tools[0], false);

  value.tools[0].production_eligible = true;
  Object.assign(value.tools[0], deterministicToolSchemaHashes(value.tools[0]));
  assert.match(validateDeterministicPolicyArtifacts({
    policy: value.policy,
    tools: value.tools,
    requiredFactTypes: REQUIRED,
    optionalFactTypes: [],
    pipeline: value.pipeline,
    dslVersion: "1.1",
    nativeDecisionSchema: "owner_method_native_v1",
  }).join("\n"), /production_eligible.*must be false/u);
});

test("identical frozen inputs produce identical execution and freeze hashes", () => {
  const before = preDecision();
  const first = executeDeterministicPersonaPolicy(before);
  const second = executeDeterministicPersonaPolicy(before);
  assert.equal(first.policy_execution_hash, second.policy_execution_hash);
  assert.equal(first.frozen_decision.structured_decision_hash, second.frozen_decision.structured_decision_hash);
  assert.equal(first.frozen_decision.frozen_decision_hash, second.frozen_decision.frozen_decision_hash);
  assert.throws(() => {
    first.frozen_decision.structured_decision.result.stance = "opposed";
  }, TypeError);
});

test("an eligibility miss deterministically abstains before scoring", () => {
  const execution = executeDeterministicPersonaPolicy(preDecision({ factPack: facts({ "business.understood": false }) }));
  const result = execution.frozen_decision.structured_decision.result;
  assert.equal(result.stance, "out_of_scope");
  assert.equal(result.reason, "eligibility");
  assert.equal(result.native_decision.state, "business_not_explainable");
  assert.deepEqual(result.eligibility.unmet_condition_ids, ["business.explainable"]);
  assert.equal(result.score, null);
});

test("a hard veto overrides a perfect score", () => {
  const execution = executeDeterministicPersonaPolicy(preDecision({ factPack: facts({ "finance.debt_ratio": 3 }) }));
  const result = execution.frozen_decision.structured_decision.result;
  assert.equal(result.reason, "veto");
  assert.equal(result.stance, "opposed");
  assert.equal(result.native_decision.state, "leverage_reject");
  assert.deepEqual(result.vetoes_triggered.map((veto) => veto.veto_id), ["leverage.ruin"]);
});

test("an uncomputable hard veto follows its explicit fail-closed state with zero confidence", () => {
  const value = artifacts();
  const required = REQUIRED.filter((id) => id !== "finance.debt_ratio");
  const factPack = buildFactPack([
    typedFact("finance.net_income", 100),
    typedFact("finance.da", 30),
    typedFact("finance.maintenance_capex", 20),
    typedFact("business.understood", true),
  ], { asOf: AS_OF });
  const execution = executeDeterministicPersonaPolicy(preDecision({
    packValue: pack({ ...value, requiredFactTypes: required, optionalFactTypes: ["finance.debt_ratio"] }),
    factPack,
  }));
  const result = execution.frozen_decision.structured_decision.result;
  assert.equal(result.reason, "veto_uncomputable");
  assert.equal(result.stance, "out_of_scope");
  assert.equal(result.native_decision.state, "leverage_unknown");
  assert.equal(result.narratable, false);
  assert.equal(result.vetoes_evaluated[0].computable, false);
  assert.equal(result.vetoes_evaluated[0].resolution, "uncomputable_abstain");
  assert.equal(result.vetoes_evaluated[0].on_uncomputable_action, "abstain");
  assert.equal(result.common_projection.confidence, "low");
  assert.equal(result.common_projection.confidence_score, 0);
});

test("a tool configured to fail never skips a missing optional input", () => {
  const value = artifacts();
  const factPack = buildFactPack([], { asOf: AS_OF });
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({
      packValue: pack({ ...value, requiredFactTypes: [], optionalFactTypes: REQUIRED }),
      factPack,
    })),
    (error) => error instanceof PersonaV3PolicyError && error.code === "MISSING_TOOL_INPUT",
  );
});

test("Taleb-style 1-of-4 optional coverage is 25% and fails a 50% grounding floor", () => {
  const optional = ["options.skew", "options.realized_vol", "options.friction", "options.event_expiry"];
  const tools = optional.map((factId, index) => tool({
    id: `tail.compute_${index + 1}`,
    operation: "identity",
    on_missing: "skip",
    inputs: [{ fact_id: factId }],
    output_id: `tail.metric_${index + 1}`,
  }));
  const policy = {
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: "owner_method_native_v1",
    native_states: ["critical_tail_missing", "insufficient_tail_grounding", "tail_edge", "tail_no_edge"],
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "critical_tail_missing", common_stance: "out_of_scope" },
    },
    eligibility: { all: [] },
    hard_vetoes: [],
    scoring: {
      max_score: 4,
      min_coverage: 0.5,
      on_insufficient_coverage: { native_state: "insufficient_tail_grounding", common_stance: "out_of_scope" },
      rules: optional.map((_factId, index) => ({
        rule_id: `tail.rule_${index + 1}`,
        condition: { op: "gte", left: { output_id: `tail.metric_${index + 1}` }, right: { literal: 0 } },
        points: 1,
        coverage_weight: 1,
        source_ids: ["source:primary"],
      })),
    },
    score_bands: [
      { min_ratio: 0.5, decision: { native_state: "tail_edge", common_stance: "constructive" } },
      { min_ratio: 0, decision: { native_state: "tail_no_edge", common_stance: "opposed" } },
    ],
    native_output_fields: optional.map((_factId, index) => ({
      field: `metric_${index + 1}`,
      value: { output_id: `tail.metric_${index + 1}` },
      on_missing: "omit",
    })),
  };
  const packValue = pack({
    policy,
    tools,
    pipeline: tools.map((record) => record.id),
    requiredFactTypes: [],
    optionalFactTypes: optional,
  });
  const factPack = buildFactPack([typedFact("options.skew", 0.33)], { asOf: AS_OF });
  const before = preDecision({ packValue, factPack });
  assert.equal(before.eligibility.status, "ready", "optional facts must not trip the critical fact gate");
  assert.equal(before.eligibility.optional_coverage.ratio, 0.25);
  const execution = executeDeterministicPersonaPolicy(before);
  const result = execution.frozen_decision.structured_decision.result;
  assert.equal(result.reason, "insufficient_grounding");
  assert.equal(result.stance, "out_of_scope");
  assert.equal(result.native_decision.state, "insufficient_tail_grounding");
  assert.equal(result.score.status, "insufficient_coverage");
  assert.equal(result.score.coverage, 0.25);
  assert.equal(result.score.score, null);
  assert.equal(result.ratio, null);
  assert.equal(result.narratable, false);
  assert.equal(result.common_projection.confidence, "low");
  assert.equal(result.common_projection.confidence_score, 0.225);
  assert.deepEqual(result.score.uncomputable.map((rule) => rule.rule_id), ["tail.rule_2", "tail.rule_3", "tail.rule_4"]);
  assert.deepEqual(result.computations.trace.map((entry) => entry.status), [
    "computed", "skipped_missing_optional", "skipped_missing_optional", "skipped_missing_optional",
  ]);
});

test("policy references must be declared required typed facts", () => {
  const value = artifacts();
  value.policy.scoring.rules[0].condition.left = { fact_id: "finance.secret_metric" };
  const errors = validateDeterministicPolicyArtifacts({
    policy: value.policy,
    tools: value.tools,
    requiredFactTypes: REQUIRED,
    optionalFactTypes: [],
    pipeline: value.pipeline,
    dslVersion: "1.1",
    nativeDecisionSchema: "owner_method_native_v1",
  });
  assert.ok(errors.some((error) => /undeclared fact "finance.secret_metric"/.test(error)));
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ packValue: pack(value) })),
    (error) => error instanceof PersonaV3PolicyError && error.code === "INVALID_POLICY_ARTIFACT",
  );
});

test("required and optional fact declarations must be disjoint and non-empty in union", () => {
  const value = artifacts();
  const overlapping = validateDeterministicPolicyArtifacts({
    policy: value.policy,
    tools: value.tools,
    requiredFactTypes: REQUIRED,
    optionalFactTypes: [REQUIRED[0]],
    pipeline: value.pipeline,
    dslVersion: "1.1",
    nativeDecisionSchema: "owner_method_native_v1",
  });
  assert.ok(overlapping.some((error) => /overlap/.test(error)));
  const empty = validateDeterministicPolicyArtifacts({
    policy: value.policy,
    tools: value.tools,
    requiredFactTypes: [],
    optionalFactTypes: [],
    pipeline: value.pipeline,
    dslVersion: "1.1",
    nativeDecisionSchema: "owner_method_native_v1",
  });
  assert.ok(empty.some((error) => /cannot both be empty/.test(error)));
});

test("unknown condition and tool operations fail closed", () => {
  const badCondition = artifacts();
  badCondition.policy.scoring.rules[0].condition.op = "approximately";
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ packValue: pack(badCondition) })),
    (error) => error.code === "INVALID_POLICY_ARTIFACT" && /unknown operation/.test(error.message),
  );

  const badTool = artifacts();
  badTool.tools[0].operation = "execute_javascript";
  Object.assign(badTool.tools[0], deterministicToolSchemaHashes(badTool.tools[0]));
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ packValue: pack(badTool) })),
    (error) => error.code === "INVALID_POLICY_ARTIFACT" && /unknown operation/.test(error.message),
  );
});

test("division by zero blocks execution instead of inventing a score", () => {
  const value = artifacts();
  value.tools[0] = tool({
    id: "cash.addback",
    operation: "divide",
    inputs: [{ fact_id: "finance.net_income" }, { literal: 0 }],
    output_id: "cash.pre_maintenance",
  });
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ packValue: pack(value) })),
    (error) => error.code === "DIVISION_BY_ZERO",
  );
});

test("forward output references and cycles are rejected before execution", () => {
  const value = artifacts();
  value.tools[0] = tool({
    id: "cash.addback",
    operation: "identity",
    inputs: [{ output_id: "cash.owner_earnings_value" }],
    output_id: "cash.pre_maintenance",
  });
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ packValue: pack(value) })),
    (error) => error.code === "INVALID_POLICY_ARTIFACT" && /forward reference or cycle/.test(error.message),
  );
});

test("tool input/output schema-hash tampering is rejected", () => {
  const value = artifacts();
  value.tools[0].input_schema_hash = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ packValue: pack(value) })),
    (error) => error.code === "INVALID_POLICY_ARTIFACT" && /does not match executable input contract/.test(error.message),
  );
});

test("typed facts must match the hash-bound input unit and period contract", () => {
  const unitMismatch = artifacts();
  unitMismatch.tools[0].input_contracts[0].unit = "currency_units";
  Object.assign(unitMismatch.tools[0], deterministicToolSchemaHashes(unitMismatch.tools[0]));
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ packValue: pack(unitMismatch) })),
    (error) => error.code === "INPUT_CONTRACT_MISMATCH" && /unit/u.test(error.message),
  );

  const periodMismatch = artifacts();
  periodMismatch.tools[0].input_contracts[0].period = { basis: "duration", window: "P3M", alignment: "exact" };
  Object.assign(periodMismatch.tools[0], deterministicToolSchemaHashes(periodMismatch.tools[0]));
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ packValue: pack(periodMismatch) })),
    (error) => error.code === "INPUT_CONTRACT_MISMATCH" && /period/u.test(error.message),
  );
});

test("downstream output references must declare the producer's exact output contract", () => {
  const value = artifacts();
  value.tools[1].input_contracts[0].unit = "different_units";
  Object.assign(value.tools[1], deterministicToolSchemaHashes(value.tools[1]));
  const errors = validateDeterministicPolicyArtifacts({
    policy: value.policy,
    tools: value.tools,
    requiredFactTypes: REQUIRED,
    optionalFactTypes: [],
    pipeline: value.pipeline,
    dslVersion: "1.1",
    nativeDecisionSchema: "owner_method_native_v1",
  });
  assert.match(errors.join("\n"), /does not match producer/u);
});

test("unknown policy fields are rejected rather than ignored", () => {
  const value = artifacts();
  value.policy.model_override = "buy";
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ packValue: pack(value) })),
    (error) => error.code === "INVALID_POLICY_ARTIFACT" && /unknown field "model_override"/.test(error.message),
  );
});

test("numeric operations reject text facts", () => {
  const invalidFacts = facts();
  const copy = JSON.parse(JSON.stringify(invalidFacts));
  const netIncome = copy.facts.find((fact) => fact.fact_id === "finance.net_income");
  netIncome.value_kind = "text";
  netIncome.value = "one hundred";
  netIncome.unit = null;
  delete copy.fact_pack_hash;
  const rebuilt = buildFactPack(copy.facts, { asOf: AS_OF });
  assert.throws(
    () => executeDeterministicPersonaPolicy(preDecision({ factPack: rebuilt })),
    (error) => error.code === "INPUT_CONTRACT_MISMATCH",
  );
});
