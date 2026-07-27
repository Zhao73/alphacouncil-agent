import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  EXPERIMENT_RUN_KEYS,
  buildCaseFreezeFromManifest,
  canonicalArmConfigurationHash,
  checkExperimentArtifactFile,
  computeExperimentArtifactHash,
  experimentArtifactPlan,
  validateExperimentArtifact,
  writeExperimentArtifact,
} from "../../scripts/lib/council-experiment-artifacts.mjs";
import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";

const H = (value) => sha256(value);
const PH = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function arm(overrides = {}) {
  const value = {
    schema_version: 1,
    artifact_kind: "alphacouncil_arm_run_result",
    run_id: "run-A",
    arm_id: "A",
    arm_variant: null,
    protocol_hash: H("protocol"),
    case_freeze_hash: H("freeze"),
    frozen_inputs_hash: H("inputs"),
    arm_configuration_hash: canonicalArmConfigurationHash(overrides.arm_id || "A", overrides.arm_variant ?? null),
    runner_hash: H("runner"),
    model_matrix_hash: H("models"),
    prompt_bundle_hash: H("prompts"),
    host_matrix_hash: H("hosts"),
    status: "completed",
    artifact_directory: "run-artifacts",
    result_bindings: {
      raw_result: { relative_path: "raw-result.json", file_hash: H("result") },
      fact_clusters: { relative_path: "fact-clusters.json", file_hash: H("facts") },
      native_decisions: { relative_path: "native-decisions.json", file_hash: H("native") },
      common_projection: { relative_path: "common-projection.json", file_hash: H("projection") },
    },
    metrics: {
      cost: { currency: "USD", provider_billed_cost: 1.25, input_tokens: 100, output_tokens: 20, tool_calls: 2, network_requests: 1, failed_attempts: 0, retry_attempts: 0 },
      latency: { started_at: "2026-07-27T00:00:00.000Z", completed_at: "2026-07-27T00:00:01.000Z", critical_path_ms: 1000, timed_out: false },
      sources: { retrieval_count: 2, material_claim_count: 3, citation_count: 3, source_manifest_hash: H("sources") },
    },
    degradation: [],
    human_boundary: null,
    artifact_hash: H("placeholder"),
    attestations: [],
    ...overrides,
  };
  value.artifact_hash = computeExperimentArtifactHash(value);
  return value;
}

test("experiment plan is canonical, no-cost and non-executing", () => {
  const plan = experimentArtifactPlan();
  assert.deepEqual(plan.run_keys, EXPERIMENT_RUN_KEYS);
  assert.equal(plan.execution, "not_run");
  assert.equal(plan.paid_model_calls, 0);
});

test("published experiment schemas are parseable and preserve non-self-certifying fields", () => {
  for (const name of ["council-case-freeze-v1", "council-arm-run-result-v1", "council-experiment-result-manifest-v1"]) {
    const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas", `${name}.schema.json`), "utf8"));
    assert.equal(schema.properties.schema_version.const, 1);
    assert.equal(schema.properties.attestations.maxItems, 0);
  }
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "schemas/council-experiment-result-manifest-v1.schema.json"), "utf8"));
  assert.deepEqual(manifest.properties.run_order.const, EXPERIMENT_RUN_KEYS);
  assert.equal(manifest.properties.passed_claims.maxItems, 0);
  assert.equal(manifest.properties.promotion_effect.const, "none");
});

