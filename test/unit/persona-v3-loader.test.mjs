import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { compilePersonaPack } from "../../mcp/lib/personas-v3/compiler.mjs";
import { loadV3Pack } from "../../mcp/lib/personas-v3/loader.mjs";
import { computeExperimentSignature } from "../../mcp/lib/personas-v3/admission.mjs";
import { withTestFormulaApprovalBinding } from "../helpers/persona-v3-deterministic-tool.mjs";

const ZERO_HASH = `sha256:${"0".repeat(64)}`;
const TEST_SIGNER = "ci:loader-test-v1";

function experimentEntry(id) {
  const entry = {
    experiment_id: id,
    status: "passed",
    dataset_hash: ZERO_HASH,
    case_ledger_hash: ZERO_HASH,
    pack_hash: ZERO_HASH,
    policy_hash: ZERO_HASH,
    model_hash: ZERO_HASH,
    prompt_hash: ZERO_HASH,
    runner_hash: ZERO_HASH,
    host_hash: ZERO_HASH,
    thresholds: { minimum: { operator: ">=", value: 0.95, unit: "ratio" } },
    metrics: {
      result: { value: 0.99, unit: "ratio", sample_size: 48, threshold_id: "minimum", passed: true },
    },
    started_at: "2026-07-27T00:00:00.000Z",
    evaluated_at: "2026-07-27T01:00:00.000Z",
    signer_key_id: TEST_SIGNER,
  };
  entry.signature = computeExperimentSignature(entry);
  return entry;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(path, values) {
  writeFileSync(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function makePack(t, {
  unknownDoctrineSource = false,
  futureSource = false,
  futureKnownSource = false,
  escapeSourcePath = false,
  sourcePublicAt = null,
  sourceKnownAt = null,
  sourceCutoff = "2026-07-27",
  packVersion = "0.1.0",
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-v3-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packDir = join(root, "master_test");
  mkdirSync(join(packDir, "eval"), { recursive: true });
  const source = {
    schema_version: 1,
    source_id: "test:primary:1",
    source_kind: "primary_text",
    grade: "A",
    author: "Method author",
    title: "Primary method text",
    url: "https://example.test/primary",
    published_at: futureSource ? "2027-01-01" : "2026-01-01",
    public_at: futureSource ? "2027-01-01" : sourcePublicAt || "2026-01-01",
    known_at: futureSource || futureKnownSource
      ? "2027-01-01" : sourceKnownAt ?? sourcePublicAt ?? "2026-01-01",
    retrieved_at: "2026-07-27",
    locator: { section: "Decision rule" },
    summary: "An exact primary source for one method proposition.",
    content_hash: ZERO_HASH,
    adjudication: { status: "approved", reviewer_ids: ["reviewer-a", "reviewer-b"], reviewed_at: "2026-07-27" },
  };
  const sourcesFile = escapeSourcePath ? join(root, "outside.jsonl") : join(packDir, "sources.jsonl");
  writeJsonl(sourcesFile, [source]);
  writeJsonl(join(packDir, "doctrine.jsonl"), [{
    rule_id: "test.method.01",
    claim: "Reject when the primary condition fails.",
    source_ids: [unknownDoctrineSource ? "missing:source" : source.source_id],
  }]);
  writeJsonl(join(packDir, "decision_cases.jsonl"), [{ case_id: "decision-1", source_ids: [source.source_id] }]);
  writeJsonl(join(packDir, "failures.jsonl"), [{ case_id: "failure-1", source_ids: [source.source_id] }]);
  writeJsonl(join(packDir, "counterfactuals.jsonl"), [{ case_id: "counterfactual-1", expected_direction: "abstain" }]);
  writeJsonl(join(packDir, "eval/golden_cases.jsonl"), [{ case_id: "golden-1" }]);
  writeJsonl(join(packDir, "eval/pairwise_cases.jsonl"), [{ case_id: "pairwise-1", group_id: "test-v-peer" }]);
  writeJsonl(join(packDir, "eval/calibration_cases.jsonl"), [{ case_id: "calibration-1" }]);
  writeJson(join(packDir, "eval/experiments.json"), {
    schema_version: 1,
    persona_id: "master_test",
    experiments: {},
  });
  writeJson(join(packDir, "research_policy.json"), {
    private_research_paths: ["primary filings"],
    mandatory_disconfirming_queries: ["method thesis failure"],
  });
  writeJson(join(packDir, "decision_policy.json"), {
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: "test_native_v1",
    native_states: [
      "critical_missing", "eligibility_not_met", "eligibility_unknown", "vetoed",
      "veto_unknown", "insufficient_evidence", "accepted", "rejected",
    ],
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "critical_missing", common_stance: "out_of_scope" },
    },
    eligibility: {
      all: [{
        condition_id: "test.eligibility",
        condition: { op: "exists", value: { fact_id: "test.fact" } },
        source_ids: [source.source_id],
        on_false: { native_state: "eligibility_not_met", common_stance: "out_of_scope" },
        on_uncomputable: { native_state: "eligibility_unknown", common_stance: "out_of_scope" },
      }],
    },
    hard_vetoes: [{
      veto_id: "veto-1",
      condition: { op: "eq", left: { fact_id: "test.fact" }, right: { literal: false } },
      source_ids: [source.source_id],
      on_trigger: { native_state: "vetoed", common_stance: "opposed" },
      on_uncomputable: {
        action: "abstain",
        decision: { native_state: "veto_unknown", common_stance: "out_of_scope" },
      },
    }],
    scoring: {
      max_score: 1,
      min_coverage: 1,
      on_insufficient_coverage: { native_state: "insufficient_evidence", common_stance: "out_of_scope" },
      rules: [{
        rule_id: "test.score",
        condition: { op: "exists", value: { fact_id: "test.fact" } },
        points: 1,
        coverage_weight: 1,
        source_ids: [source.source_id],
      }],
    },
    score_bands: [
      { min_ratio: 1, decision: { native_state: "accepted", common_stance: "constructive" } },
      { min_ratio: 0, decision: { native_state: "rejected", common_stance: "cautious" } },
    ],
    native_output_fields: [{ field: "test_value", value: { output_id: "test.output" }, on_missing: "fail" }],
  });
  const testTool = {
    schema_version: 1,
    dsl_version: "1.1",
    id: "test-recompute",
    version: "1.0.0",
    kind: "recomputation",
    operation: "identity",
    on_missing: "fail",
    inputs: [{ fact_id: "test.fact" }],
    input_contracts: [{ value_kind: "scalar", unit: "points", period: { basis: "instant", window: null, alignment: "as_of" }, on_missing: "fail" }],
    output_id: "test.output",
    value_kind: "scalar",
    unit: "points",
    output_period: { basis: "instant", window: null, alignment: "as_of" },
    source_ids: [source.source_id],
  };
  Object.assign(testTool, withTestFormulaApprovalBinding(testTool));
  writeJson(join(packDir, "tools.json"), [testTool]);
  writeJson(join(packDir, "memory_policy.json"), {
    leak_rule: "public_at <= as_of AND memory_created_at <= as_of",
  });
  writeFileSync(join(packDir, "voice.en.md"), "Explain the frozen method decision in plain English.\n");
  writeFileSync(join(packDir, "voice.zh.md"), "用中文解释已经冻结的方法结论。\n");
  writeJson(join(packDir, "manifest.json"), {
    schema_version: 3,
    pack_version: packVersion,
    identity: {
      persona_id: "master_test",
      public_label: { en: "Test Method Model", zh: "测试方法模型" },
      operator_label: { en: "Test-inspired Operator Lens", zh: "测试启发操作视角" },
      maturity: "method_model",
      source_cutoff: sourceCutoff,
    },
    selection: {
      identity: { en: "A test method", zh: "测试方法" },
      method: { en: "Tests one rule", zh: "检验一条规则" },
      best_for: { en: "Loader tests", zh: "加载器测试" },
    },
    capability: {
      domains: ["public_equity"],
      exclusions: [],
      required_fact_types: ["test.fact"],
      optional_fact_types: [],
      native_decision_schema: "test_native_v1",
    },
    research: {
      planner: "test_planner_v1",
      private_budget: { queries: 1, fetches: 1 },
      mandatory_disconfirming_queries: ["method thesis failure"],
      source_policy: "primary_first_v1",
    },
    computation: { dsl_version: "1.1", pipeline: ["test-recompute"] },
    decision: {
      eligibility: ["test.fact"],
      hard_vetoes: ["veto-1"],
      native_output: "test_native_v1",
      common_projection: "test_projection_v1",
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
      sources: escapeSourcePath ? "../outside.jsonl" : "sources.jsonl",
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
    }
  });
  return packDir;
}

test("a physical v3 pack loads and a self-declared method model stays an operator until admitted", (t) => {
  const pack = loadV3Pack(makePack(t));
  const compiled = compilePersonaPack(pack);
  assert.equal(pack.component_files.golden_cases, "eval/golden_cases.jsonl");
  assert.equal(compiled.persona_id, "master_test");
  assert.equal(compiled.dsl_version, "1.1");
  assert.equal(compiled.maturity, "operator_lens");
  assert.equal(compiled.admission.method_model_experiment_status.file, "eval/experiments.json");
  assert.equal(compiled.admitted_label.en, "Test-inspired Operator Lens");
  assert.match(compiled.pack_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(compiled.corpus_hash, /^sha256:[a-f0-9]{64}$/);
});

test("a physical v3 pack accepts a SemVer prerelease pack version", (t) => {
  const pack = loadV3Pack(makePack(t, { packVersion: "0.9.0-solo-test.2" }));
  assert.equal(pack.manifest.pack_version, "0.9.0-solo-test.2");
});

test("compiler hashes are stable across repeated loads", (t) => {
  const dir = makePack(t);
  const first = compilePersonaPack(loadV3Pack(dir));
  const second = compilePersonaPack(loadV3Pack(dir));
  assert.equal(first.pack_hash, second.pack_hash);
  assert.equal(first.policy_hash, second.policy_hash);
});

test("experiments participate in the component and pack hashes", (t) => {
  const dir = makePack(t);
  const first = compilePersonaPack(loadV3Pack(dir));
  writeJson(join(dir, "eval/experiments.json"), {
    schema_version: 1,
    persona_id: "master_test",
    experiments: { source_fidelity: experimentEntry("source_fidelity") },
  });
  const second = compilePersonaPack(loadV3Pack(dir));
  assert.notEqual(first.component_hashes.experiments, second.component_hashes.experiments);
  assert.notEqual(first.pack_hash, second.pack_hash);
  assert.equal(first.corpus_hash, second.corpus_hash);
});

test("the experiments component is a required physical manifest artifact", (t) => {
  const dir = makePack(t);
  const manifestFile = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  delete manifest.components.experiments;
  writeJson(manifestFile, manifest);
  assert.throws(() => loadV3Pack(dir), /components\.experiments is required/);
});

test("a loaded pack is a detached recursively frozen snapshot", (t) => {
  const pack = loadV3Pack(makePack(t));
  assert.equal(Object.isFrozen(pack), true);
  assert.equal(Object.isFrozen(pack.manifest), true);
  assert.equal(Object.isFrozen(pack.manifest.identity), true);
  assert.equal(Object.isFrozen(pack.components), true);
  assert.equal(Object.isFrozen(pack.components.doctrine), true);
  assert.equal(Object.isFrozen(pack.components.doctrine[0]), true);
  assert.equal(Object.isFrozen(pack.voice), true);
  assert.throws(() => { pack.manifest.identity.source_cutoff = "2099-01-01"; }, TypeError);
  assert.throws(() => { pack.components.doctrine[0].claim = "mutated"; }, TypeError);
});

test("a compiled pack recursively freezes every hash-bound nested payload", (t) => {
  const compiled = compilePersonaPack(loadV3Pack(makePack(t)));
  const hash = compiled.pack_hash;
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.component_hashes), true);
  assert.equal(Object.isFrozen(compiled.admission), true);
  assert.equal(Object.isFrozen(compiled.admission.counts), true);
  assert.equal(Object.isFrozen(compiled.components), true);
  assert.equal(Object.isFrozen(compiled.components.experiments), true);
  assert.throws(() => { compiled.component_hashes.doctrine = ZERO_HASH; }, TypeError);
  assert.throws(() => { compiled.admission.counts.propositions = 999; }, TypeError);
  assert.equal(compiled.pack_hash, hash);
});

test("a component path cannot escape through dot-dot", (t) => {
  assert.throws(() => loadV3Pack(makePack(t, { escapeSourcePath: true })), /escaping component/);
});

test("a component path cannot escape through a symlink", {
  skip: process.platform === "win32",
}, (t) => {
  const packDir = makePack(t);
  const sourceFile = join(packDir, "sources.jsonl");
  const outside = join(packDir, "..", "outside-sources.jsonl");
  renameSync(sourceFile, outside);
  symlinkSync(outside, sourceFile);
  assert.throws(() => loadV3Pack(packDir), /symlink escapes the pack directory/);
});

test("the manifest itself cannot escape through a symlink", {
  skip: process.platform === "win32",
}, (t) => {
  const packDir = makePack(t);
  const manifestFile = join(packDir, "manifest.json");
  const outside = join(packDir, "..", "outside-manifest.json");
  renameSync(manifestFile, outside);
  symlinkSync(outside, manifestFile);
  assert.throws(() => loadV3Pack(packDir), /symlink escapes the pack directory/);
});

test("unknown doctrine sources fail closed", (t) => {
  assert.throws(() => loadV3Pack(makePack(t, { unknownDoctrineSource: true })), /unknown source/);
});

test("a source newer than the pack cutoff is rejected", (t) => {
  assert.throws(
    () => loadV3Pack(makePack(t, { futureSource: true })),
    /public_at exceeds identity.source_cutoff/,
  );
});

test("a source learned after the pack cutoff is rejected even when already public", (t) => {
  assert.throws(
    () => loadV3Pack(makePack(t, { futureKnownSource: true })),
    /known_at exceeds identity.source_cutoff/,
  );
});

test("a date-only source cutoff includes the entire UTC calendar day", (t) => {
  const pack = loadV3Pack(makePack(t, {
    sourcePublicAt: "2026-07-27T23:59:59.999Z",
    sourceKnownAt: "2026-07-27T23:59:59.999Z",
  }));
  assert.equal(pack.components.sources[0].public_at, "2026-07-27T23:59:59.999Z");
});

test("a timestamp source cutoff remains an exact instant", (t) => {
  assert.throws(
    () => loadV3Pack(makePack(t, {
      sourceCutoff: "2026-07-27T12:00:00.000Z",
      sourcePublicAt: "2026-07-27T12:00:00.001Z",
      sourceKnownAt: "2026-07-27T12:00:00.001Z",
    })),
    /public_at exceeds identity.source_cutoff/,
  );
});
