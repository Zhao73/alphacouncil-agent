/**
 * Ed25519 formula-review evidence for PersonaPack v3 deterministic tools.
 *
 * This module never invents an identity, key, timestamp, or decision. Callers provide an
 * already-authored formula spec and explicit human review inputs. Compilation and release
 * gates accept the result only after two different trusted principals have signed the exact
 * spec, prototype hash, source IDs, authorship metadata, and approval decision.
 */

import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import {
  ATTESTATION_KEY_ID,
  ED25519_SIGNATURE_PREFIX,
  normalizeTrustedKeyRegistry,
  signCanonicalAttestation,
  verifyCanonicalAttestation,
} from "./attestations.mjs";

export const TRUSTED_FORMULA_REVIEW_KEYS_ENV = "ALPHACOUNCIL_TRUSTED_FORMULA_REVIEW_KEYS";
export const FORMULA_REVIEW_PURPOSE = "formula_review";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECISIONS = new Set(["approve", "reject"]);
const ATTESTATION_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "formula_spec_id", "tool_id",
  "formula_spec_hash", "review_subject_hash", "prototype_content_hash", "source_ids",
  "author_id", "authored_at", "reviewer_id", "signer_key_id", "decision", "reviewed_at",
  "signature",
]);
const SIGNED_FIELDS = Object.freeze(ATTESTATION_FIELDS.filter((field) => field !== "signature"));
const BUNDLE_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "formula_spec", "formula_spec_hash",
  "review_subject_hash", "prototype_content_hash", "source_ids", "author_id", "authored_at",
  "attestations",
]);

/** Stable pack-relative location used by compilation, candidate gates and release assembly. */
export function formulaApprovalEvidenceRelativePath(personaId, toolId) {
  if (typeof personaId !== "string" || !/^master_[a-z0-9_]+$/u.test(personaId)) {
    throw new Error("formula approval evidence requires a valid persona id");
  }
  const prefix = `${personaId}.`;
  if (typeof toolId !== "string" || !toolId.startsWith(prefix)) {
    throw new Error("formula approval evidence tool id must be persona-prefixed");
  }
  const leaf = toolId.slice(prefix.length);
  if (!/^[a-z][a-z0-9_.-]{1,119}$/u.test(leaf)) throw new Error("formula approval evidence tool id is unsafe");
  return `formula-approvals/${leaf}.approval-bundle.json`;
}

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
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function normalizedPrincipal(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized || null;
}

function exactStringArray(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) errors.push(`${label}[${index}] is invalid`);
    else if (seen.has(item)) errors.push(`${label}[${index}] is duplicated`);
    seen.add(item);
  });
}

/** The human-review subject deliberately excludes the self-declared review_subject_hash. */
export function formulaReviewSubject(spec) {
  return canonicalValue({
    hash_domain: "alphacouncil.persona-v3.formula-review.v1",
    schema_version: spec?.schema_version,
    formula_spec_id: spec?.formula_spec_id,
    persona_id: spec?.persona_id,
    prototype_id: spec?.prototype_id,
    tool_id: spec?.tool_id,
    dsl_target: spec?.dsl_target,
    prototype_provenance: spec?.prototype_provenance,
    authorship_request: spec?.authorship_request,
    formula: spec?.formula,
    provenance: spec?.provenance,
    review: {
      status: spec?.review?.status,
      reviewer_ids: spec?.review?.reviewer_ids,
      reviewed_at: spec?.review?.reviewed_at,
      approval_reference: spec?.review?.approval_reference,
    },
  });
}

export function formulaReviewSubjectHash(spec) {
  return sha256(formulaReviewSubject(spec));
}

/** Hash every field in the submitted formula spec, including its review summary. */
export function completeFormulaSpecHash(spec) {
  return sha256(canonicalValue(spec));
}

function attestationSubject(spec, {
  reviewer_id,
  signer_key_id,
  decision,
  reviewed_at,
}) {
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_formula_review_attestation",
    formula_spec_id: spec?.formula_spec_id,
    tool_id: spec?.tool_id,
    formula_spec_hash: completeFormulaSpecHash(spec),
    review_subject_hash: formulaReviewSubjectHash(spec),
    prototype_content_hash: spec?.prototype_provenance?.source_content_hash,
    source_ids: spec?.provenance?.source_ids,
    author_id: spec?.provenance?.author_id,
    authored_at: spec?.provenance?.authored_at,
    reviewer_id,
    signer_key_id,
    decision,
    reviewed_at,
  });
}

