import { test } from "node:test";
import assert from "node:assert/strict";

import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { buildFactPack } from "../../mcp/lib/personas-v3/typed-facts.mjs";
import { completedMasterOpinion, declinedMasterOpinion, planMasterSeats, reconcileMasterOpinion } from "../../mcp/lib/personas/engine.mjs";
import { withTestFormulaApprovalBinding } from "../helpers/persona-v3-deterministic-tool.mjs";

const AS_OF = "2026-07-27";
const HASH = sha256("fixture");

function pack(required = ["options.skew"], optional = []) {
  const inputFact = required[0] || optional[0];
  const inputValueKind = inputFact === "options.skew_25d" ? "ratio" : "scalar";
  const inputUnit = inputFact === "options.skew_25d" ? "decimal_volatility_difference" : "vol_points";
  const tool = {
    schema_version: 1,
    dsl_version: "1.1",
    id: "tail_tool",
    version: "1.0.0",
    kind: "recomputation",
    operation: "identity",
    on_missing: "fail",
    inputs: [{ fact_id: inputFact }],
    input_contracts: [{ value_kind: inputValueKind, unit: inputUnit, period: { basis: "instant", window: null, alignment: "as_of" }, on_missing: "fail" }],
    output_id: "tail.metric",
    value_kind: inputValueKind,
    unit: inputUnit,
    output_period: { basis: "instant", window: null, alignment: "as_of" },
    source_ids: ["source:tail"],
  };
  Object.assign(tool, withTestFormulaApprovalBinding(tool));
  const decisionPolicy = {
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: "tail_v1",
    native_states: [
      "critical_tail_data_missing", "tail_veto", "tail_veto_unknown",
      "insufficient_tail_data", "tail_attractive", "tail_unattractive",
    ],
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "critical_tail_data_missing", common_stance: "out_of_scope" },
    },
    eligibility: { all: [] },
    hard_vetoes: [{
      veto_id: "tail.negative",
      condition: { op: "lt", left: { output_id: "tail.metric" }, right: { literal: 0 } },
      source_ids: ["source:tail"],
      on_trigger: { native_state: "tail_veto", common_stance: "opposed" },
      on_uncomputable: {
        action: "abstain",
        decision: { native_state: "tail_veto_unknown", common_stance: "out_of_scope" },
      },
    }],
    scoring: {
      max_score: 1,
      min_coverage: 1,
      on_insufficient_coverage: { native_state: "insufficient_tail_data", common_stance: "out_of_scope" },
      rules: [{
        rule_id: "tail.positive",
        condition: { op: "gte", left: { output_id: "tail.metric" }, right: { literal: 0.3 } },
        points: 1,
        coverage_weight: 1,
        source_ids: ["source:tail"],
      }],
    },
    score_bands: [
      { min_ratio: 1, decision: { native_state: "tail_attractive", common_stance: "constructive" } },
      { min_ratio: 0, decision: { native_state: "tail_unattractive", common_stance: "cautious" } },
    ],
    native_output_fields: [{ field: "tail_metric", value: { output_id: "tail.metric" }, on_missing: "fail" }],
  };
  return {
    schema_version: 3,
    pack_version: "0.1.0",
    persona_id: "master_taleb",
    source_cutoff: AS_OF,
    maturity: "operator_lens",
    admitted_label: { en: "Tail-risk Operator Lens", zh: "尾部风险操作视角" },
    corpus_hash: HASH,
    tool_graph_hash: HASH,
    policy_hash: HASH,
    pack_hash: HASH,
    manifest: {
      identity: { persona_id: "master_taleb", public_label: { en: "Named Method", zh: "具名方法" }, operator_label: { en: "Tail-risk Operator Lens", zh: "尾部风险操作视角" } },
      capability: { required_fact_types: required, optional_fact_types: optional, native_decision_schema: "tail_v1" },
      computation: { dsl_version: "1.1", pipeline: ["tail_tool"] },
      decision: { eligibility: required, hard_vetoes: [], native_output: "tail_v1", common_projection: "tail_projection_v1", abstention_policy: "fail_closed", confidence_calibrator: null },
    },
    components: { doctrine: [], decision_policy: decisionPolicy, tools: [tool] },
    voice: { en: "tail voice", zh: "尾部口吻" },
  };
}

