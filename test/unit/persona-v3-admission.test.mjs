import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_BAR,
  CANDIDATE_EXPERIMENTS,
  METHOD_MODEL_EXPERIMENTS,
  OPERATIONAL_BAR,
  PersonaAdmissionError,
  evaluateMethodModelExperiments,
  inspectPersonaAdmission,
  signExperimentEntry,
} from "../../mcp/lib/personas-v3/admission.mjs";
import { withTestFormulaApprovalBinding } from "../helpers/persona-v3-deterministic-tool.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEST_SIGNER = "ci:test-key-v1";
const TEST_HASH = `sha256:${"a".repeat(64)}`;
const { privateKey: TEST_PRIVATE_KEY, publicKey: TEST_PUBLIC_KEY } = generateKeyPairSync("ed25519");
const TEST_SIGNER_KEYS = {
  [TEST_SIGNER]: { public_key: TEST_PUBLIC_KEY, purposes: ["persona_experiment"] },
};
const TEST_BINDINGS = Object.freeze({
  artifact_subject_hash: TEST_HASH,
  corpus_hash: TEST_HASH,
  policy_hash: TEST_HASH,
  tool_graph_hash: TEST_HASH,
  prompt_hash: TEST_HASH,
});

function temp(name) {
  return mkdtempSync(join(tmpdir(), `alphacouncil-${name}-`));
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function promptFile(root, id = "master_test") {
  const file = join(root, `${id}.md`);
  writeFileSync(file, "---json\n{}\n---\n\n<!-- lang:en -->\nMethod prompt.\n");
  return file;
}

function records(count, make) {
  return Array.from({ length: count }, (_, index) => make(index + 1));
}

function experimentEntry(id, {
  status = "passed",
  signerKeyId = TEST_SIGNER,
  overrides = {},
  artifactHashes = TEST_BINDINGS,
} = {}) {
  const entry = {
    experiment_id: id,
    status,
    dataset_hash: TEST_HASH,
    case_ledger_hash: TEST_HASH,
    artifact_subject_hash: artifactHashes.artifact_subject_hash,
    corpus_hash: artifactHashes.corpus_hash,
    policy_hash: artifactHashes.policy_hash,
    tool_graph_hash: artifactHashes.tool_graph_hash,
    model_hash: TEST_HASH,
    prompt_hash: artifactHashes.prompt_hash,
    runner_hash: TEST_HASH,
    host_hash: TEST_HASH,
    thresholds: {
      primary_metric: { operator: ">=", value: 0.95, unit: "ratio" },
    },
    metrics: {
      primary_metric: {
        value: status === "passed" ? 0.99 : 0.5,
        unit: "ratio",
        sample_size: 48,
        threshold_id: "primary_metric",
        passed: status === "passed",
      },
    },
    started_at: "2026-07-27T00:00:00.000Z",
    evaluated_at: "2026-07-27T01:00:00.000Z",
    signer_key_id: signerKeyId,
    signature_algorithm: "ed25519",
    ...overrides,
  };
  entry.signature = signExperimentEntry(entry, { privateKey: TEST_PRIVATE_KEY, signerKeyId });
  return entry;
}

function signedExperiments(ids, artifactHashes = TEST_BINDINGS) {
  return Object.fromEntries(ids.map((id) => [id, experimentEntry(id, { artifactHashes })]));
}

function unsignedExperiments(ids) {
  return Object.fromEntries(ids.map((id) => {
    const entry = experimentEntry(id);
    delete entry.signature;
    return [id, entry];
  }));
}

function installSignedExperiments(pack, ids, { failed = [] } = {}) {
  const personaId = basename(pack);
  const inspection = inspectPersonaAdmission({ persona_id: personaId, pack_dir: pack });
  const experiments = Object.fromEntries(ids.map((id) => [id, experimentEntry(id, {
    status: failed.includes(id) ? "failed" : "passed",
    artifactHashes: inspection.artifact_hashes,
  })]));
  writeJson(join(pack, "evaluation", "experiments.json"), {
    schema_version: 1,
    persona_id: personaId,
    experiments,
  });
  return experiments;
}

function makeV3Pack(root, {
  id = "master_test",
  propositions = 10,
  sources = 3,
  abSources = sources,
  decisions = 2,
  failures = 1,
  vetoes = 5,
  counterfactuals = 10,
  tools = 2,
  recomputationTools = 0,
  golden = 0,
  pairwiseGroups = 0,
  sourceReviewers = 2,
  experiments = null,
  declaredMaturity = "method_model",
} = {}) {
  const pack = join(root, id);
  mkdirSync(join(pack, "evaluation"), { recursive: true });
  const componentNames = {
    sources: "sources.json",
    doctrine: "doctrine.json",
    decision_cases: "decision_cases.json",
    failures: "failures.json",
    counterfactuals: "counterfactuals.json",
    research_policy: "research_policy.json",
    decision_policy: "decision_policy.json",
    tools: "tools.json",
    memory_policy: "memory_policy.json",
    golden_cases: "golden_cases.json",
    pairwise_cases: "pairwise_cases.json",
    calibration_cases: "calibration_cases.json",
    experiments: "evaluation/experiments.json",
  };
  const sourceRows = records(sources, (n) => ({
    schema_version: 1,
    source_id: `source_${n}`,
    source_kind: "primary_text",
    grade: n <= abSources ? "A" : "C",
    author: "Test Author",
    title: `Source ${n}`,
    url: `https://example.test/source-${n}`,
    published_at: `202${n % 10}-01-01`,
    public_at: `202${n % 10}-01-01`,
    retrieved_at: "2026-07-27",
    locator: { section: `Section ${n}` },
    summary: `Primary method source number ${n}.`,
    content_hash: `sha256:${n.toString(16).padStart(64, "0")}`,
    adjudication: {
      status: "approved",
      reviewer_ids: records(sourceReviewers, (reviewer) => `reviewer-${reviewer}`),
      reviewed_at: "2026-07-27",
    },
  }));
  const sourceIds = sourceRows.map((source) => source.source_id);
  writeJson(join(pack, componentNames.sources), sourceRows);
  writeJson(join(pack, componentNames.doctrine), records(propositions, (n) => ({
    rule_id: `test.rule.${String(n).padStart(2, "0")}`,
    claim: `Proposition ${n}`,
    source_ids: [sourceIds[(n - 1) % sourceIds.length]],
  })));
  const caseCore = {
    schema_version: 1,
    as_of: "2026-07-27",
    source_ids: ["source_1"],
    fact_pack_hash: TEST_HASH,
  };
  writeJson(join(pack, componentNames.decision_cases), records(decisions, (n) => ({
    ...caseCore, case_id: `D${n}`, expected_native_decision: "WATCH",
  })));
  writeJson(join(pack, componentNames.failures), records(failures, (n) => ({
    ...caseCore, case_id: `F${n}`, failure_mode: "missed disconfirming evidence", expected_correction: "abstain",
  })));
  writeJson(join(pack, componentNames.counterfactuals), records(counterfactuals, (n) => ({
    ...caseCore,
    case_id: `C${n}`,
    base_case_id: "D1",
    mutation: { leverage: "increase" },
    expected_direction: "down",
  })));
  writeJson(join(pack, componentNames.research_policy), {
    private_research_paths: ["private/company"],
    mandatory_disconfirming_queries: ["thesis failure"],
  });
  writeJson(join(pack, componentNames.decision_policy), {
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: "test_native_v1",
    native_states: [
      "critical_metric_missing", "metric_veto", "metric_veto_unknown",
      "metric_evidence_insufficient", "metric_accept", "metric_reject",
    ],
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "critical_metric_missing", common_stance: "out_of_scope" },
    },
    eligibility: { all: [] },
    hard_vetoes: records(vetoes, (n) => ({
      veto_id: `veto_${n}`,
      condition: { op: "gt", left: { fact_id: "test.metric" }, right: { literal: n } },
      source_ids: ["source_1"],
      on_trigger: { native_state: "metric_veto", common_stance: "opposed" },
      on_uncomputable: {
        action: "abstain",
        decision: { native_state: "metric_veto_unknown", common_stance: "out_of_scope" },
      },
    })),
    scoring: {
      max_score: 1,
      min_coverage: 1,
      on_insufficient_coverage: { native_state: "metric_evidence_insufficient", common_stance: "out_of_scope" },
      rules: [{
        rule_id: "metric_positive",
        condition: { op: "gt", left: { fact_id: "test.metric" }, right: { literal: 0 } },
        points: 1,
        coverage_weight: 1,
        source_ids: ["source_1"],
      }],
    },
    score_bands: [
      { min_ratio: 1, decision: { native_state: "metric_accept", common_stance: "constructive" } },
      { min_ratio: 0, decision: { native_state: "metric_reject", common_stance: "opposed" } },
    ],
    native_output_fields: [],
  });
  const toolRows = records(tools, (n) => {
    const tool = {
      schema_version: 1,
      dsl_version: "1.1",
      id: `tool_${n}`,
      version: "1.0.0",
      kind: n <= recomputationTools ? "recomputation" : "calculator",
      operation: "identity",
      on_missing: "skip",
      inputs: [{ fact_id: "test.metric" }],
      input_contracts: [{ value_kind: "scalar", unit: "points", period: { basis: "instant", window: null, alignment: "as_of" }, on_missing: "skip" }],
      output_id: `test.output_${n}`,
      value_kind: "scalar",
      unit: "points",
      output_period: { basis: "instant", window: null, alignment: "as_of" },
      source_ids: ["source_1"],
    };
    return withTestFormulaApprovalBinding(tool);
  });
  writeJson(join(pack, componentNames.tools), toolRows);
  writeJson(join(pack, componentNames.memory_policy), {
    leak_rule: "public_at <= as_of AND memory_created_at <= as_of",
  });
  writeJson(join(pack, componentNames.golden_cases), records(golden, (n) => ({
    ...caseCore, case_id: `G${n}`, expected_native_decision: "WATCH",
  })));
  writeJson(join(pack, componentNames.pairwise_cases), records(pairwiseGroups, (n) => ({
    ...caseCore,
    case_id: `P${n}`,
    group_id: `pair_${n}`,
    peer_persona_id: "master_peer",
    expected_relation: "different",
  })));
  writeJson(join(pack, componentNames.calibration_cases), []);
  writeJson(join(pack, componentNames.experiments), {
    schema_version: 1,
    persona_id: id,
    experiments: experiments || {},
  });
  writeFileSync(join(pack, "voice.en.md"), "Neutral English voice.\n");
  writeFileSync(join(pack, "voice.zh.md"), "中性中文表达。\n");
  writeJson(join(pack, "manifest.json"), {
    schema_version: 3,
    pack_version: "0.9.0",
    identity: { persona_id: id, maturity: declaredMaturity, source_cutoff: "2026-07-27" },
    capability: {
      required_fact_types: [],
      optional_fact_types: ["test.metric"],
      native_decision_schema: "test_native_v1",
    },
    computation: { dsl_version: "1.1", pipeline: toolRows.map((tool) => tool.id) },
    decision: {
      eligibility: ["test.metric"],
      hard_vetoes: records(vetoes, (n) => `veto_${n}`),
      native_output: "test_native_v1",
      common_projection: "test_projection_v1",
      abstention_policy: "fail_closed",
    },
    voice: { load_after_decision_freeze: true, en: "voice.en.md", zh: "voice.zh.md" },
    components: componentNames,
    admission: {
      propositions: 999,
      primary_sources: 999,
      decision_cases: 999,
    },
  });
  return pack;
}

