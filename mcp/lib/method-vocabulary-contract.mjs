/** Signed, version-bound vocabulary evidence for method-seat statement diagnostics. */

import { canonicalValue, sha256 } from "./personas-v3/canonical.mjs";
import { verifyCanonicalAttestation } from "./personas-v3/attestations.mjs";

export const METHOD_VOCABULARY_REVIEW_PURPOSE = "method_vocabulary_review";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MASTER_ID = /^master_[a-z0-9_]+$/u;
const MINIMUM_SEAT_MARKERS = 8;
const MINIMUM_PAIR_CONFLICT_MARKERS = 4;
const MINIMUM_STATEMENT_HITS = 3;
const REQUIRED_SEAT_COUNT = 26;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactUtc(value) {
  return typeof value === "string" && ISO_UTC.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function strings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.normalize("NFKC").trim()))];
}

function vocabularyContent(document) {
  return canonicalValue({
    hash_domain: "alphacouncil.method-vocabulary-content.v1",
    schema_version: document?.schema_version,
    artifact_kind: document?.artifact_kind,
    vocabulary_version: document?.vocabulary_version,
    catalog_hash: document?.catalog_hash,
    authored_at: document?.authored_at,
    seats: document?.seats,
    confusable_pairs: document?.confusable_pairs,
  });
}

export function methodVocabularyContentHash(document) {
  return sha256(vocabularyContent(document));
}

/** Exact payload a caller may send to an offline owner-controlled Ed25519 signer. */
export function methodVocabularyReviewPayload(document) {
  return canonicalValue({
    hash_domain: "alphacouncil.method-vocabulary-review.v1",
    schema_version: document?.schema_version,
    artifact_kind: document?.artifact_kind,
    vocabulary_version: document?.vocabulary_version,
    vocabulary_hash: methodVocabularyContentHash(document),
    catalog_hash: document?.catalog_hash,
    reviewer_id: document?.review?.reviewer_id,
    signer_key_id: document?.review?.signer_key_id,
    decision: document?.review?.status,
    reviewed_at: document?.review?.reviewed_at,
  });
}

function structuralErrors(document) {
  const errors = [];
  if (!isObject(document)) return ["method vocabulary contract must be an object"];
  if (document.schema_version !== 1) errors.push("schema_version must be 1");
  if (document.artifact_kind !== "method_vocabulary_contract") errors.push("artifact_kind is invalid");
  if (typeof document.vocabulary_version !== "string" || !document.vocabulary_version.trim()) {
    errors.push("vocabulary_version is required");
  }
  if (typeof document.catalog_hash !== "string" || !/^[a-f0-9]{64}$/u.test(document.catalog_hash)) {
    errors.push("catalog_hash must be a raw sha256 digest");
  }
  if (!exactUtc(document.authored_at)) errors.push("authored_at must be an exact UTC timestamp");
  if (!Array.isArray(document.seats) || document.seats.length !== REQUIRED_SEAT_COUNT) {
    errors.push(`seats must contain exactly ${REQUIRED_SEAT_COUNT} entries`);
  }
  const seenSeats = new Set();
  for (const [index, seat] of (Array.isArray(document.seats) ? document.seats : []).entries()) {
    if (!isObject(seat) || !MASTER_ID.test(seat.master_id || "")) {
      errors.push(`seats[${index}].master_id is invalid`);
      continue;
    }
    if (seenSeats.has(seat.master_id)) errors.push(`seats[${index}].master_id is duplicated`);
    seenSeats.add(seat.master_id);
    const markers = strings(seat.positive_markers);
    if (markers.length < MINIMUM_SEAT_MARKERS || markers.length !== (seat.positive_markers?.length || 0)) {
      errors.push(`seats[${index}].positive_markers must contain at least ${MINIMUM_SEAT_MARKERS} unique strings`);
    }
  }
  if (!Array.isArray(document.confusable_pairs) || document.confusable_pairs.length === 0) {
    errors.push("confusable_pairs must be a non-empty preregistered list");
  }
  const seenPairs = new Set();
  for (const [index, pair] of (Array.isArray(document.confusable_pairs) ? document.confusable_pairs : []).entries()) {
    const validIds = MASTER_ID.test(pair?.a || "") && MASTER_ID.test(pair?.b || "")
      && pair.a !== pair.b && seenSeats.has(pair.a) && seenSeats.has(pair.b);
    if (!validIds) errors.push(`confusable_pairs[${index}] has invalid seat ids`);
    const pairId = pair?.a < pair?.b ? `${pair.a}|${pair.b}` : `${pair?.b}|${pair?.a}`;
    if (seenPairs.has(pairId)) errors.push(`confusable_pairs[${index}] is duplicated`);
    seenPairs.add(pairId);
    const markers = strings(pair?.neighbor_conflict_markers);
    if (markers.length < MINIMUM_PAIR_CONFLICT_MARKERS
      || markers.length !== (pair?.neighbor_conflict_markers?.length || 0)) {
      errors.push(`confusable_pairs[${index}].neighbor_conflict_markers must contain at least ${MINIMUM_PAIR_CONFLICT_MARKERS} unique strings`);
    }
  }
  if (!isObject(document.review)) errors.push("review is required");
  return errors;
}

