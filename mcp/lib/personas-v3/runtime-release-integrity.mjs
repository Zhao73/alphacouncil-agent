/** Fail-closed, dependency-light verification for an activated PersonaPack v3 release. */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { normalizeTrustedKeyRegistry } from "./attestations.mjs";
import { canonicalJson, canonicalValue, computePersonaArtifactHashes, sha256 } from "./canonical.mjs";
import { verifyReleaseFormulaReviewEvidence } from "./release-formula-evidence.mjs";
import { canDefineMethodRule, validateSourceAnchor } from "./source-anchor.mjs";
import {
  normalizeReviewerPrincipal,
  verifySourceReviewAttestation,
} from "./source-review-attestations.mjs";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const COMPONENTS = Object.freeze([
  "sources", "doctrine", "decision_cases", "failures", "counterfactuals",
  "research_policy", "decision_policy", "tools", "memory_policy", "golden_cases",
  "pairwise_cases", "calibration_cases", "experiments",
]);
const COLLECTIONS = new Set([
  "sources", "doctrine", "decision_cases", "failures", "counterfactuals",
  "golden_cases", "pairwise_cases", "calibration_cases",
]);
const REVIEW_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "reviewer_id", "signer_key_id", "decision",
  "content_hash", "anchor_hash", "reviewed_at", "affirmations", "notes", "signature",
]);
const EVIDENCE_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "verified_at", "canonical_master_count",
  "trusted_reviewer_keys", "trusted_key_registry_hash", "ledger_inventory_hash",
  "method_defining_source_count", "ledgers", "verified_bindings",
]);

export class PersonaRuntimeReleaseIntegrityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaRuntimeReleaseIntegrityError";
    this.details = canonicalValue(details);
  }
}

function fail(message, details = {}) {
  throw new PersonaRuntimeReleaseIntegrityError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(required)) {
    fail(`${label} fields are invalid`, { actual, expected: required });
  }
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function plainDirectory(path, label) {
  if (!existsSync(path)) fail(`${label} is missing`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a plain directory`);
  return realpathSync(path);
}

function plainFileWithin(root, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath
    || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    fail(`${label} path is unsafe`);
  }
  const unresolved = resolve(root, relativePath);
  if (!inside(root, unresolved) || !existsSync(unresolved)) fail(`${label} is missing`);
  const stat = lstatSync(unresolved);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a plain file`);
  const physical = realpathSync(unresolved);
  if (!inside(root, physical)) fail(`${label} escapes its root`);
  return physical;
}

function parseJson(file, label) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    fail(`${label} is invalid JSON (${error.message})`);
  }
}

function parseCollection(file, label) {
  const text = readFileSync(file, "utf8").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split(/\r?\n/u).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch (error) {
        fail(`${label}:${index + 1} is invalid JSON (${error.message})`);
      }
    });
  }
}

function treeInventory(root, dir = root, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name);
    const path = relative(root, file).split(sep).join("/");
    if (entry.isSymbolicLink()) fail(`active release pack contains a symlink: ${path}`);
    if (entry.isDirectory()) treeInventory(root, file, files);
    else if (entry.isFile()) {
      const bytes = readFileSync(file);
      files.push({ path, byte_length: bytes.length, content_hash: sha256(bytes.toString("base64")) });
    } else fail(`active release pack contains a special file: ${path}`);
  }
  return files;
}

function readPack(packDir, packEntry) {
  const manifest = parseJson(plainFileWithin(packDir, "manifest.json", `${packEntry.persona_id}.manifest`), `${packEntry.persona_id}/manifest.json`);
  if (manifest.schema_version !== 3 || manifest.identity?.persona_id !== packEntry.persona_id) {
    fail(`${packEntry.persona_id}: physical manifest identity is invalid`);
  }
  if (!isObject(manifest.components)
    || canonicalJson(Object.keys(manifest.components).sort()) !== canonicalJson([...COMPONENTS].sort())) {
    fail(`${packEntry.persona_id}: physical manifest components are invalid`);
  }
  const components = {};
  for (const name of COMPONENTS) {
    const file = plainFileWithin(packDir, manifest.components[name], `${packEntry.persona_id}.components.${name}`);
    components[name] = COLLECTIONS.has(name) ? parseCollection(file, `${packEntry.persona_id}.${name}`) : parseJson(file, `${packEntry.persona_id}.${name}`);
  }
  if (manifest.voice?.load_after_decision_freeze !== true) fail(`${packEntry.persona_id}: late voice is required`);
  const voice = Object.fromEntries(["en", "zh"].map((language) => {
    const file = plainFileWithin(packDir, manifest.voice?.[language], `${packEntry.persona_id}.voice.${language}`);
    const text = readFileSync(file, "utf8").trim();
    if (!text) fail(`${packEntry.persona_id}: ${language} voice is empty`);
    return [language, text];
  }));
  return { manifest, components: canonicalValue(components), voice: canonicalValue(voice) };
}

