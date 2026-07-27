import { canonicalValue, sha256 } from "./canonical.mjs";
import {
  ATTESTATION_KEY_ID,
  ED25519_SIGNATURE_PREFIX,
  normalizeTrustedKeyRegistry,
  signCanonicalAttestation,
  verifyCanonicalAttestation,
} from "./attestations.mjs";

export const TRUSTED_RELEASE_EVIDENCE_KEYS_ENV = "ALPHACOUNCIL_TRUSTED_RELEASE_EVIDENCE_KEYS";
export const RELEASE_EVIDENCE_PURPOSE = "persona_release_evidence";
export const RELEASE_EVIDENCE_CHECK_IDS = Object.freeze([
  "experiment_adjudication",
  "external_host_e2e",
  "package",
]);
export const RELEASE_EVIDENCE_OPERATION_IDS = Object.freeze(["cutover", "rollback", "final_cutover"]);
export const RELEASE_EVIDENCE_HOST_IDS = Object.freeze([
  "claude_code",
  "codex",
  "opencode",
  "grok",
]);

const HASH = /^sha256:[a-f0-9]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ROOT_FIELDS = Object.freeze([
  "schema_version",
  "artifact_kind",
  "release_id",
  "release_manifest_hash",
  "release_source_review_evidence_hash",
  "expected_version",
  "generated_at",
  "artifacts",
  "claims",
  "attestations",
]);
const BINDING_FIELDS = Object.freeze(["relative_path", "file_hash", "artifact_hash"]);
const HOST_BINDING_FIELDS = Object.freeze(["host_id", ...BINDING_FIELDS]);
const ARTIFACT_FIELDS = Object.freeze([
  "external_hosts", "package", "experiment_adjudication", "release_operations",
]);
const RELEASE_OPERATIONS_FIELDS = Object.freeze([
  ...RELEASE_EVIDENCE_OPERATION_IDS, "current_pointer", "activation_marker",
]);
const OPERATION_BINDING_FIELDS = Object.freeze([
  "pointer_history", "approval", "release_manifest", "previous_release_manifest",
]);
const CLAIM_FIELDS = Object.freeze(RELEASE_EVIDENCE_CHECK_IDS);
const ATTESTATION_FIELDS = Object.freeze([
  "reviewer_id",
  "signer_key_id",
  "signed_at",
  "signature",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function principal(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized || null;
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

function exactUtcTimestamp(value) {
  return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/")
    && !value.split(/[\\/]/u).includes("..");
}

function validateBinding(value, fields, label, errors) {
  if (!exactFields(value, fields, label, errors)) return;
  if (!safeRelativePath(value.relative_path)) errors.push(`${label}.relative_path must be a safe relative path`);
  for (const field of ["file_hash", "artifact_hash"]) {
    if (!HASH.test(value[field] || "")) errors.push(`${label}.${field} is invalid`);
  }
}

function validateOperationBinding(value, label, errors) {
  if (!exactFields(value, OPERATION_BINDING_FIELDS, label, errors)) return;
  for (const field of OPERATION_BINDING_FIELDS) {
    validateBinding(value[field], BINDING_FIELDS, `${label}.${field}`, errors);
  }
}

function unsignedEvidence(document) {
  return canonicalValue(Object.fromEntries(
    ROOT_FIELDS
      .filter((field) => field !== "attestations")
      .map((field) => [field, document[field]]),
  ));
}

export function releaseEvidenceSignedPayload(document, attestation) {
  if (!isObject(document) || !isObject(attestation)) {
    throw new Error("release evidence document and attestation are required");
  }
  return canonicalValue({
    domain: "alphacouncil.persona-v3.release-evidence.v1",
    evidence: unsignedEvidence(document),
    reviewer_id: attestation.reviewer_id,
    signer_key_id: attestation.signer_key_id,
    signed_at: attestation.signed_at,
  });
}

export function parseTrustedReleaseEvidenceKeys(
  value = process.env[TRUSTED_RELEASE_EVIDENCE_KEYS_ENV],
) {
  if (value === undefined || value === null || value === "") return new Map();
  if (typeof value !== "string") return normalizeTrustedKeyRegistry(value);
  let parsed;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new Error(`${TRUSTED_RELEASE_EVIDENCE_KEYS_ENV} must contain JSON (${error.message})`);
  }
  return normalizeTrustedKeyRegistry(parsed);
}

export function signReleaseEvidenceAttestation(documentHeader, unsignedAttestation, {
  privateKey,
  signerKeyId = unsignedAttestation?.signer_key_id,
} = {}) {
  if (!isObject(documentHeader) || !isObject(unsignedAttestation)) {
    throw new Error("release evidence header and unsigned attestation are required");
  }
  if (unsignedAttestation.signature !== undefined) {
    throw new Error("unsigned release evidence attestation must not contain signature");
  }
  const document = { ...documentHeader };
  const attestation = canonicalValue({ ...unsignedAttestation, signer_key_id: signerKeyId });
  const signature = signCanonicalAttestation(releaseEvidenceSignedPayload(document, attestation), {
    privateKey,
    signerKeyId,
  });
  return canonicalValue({ ...attestation, signature });
}

export function validateReleaseEvidenceDocument(document, {
  expectedReleaseId = null,
  expectedManifestHash = null,
  expectedSourceReviewEvidenceHash = null,
  expectedVersion = null,
  now = new Date(),
} = {}) {
  const errors = [];
  if (!exactFields(document, ROOT_FIELDS, "release evidence", errors)) return errors;
  if (document.schema_version !== 1
    || document.artifact_kind !== "persona_v3_ga_release_evidence") {
    errors.push("release evidence header is invalid");
  }
  if (!RELEASE_ID.test(document.release_id || "")) errors.push("release evidence.release_id is invalid");
  if (!HASH.test(document.release_manifest_hash || "")) {
    errors.push("release evidence.release_manifest_hash is invalid");
  }
  if (!HASH.test(document.release_source_review_evidence_hash || "")) {
    errors.push("release evidence.release_source_review_evidence_hash is invalid");
  }
  if (typeof document.expected_version !== "string"
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(document.expected_version)) {
    errors.push("release evidence.expected_version is invalid");
  }
  if (expectedReleaseId !== null && document.release_id !== expectedReleaseId) {
    errors.push("release evidence targets a different release");
  }
  if (expectedManifestHash !== null && document.release_manifest_hash !== expectedManifestHash) {
    errors.push("release evidence targets a different release manifest hash");
  }
  if (expectedSourceReviewEvidenceHash !== null
    && document.release_source_review_evidence_hash !== expectedSourceReviewEvidenceHash) {
    errors.push("release evidence targets a different source-review evidence bundle");
  }
  if (expectedVersion !== null && document.expected_version !== expectedVersion) {
    errors.push("release evidence targets a different package version");
  }
  const nowTime = new Date(now).getTime();
  const generatedTime = Date.parse(document.generated_at);
  if (!exactUtcTimestamp(document.generated_at)) errors.push("release evidence.generated_at must be an exact UTC ISO timestamp");
  else if (generatedTime > nowTime) errors.push("release evidence.generated_at cannot be in the future");

  if (exactFields(document.artifacts, ARTIFACT_FIELDS, "release evidence.artifacts", errors)) {
    if (!Array.isArray(document.artifacts.external_hosts)
      || document.artifacts.external_hosts.length !== RELEASE_EVIDENCE_HOST_IDS.length) {
      errors.push("release evidence.artifacts.external_hosts must contain exactly four bindings");
    } else document.artifacts.external_hosts.forEach((binding, index) => {
      const label = `release evidence.artifacts.external_hosts[${index}]`;
      validateBinding(binding, HOST_BINDING_FIELDS, label, errors);
      if (binding?.host_id !== RELEASE_EVIDENCE_HOST_IDS[index]) {
        errors.push(`${label}.host_id is not in canonical order`);
      }
    });
    validateBinding(document.artifacts.package, BINDING_FIELDS, "release evidence.artifacts.package", errors);
    validateBinding(
      document.artifacts.experiment_adjudication,
      BINDING_FIELDS,
      "release evidence.artifacts.experiment_adjudication",
      errors,
    );
    if (exactFields(
      document.artifacts.release_operations,
      RELEASE_OPERATIONS_FIELDS,
      "release evidence.artifacts.release_operations",
      errors,
    )) {
      for (const operation of RELEASE_EVIDENCE_OPERATION_IDS) {
        validateOperationBinding(
          document.artifacts.release_operations[operation],
          `release evidence.artifacts.release_operations.${operation}`,
          errors,
        );
      }
      validateBinding(
        document.artifacts.release_operations.current_pointer,
        BINDING_FIELDS,
        "release evidence.artifacts.release_operations.current_pointer",
        errors,
      );
      validateBinding(
        document.artifacts.release_operations.activation_marker,
        BINDING_FIELDS,
        "release evidence.artifacts.release_operations.activation_marker",
        errors,
      );
    }
  }

  if (exactFields(document.claims, CLAIM_FIELDS, "release evidence.claims", errors)) {
    for (const claimId of CLAIM_FIELDS) {
      if (document.claims[claimId] !== "passed") {
        errors.push(`release evidence.claims.${claimId} must be passed`);
      }
    }
  }

  if (!Array.isArray(document.attestations) || document.attestations.length < 2) {
    errors.push("release evidence.attestations must contain at least two entries");
  } else for (const [index, attestation] of document.attestations.entries()) {
    const label = `release evidence.attestations[${index}]`;
    if (!exactFields(attestation, ATTESTATION_FIELDS, label, errors)) continue;
    const reviewer = principal(attestation.reviewer_id);
    if (!reviewer || reviewer.length > 128) errors.push(`${label}.reviewer_id is invalid`);
    if (!ATTESTATION_KEY_ID.test(attestation.signer_key_id || "")) errors.push(`${label}.signer_key_id is invalid`);
    if (!exactUtcTimestamp(attestation.signed_at)) errors.push(`${label}.signed_at must be an exact UTC ISO timestamp`);
    else {
      const signedTime = Date.parse(attestation.signed_at);
      if (signedTime > nowTime) errors.push(`${label}.signed_at cannot be in the future`);
      if (Number.isFinite(generatedTime) && signedTime < generatedTime) {
        errors.push(`${label}.signed_at cannot be before generated_at`);
      }
    }
    if (typeof attestation.signature !== "string"
      || !attestation.signature.startsWith(ED25519_SIGNATURE_PREFIX)) {
      errors.push(`${label}.signature must be Ed25519`);
    }
  }
  return errors;
}

export function verifyReleaseEvidenceDocument(document, {
  trustedKeyRegistry = parseTrustedReleaseEvidenceKeys(),
  minimumAttestations = 2,
  ...expected
} = {}) {
  const errors = validateReleaseEvidenceDocument(document, expected);
  if (errors.length) return Object.freeze({ valid: false, reason: "invalid_evidence_document", errors });
  const registry = normalizeTrustedKeyRegistry(trustedKeyRegistry);
  const principals = new Set();
  const keyIds = new Set();
  const failures = [];
  for (const attestation of document.attestations) {
    const verification = verifyCanonicalAttestation(
      releaseEvidenceSignedPayload(document, attestation),
      {
        signature: attestation.signature,
        signerKeyId: attestation.signer_key_id,
        trustedKeyRegistry: registry,
        purpose: RELEASE_EVIDENCE_PURPOSE,
        at: attestation.signed_at,
      },
    );
    if (!verification.valid) {
      failures.push({ signer_key_id: attestation.signer_key_id, reason: verification.reason });
      continue;
    }
    const verifiedPrincipal = principal(verification.principal_id);
    if (!verifiedPrincipal) {
      failures.push({ signer_key_id: attestation.signer_key_id, reason: "trusted_release_evidence_principal_required" });
      continue;
    }
    if (verifiedPrincipal !== principal(attestation.reviewer_id)) {
      failures.push({ signer_key_id: attestation.signer_key_id, reason: "release_evidence_principal_mismatch" });
      continue;
    }
    principals.add(verifiedPrincipal);
    keyIds.add(attestation.signer_key_id);
  }
  if (failures.length) {
    return Object.freeze({ valid: false, reason: "evidence_signature_failed", errors: [], failures });
  }
  if (principals.size < minimumAttestations || keyIds.size < minimumAttestations) {
    return Object.freeze({
      valid: false,
      reason: "insufficient_independent_release_evidence_attestations",
      errors: [],
      failures: [],
      principal_count: principals.size,
      key_count: keyIds.size,
    });
  }
  return Object.freeze({
    valid: true,
    reason: null,
    errors: [],
    failures: [],
    evidence_hash: sha256(document),
    release_id: document.release_id,
    release_manifest_hash: document.release_manifest_hash,
    release_source_review_evidence_hash: document.release_source_review_evidence_hash,
    expected_version: document.expected_version,
    approver_principal_ids: [...principals].sort(),
    approver_key_ids: [...keyIds].sort(),
    statuses: Object.freeze({
      experiment: document.claims.experiment_adjudication,
      host: document.claims.external_host_e2e,
      package: document.claims.package,
    }),
    artifacts: canonicalValue(document.artifacts),
    claims: canonicalValue(document.claims),
  });
}
