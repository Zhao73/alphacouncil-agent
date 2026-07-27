/**
 * Human-only source adjudication for PersonaPack v3 staging.
 *
 * Acquisition proves which bytes were retrieved. This module binds those immutable bytes to
 * human-supplied source metadata, then records explicit human review attestations. It never
 * infers source metadata, never fabricates reviewers, and never writes production knowledge.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants as fsConstants,
} from "node:fs";
import { hostname as systemHostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalValue, sha256 } from "./canonical.mjs";
import { fsyncDirectoryStrictly } from "./platform-durability.mjs";
import { defaultKnowledgeDir } from "./admission.mjs";
import {
  parseTrustedSourceReviewKeys,
  validateSourceReviewAttestation,
  verifySourceReviewAttestation,
} from "./source-review-attestations.mjs";
import {
  normalizeExplicitHttpUrl,
  sha256Bytes,
  validateSourceAcquisitionRecord,
} from "./source-acquisition.mjs";
import { validateSourceAnchor } from "./source-anchor.mjs";
import {
  CANONICAL_MASTER_IDS,
  defaultStagingRoot,
  inspectPersonaV3Staging,
} from "./staging.mjs";
import { defaultPersonaDir } from "../personas/registry.mjs";

const QUEUE_FILE = "source-adjudication-queue.json";
const LEDGER_FILE = "source-adjudication-ledger.json";
const LOCK_FILE = ".source-adjudication-write.lock";
const TRANSACTION_PREFIX = ".source-adjudication-transaction-";
const REPLACE_PREFIX = ".source-adjudication-replace-";
const LEASE_MS = 30_000;
const DEAD_OWNER_GRACE_MS = 5_000;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CANDIDATE_ID = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/u;
const SOURCE_ID = /^[a-z0-9_:-]{3,128}$/u;
const SOURCE_KINDS = new Set([
  "primary_text", "primary_behavior", "derived_proxy", "empirical_calibration", "editorial_choice",
]);
const GRADES = new Set(["A", "B", "C", "D", "E"]);
const LOCATOR_FIELDS = new Set(["page", "chapter", "section", "timestamp", "filing_item"]);
const PROPOSAL_FIELDS = new Set([
  "schema_version", "artifact_kind", "persona_id", "candidate_id", "source_id",
  "source_kind", "grade", "author", "title", "url", "published_at", "public_at",
  "known_at", "locator", "summary", "excerpt", "supports",
]);
const PROPOSAL_REQUIRED = [
  "schema_version", "artifact_kind", "persona_id", "candidate_id", "source_id",
  "source_kind", "grade", "author", "title", "url", "published_at", "public_at",
  "locator", "summary", "supports",
];
const REVIEW_FIELDS = new Set([
  "schema_version", "artifact_kind", "reviewer_id", "signer_key_id", "decision",
  "content_hash", "anchor_hash", "reviewed_at", "affirmations", "notes", "signature",
]);
const AFFIRMATION_FIELDS = [
  "reviewed_raw_archive_bytes",
  "verified_locator_against_raw_material",
  "reviewer_is_human",
  "review_was_independent",
];
const LEDGER_FIELDS = ["schema_version", "artifact_kind", "persona_id", "records"];
const LEDGER_RECORD_FIELDS = [
  "schema_version", "persona_id", "candidate_id", "source_id", "status", "status_reason",
  "acquisition", "proposal", "proposal_hash", "anchor_hash", "prepared_at",
  "review_attestations", "attestation_chain_head",
];
const ACQUISITION_BINDING_FIELDS = [
  "record_path", "archive_path", "record_hash", "content_hash", "byte_length",
];
const PERSISTED_ATTESTATION_FIELDS = [
  ...REVIEW_FIELDS,
  "normalized_reviewer_id",
  "previous_attestation_hash",
  "attestation_hash",
];
const LEASE_FIELDS = [
  "schema_version", "artifact_kind", "owner_token", "hostname", "pid", "acquired_at", "expires_at",
];
const TRANSACTION_FIELDS = [
  "schema_version", "artifact_kind", "transaction_id", "persona_id", "created_at",
  "base_queue_hash", "next_queue_hash", "base_ledger_hash", "next_ledger_hash",
  "next_queue", "next_ledger",
];

export const SOURCE_ADJUDICATION_FILES = Object.freeze({
  queue: QUEUE_FILE,
  ledger: LEDGER_FILE,
  lock: LOCK_FILE,
  transaction_prefix: TRANSACTION_PREFIX,
  lease_ms: LEASE_MS,
  dead_owner_grace_ms: DEAD_OWNER_GRACE_MS,
});

export class PersonaSourceAdjudicationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaSourceAdjudicationError";
    this.details = canonicalValue(details);
  }
}

function fail(message, details = {}) {
  throw new PersonaSourceAdjudicationError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function exactKeys(value, allowed, required, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const allowedSet = allowed instanceof Set ? allowed : new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) errors.push(`${label}.${key} is not allowed`);
  for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${label}.${key} is required`);
  return true;
}

function exactIso(value) {
  if (!nonEmpty(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function dated(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function normalizedReviewerId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized || null;
}

function placeholder(value) {
  return typeof value === "string" && /^(?:replace|tbd|todo|unknown|n\/a)$/iu.test(value.trim());
}

function assertValid(errors, label) {
  if (errors.length) fail(`${label} is invalid:\n- ${errors.join("\n- ")}`, { errors });
}

export function validateSourceAnchorProposal(proposal, { personaId, candidateId } = {}) {
  const errors = [];
  if (!exactKeys(proposal, PROPOSAL_FIELDS, PROPOSAL_REQUIRED, "proposal", errors)) return errors;
  if (proposal.schema_version !== 1) errors.push("proposal.schema_version must be 1");
  if (proposal.artifact_kind !== "persona_v3_source_anchor_proposal") errors.push("proposal.artifact_kind is invalid");
  if (!CANONICAL_MASTER_IDS.includes(proposal.persona_id)) errors.push("proposal.persona_id is not a canonical master");
  if (personaId && proposal.persona_id !== personaId) errors.push("proposal.persona_id does not match the requested seat");
  if (!CANDIDATE_ID.test(proposal.candidate_id || "")) errors.push("proposal.candidate_id is invalid");
  if (candidateId && proposal.candidate_id !== candidateId) errors.push("proposal.candidate_id does not match the requested acquisition");
  if (!SOURCE_ID.test(proposal.source_id || "")) errors.push("proposal.source_id is invalid");
  if (!SOURCE_KINDS.has(proposal.source_kind)) errors.push("proposal.source_kind is invalid");
  if (!GRADES.has(proposal.grade)) errors.push("proposal.grade is invalid");
  for (const field of ["author", "title"]) {
    if (!nonEmpty(proposal[field]) || placeholder(proposal[field])) errors.push(`proposal.${field} must be human-supplied non-placeholder text`);
  }
  try {
    const normalized = normalizeExplicitHttpUrl(proposal.url, "proposal.url");
    if (normalized !== proposal.url) errors.push("proposal.url must use canonical URL serialization");
  } catch (error) {
    errors.push(error.message);
  }
  for (const field of ["published_at", "public_at"]) if (!dated(proposal[field])) errors.push(`proposal.${field} must be a valid dated string`);
  if (proposal.known_at !== undefined && proposal.known_at !== null && !dated(proposal.known_at)) errors.push("proposal.known_at must be null or a valid dated string");
  if (dated(proposal.published_at) && dated(proposal.public_at)
    && Date.parse(proposal.public_at) < Date.parse(proposal.published_at)) {
    errors.push("proposal.public_at cannot precede proposal.published_at");
  }
  if (!isObject(proposal.locator) || !Object.keys(proposal.locator).length) {
    errors.push("proposal.locator must identify an exact place in the raw material");
  } else {
    for (const [field, value] of Object.entries(proposal.locator)) {
      if (!LOCATOR_FIELDS.has(field)) errors.push(`proposal.locator.${field} is not allowed`);
      else if (!(Number.isSafeInteger(value) || nonEmpty(value))) errors.push(`proposal.locator.${field} must be non-empty text or an integer`);
    }
  }
  if (!nonEmpty(proposal.summary) || proposal.summary.trim().length < 8 || proposal.summary.length > 1200 || placeholder(proposal.summary)) {
    errors.push("proposal.summary must be human-supplied text from 8 through 1200 characters");
  }
  if (proposal.excerpt !== undefined && (typeof proposal.excerpt !== "string" || proposal.excerpt.length > 400)) {
    errors.push("proposal.excerpt must be at most 400 characters");
  }
  if (!Array.isArray(proposal.supports) || !proposal.supports.length
    || proposal.supports.some((value) => !nonEmpty(value))) {
    errors.push("proposal.supports must be a non-empty human-supplied string array");
  } else {
    const normalized = proposal.supports.map((value) => value.normalize("NFKC").trim());
    if (new Set(normalized).size !== normalized.length) errors.push("proposal.supports contains duplicates after NFKC normalization");
  }
  return errors;
}

export function validateReviewerAttestation(attestation, { now = new Date() } = {}) {
  return validateSourceReviewAttestation(attestation, { now });
}

function secureRead(file, { optional = false } = {}) {
  if (!existsSync(file)) {
    if (optional) return null;
    fail(`required file is missing: ${file}`);
  }
  if (lstatSync(file).isSymbolicLink()) fail(`symlinked file is forbidden: ${file}`);
  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) fail(`expected a regular file: ${file}`);
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function secureReadJson(file, options = {}) {
  const bytes = secureRead(file, options);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${file}: invalid JSON (${error.message})`);
  }
}

export function readHumanJsonFile(file) {
  if (!nonEmpty(file)) fail("human JSON input path is required");
  return canonicalValue(secureReadJson(resolve(file)));
}

function defaultLedger(personaId) {
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "source_adjudication_ledger",
    persona_id: personaId,
    records: [],
  });
}

function anchorSubject(anchor) {
  const { adjudication: _adjudication, ...subject } = anchor;
  return canonicalValue(subject);
}

function attestationHashPayload(attestation) {
  const { attestation_hash: _hash, ...payload } = attestation;
  return canonicalValue(payload);
}

function reviewOutcome(attestations) {
  const bySigningKey = new Map();
  for (const attestation of attestations) {
    if (!bySigningKey.has(attestation.signer_key_id)) bySigningKey.set(attestation.signer_key_id, []);
    bySigningKey.get(attestation.signer_key_id).push(attestation);
  }
  const conflictingReviewerIds = [];
  const duplicateReviewerIds = [];
  const approverIds = [];
  const rejecterIds = [];
  const approverKeyIds = [];
  const rejecterKeyIds = [];
  const decisionsByPrincipal = new Map();
  for (const [keyId, records] of bySigningKey) {
    const principals = new Set(records.map((record) => record.normalized_reviewer_id));
    if (principals.size !== 1) {
      conflictingReviewerIds.push(...principals);
      continue;
    }
    const [id] = principals;
    if (records.length > 1) duplicateReviewerIds.push(id);
    const decisions = new Set(records.map((record) => record.decision));
    if (decisions.size > 1) conflictingReviewerIds.push(id);
    else {
      if (!decisionsByPrincipal.has(id)) decisionsByPrincipal.set(id, new Set());
      for (const decision of decisions) decisionsByPrincipal.get(id).add(decision);
      if (decisions.has("approve")) approverKeyIds.push(keyId);
      else if (decisions.has("reject")) rejecterKeyIds.push(keyId);
    }
  }
  for (const [id, decisions] of decisionsByPrincipal) {
    if (decisions.size > 1) conflictingReviewerIds.push(id);
    else if (decisions.has("approve")) approverIds.push(id);
    else if (decisions.has("reject")) rejecterIds.push(id);
  }
  approverIds.sort();
  rejecterIds.sort();
  duplicateReviewerIds.sort();
  conflictingReviewerIds.sort();
  approverKeyIds.sort();
  rejecterKeyIds.sort();
  let status;
  let reason;
  if (conflictingReviewerIds.length || (approverIds.length && rejecterIds.length)) {
    status = "blocked";
    reason = "conflicting_human_reviews";
  } else if (rejecterIds.length) {
    status = "rejected";
    reason = "human_reviewer_rejected";
  } else if (approverIds.length >= 2) {
    status = "approved";
    reason = "two_independent_cryptographically_verified_human_approvals";
  } else {
    status = "pending";
    reason = approverIds.length ? "awaiting_second_independent_human_approval" : "awaiting_human_review";
  }
  return canonicalValue({
    status,
    reason,
    approver_ids: approverIds,
    rejecter_ids: rejecterIds,
    duplicate_reviewer_ids: duplicateReviewerIds,
    conflicting_reviewer_ids: conflictingReviewerIds,
    reviewer_ids: [...new Set([...approverIds, ...rejecterIds])].sort(),
    approver_key_ids: [...new Set(approverKeyIds)].sort(),
    rejecter_key_ids: [...new Set(rejecterKeyIds)].sort(),
    reviewer_key_ids: [...new Set([...approverKeyIds, ...rejecterKeyIds])].sort(),
  });
}

function anchorAdjudication(attestations) {
  const outcome = reviewOutcome(attestations);
  const reviewedAt = attestations.length
    ? [...attestations].map((item) => item.reviewed_at).sort().at(-1)
    : null;
  return canonicalValue({
    status: outcome.status === "approved" ? "approved" : outcome.status === "rejected" ? "rejected" : "pending",
    reviewer_ids: outcome.reviewer_ids,
    reviewed_at: reviewedAt,
    notes: outcome.reason,
  });
}

function validatePersistedAttestation(attestation, index, record, errors) {
  const label = `ledger.review_attestations[${index}]`;
  if (!exactKeys(attestation, PERSISTED_ATTESTATION_FIELDS, PERSISTED_ATTESTATION_FIELDS, label, errors)) return;
  const humanFields = canonicalValue(Object.fromEntries(
    [...REVIEW_FIELDS].map((field) => [field, attestation[field]]),
  ));
  errors.push(...validateReviewerAttestation(humanFields, { now: new Date("9999-12-31T23:59:59.999Z") })
    .map((error) => `${label}: ${error}`));
  const normalized = normalizedReviewerId(attestation.reviewer_id);
  if (normalized !== attestation.normalized_reviewer_id) errors.push(`${label}.normalized_reviewer_id does not match NFKC normalization`);
  if (attestation.content_hash !== record.acquisition?.content_hash) errors.push(`${label}.content_hash does not match acquisition`);
  if (attestation.anchor_hash !== record.anchor_hash) errors.push(`${label}.anchor_hash does not match ledger record`);
  if (!(attestation.previous_attestation_hash === null || HASH.test(attestation.previous_attestation_hash || ""))) {
    errors.push(`${label}.previous_attestation_hash is invalid`);
  }
  if (attestation.attestation_hash !== sha256(attestationHashPayload(attestation))) errors.push(`${label}.attestation_hash is invalid`);
}

export function validateAdjudicationLedger(ledger, { personaId } = {}) {
  const errors = [];
  if (!exactKeys(ledger, LEDGER_FIELDS, LEDGER_FIELDS, "ledger", errors)) return errors;
  if (ledger.schema_version !== 1) errors.push("ledger.schema_version must be 1");
  if (ledger.artifact_kind !== "source_adjudication_ledger") errors.push("ledger.artifact_kind is invalid");
  if (!CANONICAL_MASTER_IDS.includes(ledger.persona_id)) errors.push("ledger.persona_id is not canonical");
  if (personaId && ledger.persona_id !== personaId) errors.push("ledger.persona_id does not match seat");
  if (!Array.isArray(ledger.records)) {
    errors.push("ledger.records must be an array");
    return errors;
  }
  const sourceIds = new Set();
  const candidateIds = new Set();
  const contentHashes = new Set();
  ledger.records.forEach((record, recordIndex) => {
    const label = `ledger.records[${recordIndex}]`;
    if (!exactKeys(record, LEDGER_RECORD_FIELDS, LEDGER_RECORD_FIELDS, label, errors)) return;
    if (record.schema_version !== 1) errors.push(`${label}.schema_version must be 1`);
    if (record.persona_id !== ledger.persona_id) errors.push(`${label}.persona_id does not match ledger`);
    if (!CANDIDATE_ID.test(record.candidate_id || "")) errors.push(`${label}.candidate_id is invalid`);
    if (!SOURCE_ID.test(record.source_id || "")) errors.push(`${label}.source_id is invalid`);
    for (const [set, value, field] of [[sourceIds, record.source_id, "source_id"], [candidateIds, record.candidate_id, "candidate_id"]]) {
      if (set.has(value)) errors.push(`${label}.${field} is duplicated`);
      set.add(value);
    }
    if (!["pending", "approved", "rejected", "blocked"].includes(record.status)) errors.push(`${label}.status is invalid`);
    if (!nonEmpty(record.status_reason)) errors.push(`${label}.status_reason is required`);
    if (exactKeys(record.acquisition, ACQUISITION_BINDING_FIELDS, ACQUISITION_BINDING_FIELDS, `${label}.acquisition`, errors)) {
      if (!HASH.test(record.acquisition.record_hash || "")) errors.push(`${label}.acquisition.record_hash is invalid`);
      if (!HASH.test(record.acquisition.content_hash || "")) errors.push(`${label}.acquisition.content_hash is invalid`);
      if (!Number.isSafeInteger(record.acquisition.byte_length) || record.acquisition.byte_length < 1) errors.push(`${label}.acquisition.byte_length is invalid`);
      if (contentHashes.has(record.acquisition.content_hash)) errors.push(`${label}.acquisition.content_hash is duplicate evidence`);
      contentHashes.add(record.acquisition.content_hash);
    }
    const proposalErrors = validateSourceAnchorProposal(record.proposal, {
      personaId: record.persona_id,
      candidateId: record.candidate_id,
    });
    errors.push(...proposalErrors.map((error) => `${label}: ${error}`));
    if (record.proposal?.source_id !== record.source_id) errors.push(`${label}.proposal.source_id does not match record`);
    if (record.proposal_hash !== sha256(record.proposal)) errors.push(`${label}.proposal_hash is invalid`);
    if (!HASH.test(record.anchor_hash || "")) errors.push(`${label}.anchor_hash is invalid`);
    if (!exactIso(record.prepared_at)) errors.push(`${label}.prepared_at must be an exact ISO timestamp`);
    if (!Array.isArray(record.review_attestations)) errors.push(`${label}.review_attestations must be an array`);
    else {
      let previous = null;
      record.review_attestations.forEach((attestation, index) => {
        validatePersistedAttestation(attestation, index, record, errors);
        if (attestation?.previous_attestation_hash !== previous) errors.push(`${label}.review_attestations[${index}] breaks the attestation hash chain`);
        previous = attestation?.attestation_hash;
      });
      if (record.attestation_chain_head !== previous) errors.push(`${label}.attestation_chain_head does not match the chain`);
      const outcome = reviewOutcome(record.review_attestations);
      if (record.status !== outcome.status) errors.push(`${label}.status does not match review attestations`);
      if (record.status_reason !== outcome.reason) errors.push(`${label}.status_reason does not match review attestations`);
    }
  });
  return errors;
}

function queueErrors(queue, personaId) {
  const errors = [];
  if (!exactKeys(queue, ["schema_version", "artifact_kind", "persona_id", "records"], ["schema_version", "artifact_kind", "persona_id", "records"], "queue", errors)) return errors;
  if (queue.schema_version !== 1) errors.push("queue.schema_version must be 1");
  if (queue.artifact_kind !== "source_adjudication_queue") errors.push("queue.artifact_kind is invalid");
  if (queue.persona_id !== personaId) errors.push("queue.persona_id does not match seat");
  if (!Array.isArray(queue.records)) errors.push("queue.records must be an array");
  else {
    const ids = new Set();
    const hashes = new Set();
    queue.records.forEach((anchor, index) => {
      errors.push(...validateSourceAnchor(anchor, { file: `queue.records[${index}]` }));
      if (ids.has(anchor?.source_id)) errors.push(`queue.records[${index}]: duplicate source_id`);
      ids.add(anchor?.source_id);
      if (hashes.has(anchor?.content_hash)) errors.push(`queue.records[${index}]: duplicate content_hash`);
      hashes.add(anchor?.content_hash);
    });
  }
  return errors;
}

function safeSeatPaths({ root, productionRoot, personaDir, personaId, now }) {
  if (!CANONICAL_MASTER_IDS.includes(personaId)) fail(`persona must be one of the canonical 26 master IDs: ${personaId}`);
  const staging = inspectPersonaV3Staging({ root, productionRoot, personaDir, now });
  if (staging.global_errors.length || staging.invalid_count || staging.unsafe_artifact_count) {
    const reasons = [
      ...staging.global_errors,
      ...(staging.personas || []).flatMap((seat) => (seat.errors || []).map((error) => `${seat.persona_id}: ${error}`)),
    ];
    fail(`PersonaPack v3 staging must pass integrity checks before adjudication${reasons.length ? `:\n- ${reasons.join("\n- ")}` : ""}`, { staging });
  }
  const stagingRoot = realpathSync(staging.staging_root);
  const production = realpathSync(productionRoot);
  if (inside(stagingRoot, production) || inside(production, stagingRoot)) fail("staging and production roots must be disjoint");
  const seat = join(stagingRoot, personaId);
  if (lstatSync(seat).isSymbolicLink() || !statSync(seat).isDirectory()) fail("staging seat must be a physical directory");
  const physicalSeat = realpathSync(seat);
  if (!inside(stagingRoot, physicalSeat)) fail("staging seat escapes the staging root");
  return {
    root: stagingRoot,
    production,
    seat: physicalSeat,
    queue: join(physicalSeat, QUEUE_FILE),
    ledger: join(physicalSeat, LEDGER_FILE),
    lock: join(physicalSeat, LOCK_FILE),
  };
}

function readState(paths, personaId) {
  const queue = secureReadJson(paths.queue);
  const ledger = secureReadJson(paths.ledger, { optional: true }) || defaultLedger(personaId);
  assertValid(queueErrors(queue, personaId), "source adjudication queue");
  assertValid(validateAdjudicationLedger(ledger, { personaId }), "source adjudication ledger");
  return { queue: canonicalValue(queue), ledger: canonicalValue(ledger) };
}

function acquisitionFor(paths, personaId, candidateId) {
  if (!CANDIDATE_ID.test(candidateId || "")) fail("candidate-id is invalid");
  const candidateDir = join(paths.seat, "acquisitions", "candidates", candidateId);
  if (!existsSync(candidateDir) || lstatSync(candidateDir).isSymbolicLink() || !statSync(candidateDir).isDirectory()) {
    fail(`acquisition candidate is missing or unsafe: ${candidateId}`);
  }
  const physical = realpathSync(candidateDir);
  if (!inside(paths.seat, physical)) fail("acquisition candidate escapes the staging seat");
  const recordFile = join(physical, "record.json");
  const archiveFile = join(physical, "source.bin");
  const record = secureReadJson(recordFile);
  const errors = validateSourceAcquisitionRecord(record, { label: "acquisition record" });
  if (record?.persona_id !== personaId) errors.push("acquisition record persona_id does not match seat");
  if (record?.candidate_id !== candidateId) errors.push("acquisition record candidate_id does not match directory");
  const expectedRecordPath = `acquisitions/candidates/${candidateId}/record.json`;
  const expectedArchivePath = `acquisitions/candidates/${candidateId}/source.bin`;
  if (record?.archive_path !== expectedArchivePath) errors.push("acquisition record archive_path is invalid");
  const bytes = secureRead(archiveFile);
  if (bytes.length !== record?.byte_length) errors.push("archived byte length does not match acquisition record");
  const contentHash = sha256Bytes(bytes);
  if (contentHash !== record?.content_hash) errors.push("archived byte content_hash does not match acquisition record");
  assertValid(errors, "source acquisition binding");
  return canonicalValue({
    record,
    binding: {
      record_path: expectedRecordPath,
      archive_path: expectedArchivePath,
      record_hash: sha256(record),
      content_hash: contentHash,
      byte_length: bytes.length,
    },
  });
}

function buildAnchor(proposal, acquisition, adjudication = null) {
  const anchor = {
    schema_version: 1,
    source_id: proposal.source_id,
    source_kind: proposal.source_kind,
    grade: proposal.grade,
    author: proposal.author,
    title: proposal.title,
    url: proposal.url,
    published_at: proposal.published_at,
    public_at: proposal.public_at,
    retrieved_at: acquisition.record.retrieved_at,
    locator: proposal.locator,
    summary: proposal.summary,
    content_hash: acquisition.binding.content_hash,
    supports: proposal.supports,
    adjudication: adjudication || {
      status: "pending",
      reviewer_ids: [],
      reviewed_at: null,
      notes: "awaiting_human_review",
    },
  };
  if (Object.hasOwn(proposal, "known_at")) anchor.known_at = proposal.known_at;
  if (Object.hasOwn(proposal, "excerpt")) anchor.excerpt = proposal.excerpt;
  return canonicalValue(anchor);
}

function prepareMutation(state, proposal, acquisition, now) {
  const existingCandidate = state.ledger.records.find((record) => record.candidate_id === proposal.candidate_id);
  const proposalHash = sha256(proposal);
  if (existingCandidate) {
    if (existingCandidate.source_id !== proposal.source_id || existingCandidate.proposal_hash !== proposalHash
      || existingCandidate.acquisition.content_hash !== acquisition.binding.content_hash
      || existingCandidate.acquisition.record_hash !== acquisition.binding.record_hash) {
      fail(`candidate ${proposal.candidate_id} is already prepared with different immutable inputs`);
    }
    const anchor = state.queue.records.find((record) => record.source_id === existingCandidate.source_id);
    if (!anchor || sha256(anchorSubject(anchor)) !== existingCandidate.anchor_hash) fail("existing prepared anchor no longer matches its ledger binding");
    return { status: "already_prepared", queue: state.queue, ledger: state.ledger, record: existingCandidate, anchor };
  }
  if (state.ledger.records.some((record) => record.source_id === proposal.source_id)
    || state.queue.records.some((record) => record.source_id === proposal.source_id)) {
    fail(`source_id already exists in the adjudication queue: ${proposal.source_id}`);
  }
  if (state.ledger.records.some((record) => record.acquisition.content_hash === acquisition.binding.content_hash)
    || state.queue.records.some((record) => record.content_hash === acquisition.binding.content_hash)) {
    fail("the acquisition content_hash already belongs to another source anchor");
  }
  if (![acquisition.record.requested_url, acquisition.record.final_url].includes(proposal.url)) {
    fail("proposal.url must equal the acquisition requested_url or final_url; the program will not infer a replacement URL");
  }
  if (Date.parse(proposal.public_at) > Date.parse(acquisition.record.retrieved_at)) {
    fail("proposal.public_at cannot be after the immutable acquisition retrieved_at");
  }
  const anchor = buildAnchor(proposal, acquisition);
  const anchorErrors = validateSourceAnchor(anchor, { file: "prepared anchor" });
  assertValid(anchorErrors, "prepared source anchor");
  const anchorHash = sha256(anchorSubject(anchor));
  const ledgerRecord = canonicalValue({
    schema_version: 1,
    persona_id: proposal.persona_id,
    candidate_id: proposal.candidate_id,
    source_id: proposal.source_id,
    status: "pending",
    status_reason: "awaiting_human_review",
    acquisition: acquisition.binding,
    proposal,
    proposal_hash: proposalHash,
    anchor_hash: anchorHash,
    prepared_at: now.toISOString(),
    review_attestations: [],
    attestation_chain_head: null,
  });
  const nextQueue = canonicalValue({ ...state.queue, records: [...state.queue.records, anchor] });
  const nextLedger = canonicalValue({ ...state.ledger, records: [...state.ledger.records, ledgerRecord] });
  assertValid(queueErrors(nextQueue, proposal.persona_id), "next source adjudication queue");
  assertValid(validateAdjudicationLedger(nextLedger, { personaId: proposal.persona_id }), "next source adjudication ledger");
  return { status: "prepared_pending_human_review", queue: nextQueue, ledger: nextLedger, record: ledgerRecord, anchor };
}

function reviewInputKey(value) {
  return sha256({
    schema_version: value.schema_version,
    artifact_kind: value.artifact_kind,
    reviewer_id: value.reviewer_id,
    signer_key_id: value.signer_key_id,
    normalized_reviewer_id: normalizedReviewerId(value.reviewer_id),
    decision: value.decision,
    content_hash: value.content_hash,
    anchor_hash: value.anchor_hash,
    reviewed_at: value.reviewed_at,
    affirmations: value.affirmations,
    notes: value.notes,
    signature: value.signature,
  });
}

function reviewMutation(state, personaId, sourceId, attestation, acquisition, now) {
  const recordIndex = state.ledger.records.findIndex((record) => record.source_id === sourceId);
  if (recordIndex < 0) fail(`source_id is not prepared for adjudication: ${sourceId}`);
  const record = state.ledger.records[recordIndex];
  if (record.persona_id !== personaId) fail("ledger record belongs to a different persona");
  if (acquisition.binding.record_hash !== record.acquisition.record_hash
    || acquisition.binding.content_hash !== record.acquisition.content_hash) {
    fail("the immutable acquisition binding changed after prepare");
  }
  if (attestation.content_hash !== record.acquisition.content_hash) fail("attestation.content_hash does not match the archived source bytes");
  if (attestation.anchor_hash !== record.anchor_hash) fail("attestation.anchor_hash does not match the prepared anchor");
  if (Date.parse(attestation.reviewed_at) < Date.parse(acquisition.record.retrieved_at)) {
    fail("attestation.reviewed_at cannot precede acquisition retrieved_at");
  }
  if (Date.parse(attestation.reviewed_at) > now.getTime()) fail("attestation.reviewed_at cannot be in the future");
  const inputKey = reviewInputKey(attestation);
  const existing = record.review_attestations.find((item) => reviewInputKey(item) === inputKey);
  if (existing) {
    const anchor = state.queue.records.find((item) => item.source_id === sourceId);
    return { status: "already_recorded", queue: state.queue, ledger: state.ledger, record, anchor, outcome: reviewOutcome(record.review_attestations) };
  }
  const persistedWithoutHash = canonicalValue({
    ...attestation,
    normalized_reviewer_id: normalizedReviewerId(attestation.reviewer_id),
    previous_attestation_hash: record.attestation_chain_head,
  });
  const persisted = canonicalValue({
    ...persistedWithoutHash,
    attestation_hash: sha256(persistedWithoutHash),
  });
  const attestations = [...record.review_attestations, persisted];
  const outcome = reviewOutcome(attestations);
  const nextRecord = canonicalValue({
    ...record,
    status: outcome.status,
    status_reason: outcome.reason,
    review_attestations: attestations,
    attestation_chain_head: persisted.attestation_hash,
  });
  const anchorIndex = state.queue.records.findIndex((item) => item.source_id === sourceId);
  if (anchorIndex < 0) fail("prepared source anchor is missing from the queue");
  const currentAnchor = state.queue.records[anchorIndex];
  if (sha256(anchorSubject(currentAnchor)) !== record.anchor_hash) fail("queue anchor no longer matches the hash reviewers were asked to inspect");
  const nextAnchor = canonicalValue({ ...currentAnchor, adjudication: anchorAdjudication(attestations) });
  const queueRecords = [...state.queue.records];
  queueRecords[anchorIndex] = nextAnchor;
  const ledgerRecords = [...state.ledger.records];
  ledgerRecords[recordIndex] = nextRecord;
  const nextQueue = canonicalValue({ ...state.queue, records: queueRecords });
  const nextLedger = canonicalValue({ ...state.ledger, records: ledgerRecords });
  assertValid(queueErrors(nextQueue, personaId), "next source adjudication queue");
  assertValid(validateAdjudicationLedger(nextLedger, { personaId }), "next source adjudication ledger");
  return { status: outcome.status, queue: nextQueue, ledger: nextLedger, record: nextRecord, anchor: nextAnchor, outcome };
}

export function fsyncDirectory(dir, options = {}) {
  return fsyncDirectoryStrictly(dir, {
    openImpl: (target) => openSync(target, fsConstants.O_RDONLY),
    fsyncImpl: fsyncSync,
    closeImpl: closeSync,
    ...options,
  });
}

function writeExclusive(file, bytes) {
  const descriptor = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicReplaceJson(paths, target, document) {
  if (!inside(paths.seat, target)) fail("adjudication target escapes the staging seat");
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !statSync(target).isFile())) fail(`unsafe adjudication target: ${target}`);
  const temp = join(paths.seat, `${REPLACE_PREFIX}${randomUUID()}.tmp`);
  writeExclusive(temp, Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8"));
  try {
    renameSync(temp, target);
    fsyncDirectory(paths.seat);
  } catch (error) {
    if (existsSync(temp) && !lstatSync(temp).isSymbolicLink()) unlinkSync(temp);
    throw error;
  }
}

function leaseDocument({ nowMs, ownerPid, ownerHostname }) {
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_source_adjudication_write_lease",
    owner_token: randomUUID(),
    hostname: ownerHostname,
    pid: ownerPid,
    acquired_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + LEASE_MS).toISOString(),
  });
}

function validateLease(value) {
  const errors = [];
  if (!exactKeys(value, LEASE_FIELDS, LEASE_FIELDS, "adjudication lease", errors)) return errors;
  if (value.schema_version !== 1) errors.push("adjudication lease.schema_version must be 1");
  if (value.artifact_kind !== "persona_source_adjudication_write_lease") errors.push("adjudication lease.artifact_kind is invalid");
  if (!UUID.test(value.owner_token || "")) errors.push("adjudication lease.owner_token is invalid");
  if (!nonEmpty(value.hostname)) errors.push("adjudication lease.hostname is required");
  if (!Number.isSafeInteger(value.pid) || value.pid < 1) errors.push("adjudication lease.pid is invalid");
  if (!exactIso(value.acquired_at) || !exactIso(value.expires_at)) errors.push("adjudication lease timestamps must be exact ISO timestamps");
  if (exactIso(value.acquired_at) && exactIso(value.expires_at)) {
    const duration = Date.parse(value.expires_at) - Date.parse(value.acquired_at);
    if (duration < 1 || duration > LEASE_MS) errors.push("adjudication lease duration is invalid");
  }
  return errors;
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLease(file) {
  if (lstatSync(file).isSymbolicLink()) fail("adjudication write lease must not be a symlink");
  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) fail("adjudication write lease must be a regular file");
    let document;
    try { document = JSON.parse(readFileSync(descriptor, "utf8")); } catch (error) { fail(`adjudication write lease is invalid JSON: ${error.message}`); }
    assertValid(validateLease(document), "adjudication write lease");
    return { opened, document };
  } finally {
    closeSync(descriptor);
  }
}

function recoverDeadLease(paths, lease, { nowMs, ownerHostname, isProcessAlive }) {
  if (lease.document.hostname !== ownerHostname) fail("adjudication write lease owner is foreign and cannot be verified safely");
  if (isProcessAlive(lease.document.pid)) fail("another source adjudication holds a confirmed live write lease");
  if (nowMs < Date.parse(lease.document.acquired_at) + DEAD_OWNER_GRACE_MS) fail("dead adjudication owner remains inside the recovery grace");
  const stale = `${paths.lock}.stale-${randomUUID()}`;
  renameSync(paths.lock, stale);
  const moved = lstatSync(stale);
  if (moved.isSymbolicLink() || moved.dev !== lease.opened.dev || moved.ino !== lease.opened.ino) fail("adjudication lease changed during stale recovery");
  unlinkSync(stale);
  fsyncDirectory(paths.seat);
}

function acquireLease(paths, options) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nowMs = options.leaseClock();
    const document = leaseDocument({ nowMs, ownerPid: options.ownerPid, ownerHostname: options.ownerHostname });
    let descriptor;
    try {
      descriptor = openSync(paths.lock, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
      writeFileSync(descriptor, `${JSON.stringify(document)}\n`, "utf8");
      fsyncSync(descriptor);
      fsyncDirectory(paths.seat);
      return { descriptor, opened: fstatSync(descriptor), document };
    } catch (error) {
      if (descriptor !== undefined) {
        closeSync(descriptor);
        if (existsSync(paths.lock) && !lstatSync(paths.lock).isSymbolicLink()) unlinkSync(paths.lock);
      }
      if (error.code !== "EEXIST") throw error;
      recoverDeadLease(paths, readLease(paths.lock), {
        nowMs,
        ownerHostname: options.ownerHostname,
        isProcessAlive: options.isProcessAlive,
      });
    }
  }
  fail("could not acquire the source adjudication write lease");
}

function releaseLease(paths, lease) {
  closeSync(lease.descriptor);
  if (!existsSync(paths.lock)) fail("adjudication write lease disappeared during commit");
  const current = lstatSync(paths.lock);
  if (current.isSymbolicLink() || current.dev !== lease.opened.dev || current.ino !== lease.opened.ino) fail("adjudication write lease changed during commit");
  const document = secureReadJson(paths.lock);
  if (document.owner_token !== lease.document.owner_token) fail("adjudication write lease owner changed during commit");
  unlinkSync(paths.lock);
  fsyncDirectory(paths.seat);
}

function cleanupReplaceTemps(paths) {
  for (const entry of readdirSync(paths.seat, { withFileTypes: true })) {
    if (!entry.name.startsWith(REPLACE_PREFIX)) continue;
    const file = join(paths.seat, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) fail(`unsafe replacement artifact: ${file}`);
    unlinkSync(file);
  }
}

function validateTransaction(transaction, personaId) {
  const errors = [];
  if (!exactKeys(transaction, TRANSACTION_FIELDS, TRANSACTION_FIELDS, "transaction", errors)) return errors;
  if (transaction.schema_version !== 1) errors.push("transaction.schema_version must be 1");
  if (transaction.artifact_kind !== "persona_source_adjudication_atomic_transaction") errors.push("transaction.artifact_kind is invalid");
  if (!UUID.test(transaction.transaction_id || "")) errors.push("transaction.transaction_id is invalid");
  if (transaction.persona_id !== personaId) errors.push("transaction.persona_id does not match seat");
  if (!exactIso(transaction.created_at)) errors.push("transaction.created_at must be exact ISO");
  for (const field of ["base_queue_hash", "next_queue_hash", "base_ledger_hash", "next_ledger_hash"]) {
    if (!HASH.test(transaction[field] || "")) errors.push(`transaction.${field} is invalid`);
  }
  if (transaction.next_queue_hash !== sha256(transaction.next_queue)) errors.push("transaction.next_queue_hash does not match next_queue");
  if (transaction.next_ledger_hash !== sha256(transaction.next_ledger)) errors.push("transaction.next_ledger_hash does not match next_ledger");
  errors.push(...queueErrors(transaction.next_queue, personaId));
  errors.push(...validateAdjudicationLedger(transaction.next_ledger, { personaId }));
  return errors;
}

function applyTransaction(paths, transaction, { afterQueueCommit = null } = {}) {
  const current = readState(paths, transaction.persona_id);
  const queueHash = sha256(current.queue);
  const ledgerHash = sha256(current.ledger);
  if (![transaction.base_queue_hash, transaction.next_queue_hash].includes(queueHash)) fail("queue diverged from both transaction base and target; refusing recovery");
  if (![transaction.base_ledger_hash, transaction.next_ledger_hash].includes(ledgerHash)) fail("ledger diverged from both transaction base and target; refusing recovery");
  if (queueHash === transaction.base_queue_hash) {
    atomicReplaceJson(paths, paths.queue, transaction.next_queue);
    if (afterQueueCommit) afterQueueCommit();
  }
  if (ledgerHash === transaction.base_ledger_hash) atomicReplaceJson(paths, paths.ledger, transaction.next_ledger);
  const verified = readState(paths, transaction.persona_id);
  if (sha256(verified.queue) !== transaction.next_queue_hash || sha256(verified.ledger) !== transaction.next_ledger_hash) {
    fail("adjudication atomic transaction did not reach its committed hashes");
  }
}

function transactionFiles(paths) {
  return readdirSync(paths.seat, { withFileTypes: true })
    .filter((entry) => entry.name.startsWith(TRANSACTION_PREFIX))
    .map((entry) => ({ entry, file: join(paths.seat, entry.name) }))
    .sort((a, b) => a.entry.name.localeCompare(b.entry.name));
}

function recoverTransactions(paths, personaId) {
  cleanupReplaceTemps(paths);
  for (const { entry, file } of transactionFiles(paths)) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json")) fail(`unsafe adjudication transaction artifact: ${file}`);
    const transaction = secureReadJson(file);
    assertValid(validateTransaction(transaction, personaId), "adjudication transaction");
    applyTransaction(paths, transaction);
    unlinkSync(file);
    fsyncDirectory(paths.seat);
  }
}

function commitDocuments(paths, personaId, base, next, { now, transactionHooks = {} } = {}) {
  if (sha256(base.queue) === sha256(next.queue) && sha256(base.ledger) === sha256(next.ledger)) return "no_change";
  const transactionId = randomUUID();
  const transaction = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_source_adjudication_atomic_transaction",
    transaction_id: transactionId,
    persona_id: personaId,
    created_at: now.toISOString(),
    base_queue_hash: sha256(base.queue),
    next_queue_hash: sha256(next.queue),
    base_ledger_hash: sha256(base.ledger),
    next_ledger_hash: sha256(next.ledger),
    next_queue: next.queue,
    next_ledger: next.ledger,
  });
  assertValid(validateTransaction(transaction, personaId), "new adjudication transaction");
  const journal = join(paths.seat, `${TRANSACTION_PREFIX}${transactionId}.json`);
  writeExclusive(journal, Buffer.from(`${JSON.stringify(transaction, null, 2)}\n`, "utf8"));
  fsyncDirectory(paths.seat);
  applyTransaction(paths, transaction, { afterQueueCommit: transactionHooks.afterQueueCommit || null });
  unlinkSync(journal);
  fsyncDirectory(paths.seat);
  return "committed_atomically";
}

async function withWriteLease(paths, personaId, operation, options) {
  const lease = acquireLease(paths, options);
  try {
    recoverTransactions(paths, personaId);
    return await operation();
  } finally {
    releaseLease(paths, lease);
  }
}

function operationOptions(value) {
  return {
    leaseClock: value.leaseClock || (() => Date.now()),
    ownerPid: value.ownerPid || process.pid,
    ownerHostname: value.ownerHostname || systemHostname(),
    isProcessAlive: value.isProcessAlive || defaultProcessAlive,
  };
}

export async function prepareSourceAdjudication({
  write = false,
  personaId,
  candidateId,
  proposal,
  root = defaultStagingRoot(),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  now = new Date(),
  leaseClock,
  ownerPid,
  ownerHostname,
  isProcessAlive,
  transactionHooks = {},
} = {}) {
  assertValid(validateSourceAnchorProposal(proposal, { personaId, candidateId }), "human source-anchor proposal");
  if (!exactIso(now.toISOString())) fail("now must be a valid Date");
  const paths = safeSeatPaths({ root, productionRoot, personaDir, personaId, now });
  const acquisition = acquisitionFor(paths, personaId, candidateId);
  const initial = readState(paths, personaId);
  const planned = prepareMutation(initial, canonicalValue(proposal), acquisition, now);
  if (!write || planned.status === "already_prepared") {
    return Object.freeze(canonicalValue({
      mode: write ? "write" : "plan",
      status: planned.status,
      wrote: false,
      persona_id: personaId,
      candidate_id: candidateId,
      source_id: planned.record.source_id,
      content_hash: planned.record.acquisition.content_hash,
      anchor_hash: planned.record.anchor_hash,
      reviewer_count: planned.record.review_attestations.length,
    }));
  }
  return withWriteLease(paths, personaId, async () => {
    const base = readState(paths, personaId);
    const currentAcquisition = acquisitionFor(paths, personaId, candidateId);
    const next = prepareMutation(base, canonicalValue(proposal), currentAcquisition, now);
    const commitStatus = commitDocuments(paths, personaId, base, next, { now, transactionHooks });
    return Object.freeze(canonicalValue({
      mode: "write",
      status: next.status,
      wrote: commitStatus !== "no_change",
      commit_status: commitStatus,
      persona_id: personaId,
      candidate_id: candidateId,
      source_id: next.record.source_id,
      content_hash: next.record.acquisition.content_hash,
      anchor_hash: next.record.anchor_hash,
      reviewer_count: 0,
    }));
  }, operationOptions({ leaseClock, ownerPid, ownerHostname, isProcessAlive }));
}

export async function reviewSourceAdjudication({
  write = false,
  personaId,
  sourceId,
  attestation,
  trustedReviewerKeys = parseTrustedSourceReviewKeys(),
  root = defaultStagingRoot(),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  now = new Date(),
  leaseClock,
  ownerPid,
  ownerHostname,
  isProcessAlive,
  transactionHooks = {},
} = {}) {
  if (!SOURCE_ID.test(sourceId || "")) fail("source-id is invalid");
  assertValid(validateReviewerAttestation(attestation, { now }), "human reviewer attestation");
  const verification = verifySourceReviewAttestation(attestation, {
    trustedKeyRegistry: trustedReviewerKeys,
    now,
  });
  if (!verification.valid) {
    fail(`human reviewer attestation is not trusted: ${verification.reason}`, {
      reason: verification.reason,
      errors: verification.errors || [],
    });
  }
  const paths = safeSeatPaths({ root, productionRoot, personaDir, personaId, now });
  const initial = readState(paths, personaId);
  const prepared = initial.ledger.records.find((record) => record.source_id === sourceId);
  if (!prepared) fail(`source_id is not prepared for adjudication: ${sourceId}`);
  const acquisition = acquisitionFor(paths, personaId, prepared.candidate_id);
  const planned = reviewMutation(initial, personaId, sourceId, canonicalValue(attestation), acquisition, now);
  if (!write || planned.status === "already_recorded") {
    return Object.freeze(canonicalValue({
      mode: write ? "write" : "plan",
      status: planned.status,
      wrote: false,
      persona_id: personaId,
      source_id: sourceId,
      anchor_hash: planned.record.anchor_hash,
      review_status: planned.outcome.status,
      review_reason: planned.outcome.reason,
      reviewer_ids: planned.outcome.reviewer_ids,
      duplicate_reviewer_ids: planned.outcome.duplicate_reviewer_ids,
      conflicting_reviewer_ids: planned.outcome.conflicting_reviewer_ids,
      reviewer_key_ids: planned.outcome.reviewer_key_ids,
    }));
  }
  return withWriteLease(paths, personaId, async () => {
    const base = readState(paths, personaId);
    const current = base.ledger.records.find((record) => record.source_id === sourceId);
    if (!current) fail(`source_id disappeared before commit: ${sourceId}`);
    const currentAcquisition = acquisitionFor(paths, personaId, current.candidate_id);
    const next = reviewMutation(base, personaId, sourceId, canonicalValue(attestation), currentAcquisition, now);
    const commitStatus = commitDocuments(paths, personaId, base, next, { now, transactionHooks });
    return Object.freeze(canonicalValue({
      mode: "write",
      status: next.status,
      wrote: commitStatus !== "no_change",
      commit_status: commitStatus,
      persona_id: personaId,
      source_id: sourceId,
      anchor_hash: next.record.anchor_hash,
      review_status: next.outcome.status,
      review_reason: next.outcome.reason,
      reviewer_ids: next.outcome.reviewer_ids,
      duplicate_reviewer_ids: next.outcome.duplicate_reviewer_ids,
      conflicting_reviewer_ids: next.outcome.conflicting_reviewer_ids,
      reviewer_key_ids: next.outcome.reviewer_key_ids,
      attestation_chain_head: next.record.attestation_chain_head,
    }));
  }, operationOptions({ leaseClock, ownerPid, ownerHostname, isProcessAlive }));
}

function inspectSeat(paths, personaId, trustedReviewerKeys) {
  const errors = [];
  let state;
  try { state = readState(paths, personaId); } catch (error) { return { persona_id: personaId, records: [], errors: [error.message] }; }
  const ledgerBySource = new Map(state.ledger.records.map((record) => [record.source_id, record]));
  const queueBySource = new Map(state.queue.records.map((anchor) => [anchor.source_id, anchor]));
  for (const [sourceId, record] of ledgerBySource) {
    const anchor = queueBySource.get(sourceId);
    if (!anchor) { errors.push(`${sourceId}: ledger record has no queue anchor`); continue; }
    if (sha256(anchorSubject(anchor)) !== record.anchor_hash) errors.push(`${sourceId}: queue anchor hash differs from ledger`);
    if (anchor.content_hash !== record.acquisition.content_hash) errors.push(`${sourceId}: queue content_hash differs from ledger`);
    const expected = anchorAdjudication(record.review_attestations);
    if (sha256(anchor.adjudication) !== sha256(expected)) errors.push(`${sourceId}: queue adjudication differs from the review ledger`);
    for (const [index, persisted] of record.review_attestations.entries()) {
      const attestation = canonicalValue(Object.fromEntries(
        [...REVIEW_FIELDS].map((field) => [field, persisted[field]]),
      ));
      const verification = verifySourceReviewAttestation(attestation, {
        trustedKeyRegistry: trustedReviewerKeys,
        now: new Date("9999-12-31T23:59:59.999Z"),
      });
      if (!verification.valid) {
        errors.push(`${sourceId}: review_attestations[${index}] is not trusted (${verification.reason})`);
      }
    }
    try {
      const acquisition = acquisitionFor(paths, personaId, record.candidate_id);
      if (acquisition.binding.record_hash !== record.acquisition.record_hash
        || acquisition.binding.content_hash !== record.acquisition.content_hash) {
        errors.push(`${sourceId}: immutable acquisition binding changed`);
      }
    } catch (error) {
      errors.push(`${sourceId}: ${error.message}`);
    }
  }
  for (const sourceId of queueBySource.keys()) if (!ledgerBySource.has(sourceId)) errors.push(`${sourceId}: queue anchor has no adjudication ledger record`);
  for (const entry of readdirSync(paths.seat, { withFileTypes: true })) {
    if (entry.name === LOCK_FILE || entry.name.startsWith(TRANSACTION_PREFIX) || entry.name.startsWith(REPLACE_PREFIX)) {
      errors.push(`${entry.name}: transient adjudication artifact is present`);
    }
  }
  return canonicalValue({ persona_id: personaId, records: state.ledger.records, errors });
}

export function inspectSourceAdjudications({
  root = defaultStagingRoot(),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  now = new Date(),
  trustedReviewerKeys = parseTrustedSourceReviewKeys(),
} = {}) {
  const staging = inspectPersonaV3Staging({ root, productionRoot, personaDir, now });
  if (staging.global_errors.length || staging.invalid_count || staging.unsafe_artifact_count) {
    fail("PersonaPack v3 staging must pass integrity checks before adjudication inspection", { staging });
  }
  const personas = CANONICAL_MASTER_IDS.map((personaId) => {
    const paths = safeSeatPaths({ root, productionRoot, personaDir, personaId, now });
    return inspectSeat(paths, personaId, trustedReviewerKeys);
  });
  const records = personas.flatMap((persona) => persona.records);
  const counts = { pending: 0, approved: 0, rejected: 0, blocked: 0 };
  for (const record of records) if (Object.hasOwn(counts, record.status)) counts[record.status] += 1;
  const stable = canonicalValue({
    schema_version: 1,
    artifact_kind: "source_adjudication_inventory",
    canonical_master_count: CANONICAL_MASTER_IDS.length,
    record_count: records.length,
    status_counts: counts,
    invalid_count: personas.filter((persona) => persona.errors.length).length,
    production_write_count: 0,
    personas,
  });
  return Object.freeze({
    ...stable,
    generated_at: now.toISOString(),
    inventory_hash: sha256(stable),
  });
}