function registry(value = pack()) {
  return { get: (id) => id === "master_taleb" ? value : undefined };
}

function talebCoveragePack() {
  const optional = ["options.skew", "options.realized_vol", "options.friction", "options.event_expiry"];
  const tools = optional.map((factId, index) => {
    const record = {
      schema_version: 1,
      dsl_version: "1.1",
      id: `tail_tool_${index + 1}`,
      version: "1.0.0",
      kind: "recomputation",
      operation: "identity",
      on_missing: "skip",
      inputs: [{ fact_id: factId }],
      input_contracts: [{ value_kind: "scalar", unit: "vol_points", period: { basis: "instant", window: null, alignment: "as_of" }, on_missing: "skip" }],
      output_id: `tail.metric_${index + 1}`,
      value_kind: "scalar",
      unit: "vol_points",
      output_period: { basis: "instant", window: null, alignment: "as_of" },
      source_ids: ["source:tail"],
    };
    return withTestFormulaApprovalBinding(record);
  });
  const value = pack([], optional);
  value.manifest.computation.pipeline = tools.map((tool) => tool.id);
  value.components.tools = tools;
  value.components.decision_policy = {
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: "tail_v1",
    native_states: ["critical_tail_data_missing", "insufficient_tail_data", "tail_edge", "tail_no_edge"],
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "critical_tail_data_missing", common_stance: "out_of_scope" },
    },
    eligibility: { all: [] },
    hard_vetoes: [],
    scoring: {
      max_score: 4,
      min_coverage: 0.5,
      on_insufficient_coverage: { native_state: "insufficient_tail_data", common_stance: "out_of_scope" },
      rules: optional.map((_factId, index) => ({
        rule_id: `tail.rule_${index + 1}`,
        condition: { op: "gte", left: { output_id: `tail.metric_${index + 1}` }, right: { literal: 0 } },
        points: 1,
        coverage_weight: 1,
        source_ids: ["source:tail"],
      })),
    },
    score_bands: [
      { min_ratio: 0.5, decision: { native_state: "tail_edge", common_stance: "constructive" } },
      { min_ratio: 0, decision: { native_state: "tail_no_edge", common_stance: "opposed" } },
    ],
    native_output_fields: [],
  };
  return value;
}

