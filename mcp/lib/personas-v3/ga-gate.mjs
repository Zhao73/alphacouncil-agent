import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPersonas, defaultPersonaDir } from "../personas/registry.mjs";
import { inspectPersonaAdmission, defaultKnowledgeDir } from "./admission.mjs";
import { canonicalValue, sha256 } from "./canonical.mjs";
import { compilePersonaPack } from "./compiler.mjs";
import { inspectGaExternalEvidence } from "./ga-external-evidence.mjs";
import { loadV3Pack, loadV3Packs } from "./loader.mjs";
import { verifyPersonaRelease } from "./releases.mjs";
import { inspectSourceAcquisitions } from "./source-acquisition.mjs";
import { inspectSourceAdjudications } from "./source-adjudication.mjs";
import { defaultStagingRoot, inspectPersonaV3Staging } from "./staging.mjs";

export const GA_REPORT_SCHEMA_VERSION = 1;
export const GA_DEFAULT_COUNT = 26;
export const GA_DEFAULT_MIN_ADMISSION = "operational";
export const GA_TARGET_VERSION = "0.9.0";

export const GA_ADMISSION_LEVELS = Object.freeze([
  "prompt_lens",
  "operator_lens",
  "operational",
  "candidate",
  "method_model",
]);

const ADMISSION_RANK = new Map(GA_ADMISSION_LEVELS.map((level, index) => [level, index]));
const OPERATIONAL_OR_HIGHER = new Set(["operational", "candidate", "method_model"]);
const CANDIDATE_OR_HIGHER = new Set(["candidate", "method_model"]);
const PLACEHOLDER = /(?:^|[^A-Za-z0-9_])(?:TBD|TODO|REPLACE(?:_WITH)?|PLACEHOLDER)(?:$|[^A-Za-z0-9_])|待补充|待填写|占位符/iu;
const UNSAFE_ERROR = /symlink|escape|unsafe|absolute path|outside|not a directory/iu;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const DEFAULT_PACKAGE_JSON = fileURLToPath(new URL("../../../package.json", import.meta.url));

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sorted(values) {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function safeJson(file) {
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: error?.message || String(error) };
  }
}

function stableError(error, roots = {}) {
  let message = error?.message || String(error);
  for (const [label, path] of Object.entries(roots)) {
    if (path) message = message.replaceAll(resolve(path), `<${label}>`);
  }
  return message.replace(/\s+/gu, " ").trim();
}

function findingKey(finding) {
  return `${finding.scope}:${finding.persona_id || "-"}:${finding.code}:${finding.message}`;
}

function uniqueFindings(findings) {
  const byKey = new Map();
  for (const finding of findings) byKey.set(findingKey(finding), finding);
  return [...byKey.values()].sort((a, b) => findingKey(a).localeCompare(findingKey(b)));
}

function finding(scope, code, message, personaId = null) {
  return canonicalValue({ scope, code, persona_id: personaId, message });
}

function normalizeRequirements(requirements = {}) {
  const requireCount = requirements.require_count ?? requirements.requireCount ?? GA_DEFAULT_COUNT;
  const minimum = requirements.require_min_admission
    ?? requirements.requireMinAdmission
    ?? GA_DEFAULT_MIN_ADMISSION;
  if (!Number.isInteger(requireCount) || requireCount < 1) {
    throw new Error("require_count must be a positive integer");
  }
  if (!ADMISSION_RANK.has(minimum)) {
    throw new Error(`require_min_admission must be one of ${GA_ADMISSION_LEVELS.join("|")}`);
  }
  const expectedVersion = requirements.expected_version ?? requirements.expectedVersion ?? null;
  if (expectedVersion !== null
    && (typeof expectedVersion !== "string"
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion))) {
    throw new Error("expected_version must be a semantic version");
  }
  return Object.freeze({
    require_count: requireCount,
    require_min_admission: minimum,
    forbid_legacy: Boolean(requirements.forbid_legacy ?? requirements.forbidLegacy),
    forbid_prompt_lens: Boolean(requirements.forbid_prompt_lens ?? requirements.forbidPromptLens),
    require_release_evidence: true,
    expected_version: expectedVersion,
  });
}

export { normalizeRequirements as normalizeGaRequirements };