test("a legacy prompt is only a prompt_lens and reports the full operational delta", () => {
  const root = temp("v3-prompt");
  const result = inspectPersonaAdmission({
    persona_id: "master_legacy",
    prompt_file: promptFile(root, "master_legacy"),
    pack_dir: join(root, "missing-pack"),
  });
  assert.equal(result.admission_level, "prompt_lens");
  assert.equal(result.pack_format, "v1_prompt");
  assert.equal(result.delta_to_operational.physical_v3_pack, 1);
  assert.equal(result.delta_to_operational.propositions, OPERATIONAL_BAR.propositions);
  assert.equal(result.method_model_experiment_status.status, "not_started");
});

test("a v2 manifest cannot promote itself with declared admission counts or kind", () => {
  const root = temp("v3-self-claim");
  const pack = join(root, "master_claim");
  mkdirSync(pack, { recursive: true });
  writeJson(join(pack, "manifest.json"), {
    schema_version: 2,
    persona_id: "master_claim",
    kind: "method_model",
    admission: Object.fromEntries(Object.keys(CANDIDATE_BAR).map((key) => [key, 999])),
    sources: [{ id: "S1", grade: "A", title: "One", url: "https://example.test/one", date: "2020-01-01" }],
    doctrine: [{ rule_id: "claim.rule.01", source_ids: ["S1"] }],
    decision_policy: { vetoes: [] },
  });
  const result = inspectPersonaAdmission({
    persona_id: "master_claim",
    prompt_file: promptFile(root, "master_claim"),
    pack_dir: pack,
  });
  assert.equal(result.admission_level, "operator_lens");
  assert.equal(result.pack_format, "v2_inline");
  assert.equal(result.declared_maturity, "method_model");
  assert.equal(result.declared_admission_ignored, true);
  assert.equal(result.manifest_self_claim_effective, false);
  assert.equal(result.physical_corpus_counts.propositions, 1);
  assert.equal(result.delta_to_operational.physical_v3_pack, 1);
});

