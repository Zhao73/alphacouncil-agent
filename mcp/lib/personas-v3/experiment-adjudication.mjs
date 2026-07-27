import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  ATTESTATION_KEY_ID,
  ED25519_SIGNATURE_PREFIX,
  normalizeTrustedKeyRegistry,
  signCanonicalAttestation,
  verifyCanonicalAttestation,
} from "./attestations.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import {
  EXPERIMENT_RUN_KEYS,
  checkExperimentArtifactFile,
} from "../../../scripts/lib/council-experiment-artifacts.mjs";

export const EXPERIMENT_ADJUDICATION_PURPOSE = "experiment_adjudication";
export const TRUSTED_EXPERIMENT_ADJUDICATION_KEYS_ENV =
  "ALPHACOUNCIL_TRUSTED_EXPERIMENT_ADJUDICATION_KEYS";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ROOT_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "release_id", "release_manifest_hash",
  "adjudicated_at", "adjudicator_id", "registered_protocol", "case_freeze",
  "result_manifest", "runs", "promotion_thresholds", "multiplicity_policy",
  "human_reference_boundary", "release_claims", "decision", "attestation",
]);
const BINDING_FIELDS = Object.freeze(["relative_path", "file_hash", "artifact_hash"]);
const PROTOCOL_BINDING_FIELDS = Object.freeze(["relative_path", "file_hash", "protocol_hash"]);
const RUN_BINDING_FIELDS = Object.freeze(["run_key", ...BINDING_FIELDS]);
const ATTESTATION_FIELDS = Object.freeze(["signer_key_id", "signed_at", "signature"]);
const PROTOCOL_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "protocol_id", "registered_at", "protocol_hash",
  "promotion_thresholds", "multiplicity_policy", "human_reference_boundary",
  "release_claims",
]);
const HUMAN_BOUNDARY = Object.freeze({
  independent_analyst_count_minimum: 2,
  independent_analyst_count_maximum: 3,
  independent_before_adjudication: true,
  separate_named_human_adjudicator: true,
  adjudicator_blinded_to_arm: true,
  automated_vote: false,
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, fields, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const allowed = new Set(fields);
  for (const field of fields) if (!Object.hasOwn(value, field)) errors.push(`${label}.${field} is required`);
  for (const field of Object.keys(value)) if (!allowed.has(field)) errors.push(`${label}.${field} is not allowed`);
  return true;
}

function exactUtc(value) {
  return typeof value === "string" && ISO_UTC.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function nonEmptyObject(value, label, errors) {
  if (!isObject(value) || Object.keys(value).length === 0) errors.push(`${label} must be a non-empty object`);
}

function releaseClaims(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must contain explicit release claims`);
    return;
  }
  const seen = new Set();
  for (const [index, claim] of value.entries()) {
    if (typeof claim !== "string" || claim.trim().length < 8) errors.push(`${label}[${index}] is invalid`);
    if (seen.has(claim)) errors.push(`${label}[${index}] is duplicated`);
    seen.add(claim);
  }
}

function safeRelative(value, label, errors) {
  if (typeof value !== "string" || !value || isAbsolute(value)
    || value.split(/[\\/]/u).includes("..")) errors.push(`${label} must be a safe relative path`);
}

function validateBinding(binding, label, errors, fields = BINDING_FIELDS) {
  if (!exactFields(binding, fields, label, errors)) return;
  safeRelative(binding.relative_path, `${label}.relative_path`, errors);
  for (const field of fields.filter((field) => field.endsWith("_hash"))) {
    if (!HASH.test(binding[field] || "")) errors.push(`${label}.${field} must be a canonical sha256 hash`);
  }
}

function unsignedDocument(document) {
  return canonicalValue(Object.fromEntries(
    ROOT_FIELDS.filter((field) => field !== "attestation").map((field) => [field, document[field]]),
  ));
}

export function experimentAdjudicationSignedPayload(document) {
  return canonicalValue({
    domain: "alphacouncil.persona-v3.experiment-adjudication.v1",
    adjudication: unsignedDocument(document),
    signer_key_id: document?.attestation?.signer_key_id,
    signed_at: document?.attestation?.signed_at,
  });
}

export function signExperimentAdjudication(document, {
  privateKey,
  signerKeyId = document?.attestation?.signer_key_id,
  signedAt = document?.attestation?.signed_at,
} = {}) {
  if (!isObject(document)) throw new Error("experiment adjudication document is required");
  const unsigned = { ...document };
  delete unsigned.attestation;
  const header = {
    ...unsigned,
    attestation: { signer_key_id: signerKeyId, signed_at: signedAt, signature: null },
  };
  const signature = signCanonicalAttestation(experimentAdjudicationSignedPayload(header), {
    privateKey,
    signerKeyId,
  });
  return canonicalValue({
    ...unsigned,
    attestation: { signer_key_id: signerKeyId, signed_at: signedAt, signature },
  });
}

export function parseTrustedExperimentAdjudicationKeys(
  value = process.env[TRUSTED_EXPERIMENT_ADJUDICATION_KEYS_ENV],
) {
  if (value === undefined || value === null || value === "") return new Map();
  if (typeof value !== "string") return normalizeTrustedKeyRegistry(value);
  let parsed;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new Error(`${TRUSTED_EXPERIMENT_ADJUDICATION_KEYS_ENV} must contain JSON (${error.message})`);
  }
  return normalizeTrustedKeyRegistry(parsed);
}

export function validateExperimentAdjudicationDocument(document, {
  expectedReleaseId = null,
  expectedManifestHash = null,
  now = new Date(),
} = {}) {
  const errors = [];
  if (!exactFields(document, ROOT_FIELDS, "experiment adjudication", errors)) return errors;
  if (document.schema_version !== 1
    || document.artifact_kind !== "persona_v3_experiment_adjudication") {
    errors.push("experiment adjudication header is invalid");
  }
  if (!RELEASE_ID.test(document.release_id || "")) errors.push("experiment adjudication release_id is invalid");
  if (!HASH.test(document.release_manifest_hash || "")) errors.push("experiment adjudication release_manifest_hash is invalid");
  if (expectedReleaseId !== null && document.release_id !== expectedReleaseId) errors.push("experiment adjudication targets a different release");
  if (expectedManifestHash !== null && document.release_manifest_hash !== expectedManifestHash) errors.push("experiment adjudication targets a different release manifest");
  if (!exactUtc(document.adjudicated_at)) errors.push("experiment adjudication adjudicated_at must be an exact UTC timestamp");
  else if (Date.parse(document.adjudicated_at) > new Date(now).getTime()) errors.push("experiment adjudication adjudicated_at cannot be in the future");
  if (typeof document.adjudicator_id !== "string" || !document.adjudicator_id.trim()
    || document.adjudicator_id.length > 128) errors.push("experiment adjudication adjudicator_id is invalid");
  validateBinding(document.registered_protocol, "registered_protocol", errors, PROTOCOL_BINDING_FIELDS);
  validateBinding(document.case_freeze, "case_freeze", errors);
  validateBinding(document.result_manifest, "result_manifest", errors);
  if (!Array.isArray(document.runs) || document.runs.length !== EXPERIMENT_RUN_KEYS.length) {
    errors.push("experiment adjudication must bind exactly eight run artifacts");
  } else document.runs.forEach((run, index) => {
    validateBinding(run, `runs[${index}]`, errors, RUN_BINDING_FIELDS);
    if (run?.run_key !== EXPERIMENT_RUN_KEYS[index]) errors.push(`runs[${index}].run_key is out of canonical order`);
  });
  nonEmptyObject(document.promotion_thresholds, "promotion_thresholds", errors);
  nonEmptyObject(document.multiplicity_policy, "multiplicity_policy", errors);
  if (canonicalJson(document.human_reference_boundary) !== canonicalJson(HUMAN_BOUNDARY)) {
    errors.push("human_reference_boundary does not preserve the preregistered H boundary");
  }
  releaseClaims(document.release_claims, "release_claims", errors);
  if (document.decision !== "passed") errors.push("experiment adjudication decision must be passed");
  if (exactFields(document.attestation, ATTESTATION_FIELDS, "experiment adjudication attestation", errors)) {
    if (!ATTESTATION_KEY_ID.test(document.attestation.signer_key_id || "")) errors.push("experiment adjudication signer_key_id is invalid");
    if (!exactUtc(document.attestation.signed_at)) errors.push("experiment adjudication signed_at must be an exact UTC timestamp");
    else {
      if (Date.parse(document.attestation.signed_at) < Date.parse(document.adjudicated_at)) errors.push("experiment adjudication signed_at precedes adjudicated_at");
      if (Date.parse(document.attestation.signed_at) > new Date(now).getTime()) errors.push("experiment adjudication signed_at cannot be in the future");
    }
    if (typeof document.attestation.signature !== "string"
      || !document.attestation.signature.startsWith(ED25519_SIGNATURE_PREFIX)) {
      errors.push("experiment adjudication signature must be Ed25519");
    }
  }
  return errors;
}

function physicalHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readPhysicalJson(file, label) {
  const absolute = resolve(file);
  if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  let descriptor;
  let bytes;
  try {
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a physical regular file`);
    bytes = readFileSync(descriptor);
  } catch (error) {
    throw new Error(`${label} cannot be opened without following symlinks: ${absolute} (${error.code || error.message})`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw new Error(`${label} is invalid JSON (${error.message})`);
  }
  return { absolute: realpathSync(absolute), bytes, value, file_hash: physicalHash(bytes) };
}

function resolveBinding(root, binding, label) {
  const target = resolve(root, binding.relative_path);
  const back = relative(root, target);
  if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error(`${label} escapes the adjudication evidence root`);
  }
  if (existsSync(target)) {
    const physical = realpathSync(target);
    const physicalBack = relative(root, physical);
    if (physical !== target || physicalBack === ".." || physicalBack.startsWith(`..${sep}`)
      || isAbsolute(physicalBack)) {
      throw new Error(`${label} uses a symlinked path component or escapes the adjudication evidence root`);
    }
  }
  return target;
}