function scanProductionDirectories(knowledgeDir, canonicalIds, roots) {
  const canonical = new Set(canonicalIds);
  const physicalIds = [];
  const legacyIds = [];
  const manifestByDirectory = new Map();
  const invalid = [];
  const unsafe = [];
  if (!existsSync(knowledgeDir)) {
    return { physicalIds, legacyIds, manifestByDirectory, invalid, unsafe };
  }

  let entries;
  try {
    entries = readdirSync(knowledgeDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    invalid.push(finding("production", "knowledge_dir_unreadable", stableError(error, roots)));
    return { physicalIds, legacyIds, manifestByDirectory, invalid, unsafe };
  }

  for (const entry of entries) {
    const packDir = join(knowledgeDir, entry.name);
    if (entry.isSymbolicLink()) {
      unsafe.push(finding("production", "symlinked_pack_directory", `${entry.name}: pack directory is a symlink`, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const manifestFile = join(packDir, "manifest.json");
    if (!existsSync(manifestFile)) continue;
    try {
      if (lstatSync(manifestFile).isSymbolicLink()) {
        unsafe.push(finding("production", "symlinked_manifest", `${entry.name}: manifest.json is a symlink`, entry.name));
        continue;
      }
      if (!statSync(manifestFile).isFile()) {
        unsafe.push(finding("production", "non_file_manifest", `${entry.name}: manifest.json is not a regular file`, entry.name));
        continue;
      }
    } catch (error) {
      unsafe.push(finding("production", "manifest_stat_failed", stableError(error, roots), entry.name));
      continue;
    }
    const parsed = safeJson(manifestFile);
    if (parsed.error) {
      invalid.push(finding("production", "manifest_invalid_json", `${entry.name}: ${parsed.error}`, entry.name));
      continue;
    }
    manifestByDirectory.set(entry.name, parsed.value);
    if (parsed.value?.schema_version === 3) {
      physicalIds.push(entry.name);
      const declaredId = parsed.value?.identity?.persona_id;
      if (!canonical.has(entry.name)) {
        invalid.push(finding("production", "unknown_v3_directory", `${entry.name}: directory is not a canonical master ID`, entry.name));
      }
      if (declaredId !== entry.name) {
        invalid.push(finding("production", "manifest_identity_mismatch", `${entry.name}: manifest identity is ${JSON.stringify(declaredId)}`, entry.name));
      }
    } else {
      legacyIds.push(entry.name);
    }
  }
  return {
    physicalIds: sorted(physicalIds),
    legacyIds: sorted(legacyIds),
    manifestByDirectory,
    invalid,
    unsafe,
  };
}

function packTextFiles(packDir, manifest) {
  const relativeFiles = [
    "manifest.json",
    ...Object.values(isObject(manifest?.components) ? manifest.components : {}),
    manifest?.voice?.en,
    manifest?.voice?.zh,
  ].filter((value) => typeof value === "string" && value.trim());
  return sorted(relativeFiles).map((relativePath) => ({
    relativePath,
    file: resolve(packDir, relativePath),
  }));
}

function placeholderFiles(packDir, manifest, roots, unsafe) {
  const matches = [];
  const base = `${resolve(packDir)}/`;
  for (const { file, relativePath } of packTextFiles(packDir, manifest)) {
    if (!(file === resolve(packDir, "manifest.json") || file.startsWith(base))) {
      unsafe.push(finding("production", "placeholder_scan_escape", `${basename(packDir)}/${relativePath}: path escapes pack`, basename(packDir)));
      continue;
    }
    try {
      if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) continue;
      const size = statSync(file).size;
      if (size > 8 * 1024 * 1024) continue;
      if (PLACEHOLDER.test(readFileSync(file, "utf8"))) matches.push(relativePath);
    } catch (error) {
      unsafe.push(finding("production", "placeholder_scan_failed", stableError(error, roots), basename(packDir)));
    }
  }
  return sorted(matches);
}

function inspectStagingPending({ stagingDir, knowledgeDir, personaDir, roots }) {
  const result = {
    available: false,
    pending: [],
    invalid: [],
    unsafe: [],
  };
  if (!stagingDir || !existsSync(stagingDir)) return result;
  result.available = true;
  let staging;
  try {
    staging = inspectPersonaV3Staging({ root: stagingDir, productionRoot: knowledgeDir, personaDir });
  } catch (error) {
    const item = finding("staging", UNSAFE_ERROR.test(error?.message || "") ? "unsafe_staging" : "invalid_staging", stableError(error, roots));
    (item.code === "unsafe_staging" ? result.unsafe : result.invalid).push(item);
    return result;
  }
  if (staging.unsafe_artifact_count) {
    result.unsafe.push(finding("staging", "unsafe_artifact", `${staging.unsafe_artifact_count} unsafe staging artifact(s)`));
    return result;
  }
  if (staging.global_errors.length || staging.invalid_count) {
    result.invalid.push(finding("staging", "invalid_inventory", `${staging.invalid_count} invalid seat(s); ${staging.global_errors.join("; ") || "no global detail"}`));
    return result;
  }

  try {
    const acquisitions = inspectSourceAcquisitions({ root: stagingDir, productionRoot: knowledgeDir, personaDir });
    const adjudications = inspectSourceAdjudications({ root: stagingDir, productionRoot: knowledgeDir, personaDir });
    const adjudicated = new Set(adjudications.personas.flatMap((persona) => persona.records.map((record) => (
      `${persona.persona_id}/${record.candidate_id}`
    ))));
    for (const persona of acquisitions.personas) {
      for (const record of persona.records) {
        const key = `${persona.persona_id}/${record.candidate_id}`;
        if (!adjudicated.has(key)) {
          result.pending.push(canonicalValue({
            persona_id: persona.persona_id,
            candidate_id: record.candidate_id,
            status: "retrieved_unadjudicated",
          }));
        }
      }
    }
    for (const persona of adjudications.personas) {
      for (const record of persona.records) {
        if (["pending", "blocked"].includes(record.status)) {
          result.pending.push(canonicalValue({
            persona_id: persona.persona_id,
            candidate_id: record.candidate_id,
            status: record.status,
          }));
        }
      }
    }
    if (acquisitions.invalid_count || adjudications.invalid_count) {
      result.invalid.push(finding("staging", "source_inventory_invalid", `${acquisitions.invalid_count + adjudications.invalid_count} invalid source inventory seat(s)`));
    }
  } catch (error) {
    result.invalid.push(finding("staging", "source_inventory_failed", stableError(error, roots)));
  }
  result.pending.sort((a, b) => `${a.persona_id}/${a.candidate_id}`.localeCompare(`${b.persona_id}/${b.candidate_id}`));
  return result;
}

const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const RELEASE_MANIFEST_FIELDS = Object.freeze([
  "schema_version",
  "artifact_kind",
  "release_id",
  "release_status",
  "assembled_at",
  "canonical_master_count",
  "canonical_master_ids",
  "canonical_catalog_hash",
  "source_inventory_hash",
  "source_review_evidence",
  "masters_directory",
  "packs",
]);
const RELEASE_SOURCE_EVIDENCE_FIELDS = Object.freeze([
  "relative_path",
  "evidence_hash",
  "trusted_key_registry_hash",
  "ledger_inventory_hash",
  "method_defining_source_count",
]);
const RELEASE_PACK_FIELDS = Object.freeze([
  "persona_id",
  "relative_path",
  "pack_version",
  "source_cutoff",
  "tree_hash",
  "artifact_subject_hash",
  "pack_hash",
  "corpus_hash",
  "policy_hash",
  "tool_graph_hash",
  "prompt_hash",
  "component_hashes",
  "admission",
]);
const RELEASE_ADMISSION_FIELDS = Object.freeze([
  "level",
  "operational_clear",
  "candidate_clear",
  "counts",
  "delta_to_operational",
  "delta_to_candidate",
  "method_model_experiment_status",
]);
const LEGACY_COMBINED_EVIDENCE_FIELDS = new Set([
  "host", "host_status", "package", "package_status", "cutover", "cutover_status",
  "rollback", "rollback_status", "release",
]);

function exactObjectFields(value, fields, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return false;
  }
  const allowed = new Set(fields);
  for (const field of fields) if (!Object.hasOwn(value, field)) errors.push(`${label}.${field} is required`);
  for (const field of Object.keys(value)) if (!allowed.has(field)) errors.push(`${label}.${field} is not allowed`);
  return true;
}

function validIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function inspectReleaseManifest(
  releaseManifestPath,
  canonicalIds,
  expectedCatalogHash,
  actualPackHashes,
  roots,
) {
  const blank = {
    provided: false,
    status: "not_provided",
    release_id: null,
    manifest_hash: null,
    catalog_bound: false,
    pack_hashes_match: false,
    errors: [],
  };
  if (!releaseManifestPath) return blank;
  blank.provided = true;
  if (!existsSync(releaseManifestPath)) {
    blank.status = "invalid";
    blank.errors.push("release manifest is missing");
    return blank;
  }
  try {
    if (lstatSync(releaseManifestPath).isSymbolicLink() || !statSync(releaseManifestPath).isFile()) {
      blank.status = "invalid";
      blank.errors.push("release manifest must be a physical regular file");
      return blank;
    }
  } catch (error) {
    blank.status = "invalid";
    blank.errors.push(stableError(error, roots));
    return blank;
  }
  const parsed = safeJson(releaseManifestPath);
  if (parsed.error || !isObject(parsed.value)) {
    blank.status = "invalid";
    blank.errors.push(parsed.error || "release manifest must be an object");
    return blank;
  }
  blank.manifest_hash = sha256(parsed.value);
  blank.release_id = typeof parsed.value.release_id === "string" ? parsed.value.release_id : null;
  const legacyFields = Object.keys(parsed.value).filter((field) => LEGACY_COMBINED_EVIDENCE_FIELDS.has(field));
  if (legacyFields.length) {
    blank.errors.push("legacy combined release manifest is unsupported; pass the immutable manifest with --release-manifest and signed evidence with --release-evidence");
  }
  if (exactObjectFields(parsed.value, RELEASE_MANIFEST_FIELDS, "release manifest", blank.errors)) {
    if (parsed.value.schema_version !== 1
      || parsed.value.artifact_kind !== "persona_v3_release_manifest") {
      blank.errors.push("release manifest header is invalid");
    }
    if (!RELEASE_ID.test(parsed.value.release_id || "")) blank.errors.push("release manifest.release_id is invalid");
    if (parsed.value.release_status !== "assembled_immutable") blank.errors.push("release manifest.release_status must be assembled_immutable");
    if (!validIsoTimestamp(parsed.value.assembled_at)) blank.errors.push("release manifest.assembled_at is invalid");
    if (parsed.value.canonical_master_count !== canonicalIds.length) {
      blank.errors.push(`release manifest canonical_master_count=${parsed.value.canonical_master_count}; expected=${canonicalIds.length}`);
    }
    for (const field of ["canonical_catalog_hash", "source_inventory_hash"]) {
      if (!SHA256.test(parsed.value[field] || "")) blank.errors.push(`release manifest.${field} is invalid`);
    }
    if (exactObjectFields(
      parsed.value.source_review_evidence,
      RELEASE_SOURCE_EVIDENCE_FIELDS,
      "release manifest.source_review_evidence",
      blank.errors,
    )) {
      if (parsed.value.source_review_evidence.relative_path !== "source-review-evidence.json") {
        blank.errors.push("release manifest.source_review_evidence.relative_path is invalid");
      }
      for (const field of ["evidence_hash", "trusted_key_registry_hash", "ledger_inventory_hash"]) {
        if (!SHA256.test(parsed.value.source_review_evidence[field] || "")) {
          blank.errors.push(`release manifest.source_review_evidence.${field} is invalid`);
        }
      }
      if (!Number.isSafeInteger(parsed.value.source_review_evidence.method_defining_source_count)
        || parsed.value.source_review_evidence.method_defining_source_count < 0) {
        blank.errors.push("release manifest.source_review_evidence.method_defining_source_count is invalid");
      }
    }
    if (parsed.value.canonical_catalog_hash !== expectedCatalogHash) {
      blank.errors.push("release manifest.canonical_catalog_hash does not match the loaded canonical catalog");
    }
    if (parsed.value.masters_directory !== "masters") blank.errors.push("release manifest.masters_directory must be masters");
  }

  const ids = parsed.value.canonical_master_ids;
  blank.catalog_bound = Array.isArray(ids)
    && ids.length === canonicalIds.length
    && ids.every((id, index) => id === canonicalIds[index]);
  if (!blank.catalog_bound) blank.errors.push("release manifest is not bound to the exact canonical catalog order");

  const packs = parsed.value.packs;
  let packHashesMatch = Array.isArray(packs) && packs.length === canonicalIds.length;
  if (!Array.isArray(packs)) blank.errors.push("release manifest.packs must be an array");
  else {
    if (packs.length !== canonicalIds.length) blank.errors.push(`release manifest.packs must contain exactly ${canonicalIds.length} entries`);
    for (const [index, pack] of packs.entries()) {
      const personaId = canonicalIds[index] || `index_${index}`;
      const label = `release manifest.packs[${index}]`;
      if (!exactObjectFields(pack, RELEASE_PACK_FIELDS, label, blank.errors)) {
        packHashesMatch = false;
        continue;
      }
      if (pack.persona_id !== personaId) {
        blank.errors.push(`${label}.persona_id is not in canonical catalog order`);
        packHashesMatch = false;
      }
      if (pack.relative_path !== `masters/${pack.persona_id}`) blank.errors.push(`${label}.relative_path is invalid`);
      if (typeof pack.pack_version !== "string" || !/^\d+\.\d+\.\d+$/u.test(pack.pack_version)) {
        blank.errors.push(`${label}.pack_version is invalid`);
      }
      if (typeof pack.source_cutoff !== "string" || pack.source_cutoff.length < 10) blank.errors.push(`${label}.source_cutoff is invalid`);
      for (const field of [
        "tree_hash", "artifact_subject_hash", "pack_hash", "corpus_hash", "policy_hash",
        "tool_graph_hash", "prompt_hash",
      ]) {
        if (!SHA256.test(pack[field] || "")) blank.errors.push(`${label}.${field} is invalid`);
      }
      if (!isObject(pack.component_hashes) || !Object.keys(pack.component_hashes).length
        || Object.values(pack.component_hashes).some((hash) => !SHA256.test(hash || ""))) {
        blank.errors.push(`${label}.component_hashes is invalid`);
      }
      if (exactObjectFields(pack.admission, RELEASE_ADMISSION_FIELDS, `${label}.admission`, blank.errors)) {
        if (!new Set(["operational", "candidate", "method_model"]).has(pack.admission.level)) {
          blank.errors.push(`${label}.admission.level is below the release floor`);
        }
        if (pack.admission.operational_clear !== true) blank.errors.push(`${label}.admission.operational_clear must be true`);
        if (typeof pack.admission.candidate_clear !== "boolean") blank.errors.push(`${label}.admission.candidate_clear is invalid`);
        for (const field of ["counts", "delta_to_operational", "delta_to_candidate"]) {
          if (!isObject(pack.admission[field])) blank.errors.push(`${label}.admission.${field} must be an object`);
        }
        if (typeof pack.admission.method_model_experiment_status !== "string"
          || pack.admission.method_model_experiment_status.length < 3) {
          blank.errors.push(`${label}.admission.method_model_experiment_status is invalid`);
        }
      }
      const actualHash = actualPackHashes.get(pack.persona_id);
      if (!actualHash || actualHash !== pack.pack_hash) {
        blank.errors.push(`${label}.pack_hash does not match the compiled production pack`);
        packHashesMatch = false;
      }
    }
    if (packs.length === canonicalIds.length) {
      const expectedInventoryHash = sha256(packs.map((pack) => ({
        persona_id: pack?.persona_id,
        tree_hash: pack?.tree_hash,
        pack_hash: pack?.pack_hash,
        admission: pack?.admission?.level,
      })));
      if (parsed.value.source_inventory_hash !== expectedInventoryHash) {
        blank.errors.push("release manifest.source_inventory_hash does not match its pack inventory");
      }
    }
  }
  blank.pack_hashes_match = packHashesMatch;
  blank.status = blank.errors.length ? "invalid" : "valid";
  return blank;
}

function inspectReleaseEvidence(
  releaseEvidencePath,
  release,
  trustedReleaseEvidenceKeys,
  roots,
  now,
) {
  const blank = {
    provided: false,
    status: "not_provided",
    evidence_hash: null,
    release_id: null,
    release_manifest_hash: null,
    manifest_bound: false,
    signature_valid: false,
    approver_key_ids: [],
    approver_principal_ids: [],
    checks: {},
    host: "not_provided",
    package: "not_provided",
    cutover: "not_provided",
    rollback: "not_provided",
    errors: [],
  };
  if (!releaseEvidencePath) return blank;
  blank.provided = true;
  if (!existsSync(releaseEvidencePath)) {
    blank.status = "invalid";
    blank.errors.push("release evidence is missing");
    return blank;
  }
  try {
    if (lstatSync(releaseEvidencePath).isSymbolicLink() || !statSync(releaseEvidencePath).isFile()) {
      blank.status = "invalid";
      blank.errors.push("release evidence must be a physical regular file");
      return blank;
    }
  } catch (error) {
    blank.status = "invalid";
    blank.errors.push(stableError(error, roots));
    return blank;
  }
  const parsed = safeJson(releaseEvidencePath);
  if (parsed.error || !isObject(parsed.value)) {
    blank.status = "invalid";
    blank.errors.push(parsed.error || "release evidence must be an object");
    return blank;
  }
  blank.evidence_hash = sha256(parsed.value);
  blank.release_id = typeof parsed.value.release_id === "string" ? parsed.value.release_id : null;
  blank.release_manifest_hash = typeof parsed.value.release_manifest_hash === "string"
    ? parsed.value.release_manifest_hash : null;
  if (!release.provided) {
    blank.status = "invalid";
    blank.errors.push("release evidence requires the immutable --release-manifest input");
    return blank;
  }
  if (release.status !== "valid") {
    blank.status = "invalid";
    blank.errors.push("release evidence cannot bind to an invalid release manifest");
    return blank;
  }
  let verified;
  try {
    verified = verifyReleaseEvidenceDocument(parsed.value, {
      trustedKeyRegistry: trustedReleaseEvidenceKeys,
      expectedReleaseId: release.release_id,
      expectedManifestHash: release.manifest_hash,
      now,
    });
  } catch (error) {
    blank.status = "invalid";
    blank.errors.push(stableError(error, roots));
    return blank;
  }
  if (!verified.valid) {
    blank.status = "invalid";
    blank.errors.push(verified.reason || "release evidence verification failed");
    blank.errors.push(...(verified.errors || []));
    for (const failure of verified.failures || []) {
      blank.errors.push(`${failure.signer_key_id}: ${failure.reason}`);
    }
    return blank;
  }
  blank.status = "valid";
  blank.evidence_hash = verified.evidence_hash;
  blank.manifest_bound = verified.release_manifest_hash === release.manifest_hash
    && verified.release_id === release.release_id;
  blank.signature_valid = true;
  blank.approver_key_ids = verified.approver_key_ids;
  blank.approver_principal_ids = verified.approver_principal_ids;
  blank.checks = verified.checks;
  blank.host = verified.statuses.host;
  blank.package = verified.statuses.package;
  blank.cutover = verified.statuses.cutover;
  blank.rollback = verified.statuses.rollback;
  if (!blank.manifest_bound) {
    blank.status = "invalid";
    blank.errors.push("release evidence is not bound to the supplied immutable release manifest");
  }
  return blank;
}

function inspectRepositoryPackage(packageJsonPath, roots) {
  const result = { status: "invalid", name: null, version: null, file_hash: null, errors: [] };
  try {
    if (!existsSync(packageJsonPath)) throw new Error("repository package.json is missing");
    const stat = lstatSync(packageJsonPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("repository package.json must be a physical regular file");
    const bytes = readFileSync(packageJsonPath);
    const value = JSON.parse(bytes.toString("utf8"));
    result.name = typeof value.name === "string" ? value.name : null;
    result.version = typeof value.version === "string" ? value.version : null;
    result.file_hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (!result.name) result.errors.push("repository package.json name is invalid");
    if (!result.version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(result.version)) {
      result.errors.push("repository package.json version is invalid");
    }
  } catch (error) {
    result.errors.push(stableError(error, roots));
  }
  result.status = result.errors.length ? "invalid" : "valid";
  return result;
}

function inspectImmutableRelease({
  releaseRoot,
  releaseId,
  releaseManifestPath,
  personaDir,
  trustedSourceReviewerKeys,
  trustedFormulaReviewerKeys,
  expectedVersion,
  canonicalIds,
  actualPackHashes,
  roots,
}) {
  const result = {
    provided: Boolean(releaseRoot || releaseId || releaseManifestPath),
    status: "not_provided",
    release_id: releaseId || null,
    manifest_hash: null,
    catalog_bound: false,
    pack_hashes_match: false,
    full_verification: false,
    release_manifest: null,
    errors: [],
  };
  if (releaseManifestPath) {
    result.errors.push("standalone --release-manifest is not GA evidence; use --release-root and --release-id");
  }
  if (!releaseRoot && !releaseId) {
    result.status = result.errors.length ? "invalid" : "not_provided";
    return result;
  }
  result.provided = true;
  if (!releaseRoot || !releaseId) {
    result.errors.push("both release root and release id are required for full immutable release verification");
    result.status = "invalid";
    return result;
  }
  if (trustedSourceReviewerKeys === undefined || trustedSourceReviewerKeys === null) {
    result.errors.push("trusted source reviewer keys are required for immutable release verification");
    result.status = "invalid";
    return result;
  }
  if (trustedFormulaReviewerKeys === undefined || trustedFormulaReviewerKeys === null) {
    result.errors.push("trusted formula reviewer keys are required for immutable release verification");
    result.status = "invalid";
    return result;
  }
  let verified;
  try {
    verified = verifyPersonaRelease({
      releaseId,
      releaseRoot,
      personaDir,
      trustedReviewerKeys: trustedSourceReviewerKeys,
      trustedFormulaReviewerKeys,
    });
  } catch (error) {
    result.errors.push(stableError(error, roots));
    result.status = "invalid";
    return result;
  }
  const manifest = verified.release_manifest;
  result.release_id = verified.release_id;
  result.manifest_hash = verified.release_manifest_hash;
  result.release_manifest = manifest;
  result.full_verification = verified.status === "verified";
  result.catalog_bound = Array.isArray(manifest?.canonical_master_ids)
    && manifest.canonical_master_ids.length === canonicalIds.length
    && manifest.canonical_master_ids.every((id, index) => id === canonicalIds[index]);
  if (!result.catalog_bound) result.errors.push("verified release canonical catalog/order differs from the active catalog");
  result.pack_hashes_match = Array.isArray(manifest?.packs)
    && manifest.packs.length === canonicalIds.length
    && manifest.packs.every((pack, index) => (
      pack.persona_id === canonicalIds[index]
      && actualPackHashes.get(pack.persona_id) === pack.pack_hash
    ));
  if (!result.pack_hashes_match) result.errors.push("verified immutable release pack hashes differ from the active production packs");
  if (!expectedVersion) result.errors.push("expected version is required before GA can pass");
  else {
    if (verified.release_id !== expectedVersion) {
      result.errors.push(`immutable release id=${verified.release_id}; expected version=${expectedVersion}`);
    }
    if (manifest.packs.some((pack) => pack.pack_version !== expectedVersion)) {
      result.errors.push(`all immutable release pack versions must equal ${expectedVersion}`);
    }
  }
  result.status = result.errors.length ? "invalid" : "valid";
  return result;
}

function statusEvidence(status, evidence, reasons = []) {
  return canonicalValue({ status, evidence, reasons: sorted(reasons) });
}

function gateFailure(code, message, personaIds = []) {
  return canonicalValue({ code, message, persona_ids: sorted(personaIds) });
}

/**
 * Build a deterministic, read-only GA report from the canonical prompt catalog and the
 * production PersonaPack directory. No manifest declaration can override loader/admission.
 */
export function buildPersonaV3GaReport({
  personaDir = defaultPersonaDir(),
  knowledgeDir = defaultKnowledgeDir(),
  stagingDir = defaultStagingRoot(),
  releaseRoot = null,
  releaseId = null,
  releaseManifestPath = null,
  releaseEvidencePath = null,
  packageJsonPath = DEFAULT_PACKAGE_JSON,
  trustedSourceReviewerKeys = undefined,
  trustedFormulaReviewerKeys = undefined,
  trustedReleaseEvidenceKeys = undefined,
  trustedReleaseKeys = undefined,
  trustedExperimentAdjudicationKeys = undefined,
  now = new Date(),
  requirements: requestedRequirements = {},
} = {}) {
  const requirements = normalizeRequirements(requestedRequirements);
  const roots = {
    personas: personaDir,
    knowledge: knowledgeDir,
    staging: stagingDir,
    release: releaseRoot,
    package: packageJsonPath,
  };
  const invalidFindings = [];
  const unsafeFindings = [];
  let canonicalIds = [];
  let prompts = null;
  try {
    prompts = loadPersonas({ dir: personaDir });
    canonicalIds = prompts.ids("master");
  } catch (error) {
    invalidFindings.push(finding("catalog", "canonical_catalog_invalid", stableError(error, roots)));
  }

  const scan = scanProductionDirectories(knowledgeDir, canonicalIds, roots);
  invalidFindings.push(...scan.invalid);
  unsafeFindings.push(...scan.unsafe);
  const physicalSet = new Set(scan.physicalIds.filter((id) => canonicalIds.includes(id)));
  let productionLoader = null;
  let aggregateLoaderError = null;
  try {
    productionLoader = loadV3Packs({ dir: knowledgeDir });
  } catch (error) {
    aggregateLoaderError = stableError(error, roots);
    invalidFindings.push(finding("production", "production_loader_failed", aggregateLoaderError));
  }

  const loadedById = new Map();
  const loaderVisibleIds = [];
  if (productionLoader) {
    for (const pack of productionLoader.packs) {
      const id = pack.manifest.identity.persona_id;
      if (!canonicalIds.includes(id)) {
        invalidFindings.push(finding("production", "noncanonical_loaded_pack", `${id}: loader exposed a noncanonical pack`, id));
        continue;
      }
      loadedById.set(id, pack);
      loaderVisibleIds.push(id);
    }
  } else {
    // Preserve per-seat diagnostics without pretending the aggregate production loader works.
    for (const id of scan.physicalIds) {
      try {
        loadV3Pack(join(knowledgeDir, id));
      } catch (error) {
        const message = stableError(error, roots);
        const item = finding("production", "pack_load_failed", message, id);
        (UNSAFE_ERROR.test(message) ? unsafeFindings : invalidFindings).push(item);
      }
    }
  }

  const staging = inspectStagingPending({ stagingDir, knowledgeDir, personaDir, roots });
  invalidFindings.push(...staging.invalid);
  unsafeFindings.push(...staging.unsafe);
  const pendingByPersona = new Map();
  for (const item of staging.pending) pendingByPersona.set(item.persona_id, (pendingByPersona.get(item.persona_id) || 0) + 1);

  const personas = [];
  const compiledIds = [];
  for (const personaId of canonicalIds) {
    const persona = prompts.get(personaId);
    const promptFile = join(prompts.dir, persona.file);
    const packDir = join(knowledgeDir, personaId);
    const pack = loadedById.get(personaId);
    const errors = [];
    let admissionLevel = "invalid";
    let packFormat = physicalSet.has(personaId) ? "v3_physical" : "v1_prompt";
    let compiled = false;
    let packHash = null;
    let placeholderMatches = [];
    if (pack) {
      placeholderMatches = placeholderFiles(packDir, pack.manifest, roots, unsafeFindings);
      try {
        const result = compilePersonaPack(pack, { promptFile });
        admissionLevel = result.admission.level;
        packFormat = "v3_physical";
        packHash = result.pack_hash;
        compiled = true;
        compiledIds.push(personaId);
      } catch (error) {
        const message = stableError(error, roots);
        errors.push(message);
        invalidFindings.push(finding("compile", "pack_compile_failed", message, personaId));
      }
    } else {
      try {
        const result = inspectPersonaAdmission({ persona_id: personaId, prompt_file: promptFile, pack_dir: packDir });
        admissionLevel = result.admission_level;
        packFormat = result.pack_format;
        if (result.errors?.length) errors.push(...result.errors);
      } catch (error) {
        const message = stableError(error, roots);
        errors.push(message);
        invalidFindings.push(finding("admission", "admission_inspection_failed", message, personaId));
      }
    }
    const fallback = !compiled && Boolean(persona || packFormat === "v2_inline");
    personas.push(canonicalValue({
      persona_id: personaId,
      admission_level: admissionLevel,
      pack_format: packFormat,
      physical_v3: physicalSet.has(personaId),
      production_loader_visible: loadedById.has(personaId),
      compiled,
      pack_hash: SHA256.test(packHash || "") ? packHash : null,
      placeholder_files: placeholderMatches,
      pending_review: pendingByPersona.get(personaId) || 0,
      silent_fallback: fallback,
      errors: sorted(errors),
    }));
  }

  // Pending sources embedded in a loadable production pack remain visible even if staging is absent.
  for (const persona of personas) {
    const pack = loadedById.get(persona.persona_id);
    if (!pack) continue;
    const pendingSources = pack.components.sources.filter((source) => source?.adjudication?.status !== "approved").length;
    if (pendingSources) {
      const index = personas.findIndex((entry) => entry.persona_id === persona.persona_id);
      personas[index] = canonicalValue({ ...personas[index], pending_review: personas[index].pending_review + pendingSources });
    }
  }

  const levelCount = (predicate) => personas.filter((persona) => predicate(persona.admission_level)).length;
  const promptLensCount = levelCount((level) => level === "prompt_lens");
  const legacyV2Ids = sorted([
    ...scan.legacyIds,
    ...(productionLoader?.legacy_ids || []),
    ...personas.filter((persona) => persona.pack_format === "v2_inline").map((persona) => persona.persona_id),
  ]);
  const invalid = uniqueFindings(invalidFindings);
  const unsafe = uniqueFindings(unsafeFindings);
  const placeholderIds = personas.filter((persona) => persona.placeholder_files.length).map((persona) => persona.persona_id);
  const pendingReview = personas.reduce((sum, persona) => sum + persona.pending_review, 0);
  const silentFallbackIds = personas.filter((persona) => persona.silent_fallback).map((persona) => persona.persona_id);
  const actualPackHashes = new Map(personas
    .filter((persona) => persona.compiled && persona.pack_hash)
    .map((persona) => [persona.persona_id, persona.pack_hash]));
  const repositoryPackage = inspectRepositoryPackage(packageJsonPath, roots);
  const release = inspectImmutableRelease({
    releaseRoot,
    releaseId,
    releaseManifestPath,
    personaDir,
    trustedSourceReviewerKeys,
    trustedFormulaReviewerKeys,
    expectedVersion: requirements.expected_version,
    canonicalIds,
    actualPackHashes,
    roots,
  });
  const releaseEvidence = inspectGaExternalEvidence({
    releaseEvidencePath,
    verifiedRelease: release.status === "valid" ? {
      status: "verified",
      release_id: release.release_id,
      release_manifest_hash: release.manifest_hash,
      release_manifest: release.release_manifest,
    } : null,
    expectedVersion: requirements.expected_version,
    packageJsonPath,
    releaseRoot,
    personaDir,
    trustedReleaseEvidenceKeys,
    trustedReleaseKeys,
    trustedSourceReviewerKeys,
    trustedFormulaReviewerKeys,
    trustedExperimentAdjudicationKeys,
    now,
  });

  const failures = [];
  if (!requirements.expected_version) {
    failures.push(gateFailure("expected_version_required", "--expected-version is required for a GA verdict"));
  }
  if (repositoryPackage.status !== "valid") {
    failures.push(gateFailure("package_json_invalid", repositoryPackage.errors.join("; ") || "repository package.json is invalid"));
  } else if (requirements.expected_version && repositoryPackage.version !== requirements.expected_version) {
    failures.push(gateFailure(
      "package_json_version_mismatch",
      `package.json version=${repositoryPackage.version}; expected=${requirements.expected_version}`,
    ));
  }
  if (canonicalIds.length !== requirements.require_count) {
    failures.push(gateFailure("canonical_count_mismatch", `canonical_count=${canonicalIds.length}; required=${requirements.require_count}`));
  }
  if (physicalSet.size !== requirements.require_count) {
    failures.push(gateFailure("physical_v3_count_mismatch", `physical_v3_count=${physicalSet.size}; required=${requirements.require_count}`));
  }
  if (loaderVisibleIds.length !== requirements.require_count) {
    failures.push(gateFailure("production_loader_visibility_mismatch", `production_loader_visible=${loaderVisibleIds.length}; required=${requirements.require_count}`));
  }
  if (compiledIds.length !== requirements.require_count) {
    failures.push(gateFailure("compiled_count_mismatch", `compiled_count=${compiledIds.length}; required=${requirements.require_count}`));
  }
  const minimumRank = ADMISSION_RANK.get(requirements.require_min_admission);
  const belowMinimum = personas
    .filter((persona) => (ADMISSION_RANK.get(persona.admission_level) ?? -1) < minimumRank)
    .map((persona) => persona.persona_id);
  if (belowMinimum.length) {
    failures.push(gateFailure("minimum_admission_not_met", `${belowMinimum.length} seat(s) below ${requirements.require_min_admission}`, belowMinimum));
  }
  if (requirements.forbid_legacy && legacyV2Ids.length) {
    failures.push(gateFailure("legacy_v2_forbidden", `${legacyV2Ids.length} legacy v2 pack(s) remain`, legacyV2Ids));
  }
  if (requirements.forbid_prompt_lens && promptLensCount) {
    failures.push(gateFailure("prompt_lens_forbidden", `${promptLensCount} prompt lens seat(s) remain`, personas.filter((persona) => persona.admission_level === "prompt_lens").map((persona) => persona.persona_id)));
  }
  if (invalid.length) failures.push(gateFailure("invalid_artifacts", `${invalid.length} invalid finding(s)`));
  if (unsafe.length) failures.push(gateFailure("unsafe_artifacts", `${unsafe.length} unsafe finding(s)`));
  if (placeholderIds.length) failures.push(gateFailure("placeholders_present", `${placeholderIds.length} pack(s) contain placeholders`, placeholderIds));
  if (pendingReview) failures.push(gateFailure("pending_review_present", `${pendingReview} source review item(s) remain`));
  if (silentFallbackIds.length) failures.push(gateFailure("silent_fallback_present", `${silentFallbackIds.length} seat(s) can fall back below physical v3`, silentFallbackIds));
  if (!release.provided) {
    failures.push(gateFailure("release_manifest_required", "immutable release manifest was not provided"));
  }
  if (!releaseEvidence.provided) {
    failures.push(gateFailure("release_evidence_required", "signed release evidence was not provided"));
  }
  if (release.provided) {
    if (release.status !== "valid") failures.push(gateFailure("release_manifest_invalid", release.errors.join("; ") || "release manifest is invalid"));
  }
  if (releaseEvidence.provided) {
    if (releaseEvidence.status !== "valid") {
      failures.push(gateFailure("release_evidence_invalid", releaseEvidence.errors.join("; ") || "release evidence is invalid"));
    }
  }
  if (releaseEvidence.status === "valid") {
    for (const key of ["experiment", "host", "package", "cutover", "rollback"]) {
      if (releaseEvidence[key] !== "passed") {
        failures.push(gateFailure(`release_${key}_not_passed`, `release ${key} status=${releaseEvidence[key]}`));
      }
    }
  }

  failures.sort((a, b) => a.code.localeCompare(b.code));
  const coreCutoverFailures = failures.filter((failure) => !failure.code.startsWith("release_"));
  const failedHostChecks = releaseEvidence.host === "passed" ? [] : ["physical_external_host_evidence"];
  const status = failures.length ? "failed" : "passed";
  const stable = canonicalValue({
    schema_version: GA_REPORT_SCHEMA_VERSION,
    artifact_kind: "persona_v3_ga_report",
    status,
    requirements,
    canonical_count: canonicalIds.length,
    physical_v3_count: physicalSet.size,
    production_loader_visible: loaderVisibleIds.length,
    compiled_count: compiledIds.length,
    operational_or_higher: levelCount((level) => OPERATIONAL_OR_HIGHER.has(level)),
    candidate_or_higher: levelCount((level) => CANDIDATE_OR_HIGHER.has(level)),
    method_model_count: levelCount((level) => level === "method_model"),
    prompt_lens_count: promptLensCount,
    legacy_v2_count: legacyV2Ids.length,
    invalid: invalid.length,
    unsafe: unsafe.length,
    placeholder: placeholderIds.length,
    pending_review: pendingReview,
    silent_fallback: silentFallbackIds.length,
    canonical_ids: canonicalIds,
    physical_v3_ids: sorted([...physicalSet]),
    production_loader_visible_ids: sorted(loaderVisibleIds),
    compiled_ids: sorted(compiledIds),
    legacy_v2_ids: legacyV2Ids,
    invalid_findings: invalid,
    unsafe_findings: unsafe,
    pending_review_items: staging.pending,
    expected_version: requirements.expected_version,
    package_version: repositoryPackage.version,
    package_json_hash: repositoryPackage.file_hash,
    experiment_status: statusEvidence(
      releaseEvidence.experiment,
      releaseEvidence.provided ? "release_evidence" : "none",
      releaseEvidence.experiment === "passed" ? [] : releaseEvidence.errors,
    ),
    host_status: statusEvidence(
      releaseEvidence.host,
      releaseEvidence.provided ? "release_evidence" : "none",
      failedHostChecks,
    ),
    package_status: statusEvidence(
      releaseEvidence.package,
      releaseEvidence.provided ? "release_evidence" : "none",
    ),
    cutover_status: statusEvidence(
      releaseEvidence.status === "valid"
        ? releaseEvidence.cutover
        : coreCutoverFailures.length ? "blocked" : "ready",
      releaseEvidence.provided ? "core_gate_and_release_evidence" : "derived_core_gate",
      coreCutoverFailures.map((failure) => failure.code),
    ),
    rollback_status: statusEvidence(
      releaseEvidence.rollback,
      releaseEvidence.provided ? "release_evidence" : "none",
    ),
    release_manifest: canonicalValue({
      provided: release.provided,
      status: release.status,
      release_id: release.release_id,
      manifest_hash: release.manifest_hash,
      catalog_bound: release.catalog_bound,
      pack_hashes_match: release.pack_hashes_match,
      full_verification: release.full_verification,
      errors: sorted(release.errors),
    }),
    release_evidence: canonicalValue({
      provided: releaseEvidence.provided,
      status: releaseEvidence.status,
      evidence_hash: releaseEvidence.evidence_hash,
      release_id: releaseEvidence.release_id,
      release_manifest_hash: releaseEvidence.release_manifest_hash,
      manifest_bound: releaseEvidence.manifest_bound,
      signature_valid: releaseEvidence.signature_valid,
      approver_key_ids: sorted(releaseEvidence.approver_key_ids),
      approver_principal_ids: sorted(releaseEvidence.approver_principal_ids),
      physical_artifact_hashes: releaseEvidence.physical_artifact_hashes,
      errors: sorted(releaseEvidence.errors),
    }),
    aggregate_loader_status: aggregateLoaderError ? "failed" : "passed",
    gate_failures: failures,
    personas,
  });
  return Object.freeze({ ...stable, report_hash: sha256(stable) });
}

export function renderPersonaV3GaReport(report) {
  const lines = [
    `PersonaPack v3 GA gate: ${report.status.toUpperCase()}`,
    `canonical=${report.canonical_count} physical_v3=${report.physical_v3_count} loader_visible=${report.production_loader_visible} compiled=${report.compiled_count}`,
    `operational_or_higher=${report.operational_or_higher} candidate_or_higher=${report.candidate_or_higher} method_model=${report.method_model_count}`,
    `prompt_lens=${report.prompt_lens_count} legacy_v2=${report.legacy_v2_count} invalid=${report.invalid} unsafe=${report.unsafe}`,
    `placeholder=${report.placeholder} pending_review=${report.pending_review} silent_fallback=${report.silent_fallback}`,
    `expected_version=${report.expected_version || "missing"} package_version=${report.package_version || "invalid"}`,
    `experiment=${report.experiment_status.status} host=${report.host_status.status} package=${report.package_status.status} cutover=${report.cutover_status.status} rollback=${report.rollback_status.status}`,
    `release_manifest=${report.release_manifest.status} release_evidence=${report.release_evidence.status}`,
    `report_hash=${report.report_hash}`,
  ];
  if (report.gate_failures.length) {
    lines.push("Failures:");
    for (const failure of report.gate_failures) {
      const seats = failure.persona_ids.length ? ` [${failure.persona_ids.join(",")}]` : "";
      lines.push(`- ${failure.code}: ${failure.message}${seats}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