test("a physical pack that clears the operational bar becomes operational", () => {
  const root = temp("v3-operational");
  const pack = makeV3Pack(root);
  const result = inspectPersonaAdmission({
    persona_id: "master_test",
    prompt_file: promptFile(root),
    pack_dir: pack,
  });
  assert.equal(result.admission_level, "operational");
  assert.deepEqual(result.gaps_to_operational, {});
  assert.ok(result.delta_to_candidate.propositions > 0);
  assert.equal(result.declared_admission_ignored, true);
});

test("id-only case and tool shells do not count toward admission", () => {
  const root = temp("v3-empty-shells");
  const pack = makeV3Pack(root);
  writeJson(join(pack, "decision_cases.json"), [{ case_id: "D-shell", source_ids: ["source_1"] }]);
  writeJson(join(pack, "failures.json"), [{ case_id: "F-shell", source_ids: ["source_1"] }]);
  writeJson(join(pack, "counterfactuals.json"), [{ case_id: "C-shell", expected_direction: "down" }]);
  writeJson(join(pack, "golden_cases.json"), [{ case_id: "G-shell" }]);
  writeJson(join(pack, "pairwise_cases.json"), [{ case_id: "P-shell", group_id: "pair-shell" }]);
  writeJson(join(pack, "tools.json"), [{ id: "tool-shell", kind: "recomputation" }]);
  const result = inspectPersonaAdmission({
    persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack,
  });
  assert.equal(result.physical_corpus_counts.decision_cases, 0);
  assert.equal(result.physical_corpus_counts.failure_cases, 0);
  assert.equal(result.physical_corpus_counts.counterfactuals, 0);
  assert.equal(result.physical_corpus_counts.golden_cases, 0);
  assert.equal(result.physical_corpus_counts.pairwise_groups, 0);
  assert.equal(result.physical_corpus_counts.dedicated_tools, 0);
  assert.ok(result.excluded_physical_counts.decision_cases > 0);
  assert.ok(result.excluded_physical_counts.dedicated_tools > 0);
  assert.equal(result.admission_level, "operator_lens");
});

