import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPersonaV3GaReport,
  normalizeGaRequirements,
  renderPersonaV3GaReport,
} from "../../mcp/lib/personas-v3/ga-gate.mjs";
import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { inspectSourceAcquisitions } from "../../mcp/lib/personas-v3/source-acquisition.mjs";
import { inspectSourceAdjudications } from "../../mcp/lib/personas-v3/source-adjudication.mjs";
import { defaultPersonaDir, loadPersonas } from "../../mcp/lib/personas/registry.mjs";
import { parseArgs } from "../../scripts/check-persona-v3-ga.mjs";
import { withTestFormulaApprovalBinding } from "../helpers/persona-v3-deterministic-tool.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

/** Seats that currently carry at least one raw source acquisition. */
const SEATS_WITH_RAW_ACQUISITIONS = 26;

/** Seats carrying legacy v2 operator material rather than prompt-only material. */
const LEGACY_OPERATOR_SEATS = 4;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/check-persona-v3-ga.mjs");
const CURRENT_PACKAGE_VERSION = JSON.parse(
  readFileSync(join(ROOT, "package.json"), "utf8"),
).version;

function temp(t, name) {
  const root = mkdtempSync(join(tmpdir(), `alphacouncil-ga-${name}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, values) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

function records(count, make) {
  return Array.from({ length: count }, (_, index) => make(index + 1));
}

function makeOperationalPack(knowledgeDir, personaId) {
  const packDir = join(knowledgeDir, personaId);
  mkdirSync(join(packDir, "evaluation"), { recursive: true });
  const sourceRows = records(3, (number) => ({
    schema_version: 1,
    source_id: `${personaId}:primary:${number}`,
    source_kind: "primary_text",
    grade: "A",
    author: "Fixture Method Author",
    title: `${personaId} primary source ${number}`,
    url: `https://example.test/${personaId}/source-${number}`,
    published_at: `202${number}-01-01`,
    public_at: `202${number}-01-01`,
    known_at: `202${number}-01-01`,
    retrieved_at: "2026-07-27",
    locator: { section: `Method section ${number}` },
    summary: `Independently reviewed method source ${number}.`,
    content_hash: sha256({ personaId, number }),
    adjudication: {
      status: "approved",
      reviewer_ids: [`reviewer-a-${number}`, `reviewer-b-${number}`],
      reviewed_at: "2026-07-27",
    },
  }));
  const sourceIds = sourceRows.map((source) => source.source_id);
  const caseCore = {
    schema_version: 1,
    as_of: "2026-07-27",
    source_ids: [sourceIds[0]],
    fact_pack_hash: sha256({ personaId, fixture: "fact-pack" }),
  };
  writeJsonl(join(packDir, "sources.jsonl"), sourceRows);
  writeJsonl(join(packDir, "doctrine.jsonl"), records(10, (number) => ({
    rule_id: `${personaId}.rule.${number}`,
    claim: `Fixture proposition ${number}`,
    source_ids: [sourceIds[(number - 1) % sourceIds.length]],
  })));
  writeJsonl(join(packDir, "decision_cases.jsonl"), records(2, (number) => ({
    ...caseCore,
    case_id: `${personaId}.decision.${number}`,
    expected_native_decision: "accepted",
  })));
  writeJsonl(join(packDir, "failures.jsonl"), [{
    ...caseCore,
    case_id: `${personaId}.failure.1`,
    failure_mode: "missed disconfirming evidence",
    expected_correction: "abstain",
  }]);
  writeJsonl(join(packDir, "counterfactuals.jsonl"), records(10, (number) => ({
    ...caseCore,
    case_id: `${personaId}.counterfactual.${number}`,
    base_case_id: `${personaId}.decision.1`,
    mutation: { metric: number },
    expected_direction: "down",
  })));
  writeJsonl(join(packDir, "evaluation/golden_cases.jsonl"), [{
    ...caseCore,
    case_id: `${personaId}.golden.1`,
    expected_native_decision: "accepted",
  }]);
  writeJsonl(join(packDir, "evaluation/pairwise_cases.jsonl"), [{
    ...caseCore,
    case_id: `${personaId}.pairwise.1`,
    group_id: `${personaId}.pair.1`,
    peer_persona_id: "master_peer",
    expected_relation: "different",
  }]);
  writeJsonl(join(packDir, "evaluation/calibration_cases.jsonl"), [{
    case_id: `${personaId}.calibration.1`,
    expected_confidence: "bounded",
  }]);
  writeJson(join(packDir, "evaluation/experiments.json"), {
    schema_version: 1,
    persona_id: personaId,
    experiments: {},
  });
  writeJson(join(packDir, "research_policy.json"), {
    private_research_paths: ["primary filings"],
    mandatory_disconfirming_queries: ["fixture thesis failure"],
  });

  const nativeStates = [
    "critical_missing",
    "eligibility_not_met",
    "eligibility_unknown",
    "vetoed",
    "veto_unknown",
    "insufficient_evidence",
    "accepted",
    "rejected",
  ];
  writeJson(join(packDir, "decision_policy.json"), {
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: `${personaId}_native_v1`,
    native_states: nativeStates,
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "critical_missing", common_stance: "out_of_scope" },
    },
    eligibility: {
      all: [{
        condition_id: `${personaId}.eligibility`,
        condition: { op: "exists", value: { fact_id: `${personaId}.metric` } },
        source_ids: [sourceIds[0]],
        on_false: { native_state: "eligibility_not_met", common_stance: "out_of_scope" },
        on_uncomputable: { native_state: "eligibility_unknown", common_stance: "out_of_scope" },
      }],
    },
    hard_vetoes: records(5, (number) => ({
      veto_id: `${personaId}.veto.${number}`,
      condition: { op: "lt", left: { fact_id: `${personaId}.metric` }, right: { literal: number * -1 } },
      source_ids: [sourceIds[(number - 1) % sourceIds.length]],
      on_trigger: { native_state: "vetoed", common_stance: "opposed" },
      on_uncomputable: {
        action: "abstain",
        decision: { native_state: "veto_unknown", common_stance: "out_of_scope" },
      },
    })),
    scoring: {
      max_score: 1,
      min_coverage: 1,
      on_insufficient_coverage: { native_state: "insufficient_evidence", common_stance: "out_of_scope" },
      rules: [{
        rule_id: `${personaId}.score.1`,
        condition: { op: "exists", value: { fact_id: `${personaId}.metric` } },
        points: 1,
        coverage_weight: 1,
        source_ids: [sourceIds[0]],
      }],
    },
    score_bands: [
      { min_ratio: 1, decision: { native_state: "accepted", common_stance: "constructive" } },
      { min_ratio: 0, decision: { native_state: "rejected", common_stance: "cautious" } },
    ],
    native_output_fields: [{ field: "fixture_value", value: { output_id: `${personaId}.output.1` }, on_missing: "fail" }],
  });

  const toolRows = records(2, (number) => {
    const tool = {
      schema_version: 1,
      dsl_version: "1.1",
      id: `${personaId}.tool.${number}`,
      version: "1.0.0",
      kind: "recomputation",
      operation: "identity",
      on_missing: "fail",
      inputs: [{ fact_id: `${personaId}.metric` }],
      input_contracts: [{ value_kind: "scalar", unit: "points", period: { basis: "instant", window: null, alignment: "as_of" }, on_missing: "fail" }],
      output_id: `${personaId}.output.${number}`,
      value_kind: "scalar",
      unit: "points",
      output_period: { basis: "instant", window: null, alignment: "as_of" },
      source_ids: [sourceIds[(number - 1) % sourceIds.length]],
    };
    return withTestFormulaApprovalBinding(tool);
  });
  writeJson(join(packDir, "tools.json"), toolRows);
  writeJson(join(packDir, "memory_policy.json"), {
    leak_rule: "public_at <= as_of AND memory_created_at <= as_of",
  });
  writeFileSync(join(packDir, "voice.en.md"), "Explain the frozen structured decision in plain English.\n");
  writeFileSync(join(packDir, "voice.zh.md"), "用中文解释已经冻结的结构化结论。\n");
  writeJson(join(packDir, "manifest.json"), {
    schema_version: 3,
    pack_version: "0.9.0",
    identity: {
      persona_id: personaId,
      public_label: { en: `${personaId} Method Model`, zh: `${personaId}方法模型` },
      operator_label: { en: `${personaId}-inspired Operator Lens`, zh: `${personaId}启发操作视角` },
      maturity: "operator_lens",
      source_cutoff: "2026-07-27",
    },
    selection: {
      identity: { en: `${personaId} fixture`, zh: `${personaId}测试` },
      method: { en: "Recomputes one fixture metric", zh: "重算一个测试指标" },
      best_for: { en: "GA gate tests", zh: "GA门禁测试" },
    },
    capability: {
      domains: ["public_equity"],
      exclusions: [],
      required_fact_types: [`${personaId}.metric`],
      optional_fact_types: [],
      native_decision_schema: `${personaId}_native_v1`,
    },
    research: {
      planner: `${personaId}_planner_v1`,
      private_budget: { queries: 1, fetches: 1 },
      mandatory_disconfirming_queries: ["fixture thesis failure"],
      source_policy: "primary_first_v1",
    },
    computation: { dsl_version: "1.1", pipeline: toolRows.map((tool) => tool.id) },
    decision: {
      eligibility: [`${personaId}.metric`],
      hard_vetoes: records(5, (number) => `${personaId}.veto.${number}`),
      native_output: `${personaId}_native_v1`,
      common_projection: "fixture_projection_v1",
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
      golden_cases: "evaluation/golden_cases.jsonl",
      pairwise_cases: "evaluation/pairwise_cases.jsonl",
      calibration_cases: "evaluation/calibration_cases.jsonl",
      experiments: "evaluation/experiments.json"
    }
  });
  return packDir;
}

