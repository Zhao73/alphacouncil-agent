import { canonicalValue } from "./canonical.mjs";
import {
  ATTESTATION_KEY_ID,
  ED25519_SIGNATURE_PREFIX,
  normalizeTrustedKeyRegistry,
  signCanonicalAttestation,
  verifyCanonicalAttestation,
} from "./attestations.mjs";

export const TRUSTED_SOURCE_REVIEW_KEYS_ENV = "ALPHACOUNCIL_TRUSTED_SOURCE_REVIEW_KEYS";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECISIONS = new Set(["approve", "reject"]);
const FIELDS = Object.freeze([
  "schema_version",
  "artifact_kind",
  "reviewer_id",
  "signer_key_id",
  "decision",
  "content_hash",
  "anchor_hash",
  "reviewed_at",
  "affirmations",
  "notes",
  "signature",
]);
const SIGNED_FIELDS = Object.freeze(FIELDS.filter((field) => field !== "signature"));
const AFFIRMATIONS = Object.freeze([
  "reviewed_raw_archive_bytes",
  "verified_locator_against_raw_material",
  "reviewer_is_human",
  "review_was_independent",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeReviewerPrincipal(value) {
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
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label}.${field} is not allowed`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`${label}.${field} is required`);
  }
  return true;
}

export function sourceReviewSignedPayload(attestation) {
  if (!isObject(attestation)) throw new Error("source review attestation must be an object");
  return canonicalValue(Object.fromEntries(
    SIGNED_FIELDS
      .filter((field) => attestation[field] !== undefined)
      .map((field) => [field, attestation[field]]),
  ));
}

export function validateSourceReviewAttestation(attestation, { now = new Date() } = {}) {
  const errors = [];
  if (!exactFields(attestation, FIELDS, "source review attestation", errors)) return errors;
  if (attestation.schema_version !== 2) errors.push("source review attestation.schema_version must be 2");
  if (attestation.artifact_kind !== "persona_v3_source_review_attestation") {
    errors.push("source review attestation.artifact_kind is invalid");
  }
  const principal = normalizeReviewerPrincipal(attestation.reviewer_id);
  if (!principal || principal.length > 128) {
    errors.push("source review attestation.reviewer_id must be non-empty and at most 128 characters");
  }
  if (!ATTESTATION_KEY_ID.test(attestation.signer_key_id || "")) {
    errors.push("source review attestation.signer_key_id is invalid");
  }
  if (!DECISIONS.has(attestation.decision)) {
    errors.push("source review attestation.decision must be approve or reject");
  }
  for (const field of ["content_hash", "anchor_hash"]) {
    if (!HASH.test(attestation[field] || "")) errors.push(`source review attestation.${field} must be a sha256 hash`);
  }
  if (!ISO_UTC.test(attestation.reviewed_at || "")
    || !Number.isFinite(Date.parse(attestation.reviewed_at))) {
    errors.push("source review attestation.reviewed_at must be an exact UTC ISO timestamp");
  } else if (Date.parse(attestation.reviewed_at) > now.getTime()) {
    errors.push("source review attestation.reviewed_at cannot be in the future");
  }
  if (exactFields(attestation.affirmations, AFFIRMATIONS, "source review attestation.affirmations", errors)) {
    for (const field of AFFIRMATIONS) {
      if (attestation.affirmations[field] !== true) {
        errors.push(`source review attestation.affirmations.${field} must be true`);
      }
    }
  }
  if (typeof attestation.notes !== "string" || attestation.notes.length > 1200) {
    errors.push("source review attestation.notes must be a string no longer than 1200 characters");
  }
  if (typeof attestation.signature !== "string"
    || !attestation.signature.startsWith(ED25519_SIGNATURE_PREFIX)) {
    errors.push("source review attestation.signature must be an Ed25519 signature");
  }
  return errors;
}

/** Validate the exact human-completed payload before any private-key operation. */
export function validateUnsignedSourceReviewAttestation(attestation, { now = new Date() } = {}) {
  if (!isObject(attestation)) return ["unsigned source review attestation must be an object"];
  return validateSourceReviewAttestation({
    ...attestation,
    signature: `${ED25519_SIGNATURE_PREFIX}${"A".repeat(86)}`,
  }, { now });
}

export function parseTrustedSourceReviewKeys(value = process.env[TRUSTED_SOURCE_REVIEW_KEYS_ENV]) {
  if (value === undefined || value === null || value === "") return new Map();
  if (typeof value !== "string") return normalizeTrustedKeyRegistry(value);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${TRUSTED_SOURCE_REVIEW_KEYS_ENV} must contain JSON (${error.message})`);
  }
  return normalizeTrustedKeyRegistry(parsed);
}

export function signSourceReviewAttestation(unsignedAttestation, {
  privateKey,
  signerKeyId = unsignedAttestation?.signer_key_id,
} = {}) {
  if (!isObject(unsignedAttestation)) throw new Error("unsigned source review attestation must be an object");
  if (unsignedAttestation.signature !== undefined) {
    throw new Error("unsigned source review attestation must not already contain signature");
  }
  const payload = canonicalValue({ ...unsignedAttestation, signer_key_id: signerKeyId });
  const signature = signCanonicalAttestation(payload, { privateKey, signerKeyId });
  const attestation = canonicalValue({ ...payload, signature });
  const errors = validateSourceReviewAttestation(attestation, {
    now: new Date(Math.max(Date.now(), Date.parse(attestation.reviewed_at || 0))),
  });
  if (errors.length) throw new Error(`source review attestation is invalid:\n- ${errors.join("\n- ")}`);
  return attestation;
}

export function verifySourceReviewAttestation(attestation, {
  trustedKeyRegistry = parseTrustedSourceReviewKeys(),
  now = new Date(),
} = {}) {
  const errors = validateSourceReviewAttestation(attestation, { now });
  if (errors.length) return Object.freeze({ valid: false, reason: "invalid_attestation", errors });
  const registry = normalizeTrustedKeyRegistry(trustedKeyRegistry);
  const verified = verifyCanonicalAttestation(sourceReviewSignedPayload(attestation), {
    signature: attestation.signature,
    signerKeyId: attestation.signer_key_id,
    trustedKeyRegistry: registry,
    purpose: "source_review",
    at: attestation.reviewed_at,
  });
  if (!verified.valid) return Object.freeze({ ...verified, errors: [] });
  const principal = normalizeReviewerPrincipal(verified.principal_id);
  if (!principal) {
    return Object.freeze({ valid: false, reason: "trusted_reviewer_principal_required", errors: [] });
  }
  if (principal !== normalizeReviewerPrincipal(attestation.reviewer_id)) {
    return Object.freeze({ valid: false, reason: "reviewer_principal_mismatch", errors: [] });
  }
  return Object.freeze({
    valid: true,
    reason: null,
    key_id: verified.key_id,
    principal_id: principal,
    errors: [],
  });
}
