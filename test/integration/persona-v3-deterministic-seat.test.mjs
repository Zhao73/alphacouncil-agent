import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compilePersonaPack } from "../../mcp/lib/personas-v3/compiler.mjs";
import { loadV3Pack } from "../../mcp/lib/personas-v3/loader.mjs";
import { buildFactPack } from "../../mcp/lib/personas-v3/typed-facts.mjs";
import { completedMasterOpinion, planMasterSeats } from "../../mcp/lib/personas/engine.mjs";
import { withTestFormulaApprovalBinding } from "../helpers/persona-v3-deterministic-tool.mjs";

const AS_OF = "2026-07-27";
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, values) {
  writeFileSync(file, values.length ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "");
}

function physicalPack(t) {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-v3-executor-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "master_test");
  mkdirSync(join(dir, "eval"), { recursive: true });
  const source = {
    schema_version: 1,
    source_id: "primary:method:1",
    source_kind: "primary_text",
    grade: "A",
    author: "Method author",
    title: "Primary method rule",
    url: "https://example.test/method",
    published_at: "2026-01-01",
    public_at: "2026-01-01",
    known_at: "2026-01-01",
    retrieved_at: AS_OF,
    locator: { section: "Rule" },
    summary: "A primary source anchors the threshold and recomputation.",
    content_hash: ZERO_HASH,
    adjudication: { status: "approved", reviewer_ids: ["reviewer-a", "reviewer-b"], reviewed_at: AS_OF },
  };
  const tool = {
    schema_version: 1,
    dsl_version: "1.1",
    id: "quality.double",
    version: "1.0.0",
    kind: "recomputation",
    operation: "multiply",
    on_missing: "fail",
    inputs: [{ fact_id: "quality.base" }, { literal: 2 }],
    input_contracts: [
      { value_kind: "scalar", unit: "points", period: { basis: "instant", window: null, alignment: "as_of" }, on_missing: "fail" },
      { value_kind: "scalar", unit: "multiplier", period: { basis: "not_applicable", window: null, alignment: "not_applicable" }, on_missing: "fail" },
    ],
    output_id: "quality.adjusted",
    value_kind: "scalar",
    unit: "points",
    output_period: { basis: "instant", window: null, alignment: "as_of" },
    source_ids: [source.source_id],
  };
  Object.assign(tool, withTestFormulaApprovalBinding(tool));
  const policy = {
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: "quality_native_v1",
    native_states: [
      "critical_quality_missing", "quality_veto", "quality_veto_unknown",
      "insufficient_quality", "quality_candidate", "quality_reject",
    ],
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "critical_quality_missing", common_stance: "out_of_scope" },
    },
    eligibility: { all: [] },
    hard_vetoes: [{
      veto_id: "quality.negative",
      condition: { op: "lt", left: { fact_id: "quality.base" }, right: { literal: 0 } },
      source_ids: [source.source_id],
      on_trigger: { native_state: "quality_veto", common_stance: "opposed" },
      on_uncomputable: {
        action: "abstain",
        decision: { native_state: "quality_veto_unknown", common_stance: "out_of_scope" },
      },
    }],
    scoring: {
      max_score: 1,
      min_coverage: 1,
      on_insufficient_coverage: { native_state: "insufficient_quality", common_stance: "out_of_scope" },
      rules: [{
        rule_id: "quality.hurdle",
        condition: { op: "gte", left: { output_id: "quality.adjusted" }, right: { literal: 10 } },
        points: 1,
        coverage_weight: 1,
        source_ids: [source.source_id],
      }],
    },
    score_bands: [
      { min_ratio: 1, decision: { native_state: "quality_candidate", common_stance: "constructive" } },
      { min_ratio: 0, decision: { native_state: "quality_reject", common_stance: "opposed" } },
    ],
    native_output_fields: [{ field: "adjusted_quality", value: { output_id: "quality.adjusted" }, on_missing: "fail" }],
  };

  writeJsonl(join(dir, "sources.jsonl"), [source]);
  writeJsonl(join(dir, "doctrine.jsonl"), [{
    rule_id: "quality.rule",
    claim: "Use the frozen quality hurdle.",
    source_ids: [source.source_id],
  }]);
  for (const name of ["decision_cases", "failures", "counterfactuals"]) writeJsonl(join(dir, `${name}.jsonl`), []);
  for (const name of ["golden_cases", "pairwise_cases", "calibration_cases"]) writeJsonl(join(dir, `eval/${name}.jsonl`), []);
  writeJson(join(dir, "research_policy.json"), {
    private_research_paths: ["primary filings"],
    mandatory_disconfirming_queries: ["quality thesis failure"],
  });
  writeJson(join(dir, "decision_policy.json"), policy);
  writeJson(join(dir, "tools.json"), [tool]);
  writeJson(join(dir, "memory_policy.json"), {
    leak_rule: "public_at <= as_of AND memory_created_at <= as_of",
  });
  writeJson(join(dir, "eval/experiments.json"), { schema_version: 1, persona_id: "master_test", experiments: {} });
  writeFileSync(join(dir, "voice.en.md"), "Explain the frozen result.\n");
  writeFileSync(join(dir, "voice.zh.md"), "解释冻结结果。\n");
  writeJson(join(dir, "manifest.json"), {
    schema_version: 3,
    pack_version: "0.9.0",
    identity: {
      persona_id: "master_test",
      public_label: { en: "Test Method Model", zh: "测试方法模型" },
      operator_label: { en: "Test Operator Lens", zh: "测试操作视角" },
      maturity: "method_model",
      source_cutoff: AS_OF,
    },
    selection: {
      identity: { en: "Physical test method", zh: "物理测试方法" },
      method: { en: "Recomputes a quality metric", zh: "重算质量指标" },
      best_for: { en: "Executor integration", zh: "执行器集成" },
    },
    capability: {
      domains: ["public_equity"],
      exclusions: [],
      required_fact_types: ["quality.base"],
      optional_fact_types: [],
      native_decision_schema: "quality_native_v1",
    },
    research: {
      planner: "test_planner_v1",
      private_budget: { queries: 1, fetches: 1 },
      mandatory_disconfirming_queries: ["quality thesis failure"],
      source_policy: "primary_first_v1",
    },
    computation: { dsl_version: "1.1", pipeline: [tool.id] },
    decision: {
      eligibility: ["quality.base"],
      hard_vetoes: ["quality.negative"],
      native_output: "quality_native_v1",
      common_projection: "master_projection_v1",
      abstention_policy: "fail_closed",
      confidence_calibrator: null,
    },
    memory: {
      episodic: true,
      belief_updates: "evidence_required",
      postmortem_horizon_days: 30,
      leak_rule: "public_at <= as_of AND memory_created_at <= as_of",
    },
    voice: { load_after_decision_freeze: true, en: "voice.en.md", zh: "voice.zh.md" },
    evaluation: { required_ablations: ["name", "voice", "policy", "evidence", "memory", "model"] },
    components: {
      sources: "sources.jsonl",
      doctrine: "doctrine.jsonl",
      decision_cases: "decision_cases.jsonl",
      failures: "failures.jsonl",
      counterfactuals: "counterfactuals.jsonl",
      research_policy: "research_policy.json",
      decision_policy: "decision_policy.json",
      tools: "tools.json",
      memory_policy: "memory_policy.json",
      golden_cases: "eval/golden_cases.jsonl",
      pairwise_cases: "eval/pairwise_cases.jsonl",
      calibration_cases: "eval/calibration_cases.jsonl",
      experiments: "eval/experiments.json"
    },
  });
  return dir;
}