function verifyPack(releaseDir, packEntry) {
  exactKeys(packEntry, [
    "persona_id", "relative_path", "pack_version", "source_cutoff", "tree_hash",
    "artifact_subject_hash", "pack_hash", "corpus_hash", "policy_hash", "tool_graph_hash",
    "prompt_hash", "component_hashes", "admission",
  ], `${packEntry.persona_id || "unknown"} release pack`);
  if (packEntry.relative_path !== `masters/${packEntry.persona_id}`) fail(`${packEntry.persona_id}: release pack path is invalid`);
  const packDir = plainDirectory(join(releaseDir, packEntry.relative_path), `${packEntry.persona_id} release pack`);
  if (!inside(releaseDir, packDir)) fail(`${packEntry.persona_id}: release pack escapes its release`);
  const files = treeInventory(packDir).sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length || sha256(files) !== packEntry.tree_hash) fail(`${packEntry.persona_id}: physical tree hash does not match the release manifest`);
  const loaded = readPack(packDir, packEntry);
  if (loaded.manifest.pack_version !== packEntry.pack_version
    || loaded.manifest.identity?.source_cutoff !== packEntry.source_cutoff) {
    fail(`${packEntry.persona_id}: pack version or source cutoff does not match the release manifest`);
  }
  const hashes = computePersonaArtifactHashes(loaded);
  for (const field of ["artifact_subject_hash", "corpus_hash", "policy_hash", "tool_graph_hash", "prompt_hash"]) {
    if (hashes[field] !== packEntry[field]) fail(`${packEntry.persona_id}: ${field} does not match physical pack content`);
  }
  if (canonicalJson(hashes.component_hashes) !== canonicalJson(packEntry.component_hashes)) {
    fail(`${packEntry.persona_id}: component hashes do not match physical pack content`);
  }
  if (!HASH.test(packEntry.pack_hash || "")) fail(`${packEntry.persona_id}: pack_hash is invalid`);
  return { persona_id: packEntry.persona_id, sources: loaded.components.sources };
}

function registrySnapshot(registry) {
  return [...registry.values()].map((descriptor) => canonicalValue({
    key_id: descriptor.key_id,
    public_key: descriptor.public_key.export({ type: "spki", format: "pem" }),
    principal_id: descriptor.principal_id,
    revoked: descriptor.revoked,
    not_before: descriptor.not_before,
    not_after: descriptor.not_after,
    purposes: descriptor.purposes,
  })).sort((a, b) => a.key_id.localeCompare(b.key_id));
}

function externallyTrustedRegistry(embedded, trustedReviewerKeys) {
  if (trustedReviewerKeys === undefined || trustedReviewerKeys === null) fail("trusted source-review key registry is required");
  let external;
  let snapshot;
  try {
    external = normalizeTrustedKeyRegistry(trustedReviewerKeys);
    snapshot = registrySnapshot(external);
    normalizeTrustedKeyRegistry(embedded);
  } catch (error) {
    fail(`trusted source-review key registry is invalid: ${error.message}`);
  }
  if (!external.size) fail("trusted source-review key registry is required");
  const externalById = new Map(snapshot.map((entry) => [entry.key_id, entry]));
  for (const entry of embedded) {
    const trusted = externalById.get(entry.key_id);
    if (!trusted || canonicalJson(trusted) !== canonicalJson(entry)) {
      fail(`embedded source-review key ${entry.key_id} is not identical to the external trust registry`);
    }
  }
  return external;
}

function anchorSubjectHash(anchor) {
  const { adjudication: _adjudication, ...subject } = anchor;
  return sha256(canonicalValue(subject));
}

function signedReview(persisted) {
  return canonicalValue(Object.fromEntries(REVIEW_FIELDS.map((field) => [field, persisted[field]])));
}

function verifyRecordChain(record, label) {
  if (!Array.isArray(record.review_attestations)) fail(`${label}: review attestations must be an array`);
  let previous = null;
  for (const [index, persisted] of record.review_attestations.entries()) {
    const entryLabel = `${label}.review_attestations[${index}]`;
    if (!isObject(persisted) || persisted.previous_attestation_hash !== previous) fail(`${entryLabel}: attestation chain is invalid`);
    const { attestation_hash: attestationHash, ...hashed } = persisted;
    if (attestationHash !== sha256(hashed)) fail(`${entryLabel}: attestation hash is invalid`);
    previous = attestationHash;
  }
  if (record.attestation_chain_head !== previous) fail(`${label}: attestation chain head is invalid`);
}