function result(document, fields) {
  return Object.freeze(canonicalValue({
    valid: false,
    status: "not_evaluable",
    reason: null,
    errors: [],
    vocabulary_version: typeof document?.vocabulary_version === "string" ? document.vocabulary_version : null,
    vocabulary_hash: isObject(document) ? methodVocabularyContentHash(document) : null,
    ...fields,
  }));
}

/** Validate thresholds first, then require an exact trusted human review signature. */
export function validateMethodVocabularyContract(document, {
  trustedKeyRegistry,
  now = new Date(),
} = {}) {
  const errors = structuralErrors(document);
  if (errors.length) {
    return result(document, { reason: "vocabulary_marker_threshold_failed", errors });
  }
  const review = document.review;
  if (review.status !== "approved" || typeof review.reviewer_id !== "string" || !review.reviewer_id.trim()
    || typeof review.signer_key_id !== "string" || !review.signer_key_id.trim()
    || !exactUtc(review.reviewed_at) || typeof review.signature !== "string") {
    return result(document, { reason: "human_review_signature_required" });
  }
  if (Date.parse(review.reviewed_at) < Date.parse(document.authored_at)
    || Date.parse(review.reviewed_at) > now.getTime()) {
    return result(document, { reason: "invalid_human_review_signature", errors: ["reviewed_at is outside the valid review window"] });
  }
  const verified = verifyCanonicalAttestation(methodVocabularyReviewPayload(document), {
    signature: review.signature,
    signerKeyId: review.signer_key_id,
    trustedKeyRegistry,
    purpose: METHOD_VOCABULARY_REVIEW_PURPOSE,
    at: review.reviewed_at,
  });
  const expectedPrincipal = review.reviewer_id.normalize("NFKC").trim();
  if (!verified.valid || !verified.principal_id
    || verified.principal_id.normalize("NFKC").trim() !== expectedPrincipal) {
    return result(document, {
      reason: "invalid_human_review_signature",
      errors: [verified.reason || "reviewer_principal_mismatch"],
    });
  }
  return Object.freeze(canonicalValue({
    valid: true,
    status: "approved",
    reason: null,
    errors: [],
    vocabulary_version: document.vocabulary_version,
    vocabulary_hash: methodVocabularyContentHash(document),
    reviewer_id: expectedPrincipal,
    signer_key_id: review.signer_key_id,
    reviewed_at: review.reviewed_at,
  }));
}

function markerHits(statement, markers) {
  const normalized = statement.normalize("NFKC").toLowerCase();
  return strings(markers).filter((marker) => normalized.includes(marker.toLowerCase()));
}

/** Evaluate a statement only under the exact approved vocabulary version that produced it. */
export function evaluateMethodVocabularyStatement(document, {
  trustedKeyRegistry,
  now = new Date(),
  master_id,
  statement,
  prior_result = null,
} = {}) {
  const validation = validateMethodVocabularyContract(document, { trustedKeyRegistry, now });
  if (!validation.valid) {
    return Object.freeze(canonicalValue({
      status: "not_evaluable",
      reason: validation.reason,
      vocabulary_version: validation.vocabulary_version,
      vocabulary_hash: validation.vocabulary_hash,
      positive_hits: 0,
      neighbor_conflict_hits: 0,
    }));
  }
  if (prior_result && (prior_result.vocabulary_version !== validation.vocabulary_version
    || prior_result.vocabulary_hash !== validation.vocabulary_hash)) {
    return Object.freeze(canonicalValue({
      status: "not_evaluable",
      reason: "vocabulary_version_mismatch",
      vocabulary_version: validation.vocabulary_version,
      vocabulary_hash: validation.vocabulary_hash,
      positive_hits: 0,
      neighbor_conflict_hits: 0,
    }));
  }
  if (typeof statement !== "string" || !statement.trim()) throw new Error("method vocabulary statement is required");
  const seat = document.seats.find((candidate) => candidate.master_id === master_id);
  if (!seat) throw new Error(`method vocabulary seat is unknown: ${master_id}`);
  const conflictMarkers = document.confusable_pairs
    .filter((pair) => pair.a === master_id || pair.b === master_id)
    .flatMap((pair) => pair.neighbor_conflict_markers);
  const positive = markerHits(statement, seat.positive_markers);
  const conflicts = markerHits(statement, conflictMarkers);
  const characteristic = positive.length >= MINIMUM_STATEMENT_HITS && conflicts.length <= positive.length;
  return Object.freeze(canonicalValue({
    status: characteristic ? "characteristic" : "not_characteristic",
    reason: characteristic ? "marker_threshold_met" : "marker_threshold_not_met",
    master_id,
    vocabulary_version: validation.vocabulary_version,
    vocabulary_hash: validation.vocabulary_hash,
    positive_hits: positive.length,
    neighbor_conflict_hits: conflicts.length,
    positive_marker_ids: positive,
    neighbor_conflict_marker_ids: conflicts,
  }));
}
