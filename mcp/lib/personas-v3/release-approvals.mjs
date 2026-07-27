import { canonicalValue, sha256 } from "./canonical.mjs";
import {
  ATTESTATION_KEY_ID,
  ED25519_SIGNATURE_PREFIX,
  normalizeTrustedKeyRegistry,
  signCanonicalAttestation,
  verifyCanonicalAttestation,
} from "./attestations.mjs";

export const TRUSTED_RELEASE_KEYS_ENV = "ALPHACOUNCIL_TRUSTED_RELEASE_KEYS";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const OPERATIONS = new Set(["cutover", "rollback"]);
const HEADER_FIELDS = Object.freeze([
  "schema_version",
  "artifact_kind",
  "operation",
  "release_id",
  "release_manifest_hash",
  "previous_release_id",
]);
const APPROVAL_FIELDS = Object.freeze([
  "reviewer_id",
  "signer_key_id",
  "approved_at",
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

function header(document) {
  return canonicalValue(Object.fromEntries(HEADER_FIELDS.map((field) => [field, document[field]])));
}

export function releaseApprovalSignedPayload(document, approval) {
  if (!isObject(document) || !isObject(approval)) throw new Error("release approval document and entry are required");
  return canonicalValue({
    domain: "alphacouncil.persona-v3.release-approval.v1",
    ...header(document),
    reviewer_id: approval.reviewer_id,
    signer_key_id: approval.signer_key_id,
    approved_at: approval.approved_at,
  });
}

export function parseTrustedReleaseKeys(value = process.env[TRUSTED_RELEASE_KEYS_ENV]) {
  if (value === undefined || value === null || value === "") return new Map();
  if (typeof value !== "string") return normalizeTrustedKeyRegistry(value);
  let parsed;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new Error(`${TRUSTED_RELEASE_KEYS_ENV} must contain JSON (${error.message})`);
  }
  return normalizeTrustedKeyRegistry(parsed);
}

export function signReleaseApproval(documentHeader, unsignedApproval, {
  privateKey,
  signerKeyId = unsignedApproval?.signer_key_id,
} = {}) {
  const document = { ...documentHeader };
  const approval = canonicalValue({ ...unsignedApproval, signer_key_id: signerKeyId });
  if (approval.signature !== undefined) throw new Error("unsigned release approval must not contain signature");
  const signature = signCanonicalAttestation(releaseApprovalSignedPayload(document, approval), {
    privateKey,
    signerKeyId,
  });
  return canonicalValue({ ...approval, signature });
}

export function validateReleaseApprovalDocument(document, {
  expectedReleaseId = null,
  expectedManifestHash = null,
  expectedOperation = null,
  expectedPreviousReleaseId = undefined,
  now = new Date(),
} = {}) {
  const errors = [];
  if (!exactFields(document, [...HEADER_FIELDS, "approvals"], "release approval", errors)) return errors;
  if (document.schema_version !== 1 || document.artifact_kind !== "persona_v3_release_approval_bundle") {
    errors.push("release approval header is invalid");
  }
  if (!OPERATIONS.has(document.operation)) errors.push("release approval.operation is invalid");
  if (!RELEASE_ID.test(document.release_id || "")) errors.push("release approval.release_id is invalid");
  if (!HASH.test(document.release_manifest_hash || "")) errors.push("release approval.release_manifest_hash is invalid");
  if (document.previous_release_id !== null && !RELEASE_ID.test(document.previous_release_id || "")) {
    errors.push("release approval.previous_release_id is invalid");
  }
  if (expectedReleaseId !== null && document.release_id !== expectedReleaseId) errors.push("release approval targets a different release");
  if (expectedManifestHash !== null && document.release_manifest_hash !== expectedManifestHash) errors.push("release approval targets a different manifest hash");
  if (expectedOperation !== null && document.operation !== expectedOperation) errors.push("release approval targets a different operation");
  if (expectedPreviousReleaseId !== undefined && document.previous_release_id !== expectedPreviousReleaseId) {
    errors.push("release approval targets a different previous release");
  }
  if (!Array.isArray(document.approvals)) errors.push("release approval.approvals must be an array");
  else for (const [index, approval] of document.approvals.entries()) {
    const label = `release approval.approvals[${index}]`;
    if (!exactFields(approval, APPROVAL_FIELDS, label, errors)) continue;
    const reviewer = principal(approval.reviewer_id);
    if (!reviewer || reviewer.length > 128) errors.push(`${label}.reviewer_id is invalid`);
    if (!ATTESTATION_KEY_ID.test(approval.signer_key_id || "")) errors.push(`${label}.signer_key_id is invalid`);
    if (!Number.isFinite(Date.parse(approval.approved_at))) errors.push(`${label}.approved_at is invalid`);
    else if (Date.parse(approval.approved_at) > now.getTime()) errors.push(`${label}.approved_at cannot be in the future`);
    if (typeof approval.signature !== "string" || !approval.signature.startsWith(ED25519_SIGNATURE_PREFIX)) {
      errors.push(`${label}.signature must be Ed25519`);
    }
  }
  return errors;
}

export function verifyReleaseApprovalDocument(document, {
  trustedKeyRegistry = parseTrustedReleaseKeys(),
  minimumApprovals = 2,
  ...expected
} = {}) {
  const errors = validateReleaseApprovalDocument(document, expected);
  if (errors.length) return Object.freeze({ valid: false, reason: "invalid_approval_document", errors });
  const registry = normalizeTrustedKeyRegistry(trustedKeyRegistry);
  const principals = new Set();
  const keyIds = new Set();
  const failures = [];
  for (const approval of document.approvals) {
    const verification = verifyCanonicalAttestation(releaseApprovalSignedPayload(document, approval), {
      signature: approval.signature,
      signerKeyId: approval.signer_key_id,
      trustedKeyRegistry: registry,
      purpose: "persona_release",
      at: approval.approved_at,
    });
    if (!verification.valid) {
      failures.push({ signer_key_id: approval.signer_key_id, reason: verification.reason });
      continue;
    }
    const verifiedPrincipal = principal(verification.principal_id);
    if (!verifiedPrincipal) {
      failures.push({ signer_key_id: approval.signer_key_id, reason: "trusted_release_principal_required" });
      continue;
    }
    if (verifiedPrincipal !== principal(approval.reviewer_id)) {
      failures.push({ signer_key_id: approval.signer_key_id, reason: "release_principal_mismatch" });
      continue;
    }
    principals.add(verifiedPrincipal);
    keyIds.add(approval.signer_key_id);
  }
  if (failures.length) return Object.freeze({ valid: false, reason: "approval_signature_failed", errors: [], failures });
  if (principals.size < minimumApprovals || keyIds.size < minimumApprovals) {
    return Object.freeze({
      valid: false,
      reason: "insufficient_independent_release_approvals",
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
    approval_hash: sha256(document),
    approver_principal_ids: [...principals].sort(),
    approver_key_ids: [...keyIds].sort(),
  });
}