test("candidate corpus still needs signed source, policy and host experiment gates", () => {
  const root = temp("v3-unsigned-candidate");
  const pack = makeV3Pack(root, {
    propositions: 25, sources: 5, decisions: 5, failures: 3, vetoes: 10,
    counterfactuals: 20, tools: 3, recomputationTools: 2, golden: 12, pairwiseGroups: 4,
    experiments: unsignedExperiments(CANDIDATE_EXPERIMENTS),
  });
  const result = inspectPersonaAdmission({
    persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack,
    trustedSignerKeys: TEST_SIGNER_KEYS,
  });
  assert.equal(result.admission_level, "operational");
  assert.equal(result.method_model_experiment_status.status, "incomplete");
  assert.deepEqual(result.method_model_experiment_status.unsigned.sort(), [...CANDIDATE_EXPERIMENTS].sort());
  assert.equal(result.delta_to_candidate.source_experiment_passes, 1);
});

test("candidate promotion requires the complete candidate corpus and signed experiment gates", () => {
  const root = temp("v3-candidate");
  const pack = makeV3Pack(root, {
    propositions: 25, sources: 5, decisions: 5, failures: 3, vetoes: 10,
    counterfactuals: 20, tools: 3, recomputationTools: 2, golden: 12, pairwiseGroups: 4,
  });
  installSignedExperiments(pack, CANDIDATE_EXPERIMENTS);
  const result = inspectPersonaAdmission({
    persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack,
    trustedSignerKeys: TEST_SIGNER_KEYS,
  });
  assert.equal(result.admission_level, "candidate");
  assert.deepEqual(result.gaps_to_candidate, {});
  assert.equal(result.method_model_experiment_status.status, "incomplete");
  assert.ok(result.method_model_experiment_status.missing.includes("name_invariance"));
  assert.equal("delta_to_method_model" in result, false);
});

