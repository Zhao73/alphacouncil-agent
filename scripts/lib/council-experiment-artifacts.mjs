import { createHash } from "node:crypto";
import { closeSync, copyFileSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { CANONICAL_ARM_IDS, REPO_ROOT, loadCouncilEvaluationProtocol } from "./council-evaluation-protocol.mjs";
import { canonicalJson, canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";

export const EXPERIMENT_RUN_KEYS = Object.freeze(["A", "B", "C", "D13", "D26", "E:D13", "E:D26", "H"]);
export const EXPERIMENT_ARTIFACT_KINDS = Object.freeze([
  "alphacouncil_case_freeze",
  "alphacouncil_arm_run_result",
  "alphacouncil_experiment_result_manifest",
]);
const CANONICAL_PROTOCOL = loadCouncilEvaluationProtocol();

const HASH = /^sha256:[a-f0-9]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ARM_RESULT_BINDING_KEYS = Object.freeze([
  "raw_result",
  "fact_clusters",
  "native_decisions",
  "common_projection",
]);

export class ExperimentArtifactError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "ExperimentArtifactError";
    this.errors = errors;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const missing = wanted.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !wanted.includes(key));
  if (missing.length) errors.push(`${path} missing fields: ${missing.join(", ")}`);
  if (extra.length) errors.push(`${path} unknown fields: ${extra.join(", ")}`);
  return missing.length === 0 && extra.length === 0;
}

function expectHash(value, path, errors) {
  if (!HASH.test(value || "")) errors.push(`${path} must be a canonical sha256 hash`);
}

function expectDate(value, path, errors) {
  if (!DATE.test(value || "") || Number.isNaN(Date.parse(value))) errors.push(`${path} must be a UTC date-time`);
}

