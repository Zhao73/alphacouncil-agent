/**
 * Cryptographic source-review evidence bound to an immutable PersonaPack v3 release.
 *
 * A production pack's reviewer_ids are display metadata, not authority. Release assembly
 * must find the exact source anchor in its human-adjudication ledger, verify the ledger hash
 * chain, and verify two Ed25519 approvals from distinct trusted principals. The resulting
 * self-contained bundle is copied into the release and hash-bound by release-manifest.json.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { normalizeTrustedKeyRegistry } from "./attestations.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import { validateAdjudicationLedger } from "./source-adjudication.mjs";
import { canDefineMethodRule, validateSourceAnchor } from "./source-anchor.mjs";
import {
  normalizeReviewerPrincipal,
  parseTrustedSourceReviewKeys,
  verifySourceReviewAttestation,
} from "./source-review-attestations.mjs";
import { CANONICAL_MASTER_IDS } from "./staging.mjs";

export const RELEASE_SOURCE_EVIDENCE_FILE = "source-review-evidence.json";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const LEDGER_FILE = "source-adjudication-ledger.json";
const REVIEW_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "reviewer_id", "signer_key_id", "decision",
  "content_hash", "anchor_hash", "reviewed_at", "affirmations", "notes", "signature",
]);
const BUNDLE_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "verified_at", "canonical_master_count",
  "trusted_reviewer_keys", "trusted_key_registry_hash", "ledger_inventory_hash",
  "method_defining_source_count", "ledgers", "verified_bindings",
]);

export class PersonaReleaseSourceEvidenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaReleaseSourceEvidenceError";
    this.details = canonicalValue(details);
  }
}

function fail(message, details = {}) {
  throw new PersonaReleaseSourceEvidenceError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(`${label} fields are invalid`, { actual, expected });
  }
}

function exactIso(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    fail(`${label} must be an exact UTC ISO timestamp`);
  }
  return new Date(time);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function plainDirectory(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a plain directory: ${path}`);
  return realpathSync(path);
}

function plainJsonWithin(root, relativePath, label) {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    fail(`${label} path is unsafe`);
  }
  const unresolved = resolve(root, relativePath);
  if (!inside(root, unresolved) || !existsSync(unresolved)) fail(`${label} is missing: ${relativePath}`);
  const stat = lstatSync(unresolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a plain file`);
  const physical = realpathSync(unresolved);
  if (!inside(root, physical)) fail(`${label} escapes its evidence root`);
  try {
    return JSON.parse(readFileSync(physical, "utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON (${error.message})`);
  }
}

function anchorSubjectHash(anchor) {
  const { adjudication: _adjudication, ...subject } = anchor;
  return sha256(canonicalValue(subject));
}

function persistedReviewInput(persisted) {
  return canonicalValue(Object.fromEntries(REVIEW_FIELDS.map((field) => [field, persisted[field]])));
}

function normalizedReviewers(values) {
  return [...new Set((values || []).map(normalizeReviewerPrincipal).filter(Boolean))].sort();
}

function publicKeyRegistryDocument(value) {
  let registry;
  try {
    registry = normalizeTrustedKeyRegistry(value);
  } catch (error) {
    fail(`trusted reviewer key registry is invalid: ${error.message}`);
  }
  const entries = [...registry.values()].map((descriptor) => canonicalValue({
    key_id: descriptor.key_id,
    public_key: descriptor.public_key.export({ type: "spki", format: "pem" }),
    principal_id: descriptor.principal_id,
    revoked: descriptor.revoked,
    not_before: descriptor.not_before,
    not_after: descriptor.not_after,
    purposes: descriptor.purposes,
  })).sort((a, b) => a.key_id.localeCompare(b.key_id));
  const sourceReviewPrincipals = new Set(entries
    .filter((entry) => entry.revoked !== true && entry.purposes?.includes("source_review"))
    .map((entry) => normalizeReviewerPrincipal(entry.principal_id))
    .filter(Boolean));
  if (sourceReviewPrincipals.size < 2) {
    fail("release source evidence requires at least two distinct trusted source_review principals");
  }
  return canonicalValue(entries);
}

function registryFromDocument(entries) {
  if (!Array.isArray(entries)) fail("source-review evidence trusted_reviewer_keys must be an array");
  const registryInput = entries.map((entry, index) => {
    exactKeys(entry, [
      "key_id", "public_key", "principal_id", "revoked", "not_before", "not_after", "purposes",
    ], `trusted_reviewer_keys[${index}]`);
    return entry;
  });
  try {
    return normalizeTrustedKeyRegistry(registryInput);
  } catch (error) {
    fail(`embedded trusted reviewer key registry is invalid: ${error.message}`);
  }
}

function normalizePackSources(packSourcesByPersona) {
  const entries = packSourcesByPersona instanceof Map
    ? [...packSourcesByPersona.entries()]
    : Object.entries(packSourcesByPersona || {});
  const byPersona = new Map(entries);
  const actualIds = [...byPersona.keys()].sort();
  const expectedIds = [...CANONICAL_MASTER_IDS].sort();
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
    fail("source-review evidence requires source collections for exactly 26 canonical masters", {
      actual_ids: actualIds,
      expected_ids: expectedIds,
    });
  }
  for (const [personaId, sources] of byPersona) {
    if (!Array.isArray(sources)) fail(`${personaId}: pack sources must be an array`);
    for (const [index, source] of sources.entries()) {
      const errors = validateSourceAnchor(source, { file: `${personaId}.sources[${index}]` });
      if (errors.length) fail(`${personaId}: invalid source anchor\n- ${errors.join("\n- ")}`);
    }
  }
  return byPersona;
}

function normalizeLedgers(ledgers) {
  if (!Array.isArray(ledgers)) fail("source-review evidence ledgers must be an array");
  const byPersona = new Map();
  for (const ledger of ledgers) {
    const personaId = ledger?.persona_id;
    if (byPersona.has(personaId)) fail(`duplicate source-adjudication ledger for ${personaId}`);
    const errors = validateAdjudicationLedger(ledger, { personaId });
    if (errors.length) fail(`${personaId || "unknown"}: invalid source-adjudication ledger\n- ${errors.join("\n- ")}`);
    byPersona.set(personaId, canonicalValue(ledger));
  }
  const actualIds = [...byPersona.keys()].sort();
  const expectedIds = [...CANONICAL_MASTER_IDS].sort();
  if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
    fail("source-review evidence requires one ledger for each canonical master", {
      actual_ids: actualIds,
      expected_ids: expectedIds,
    });
  }
  return byPersona;
}

function readExternalLedgers(adjudicationRoot) {
  if (typeof adjudicationRoot !== "string" || !isAbsolute(adjudicationRoot)) {
    fail("source adjudication root must be an explicit absolute path");
  }
  const root = plainDirectory(resolve(adjudicationRoot), "source adjudication root");
  return CANONICAL_MASTER_IDS.map((personaId) => {
    const seat = plainDirectory(join(root, personaId), `${personaId} adjudication directory`);
    if (!inside(root, seat)) fail(`${personaId}: adjudication directory escapes the evidence root`);
    return canonicalValue(plainJsonWithin(seat, LEDGER_FILE, `${personaId} adjudication ledger`));
  });
}

function bindingForSource({ personaId, anchor, ledger, ledgerHash, registry, verifiedAt }) {
  const record = ledger.records.find((candidate) => candidate.source_id === anchor.source_id);
  if (!record) fail(`${personaId}.${anchor.source_id}: no source-adjudication ledger record exists`);
  if (record.status !== "approved") fail(`${personaId}.${anchor.source_id}: ledger status is not approved`);
  const expectedAnchorHash = anchorSubjectHash(anchor);
  if (record.anchor_hash !== expectedAnchorHash) {
    fail(`${personaId}.${anchor.source_id}: pack anchor hash does not match the adjudication ledger`);
  }
  if (record.acquisition?.content_hash !== anchor.content_hash) {
    fail(`${personaId}.${anchor.source_id}: pack content_hash does not match the adjudication ledger`);
  }

  const approvals = [];
  for (const [index, persisted] of record.review_attestations.entries()) {
    const attestation = persistedReviewInput(persisted);
    const verification = verifySourceReviewAttestation(attestation, {
      trustedKeyRegistry: registry,
      now: verifiedAt,
    });
    if (!verification.valid) {
      fail(`${personaId}.${anchor.source_id}: review_attestations[${index}] is not trusted (${verification.reason})`);
    }
    if (attestation.decision !== "approve") {
      fail(`${personaId}.${anchor.source_id}: an approved method source contains a non-approval attestation`);
    }
    approvals.push({
      attestation_hash: persisted.attestation_hash,
      key_id: verification.key_id,
      principal_id: verification.principal_id,
      reviewed_at: attestation.reviewed_at,
    });
  }
  const principalIds = normalizedReviewers(approvals.map((approval) => approval.principal_id));
  const signerKeyIds = [...new Set(approvals.map((approval) => approval.key_id))].sort();
  if (principalIds.length < 2 || signerKeyIds.length < 2) {
    fail(`${personaId}.${anchor.source_id}: two distinct trusted reviewer principals and keys are required`);
  }
  const anchorReviewerIds = normalizedReviewers(anchor.adjudication?.reviewer_ids);
  if (canonicalJson(anchorReviewerIds) !== canonicalJson(principalIds)) {
    fail(`${personaId}.${anchor.source_id}: pack reviewer_ids do not match verified signer principals`);
  }
  const latestReview = approvals.map((approval) => approval.reviewed_at).sort().at(-1);
  if (anchor.adjudication?.reviewed_at !== latestReview) {
    fail(`${personaId}.${anchor.source_id}: pack reviewed_at does not match the signed review ledger`);
  }
  if (anchor.adjudication?.notes !== "two_independent_cryptographically_verified_human_approvals") {
    fail(`${personaId}.${anchor.source_id}: pack adjudication reason is not the verified ledger outcome`);
  }
  return canonicalValue({
    persona_id: personaId,
    source_id: anchor.source_id,
    content_hash: anchor.content_hash,
    anchor_hash: expectedAnchorHash,
    ledger_hash: ledgerHash,
    attestation_chain_head: record.attestation_chain_head,
    reviewer_principal_ids: principalIds,
    signer_key_ids: signerKeyIds,
    approval_attestation_hashes: approvals.map((approval) => approval.attestation_hash).sort(),
  });
}

function buildFromDocuments({ packSourcesByPersona, ledgers, trustedReviewerKeys, verifiedAt }) {
  const verifiedDate = exactIso(verifiedAt, "source-review evidence verified_at");
  const sourcesByPersona = normalizePackSources(packSourcesByPersona);
  const ledgerByPersona = normalizeLedgers(ledgers);
  const trustedKeys = publicKeyRegistryDocument(trustedReviewerKeys);
  const registry = registryFromDocument(trustedKeys);
  const ledgerInventory = CANONICAL_MASTER_IDS.map((personaId) => ({
    persona_id: personaId,
    ledger_hash: sha256(ledgerByPersona.get(personaId)),
  }));
  const bindings = [];
  for (const personaId of CANONICAL_MASTER_IDS) {
    const ledger = ledgerByPersona.get(personaId);
    const ledgerHash = sha256(ledger);
    const methodSources = sourcesByPersona.get(personaId).filter((source) => canDefineMethodRule(source));
    for (const anchor of methodSources) {
      bindings.push(bindingForSource({
        personaId,
        anchor,
        ledger,
        ledgerHash,
        registry,
        verifiedAt: verifiedDate,
      }));
    }
  }
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_release_source_review_evidence",
    verified_at: verifiedDate.toISOString(),
    canonical_master_count: CANONICAL_MASTER_IDS.length,
    trusted_reviewer_keys: trustedKeys,
    trusted_key_registry_hash: sha256(trustedKeys),
    ledger_inventory_hash: sha256(ledgerInventory),
    method_defining_source_count: bindings.length,
    ledgers: CANONICAL_MASTER_IDS.map((personaId) => ledgerByPersona.get(personaId)),
    verified_bindings: bindings,
  });
}

export function buildReleaseSourceReviewEvidence({
  packSourcesByPersona,
  adjudicationRoot,
  trustedReviewerKeys,
  verifiedAt,
} = {}) {
  if (trustedReviewerKeys === undefined || trustedReviewerKeys === null) {
    fail("trusted reviewer key registry is required for release assembly");
  }
  return Object.freeze(buildFromDocuments({
    packSourcesByPersona,
    ledgers: readExternalLedgers(adjudicationRoot),
    trustedReviewerKeys,
    verifiedAt,
  }));
}

export function verifyReleaseSourceReviewEvidence({
  packSourcesByPersona,
  evidence,
  trustedReviewerKeys = parseTrustedSourceReviewKeys(),
} = {}) {
  exactKeys(evidence, BUNDLE_FIELDS, "source-review evidence bundle");
  if (evidence.schema_version !== 1
    || evidence.artifact_kind !== "persona_v3_release_source_review_evidence") {
    fail("source-review evidence bundle header is invalid");
  }
  if (evidence.canonical_master_count !== CANONICAL_MASTER_IDS.length) {
    fail("source-review evidence bundle does not cover 26 canonical masters");
  }
  if (!HASH.test(evidence.trusted_key_registry_hash || "")
    || !HASH.test(evidence.ledger_inventory_hash || "")) {
    fail("source-review evidence bundle hashes are invalid");
  }
  if (trustedReviewerKeys === undefined || trustedReviewerKeys === null) {
    fail("external trusted reviewer key registry is required to verify release source evidence");
  }
  const rebuilt = buildFromDocuments({
    packSourcesByPersona,
    ledgers: evidence.ledgers,
    trustedReviewerKeys,
    verifiedAt: evidence.verified_at,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(evidence)) {
    fail("source-review evidence bundle does not match the packs, ledgers, or trusted keys");
  }
  return Object.freeze(rebuilt);
}

export function releaseSourceReviewEvidenceManifestEntry(evidence) {
  return canonicalValue({
    relative_path: RELEASE_SOURCE_EVIDENCE_FILE,
    evidence_hash: sha256(evidence),
    trusted_key_registry_hash: evidence.trusted_key_registry_hash,
    ledger_inventory_hash: evidence.ledger_inventory_hash,
    method_defining_source_count: evidence.method_defining_source_count,
  });
}