/** Build an unsigned request only from caller-supplied identity, key, decision and time. */
export function buildFormulaReviewSigningRequest(spec, review) {
  for (const field of ["reviewer_id", "signer_key_id", "decision", "reviewed_at"]) {
    if (!Object.hasOwn(review || {}, field)) throw new Error(`formula review signing request requires explicit ${field}`);
  }
  const request = attestationSubject(spec, review);
  const errors = validateUnsignedFormulaReviewAttestation(request, {
    now: new Date(Math.max(Date.now(), Date.parse(request.reviewed_at || 0))),
  });
  if (errors.length) throw new Error(`formula review signing request is invalid:\n- ${errors.join("\n- ")}`);
  return Object.freeze(request);
}

export function formulaReviewSignedPayload(attestation) {
  if (!isObject(attestation)) throw new Error("formula review attestation must be an object");
  return canonicalValue(Object.fromEntries(SIGNED_FIELDS
    .filter((field) => attestation[field] !== undefined)
    .map((field) => [field, attestation[field]])));
}

export function validateFormulaReviewAttestation(attestation, { now = new Date() } = {}) {
  const errors = [];
  if (!exactFields(attestation, ATTESTATION_FIELDS, "formula review attestation", errors)) return errors;
  if (attestation.schema_version !== 1) errors.push("formula review attestation.schema_version must be 1");
  if (attestation.artifact_kind !== "persona_v3_formula_review_attestation") errors.push("formula review attestation.artifact_kind is invalid");
  for (const field of ["formula_spec_hash", "review_subject_hash", "prototype_content_hash"]) {
    if (!HASH.test(attestation[field] || "")) errors.push(`formula review attestation.${field} must be a sha256 hash`);
  }
  for (const field of ["formula_spec_id", "tool_id", "author_id"]) {
    if (typeof attestation[field] !== "string" || !attestation[field].trim()) errors.push(`formula review attestation.${field} is required`);
  }
  const principal = normalizedPrincipal(attestation.reviewer_id);
  if (!principal || principal.length > 128) errors.push("formula review attestation.reviewer_id must identify one principal");
  if (!ATTESTATION_KEY_ID.test(attestation.signer_key_id || "")) errors.push("formula review attestation.signer_key_id is invalid");
  if (!DECISIONS.has(attestation.decision)) errors.push("formula review attestation.decision must be approve or reject");
  exactStringArray(attestation.source_ids, "formula review attestation.source_ids", errors);
  for (const field of ["authored_at", "reviewed_at"]) {
    if (!exactUtc(attestation[field])) errors.push(`formula review attestation.${field} must be an exact UTC ISO timestamp`);
  }
  if (exactUtc(attestation.authored_at) && exactUtc(attestation.reviewed_at)
    && Date.parse(attestation.reviewed_at) < Date.parse(attestation.authored_at)) {
    errors.push("formula review attestation.reviewed_at cannot precede authored_at");
  }
  if (exactUtc(attestation.reviewed_at) && Date.parse(attestation.reviewed_at) > now.getTime()) {
    errors.push("formula review attestation.reviewed_at cannot be in the future");
  }
  if (typeof attestation.signature !== "string" || !attestation.signature.startsWith(ED25519_SIGNATURE_PREFIX)) {
    errors.push("formula review attestation.signature must be an Ed25519 signature");
  }
  return errors;
}

export function validateUnsignedFormulaReviewAttestation(attestation, options = {}) {
  if (!isObject(attestation)) return ["unsigned formula review attestation must be an object"];
  if (Object.hasOwn(attestation, "signature")) return ["unsigned formula review attestation must not contain signature"];
  return validateFormulaReviewAttestation({
    ...attestation,
    signature: `${ED25519_SIGNATURE_PREFIX}${"A".repeat(86)}`,
  }, options);
}

/** Sign an explicit offline request. This function never creates keys or review decisions. */
export function signFormulaReviewAttestation(unsignedAttestation, {
  privateKey,
  signerKeyId = unsignedAttestation?.signer_key_id,
} = {}) {
  const errors = validateUnsignedFormulaReviewAttestation(unsignedAttestation, {
    now: new Date(Math.max(Date.now(), Date.parse(unsignedAttestation?.reviewed_at || 0))),
  });
  if (errors.length) throw new Error(`unsigned formula review attestation is invalid:\n- ${errors.join("\n- ")}`);
  if (signerKeyId !== unsignedAttestation.signer_key_id) throw new Error("formula review signer key id does not match the request");
  const signature = signCanonicalAttestation(formulaReviewSignedPayload(unsignedAttestation), {
    privateKey,
    signerKeyId,
  });
  return Object.freeze(canonicalValue({ ...unsignedAttestation, signature }));
}

