/** Self-contained, immutable release evidence for all 52 deterministic formula tools. */

import { CANONICAL_MASTER_COUNT } from "./staging.mjs";

// Two planned tools per canonical seat; the seat count is the single source of truth.
// Evaluated lazily: this module participates in an import cycle with the staging roster, so a
// module-level constant reads the binding before it is initialised.
const plannedToolCount = () => CANONICAL_MASTER_COUNT * 2;
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import buildInventory from "../../../data/persona-v3-build-specs.v1.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import {
  formulaApprovalEvidenceRelativePath,
  parseTrustedFormulaReviewKeys,
  publicFormulaReviewKeyRegistry,
  verifyFormulaApprovalBundle,
} from "./formula-review-attestations.mjs";
import { CANONICAL_MASTER_IDS } from "./staging.mjs";
import { validateFormulaSpec } from "../../../scripts/lib/persona-v3-formula-pipeline.mjs";

export const RELEASE_FORMULA_EVIDENCE_FILE = "formula-review-evidence.json";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const EVIDENCE_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "verified_at", "canonical_master_count",
  "planned_tool_count", "trusted_formula_reviewer_keys", "trusted_key_registry_hash",
  "formula_binding_inventory_hash", "verified_bindings",
]);

export class PersonaReleaseFormulaEvidenceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaReleaseFormulaEvidenceError";
    this.details = canonicalValue(details);
  }
}

function fail(message, details = {}) {
  throw new PersonaReleaseFormulaEvidenceError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function exactIso(value, label) {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(`${label} must be an exact UTC ISO timestamp`);
  return new Date(time);
}

function plainDirectory(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a plain directory: ${path}`);
  return realpathSync(path);
}

function readJsonWithin(root, relativePath, label) {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) fail(`${label} path is unsafe`);
  const file = resolve(root, relativePath);
  if (!inside(root, file) || !existsSync(file)) fail(`${label} is missing: ${relativePath}`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a plain file`);
  const physical = realpathSync(file);
  if (!inside(root, physical)) fail(`${label} escapes its pack`);
  try { return JSON.parse(readFileSync(physical, "utf8")); } catch (error) {
    fail(`${label} is invalid JSON (${error.message})`);
  }
}

function expectedToolMap() {
  const byPersona = new Map(buildInventory.seats.map((seat) => [
    seat.persona_id,
    seat.planned_dedicated_tools.map((tool) => tool.tool_id),
  ]));
  const count = [...byPersona.values()].reduce((total, ids) => total + ids.length, 0);
  if (count !== plannedToolCount()) fail(`release formula inventory must contain exactly ${plannedToolCount()} planned tools, found ${count}`);
  return byPersona;
}

function verifyToolBinding({ tool, bundle, personaId, trustedKeys, now }) {
  const specErrors = validateFormulaSpec(bundle?.formula_spec);
  if (specErrors.length) fail(`${tool.id}: bundled formula spec is invalid`, { errors: specErrors });
  const approval = verifyFormulaApprovalBundle(bundle, {
    trustedKeyRegistry: trustedKeys,
    now,
    expectedFormulaSpec: bundle.formula_spec,
  });
  if (!approval.valid) fail(`${tool.id}: formula approval is invalid (${approval.reason})`, { approval });
  const scalarBindings = {
    id: bundle.formula_spec.tool_id,
    formula_spec_id: bundle.formula_spec.formula_spec_id,
    formula_spec_hash: approval.formula_spec_hash,
    formula_review_subject_hash: approval.review_subject_hash,
    approval_bundle_hash: approval.approval_bundle_hash,
  };
  for (const [field, expected] of Object.entries(scalarBindings)) {
    if (tool[field] !== expected) fail(`${personaId}.${tool.id}: ${field} does not match formula evidence`);
  }
  for (const [field, expected] of Object.entries({
    source_ids: bundle.source_ids,
  })) {
    if (canonicalJson(tool[field]) !== canonicalJson(expected)) fail(`${personaId}.${tool.id}: ${field} does not match formula evidence`);
  }
  return canonicalValue({
    persona_id: personaId,
    tool_id: tool.id,
    formula_spec_id: tool.formula_spec_id,
    formula_spec_hash: approval.formula_spec_hash,
    formula_review_subject_hash: approval.review_subject_hash,
    approval_bundle_hash: approval.approval_bundle_hash,
    prototype_content_hash: bundle.prototype_content_hash,
    source_ids: bundle.source_ids,
    reviewer_principal_ids: approval.reviewer_principal_ids,
    signer_key_ids: approval.signer_key_ids,
    latest_reviewed_at: approval.latest_reviewed_at,
  });
}

function bindingsFromPacks({ packsRoot, trustedKeys, verifiedAt }) {
  const root = plainDirectory(resolve(packsRoot), "formula evidence packs root");
  const expectedByPersona = expectedToolMap();
  const bindings = [];
  for (const personaId of CANONICAL_MASTER_IDS) {
    const pack = plainDirectory(join(root, personaId), `${personaId} release pack`);
    if (!inside(root, pack)) fail(`${personaId}: release pack escapes the packs root`);
    const manifest = readJsonWithin(pack, "manifest.json", `${personaId} manifest`);
    const tools = readJsonWithin(pack, manifest?.components?.tools, `${personaId} tools`);
    if (!Array.isArray(tools)) fail(`${personaId}: tools component must be an exact array`);
    const ids = tools.map((tool) => tool?.id);
    const expectedIds = expectedByPersona.get(personaId) || [];
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    const missing = expectedIds.filter((id) => !ids.includes(id));
    const extra = ids.filter((id) => !expectedIds.includes(id));
    if (ids.length !== expectedIds.length || duplicates.length || missing.length || extra.length) {
      fail(`${personaId}: release pack must contain exactly its planned unique formula tools`, {
        actual_count: ids.length, expected_count: expectedIds.length, duplicates, missing, extra,
      });
    }
    for (const toolId of expectedIds) {
      const tool = tools.find((candidate) => candidate?.id === toolId);
      const bundle = readJsonWithin(pack,
        formulaApprovalEvidenceRelativePath(personaId, toolId),
        `${personaId}.${toolId} formula approval bundle`);
      bindings.push(verifyToolBinding({ tool, bundle, personaId, trustedKeys, now: verifiedAt }));
    }
  }
  if (bindings.length !== plannedToolCount() || new Set(bindings.map((binding) => binding.tool_id)).size !== plannedToolCount()) {
    fail(`release formula evidence must contain exactly ${plannedToolCount()} unique bindings`);
  }
  return canonicalValue(bindings);
}