function completeFixture(t, name = "complete") {
  const root = temp(t, name);
  const knowledgeDir = join(root, "knowledge");
  mkdirSync(knowledgeDir);
  const personaDir = defaultPersonaDir();
  const canonicalIds = loadPersonas({ dir: personaDir }).ids("master");
  for (const id of canonicalIds) makeOperationalPack(knowledgeDir, id);
  return { root, knowledgeDir, personaDir, canonicalIds, stagingDir: join(root, "missing-staging") };
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env },
  });
}

test("the live default report is structured, stable and honestly fails at zero physical v3", () => {
  const acquisitions = inspectSourceAcquisitions();
  const adjudications = inspectSourceAdjudications();
  const adjudicated = new Set(adjudications.personas.flatMap((persona) => persona.records
    .map((record) => `${persona.persona_id}/${record.candidate_id}`)));
  const unpreparedCount = acquisitions.personas.reduce((sum, persona) => sum + persona.records
    .filter((record) => !adjudicated.has(`${persona.persona_id}/${record.candidate_id}`)).length, 0);
  const pendingPreparedCount = adjudications.personas.reduce((sum, persona) => sum + persona.records
    .filter((record) => ["pending", "blocked"].includes(record.status)).length, 0);
  const first = buildPersonaV3GaReport();
  const second = buildPersonaV3GaReport();
  assert.equal(first.status, "failed");
  assert.equal(first.canonical_count, CANONICAL_MASTER_COUNT);
  assert.equal(first.physical_v3_count, 0);
  assert.equal(first.production_loader_visible, 0);
  assert.equal(first.operational_or_higher, 0);
  assert.equal(first.prompt_lens_count, CANONICAL_MASTER_COUNT - LEGACY_OPERATOR_SEATS);
  assert.equal(first.legacy_v2_count, 4);
  assert.equal(acquisitions.personas.length, CANONICAL_MASTER_COUNT);
  // Acquisition is per-seat work that lags a roster addition; what must hold is that the seats
  // which do have raw material still have it, and that none of it has been adjudicated.
  assert.equal(acquisitions.personas.filter((persona) => persona.retrieved_unadjudicated_count >= 1).length,
    SEATS_WITH_RAW_ACQUISITIONS);
  assert.equal(first.pending_review, unpreparedCount + pendingPreparedCount);
  assert.equal(first.silent_fallback, CANONICAL_MASTER_COUNT);
  assert.equal(first.report_hash, second.report_hash);
  assert.deepEqual(first, second);
  assert.match(renderPersonaV3GaReport(first), /PersonaPack v3 GA gate: FAILED/);
});