test("physical pack -> loader -> compiler -> typed facts -> engine -> frozen deterministic opinion", (t) => {
  const compiled = compilePersonaPack(loadV3Pack(physicalPack(t)));
  const typed = buildFactPack([{
    schema_version: 1,
    fact_id: "quality.base",
    value_kind: "scalar",
    value: 6,
    unit: "points",
    currency: null,
    scale: null,
    period_start: null,
    period_end: null,
    fiscal_year: null,
    as_of: AS_OF,
    public_at: AS_OF,
    source_ids: ["filing:S1"],
    derivation: "reported",
    confidence: 0.95,
    restatement_policy: "frozen snapshot",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  }], { asOf: AS_OF });
  let legacyCalls = 0;
  const run = { symbol: "TEST", as_of: AS_OF, language: "en", grounding: { typed_fact_pack: typed } };
  const plan = planMasterSeats(run, ["master_test"], {
    v3Registry: { get: (id) => id === "master_test" ? compiled : undefined },
    legacyPlanner: () => { legacyCalls += 1; throw new Error("legacy path must not run"); },
  });
  assert.equal(legacyCalls, 0);
  assert.equal(plan.to_run.length, 0);
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.completed.length, 1);
  assert.equal(plan.completed[0].decision.stance, "constructive");
  assert.equal(plan.completed[0].decision.native_decision.metrics.adjusted_quality, 12);

  const opinion = completedMasterOpinion(run, plan.completed[0]);
  assert.equal(opinion.stance, "constructive");
  assert.equal(opinion.engine, "v3_method_runtime");
  assert.match(opinion.policy_execution_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(opinion.structured_decision_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(opinion.frozen_decision_hash, /^sha256:[a-f0-9]{64}$/);
});