test("case-freeze builder hashes 48 physical inputs across at least 36 clusters and saves only explicitly", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-case-freeze-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = Array.from({ length: 48 }, (_, index) => {
    const inputPath = `case-${index}.json`;
    writeFileSync(join(dir, inputPath), `${JSON.stringify({ case: index, outcome: "withheld" })}\n`);
    return {
      case_id: `case-${index}`,
      issuer: `issuer-${index % 36}`,
      event: `event-${index}`,
      market_regime: `regime-${index % 4}`,
      as_of: "2026-07-27T00:00:00.000Z",
      input_path: inputPath,
      question_hash: H(`question-${index}`),
      fact_pack_hash: H(`facts-${index}`),
    };
  });
  const manifest = join(dir, "build.json");
  writeFileSync(manifest, `${JSON.stringify({ schema_version: 1, manifest_kind: "alphacouncil_case_freeze_build_manifest", freeze_id: "freeze-1", protocol_hash: H("protocol"), created_at: "2026-07-27T00:00:01.000Z", cases }, null, 2)}\n`);
  const artifact = buildCaseFreezeFromManifest(manifest);
  assert.equal(artifact.cases.length, 48);
  assert.equal(artifact.outcomes_withheld, true);
  assert.equal(validateExperimentArtifact(artifact).valid, true);
  assert.equal(artifact.case_order[47], "case-47");
  const output = join(dir, "freeze.json");
  const saved = writeExperimentArtifact(artifact, output);
  assert.equal(saved.mode, process.platform === "win32" ? "windows_acl_not_verified" : "0600");
  assert.throws(() => writeExperimentArtifact(artifact, output), /overwrite/);
});

test("case-freeze builder rejects symlink inputs and an undersized case ledger", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-case-freeze-invalid-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const physical = join(dir, "physical.json");
  writeFileSync(physical, "{}\n");
  symlinkSync(physical, join(dir, "link.json"));
  const base = { case_id: "case-0", issuer: "issuer", event: "event", market_regime: "regime", as_of: "2026-07-27T00:00:00.000Z", input_path: "link.json", question_hash: H("q"), fact_pack_hash: H("f") };
  const manifest = join(dir, "build.json");
  writeFileSync(manifest, `${JSON.stringify({ schema_version: 1, manifest_kind: "alphacouncil_case_freeze_build_manifest", freeze_id: "freeze-1", protocol_hash: H("protocol"), created_at: "2026-07-27T00:00:01.000Z", cases: [base] })}\n`);
  assert.throws(() => buildCaseFreezeFromManifest(manifest), /without following symlinks/);
  base.input_path = "physical.json";
  writeFileSync(manifest, `${JSON.stringify({ schema_version: 1, manifest_kind: "alphacouncil_case_freeze_build_manifest", freeze_id: "freeze-1", protocol_hash: H("protocol"), created_at: "2026-07-27T00:00:01.000Z", cases: [base] })}\n`);
  assert.throws(
    () => buildCaseFreezeFromManifest(manifest),
    (error) => error.errors.some((detail) => /at least 48 shared cases/.test(detail)),
  );
});

test("arm result enforces canonical IDs, E variants, metrics and hash binding", () => {
  assert.equal(validateExperimentArtifact(arm()).valid, true);
  const bad = arm({ metrics: { cost: {}, latency: {}, sources: {} } });
  bad.arm_id = "D27";
  bad.artifact_hash = computeExperimentArtifactHash(bad);
  const result = validateExperimentArtifact(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /arm_id/.test(error)));
  assert.ok(result.errors.some((error) => /metrics\.cost/.test(error)));
  const e = arm({ arm_id: "E", arm_variant: "D13" });
  e.arm_variant = null;
  e.artifact_hash = computeExperimentArtifactHash(e);
  assert.ok(validateExperimentArtifact(e).errors.some((error) => /arm_variant for E/.test(error)));
});

test("arbitrary completed-run hash strings are declarations, not valid physical evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-arm-physical-required-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "run.json");
  writeFileSync(file, `${JSON.stringify(arm(), null, 2)}\n`);
  const checked = checkExperimentArtifactFile(file);
  assert.equal(checked.valid, false);
  assert.ok(checked.errors.some((error) => /artifact_directory must be a physical directory/u.test(error)));
});

test("H requires a blinded separate human adjudicator and rejects a revealing label", () => {
  const h = arm({
    arm_id: "H",
    human_boundary: {
      blind_label: "H",
      independent_analyst_count: 2,
      independent_before_adjudication: true,
      separate_adjudicator: true,
      adjudicator_blinded_to_arm: true,
      automated_vote: false,
      adjudication_packet_hash: H("adjudication"),
    },
  });
  const invalid = validateExperimentArtifact(h);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => /must not reveal arm H/.test(error)));
  h.human_boundary.blind_label = "blind-07";
  h.artifact_hash = computeExperimentArtifactHash(h);
  assert.equal(validateExperimentArtifact(h).valid, true);
});