function bindingForSource({ personaId, anchor, ledger, registry, verifiedAt }) {
  const label = `${personaId}.${anchor.source_id}`;
  const record = ledger.records.find((candidate) => candidate.source_id === anchor.source_id);
  if (!record || record.status !== "approved") fail(`${label}: approved source ledger record is missing`);
  verifyRecordChain(record, label);
  const anchorHash = anchorSubjectHash(anchor);
  if (record.anchor_hash !== anchorHash || record.acquisition?.content_hash !== anchor.content_hash) {
    fail(`${label}: source anchor is not bound to the release ledger`);
  }
  const approvals = record.review_attestations.map((persisted, index) => {
    const attestation = signedReview(persisted);
    const verification = verifySourceReviewAttestation(attestation, {
      trustedKeyRegistry: registry,
      now: verifiedAt,
    });
    if (!verification.valid || attestation.decision !== "approve") {
      fail(`${label}: source-review attestation ${index} is not externally trusted (${verification.reason || "not_approved"})`);
    }
    return {
      attestation_hash: persisted.attestation_hash,
      key_id: verification.key_id,
      principal_id: verification.principal_id,
      reviewed_at: attestation.reviewed_at,
    };
  });
  const principals = [...new Set(approvals.map((entry) => normalizeReviewerPrincipal(entry.principal_id)).filter(Boolean))].sort();
  const keyIds = [...new Set(approvals.map((entry) => entry.key_id))].sort();
  if (principals.length < 2 || keyIds.length < 2) fail(`${label}: two externally trusted reviewer principals and keys are required`);
  const declaredPrincipals = [...new Set((anchor.adjudication?.reviewer_ids || []).map(normalizeReviewerPrincipal).filter(Boolean))].sort();
  if (canonicalJson(principals) !== canonicalJson(declaredPrincipals)) fail(`${label}: pack reviewer principals do not match signed reviews`);
  if (anchor.adjudication?.reviewed_at !== approvals.map((entry) => entry.reviewed_at).sort().at(-1)) {
    fail(`${label}: pack review timestamp does not match signed reviews`);
  }
  if (anchor.adjudication?.notes !== "two_independent_cryptographically_verified_human_approvals") {
    fail(`${label}: pack adjudication outcome is invalid`);
  }
  return canonicalValue({
    persona_id: personaId,
    source_id: anchor.source_id,
    content_hash: anchor.content_hash,
    anchor_hash: anchorHash,
    ledger_hash: sha256(ledger),
    attestation_chain_head: record.attestation_chain_head,
    reviewer_principal_ids: principals,
    signer_key_ids: keyIds,
    approval_attestation_hashes: approvals.map((entry) => entry.attestation_hash).sort(),
  });
}

function verifySourceEvidence({ manifest, evidence, packSources, trustedReviewerKeys }) {
  exactKeys(evidence, EVIDENCE_FIELDS, "source-review evidence bundle");
  if (evidence.schema_version !== 1 || evidence.artifact_kind !== "persona_v3_release_source_review_evidence") {
    fail("source-review evidence bundle header is invalid");
  }
  if (evidence.canonical_master_count !== 26 || !Array.isArray(evidence.ledgers) || evidence.ledgers.length !== 26) {
    fail("source-review evidence bundle does not cover 26 masters");
  }
  if (!Array.isArray(evidence.trusted_reviewer_keys)
    || sha256(evidence.trusted_reviewer_keys) !== evidence.trusted_key_registry_hash) {
    fail("source-review evidence trusted key snapshot hash is invalid");
  }
  const registry = externallyTrustedRegistry(evidence.trusted_reviewer_keys, trustedReviewerKeys);
  const ledgerByPersona = new Map();
  for (const ledger of evidence.ledgers) {
    if (!isObject(ledger) || ledger.schema_version !== 1 || ledger.artifact_kind !== "source_adjudication_ledger"
      || !Array.isArray(ledger.records) || ledgerByPersona.has(ledger.persona_id)) {
      fail("source-review evidence contains an invalid or duplicate ledger");
    }
    ledgerByPersona.set(ledger.persona_id, ledger);
  }
  const personaIds = [...packSources.keys()];
  if (canonicalJson([...ledgerByPersona.keys()].sort()) !== canonicalJson([...personaIds].sort())) {
    fail("source-review evidence ledgers do not match the active release packs");
  }
  const inventory = personaIds.map((personaId) => ({ persona_id: personaId, ledger_hash: sha256(ledgerByPersona.get(personaId)) }));
  if (sha256(inventory) !== evidence.ledger_inventory_hash) fail("source-review evidence ledger inventory hash is invalid");
  const bindings = [];
  const verifiedAt = new Date(evidence.verified_at);
  if (!Number.isFinite(verifiedAt.getTime()) || verifiedAt.toISOString() !== evidence.verified_at) {
    fail("source-review evidence verified_at is invalid");
  }
  for (const personaId of personaIds) {
    const sources = packSources.get(personaId);
    for (const [index, source] of sources.entries()) {
      const errors = validateSourceAnchor(source, { file: `${personaId}.sources[${index}]` });
      if (errors.length) fail(`${personaId}: source anchor is invalid\n- ${errors.join("\n- ")}`);
      if (canDefineMethodRule(source)) bindings.push(bindingForSource({
        personaId,
        anchor: source,
        ledger: ledgerByPersona.get(personaId),
        registry,
        verifiedAt,
      }));
    }
  }
  if (evidence.method_defining_source_count !== bindings.length
    || canonicalJson(evidence.verified_bindings) !== canonicalJson(bindings)) {
    fail("source-review evidence bindings do not match the physical packs or signed ledgers");
  }
  const expectedEntry = {
    relative_path: "source-review-evidence.json",
    evidence_hash: sha256(evidence),
    trusted_key_registry_hash: evidence.trusted_key_registry_hash,
    ledger_inventory_hash: evidence.ledger_inventory_hash,
    method_defining_source_count: evidence.method_defining_source_count,
  };
  if (canonicalJson(expectedEntry) !== canonicalJson(manifest.source_review_evidence)) {
    fail("source-review evidence bundle does not match its release manifest binding");
  }
}