export function parseTrustedFormulaReviewKeys(value = process.env[TRUSTED_FORMULA_REVIEW_KEYS_ENV]) {
  if (value === undefined || value === null || value === "") return new Map();
  if (typeof value !== "string") return normalizeTrustedKeyRegistry(value);
  let parsed;
  try { parsed = JSON.parse(value); } catch (error) {
    throw new Error(`${TRUSTED_FORMULA_REVIEW_KEYS_ENV} must contain JSON (${error.message})`);
  }
  return normalizeTrustedKeyRegistry(parsed);
}

/** Canonical public-only registry suitable for immutable release evidence. */
export function publicFormulaReviewKeyRegistry(value, { requireIndependentPrincipals = true } = {}) {
  const registry = normalizeTrustedKeyRegistry(value);
  const entries = [...registry.values()].map((descriptor) => canonicalValue({
    key_id: descriptor.key_id,
    public_key: descriptor.public_key.export({ type: "spki", format: "pem" }),
    principal_id: descriptor.principal_id,
    revoked: descriptor.revoked,
    not_before: descriptor.not_before,
    not_after: descriptor.not_after,
    purposes: descriptor.purposes,
  })).sort((a, b) => a.key_id.localeCompare(b.key_id));
  if (requireIndependentPrincipals) {
    const principals = new Set(entries
      .filter((entry) => entry.revoked !== true && entry.purposes?.includes(FORMULA_REVIEW_PURPOSE))
      .map((entry) => normalizedPrincipal(entry.principal_id)).filter(Boolean));
    if (principals.size < 2) throw new Error("formula review requires at least two distinct trusted formula_review principals");
  }
  return Object.freeze(canonicalValue(entries));
}

/** Bundle the exact spec and signed reviews without granting approval by itself. */
export function buildFormulaApprovalBundle({ formulaSpec, attestations } = {}) {
  if (!isObject(formulaSpec)) throw new Error("formula approval bundle requires a formula spec");
  if (!Array.isArray(attestations)) throw new Error("formula approval bundle requires attestations");
  return Object.freeze(canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_formula_approval_bundle",
    formula_spec: formulaSpec,
    formula_spec_hash: completeFormulaSpecHash(formulaSpec),
    review_subject_hash: formulaReviewSubjectHash(formulaSpec),
    prototype_content_hash: formulaSpec.prototype_provenance?.source_content_hash,
    source_ids: formulaSpec.provenance?.source_ids,
    author_id: formulaSpec.provenance?.author_id,
    authored_at: formulaSpec.provenance?.authored_at,
    attestations,
  }));
}

function attestationMatchesBundle(attestation, bundle) {
  return attestation.formula_spec_id === bundle.formula_spec?.formula_spec_id
    && attestation.tool_id === bundle.formula_spec?.tool_id
    && attestation.formula_spec_hash === bundle.formula_spec_hash
    && attestation.review_subject_hash === bundle.review_subject_hash
    && attestation.prototype_content_hash === bundle.prototype_content_hash
    && canonicalJson(attestation.source_ids) === canonicalJson(bundle.source_ids)
    && attestation.author_id === bundle.author_id
    && attestation.authored_at === bundle.authored_at;
}

