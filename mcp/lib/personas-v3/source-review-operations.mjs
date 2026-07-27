/** Read-only operational views for PersonaPack v3 human source review. */

import { canonicalValue, sha256 } from "./canonical.mjs";
import { defaultKnowledgeDir } from "./admission.mjs";
import { inspectSourceAcquisitions } from "./source-acquisition.mjs";
import { inspectSourceAdjudications } from "./source-adjudication.mjs";
import {
  parseTrustedSourceReviewKeys,
  verifySourceReviewAttestation,
} from "./source-review-attestations.mjs";
import { defaultStagingRoot } from "./staging.mjs";
import { defaultPersonaDir } from "../personas/registry.mjs";

const REVIEW_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "reviewer_id", "signer_key_id", "decision",
  "content_hash", "anchor_hash", "reviewed_at", "affirmations", "notes", "signature",
]);

export const SOURCE_REVIEW_INSTRUCTIONS = Object.freeze([
  "Open the archived source.bin identified by raw_acquisition.archive_path; do not review a live replacement URL.",
  "Recompute or independently compare raw_acquisition.content_hash before relying on the bytes.",
  "A human must enter every field named in proposal_pending_fields after inspecting the archived material.",
  "The locator must identify the exact page, chapter, section, timestamp, or filing item that supports the claim.",
  "Run adjudicate-persona-source prepare in plan mode, inspect content_hash and anchor_hash, then use --write explicitly.",
  "Each reviewer must independently inspect the raw bytes and exact locator before completing an unsigned review request.",
  "Sign reviews offline with a registered Ed25519 key; never share or copy the private key into the repository or batch.",
  "Run adjudicate-persona-source review in plan mode before --write; two distinct trusted principals and keys are required.",
  "No batch, signature, approval, or quorum result promotes a PersonaPack or writes production knowledge.",
]);

function humanProposalTemplate(record) {
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_source_anchor_proposal",
    persona_id: record.persona_id,
    candidate_id: record.candidate_id,
    source_id: "REPLACE",
    source_kind: "REPLACE",
    grade: "REPLACE",
    author: "REPLACE",
    title: "REPLACE",
    url: record.final_url,
    published_at: "REPLACE",
    public_at: "REPLACE",
    known_at: null,
    locator: { section: "REPLACE" },
    summary: "REPLACE",
    supports: ["REPLACE"],
  });
}

function unsignedReviewTemplate(record) {
  if (!record) return null;
  return canonicalValue({
    schema_version: 2,
    artifact_kind: "persona_v3_source_review_attestation",
    reviewer_id: "REPLACE",
    signer_key_id: "REPLACE",
    decision: "REPLACE",
    content_hash: record.acquisition.content_hash,
    anchor_hash: record.anchor_hash,
    reviewed_at: "REPLACE",
    affirmations: {
      reviewed_raw_archive_bytes: false,
      verified_locator_against_raw_material: false,
      reviewer_is_human: false,
      review_was_independent: false,
    },
    notes: "REPLACE",
  });
}

function humanAttestation(persisted) {
  return canonicalValue(Object.fromEntries(REVIEW_FIELDS.map((field) => [field, persisted[field]])));
}

/** Derive quorum only from currently valid signatures and trusted principal bindings. */
export function trustedSourceReviewQuorum(record, {
  trustedReviewerKeys = parseTrustedSourceReviewKeys(),
  now = new Date(),
} = {}) {
  if (!record) {
    return canonicalValue({
      status: "not_prepared",
      satisfied: false,
      distinct_approver_principal_count: 0,
      distinct_approver_key_count: 0,
      approver_principal_ids: [],
      approver_key_ids: [],
      rejecter_principal_ids: [],
      invalid_attestations: [],
      conflicts: [],
    });
  }
  const valid = [];
  const invalid = [];
  for (const [index, persisted] of record.review_attestations.entries()) {
    const attestation = humanAttestation(persisted);
    const verification = verifySourceReviewAttestation(attestation, {
      trustedKeyRegistry: trustedReviewerKeys,
      now,
    });
    if (!verification.valid) {
      invalid.push({ index, signer_key_id: attestation.signer_key_id, reason: verification.reason });
      continue;
    }
    valid.push({
      decision: attestation.decision,
      key_id: verification.key_id,
      principal_id: verification.principal_id,
    });
  }
  const decisions = new Map();
  for (const item of valid) {
    if (!decisions.has(item.principal_id)) decisions.set(item.principal_id, new Set());
    decisions.get(item.principal_id).add(item.decision);
  }
  const conflicts = [...decisions.entries()]
    .filter(([, values]) => values.size > 1)
    .map(([principalId]) => principalId)
    .sort();
  const approvers = [...new Set(valid.filter((item) => item.decision === "approve")
    .map((item) => item.principal_id))].sort();
  const approverKeys = [...new Set(valid.filter((item) => item.decision === "approve")
    .map((item) => item.key_id))].sort();
  const rejecters = [...new Set(valid.filter((item) => item.decision === "reject")
    .map((item) => item.principal_id))].sort();
  const satisfied = invalid.length === 0 && conflicts.length === 0 && rejecters.length === 0
    && approvers.length >= 2 && approverKeys.length >= 2;
  let status = "pending";
  if (invalid.length) status = "invalid";
  else if (conflicts.length || (approvers.length && rejecters.length)) status = "blocked";
  else if (rejecters.length) status = "rejected";
  else if (satisfied) status = "approved";
  return canonicalValue({
    status,
    satisfied,
    distinct_approver_principal_count: approvers.length,
    distinct_approver_key_count: approverKeys.length,
    approver_principal_ids: approvers,
    approver_key_ids: approverKeys,
    rejecter_principal_ids: rejecters,
    invalid_attestations: invalid,
    conflicts,
  });
}