test("the physical operational packs are only core-ready; GA remains blocked without versioned physical evidence", (t) => {
  const fixture = completeFixture(t);
  const requirements = {
    require_count: CANONICAL_MASTER_COUNT,
    require_min_admission: "operational",
    forbid_legacy: true,
    forbid_prompt_lens: true,
  };
  const first = buildPersonaV3GaReport({ ...fixture, requirements });
  const second = buildPersonaV3GaReport({ ...fixture, requirements });
  assert.equal(first.status, "failed");
  assert.equal(first.canonical_count, CANONICAL_MASTER_COUNT);
  assert.equal(first.physical_v3_count, CANONICAL_MASTER_COUNT);
  assert.equal(first.production_loader_visible, CANONICAL_MASTER_COUNT);
  assert.equal(first.compiled_count, CANONICAL_MASTER_COUNT);
  assert.equal(first.operational_or_higher, CANONICAL_MASTER_COUNT);
  assert.equal(first.prompt_lens_count, 0);
  assert.equal(first.legacy_v2_count, 0);
  assert.equal(first.invalid, 0);
  assert.equal(first.unsafe, 0);
  assert.equal(first.placeholder, 0);
  assert.equal(first.pending_review, 0);
  assert.equal(first.silent_fallback, 0);
  assert.equal(first.cutover_status.status, "blocked");
  assert.equal(first.report_hash, second.report_hash);
  assert.ok(first.gate_failures.some((failure) => failure.code === "expected_version_required"));
  assert.ok(first.gate_failures.some((failure) => failure.code === "release_manifest_required"));
  assert.ok(first.gate_failures.some((failure) => failure.code === "release_evidence_required"));
});