function expectString(value, path, errors) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${path} must be a non-empty string`);
}

function safeRelative(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !value || isAbsolute(value) || value.split(/[\\/]/u).includes("..")) {
    errors.push(`${path} must be a safe relative path${nullable ? " or null" : ""}`);
  }
}

function safeDirectory(value, path, errors, { nullable = false } = {}) {
  if (nullable && value === null) return;
  expectString(value, path, errors);
  if (typeof value === "string" && !isAbsolute(value) && value.split(/[\\/]/u).includes("..")) {
    errors.push(`${path} must be an absolute path or a safe relative path${nullable ? " or null" : ""}`);
  }
}

function validateArmResultBinding(value, path, errors) {
  if (!exactKeys(value, ["relative_path", "file_hash"], path, errors)) return;
  safeRelative(value.relative_path, `${path}.relative_path`, errors, { nullable: true });
  if (value.file_hash !== null) expectHash(value.file_hash, `${path}.file_hash`, errors);
  if ((value.relative_path === null) !== (value.file_hash === null)) {
    errors.push(`${path} relative path and hash must either both be null or both be present`);
  }
}

function uniqueStrings(value, path, errors, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) {
    errors.push(`${path} must contain at least ${min} item(s)`);
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    expectString(item, `${path}[${index}]`, errors);
    if (seen.has(item)) errors.push(`${path}[${index}] duplicates ${JSON.stringify(item)}`);
    seen.add(item);
  });
}

export function artifactSubject(artifact) {
  if (!isObject(artifact)) return artifact;
  const { artifact_hash: ignoredHash, attestations: ignoredAttestations, ...subject } = artifact;
  return canonicalValue(subject);
}

export function computeExperimentArtifactHash(artifact) {
  return sha256({
    hash_domain: `alphacouncil.${artifact?.artifact_kind || "unknown"}.v1`,
    subject: artifactSubject(artifact),
  });
}

function validateEnvelope(artifact, expectedKind, errors) {
  if (!isObject(artifact)) {
    errors.push("artifact must be an object");
    return;
  }
  if (artifact.schema_version !== 1) errors.push("schema_version must be 1");
  if (artifact.artifact_kind !== expectedKind) errors.push(`artifact_kind must be ${expectedKind}`);
  expectHash(artifact.artifact_hash, "artifact_hash", errors);
  if (!Array.isArray(artifact.attestations) || artifact.attestations.length !== 0) {
    errors.push("attestations must remain empty; this collector cannot self-certify a result");
  }
  if (HASH.test(artifact.artifact_hash || "")) {
    const expected = computeExperimentArtifactHash(artifact);
    if (artifact.artifact_hash !== expected) errors.push(`artifact_hash mismatch; expected ${expected}`);
  }
}

function validateCaseFreeze(artifact, errors) {
  exactKeys(artifact, [
    "schema_version", "artifact_kind", "freeze_id", "protocol_hash", "created_at", "case_order",
    "cases", "frozen_inputs_hash", "outcomes_withheld", "artifact_hash", "attestations",
  ], "case freeze", errors);
  validateEnvelope(artifact, "alphacouncil_case_freeze", errors);
  expectString(artifact.freeze_id, "freeze_id", errors);
  expectHash(artifact.protocol_hash, "protocol_hash", errors);
  expectDate(artifact.created_at, "created_at", errors);
  uniqueStrings(artifact.case_order, "case_order", errors, { min: 1 });
  if (!Array.isArray(artifact.cases) || artifact.cases.length !== artifact.case_order?.length) {
    errors.push("cases must match case_order length");
  } else {
    if (artifact.cases.length < CANONICAL_PROTOCOL.case_design.minimum_shared_cases) errors.push(`cases must contain at least ${CANONICAL_PROTOCOL.case_design.minimum_shared_cases} shared cases`);
    const ids = [];
    artifact.cases.forEach((item, index) => {
      const path = `cases[${index}]`;
      if (!exactKeys(item, ["case_id", "issuer", "event", "market_regime", "as_of", "input_path", "question_hash", "input_file_hash", "fact_pack_hash"], path, errors)) return;
      ids.push(item.case_id);
      for (const field of ["case_id", "issuer", "event", "market_regime"]) expectString(item[field], `${path}.${field}`, errors);
      if (typeof item.input_path !== "string" || !item.input_path || isAbsolute(item.input_path) || item.input_path.split(/[\\/]/u).includes("..")) errors.push(`${path}.input_path must be a safe relative path`);
      expectDate(item.as_of, `${path}.as_of`, errors);
      for (const field of ["question_hash", "input_file_hash", "fact_pack_hash"]) expectHash(item[field], `${path}.${field}`, errors);
    });
    if (JSON.stringify(ids) !== JSON.stringify(artifact.case_order)) errors.push("cases must appear in exact case_order");
    const clusters = new Set(artifact.cases.map((item) => `${item.issuer}\u0000${item.event}\u0000${item.market_regime}`));
    if (clusters.size < CANONICAL_PROTOCOL.case_design.minimum_historical_clusters) errors.push(`cases must contain at least ${CANONICAL_PROTOCOL.case_design.minimum_historical_clusters} issuer/event/regime clusters`);
  }
  if (artifact.outcomes_withheld !== true) errors.push("outcomes_withheld must be true at case freeze");
  expectHash(artifact.frozen_inputs_hash, "frozen_inputs_hash", errors);
  const expectedInputs = sha256({ case_order: artifact.case_order, cases: artifact.cases });
  if (artifact.frozen_inputs_hash !== expectedInputs) errors.push(`frozen_inputs_hash mismatch; expected ${expectedInputs}`);
}

function validateResourceMetrics(metrics, errors) {
  if (!exactKeys(metrics, ["cost", "latency", "sources"], "metrics", errors)) return;
  if (exactKeys(metrics.cost, ["currency", "provider_billed_cost", "input_tokens", "output_tokens", "tool_calls", "network_requests", "failed_attempts", "retry_attempts"], "metrics.cost", errors)) {
    if (metrics.cost.currency !== "USD") errors.push("metrics.cost.currency must be USD");
    if (metrics.cost.provider_billed_cost !== null && (!Number.isFinite(metrics.cost.provider_billed_cost) || metrics.cost.provider_billed_cost < 0)) errors.push("metrics.cost.provider_billed_cost must be null or >= 0");
    for (const field of ["input_tokens", "output_tokens", "tool_calls", "network_requests", "failed_attempts", "retry_attempts"]) {
      if (!Number.isInteger(metrics.cost[field]) || metrics.cost[field] < 0) errors.push(`metrics.cost.${field} must be an integer >= 0`);
    }
  }
  if (exactKeys(metrics.latency, ["started_at", "completed_at", "critical_path_ms", "timed_out"], "metrics.latency", errors)) {
    expectDate(metrics.latency.started_at, "metrics.latency.started_at", errors);
    expectDate(metrics.latency.completed_at, "metrics.latency.completed_at", errors);
    if (!Number.isInteger(metrics.latency.critical_path_ms) || metrics.latency.critical_path_ms < 0) errors.push("metrics.latency.critical_path_ms must be an integer >= 0");
    if (typeof metrics.latency.timed_out !== "boolean") errors.push("metrics.latency.timed_out must be boolean");
    if (Date.parse(metrics.latency.completed_at) < Date.parse(metrics.latency.started_at)) errors.push("metrics.latency.completed_at must not precede started_at");
  }
  if (exactKeys(metrics.sources, ["retrieval_count", "material_claim_count", "citation_count", "source_manifest_hash"], "metrics.sources", errors)) {
    for (const field of ["retrieval_count", "material_claim_count", "citation_count"]) {
      if (!Number.isInteger(metrics.sources[field]) || metrics.sources[field] < 0) errors.push(`metrics.sources.${field} must be an integer >= 0`);
    }
    expectHash(metrics.sources.source_manifest_hash, "metrics.sources.source_manifest_hash", errors);
  }
}

function validateHumanBoundary(value, isHuman, errors) {
  if (!isHuman) {
    if (value !== null) errors.push("human_boundary must be null for machine arms");
    return;
  }
  if (!exactKeys(value, ["blind_label", "independent_analyst_count", "independent_before_adjudication", "separate_adjudicator", "adjudicator_blinded_to_arm", "automated_vote", "adjudication_packet_hash"], "human_boundary", errors)) return;
  expectString(value.blind_label, "human_boundary.blind_label", errors);
  if (![2, 3].includes(value.independent_analyst_count)) errors.push("human_boundary.independent_analyst_count must be 2 or 3");
  for (const field of ["independent_before_adjudication", "separate_adjudicator", "adjudicator_blinded_to_arm"]) if (value[field] !== true) errors.push(`human_boundary.${field} must be true`);
  if (value.automated_vote !== false) errors.push("human_boundary.automated_vote must be false");
  expectHash(value.adjudication_packet_hash, "human_boundary.adjudication_packet_hash", errors);
  if (/^(?:H|human)$/iu.test(value.blind_label)) errors.push("human_boundary.blind_label must not reveal arm H");
}

function validateArmRun(artifact, errors) {
  exactKeys(artifact, [
    "schema_version", "artifact_kind", "run_id", "arm_id", "arm_variant", "protocol_hash",
    "case_freeze_hash", "frozen_inputs_hash", "arm_configuration_hash", "runner_hash", "model_matrix_hash", "prompt_bundle_hash",
    "host_matrix_hash", "status", "artifact_directory", "result_bindings", "metrics", "degradation",
    "human_boundary", "artifact_hash", "attestations",
  ], "arm run", errors);
  validateEnvelope(artifact, "alphacouncil_arm_run_result", errors);
  expectString(artifact.run_id, "run_id", errors);
  if (!CANONICAL_ARM_IDS.includes(artifact.arm_id)) errors.push(`arm_id must be one of ${CANONICAL_ARM_IDS.join(", ")}`);
  if (artifact.arm_id === "E") {
    if (!["D13", "D26"].includes(artifact.arm_variant)) errors.push("arm_variant for E must be D13 or D26");
  } else if (artifact.arm_variant !== null) errors.push("arm_variant must be null except for E");
  for (const field of ["protocol_hash", "case_freeze_hash", "frozen_inputs_hash", "arm_configuration_hash", "runner_hash", "model_matrix_hash", "prompt_bundle_hash", "host_matrix_hash"]) expectHash(artifact[field], field, errors);
  const protocolArm = CANONICAL_PROTOCOL.arms.find((arm) => arm.arm_id === artifact.arm_id);
  if (protocolArm) {
    const expectedConfig = sha256({
      arm_id: protocolArm.arm_id,
      execution_mode: protocolArm.execution_mode,
      analyst_ids: protocolArm.analyst_ids,
      master_ids: protocolArm.master_ids,
      verifier_ids: protocolArm.verifier_ids,
      base_arm_ids: protocolArm.base_arm_ids,
      master_execution_mode: protocolArm.master_execution_mode,
      bounded_repair: protocolArm.bounded_repair,
      human_reference: protocolArm.human_reference,
      arm_variant: artifact.arm_variant,
    });
    if (artifact.arm_configuration_hash !== expectedConfig) errors.push(`arm_configuration_hash mismatch; expected ${expectedConfig}`);
  }
  if (!["completed", "failed", "not_run"].includes(artifact.status)) errors.push("status must be completed, failed or not_run");
  safeDirectory(artifact.artifact_directory, "artifact_directory", errors, { nullable: true });
  if (exactKeys(artifact.result_bindings, ARM_RESULT_BINDING_KEYS, "result_bindings", errors)) {
    for (const field of ARM_RESULT_BINDING_KEYS) validateArmResultBinding(artifact.result_bindings[field], `result_bindings.${field}`, errors);
  }
  if (artifact.status === "completed") {
    if (artifact.artifact_directory === null) errors.push("completed requires a declared artifact_directory");
    for (const field of ARM_RESULT_BINDING_KEYS) {
      if (!artifact.result_bindings?.[field]?.relative_path || !HASH.test(artifact.result_bindings?.[field]?.file_hash || "")) {
        errors.push(`completed requires physical result_bindings.${field} path/hash`);
      }
    }
  } else {
    if (artifact.artifact_directory !== null) errors.push("artifact_directory must be null unless status is completed");
    for (const field of ARM_RESULT_BINDING_KEYS) {
      if (artifact.result_bindings?.[field]?.relative_path !== null || artifact.result_bindings?.[field]?.file_hash !== null) {
        errors.push(`result_bindings.${field} path/hash must be null unless status is completed`);
      }
    }
  }
  validateResourceMetrics(artifact.metrics, errors);
  uniqueStrings(artifact.degradation, "degradation", errors);
  if (artifact.status === "completed" && artifact.metrics?.cost?.provider_billed_cost === null) errors.push("completed runs require measured provider_billed_cost; use numeric 0 for a genuinely free run");
  if (artifact.status === "not_run" && artifact.degradation.length === 0) errors.push("not_run requires at least one degradation/blocker reason");
  validateHumanBoundary(artifact.human_boundary, artifact.arm_id === "H", errors);
}

function validateResultManifest(artifact, errors) {
  exactKeys(artifact, [
    "schema_version", "artifact_kind", "manifest_id", "protocol_hash", "case_freeze_hash",
    "frozen_inputs_hash", "created_at", "run_order", "runs", "human_adjudication", "result_status",
    "passed_claims", "promotion_effect", "artifact_hash", "attestations",
  ], "result manifest", errors);
  validateEnvelope(artifact, "alphacouncil_experiment_result_manifest", errors);
  expectString(artifact.manifest_id, "manifest_id", errors);
  for (const field of ["protocol_hash", "case_freeze_hash", "frozen_inputs_hash"]) expectHash(artifact[field], field, errors);
  expectDate(artifact.created_at, "created_at", errors);
  if (JSON.stringify(artifact.run_order) !== JSON.stringify(EXPERIMENT_RUN_KEYS)) errors.push(`run_order must be ${EXPERIMENT_RUN_KEYS.join(", ")}`);
  if (!Array.isArray(artifact.runs) || artifact.runs.length !== EXPERIMENT_RUN_KEYS.length) errors.push("runs must contain exactly eight canonical run bindings");
  else artifact.runs.forEach((run, index) => {
    const path = `runs[${index}]`;
    if (!exactKeys(run, ["run_key", "arm_id", "arm_variant", "artifact_path", "artifact_file_hash", "artifact_hash", "case_freeze_hash", "frozen_inputs_hash", "status"], path, errors)) return;
    if (run.run_key !== EXPERIMENT_RUN_KEYS[index]) errors.push(`${path}.run_key drifted`);
    const [id, variant = null] = EXPERIMENT_RUN_KEYS[index].split(":");
    if (run.arm_id !== id || run.arm_variant !== variant) errors.push(`${path} arm identity does not match run_key`);
    if (typeof run.artifact_path !== "string" || !run.artifact_path || isAbsolute(run.artifact_path) || run.artifact_path.split(/[\\/]/u).includes("..")) errors.push(`${path}.artifact_path must be a safe relative path`);
    for (const field of ["artifact_file_hash", "artifact_hash", "case_freeze_hash", "frozen_inputs_hash"]) expectHash(run[field], `${path}.${field}`, errors);
    if (run.case_freeze_hash !== artifact.case_freeze_hash || run.frozen_inputs_hash !== artifact.frozen_inputs_hash) errors.push(`${path} is not bound to the manifest's same frozen inputs`);
    if (!["completed", "failed", "not_run"].includes(run.status)) errors.push(`${path}.status is invalid`);
  });
  if (!exactKeys(artifact.human_adjudication, ["arm_identity_blinded", "separate_named_human_required", "automated_adjudicator_forbidden", "adjudication_artifact_hash"], "human_adjudication", errors)) return;
  if (artifact.human_adjudication.arm_identity_blinded !== true || artifact.human_adjudication.separate_named_human_required !== true || artifact.human_adjudication.automated_adjudicator_forbidden !== true) errors.push("human_adjudication must preserve the blinded named-human boundary");
  expectHash(artifact.human_adjudication.adjudication_artifact_hash, "human_adjudication.adjudication_artifact_hash", errors);
  if (!['incomplete', 'ready_for_external_signature'].includes(artifact.result_status)) errors.push("result_status must be incomplete or ready_for_external_signature");
  if (artifact.result_status === "ready_for_external_signature" && artifact.runs?.some((run) => run.status !== "completed")) errors.push("ready_for_external_signature requires every canonical run to be completed");
  if (!Array.isArray(artifact.passed_claims) || artifact.passed_claims.length !== 0) errors.push("passed_claims must remain empty in a non-self-certifying manifest");
  if (artifact.promotion_effect !== "none") errors.push("promotion_effect must remain none");
}