test("a signed experiment cannot be replayed after the physical policy changes", () => {
  const root = temp("v3-policy-binding");
  const pack = makeV3Pack(root, {
    propositions: 25, sources: 5, decisions: 5, failures: 3, vetoes: 10,
    counterfactuals: 20, tools: 3, recomputationTools: 2, golden: 12, pairwiseGroups: 4,
  });
  installSignedExperiments(pack, CANDIDATE_EXPERIMENTS);
  const policyFile = join(pack, "research_policy.json");
  const policy = JSON.parse(readFileSync(policyFile, "utf8"));
  policy.private_research_paths.push("private/disconfirming");
  writeJson(policyFile, policy);

  const result = inspectPersonaAdmission({
    persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack,
    trustedSignerKeys: TEST_SIGNER_KEYS,
  });
  assert.equal(result.admission_level, "operational");
  assert.deepEqual(
    result.method_model_experiment_status.binding_mismatch.sort(),
    [...CANDIDATE_EXPERIMENTS].sort(),
  );
  assert.equal(result.method_model_experiment_status.passed.length, 0);
});

test("method_model promotion stays fail closed until the migration gate is explicitly enabled", () => {
  const root = temp("v3-method");
  const pack = makeV3Pack(root, {
    propositions: 25, sources: 5, decisions: 5, failures: 3, vetoes: 10,
    counterfactuals: 20, tools: 3, recomputationTools: 2, golden: 12, pairwiseGroups: 4,
  });
  installSignedExperiments(pack, METHOD_MODEL_EXPERIMENTS);
  const result = inspectPersonaAdmission({
    persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack,
    trustedSignerKeys: TEST_SIGNER_KEYS,
  });
  assert.equal(result.admission_level, "candidate");
  assert.equal(result.method_model_experiment_status.status, "passed");
  assert.equal(result.method_model_rule_review_status.status, "passed");
  assert.equal(result.candidate_clear, true);
  assert.equal(result.method_model_ready, true);
  assert.equal(result.method_model_promotion_enabled, false);
  assert.equal(result.method_model_promotion_blocked_reason, "migration_gate_closed");
  assert.equal("delta_to_method_model" in result, false);

  const explicitlyEnabled = inspectPersonaAdmission({
    persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack,
    trustedSignerKeys: TEST_SIGNER_KEYS,
    allowMethodModelPromotion: true,
  });
  assert.equal(explicitlyEnabled.admission_level, "method_model");
});

test("a complete signed corpus does not promote when no signer is trusted", () => {
  const root = temp("v3-method-untrusted");
  const pack = makeV3Pack(root, {
    propositions: 25, sources: 5, decisions: 5, failures: 3, vetoes: 10,
    counterfactuals: 20, tools: 3, recomputationTools: 2, golden: 12, pairwiseGroups: 4,
  });
  installSignedExperiments(pack, METHOD_MODEL_EXPERIMENTS);
  const result = inspectPersonaAdmission({
    persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack,
    trustedSignerKeys: {},
  });
  assert.equal(result.admission_level, "operational");
  assert.equal(result.candidate_clear, false);
  assert.deepEqual(result.method_model_experiment_status.untrusted, [...METHOD_MODEL_EXPERIMENTS]);
  assert.equal(result.method_model_experiment_status.passed.length, 0);
});

test("method_model rule admission requires dual-reviewed A/B primary anchors", () => {
  const root = temp("v3-method-one-reviewer");
  const pack = makeV3Pack(root, {
    propositions: 25, sources: 5, decisions: 5, failures: 3, vetoes: 10,
    counterfactuals: 20, tools: 3, recomputationTools: 2, golden: 12, pairwiseGroups: 4,
    sourceReviewers: 1,
  });
  installSignedExperiments(pack, METHOD_MODEL_EXPERIMENTS);
  const result = inspectPersonaAdmission({
    persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack,
    trustedSignerKeys: TEST_SIGNER_KEYS,
  });
  assert.equal(result.candidate_clear, true);
  assert.equal(result.admission_level, "candidate");
  assert.equal(result.method_model_experiment_status.status, "passed");
  assert.equal(result.method_model_rule_review_status.status, "incomplete");
  assert.deepEqual(result.method_model_rule_review_status.gaps, {
    dual_reviewed_propositions: 25,
    dual_reviewed_vetoes: 10,
  });
});