test("a physical v3 seat with no typed facts declines and never reaches legacy planning", () => {
  let legacyCalls = 0;
  const run = { symbol: "NOK", as_of: AS_OF, grounding: {} };
  const plan = planMasterSeats(run, ["master_taleb"], {
    v3Registry: registry(),
    legacyPlanner: () => { legacyCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(legacyCalls, 0);
  assert.deepEqual(plan.v3_ids, ["master_taleb"]);
  assert.deepEqual(plan.legacy_ids, []);
  assert.equal(plan.to_run.length, 0);
  assert.equal(plan.declined.length, 1);
  assert.equal(plan.declined[0].reason, "out_of_scope");
  const opinion = declinedMasterOpinion(run, plan.declined[0]);
  assert.equal(opinion.engine, "v3_method_runtime");
  assert.equal(opinion.confidence, "low");
  assert.match(opinion.summary, /No legacy prompt/);
  const chinese = declinedMasterOpinion({ ...run, language: "中文" }, plan.declined[0]);
  assert.match(chinese.verdict, /尾部风险操作视角无法评估/);
  assert.match(chinese.summary, /未调用旧提示词或叙述决策层/);
  const japanese = declinedMasterOpinion({ ...run, language: "日本語" }, plan.declined[0]);
  assert.match(japanese.verdict, /評価できません/);
  assert.match(japanese.summary, /叙述型の判断層は呼び出していません/);
  const korean = declinedMasterOpinion({ ...run, language: "한국어" }, plan.declined[0]);
  assert.match(korean.verdict, /평가할 수 없습니다/);
  assert.match(korean.summary, /서술형 판단 계층은 호출하지 않았습니다/);
});

test("an ETF deterministic decline explains look-through instead of sounding bearish", () => {
  const run = {
    symbol: "QQQ",
    as_of: AS_OF,
    language: "中文",
    grounding: {
      instrument: {
        asset_type: "etf",
        research_model: "fund_lookthrough",
        fund_like: true,
      },
    },
  };
  const plan = planMasterSeats(run, ["master_taleb"], { v3Registry: registry() });
  const opinion = declinedMasterOpinion(run, plan.declined[0]);
  assert.match(opinion.voice_statement, /QQQ 已识别为 etf/);
  assert.match(opinion.voice_statement, /持仓穿透或指数聚合证据/);
  assert.match(opinion.voice_statement, /这不是看空，也不是一张反对票/);
});

test("a ready v3 seat executes the deterministic DSL without entering the legacy planner", () => {
  const facts = buildFactPack([{
    schema_version: 1, fact_id: "options.skew", value_kind: "scalar", value: 0.33,
    unit: "vol_points", currency: null, scale: null, period_start: null, period_end: null,
    fiscal_year: null, as_of: AS_OF, public_at: AS_OF, source_ids: ["options:S1"],
    derivation: "reported", confidence: 1, restatement_policy: "snapshot",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  }], { asOf: AS_OF });
  const plan = planMasterSeats(
    { symbol: "NOK", as_of: AS_OF, grounding: { typed_fact_pack: facts } },
    ["master_taleb"],
    { v3Registry: registry(), legacyPlanner: () => { throw new Error("must not run"); } },
  );
  assert.equal(plan.to_run.length, 0);
  assert.equal(plan.declined.length, 0);
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.completed.length, 1);
  assert.equal(plan.completed[0].decision.stance, "constructive");
  assert.equal(plan.completed[0].decision.native_decision.state, "tail_attractive");
  assert.equal(plan.completed[0].decision.dsl_version, "1.1");
  assert.equal(plan.completed[0].decision.native_state, "tail_attractive");
  assert.equal(plan.completed[0].decision.native_decision.metrics.tail_metric, 0.33);
  const opinion = completedMasterOpinion({ symbol: "NOK", as_of: AS_OF, language: "en" }, plan.completed[0]);
  assert.equal(opinion.stance, "constructive");
  assert.equal(opinion.engine, "v3_method_runtime");
  assert.match(opinion.policy_execution_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(opinion.frozen_decision_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(opinion.summary, /no language model selected/i);
  const chinese = completedMasterOpinion({ symbol: "NOK", as_of: AS_OF, language: "Chinese" }, plan.completed[0]);
  assert.match(chinese.summary, /没有让语言模型选择立场/);
  const japanese = completedMasterOpinion({ symbol: "NOK", as_of: AS_OF, language: "日本語" }, plan.completed[0]);
  assert.match(japanese.summary, /言語モデルは立場を選択していない/);
  const korean = completedMasterOpinion({ symbol: "NOK", as_of: AS_OF, language: "한국어" }, plan.completed[0]);
  assert.match(korean.summary, /언어 모델은 입장을 선택하지 않았습니다/);
});

test("Taleb-style 1-of-4 optional coverage completes out_of_scope without narrative or legacy fallback", () => {
  const oneFact = buildFactPack([{
    schema_version: 1, fact_id: "options.skew", value_kind: "scalar", value: 0.33,
    unit: "vol_points", currency: null, scale: null, period_start: null, period_end: null,
    fiscal_year: null, as_of: AS_OF, public_at: AS_OF, source_ids: ["options:S1"],
    derivation: "reported", confidence: 1, restatement_policy: "snapshot",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  }], { asOf: AS_OF });
  let legacyCalls = 0;
  const run = { symbol: "NOK", as_of: AS_OF, language: "en", grounding: { typed_fact_pack: oneFact } };
  const plan = planMasterSeats(run, ["master_taleb"], {
    v3Registry: registry(talebCoveragePack()),
    legacyPlanner: () => { legacyCalls += 1; throw new Error("must not run"); },
  });
  assert.equal(legacyCalls, 0);
  assert.equal(plan.to_run.length, 0);
  assert.equal(plan.declined.length, 0);
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.completed.length, 1);
  assert.equal(plan.completed[0].decision.reason, "insufficient_grounding");
  assert.equal(plan.completed[0].decision.stance, "out_of_scope");
  assert.equal(plan.completed[0].decision.score.coverage, 0.25);
  assert.equal(plan.completed[0].decision.score.score, null);
  assert.equal(plan.completed[0].decision.native_decision.state, "insufficient_tail_data");
  assert.equal(plan.completed[0].decision.common_projection.confidence, "low");
  const opinion = completedMasterOpinion(run, plan.completed[0]);
  assert.equal(opinion.stance, "out_of_scope");
  assert.equal(opinion.decision_reason, "insufficient_grounding");
  assert.match(opinion.summary, /no language model selected/i);
});

test("the engine derives the shared typed fact pack from timestamped grounding", () => {
  const plan = planMasterSeats({
    symbol: "NOK",
    as_of: AS_OF,
    grounding: {
      as_of: AS_OF,
      gathered_at: "2026-07-27T12:00:00.000Z",
      options: {
        symbol: "NOK",
        available: true,
        delayed: true,
        source: "CBOE delayed quotes",
        reference_expiry: { expiry: "2026-08-15", atm_iv: 0.45 },
        skew_25delta: { put_minus_call: 0.33 },
      },
    },
  }, ["master_taleb"], {
    v3Registry: registry(pack(["options.skew_25d"])),
    legacyPlanner: () => { throw new Error("must not run"); },
  });
  assert.equal(plan.completed.length, 1);
  assert.equal(plan.completed[0].decision.stance, "constructive");
  assert.match(plan.shared_fact_pack_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(plan.completed[0].decision.fact_pack_hash, plan.shared_fact_pack_hash);
  const opinion = completedMasterOpinion({ symbol: "NOK", as_of: AS_OF, language: "en" }, plan.completed[0]);
  assert.equal(opinion.fact_pack_hash, plan.shared_fact_pack_hash);
});

test("a physical v3 seat with an invalid policy blocks and never falls through", () => {
  const broken = pack();
  broken.components.decision_policy = {
    ...broken.components.decision_policy,
    scoring: { ...broken.components.decision_policy.scoring, min_coverage: 1.5 },
  };
  const facts = buildFactPack([{
    schema_version: 1, fact_id: "options.skew", value_kind: "scalar", value: 0.33,
    unit: "vol_points", currency: null, scale: null, period_start: null, period_end: null,
    fiscal_year: null, as_of: AS_OF, public_at: AS_OF, source_ids: ["options:S1"],
    derivation: "reported", confidence: 1, restatement_policy: "snapshot",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  }], { asOf: AS_OF });
  let legacyCalls = 0;
  const plan = planMasterSeats(
    { symbol: "NOK", as_of: AS_OF, grounding: { typed_fact_pack: facts } },
    ["master_taleb"],
    {
      v3Registry: registry(broken),
      legacyPlanner: () => { legacyCalls += 1; throw new Error("must not run"); },
    },
  );
  assert.equal(legacyCalls, 0);
  assert.equal(plan.completed.length, 0);
  assert.equal(plan.blocked[0].reason, "v3_policy_execution_failed");
  assert.match(plan.blocked[0].error, /min_coverage/);
});

test("only seats without physical v3 packs use the explicitly labelled legacy planner", () => {
  const legacyPlanner = (_run, ids) => ({
    facts: {}, decisions: [], declined: [], to_run: ids.map((id) => ({ id, engine: "v1_prompt" })),
  });
  const plan = planMasterSeats({ symbol: "X", as_of: AS_OF }, ["master_taleb", "master_graham"], {
    v3Registry: registry(), legacyPlanner,
  });
  assert.deepEqual(plan.v3_ids, ["master_taleb"]);
  assert.deepEqual(plan.legacy_ids, ["master_graham"]);
  assert.deepEqual(plan.to_run, [{ id: "master_graham", engine: "v1_prompt" }]);
});

test("a v3 seat cannot be reconciled through the legacy opinion path", () => {
  assert.throws(
    () => reconcileMasterOpinion({}, "master_taleb", { stance: "constructive" }, { v3Registry: registry() }),
    /cannot be recorded through the legacy/,
  );
});