function validateRegisteredProtocol(value) {
  const errors = [];
  if (!exactFields(value, PROTOCOL_FIELDS, "registered protocol", errors)) return errors;
  if (value.schema_version !== 1 || value.artifact_kind !== "alphacouncil_registered_evaluation_protocol") errors.push("registered protocol header is invalid");
  if (typeof value.protocol_id !== "string" || !value.protocol_id.trim()) errors.push("registered protocol protocol_id is invalid");
  if (!exactUtc(value.registered_at)) errors.push("registered protocol registered_at is invalid");
  if (!HASH.test(value.protocol_hash || "")) errors.push("registered protocol protocol_hash is invalid");
  const expected = sha256({
    domain: "alphacouncil.registered-evaluation-protocol.v1",
    protocol_id: value.protocol_id,
    registered_at: value.registered_at,
    promotion_thresholds: value.promotion_thresholds,
    multiplicity_policy: value.multiplicity_policy,
    human_reference_boundary: value.human_reference_boundary,
    release_claims: value.release_claims,
  });
  if (value.protocol_hash !== expected) errors.push("registered protocol protocol_hash does not bind the preregistration");
  nonEmptyObject(value.promotion_thresholds, "registered protocol promotion_thresholds", errors);
  nonEmptyObject(value.multiplicity_policy, "registered protocol multiplicity_policy", errors);
  if (canonicalJson(value.human_reference_boundary) !== canonicalJson(HUMAN_BOUNDARY)) errors.push("registered protocol H boundary is invalid");
  releaseClaims(value.release_claims, "registered protocol release_claims", errors);
  return errors;
}

