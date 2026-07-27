import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "./canonical.mjs";
import {
  TRUSTED_RELEASE_KEYS_ENV,
  parseTrustedReleaseKeys,
  verifyReleaseApprovalDocument,
} from "./release-approvals.mjs";
import { verifyRuntimePersonaRelease } from "./runtime-release-integrity.mjs";
import {
  TRUSTED_FORMULA_REVIEW_KEYS_ENV,
  parseTrustedFormulaReviewKeys,
} from "./formula-review-attestations.mjs";
import {
  TRUSTED_SOURCE_REVIEW_KEYS_ENV,
  parseTrustedSourceReviewKeys,
} from "./source-review-attestations.mjs";

const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const REQUIRE_ACTIVE_RELEASE_ENV = "ALPHACOUNCIL_REQUIRE_PERSONA_RELEASE";
const ACTIVATION_MARKER_FILE = "cutover-ever.json";

export class PersonaProductionRootError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaProductionRootError";
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new PersonaProductionRootError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function plainFile(file, label) {
  if (!existsSync(file)) fail(`${label} is missing`, { file });
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a plain file`, { file });
  return file;
}

function plainDirectory(dir, label) {
  if (!existsSync(dir)) fail(`${label} is missing`, { dir });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a plain directory`, { dir });
  return realpathSync(dir);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(plainFile(file, label), "utf8"));
  } catch (error) {
    if (error instanceof PersonaProductionRootError) throw error;
    fail(`${label} is invalid JSON (${error.message})`, { file });
  }
}

function pointerHistoryName(version) {
  if (!Number.isSafeInteger(version) || version < 1) fail("active release pointer version is invalid");
  return `${String(version).padStart(8, "0")}.json`;
}

function validatePointer(pointer) {
  if (!isObject(pointer)) fail("active release pointer must be an object");
  const fields = [
    "schema_version", "artifact_kind", "pointer_version", "operation", "release_id",
    "release_manifest_hash", "previous_release_id", "approval_hash", "approver_key_ids",
    "created_at",
  ];
  if (canonicalJson(Object.keys(pointer).sort()) !== canonicalJson([...fields].sort())) {
    fail("active release pointer fields are invalid");
  }
  if (pointer.schema_version !== 1 || pointer.artifact_kind !== "persona_v3_current_pointer") {
    fail("active release pointer header is invalid");
  }
  pointerHistoryName(pointer.pointer_version);
  if (!new Set(["cutover", "rollback"]).has(pointer.operation)) fail("active release pointer operation is invalid");
  if (!RELEASE_ID.test(pointer.release_id || "")) fail("active release id is invalid");
  if (!HASH.test(pointer.release_manifest_hash || "")) fail("active release manifest hash is invalid");
  if (!HASH.test(pointer.approval_hash || "")) fail("active release approval hash is invalid");
  if (!Array.isArray(pointer.approver_key_ids)
    || pointer.approver_key_ids.length < 2
    || new Set(pointer.approver_key_ids).size !== pointer.approver_key_ids.length) {
    fail("active release pointer requires two unique approval keys");
  }
  if (pointer.previous_release_id !== null && !RELEASE_ID.test(pointer.previous_release_id || "")) {
    fail("active release previous_release_id is invalid");
  }
  if (!Number.isFinite(Date.parse(pointer.created_at))) fail("active release pointer timestamp is invalid");
  return pointer;
}

