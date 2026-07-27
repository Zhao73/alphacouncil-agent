/**
 * PersonaPack v3 staging factory and progress inventory.
 *
 * Staging is deliberately a different artifact type in a different tree. It never writes a
 * `manifest.json`, never declares maturity, and is never read by the production v3 registry.
 * Moving a seat into `knowledge/masters/` is a separate, explicit release operation whose
 * physical pack still has to pass the normal loader, admission and compile gates.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadPersonas, defaultPersonaDir } from "../personas/registry.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import { canDefineMethodRule, validateSourceAnchor } from "./source-anchor.mjs";
import { defaultKnowledgeDir } from "./admission.mjs";

export const CANONICAL_MASTER_COUNT = 26;
export const CANONICAL_MASTER_IDS = Object.freeze([
  "master_aschenbrenner",
  "master_buffett",
  "master_graham",
  "master_simons",
  "master_soros",
  "master_cathie_wood",
  "master_druckenmiller",
  "master_fisher",
  "master_munger",
  "master_thorp",
  "master_asness",
  "master_dalio",
  "master_duan_yongping",
  "master_jhunjhunwala",
  "master_lynch",
  "master_forensic_short",
  "master_li_lu",
  "master_marks",
  "master_burry",
  "master_klarman",
  "master_pabrai",
  "master_ackman",
  "master_damodaran",
  "master_taleb",
  "master_natenberg",
  "master_sinclair",
]);

export const STAGING_COMPONENTS = Object.freeze([
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
  "voice_en",
  "voice_zh",
]);

const COMPONENT_STATES = new Set(["not_started", "draft", "in_review", "reviewed", "blocked"]);
const HASH = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[a-z0-9_]{2,48}$/u;
const INDEX_FILE = "staging-index.json";
const SCAFFOLD_FILE = "scaffold.json";
const QUEUE_FILE = "source-adjudication-queue.json";
const TEMPLATE_DIR = "_templates";

export class PersonaStagingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaStagingError";
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new PersonaStagingError(message, details);
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

function disjointRoots(stagingRoot, productionRoot) {
  const staging = resolve(stagingRoot);
  const production = resolve(productionRoot);
  return !inside(staging, production) && !inside(production, staging);
}

function prospectivePhysicalPath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) fail(`cannot resolve an existing ancestor for ${path}`);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function assertSafeRoot(stagingRoot, productionRoot, { create = false } = {}) {
  if (!nonEmpty(stagingRoot)) fail("staging root is required");
  if (!nonEmpty(productionRoot)) fail("production knowledge root is required");
  if (!disjointRoots(stagingRoot, productionRoot)) {
    fail("staging and production roots must be physically disjoint", { stagingRoot, productionRoot });
  }
  const physicalStagingTarget = prospectivePhysicalPath(stagingRoot);
  const physicalProductionTarget = prospectivePhysicalPath(productionRoot);
  if (!disjointRoots(physicalStagingTarget, physicalProductionTarget)) {
    fail("staging resolves into the production knowledge tree", { stagingRoot, productionRoot });
  }
  if (existsSync(stagingRoot) && lstatSync(stagingRoot).isSymbolicLink()) {
    fail("staging root must not be a symlink", { stagingRoot });
  }
  if (create && !existsSync(stagingRoot)) mkdirSync(stagingRoot, { recursive: true });
  return resolve(stagingRoot);
}

function parseJson(file, label = file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label}: invalid JSON (${error.message})`, { file });
  }
}

function titleOf(persona) {
  const title = isObject(persona.title) ? persona.title : {};
  return {
    en: nonEmpty(title.en) ? title.en : persona.id,
    zh: nonEmpty(title.zh) ? title.zh : persona.id,
  };
}

export function canonicalMasterBlueprints({ personaDir = defaultPersonaDir() } = {}) {
  const registry = loadPersonas({ dir: personaDir });
  const actual = registry.ids("master");
  const expectedSet = new Set(CANONICAL_MASTER_IDS);
  const missing = CANONICAL_MASTER_IDS.filter((id) => !actual.includes(id));
  const extra = actual.filter((id) => !expectedSet.has(id));
  if (actual.length !== CANONICAL_MASTER_COUNT || missing.length || extra.length) {
    fail(`canonical master roster mismatch: expected exactly ${CANONICAL_MASTER_COUNT}`, {
      expected: CANONICAL_MASTER_IDS,
      actual,
      missing,
      extra,
    });
  }
  return Object.freeze(CANONICAL_MASTER_IDS.map((id) => {
    const persona = registry.get(id);
    return Object.freeze(canonicalValue({
      persona_id: id,
      canonical_prompt_file: persona.file,
      canonical_title: titleOf(persona),
    }));
  }));
}

function componentPlan() {
  return STAGING_COMPONENTS.map((component) => ({
    component,
    status: "not_started",
    artifact_hash: null,
    reviewer_ids: [],
    reviewed_at: null,
    notes: "",
  }));
}

export function createScaffoldDocument(blueprint) {
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_staging_scaffold",
    persona_id: blueprint.persona_id,
    canonical_prompt_file: blueprint.canonical_prompt_file,
    canonical_title: blueprint.canonical_title,
    target_release: "0.9.0",
    target_pack_schema_version: 3,
    source_adjudication_queue: QUEUE_FILE,
    target_contracts: {
      manifest: "schemas/persona-v3.schema.json",
      source_anchor: "schemas/source-anchor-v1.schema.json",
      decision_policy: "schemas/persona-v3-decision-policy-v1.schema.json",
      tool_graph: "schemas/persona-v3-tool-graph-v1.schema.json",
      experiment_results: "schemas/persona-v3-experiments-v1.schema.json",
    },
    component_plan: componentPlan(),
    production_guard: {
      production_eligible: false,
      production_manifest_allowed: false,
      registry_registration_allowed: false,
      promotion_status: "blocked_pending_explicit_release_review",
      release_approvals: [],
    },
  });
}

export function createSourceQueueDocument(personaId) {
  if (!ID.test(personaId || "")) fail(`invalid persona id ${JSON.stringify(personaId)}`);
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "source_adjudication_queue",
    persona_id: personaId,
    records: [],
  });
}

export function createStagingIndex(blueprints) {
  const entries = blueprints.map((blueprint) => ({
    persona_id: blueprint.persona_id,
    scaffold: `${blueprint.persona_id}/${SCAFFOLD_FILE}`,
    source_adjudication_queue: `${blueprint.persona_id}/${QUEUE_FILE}`,
  }));
  const registryPayload = {
    canonical_master_count: entries.length,
    canonical_prompt_files: blueprints.map(({ persona_id, canonical_prompt_file }) => ({ persona_id, canonical_prompt_file })),
  };
  return canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_staging_index",
    target_release: "0.9.0",
    canonical_master_count: CANONICAL_MASTER_COUNT,
    production_loader_root: "knowledge/masters",
    staging_loader_registered: false,
    promotion_mode: "explicit_release_review_only",
    canonical_registry_hash: sha256(registryPayload),
    personas: entries,
  });
}

function sourceRecordTemplate() {
  return canonicalValue({
    template_only: true,
    warning: "This is not a source citation. Replace every placeholder and validate before appending a record to a persona queue.",
    required_schema: "schemas/source-anchor-v1.schema.json",
    record_shape: {
      schema_version: 1,
      source_id: "REPLACE",
      source_kind: "REPLACE_WITH_ALLOWED_KIND",
      grade: "REPLACE_WITH_A_TO_E",
      author: "REPLACE",
      title: "REPLACE",
      url: "REPLACE_WITH_PRIMARY_URL",
      published_at: "REPLACE_WITH_DATE_OR_TIMESTAMP",
      public_at: "REPLACE_WITH_DATE_OR_TIMESTAMP",
      known_at: null,
      retrieved_at: "REPLACE_WITH_DATE_OR_TIMESTAMP",
      locator: { section: "REPLACE_WITH_EXACT_LOCATOR" },
      summary: "REPLACE_WITH_A_PARAPHRASED_METHOD_CLAIM",
      content_hash: "REPLACE_WITH_SHA256_OF_RETRIEVED_CONTENT",
      supports: [],
      adjudication: {
        status: "pending",
        reviewer_ids: [],
        reviewed_at: null,
        notes: "",
      },
    },
  });
}

function reviewChecklist() {
  return [
    "# PersonaPack v3 staging review checklist",
    "",
    "Staging records are evidence work-in-progress. They are not production packs and cannot declare maturity.",
    "",
    "For every proposed source:",
    "",
    "- Retrieve the actual primary document; do not cite a search result or unsourced summary.",
    "- Record publication, public-availability and retrieval dates separately.",
    "- Add a precise page, chapter, section, timestamp or filing-item locator.",
    "- Hash the retrieved content and reject duplicate content under different URLs.",
    "- Keep adjudication `pending` until a human has inspected the source.",
    "- A source may define a named method rule only after two independent reviewers approve A/B primary material.",
    "- Reviewer IDs and dates record real completed reviews; never prefill them.",
    "",
    "Promotion remains a separate release action. Do not add `manifest.json` anywhere under this staging tree.",
    "",
  ].join("\n");
}

function writeNew(file, content, created, existing) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    existing.push(file);
    return;
  }
  writeFileSync(file, content, { encoding: "utf8", flag: "wx" });
  created.push(file);
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function scaffoldPersonaV3Staging({
  root = defaultStagingRoot(),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
} = {}) {
  const stagingRoot = assertSafeRoot(root, productionRoot, { create: true });
  const blueprints = canonicalMasterBlueprints({ personaDir });
  const created = [];
  const existing = [];
  writeNew(join(stagingRoot, INDEX_FILE), prettyJson(createStagingIndex(blueprints)), created, existing);
  writeNew(join(stagingRoot, TEMPLATE_DIR, "source-adjudication-record.template.json"), prettyJson(sourceRecordTemplate()), created, existing);
  writeNew(join(stagingRoot, TEMPLATE_DIR, "human-review-checklist.md"), reviewChecklist(), created, existing);
  for (const blueprint of blueprints) {
    const packDir = join(stagingRoot, blueprint.persona_id);
    if (existsSync(packDir) && lstatSync(packDir).isSymbolicLink()) fail(`${blueprint.persona_id}: staging seat must not be a symlink`);
    writeNew(join(packDir, SCAFFOLD_FILE), prettyJson(createScaffoldDocument(blueprint)), created, existing);
    writeNew(join(packDir, QUEUE_FILE), prettyJson(createSourceQueueDocument(blueprint.persona_id)), created, existing);
  }
  return Object.freeze({
    staging_root: stagingRoot,
    canonical_master_count: blueprints.length,
    created: Object.freeze(created.map((file) => relative(stagingRoot, file))),
    existing: Object.freeze(existing.map((file) => relative(stagingRoot, file))),
  });
}

function exactKeys(value, expected, label, errors) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  for (const key of expected) if (!(key in value)) errors.push(`${label}.${key} is required`);
}

function validateComponentPlan(plan, errors) {
  if (!Array.isArray(plan)) {
    errors.push("component_plan must be an array");
    return { started: 0, reviewed: 0, blocked: 0 };
  }
  const seen = new Set();
  let started = 0;
  let reviewed = 0;
  let blocked = 0;
  for (const [index, item] of plan.entries()) {
    const label = `component_plan[${index}]`;
    exactKeys(item, ["component", "status", "artifact_hash", "reviewer_ids", "reviewed_at", "notes"], label, errors);
    if (!isObject(item)) continue;
    if (!STAGING_COMPONENTS.includes(item.component)) errors.push(`${label}.component is unknown`);
    if (seen.has(item.component)) errors.push(`${label}.component is duplicated`);
    seen.add(item.component);
    if (!COMPONENT_STATES.has(item.status)) errors.push(`${label}.status is invalid`);
    if (item.status !== "not_started") started += 1;
    if (item.status === "blocked") blocked += 1;
    if (!Array.isArray(item.reviewer_ids) || item.reviewer_ids.some((id) => !nonEmpty(id))) {
      errors.push(`${label}.reviewer_ids must contain only non-empty strings`);
    }
    const reviewerIds = Array.isArray(item.reviewer_ids)
      ? item.reviewer_ids.map((id) => String(id).normalize("NFKC").trim()) : [];
    if (new Set(reviewerIds).size !== reviewerIds.length) errors.push(`${label}.reviewer_ids contains duplicates after normalization`);
    if (item.status === "reviewed") {
      reviewed += 1;
      if (!HASH.test(item.artifact_hash || "")) errors.push(`${label}.reviewed requires artifact_hash`);
      if (reviewerIds.length < 2) errors.push(`${label}.reviewed requires two independent reviewer IDs`);
      if (!Number.isFinite(Date.parse(item.reviewed_at))) errors.push(`${label}.reviewed requires reviewed_at`);
    } else {
      if (item.artifact_hash !== null) errors.push(`${label}.artifact_hash must remain null before reviewed`);
      if (item.reviewed_at !== null) errors.push(`${label}.reviewed_at must remain null before reviewed`);
    }
    if (typeof item.notes !== "string") errors.push(`${label}.notes must be a string`);
  }
  for (const component of STAGING_COMPONENTS) if (!seen.has(component)) errors.push(`component_plan is missing ${component}`);
  return { started, reviewed, blocked };
}

function validateScaffold(scaffold, blueprint) {
  const errors = [];
  exactKeys(scaffold, [
    "schema_version", "artifact_kind", "persona_id", "canonical_prompt_file", "canonical_title",
    "target_release", "target_pack_schema_version", "source_adjudication_queue", "target_contracts",
    "component_plan", "production_guard",
  ], "scaffold", errors);
  if (!isObject(scaffold)) return { errors, component_progress: { started: 0, reviewed: 0, blocked: 0 } };
  if (scaffold.schema_version !== 1) errors.push("scaffold.schema_version must be 1");
  if (scaffold.artifact_kind !== "persona_v3_staging_scaffold") errors.push("scaffold.artifact_kind is invalid");
  if (scaffold.persona_id !== blueprint.persona_id) errors.push("scaffold.persona_id does not match canonical seat");
  if (scaffold.canonical_prompt_file !== blueprint.canonical_prompt_file) errors.push("scaffold.canonical_prompt_file drifted from registry");
  if (!isObject(scaffold.canonical_title)
    || canonicalJson(scaffold.canonical_title) !== canonicalJson(blueprint.canonical_title)) {
    errors.push("scaffold.canonical_title drifted from registry");
  }
  if (scaffold.target_release !== "0.9.0") errors.push("scaffold.target_release must be 0.9.0");
  if (scaffold.target_pack_schema_version !== 3) errors.push("scaffold.target_pack_schema_version must be 3");
  if (scaffold.source_adjudication_queue !== QUEUE_FILE) errors.push(`scaffold.source_adjudication_queue must be ${QUEUE_FILE}`);
  const expectedContracts = createScaffoldDocument(blueprint).target_contracts;
  if (!isObject(scaffold.target_contracts)
    || canonicalJson(scaffold.target_contracts) !== canonicalJson(expectedContracts)) {
    errors.push("scaffold.target_contracts drifted from canonical schemas");
  }
  const guard = scaffold.production_guard;
  exactKeys(guard, [
    "production_eligible", "production_manifest_allowed", "registry_registration_allowed",
    "promotion_status", "release_approvals",
  ], "scaffold.production_guard", errors);
  if (isObject(guard)) {
    if (guard.production_eligible !== false) errors.push("staging production_eligible must remain false");
    if (guard.production_manifest_allowed !== false) errors.push("staging production_manifest_allowed must remain false");
    if (guard.registry_registration_allowed !== false) errors.push("staging registry_registration_allowed must remain false");
    if (guard.promotion_status !== "blocked_pending_explicit_release_review") errors.push("staging promotion_status must remain blocked");
    if (!Array.isArray(guard.release_approvals) || guard.release_approvals.length !== 0) errors.push("staging must not claim release approvals");
  }
  return { errors, component_progress: validateComponentPlan(scaffold.component_plan, errors) };
}

function validateQueue(queue, personaId) {
  const errors = [];
  exactKeys(queue, ["schema_version", "artifact_kind", "persona_id", "records"], "source queue", errors);
  if (!isObject(queue)) return { errors, counts: { total: 0, pending: 0, approved: 0, rejected: 0, method_defining: 0 } };
  if (queue.schema_version !== 1) errors.push("source queue.schema_version must be 1");
  if (queue.artifact_kind !== "source_adjudication_queue") errors.push("source queue.artifact_kind is invalid");
  if (queue.persona_id !== personaId) errors.push("source queue.persona_id does not match seat");
  if (!Array.isArray(queue.records)) errors.push("source queue.records must be an array");
  const records = Array.isArray(queue.records) ? queue.records : [];
  const ids = new Set();
  const hashes = new Set();
  const counts = { total: records.length, pending: 0, approved: 0, rejected: 0, method_defining: 0 };
  for (const [index, record] of records.entries()) {
    const recordErrors = validateSourceAnchor(record, { file: `source queue.records[${index}]` });
    let duplicate = false;
    if (nonEmpty(record?.source_id)) {
      if (ids.has(record.source_id)) {
        errors.push(`source queue.records[${index}]: duplicate source_id`);
        duplicate = true;
      }
      ids.add(record.source_id);
    }
    if (nonEmpty(record?.content_hash)) {
      if (hashes.has(record.content_hash)) {
        errors.push(`source queue.records[${index}]: duplicate content_hash is not independent evidence`);
        duplicate = true;
      }
      hashes.add(record.content_hash);
    }
    errors.push(...recordErrors);
    if (recordErrors.length || duplicate) continue;
    if (["pending", "approved", "rejected"].includes(record?.adjudication?.status)) counts[record.adjudication.status] += 1;
    if (canDefineMethodRule(record)) counts.method_defining += 1;
  }
  return { errors, counts };
}

function findUnsafeManifest(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      out.push({ type: "symlink", file });
      continue;
    }
    if (entry.isDirectory()) findUnsafeManifest(file, out);
    else if (entry.name === "manifest.json") out.push({ type: "production_manifest", file });
  }
  return out;
}

function stagingPhase(sourceCounts, componentProgress) {
  if (componentProgress.reviewed === STAGING_COMPONENTS.length
    && sourceCounts.approved > 0 && sourceCounts.pending === 0 && sourceCounts.rejected === 0) {
    return "release_review_pending";
  }
  if (componentProgress.started > 0) return "content_build";
  if (sourceCounts.total > 0) return sourceCounts.pending > 0 ? "source_adjudication" : "source_collection";
  return "scaffolded";
}

export function defaultStagingRoot() {
  return process.env.ALPHACOUNCIL_PERSONA_STAGING_DIR
    || fileURLToPath(new URL("../../../knowledge/staging/personas-v3/", import.meta.url));
}

export function inspectPersonaV3Staging({
  root = defaultStagingRoot(),
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  now = new Date(),
} = {}) {
  const stagingRoot = assertSafeRoot(root, productionRoot);
  const blueprints = canonicalMasterBlueprints({ personaDir });
  const globalErrors = [];
  if (!existsSync(stagingRoot)) fail(`staging root is missing: ${stagingRoot}`);

  const unsafe = findUnsafeManifest(stagingRoot);
  for (const item of unsafe) globalErrors.push(`${relative(stagingRoot, item.file)}: ${item.type} is forbidden in staging`);

  const indexFile = join(stagingRoot, INDEX_FILE);
  if (!existsSync(indexFile)) globalErrors.push(`${INDEX_FILE} is missing`);
  else {
    const actualIndex = parseJson(indexFile, INDEX_FILE);
    const expectedIndex = createStagingIndex(blueprints);
    if (canonicalJson(actualIndex) !== canonicalJson(expectedIndex)) globalErrors.push(`${INDEX_FILE} does not match the canonical 26-seat registry`);
  }

  const expectedIds = new Set(CANONICAL_MASTER_IDS);
  const extraSeatDirs = readdirSync(stagingRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== TEMPLATE_DIR && !expectedIds.has(entry.name))
    .map((entry) => entry.name);
  if (extraSeatDirs.length) globalErrors.push(`unexpected staging seat directories: ${extraSeatDirs.join(", ")}`);

  const personas = blueprints.map((blueprint) => {
    const errors = [];
    const packDir = join(stagingRoot, blueprint.persona_id);
    if (!existsSync(packDir) || !statSync(packDir).isDirectory()) {
      errors.push("staging seat directory is missing");
      return {
        persona_id: blueprint.persona_id,
        phase: "missing",
        production_eligible: false,
        source_counts: { total: 0, pending: 0, approved: 0, rejected: 0, method_defining: 0 },
        component_progress: { total: STAGING_COMPONENTS.length, started: 0, reviewed: 0, blocked: 0 },
        errors,
      };
    }
    if (lstatSync(packDir).isSymbolicLink()) {
      errors.push("staging seat directory must not be a symlink");
      return {
        persona_id: blueprint.persona_id,
        phase: "invalid",
        production_eligible: false,
        source_counts: { total: 0, pending: 0, approved: 0, rejected: 0, method_defining: 0 },
        component_progress: { total: STAGING_COMPONENTS.length, started: 0, reviewed: 0, blocked: 0 },
        errors,
      };
    }
    const scaffoldFile = join(packDir, SCAFFOLD_FILE);
    const queueFile = join(packDir, QUEUE_FILE);
    let componentProgress = { started: 0, reviewed: 0, blocked: 0 };
    let sourceCounts = { total: 0, pending: 0, approved: 0, rejected: 0, method_defining: 0 };
    if (!existsSync(scaffoldFile)) errors.push(`${SCAFFOLD_FILE} is missing`);
    else {
      const validation = validateScaffold(parseJson(scaffoldFile, `${blueprint.persona_id}/${SCAFFOLD_FILE}`), blueprint);
      errors.push(...validation.errors);
      componentProgress = validation.component_progress;
    }
    if (!existsSync(queueFile)) errors.push(`${QUEUE_FILE} is missing`);
    else {
      const validation = validateQueue(parseJson(queueFile, `${blueprint.persona_id}/${QUEUE_FILE}`), blueprint.persona_id);
      errors.push(...validation.errors);
      sourceCounts = validation.counts;
    }
    return canonicalValue({
      persona_id: blueprint.persona_id,
      phase: errors.length ? "invalid" : stagingPhase(sourceCounts, componentProgress),
      production_eligible: false,
      source_counts: sourceCounts,
      component_progress: { total: STAGING_COMPONENTS.length, ...componentProgress },
      errors,
    });
  });

  const phases = {};
  for (const persona of personas) phases[persona.phase] = (phases[persona.phase] || 0) + 1;
  const invalidCount = personas.filter((persona) => persona.errors.length).length;
  const stablePayload = canonicalValue({
    schema_version: 1,
    canonical_master_count: blueprints.length,
    physical_v3_pack_count: 0,
    production_eligible_count: 0,
    invalid_count: invalidCount,
    unsafe_artifact_count: unsafe.length,
    phases,
    global_errors: globalErrors,
    personas,
  });
  return Object.freeze({
    staging_root: stagingRoot,
    production_root: resolve(productionRoot),
    ...stablePayload,
    generated_at: now.toISOString(),
    staging_inventory_hash: sha256(stablePayload),
  });
}