export function verifyExperimentAdjudicationFile(file, {
  trustedKeyRegistry = parseTrustedExperimentAdjudicationKeys(),
  expectedReleaseId = null,
  expectedManifestHash = null,
  now = new Date(),
} = {}) {
  const physical = readPhysicalJson(file, "experiment adjudication");
  const document = physical.value;
  const errors = validateExperimentAdjudicationDocument(document, {
    expectedReleaseId,
    expectedManifestHash,
    now,
  });
  if (errors.length) return Object.freeze({ valid: false, reason: "invalid_experiment_adjudication", errors });

  const registry = normalizeTrustedKeyRegistry(trustedKeyRegistry);
  const signature = verifyCanonicalAttestation(experimentAdjudicationSignedPayload(document), {
    signature: document.attestation.signature,
    signerKeyId: document.attestation.signer_key_id,
    trustedKeyRegistry: registry,
    purpose: EXPERIMENT_ADJUDICATION_PURPOSE,
    at: document.attestation.signed_at,
  });
  if (!signature.valid) return Object.freeze({ valid: false, reason: signature.reason, errors: [] });
  const principal = String(signature.principal_id || "").normalize("NFKC").trim();
  if (!principal || principal !== document.adjudicator_id.normalize("NFKC").trim()) {
    return Object.freeze({ valid: false, reason: "experiment_adjudicator_principal_mismatch", errors: [] });
  }

  const root = dirname(physical.absolute);
  const verifiedRunBindings = {};
  try {
    const protocolFile = readPhysicalJson(
      resolveBinding(root, document.registered_protocol, "registered_protocol"),
      "registered protocol",
    );
    errors.push(...validateRegisteredProtocol(protocolFile.value));
    if (protocolFile.file_hash !== document.registered_protocol.file_hash) errors.push("registered protocol physical file hash mismatch");
    if (protocolFile.value.protocol_hash !== document.registered_protocol.protocol_hash) errors.push("registered protocol semantic hash mismatch");
    if (canonicalJson(protocolFile.value.promotion_thresholds) !== canonicalJson(document.promotion_thresholds)) errors.push("experiment adjudication thresholds differ from preregistration");
    if (canonicalJson(protocolFile.value.multiplicity_policy) !== canonicalJson(document.multiplicity_policy)) errors.push("experiment adjudication multiplicity policy differs from preregistration");
    if (canonicalJson(protocolFile.value.human_reference_boundary) !== canonicalJson(document.human_reference_boundary)) errors.push("experiment adjudication H boundary differs from preregistration");
    if (canonicalJson(protocolFile.value.release_claims) !== canonicalJson(document.release_claims)) errors.push("experiment adjudication release claims differ from preregistration");

    const casePath = resolveBinding(root, document.case_freeze, "case_freeze");
    const checkedCase = checkExperimentArtifactFile(casePath, { artifactDirectory: dirname(casePath) });
    if (!checkedCase.valid || checkedCase.artifact_kind !== "alphacouncil_case_freeze") errors.push(`case freeze failed validation: ${checkedCase.errors.join("; ")}`);
    if (checkedCase.file_hash !== document.case_freeze.file_hash || checkedCase.artifact_hash !== document.case_freeze.artifact_hash) errors.push("case freeze physical binding mismatch");

    const manifestPath = resolveBinding(root, document.result_manifest, "result_manifest");
    const checkedManifest = checkExperimentArtifactFile(manifestPath, { artifactDirectory: dirname(manifestPath) });
    if (!checkedManifest.valid || checkedManifest.artifact_kind !== "alphacouncil_experiment_result_manifest") errors.push(`result manifest failed validation: ${checkedManifest.errors.join("; ")}`);
    if (checkedManifest.file_hash !== document.result_manifest.file_hash || checkedManifest.artifact_hash !== document.result_manifest.artifact_hash) errors.push("result manifest physical binding mismatch");
    const resultManifest = readPhysicalJson(manifestPath, "experiment result manifest").value;
    if (resultManifest.result_status !== "ready_for_external_signature") errors.push("experiment result manifest is not ready for external signature");
    if (resultManifest.protocol_hash !== document.registered_protocol.protocol_hash) errors.push("result manifest is not bound to the registered protocol");
    if (resultManifest.case_freeze_hash !== document.case_freeze.artifact_hash) errors.push("result manifest is not bound to the physical case freeze");
    if (resultManifest.runs?.some((run) => run.status !== "completed")) errors.push("all eight experiment runs must be completed");
    if (Object.keys(checkedManifest.verified_runs || {}).length !== EXPERIMENT_RUN_KEYS.length) errors.push("result manifest did not physically verify all eight run result sets");

    for (const [index, binding] of document.runs.entries()) {
      const run = resultManifest.runs?.[index];
      const runPath = resolveBinding(root, binding, `runs[${index}]`);
      const manifestRunPath = resolve(dirname(manifestPath), run?.artifact_path || "");
      if (runPath !== manifestRunPath) errors.push(`runs[${index}] path does not match the result manifest`);
      const checkedRun = checkExperimentArtifactFile(runPath);
      if (!checkedRun.valid || checkedRun.artifact_kind !== "alphacouncil_arm_run_result") errors.push(`runs[${index}] failed validation: ${checkedRun.errors.join("; ")}`);
      if (checkedRun.file_hash !== binding.file_hash || checkedRun.artifact_hash !== binding.artifact_hash) errors.push(`runs[${index}] physical binding mismatch`);
      const runValue = readPhysicalJson(runPath, `run ${binding.run_key}`).value;
      if (runValue.status !== "completed") errors.push(`runs[${index}] is not completed`);
      if (runValue.protocol_hash !== document.registered_protocol.protocol_hash) errors.push(`runs[${index}] is not bound to the registered protocol`);
      if (runValue.case_freeze_hash !== document.case_freeze.artifact_hash) errors.push(`runs[${index}] is not bound to the physical case freeze`);
      if (run?.artifact_file_hash !== binding.file_hash || run?.artifact_hash !== binding.artifact_hash) errors.push(`runs[${index}] differs from its result-manifest binding`);
      if (checkedRun.valid) verifiedRunBindings[binding.run_key] = checkedRun.verified_result_bindings;
    }
  } catch (error) {
    errors.push(error?.message || String(error));
  }
  if (errors.length) return Object.freeze({ valid: false, reason: "experiment_physical_evidence_failed", errors });
  return Object.freeze({
    valid: true,
    reason: null,
    errors: [],
    file: physical.absolute,
    file_hash: physical.file_hash,
    artifact_hash: sha256(document),
    release_id: document.release_id,
    release_manifest_hash: document.release_manifest_hash,
    protocol_hash: document.registered_protocol.protocol_hash,
    case_freeze_hash: document.case_freeze.artifact_hash,
    result_manifest_hash: document.result_manifest.artifact_hash,
    run_artifact_hashes: document.runs.map((run) => run.artifact_hash),
    run_result_bindings: canonicalValue(verifiedRunBindings),
    release_claims: canonicalValue(document.release_claims),
    signer_key_id: document.attestation.signer_key_id,
    signer_principal_id: principal,
  });
}

export const EXPERIMENT_HUMAN_REFERENCE_BOUNDARY = HUMAN_BOUNDARY;