/** Verify exact content binding plus a quorum of two different trusted human principals. */
export function verifyFormulaApprovalBundle(bundle, {
  trustedKeyRegistry = parseTrustedFormulaReviewKeys(),
  now = new Date(),
  expectedFormulaSpec = null,
} = {}) {
  const errors = [];
  if (!exactFields(bundle, BUNDLE_FIELDS, "formula approval bundle", errors)) {
    return Object.freeze({ valid: false, reason: "invalid_bundle", errors });
  }
  if (bundle.schema_version !== 1 || bundle.artifact_kind !== "persona_v3_formula_approval_bundle") {
    errors.push("formula approval bundle header is invalid");
  }
  if (!isObject(bundle.formula_spec)) errors.push("formula approval bundle.formula_spec must be an object");
  if (bundle.formula_spec_hash !== completeFormulaSpecHash(bundle.formula_spec)) errors.push("formula approval bundle.formula_spec_hash does not match the complete spec");
  if (bundle.review_subject_hash !== formulaReviewSubjectHash(bundle.formula_spec)) errors.push("formula approval bundle.review_subject_hash does not match the immutable review subject");
  if (bundle.prototype_content_hash !== bundle.formula_spec?.prototype_provenance?.source_content_hash) errors.push("formula approval bundle prototype hash does not match the formula spec");
  if (canonicalJson(bundle.source_ids) !== canonicalJson(bundle.formula_spec?.provenance?.source_ids)) errors.push("formula approval bundle source IDs do not match the formula spec");
  if (bundle.author_id !== bundle.formula_spec?.provenance?.author_id || bundle.authored_at !== bundle.formula_spec?.provenance?.authored_at) errors.push("formula approval bundle authorship does not match the formula spec");
  if (expectedFormulaSpec && canonicalJson(bundle.formula_spec) !== canonicalJson(expectedFormulaSpec)) errors.push("formula approval bundle contains a different formula spec");
  if (!Array.isArray(bundle.attestations) || bundle.attestations.length < 2) errors.push("formula approval bundle requires at least two attestations");
  if (errors.length) return Object.freeze({ valid: false, reason: "invalid_bundle", errors });

  let registry;
  try { registry = normalizeTrustedKeyRegistry(trustedKeyRegistry); } catch (error) {
    return Object.freeze({ valid: false, reason: "invalid_trusted_key_registry", errors: [error.message] });
  }
  const failures = [];
  const keyIds = new Set();
  const principalIds = new Set();
  const approvals = [];
  for (const [index, attestation] of bundle.attestations.entries()) {
    const validation = validateFormulaReviewAttestation(attestation, { now });
    if (validation.length) {
      failures.push({ index, signer_key_id: attestation?.signer_key_id || null, reason: "invalid_attestation", errors: validation });
      continue;
    }
    if (!attestationMatchesBundle(attestation, bundle)) {
      failures.push({ index, signer_key_id: attestation.signer_key_id, reason: "attestation_subject_mismatch", errors: [] });
      continue;
    }
    const verified = verifyCanonicalAttestation(formulaReviewSignedPayload(attestation), {
      signature: attestation.signature,
      signerKeyId: attestation.signer_key_id,
      trustedKeyRegistry: registry,
      purpose: FORMULA_REVIEW_PURPOSE,
      at: attestation.reviewed_at,
    });
    if (!verified.valid) {
      failures.push({ index, signer_key_id: attestation.signer_key_id, reason: verified.reason, errors: [] });
      continue;
    }
    const principal = normalizedPrincipal(verified.principal_id);
    if (!principal) {
      failures.push({ index, signer_key_id: attestation.signer_key_id, reason: "trusted_formula_reviewer_principal_required", errors: [] });
      continue;
    }
    if (principal !== normalizedPrincipal(attestation.reviewer_id)) {
      failures.push({ index, signer_key_id: attestation.signer_key_id, reason: "formula_reviewer_principal_mismatch", errors: [] });
      continue;
    }
    if (attestation.decision !== "approve") {
      failures.push({ index, signer_key_id: attestation.signer_key_id, reason: "formula_review_not_approved", errors: [] });
      continue;
    }
    keyIds.add(attestation.signer_key_id);
    principalIds.add(principal);
    approvals.push({ key_id: attestation.signer_key_id, principal_id: principal, reviewed_at: attestation.reviewed_at });
  }
  if (failures.length) return Object.freeze({ valid: false, reason: "approval_signature_failed", errors: [], failures });
  if (keyIds.size < 2 || principalIds.size < 2) {
    return Object.freeze({
      valid: false,
      reason: "insufficient_independent_formula_approvals",
      errors: [],
      failures: [],
      distinct_key_count: keyIds.size,
      distinct_principal_count: principalIds.size,
    });
  }
  const principals = [...principalIds].sort();
  const declaredReviewers = [...new Set((bundle.formula_spec.review?.reviewer_ids || [])
    .map(normalizedPrincipal).filter(Boolean))].sort();
  const latestReview = approvals.map((approval) => approval.reviewed_at).sort().at(-1);
  if (canonicalJson(principals) !== canonicalJson(declaredReviewers)) {
    return Object.freeze({ valid: false, reason: "formula_spec_reviewer_summary_mismatch", errors: [] });
  }
  if (bundle.formula_spec.review?.status !== "approved"
    || bundle.formula_spec.review?.reviewed_at !== latestReview) {
    return Object.freeze({ valid: false, reason: "formula_spec_review_summary_mismatch", errors: [] });
  }
  return Object.freeze({
    valid: true,
    reason: null,
    formula_spec_hash: bundle.formula_spec_hash,
    review_subject_hash: bundle.review_subject_hash,
    approval_bundle_hash: sha256(bundle),
    reviewer_principal_ids: Object.freeze(principals),
    signer_key_ids: Object.freeze([...keyIds].sort()),
    latest_reviewed_at: latestReview,
    errors: [],
    failures: [],
  });
}
