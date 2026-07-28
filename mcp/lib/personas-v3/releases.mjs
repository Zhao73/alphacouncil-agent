/**
 * PersonaPack v3 immutable release assembly and current-pointer lifecycle.
 *
 * Release assembly is deliberately separate from the production loader root. A caller
 * supplies one complete 26-seat source tree; this module validates it, copies it into a
 * same-filesystem transaction, fsyncs it, and publishes one immutable release directory by
 * atomic rename. Cutover changes only a versioned JSON pointer. Existing releases are never
 * modified or deleted by this API.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultPersonaDir } from "../personas/registry.mjs";
import { inspectPersonaAdmission } from "./admission.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import { compilePersonaPack } from "./compiler.mjs";
import { loadV3Pack } from "./loader.mjs";
import {
  RELEASE_FORMULA_EVIDENCE_FILE,
  buildReleaseFormulaReviewEvidence,
  releaseFormulaReviewEvidenceManifestEntry,
  verifyReleaseFormulaReviewEvidence,
} from "./release-formula-evidence.mjs";
import { verifyReleaseApprovalDocument } from "./release-approvals.mjs";
import {
  RELEASE_SOURCE_EVIDENCE_FILE,
  buildReleaseSourceReviewEvidence,
  releaseSourceReviewEvidenceManifestEntry,
  verifyReleaseSourceReviewEvidence,
} from "./release-source-evidence.mjs";
import {
  CANONICAL_MASTER_COUNT,
  CANONICAL_MASTER_IDS,
  canonicalMasterBlueprints,
} from "./staging.mjs";

export const PERSONA_RELEASE_COMPONENTS = Object.freeze([
  "sources",
  "doctrine",
  "decision_cases",
  "failures",
  "counterfactuals",
  "research_policy",
  "decision_policy",
  "tools",
  "memory_policy",
  "golden_cases",
  "pairwise_cases",
  "calibration_cases",
  "experiments",
]);

export const PERSONA_RELEASE_RULES = Object.freeze({
  schema_version: 1,
  manifest_file: "release-manifest.json",
  current_pointer_file: "current.json",
  activation_marker_file: "cutover-ever.json",
  masters_directory: "masters",
  pointers_directory: "pointers",
  approvals_directory: "approvals",
  source_review_evidence_file: RELEASE_SOURCE_EVIDENCE_FILE,
  formula_review_evidence_file: RELEASE_FORMULA_EVIDENCE_FILE,
  transactions_directory: ".transactions",
  lock_file: ".release.lock",
  canonical_master_count: CANONICAL_MASTER_COUNT,
});

const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ALLOWED_ADMISSIONS = new Set(["operational", "candidate", "method_model"]);
const FORBIDDEN_RELEASE_VALUES = new Set([
  "draft",
  "editorial_prototype",
  "pending_human_adjudication",
  "planned_unverified",
  "not_encoded_pending_human_adjudication",
  "not_started",
]);
const POINTER_OPERATIONS = new Set(["cutover", "rollback"]);

export class PersonaReleaseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaReleaseError";
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new PersonaReleaseError(message, details);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function parseJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${label}: invalid JSON (${error.message})`);
  }
}

function readJsonFile(file, label = file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`${label}: unreadable (${error.code || error.message})`);
  }
  return parseJsonText(text, label);
}

function prettyJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function assertReleaseId(value) {
  const releaseId = String(value || "");
  if (!RELEASE_ID.test(releaseId)
    || new Set(["current", "pointers", "masters", "transactions"]).has(releaseId)) {
    fail(`invalid persona release id: ${JSON.stringify(value)}`);
  }
  return releaseId;
}

function assertAbsoluteSafeRoot(value, label) {
  if (typeof value !== "string" || !isAbsolute(value)) fail(`${label} must be an absolute path`);
  const root = resolve(value);
  if (root === resolve(sep)) fail(`${label} cannot be the filesystem root`);
  return root;
}

function assertExistingPathChainHasNoSymlink(target, label) {
  let cursor = resolve(target);
  const pending = [];
  while (!existsSync(cursor)) {
    pending.push(basename(cursor));
    const parent = dirname(cursor);
    if (parent === cursor) fail(`${label}: cannot find an existing ancestor`);
    cursor = parent;
  }
  for (;;) {
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) fail(`${label}: symlinked path component is forbidden: ${cursor}`);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return pending;
}

function assertPlainDirectory(path, label, { create = false } = {}) {
  assertExistingPathChainHasNoSymlink(path, label);
  if (!existsSync(path) && create) mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a plain directory: ${path}`);
  return realpathSync(path);
}

function safeChild(root, relativePath, label) {
  if (!nonEmpty(relativePath) || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    fail(`${label}: unsafe relative path ${JSON.stringify(relativePath)}`);
  }
  const target = resolve(root, relativePath);
  if (!inside(root, target)) fail(`${label}: path escapes its root`);
  return target;
}

function assertPlainFileWithin(root, relativePath, label) {
  const target = safeChild(root, relativePath, label);
  if (!existsSync(target)) fail(`${label}: component is missing: ${relativePath}`);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label}: component must be a plain file: ${relativePath}`);
  const physical = realpathSync(target);
  if (!inside(realpathSync(root), physical)) fail(`${label}: component resolves outside its pack`);
  return physical;
}

function exactKeys(value, keys, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const allowed = new Set(keys);
  for (const key of keys) if (!(key in value)) errors.push(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}.${key} is unsupported`);
}

function forbiddenValuePaths(value, path = "$", found = []) {
  if (typeof value === "string" && FORBIDDEN_RELEASE_VALUES.has(value.trim().toLowerCase())) found.push(path);
  else if (Array.isArray(value)) value.forEach((item, index) => forbiddenValuePaths(item, `${path}[${index}]`, found));
  else if (isObject(value)) for (const [key, item] of Object.entries(value)) forbiddenValuePaths(item, `${path}.${key}`, found);
  return found;
}

function inspectJsonOrJsonlForDraft(file, label) {
  const text = readFileSync(file, "utf8");
  if (!text.trim()) fail(`${label}: production component is empty`);
  if (!/\.(?:json|jsonl)$/iu.test(file)) {
    if (/editorial_prototype|pending_human_adjudication|planned_unverified/iu.test(text)) {
      fail(`${label}: voice or text component still contains a draft marker`);
    }
    return;
  }
  const values = [];
  if (/\.jsonl$/iu.test(file)) {
    for (const [index, raw] of text.split(/\r?\n/u).entries()) {
      const line = raw.trim();
      if (!line) continue;
      values.push(parseJsonText(line, `${label}:${index + 1}`));
    }
  } else values.push(parseJsonText(text, label));
  for (const value of values) {
    const forbidden = forbiddenValuePaths(value);
    if (forbidden.length) fail(`${label}: draft or pending values remain at ${forbidden.join(", ")}`);
  }
}

function readSourceAnchors(file, label) {
  const text = readFileSync(file, "utf8").trim();
  if (!text) fail(`${label}: production source collection is empty`);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return canonicalValue(parsed);
    if (isObject(parsed)) return canonicalValue([parsed]);
  } catch {
    // Multiple-record JSONL is intentionally parsed line by line below.
  }
  const records = [];
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const value = parseJsonText(line, `${label}:${index + 1}`);
    if (!isObject(value)) fail(`${label}:${index + 1}: every source record must be an object`);
    records.push(value);
  }
  return canonicalValue(records);
}

function sortedDirectoryEntries(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
}

function inspectPlainTree(root, dir = root, files = []) {
  for (const entry of sortedDirectoryEntries(dir)) {
    const file = join(dir, entry.name);
    const rel = relative(root, file).split(sep).join("/");
    if (entry.isSymbolicLink()) fail(`release tree contains a symlink: ${rel}`);
    if (entry.isDirectory()) inspectPlainTree(root, file, files);
    else if (entry.isFile()) {
      const bytes = readFileSync(file);
      files.push({ path: rel, byte_length: bytes.length, content_hash: sha256(bytes.toString("base64")) });
    } else fail(`release tree contains a special file: ${rel}`);
  }
  return files;
}

function treeInventory(packDir) {
  const files = inspectPlainTree(packDir).sort((a, b) => a.path.localeCompare(b.path));
  if (!files.length) fail(`release pack is empty: ${packDir}`);
  return { files, tree_hash: sha256(files) };
}

function normalizeAdmission(result, personaId) {
  const admission = isObject(result?.admission) ? result.admission : {};
  const level = result?.admission_level || admission.level;
  if (!ALLOWED_ADMISSIONS.has(level)) {
    fail(`${personaId}: admission ${JSON.stringify(level)} is below the release floor`, { admission: result?.admission || result });
  }
  const operationalClear = result?.operational_clear ?? admission.operational_clear ?? true;
  if (operationalClear !== true) fail(`${personaId}: admission did not clear the operational release floor`);
  return canonicalValue({
    level,
    operational_clear: operationalClear,
    candidate_clear: result?.candidate_clear ?? admission.candidate_clear ?? new Set(["candidate", "method_model"]).has(level),
    counts: result?.physical_corpus_counts || admission.counts || {},
    delta_to_operational: result?.delta_to_operational || admission.delta_to_operational || {},
    delta_to_candidate: result?.delta_to_candidate || admission.delta_to_candidate || {},
    method_model_experiment_status: result?.method_model_experiment_status?.status
      || admission.method_model_experiment_status?.status || "unknown",
  });
}

function hashField(value, fallback, label) {
  const resolved = value || fallback;
  if (!SHA256.test(resolved || "")) fail(`${label} must be a canonical sha256 hash`);
  return resolved;
}

function normalizeInspection(result, { personaId, packDir, manifest, tree }) {
  const admission = normalizeAdmission(result, personaId);
  const componentHashes = isObject(result?.component_hashes) ? result.component_hashes : {};
  const expectedComponentHashes = [...PERSONA_RELEASE_COMPONENTS, "voice"].sort();
  const actualComponentHashes = Object.keys(componentHashes).sort();
  if (canonicalJson(actualComponentHashes) !== canonicalJson(expectedComponentHashes)) {
    fail(`${personaId}: inspector must return hashes for all 13 components and voice`);
  }
  for (const [name, hash] of Object.entries(componentHashes)) {
    if (!SHA256.test(hash || "")) fail(`${personaId}.component_hashes.${name} is invalid`);
  }
  return canonicalValue({
    persona_id: personaId,
    relative_path: `${PERSONA_RELEASE_RULES.masters_directory}/${personaId}`,
    pack_version: result?.pack_version || manifest.pack_version,
    source_cutoff: result?.source_cutoff || manifest.identity?.source_cutoff,
    tree_hash: tree.tree_hash,
    artifact_subject_hash: hashField(result?.artifact_subject_hash, sha256({ persona_id: personaId, subject: tree.tree_hash }), `${personaId}.artifact_subject_hash`),
    pack_hash: hashField(result?.pack_hash, sha256({ persona_id: personaId, tree_hash: tree.tree_hash, admission }), `${personaId}.pack_hash`),
    corpus_hash: hashField(result?.corpus_hash, sha256({ persona_id: personaId, corpus: tree.tree_hash }), `${personaId}.corpus_hash`),
    policy_hash: hashField(result?.policy_hash, sha256({ persona_id: personaId, policy: tree.tree_hash }), `${personaId}.policy_hash`),
    tool_graph_hash: hashField(result?.tool_graph_hash, sha256({ persona_id: personaId, tools: tree.tree_hash }), `${personaId}.tool_graph_hash`),
    prompt_hash: hashField(result?.prompt_hash, sha256({ persona_id: personaId, prompt: tree.tree_hash }), `${personaId}.prompt_hash`),
    component_hashes: canonicalValue(componentHashes),
    admission,
  });
}

function promptFileFor(blueprint, personaDir) {
  const file = resolve(personaDir, blueprint.canonical_prompt_file);
  if (!inside(personaDir, file)) fail(`${blueprint.persona_id}: canonical prompt path escapes persona root`);
  return file;
}

function defaultInspectPack({ personaId, packDir, promptFile }) {
  const loaded = loadV3Pack(packDir);
  const admission = inspectPersonaAdmission({ persona_id: personaId, prompt_file: promptFile, pack_dir: packDir });
  const compiled = compilePersonaPack(loaded, { promptFile });
  return {
    ...compiled,
    admission_level: admission.admission_level,
    operational_clear: admission.operational_clear,
    candidate_clear: admission.candidate_clear,
    physical_corpus_counts: admission.physical_corpus_counts,
    delta_to_operational: admission.delta_to_operational,
    delta_to_candidate: admission.delta_to_candidate,
    method_model_experiment_status: admission.method_model_experiment_status,
  };
}

function validatePackPhysicalContract(packDir, personaId) {
  const manifestFile = assertPlainFileWithin(packDir, "manifest.json", `${personaId}.manifest`);
  const manifest = readJsonFile(manifestFile, `${personaId}/manifest.json`);
  if (manifest.schema_version !== 3) fail(`${personaId}: manifest.schema_version must be 3`);
  if (manifest.identity?.persona_id !== personaId) fail(`${personaId}: manifest identity does not match directory`);
  if (!nonEmpty(manifest.pack_version) || !nonEmpty(manifest.identity?.source_cutoff)) fail(`${personaId}: pack version and source cutoff are required`);
  const components = manifest.components;
  if (!isObject(components)) fail(`${personaId}: manifest components are missing`);
  const componentKeys = Object.keys(components).sort();
  const expectedKeys = [...PERSONA_RELEASE_COMPONENTS].sort();
  if (canonicalJson(componentKeys) !== canonicalJson(expectedKeys)) fail(`${personaId}: manifest must reference exactly 13 release components`);
  for (const name of PERSONA_RELEASE_COMPONENTS) {
    const file = assertPlainFileWithin(packDir, components[name], `${personaId}.components.${name}`);
    inspectJsonOrJsonlForDraft(file, `${personaId}.components.${name}`);
  }
  if (manifest.voice?.load_after_decision_freeze !== true) fail(`${personaId}: late voice is required`);
  for (const language of ["en", "zh"]) {
    const file = assertPlainFileWithin(packDir, manifest.voice?.[language], `${personaId}.voice.${language}`);
    inspectJsonOrJsonlForDraft(file, `${personaId}.voice.${language}`);
  }
  const forbidden = forbiddenValuePaths(manifest);
  if (forbidden.length) fail(`${personaId}: manifest contains draft or pending values at ${forbidden.join(", ")}`);
  const sourceFile = assertPlainFileWithin(packDir, components.sources, `${personaId}.components.sources`);
  return Object.freeze({
    manifest,
    sources: readSourceAnchors(sourceFile, `${personaId}.components.sources`),
  });
}

export function validateCanonicalReleaseEntries(ids, expected = CANONICAL_MASTER_IDS) {
  if (!Array.isArray(ids)) fail("release persona IDs must be an array");
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const expectedSet = new Set(expected);
  const missing = expected.filter((id) => !ids.includes(id));
  const extra = ids.filter((id) => !expectedSet.has(id));
  if (ids.length !== expected.length || duplicates.length || missing.length || extra.length) {
    fail(`release roster must contain exactly ${expected.length} unique canonical masters`, {
      actual_count: ids.length,
      duplicates,
      missing,
      extra,
    });
  }
  return true;
}

function inspectSourceRoot({ sourceRoot, personaDir, inspectPack = defaultInspectPack }) {
  const source = assertPlainDirectory(assertAbsoluteSafeRoot(sourceRoot, "source root"), "source root");
  const personaRoot = assertPlainDirectory(assertAbsoluteSafeRoot(personaDir, "persona root"), "persona root");
  const blueprints = canonicalMasterBlueprints({ personaDir: personaRoot });
  const blueprintById = new Map(blueprints.map((blueprint) => [blueprint.persona_id, blueprint]));
  const entries = sortedDirectoryEntries(source);
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail(`release source contains a symlinked seat: ${entry.name}`);
    if (!entry.isDirectory()) fail(`release source contains a non-directory entry: ${entry.name}`);
  }
  const ids = entries.map((entry) => entry.name);
  validateCanonicalReleaseEntries(ids);
  const packs = [];
  const sourceAnchorsByPersona = {};
  for (const personaId of CANONICAL_MASTER_IDS) {
    const packDir = join(source, personaId);
    const physical = validatePackPhysicalContract(packDir, personaId);
    const { manifest } = physical;
    sourceAnchorsByPersona[personaId] = physical.sources;
    const tree = treeInventory(packDir);
    const result = inspectPack({
      personaId,
      packDir,
      promptFile: promptFileFor(blueprintById.get(personaId), personaRoot),
      manifest,
      tree,
    });
    packs.push(normalizeInspection(result, { personaId, packDir, manifest, tree }));
  }
  validateCanonicalReleaseEntries(packs.map((pack) => pack.persona_id));
  return Object.freeze({
    source_root: source,
    persona_root: personaRoot,
    canonical_catalog_hash: sha256(blueprints.map((blueprint) => ({
      persona_id: blueprint.persona_id,
      canonical_prompt_file: blueprint.canonical_prompt_file,
    }))),
    packs: Object.freeze(packs),
    source_anchors_by_persona: canonicalValue(sourceAnchorsByPersona),
    source_inventory_hash: sha256(packs.map((pack) => ({
      persona_id: pack.persona_id,
      tree_hash: pack.tree_hash,
      pack_hash: pack.pack_hash,
      admission: pack.admission.level,
    }))),
  });
}

function releaseManifest({ releaseId, inspected, assembledAt, sourceReviewEvidence, formulaReviewEvidence }) {
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_release_manifest",
    release_id: releaseId,
    release_status: "assembled_immutable",
    assembled_at: assembledAt,
    canonical_master_count: CANONICAL_MASTER_COUNT,
    canonical_master_ids: CANONICAL_MASTER_IDS,
    canonical_catalog_hash: inspected.canonical_catalog_hash,
    source_inventory_hash: inspected.source_inventory_hash,
    source_review_evidence: releaseSourceReviewEvidenceManifestEntry(sourceReviewEvidence),
    formula_review_evidence: releaseFormulaReviewEvidenceManifestEntry(formulaReviewEvidence),
    masters_directory: PERSONA_RELEASE_RULES.masters_directory,
    packs: inspected.packs,
  });
}

export function defaultPersonaReleaseRoot() {
  return process.env.ALPHACOUNCIL_PERSONA_RELEASES_DIR
    || fileURLToPath(new URL("../../../knowledge/persona-releases/", import.meta.url));
}

export function planPersonaRelease({
  releaseId,
  sourceRoot,
  releaseRoot = defaultPersonaReleaseRoot(),
  personaDir = defaultPersonaDir(),
  inspectPack = defaultInspectPack,
  adjudicationRoot,
  trustedReviewerKeys,
  trustedFormulaReviewerKeys,
  now = new Date(),
} = {}) {
  const id = assertReleaseId(releaseId);
  const root = assertAbsoluteSafeRoot(resolve(releaseRoot), "release root");
  assertExistingPathChainHasNoSymlink(root, "release root");
  const inspected = inspectSourceRoot({ sourceRoot: resolve(sourceRoot), personaDir: resolve(personaDir), inspectPack });
  const assembledAt = new Date(now).toISOString();
  const sourceReviewEvidence = buildReleaseSourceReviewEvidence({
    packSourcesByPersona: inspected.source_anchors_by_persona,
    adjudicationRoot,
    trustedReviewerKeys,
    verifiedAt: assembledAt,
  });
  const formulaReviewEvidence = buildReleaseFormulaReviewEvidence({
    packsRoot: inspected.source_root,
    trustedFormulaReviewerKeys,
    verifiedAt: assembledAt,
  });
  const manifest = releaseManifest({
    releaseId: id, inspected, assembledAt, sourceReviewEvidence, formulaReviewEvidence,
  });
  return Object.freeze({
    mode: "check_only",
    release_id: id,
    release_root: root,
    destination: join(root, id),
    canonical_master_count: inspected.packs.length,
    source_inventory_hash: inspected.source_inventory_hash,
    source_review_evidence_hash: sha256(sourceReviewEvidence),
    source_review_evidence: sourceReviewEvidence,
    formula_review_evidence_hash: sha256(formulaReviewEvidence),
    formula_review_evidence: formulaReviewEvidence,
    release_manifest: manifest,
    release_manifest_hash: sha256(manifest),
    packs: inspected.packs,
  });
}

function ensureReleaseStore(root) {
  const releaseRoot = assertAbsoluteSafeRoot(root, "release root");
  assertPlainDirectory(releaseRoot, "release root", { create: true });
  const transactions = join(releaseRoot, PERSONA_RELEASE_RULES.transactions_directory);
  const pointers = join(releaseRoot, PERSONA_RELEASE_RULES.pointers_directory);
  const approvals = join(releaseRoot, PERSONA_RELEASE_RULES.approvals_directory);
  assertPlainDirectory(transactions, "release transaction directory", { create: true });
  assertPlainDirectory(pointers, "release pointer history directory", { create: true });
  assertPlainDirectory(approvals, "release approval directory", { create: true });
  return Object.freeze({
    root: realpathSync(releaseRoot),
    transactions: realpathSync(transactions),
    pointers: realpathSync(pointers),
    approvals: realpathSync(approvals),
  });
}

function fsyncDirectory(dir) {
  const descriptor = openSync(dir, fsConstants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function copyPlainTree(source, target) {
  if (existsSync(target)) fail(`transaction copy target already exists: ${target}`);
  mkdirSync(target, { mode: 0o700 });
  for (const entry of sortedDirectoryEntries(source)) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isSymbolicLink()) fail(`cannot copy symlink into a release: ${from}`);
    if (entry.isDirectory()) copyPlainTree(from, to);
    else if (entry.isFile()) {
      copyFileSync(from, to, fsConstants.COPYFILE_EXCL);
      const descriptor = openSync(to, fsConstants.O_RDONLY);
      try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    } else fail(`cannot copy special file into a release: ${from}`);
  }
  fsyncDirectory(target);
}

function writeNewJsonFsync(file, value) {
  const descriptor = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(descriptor, prettyJson(value), "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(file));
}

function lockMetadata(operation, token, now = Date.now()) {
  return Object.freeze({
    schema_version: 1,
    lock_kind: "alphacouncil_persona_release_exclusive",
    operation,
    token,
    owner_pid: process.pid,
    owner_hostname: os.hostname(),
    created_at: new Date(now).toISOString(),
  });
}

export function acquirePersonaReleaseLock(releaseRoot, operation, { now = Date.now() } = {}) {
  if (!nonEmpty(operation)) fail("release lock operation is required");
  const store = ensureReleaseStore(resolve(releaseRoot));
  const path = join(store.root, PERSONA_RELEASE_RULES.lock_file);
  const token = randomUUID();
  const metadata = lockMetadata(operation, token, now);
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, prettyJson(metadata), "utf8");
    fsyncSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error.code === "EEXIST") fail("another persona release operation holds the exclusive publication lock", { lock_path: path });
    throw error;
  }
  const opened = fstatSync(descriptor);
  fsyncDirectory(store.root);
  let released = false;
  return Object.freeze({
    path,
    metadata,
    release() {
      if (released) return false;
      released = true;
      closeSync(descriptor);
      if (!existsSync(path)) fail("persona release lock disappeared before release");
      const current = lstatSync(path);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
        fail("persona release lock changed ownership before release");
      }
      const value = readJsonFile(path, "persona release lock");
      if (value.token !== token) fail("persona release lock token changed before release");
      unlinkSync(path);
      fsyncDirectory(store.root);
      return true;
    },
  });
}

function removeTransaction(path, transactionRoot) {
  if (!existsSync(path)) return;
  if (!inside(transactionRoot, path) || lstatSync(path).isSymbolicLink()) fail(`unsafe release transaction cleanup target: ${path}`);
  rmSync(path, { recursive: true, force: true });
}

export function assemblePersonaRelease(options = {}) {
  const plan = planPersonaRelease(options);
  const store = ensureReleaseStore(plan.release_root);
  const destination = join(store.root, plan.release_id);
  if (existsSync(destination)) fail(`persona release is immutable and already exists: ${plan.release_id}`);
  const lock = acquirePersonaReleaseLock(store.root, `assemble:${plan.release_id}`, { now: new Date(options.now || Date.now()).getTime() });
  const transaction = join(store.transactions, `${plan.release_id}-${randomUUID()}`);
  try {
    if (existsSync(destination)) fail(`persona release is immutable and already exists: ${plan.release_id}`);
    mkdirSync(transaction, { mode: 0o700 });
    const transactionMasters = join(transaction, PERSONA_RELEASE_RULES.masters_directory);
    copyPlainTree(resolve(options.sourceRoot), transactionMasters);
    const copied = inspectSourceRoot({
      sourceRoot: transactionMasters,
      personaDir: resolve(options.personaDir || defaultPersonaDir()),
      inspectPack: options.inspectPack || defaultInspectPack,
    });
    if (copied.source_inventory_hash !== plan.source_inventory_hash) fail("release source changed while it was being assembled");
    const copiedEvidence = buildReleaseSourceReviewEvidence({
      packSourcesByPersona: copied.source_anchors_by_persona,
      adjudicationRoot: options.adjudicationRoot,
      trustedReviewerKeys: options.trustedReviewerKeys,
      verifiedAt: plan.release_manifest.assembled_at,
    });
    if (sha256(copiedEvidence) !== plan.source_review_evidence_hash) {
      fail("source-review evidence changed while the release was being assembled");
    }
    const copiedFormulaEvidence = buildReleaseFormulaReviewEvidence({
      packsRoot: transactionMasters,
      trustedFormulaReviewerKeys: options.trustedFormulaReviewerKeys,
      verifiedAt: plan.release_manifest.assembled_at,
    });
    if (sha256(copiedFormulaEvidence) !== plan.formula_review_evidence_hash) {
      fail("formula-review evidence changed while the release was being assembled");
    }
    writeNewJsonFsync(join(transaction, PERSONA_RELEASE_RULES.source_review_evidence_file), copiedEvidence);
    writeNewJsonFsync(join(transaction, PERSONA_RELEASE_RULES.formula_review_evidence_file), copiedFormulaEvidence);
    const manifest = releaseManifest({
      releaseId: plan.release_id,
      inspected: copied,
      assembledAt: plan.release_manifest.assembled_at,
      sourceReviewEvidence: copiedEvidence,
      formulaReviewEvidence: copiedFormulaEvidence,
    });
    writeNewJsonFsync(join(transaction, PERSONA_RELEASE_RULES.manifest_file), manifest);
    fsyncDirectory(transaction);
    if (statSync(store.transactions).dev !== statSync(store.root).dev) fail("release transaction and destination are on different filesystems");
    if (existsSync(destination)) fail(`persona release destination appeared during assembly: ${plan.release_id}`);
    (options.renameImpl || renameSync)(transaction, destination);
    fsyncDirectory(store.root);
    const verified = verifyPersonaRelease({
      releaseId: plan.release_id,
      releaseRoot: store.root,
      personaDir: options.personaDir || defaultPersonaDir(),
      inspectPack: options.inspectPack || defaultInspectPack,
      trustedReviewerKeys: options.trustedReviewerKeys,
      trustedFormulaReviewerKeys: options.trustedFormulaReviewerKeys,
    });
    return Object.freeze({
      mode: "write",
      commit_strategy: "same_filesystem_fsync_atomic_rename",
      ...verified,
    });
  } catch (error) {
    removeTransaction(transaction, store.transactions);
    throw error;
  } finally {
    lock.release();
  }
}

function validateReleaseManifestDocument(manifest, releaseId) {
  const errors = [];
  exactKeys(manifest, [
    "schema_version", "artifact_kind", "release_id", "release_status", "assembled_at",
    "canonical_master_count", "canonical_master_ids", "canonical_catalog_hash",
    "source_inventory_hash", "source_review_evidence", "formula_review_evidence", "masters_directory", "packs",
  ], "release manifest", errors);
  if (!isObject(manifest)) fail(`invalid release manifest:\n- ${errors.join("\n- ")}`);
  if (manifest.schema_version !== 1) errors.push("release manifest.schema_version must be 1");
  if (manifest.artifact_kind !== "persona_v3_release_manifest") errors.push("release manifest.artifact_kind is invalid");
  if (manifest.release_id !== releaseId) errors.push("release manifest.release_id does not match its directory");
  if (manifest.release_status !== "assembled_immutable") errors.push("release manifest.release_status is invalid");
  if (!Number.isFinite(Date.parse(manifest.assembled_at))) errors.push("release manifest.assembled_at is invalid");
  if (manifest.canonical_master_count !== CANONICAL_MASTER_COUNT) errors.push(`release manifest count is not ${CANONICAL_MASTER_COUNT}`);
  try { validateCanonicalReleaseEntries(manifest.canonical_master_ids); } catch (error) { errors.push(error.message); }
  if (!SHA256.test(manifest.canonical_catalog_hash || "") || !SHA256.test(manifest.source_inventory_hash || "")) errors.push("release manifest inventory hashes are invalid");
  if (!isObject(manifest.source_review_evidence)) errors.push("release manifest source_review_evidence is required");
  else {
    exactKeys(manifest.source_review_evidence, [
      "relative_path", "evidence_hash", "trusted_key_registry_hash", "ledger_inventory_hash",
      "method_defining_source_count",
    ], "release manifest source_review_evidence", errors);
    if (manifest.source_review_evidence.relative_path !== PERSONA_RELEASE_RULES.source_review_evidence_file) {
      errors.push("release manifest source-review evidence path is invalid");
    }
    for (const field of ["evidence_hash", "trusted_key_registry_hash", "ledger_inventory_hash"]) {
      if (!SHA256.test(manifest.source_review_evidence[field] || "")) {
        errors.push(`release manifest source_review_evidence.${field} is invalid`);
      }
    }
    if (!Number.isSafeInteger(manifest.source_review_evidence.method_defining_source_count)
      || manifest.source_review_evidence.method_defining_source_count < 0) {
      errors.push("release manifest method-defining source count is invalid");
    }
  }
  if (!isObject(manifest.formula_review_evidence)) errors.push("release manifest formula_review_evidence is required");
  else {
    exactKeys(manifest.formula_review_evidence, [
      "relative_path", "evidence_hash", "trusted_key_registry_hash",
      "formula_binding_inventory_hash", "planned_tool_count",
    ], "release manifest formula_review_evidence", errors);
    if (manifest.formula_review_evidence.relative_path !== PERSONA_RELEASE_RULES.formula_review_evidence_file) {
      errors.push("release manifest formula-review evidence path is invalid");
    }
    for (const field of ["evidence_hash", "trusted_key_registry_hash", "formula_binding_inventory_hash"]) {
      if (!SHA256.test(manifest.formula_review_evidence[field] || "")) {
        errors.push(`release manifest formula_review_evidence.${field} is invalid`);
      }
    }
    if (manifest.formula_review_evidence.planned_tool_count !== CANONICAL_MASTER_COUNT * 2) {
      errors.push(`release manifest formula-review evidence must bind exactly ${CANONICAL_MASTER_COUNT * 2} tools`);
    }
  }
  if (manifest.masters_directory !== PERSONA_RELEASE_RULES.masters_directory) errors.push("release manifest masters directory is invalid");
  if (!Array.isArray(manifest.packs)) errors.push("release manifest.packs must be an array");
  else {
    try { validateCanonicalReleaseEntries(manifest.packs.map((pack) => pack?.persona_id)); } catch (error) { errors.push(error.message); }
    for (const pack of manifest.packs) {
      for (const key of ["tree_hash", "artifact_subject_hash", "pack_hash", "corpus_hash", "policy_hash", "tool_graph_hash", "prompt_hash"]) {
        if (!SHA256.test(pack?.[key] || "")) errors.push(`${pack?.persona_id || "unknown"}.${key} is invalid`);
      }
      if (!ALLOWED_ADMISSIONS.has(pack?.admission?.level)) errors.push(`${pack?.persona_id || "unknown"}.admission is below release floor`);
      if (pack?.relative_path !== `masters/${pack?.persona_id}`) errors.push(`${pack?.persona_id || "unknown"}.relative_path is invalid`);
    }
  }
  if (errors.length) fail(`invalid release manifest:\n- ${errors.join("\n- ")}`, { errors });
  return true;
}

export function verifyPersonaRelease({
  releaseId,
  releaseRoot = defaultPersonaReleaseRoot(),
  personaDir = defaultPersonaDir(),
  inspectPack = defaultInspectPack,
  trustedReviewerKeys,
  trustedFormulaReviewerKeys,
} = {}) {
  const id = assertReleaseId(releaseId);
  const root = assertPlainDirectory(assertAbsoluteSafeRoot(resolve(releaseRoot), "release root"), "release root");
  const releaseDir = join(root, id);
  if (!existsSync(releaseDir)) fail(`persona release not found: ${id}`);
  const releaseStat = lstatSync(releaseDir);
  if (!releaseStat.isDirectory() || releaseStat.isSymbolicLink()) fail(`persona release directory is unsafe: ${id}`);
  const manifestFile = assertPlainFileWithin(releaseDir, PERSONA_RELEASE_RULES.manifest_file, `${id}.release_manifest`);
  const manifest = readJsonFile(manifestFile, `${id}/${PERSONA_RELEASE_RULES.manifest_file}`);
  validateReleaseManifestDocument(manifest, id);
  const mastersRoot = assertPlainDirectory(join(releaseDir, manifest.masters_directory), `${id}.masters`);
  const inspected = inspectSourceRoot({ sourceRoot: mastersRoot, personaDir: resolve(personaDir), inspectPack });
  const evidenceFile = assertPlainFileWithin(
    releaseDir,
    manifest.source_review_evidence.relative_path,
    `${id}.source_review_evidence`,
  );
  const sourceReviewEvidence = readJsonFile(evidenceFile, `${id}/${manifest.source_review_evidence.relative_path}`);
  if (sha256(sourceReviewEvidence) !== manifest.source_review_evidence.evidence_hash) {
    fail(`${id}: source-review evidence hash does not match the release manifest`);
  }
  verifyReleaseSourceReviewEvidence({
    packSourcesByPersona: inspected.source_anchors_by_persona,
    evidence: sourceReviewEvidence,
    trustedReviewerKeys,
  });
  const formulaEvidenceFile = assertPlainFileWithin(
    releaseDir,
    manifest.formula_review_evidence.relative_path,
    `${id}.formula_review_evidence`,
  );
  const formulaReviewEvidence = readJsonFile(
    formulaEvidenceFile,
    `${id}/${manifest.formula_review_evidence.relative_path}`,
  );
  if (sha256(formulaReviewEvidence) !== manifest.formula_review_evidence.evidence_hash) {
    fail(`${id}: formula-review evidence hash does not match the release manifest`);
  }
  verifyReleaseFormulaReviewEvidence({
    packsRoot: mastersRoot,
    evidence: formulaReviewEvidence,
    trustedFormulaReviewerKeys,
  });
  const expected = releaseManifest({
    releaseId: id,
    inspected,
    assembledAt: manifest.assembled_at,
    sourceReviewEvidence,
    formulaReviewEvidence,
  });
  if (canonicalJson(expected) !== canonicalJson(manifest)) fail(`${id}: release manifest no longer matches physical packs`);
  return Object.freeze({
    release_id: id,
    release_root: root,
    release_dir: realpathSync(releaseDir),
    release_manifest_hash: sha256(manifest),
    release_manifest: manifest,
    canonical_master_count: inspected.packs.length,
    source_inventory_hash: inspected.source_inventory_hash,
    status: "verified",
  });
}

function pointerHistoryName(version) {
  if (!Number.isSafeInteger(version) || version < 1) fail("pointer version must be a positive safe integer");
  return `${String(version).padStart(8, "0")}.json`;
}

function validatePointer(pointer) {
  const errors = [];
  exactKeys(pointer, [
    "schema_version", "artifact_kind", "pointer_version", "operation", "release_id",
    "release_manifest_hash", "previous_release_id", "approval_hash", "approver_key_ids",
    "created_at",
  ], "release pointer", errors);
  if (!isObject(pointer)) fail(`invalid release pointer:\n- ${errors.join("\n- ")}`);
  if (pointer.schema_version !== 1 || pointer.artifact_kind !== "persona_v3_current_pointer") errors.push("release pointer header is invalid");
  if (!Number.isSafeInteger(pointer.pointer_version) || pointer.pointer_version < 1) errors.push("release pointer version is invalid");
  if (!POINTER_OPERATIONS.has(pointer.operation)) errors.push("release pointer operation is invalid");
  try { assertReleaseId(pointer.release_id); } catch (error) { errors.push(error.message); }
  if (!SHA256.test(pointer.release_manifest_hash || "")) errors.push("release pointer manifest hash is invalid");
  if (!SHA256.test(pointer.approval_hash || "")) errors.push("release pointer approval hash is invalid");
  if (!Array.isArray(pointer.approver_key_ids)
    || pointer.approver_key_ids.length < 2
    || new Set(pointer.approver_key_ids).size !== pointer.approver_key_ids.length
    || pointer.approver_key_ids.some((id) => !/^[A-Za-z0-9._:-]{3,128}$/u.test(id))) {
    errors.push("release pointer requires at least two unique approver key ids");
  }
  if (pointer.previous_release_id !== null) {
    try { assertReleaseId(pointer.previous_release_id); } catch (error) { errors.push(error.message); }
  }
  if (!Number.isFinite(Date.parse(pointer.created_at))) errors.push("release pointer timestamp is invalid");
  if (errors.length) fail(`invalid release pointer:\n- ${errors.join("\n- ")}`, { errors });
  return true;
}

function approvalFile(root, approvalHash) {
  if (!SHA256.test(approvalHash || "")) fail("release approval hash is invalid");
  return join(root, PERSONA_RELEASE_RULES.approvals_directory, `${approvalHash.slice("sha256:".length)}.json`);
}

function readPointerApproval(root, pointer, { trustedReleaseKeys, now = new Date() } = {}) {
  const document = readJsonFile(approvalFile(root, pointer.approval_hash), "release approval record");
  if (sha256(document) !== pointer.approval_hash) fail("release approval record hash does not match the pointer");
  const verification = verifyReleaseApprovalDocument(document, {
    trustedKeyRegistry: trustedReleaseKeys,
    expectedReleaseId: pointer.release_id,
    expectedManifestHash: pointer.release_manifest_hash,
    expectedOperation: pointer.operation,
    expectedPreviousReleaseId: pointer.previous_release_id,
    now,
  });
  if (!verification.valid) fail(`release approval record failed cryptographic verification: ${verification.reason}`, { verification });
  if (canonicalJson(verification.approver_key_ids) !== canonicalJson(pointer.approver_key_ids)) {
    fail("release approval record key ids do not match the pointer");
  }
  return Object.freeze({ document, verification });
}

function readCurrentPointer(root, {
  required = false,
  trustedReleaseKeys,
  now = new Date(),
} = {}) {
  const file = join(root, PERSONA_RELEASE_RULES.current_pointer_file);
  if (!existsSync(file)) {
    if (required) fail("current persona release pointer does not exist");
    return null;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("current persona release pointer must be a plain file");
  const pointer = readJsonFile(file, "current persona release pointer");
  validatePointer(pointer);
  const history = join(root, PERSONA_RELEASE_RULES.pointers_directory, pointerHistoryName(pointer.pointer_version));
  const historyStat = existsSync(history) ? lstatSync(history) : null;
  if (!historyStat?.isFile() || historyStat.isSymbolicLink()) fail("current pointer has no safe immutable history record");
  const recorded = readJsonFile(history, "current pointer history record");
  if (canonicalJson(recorded) !== canonicalJson(pointer)) fail("current pointer differs from its immutable history record");
  const records = readPointerHistory(join(root, PERSONA_RELEASE_RULES.pointers_directory));
  if (!records.length || canonicalJson(records.at(-1)) !== canonicalJson(pointer)) {
    fail("current pointer is not the latest immutable history record");
  }
  const marker = readActivationMarker(root, { required: true });
  if (marker.highest_pointer_version !== pointer.pointer_version
    || marker.first_cutover_at !== records[0].created_at
    || marker.updated_at !== pointer.created_at) {
    fail("release activation marker does not match the complete pointer history");
  }
  readPointerApproval(root, pointer, { trustedReleaseKeys, now });
  return pointer;
}

function nextPointerVersion(pointersDir) {
  return readPointerHistory(pointersDir).length + 1;
}

function readPointerHistory(pointersDir) {
  const history = [];
  for (const [index, entry] of sortedDirectoryEntries(pointersDir).entries()) {
    if (entry.isSymbolicLink() || !entry.isFile()) fail(`unsafe pointer history entry: ${entry.name}`);
    const match = /^(\d{8})\.json$/u.exec(entry.name);
    if (!match) fail(`unexpected pointer history entry: ${entry.name}`);
    const version = Number(match[1]);
    const value = readJsonFile(join(pointersDir, entry.name), `pointer history ${entry.name}`);
    validatePointer(value);
    if (value.pointer_version !== version) fail(`pointer history filename/version mismatch: ${entry.name}`);
    const expectedVersion = index + 1;
    if (version !== expectedVersion) fail(`pointer history is not contiguous at version ${expectedVersion}`);
    const previous = history.at(-1) || null;
    if (!previous) {
      if (value.operation !== "cutover" || value.previous_release_id !== null) {
        fail("first pointer history record must be an initial cutover with no previous release");
      }
    } else {
      if (value.previous_release_id !== previous.release_id) {
        fail(`pointer history previous release mismatch at version ${version}`);
      }
      if (value.release_id === previous.release_id) {
        fail(`pointer history operation does not change the active release at version ${version}`);
      }
      if (Date.parse(value.created_at) < Date.parse(previous.created_at)) {
        fail(`pointer history timestamp regressed at version ${version}`);
      }
      if (value.operation === "rollback"
        && !history.some((record) => record.release_id === value.release_id)) {
        fail(`rollback target was never active before pointer version ${version}`);
      }
    }
    history.push(value);
  }
  return history;
}

export function readPersonaReleasePointerHistory({
  releaseRoot = defaultPersonaReleaseRoot(),
} = {}) {
  const root = assertPlainDirectory(
    assertAbsoluteSafeRoot(resolve(releaseRoot), "release root"),
    "release root",
  );
  return Object.freeze(readPointerHistory(
    join(root, PERSONA_RELEASE_RULES.pointers_directory),
  ).map((pointer) => Object.freeze(canonicalValue(pointer))));
}

function validateActivationMarker(marker) {
  const errors = [];
  exactKeys(marker, [
    "schema_version", "artifact_kind", "first_pointer_version", "highest_pointer_version",
    "first_cutover_at", "updated_at",
  ], "release activation marker", errors);
  if (!isObject(marker)) fail(`invalid release activation marker:\n- ${errors.join("\n- ")}`);
  if (marker.schema_version !== 1 || marker.artifact_kind !== "persona_v3_cutover_ever_marker") {
    errors.push("release activation marker header is invalid");
  }
  if (marker.first_pointer_version !== 1) errors.push("release activation marker first pointer version must be 1");
  if (!Number.isSafeInteger(marker.highest_pointer_version) || marker.highest_pointer_version < 1) {
    errors.push("release activation marker highest pointer version is invalid");
  }
  if (!Number.isFinite(Date.parse(marker.first_cutover_at))) errors.push("release activation marker first cutover timestamp is invalid");
  if (!Number.isFinite(Date.parse(marker.updated_at))) errors.push("release activation marker updated timestamp is invalid");
  if (Number.isFinite(Date.parse(marker.first_cutover_at))
    && Number.isFinite(Date.parse(marker.updated_at))
    && Date.parse(marker.updated_at) < Date.parse(marker.first_cutover_at)) {
    errors.push("release activation marker timestamp regressed");
  }
  if (errors.length) fail(`invalid release activation marker:\n- ${errors.join("\n- ")}`, { errors });
  return marker;
}

function readActivationMarker(root, { required = false } = {}) {
  const file = join(root, PERSONA_RELEASE_RULES.activation_marker_file);
  if (!existsSync(file)) {
    if (required) fail("release activation marker is missing");
    return null;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("release activation marker must be a plain file");
  return validateActivationMarker(readJsonFile(file, "release activation marker"));
}

function atomicReplaceCurrentPointer(store, pointer) {
  const current = join(store.root, PERSONA_RELEASE_RULES.current_pointer_file);
  if (existsSync(current)) {
    const stat = lstatSync(current);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("current pointer path is unsafe");
  }
  const temporary = join(store.root, `.current-${randomUUID()}.json`);
  writeNewJsonFsync(temporary, pointer);
  try {
    renameSync(temporary, current);
    fsyncDirectory(store.root);
  } catch (error) {
    try { unlinkSync(temporary); } catch (cleanup) { if (cleanup.code !== "ENOENT") throw cleanup; }
    throw error;
  }
}

function atomicReplaceActivationMarker(store, pointer) {
  const current = readActivationMarker(store.root);
  if (!current && pointer.pointer_version !== 1) {
    fail("release activation marker cannot be created after pointer version 1");
  }
  if (current && current.highest_pointer_version !== pointer.pointer_version - 1) {
    fail("release activation marker is not monotonic with pointer history");
  }
  const marker = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_cutover_ever_marker",
    first_pointer_version: 1,
    highest_pointer_version: pointer.pointer_version,
    first_cutover_at: current?.first_cutover_at || pointer.created_at,
    updated_at: pointer.created_at,
  });
  const target = join(store.root, PERSONA_RELEASE_RULES.activation_marker_file);
  const temporary = join(store.root, `.cutover-ever-${randomUUID()}.json`);
  writeNewJsonFsync(temporary, marker);
  try {
    renameSync(temporary, target);
    fsyncDirectory(store.root);
  } catch (error) {
    try { unlinkSync(temporary); } catch (cleanup) { if (cleanup.code !== "ENOENT") throw cleanup; }
    throw error;
  }
  return marker;
}

export function planPersonaReleasePointer({
  releaseId,
  operation = "cutover",
  releaseRoot = defaultPersonaReleaseRoot(),
  personaDir = defaultPersonaDir(),
  inspectPack = defaultInspectPack,
  approvalDocument,
  trustedReleaseKeys,
  trustedReviewerKeys,
  trustedFormulaReviewerKeys,
  now = new Date(),
} = {}) {
  if (!POINTER_OPERATIONS.has(operation)) fail(`invalid release pointer operation: ${operation}`);
  const verified = verifyPersonaRelease({
    releaseId,
    releaseRoot,
    personaDir,
    inspectPack,
    trustedReviewerKeys,
    trustedFormulaReviewerKeys,
  });
  const root = verified.release_root;
  const current = readCurrentPointer(root, { trustedReleaseKeys, now });
  if (operation === "rollback" && !current) fail("cannot roll back without a current release");
  if (current?.release_id === verified.release_id) fail(`${operation} target must differ from the current release`);
  if (operation === "rollback") {
    const history = readPointerHistory(join(root, PERSONA_RELEASE_RULES.pointers_directory));
    if (!history.some((record) => record.release_id === verified.release_id)) {
      fail("rollback target must be a previously active retained release");
    }
  }
  if (!approvalDocument) fail("a signed release approval bundle is required");
  const approval = verifyReleaseApprovalDocument(approvalDocument, {
    trustedKeyRegistry: trustedReleaseKeys,
    expectedReleaseId: verified.release_id,
    expectedManifestHash: verified.release_manifest_hash,
    expectedOperation: operation,
    expectedPreviousReleaseId: current?.release_id || null,
    now,
  });
  if (!approval.valid) fail(`release approval failed: ${approval.reason}`, { approval });
  const pointerVersion = nextPointerVersion(join(root, PERSONA_RELEASE_RULES.pointers_directory));
  const pointer = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_current_pointer",
    pointer_version: pointerVersion,
    operation,
    release_id: verified.release_id,
    release_manifest_hash: verified.release_manifest_hash,
    previous_release_id: current?.release_id || null,
    approval_hash: approval.approval_hash,
    approver_key_ids: approval.approver_key_ids,
    created_at: new Date(now).toISOString(),
  });
  return Object.freeze({ mode: "check_only", operation, current, target: verified, approval, pointer });
}

function writeApprovalRecord(store, document, approvalHash) {
  const file = approvalFile(store.root, approvalHash);
  if (existsSync(file)) {
    const current = readJsonFile(file, "existing release approval record");
    if (canonicalJson(current) !== canonicalJson(document)) fail("release approval hash collision or record mutation");
    return file;
  }
  writeNewJsonFsync(file, document);
  fsyncDirectory(store.approvals);
  return file;
}

export function promotePersonaRelease(options = {}) {
  const root = assertPlainDirectory(assertAbsoluteSafeRoot(resolve(options.releaseRoot || defaultPersonaReleaseRoot()), "release root"), "release root");
  const lock = acquirePersonaReleaseLock(root, `${options.operation || "cutover"}:${options.releaseId}`, { now: new Date(options.now || Date.now()).getTime() });
  try {
    const plan = planPersonaReleasePointer({ ...options, releaseRoot: root });
    const store = ensureReleaseStore(root);
    writeApprovalRecord(store, options.approvalDocument, plan.pointer.approval_hash);
    const history = join(store.pointers, pointerHistoryName(plan.pointer.pointer_version));
    writeNewJsonFsync(history, plan.pointer);
    const activationMarker = atomicReplaceActivationMarker(store, plan.pointer);
    atomicReplaceCurrentPointer(store, plan.pointer);
    const resolved = resolveCurrentPersonaRelease({
      releaseRoot: store.root,
      personaDir: options.personaDir || defaultPersonaDir(),
      inspectPack: options.inspectPack || defaultInspectPack,
      trustedReleaseKeys: options.trustedReleaseKeys,
      trustedReviewerKeys: options.trustedReviewerKeys,
      trustedFormulaReviewerKeys: options.trustedFormulaReviewerKeys,
      now: options.now || new Date(),
    });
    return Object.freeze({
      mode: "write",
      operation: plan.operation,
      pointer: plan.pointer,
      approval: plan.approval,
      activation_marker: activationMarker,
      current: resolved,
      old_releases_retained: true,
    });
  } finally {
    lock.release();
  }
}

export function resolveCurrentPersonaRelease({
  releaseRoot = defaultPersonaReleaseRoot(),
  personaDir = defaultPersonaDir(),
  inspectPack = defaultInspectPack,
  trustedReleaseKeys,
  trustedReviewerKeys,
  trustedFormulaReviewerKeys,
  now = new Date(),
} = {}) {
  const root = assertPlainDirectory(assertAbsoluteSafeRoot(resolve(releaseRoot), "release root"), "release root");
  const pointer = readCurrentPointer(root, { required: true, trustedReleaseKeys, now });
  const verified = verifyPersonaRelease({
    releaseId: pointer.release_id,
    releaseRoot: root,
    personaDir,
    inspectPack,
    trustedReviewerKeys,
    trustedFormulaReviewerKeys,
  });
  if (verified.release_manifest_hash !== pointer.release_manifest_hash) fail("current pointer release manifest hash does not match the target release");
  return Object.freeze({ pointer, release: verified, status: "current_verified" });
}

export { defaultInspectPack as inspectProductionPersonaReleasePack };