test("v3 rejects loose v2-style source rows instead of treating them as anchors", () => {
  const root = temp("v3-loose-source");
  const pack = makeV3Pack(root);
  writeJson(join(pack, "sources.json"), [{
    id: "S1", grade: "A", title: "Loose", url: "https://example.test/loose", date: "2020-01-01",
  }]);
  const result = inspectPersonaAdmission({ persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack });
  assert.equal(result.source_contract, "v3_anchor_v1");
  assert.equal(result.physical_corpus_counts.method_sources, 0);
  assert.equal(result.physical_corpus_counts.propositions, 0);
  assert.equal(result.admission_level, "operator_lens");
  assert.ok(result.source_anchor_errors.some((error) => /schema_version must be 1/.test(error)));
});

test("v3 counts duplicate content only once as an independent source", () => {
  const root = temp("v3-duplicate-content");
  const pack = makeV3Pack(root);
  const sourcesFile = join(pack, "sources.json");
  const rows = JSON.parse(readFileSync(sourcesFile, "utf8"));
  rows[1].content_hash = rows[0].content_hash;
  writeJson(sourcesFile, rows);
  const result = inspectPersonaAdmission({ persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack });
  assert.equal(result.physical_corpus_counts.method_sources, 2);
  assert.equal(result.excluded_physical_counts.method_sources, 1);
  assert.ok(result.source_anchor_errors.some((error) => /not an independent source/.test(error)));
});

test("v3 admission excludes a source learned after identity.source_cutoff", () => {
  const root = temp("v3-future-known-source");
  const pack = makeV3Pack(root);
  const sourcesFile = join(pack, "sources.json");
  const rows = JSON.parse(readFileSync(sourcesFile, "utf8"));
  rows[0].known_at = "2027-01-01";
  writeJson(sourcesFile, rows);
  const result = inspectPersonaAdmission({ persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack });
  assert.equal(result.physical_corpus_counts.method_sources, 2);
  assert.equal(result.excluded_physical_counts.method_sources, 1);
  assert.ok(result.source_anchor_errors.some((error) => /known_at exceeds identity.source_cutoff/.test(error)));
});

test("v3 admission treats a date-only source cutoff as the inclusive UTC day", () => {
  const root = temp("v3-date-only-cutoff");
  const pack = makeV3Pack(root);
  const sourcesFile = join(pack, "sources.json");
  const rows = JSON.parse(readFileSync(sourcesFile, "utf8"));
  for (const source of rows) {
    source.public_at = "2026-07-27T23:59:59.999Z";
    source.known_at = "2026-07-27T23:59:59.999Z";
  }
  writeJson(sourcesFile, rows);
  const result = inspectPersonaAdmission({ persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack });
  assert.equal(result.physical_corpus_counts.method_sources, rows.length);
  assert.equal(result.source_anchor_errors.length, 0);
});

test("v3 admission rejects a manifest symlink that escapes the pack", {
  skip: process.platform === "win32",
}, () => {
  const root = temp("v3-manifest-symlink");
  const pack = makeV3Pack(root);
  const manifest = join(pack, "manifest.json");
  const outside = join(root, "outside-manifest.json");
  renameSync(manifest, outside);
  symlinkSync(outside, manifest);
  assert.throws(
    () => inspectPersonaAdmission({ persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack }),
    (error) => error instanceof PersonaAdmissionError && /symlink escapes the pack directory/.test(error.message),
  );
});

test("v3 admission rejects a component symlink that escapes the pack", {
  skip: process.platform === "win32",
}, () => {
  const root = temp("v3-component-symlink");
  const pack = makeV3Pack(root);
  const component = join(pack, "doctrine.json");
  const outside = join(root, "outside-doctrine.json");
  renameSync(component, outside);
  symlinkSync(outside, component);
  assert.throws(
    () => inspectPersonaAdmission({ persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack }),
    (error) => error instanceof PersonaAdmissionError && /symlink escapes the pack directory/.test(error.message),
  );
});