function candidateReviewEntry(acquisition, ledgerRecord, trustedReviewerKeys, now) {
  const prepared = Boolean(ledgerRecord);
  return canonicalValue({
    candidate_id: acquisition.candidate_id,
    source_id: ledgerRecord?.source_id ?? null,
    workflow_state: prepared ? "prepared_for_human_review" : "awaiting_human_proposal",
    raw_acquisition: {
      record_path: `${acquisition.persona_id}/acquisitions/candidates/${acquisition.candidate_id}/record.json`,
      archive_path: `${acquisition.persona_id}/${acquisition.archive_path}`,
      seat_relative_record_path: `acquisitions/candidates/${acquisition.candidate_id}/record.json`,
      seat_relative_archive_path: acquisition.archive_path,
      record_hash: sha256(acquisition),
      content_hash: acquisition.content_hash,
      byte_length: acquisition.byte_length,
      content_type: acquisition.content_type,
      requested_url: acquisition.requested_url,
      final_url: acquisition.final_url,
      retrieved_at: acquisition.retrieved_at,
    },
    proposal: ledgerRecord?.proposal ?? null,
    proposal_template: prepared ? null : humanProposalTemplate(acquisition),
    proposal_hash: ledgerRecord?.proposal_hash ?? null,
    proposal_pending_fields: prepared ? [] : [
      "source_id", "source_kind", "grade", "author", "title", "published_at", "public_at",
      "known_at_if_known", "locator", "summary", "supports", "url_confirmed_against_acquisition",
    ],
    exact_locator: ledgerRecord?.proposal?.locator ?? null,
    exact_locator_pending: !ledgerRecord?.proposal?.locator,
    content_hash: acquisition.content_hash,
    anchor_hash: ledgerRecord?.anchor_hash ?? null,
    unsigned_review_template: unsignedReviewTemplate(ledgerRecord),
    trusted_quorum: trustedSourceReviewQuorum(ledgerRecord, { trustedReviewerKeys, now }),
  });
}

export function buildSourceReviewBatch({
  root = defaultStagingRoot(),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  trustedReviewerKeys = parseTrustedSourceReviewKeys(),
  now = new Date(),
} = {}) {
  const acquisitions = inspectSourceAcquisitions({ root, productionRoot, personaDir, now });
  const adjudications = inspectSourceAdjudications({
    root, productionRoot, personaDir, trustedReviewerKeys, now,
  });
  const adjudicationByPersona = new Map(adjudications.personas.map((seat) => [seat.persona_id, seat]));
  const personas = acquisitions.personas.map((seat) => {
    const adjudication = adjudicationByPersona.get(seat.persona_id);
    const ledgerByCandidate = new Map((adjudication?.records || [])
      .map((record) => [record.candidate_id, record]));
    const candidates = seat.records.map((record) => candidateReviewEntry(
      record,
      ledgerByCandidate.get(record.candidate_id),
      trustedReviewerKeys,
      now,
    ));
    return canonicalValue({
      persona_id: seat.persona_id,
      candidate_count: candidates.length,
      prepared_count: candidates.filter((item) => item.anchor_hash !== null).length,
      trusted_quorum_count: candidates.filter((item) => item.trusted_quorum.satisfied).length,
      errors: [...seat.errors, ...(adjudication?.errors || [])],
      candidates,
    });
  });
  const candidates = personas.flatMap((seat) => seat.candidates);
  const prepared = candidates.filter((item) => item.anchor_hash !== null);
  const stable = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_source_review_batch",
    canonical_master_count: personas.length,
    reviewer_instructions: SOURCE_REVIEW_INSTRUCTIONS,
    progress: {
      seat_count: personas.length,
      seats_with_raw_acquisition: personas.filter((seat) => seat.candidate_count > 0).length,
      raw_acquisition_count: candidates.length,
      proposal_pending_count: candidates.length - prepared.length,
      prepared_source_count: prepared.length,
      trusted_quorum_source_count: prepared.filter((item) => item.trusted_quorum.satisfied).length,
      invalid_seat_count: personas.filter((seat) => seat.errors.length).length,
      all_26_seats_acquired: personas.length === 26 && personas.every((seat) => seat.candidate_count > 0),
      all_candidates_prepared: candidates.length > 0 && prepared.length === candidates.length,
      all_prepared_sources_have_two_distinct_trusted_principals: prepared.length > 0
        && prepared.every((item) => item.trusted_quorum.satisfied),
      all_26_seats_have_a_two_principal_quorum_source: personas.length === 26
        && personas.every((seat) => seat.candidates.some((item) => item.trusted_quorum.satisfied)),
      production_write_count: 0,
    },
    personas,
  });
  return Object.freeze({
    ...stable,
    generated_at: now.toISOString(),
    batch_hash: sha256(stable),
  });
}