function buildDocument({ packsRoot, trustedFormulaReviewerKeys, verifiedAt }) {
  const verifiedDate = exactIso(verifiedAt, "formula-review evidence verified_at");
  let publicKeys;
  try { publicKeys = publicFormulaReviewKeyRegistry(trustedFormulaReviewerKeys); } catch (error) {
    fail(`trusted formula reviewer key registry is invalid: ${error.message}`);
  }
  const bindings = bindingsFromPacks({
    packsRoot,
    trustedKeys: publicKeys,
    verifiedAt: verifiedDate,
  });
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_release_formula_review_evidence",
    verified_at: verifiedDate.toISOString(),
    canonical_master_count: CANONICAL_MASTER_IDS.length,
    planned_tool_count: plannedToolCount(),
    trusted_formula_reviewer_keys: publicKeys,
    trusted_key_registry_hash: sha256(publicKeys),
    formula_binding_inventory_hash: sha256(bindings),
    verified_bindings: bindings,
  });
}

export function buildReleaseFormulaReviewEvidence({
  packsRoot,
  trustedFormulaReviewerKeys,
  verifiedAt,
} = {}) {
  if (trustedFormulaReviewerKeys === undefined || trustedFormulaReviewerKeys === null) {
    fail("trusted formula reviewer key registry is required for release assembly");
  }
  return Object.freeze(buildDocument({ packsRoot, trustedFormulaReviewerKeys, verifiedAt }));
}

function externallyTrustedFormulaRegistry(embedded, trustedFormulaReviewerKeys) {
  if (trustedFormulaReviewerKeys === undefined || trustedFormulaReviewerKeys === null) {
    fail("external trusted formula reviewer key registry is required");
  }
  let embeddedSnapshot;
  let externalSnapshot;
  try {
    embeddedSnapshot = publicFormulaReviewKeyRegistry(embedded);
    externalSnapshot = publicFormulaReviewKeyRegistry(trustedFormulaReviewerKeys);
  } catch (error) {
    fail(`trusted formula reviewer key registry is invalid: ${error.message}`);
  }
  const externalById = new Map(externalSnapshot.map((entry) => [entry.key_id, entry]));
  for (const entry of embeddedSnapshot) {
    const trusted = externalById.get(entry.key_id);
    if (!trusted || canonicalJson(trusted) !== canonicalJson(entry)) {
      fail(`embedded formula-review key ${entry.key_id} is not identical to the external trust registry`);
    }
  }
  return embeddedSnapshot;
}

export function verifyReleaseFormulaReviewEvidence({
  packsRoot,
  evidence,
  trustedFormulaReviewerKeys = parseTrustedFormulaReviewKeys(),
} = {}) {
  if (!isObject(evidence)) fail("formula-review evidence bundle must be an object");
  const actual = Object.keys(evidence).sort();
  const expected = [...EVIDENCE_FIELDS].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) fail("formula-review evidence bundle fields are invalid", { actual, expected });
  if (evidence.schema_version !== 1 || evidence.artifact_kind !== "persona_v3_release_formula_review_evidence") fail("formula-review evidence bundle header is invalid");
  if (evidence.canonical_master_count !== CANONICAL_MASTER_COUNT || evidence.planned_tool_count !== plannedToolCount()) fail("formula-review evidence coverage is not exact");
  for (const field of ["trusted_key_registry_hash", "formula_binding_inventory_hash"]) {
    if (!HASH.test(evidence[field] || "")) fail(`formula-review evidence ${field} is invalid`);
  }
  if (!Array.isArray(evidence.trusted_formula_reviewer_keys)
    || sha256(evidence.trusted_formula_reviewer_keys) !== evidence.trusted_key_registry_hash) {
    fail("formula-review evidence trusted key snapshot hash is invalid");
  }
  const externallyTrustedSnapshot = externallyTrustedFormulaRegistry(
    evidence.trusted_formula_reviewer_keys,
    trustedFormulaReviewerKeys,
  );
  const rebuilt = buildDocument({
    packsRoot,
    trustedFormulaReviewerKeys: externallyTrustedSnapshot,
    verifiedAt: evidence.verified_at,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(evidence)) fail("formula-review evidence no longer matches the 52 physical tool bindings");
  return Object.freeze(rebuilt);
}

export function releaseFormulaReviewEvidenceManifestEntry(evidence) {
  return canonicalValue({
    relative_path: RELEASE_FORMULA_EVIDENCE_FILE,
    evidence_hash: sha256(evidence),
    trusted_key_registry_hash: evidence.trusted_key_registry_hash,
    formula_binding_inventory_hash: evidence.formula_binding_inventory_hash,
    planned_tool_count: evidence.planned_tool_count,
  });
}