test("not_run needs a reason and cannot carry invented result hashes", () => {
  const result = validateExperimentArtifact(arm({ status: "not_run", degradation: [] }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /path\/hash must be null unless status is completed/.test(error)));
  assert.ok(result.errors.some((error) => /not_run requires/.test(error)));
});

test("manifest physical verification binds all eight runs to one freeze", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-artifacts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runs = EXPERIMENT_RUN_KEYS.map((runKey, index) => {
    const [armId, armVariant = null] = runKey.split(":");
    const artifactDirectory = `run-${index}-artifacts`;
    const physicalDirectory = join(dir, artifactDirectory);
    mkdirSync(physicalDirectory);
    const names = {
      raw_result: "raw-result.json",
      fact_clusters: "fact-clusters.json",
      native_decisions: "native-decisions.json",
      common_projection: "common-projection.json",
    };
    for (const [field, name] of Object.entries(names)) writeFileSync(join(physicalDirectory, name), `${field}:${runKey}\n`);
    const result = arm({
      run_id: `run-${runKey}`,
      arm_id: armId,
      arm_variant: armVariant,
      artifact_directory: artifactDirectory,
      result_bindings: Object.fromEntries(Object.entries(names).map(([field, name]) => [field, {
        relative_path: name,
        file_hash: PH(readFileSync(join(physicalDirectory, name))),
      }])),
    });
    if (armId === "H") {
      result.human_boundary = { blind_label: "blind-07", independent_analyst_count: 2, independent_before_adjudication: true, separate_adjudicator: true, adjudicator_blinded_to_arm: true, automated_vote: false, adjudication_packet_hash: H("adjudication") };
      result.artifact_hash = computeExperimentArtifactHash(result);
    }
    const path = `run-${index}.json`;
    writeFileSync(join(dir, path), `${JSON.stringify(result, null, 2)}\n`);
    return {
      run_key: runKey,
      arm_id: armId,
      arm_variant: armVariant,
      artifact_path: path,
      artifact_file_hash: H(readFileSync(join(dir, path), "utf8")),
      artifact_hash: result.artifact_hash,
      case_freeze_hash: H("freeze"),
      frozen_inputs_hash: H("inputs"),
      status: "completed",
    };
  });
  const manifest = {
    schema_version: 1,
    artifact_kind: "alphacouncil_experiment_result_manifest",
    manifest_id: "manifest-1",
    protocol_hash: H("protocol"),
    case_freeze_hash: H("freeze"),
    frozen_inputs_hash: H("inputs"),
    created_at: "2026-07-27T00:00:02.000Z",
    run_order: EXPERIMENT_RUN_KEYS,
    runs,
    human_adjudication: { arm_identity_blinded: true, separate_named_human_required: true, automated_adjudicator_forbidden: true, adjudication_artifact_hash: H("human-final") },
    result_status: "ready_for_external_signature",
    passed_claims: [],
    promotion_effect: "none",
    artifact_hash: H("placeholder"),
    attestations: [],
  };
  manifest.artifact_hash = computeExperimentArtifactHash(manifest);
  const file = join(dir, "manifest.json");
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(checkExperimentArtifactFile(file, { artifactDirectory: dir }).valid, true);
  writeFileSync(join(dir, "run-2-artifacts", "fact-clusters.json"), "tampered\n");
  assert.ok(checkExperimentArtifactFile(file, { artifactDirectory: dir }).errors.some((error) => /fact_clusters physical file hash mismatch/.test(error)));
});

test("CLI defaults to plan and rejects a symlink import source", (t) => {
  const plan = spawnSync(process.execPath, ["scripts/council-experiment-artifacts.mjs"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).mode, "plan_only");
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-artifact-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const physical = join(dir, "result.json");
  const link = join(dir, "link.json");
  writeFileSync(physical, `${JSON.stringify(arm())}\n`);
  try {
    symlinkSync(physical, link, "file");
  } catch (error) {
    if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
      t.skip(`file symlinks are unavailable on this Windows runner (${error.code})`);
      return;
    }
    throw error;
  }
  const result = spawnSync(process.execPath, ["scripts/council-experiment-artifacts.mjs", "--import-result", "--file", link, "--output", join(dir, "out")], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /physical regular file/);
});