export function validateExperimentArtifact(artifact) {
  const errors = [];
  const kind = artifact?.artifact_kind;
  if (kind === "alphacouncil_case_freeze") validateCaseFreeze(artifact, errors);
  else if (kind === "alphacouncil_arm_run_result") validateArmRun(artifact, errors);
  else if (kind === "alphacouncil_experiment_result_manifest") validateResultManifest(artifact, errors);
  else errors.push(`unsupported artifact_kind: ${JSON.stringify(kind)}`);
  return { valid: errors.length === 0, errors, artifact_kind: kind || null, artifact_hash: artifact?.artifact_hash || null };
}

export function readPhysicalJson(file) {
  const physical = readPhysicalBytesNoFollow(resolve(file), "experiment artifact");
  let value;
  try { value = JSON.parse(physical.bytes.toString("utf8")); } catch (error) {
    throw new ExperimentArtifactError(`experiment artifact is invalid JSON: ${error.message}`);
  }
  return { ...physical, value };
}

function readPhysicalBytesNoFollow(file, label) {
  const absolute = resolve(file);
  let descriptor;
  try {
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
      throw new ExperimentArtifactError(`${label} cannot be opened without following symlinks as a physical regular file: ${absolute}`);
    }
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new ExperimentArtifactError(`${label} must be a physical regular file: ${absolute}`);
    return { absolute: realpathSync(absolute), bytes: readFileSync(descriptor) };
  } catch (error) {
    if (error instanceof ExperimentArtifactError) throw error;
    throw new ExperimentArtifactError(`${label} cannot be opened without following symlinks: ${absolute} (${error.code || error.message})`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function buildCaseFreezeFromManifest(manifestFile) {
  const manifestPath = resolve(manifestFile);
  const manifestBytes = readPhysicalBytesNoFollow(manifestPath, "case-freeze build manifest").bytes;
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch (error) { throw new ExperimentArtifactError(`case-freeze build manifest is invalid JSON: ${error.message}`); }
  const errors = [];
  if (!exactKeys(manifest, ["schema_version", "manifest_kind", "freeze_id", "protocol_hash", "created_at", "cases"], "case-freeze build manifest", errors)) throw new ExperimentArtifactError("case-freeze build manifest is invalid", errors);
  if (manifest.schema_version !== 1) errors.push("case-freeze build manifest schema_version must be 1");
  if (manifest.manifest_kind !== "alphacouncil_case_freeze_build_manifest") errors.push("case-freeze build manifest_kind is invalid");
  expectString(manifest.freeze_id, "freeze_id", errors);
  expectHash(manifest.protocol_hash, "protocol_hash", errors);
  expectDate(manifest.created_at, "created_at", errors);
  if (!Array.isArray(manifest.cases)) errors.push("cases must be an array");
  if (errors.length) throw new ExperimentArtifactError("case-freeze build manifest is invalid", errors);

  const base = realpathSync(dirname(manifestPath));
  const cases = manifest.cases.map((item, index) => {
    const path = `cases[${index}]`;
    const itemErrors = [];
    exactKeys(item, ["case_id", "issuer", "event", "market_regime", "as_of", "input_path", "question_hash", "fact_pack_hash"], path, itemErrors);
    for (const field of ["case_id", "issuer", "event", "market_regime"]) expectString(item[field], `${path}.${field}`, itemErrors);
    expectDate(item.as_of, `${path}.as_of`, itemErrors);
    for (const field of ["question_hash", "fact_pack_hash"]) expectHash(item[field], `${path}.${field}`, itemErrors);
    if (typeof item.input_path !== "string" || !item.input_path || isAbsolute(item.input_path) || item.input_path.split(/[\\/]/u).includes("..")) itemErrors.push(`${path}.input_path must be a safe relative path`);
    if (itemErrors.length) throw new ExperimentArtifactError("case-freeze build manifest has an invalid case", itemErrors);
    const target = resolve(base, item.input_path);
    const back = relative(base, target);
    if (back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new ExperimentArtifactError(`${path}.input_path leaves the manifest directory`);
    const bytes = readPhysicalBytesNoFollow(target, `${path}.input_path`).bytes;
    return canonicalValue({
      case_id: item.case_id,
      issuer: item.issuer,
      event: item.event,
      market_regime: item.market_regime,
      as_of: item.as_of,
      input_path: item.input_path,
      question_hash: item.question_hash,
      input_file_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      fact_pack_hash: item.fact_pack_hash,
    });
  });
  const artifact = {
    schema_version: 1,
    artifact_kind: "alphacouncil_case_freeze",
    freeze_id: manifest.freeze_id,
    protocol_hash: manifest.protocol_hash,
    created_at: manifest.created_at,
    case_order: cases.map((item) => item.case_id),
    cases,
    frozen_inputs_hash: sha256({ case_order: cases.map((item) => item.case_id), cases }),
    outcomes_withheld: true,
    artifact_hash: null,
    attestations: [],
  };
  artifact.artifact_hash = computeExperimentArtifactHash(artifact);
  const validation = validateExperimentArtifact(artifact);
  if (!validation.valid) throw new ExperimentArtifactError("built case freeze failed validation", validation.errors);
  return canonicalValue(artifact);
}

export function writeExperimentArtifact(artifact, outputFile, { repoRoot = REPO_ROOT } = {}) {
  const validation = validateExperimentArtifact(artifact);
  if (!validation.valid) throw new ExperimentArtifactError("only a valid experiment artifact may be saved", validation.errors);
  const target = resolve(outputFile);
  if (existsSync(target)) throw new ExperimentArtifactError(`refusing to overwrite existing artifact: ${target}`);
  const parent = realpathSync(dirname(target));
  if (!statSync(parent).isDirectory()) throw new ExperimentArtifactError(`output parent must be a physical directory: ${parent}`);
  const physicalTarget = join(parent, basename(target));
  const knowledgeRoot = resolve(repoRoot, "knowledge");
  const back = relative(knowledgeRoot, physicalTarget);
  if (back === "" || (back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back))) throw new ExperimentArtifactError("refusing to write experiment evidence into the production knowledge tree");
  writeFileSync(physicalTarget, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const mode = statSync(physicalTarget).mode & 0o777;
  if (mode !== 0o600) throw new ExperimentArtifactError(`saved artifact permissions are not 0600: ${mode.toString(8)}`);
  return canonicalValue({ status: "saved_unsigned_artifact", artifact_kind: artifact.artifact_kind, artifact_hash: artifact.artifact_hash, file_hash: physicalHash(physicalTarget), output_file: physicalTarget, mode: "0600" });
}

function physicalHash(file) {
  const physical = readPhysicalBytesNoFollow(file, "physical artifact");
  return `sha256:${createHash("sha256").update(physical.bytes).digest("hex")}`;
}

function physicalDirectory(path, label) {
  const target = resolve(path);
  if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !statSync(target).isDirectory()) {
    throw new ExperimentArtifactError(`${label} must be a physical directory: ${target}`);
  }
  return realpathSync(target);
}

function containedFile(base, path, label) {
  const target = resolve(base, path);
  const back = relative(base, target);
  if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new ExperimentArtifactError(`${label} escapes its declared artifact directory`);
  }
  if (existsSync(target)) {
    const physical = realpathSync(target);
    const physicalBack = relative(base, physical);
    if (physicalBack === "" || physicalBack === ".." || physicalBack.startsWith(`..${sep}`) || isAbsolute(physicalBack)) {
      throw new ExperimentArtifactError(`${label} uses a symlinked path component that escapes its declared artifact directory`);
    }
  }
  return target;
}

function verifyArmResultFiles(artifact, artifactFile, errors) {
  const verified = {};
  if (artifact.status !== "completed") return verified;
  try {
    const declared = isAbsolute(artifact.artifact_directory)
      ? artifact.artifact_directory
      : resolve(dirname(artifactFile), artifact.artifact_directory);
    const base = physicalDirectory(declared, "arm artifact_directory");
    for (const field of ARM_RESULT_BINDING_KEYS) {
      const binding = artifact.result_bindings[field];
      const opened = readPhysicalBytesNoFollow(containedFile(base, binding.relative_path, `result_bindings.${field}`), `result_bindings.${field}`);
      const actual = `sha256:${createHash("sha256").update(opened.bytes).digest("hex")}`;
      if (actual !== binding.file_hash) errors.push(`result_bindings.${field} physical file hash mismatch; expected ${binding.file_hash}, got ${actual}`);
      else verified[field] = canonicalValue({ relative_path: binding.relative_path, physical_path: opened.absolute, file_hash: actual });
    }
  } catch (error) {
    errors.push(error.message);
  }
  return verified;
}

function validateReferencedFiles(artifact, artifactFile, artifactDirectory, errors) {
  if (artifact.artifact_kind === "alphacouncil_arm_run_result") {
    return { result_bindings: verifyArmResultFiles(artifact, artifactFile, errors), runs: {} };
  }
  const verifiedRuns = {};
  const requestedBase = artifactDirectory ? resolve(artifactDirectory) : dirname(artifactFile);
  let base;
  try { base = physicalDirectory(requestedBase, "artifact reference directory"); } catch (error) {
    errors.push(error.message);
    return { result_bindings: {}, runs: verifiedRuns };
  }
  const refs = artifact.artifact_kind === "alphacouncil_case_freeze"
    ? artifact.cases.map((item) => ({ path: item.input_path, hash: item.input_file_hash, label: `case ${item.case_id}` }))
    : artifact.artifact_kind === "alphacouncil_experiment_result_manifest"
      ? artifact.runs.map((item) => ({ path: item.artifact_path, hash: item.artifact_file_hash, label: `run ${item.run_key}`, artifact_hash: item.artifact_hash, run_key: item.run_key }))
      : [];
  for (const ref of refs) {
    let target;
    try { target = containedFile(base, ref.path, ref.label); } catch (error) {
      errors.push(error.message);
      continue;
    }
    if (!existsSync(target)) {
      errors.push(`${ref.label} reference is missing, unsafe or not physical: ${ref.path}`);
      continue;
    }
    let opened;
    try { opened = readPhysicalBytesNoFollow(target, ref.label); } catch (error) {
      errors.push(error.message);
      continue;
    }
    const actualFileHash = `sha256:${createHash("sha256").update(opened.bytes).digest("hex")}`;
    if (actualFileHash !== ref.hash) errors.push(`${ref.label} physical file hash does not match ${ref.path}`);
    if (ref.artifact_hash) {
      try {
        const nested = JSON.parse(opened.bytes.toString("utf8"));
        const nestedValidation = validateExperimentArtifact(nested);
        if (!nestedValidation.valid) errors.push(`${ref.label} nested artifact is invalid: ${nestedValidation.errors.join("; ")}`);
        if (nested.artifact_kind !== "alphacouncil_arm_run_result") errors.push(`${ref.label} nested artifact must be an arm run result`);
        if (nested.artifact_hash !== ref.artifact_hash) errors.push(`${ref.label} nested artifact_hash mismatch`);
        if (nested.case_freeze_hash !== artifact.case_freeze_hash || nested.frozen_inputs_hash !== artifact.frozen_inputs_hash) errors.push(`${ref.label} nested artifact uses different frozen inputs`);
        if (nested.artifact_kind === "alphacouncil_arm_run_result") {
          const checked = checkExperimentArtifactFile(target);
          if (!checked.valid) errors.push(`${ref.label} physical result bindings failed: ${checked.errors.join("; ")}`);
          else verifiedRuns[ref.run_key] = canonicalValue({
            file_hash: actualFileHash,
            artifact_hash: checked.artifact_hash,
            result_bindings: checked.verified_result_bindings,
          });
        }
      } catch (error) {
        errors.push(`${ref.label} cannot be parsed: ${error.message}`);
      }
    }
  }
  return { result_bindings: {}, runs: verifiedRuns };
}

/*
 * Schema validation alone checks the declaration. Evidence validation always comes through
 * this file-level function, which opens every referenced byte stream without following a
 * final symlink and recomputes its raw SHA-256.
 */
export function checkExperimentArtifactFile(file, { artifactDirectory = null } = {}) {
  const physical = readPhysicalJson(file);
  const validation = validateExperimentArtifact(physical.value);
  const verified = validateReferencedFiles(physical.value, physical.absolute, artifactDirectory, validation.errors);
  validation.valid = validation.errors.length === 0;
  return {
    ...validation,
    file: physical.absolute,
    file_hash: `sha256:${createHash("sha256").update(physical.bytes).digest("hex")}`,
    verified_result_bindings: canonicalValue(verified.result_bindings),
    verified_runs: canonicalValue(verified.runs),
  };
}

export function importExperimentResult(file, outputDirectory) {
  const checked = checkExperimentArtifactFile(file);
  if (!checked.valid) throw new ExperimentArtifactError("result artifact failed validation", checked.errors);
  if (checked.artifact_kind !== "alphacouncil_arm_run_result") throw new ExperimentArtifactError("--import-result accepts only arm run result artifacts");
  const source = realpathSync(file);
  const out = resolve(outputDirectory);
  mkdirSync(out, { recursive: true });
  if (lstatSync(out).isSymbolicLink() || !statSync(out).isDirectory()) throw new ExperimentArtifactError(`output must be a physical directory: ${out}`);
  const target = join(out, basename(source));
  const back = relative(out, target);
  if (back.startsWith(`..${sep}`) || isAbsolute(back)) throw new ExperimentArtifactError("unsafe import target");
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  return canonicalValue({ status: "imported_unsigned_result", source_file_hash: checked.file_hash, artifact_hash: checked.artifact_hash, target });
}

export function experimentArtifactPlan() {
  return canonicalValue({
    mode: "plan_only",
    canonical_arm_ids: CANONICAL_ARM_IDS,
    run_keys: EXPERIMENT_RUN_KEYS,
    artifacts: EXPERIMENT_ARTIFACT_KINDS,
    invariants: [
      "all machine and human runs bind the same case_freeze_hash and frozen_inputs_hash",
      "E is recorded as paired E:D13 and E:D26 variants",
      "H uses two or three independent analysts and one separate arm-blinded human adjudicator",
      "cost latency source and failed/retried work are recorded",
      "attestations and passed_claims remain empty; external trusted signers decide any claim",
    ],
    execution: "not_run",
    paid_model_calls: 0,
  });
}

export function canonicalArmConfigurationHash(armId, armVariant = null) {
  const arm = CANONICAL_PROTOCOL.arms.find((item) => item.arm_id === armId);
  if (!arm) throw new ExperimentArtifactError(`unknown canonical arm: ${armId}`);
  if (armId === "E" ? !["D13", "D26"].includes(armVariant) : armVariant !== null) throw new ExperimentArtifactError(`invalid variant for ${armId}: ${armVariant}`);
  return sha256({
    arm_id: arm.arm_id,
    execution_mode: arm.execution_mode,
    analyst_ids: arm.analyst_ids,
    master_ids: arm.master_ids,
    verifier_ids: arm.verifier_ids,
    base_arm_ids: arm.base_arm_ids,
    master_execution_mode: arm.master_execution_mode,
    bounded_repair: arm.bounded_repair,
    human_reference: arm.human_reference,
    arm_variant: armVariant,
  });
}

export function signingPayload(artifact) {
  const validation = validateExperimentArtifact(artifact);
  if (!validation.valid) throw new ExperimentArtifactError("cannot build signing payload for invalid artifact", validation.errors);
  return canonicalJson({ hash_domain: `alphacouncil.${artifact.artifact_kind}.signature.v1`, artifact_hash: artifact.artifact_hash });
}