function validateHistoryAndActivation(root, currentPointer) {
  const pointersDir = join(root, "pointers");
  const markerFile = join(root, ACTIVATION_MARKER_FILE);
  const marker = readJson(markerFile, "release activation marker");
  const markerFields = [
    "schema_version", "artifact_kind", "first_pointer_version", "highest_pointer_version",
    "first_cutover_at", "updated_at",
  ];
  if (!isObject(marker)
    || canonicalJson(Object.keys(marker).sort()) !== canonicalJson([...markerFields].sort())
    || marker.schema_version !== 1
    || marker.artifact_kind !== "persona_v3_cutover_ever_marker"
    || marker.first_pointer_version !== 1
    || !Number.isSafeInteger(marker.highest_pointer_version)
    || marker.highest_pointer_version < 1
    || !Number.isFinite(Date.parse(marker.first_cutover_at))
    || !Number.isFinite(Date.parse(marker.updated_at))) {
    fail("release activation marker is invalid");
  }
  const physicalPointers = plainDirectory(pointersDir, "release pointer history directory");
  const names = readdirSync(physicalPointers).sort();
  if (names.length !== marker.highest_pointer_version) fail("release pointer history is incomplete");
  const history = [];
  names.forEach((name, index) => {
    const expectedName = pointerHistoryName(index + 1);
    if (name !== expectedName) fail(`release pointer history is not contiguous at ${expectedName}`);
    const pointer = validatePointer(readJson(join(physicalPointers, name), `release pointer history ${name}`));
    if (pointer.pointer_version !== index + 1) fail(`release pointer history filename/version mismatch at ${name}`);
    const previous = history.at(-1) || null;
    if (!previous) {
      if (pointer.operation !== "cutover" || pointer.previous_release_id !== null) {
        fail("first release pointer history record must be an initial cutover");
      }
    } else {
      if (pointer.previous_release_id !== previous.release_id) fail("release pointer history previous release chain is invalid");
      if (pointer.release_id === previous.release_id) fail("release pointer history contains a no-op operation");
      if (Date.parse(pointer.created_at) < Date.parse(previous.created_at)) fail("release pointer history timestamp regressed");
      if (pointer.operation === "rollback"
        && !history.some((record) => record.release_id === pointer.release_id)) {
        fail("release pointer history rollback target was never active");
      }
    }
    history.push(pointer);
  });
  const latest = history.at(-1);
  if (canonicalJson(latest) !== canonicalJson(currentPointer)) fail("active release pointer is not the latest immutable history");
  if (marker.highest_pointer_version !== latest.pointer_version
    || marker.first_cutover_at !== history[0].created_at
    || marker.updated_at !== latest.created_at) {
    fail("release activation marker does not match pointer history");
  }
  return history;
}