test("v3 admission rejects an experiment symlink that escapes the pack", {
  skip: process.platform === "win32",
}, () => {
  const root = temp("v3-experiment-symlink");
  const pack = makeV3Pack(root, { experiments: signedExperiments(CANDIDATE_EXPERIMENTS) });
  const experimentFile = join(pack, "evaluation", "experiments.json");
  const outside = join(root, "outside-experiments.json");
  renameSync(experimentFile, outside);
  symlinkSync(outside, experimentFile);
  assert.throws(
    () => inspectPersonaAdmission({ persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack }),
    (error) => error instanceof PersonaAdmissionError && /symlink escapes the pack directory/.test(error.message),
  );
});

test("one failed signed experiment keeps a complete corpus at candidate", () => {
  const root = temp("v3-method-failed");
  const pack = makeV3Pack(root, {
    propositions: 25, sources: 5, decisions: 5, failures: 3, vetoes: 10,
    counterfactuals: 20, tools: 3, recomputationTools: 2, golden: 12, pairwiseGroups: 4,
  });
  installSignedExperiments(pack, METHOD_MODEL_EXPERIMENTS, { failed: ["matched_cost"] });
  const result = inspectPersonaAdmission({
    persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack,
    trustedSignerKeys: TEST_SIGNER_KEYS,
  });
  assert.equal(result.admission_level, "candidate");
  assert.equal(result.method_model_experiment_status.status, "failed");
  assert.deepEqual(result.method_model_experiment_status.failed, ["matched_cost"]);
});

test("malformed physical components fail closed", () => {
  const root = temp("v3-invalid");
  const pack = makeV3Pack(root);
  writeFileSync(join(pack, "doctrine.json"), "{not-json\n");
  assert.throws(
    () => inspectPersonaAdmission({ persona_id: "master_test", prompt_file: promptFile(root), pack_dir: pack }),
    (error) => error instanceof PersonaAdmissionError && /invalid JSON/.test(error.message),
  );
});

test("experiment evaluator separates failed, unsigned and missing results", () => {
  const sourceFidelity = experimentEntry("source_fidelity");
  const policyAdherence = experimentEntry("policy_adherence", { status: "failed" });
  const hostParity = experimentEntry("host_parity");
  delete hostParity.signature;
  const result = evaluateMethodModelExperiments({
    schema_version: 1,
    persona_id: "master_test",
    experiments: {
      source_fidelity: sourceFidelity,
      policy_adherence: policyAdherence,
      host_parity: hostParity,
    },
  }, {
    personaId: "master_test",
    trustedSignerKeys: TEST_SIGNER_KEYS,
    expectedArtifactHashes: TEST_BINDINGS,
  });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.passed, ["source_fidelity"]);
  assert.deepEqual(result.failed, ["policy_adherence"]);
  assert.deepEqual(result.unsigned, ["host_parity"]);
  assert.ok(result.missing.includes("name_invariance"));
});

test("the report script scans the canonical 26 and emits JSON with required deltas", () => {
  const run = spawnSync(process.execPath, ["scripts/report-persona-corpus-gaps.mjs", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.canonical_master_count, 26);
  assert.equal(report.personas.length, 26);
  assert.equal(report.summary.method_models, 0);
  const buffett = report.personas.find((persona) => persona.persona_id === "master_buffett");
  assert.equal(buffett.pack_format, "v2_inline");
  assert.equal(buffett.admission_level, "operator_lens");
  assert.ok(buffett.delta_to_operational.physical_v3_pack > 0);
  assert.ok(buffett.delta_to_candidate.counterfactuals > 0);
  assert.equal(buffett.method_model_experiment_status.status, "not_started");
});

test("the default report is Markdown and keeps method-model promotion experiment-based", () => {
  const run = spawnSync(process.execPath, ["scripts/report-persona-corpus-gaps.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Persona corpus and admission gap report/);
  assert.match(run.stdout, /Δ operational/);
  assert.match(run.stdout, /Δ candidate/);
  assert.doesNotMatch(run.stdout, /Δ method model/);
  assert.match(run.stdout, /master_buffett/);
});