export function verifyRuntimePersonaRelease({
  releaseDir,
  manifest,
  trustedReviewerKeys,
  trustedFormulaReviewerKeys,
} = {}) {
  const physicalRelease = plainDirectory(resolve(releaseDir), "active release directory");
  if (!Array.isArray(manifest?.canonical_master_ids) || manifest.canonical_master_ids.length !== 26
    || new Set(manifest.canonical_master_ids).size !== 26
    || !Array.isArray(manifest.packs) || manifest.packs.length !== 26) {
    fail("active release manifest must contain 26 unique physical packs");
  }
  const packEntries = new Map(manifest.packs.map((entry) => [entry?.persona_id, entry]));
  if (packEntries.size !== 26
    || canonicalJson([...packEntries.keys()].sort()) !== canonicalJson([...manifest.canonical_master_ids].sort())) {
    fail("active release pack inventory does not match its canonical master ids");
  }
  const masters = plainDirectory(join(physicalRelease, manifest.masters_directory), "active release masters directory");
  const physicalIds = readdirSync(masters, { withFileTypes: true }).map((entry) => {
    if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`active release masters entry is unsafe: ${entry.name}`);
    return entry.name;
  }).sort();
  if (canonicalJson(physicalIds) !== canonicalJson([...manifest.canonical_master_ids].sort())) {
    fail("active release physical pack directories do not match the manifest");
  }
  const packSources = new Map();
  for (const personaId of manifest.canonical_master_ids) {
    const verified = verifyPack(physicalRelease, packEntries.get(personaId));
    packSources.set(personaId, verified.sources);
  }
  const sourceInventoryHash = sha256(manifest.packs.map((pack) => ({
    persona_id: pack.persona_id,
    tree_hash: pack.tree_hash,
    pack_hash: pack.pack_hash,
    admission: pack.admission.level,
  })));
  if (sourceInventoryHash !== manifest.source_inventory_hash) fail("active release source inventory hash is invalid");
  const evidence = parseJson(
    plainFileWithin(physicalRelease, manifest.source_review_evidence.relative_path, "active release source-review evidence"),
    "active release source-review evidence",
  );
  verifySourceEvidence({ manifest, evidence, packSources, trustedReviewerKeys });
  if (!isObject(manifest.formula_review_evidence)
    || manifest.formula_review_evidence.relative_path !== "formula-review-evidence.json"
    || !HASH.test(manifest.formula_review_evidence.evidence_hash || "")) {
    fail("active release formula-review evidence binding is invalid");
  }
  const formulaEvidence = parseJson(
    plainFileWithin(physicalRelease, manifest.formula_review_evidence.relative_path, "active release formula-review evidence"),
    "active release formula-review evidence",
  );
  if (sha256(formulaEvidence) !== manifest.formula_review_evidence.evidence_hash) {
    fail("active release formula-review evidence hash does not match the manifest");
  }
  verifyReleaseFormulaReviewEvidence({
    packsRoot: masters,
    evidence: formulaEvidence,
    trustedFormulaReviewerKeys,
  });
  return Object.freeze({
    masters,
    pack_count: packSources.size,
    source_review_evidence: evidence,
    formula_review_evidence: formulaEvidence,
  });
}