test("a placeholder or a stricter admission requirement fails without trusting manifest maturity", (t) => {
  const fixture = completeFixture(t, "placeholder");
  const firstId = fixture.canonicalIds[0];
  writeFileSync(join(fixture.knowledgeDir, firstId, "voice.en.md"), "TBD\n");
  const placeholder = buildPersonaV3GaReport({ ...fixture });
  assert.equal(placeholder.status, "failed");
  assert.equal(placeholder.placeholder, 1);
  assert.ok(placeholder.gate_failures.some((failure) => failure.code === "placeholders_present"));

  writeFileSync(join(fixture.knowledgeDir, firstId, "voice.en.md"), "Explain the frozen structured decision.\n");
  const candidate = buildPersonaV3GaReport({
    ...fixture,
    requirements: { require_count: CANONICAL_MASTER_COUNT, require_min_admission: "candidate" },
  });
  assert.equal(candidate.status, "failed");
  assert.ok(candidate.gate_failures.some((failure) => failure.code === "minimum_admission_not_met"));
});

test("a standalone manifest cannot substitute for full immutable release verification", (t) => {
  const fixture = completeFixture(t, "legacy-release-evidence");
  const manifest = join(fixture.root, "legacy-combined.json");
  writeJson(manifest, {
    schema_version: 1,
    artifact_kind: "persona_v3_release_manifest",
    canonical_master_ids: fixture.canonicalIds,
    host: { status: "passed" },
    package: { status: "passed" },
    cutover: { status: "passed" },
    rollback: { status: "passed" },
  });
  const report = buildPersonaV3GaReport({
    ...fixture,
    releaseManifestPath: manifest,
    requirements: { require_release_evidence: true },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.release_manifest.status, "invalid");
  assert.equal(report.release_manifest.full_verification, false);
  assert.ok(report.release_manifest.errors.some((error) => /standalone --release-manifest is not GA evidence/u.test(error)));
  assert.ok(report.gate_failures.some((failure) => failure.code === "release_evidence_required"));
});

test("release-root verification requires release id and externally trusted source-reviewer keys", (t) => {
  const fixture = completeFixture(t, "release-root-inputs");
  const report = buildPersonaV3GaReport({
    ...fixture,
    releaseRoot: join(fixture.root, "releases"),
    requirements: { expected_version: "0.9.0" },
  });
  assert.equal(report.status, "failed");
  assert.equal(report.release_manifest.status, "invalid");
  assert.ok(report.release_manifest.errors.some((error) => /both release root and release id/u.test(error)));

  const missingFormulaTrust = buildPersonaV3GaReport({
    ...fixture,
    releaseRoot: join(fixture.root, "releases"),
    releaseId: "0.9.0-rc.1",
    trustedSourceReviewerKeys: {},
    requirements: { expected_version: "0.9.0" },
  });
  assert.ok(missingFormulaTrust.release_manifest.errors
    .some((error) => /trusted formula reviewer keys are required/u.test(error)));
});

test("the GA report schema is exact enough to prevent claim-shaped drift", () => {
  const schema = JSON.parse(readFileSync(join(ROOT, "schemas/persona-v3-ga-report-v1.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes("physical_v3_count"));
  assert.ok(schema.required.includes("production_loader_visible"));
  assert.ok(schema.required.includes("silent_fallback"));
  assert.ok(schema.required.includes("release_evidence"));
  assert.equal(schema.properties.schema_version.const, 1);
  assert.equal(schema.properties.artifact_kind.const, "persona_v3_ga_report");
});

test("requirements and CLI parsing expose the explicit GA policy", () => {
  assert.deepEqual(normalizeGaRequirements(), {
    require_count: CANONICAL_MASTER_COUNT,
    require_min_admission: "operational",
    forbid_legacy: false,
    forbid_prompt_lens: false,
    require_release_evidence: true,
    expected_version: null,
  });
  const args = parseArgs([
    "--json",
    "--require-count", String(CANONICAL_MASTER_COUNT),
    "--require-min-admission=operational",
    "--forbid-legacy",
    "--forbid-prompt-lens",
    "--require-release-evidence",
    "--expected-version", "0.9.0",
    "--package-json", "/tmp/package.json",
    "--release-root", "/tmp/releases",
    "--release-id", "0.9.0-rc.1",
    "--release-manifest", "/tmp/release-manifest.json",
    "--release-evidence", "/tmp/release-evidence.json",
    "--trusted-source-reviewer-keys", "/tmp/source-reviewer-keys.json",
    "--trusted-formula-reviewer-keys", "/tmp/formula-reviewer-keys.json",
    "--trusted-release-evidence-keys", "/tmp/release-evidence-keys.json",
    "--trusted-release-keys", "/tmp/release-keys.json",
    "--trusted-experiment-adjudication-keys", "/tmp/experiment-keys.json",
    "--knowledge-dir", "/tmp/ga-knowledge",
  ]);
  assert.equal(args.json, true);
  assert.equal(args.requireCount, CANONICAL_MASTER_COUNT);
  assert.equal(args.requireMinAdmission, "operational");
  assert.equal(args.forbidLegacy, true);
  assert.equal(args.forbidPromptLens, true);
  assert.equal(args.requireReleaseEvidence, true);
  assert.equal(args.expectedVersion, "0.9.0");
  assert.equal(args.packageJsonPath, "/tmp/package.json");
  assert.equal(args.releaseRoot, "/tmp/releases");
  assert.equal(args.releaseId, "0.9.0-rc.1");
  assert.equal(args.releaseManifestPath, "/tmp/release-manifest.json");
  assert.equal(args.releaseEvidencePath, "/tmp/release-evidence.json");
  assert.equal(args.trustedReleaseEvidenceKeysFile, "/tmp/release-evidence-keys.json");
  assert.equal(args.trustedReleaseKeysFile, "/tmp/release-keys.json");
  assert.equal(args.trustedSourceReviewerKeysFile, "/tmp/source-reviewer-keys.json");
  assert.equal(args.trustedFormulaReviewerKeysFile, "/tmp/formula-reviewer-keys.json");
  assert.equal(args.trustedExperimentAdjudicationKeysFile, "/tmp/experiment-keys.json");
  assert.equal(args.knowledgeDir, "/tmp/ga-knowledge");
  assert.throws(() => parseArgs(["--require-count", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--require-min-admission", "legendary"]), /must be one of/);
  assert.throws(() => parseArgs(["--expected-version", "v0.9"]), /semantic version/);
  assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
});

test("the default CLI emits JSON before exiting one on the current incomplete worktree", () => {
  const run = runCli(["--json"]);
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, "failed");
  assert.equal(report.physical_v3_count, 0);
  assert.equal(report.canonical_count, CANONICAL_MASTER_COUNT);
});

test("the current solo-test package satisfies version identity but not formal GA", () => {
  const run = runCli(["--json", "--expected-version", CURRENT_PACKAGE_VERSION]);
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.package_version, CURRENT_PACKAGE_VERSION);
  assert.equal(report.expected_version, CURRENT_PACKAGE_VERSION);
  assert.ok(!report.gate_failures.some((failure) => failure.code === "package_json_version_mismatch"));
  assert.ok(report.gate_failures.some((failure) => failure.code === "physical_v3_count_mismatch"));
  assert.ok(report.gate_failures.some((failure) => failure.code === "release_manifest_required"));
  assert.ok(report.gate_failures.some((failure) => failure.code === "release_evidence_required"));
});

test("the CLI refuses a complete core fixture without immutable release and physical external evidence", (t) => {
  const fixture = completeFixture(t, "cli");
  const packageJson = join(fixture.root, "package.json");
  writeJson(packageJson, { name: "alphacouncil-agent", version: "0.9.0" });
  const run = runCli([
    "--json",
    "--personas-dir", fixture.personaDir,
    "--knowledge-dir", fixture.knowledgeDir,
    "--staging-dir", fixture.stagingDir,
    "--package-json", packageJson,
    "--expected-version", "0.9.0",
    "--require-count", String(CANONICAL_MASTER_COUNT),
    "--require-min-admission", "operational",
    "--forbid-legacy",
    "--forbid-prompt-lens",
  ]);
  assert.equal(run.status, 1, `${run.stderr}\n${run.stdout.slice(0, 2000)}`);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, "failed");
  assert.equal(report.physical_v3_count, CANONICAL_MASTER_COUNT);
  assert.equal(report.production_loader_visible, CANONICAL_MASTER_COUNT);
  assert.ok(report.gate_failures.some((failure) => failure.code === "release_manifest_required"));
  assert.ok(report.gate_failures.some((failure) => failure.code === "release_evidence_required"));
});