function nonEmptyPlainDirectory(dir, label) {
  if (!existsSync(dir)) return false;
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a plain directory`, { dir });
  return readdirSync(dir).length > 0;
}

function releaseActivationEvidence(root) {
  if (!existsSync(root)) return { current: false, prior: false };
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("PersonaPack release store must be a plain directory", { root });
  const current = existsSync(join(root, "current.json"));
  const marker = existsSync(join(root, ACTIVATION_MARKER_FILE));
  const pointerHistory = nonEmptyPlainDirectory(join(root, "pointers"), "release pointer history directory");
  const approvals = nonEmptyPlainDirectory(join(root, "approvals"), "release approval directory");
  return { current, prior: marker || pointerHistory || approvals };
}

function validateReleaseManifest(manifest, pointer) {
  if (!isObject(manifest)) fail("active release manifest must be an object");
  if (manifest.schema_version !== 1 || manifest.artifact_kind !== "persona_v3_release_manifest") {
    fail("active release manifest header is invalid");
  }
  if (manifest.release_id !== pointer.release_id) fail("active release manifest id does not match the pointer");
  if (manifest.release_status !== "assembled_immutable") fail("active release is not immutable");
  if (manifest.canonical_master_count !== 26
    || !Array.isArray(manifest.canonical_master_ids)
    || manifest.canonical_master_ids.length !== 26
    || new Set(manifest.canonical_master_ids).size !== 26) {
    fail("active release manifest does not contain exactly 26 canonical seats");
  }
  if (manifest.masters_directory !== "masters") fail("active release masters directory is invalid");
  if (!isObject(manifest.source_review_evidence)
    || manifest.source_review_evidence.relative_path !== "source-review-evidence.json"
    || !HASH.test(manifest.source_review_evidence.evidence_hash || "")) {
    fail("active release source-review evidence binding is invalid");
  }
  if (!isObject(manifest.formula_review_evidence)
    || manifest.formula_review_evidence.relative_path !== "formula-review-evidence.json"
    || !HASH.test(manifest.formula_review_evidence.evidence_hash || "")) {
    fail("active release formula-review evidence binding is invalid");
  }
  if (sha256(manifest) !== pointer.release_manifest_hash) fail("active release manifest hash does not match the pointer");
  return manifest;
}

export function defaultLegacyPersonaKnowledgeDir() {
  return fileURLToPath(new URL("../../../knowledge/masters/", import.meta.url));
}

export function defaultPersonaReleaseStore() {
  return process.env.ALPHACOUNCIL_PERSONA_RELEASES_DIR
    || fileURLToPath(new URL("../../../knowledge/persona-releases/", import.meta.url));
}

export function resolveActivePersonaKnowledgeDir({
  knowledgeDir = process.env.ALPHACOUNCIL_KNOWLEDGE_DIR,
  releaseRoot = defaultPersonaReleaseStore(),
  legacyDir = defaultLegacyPersonaKnowledgeDir(),
  requireActiveRelease = process.env[REQUIRE_ACTIVE_RELEASE_ENV] === "1",
  trustedReleaseKeys,
  trustedReviewerKeys,
  trustedFormulaReviewerKeys,
  now = new Date(),
} = {}) {
  const root = resolve(releaseRoot);
  const currentFile = join(root, "current.json");
  const activation = releaseActivationEvidence(root);
  if (!existsSync(currentFile)) {
    if (requireActiveRelease || activation.prior) {
      fail("an active immutable PersonaPack release is required but current.json is missing", { previously_activated: activation.prior });
    }
    if (knowledgeDir) return plainDirectory(resolve(knowledgeDir), "explicit PersonaPack knowledge root");
    return resolve(legacyDir);
  }
  const physicalRoot = plainDirectory(root, "PersonaPack release store");
  const pointer = validatePointer(readJson(currentFile, "active release pointer"));
  validateHistoryAndActivation(physicalRoot, pointer);
  const historyFile = join(physicalRoot, "pointers", pointerHistoryName(pointer.pointer_version));
  const history = validatePointer(readJson(historyFile, "active release pointer history"));
  if (canonicalJson(history) !== canonicalJson(pointer)) fail("active release pointer differs from immutable history");

  const releaseDir = join(physicalRoot, pointer.release_id);
  if (!inside(physicalRoot, releaseDir)) fail("active release path escapes the release store");
  const physicalRelease = plainDirectory(releaseDir, "active release directory");
  const manifest = validateReleaseManifest(
    readJson(join(physicalRelease, "release-manifest.json"), "active release manifest"),
    pointer,
  );
  const approval = readJson(
    join(physicalRoot, "approvals", `${pointer.approval_hash.slice("sha256:".length)}.json`),
    "active release approval",
  );
  if (sha256(approval) !== pointer.approval_hash) fail("active release approval hash does not match the pointer");
  let releaseKeys;
  let reviewerKeys;
  let formulaReviewerKeys;
  try {
    releaseKeys = trustedReleaseKeys ?? parseTrustedReleaseKeys();
    reviewerKeys = trustedReviewerKeys ?? parseTrustedSourceReviewKeys();
    formulaReviewerKeys = trustedFormulaReviewerKeys ?? parseTrustedFormulaReviewKeys();
  } catch (error) {
    fail(`active release trusted key registry is invalid (${error.message})`);
  }
  const approvalVerification = verifyReleaseApprovalDocument(approval, {
    trustedKeyRegistry: releaseKeys,
    expectedReleaseId: pointer.release_id,
    expectedManifestHash: pointer.release_manifest_hash,
    expectedOperation: pointer.operation,
    expectedPreviousReleaseId: pointer.previous_release_id,
    now,
  });
  if (!approvalVerification.valid) {
    fail(`active release approval failed cryptographic verification (${approvalVerification.reason})`, {
      approval: approvalVerification,
    });
  }
  if (canonicalJson(approvalVerification.approver_key_ids) !== canonicalJson(pointer.approver_key_ids)) {
    fail("active release approval key ids do not match the pointer");
  }
  let runtimeVerification;
  try {
    runtimeVerification = verifyRuntimePersonaRelease({
      releaseDir: physicalRelease,
      manifest,
      trustedReviewerKeys: reviewerKeys,
      trustedFormulaReviewerKeys: formulaReviewerKeys,
    });
  } catch (error) {
    fail(`active immutable release verification failed (${error.message})`, {
      cause: error.name,
      integrity: error.details || {},
    });
  }
  const physicalMasters = runtimeVerification.masters;
  if (statSync(physicalMasters).dev !== statSync(physicalRelease).dev) {
    fail("active release masters directory crosses a filesystem boundary");
  }
  return physicalMasters;
}

export const PERSONA_PRODUCTION_ROOT_ENV = Object.freeze({
  require_active_release: REQUIRE_ACTIVE_RELEASE_ENV,
  trusted_release_keys: TRUSTED_RELEASE_KEYS_ENV,
  trusted_source_review_keys: TRUSTED_SOURCE_REVIEW_KEYS_ENV,
  trusted_formula_review_keys: TRUSTED_FORMULA_REVIEW_KEYS_ENV,
});
