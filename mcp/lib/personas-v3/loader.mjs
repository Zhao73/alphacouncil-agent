import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canDefineMethodRule, inclusiveCutoffTime, validateSourceAnchor } from "./source-anchor.mjs";
import { canonicalValue, portableRelativePath } from "./canonical.mjs";
import { validateExperimentDocument } from "./admission.mjs";
import { validateDeterministicPolicyArtifacts } from "./deterministic-executor.mjs";
import { resolveActivePersonaKnowledgeDir } from "./production-root.mjs";

const ID = /^[a-z0-9_]{2,48}$/;
const MATURITIES = new Set(["operator_lens", "candidate", "method_model"]);
const BUILD_PROFILES = new Set(["production", "solo_test"]);
const ABLATIONS = new Set(["name", "voice", "policy", "evidence", "memory", "model"]);
const COMPONENTS = Object.freeze([
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
const COLLECTIONS = new Set([
  "sources",
  "doctrine",
  "decision_cases",
  "failures",
  "counterfactuals",
  "golden_cases",
  "pairwise_cases",
  "calibration_cases",
]);

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export class PersonaV3LoadError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaV3LoadError";
    this.details = details;
  }
}

export function defaultKnowledgeDir() {
  return resolveActivePersonaKnowledgeDir();
}

function fail(message, details = {}) {
  throw new PersonaV3LoadError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(file, label = file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label}: invalid JSON (${error.message})`, { file });
  }
}

function parseJsonl(file, label = file) {
  const records = [];
  const text = readFileSync(file, "utf8");
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      fail(`${label}:${index + 1}: invalid JSON (${error.message})`, { file, line: index + 1 });
    }
    if (!isObject(value)) fail(`${label}:${index + 1}: every JSONL line must be an object`, { file, line: index + 1 });
    records.push(value);
  }
  return records;
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function physicalComponent(packDir, relativePath, label) {
  if (typeof relativePath !== "string" || !relativePath.trim()) fail(`${label}: path is required`);
  if (isAbsolute(relativePath)) fail(`${label}: absolute paths are forbidden`);
  const base = realpathSync(packDir);
  const unresolved = resolve(base, relativePath);
  if (!inside(base, unresolved) || !existsSync(unresolved)) fail(`${label}: missing or escaping component ${JSON.stringify(relativePath)}`);
  const file = realpathSync(unresolved);
  if (!inside(base, file)) fail(`${label}: symlink escapes the pack directory`);
  if (!statSync(file).isFile()) fail(`${label}: component must be a file`);
  return file;
}

function localized(value, label, errors, required = ["en", "zh"]) {
  if (!isObject(value) || required.some((key) => !value[key]?.trim())) {
    errors.push(`${label} must contain non-empty ${required.join(", ")} strings`);
  }
}

function validateManifest(manifest, packDir) {
  const errors = [];
  if (!isObject(manifest)) return ["manifest must be an object"];
  if (manifest.schema_version !== 3) errors.push(`schema_version must be 3, got ${JSON.stringify(manifest.schema_version)}`);
  if (manifest.build_profile !== undefined && !BUILD_PROFILES.has(manifest.build_profile)) {
    errors.push("build_profile must be production or solo_test when present");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.pack_version || "")) {
    errors.push("pack_version must be a semantic version, optionally with a prerelease suffix");
  }
  const identity = manifest.identity;
  const selectorLocales = manifest.build_profile === "solo_test" ? ["en", "zh", "ja", "ko"] : ["en", "zh"];
  if (!isObject(identity) || !ID.test(identity.persona_id || "")) errors.push("identity.persona_id is invalid");
  else if (basename(resolve(packDir)) !== identity.persona_id) errors.push(`pack directory must be named ${identity.persona_id}`);
  localized(identity?.public_label, "identity.public_label", errors, selectorLocales);
  localized(identity?.operator_label, "identity.operator_label", errors, selectorLocales);
  if (!MATURITIES.has(identity?.maturity)) errors.push("identity.maturity is invalid (and remains advisory even when valid)");
  if (!Number.isFinite(inclusiveCutoffTime(identity?.source_cutoff))) errors.push("identity.source_cutoff is invalid");
  localized(manifest.selection?.identity, "selection.identity", errors, selectorLocales);
  localized(manifest.selection?.method, "selection.method", errors, selectorLocales);
  localized(manifest.selection?.best_for, "selection.best_for", errors, selectorLocales);
  if (!Array.isArray(manifest.capability?.domains) || !manifest.capability.domains.length) errors.push("capability.domains is required");
  const requiredFacts = manifest.capability?.required_fact_types;
  const optionalFacts = manifest.capability?.optional_fact_types;
  if (!Array.isArray(requiredFacts) || requiredFacts.some((id) => typeof id !== "string" || !id.trim())) errors.push("capability.required_fact_types must be a string array");
  if (!Array.isArray(optionalFacts) || optionalFacts.some((id) => typeof id !== "string" || !id.trim())) errors.push("capability.optional_fact_types must be a string array");
  if (Array.isArray(requiredFacts) && Array.isArray(optionalFacts)) {
    if (!requiredFacts.length && !optionalFacts.length) errors.push("capability required and optional fact types cannot both be empty");
    if (new Set(requiredFacts).size !== requiredFacts.length) errors.push("capability.required_fact_types contains duplicates");
    if (new Set(optionalFacts).size !== optionalFacts.length) errors.push("capability.optional_fact_types contains duplicates");
    const overlap = requiredFacts.filter((id) => optionalFacts.includes(id));
    if (overlap.length) errors.push(`capability required and optional fact types overlap: ${overlap.join(", ")}`);
  }
  if (!manifest.capability?.native_decision_schema?.trim()) errors.push("capability.native_decision_schema is required");
  if (!manifest.research?.planner?.trim()) errors.push("research.planner is required");
  if (!Array.isArray(manifest.research?.mandatory_disconfirming_queries) || !manifest.research.mandatory_disconfirming_queries.length) errors.push("research.mandatory_disconfirming_queries is required");
  if (manifest.computation?.dsl_version !== "1.1") errors.push("computation.dsl_version must be 1.1");
  if (!Array.isArray(manifest.computation?.pipeline) || !manifest.computation.pipeline.length) errors.push("computation.pipeline is required");
  if (manifest.decision?.abstention_policy !== "fail_closed") errors.push("decision.abstention_policy must be fail_closed");
  if (manifest.memory?.leak_rule !== "public_at <= as_of AND memory_created_at <= as_of") errors.push("memory.leak_rule must carry both time clauses");
  if (manifest.voice?.load_after_decision_freeze !== true) errors.push("voice must load after decision freeze");
  const ablations = new Set(manifest.evaluation?.required_ablations || []);
  for (const required of ABLATIONS) if (!ablations.has(required)) errors.push(`evaluation.required_ablations is missing ${required}`);
  for (const name of COMPONENTS) if (!manifest.components?.[name]) errors.push(`components.${name} is required`);
  if (!manifest.voice?.en || !manifest.voice?.zh) errors.push("voice.en and voice.zh paths are required");
  return errors;
}

function soloTestProxyCanDefine(anchor) {
  return validateSourceAnchor(anchor).length === 0
    && ["derived_proxy", "editorial_choice"].includes(anchor.source_kind)
    && ["D", "E"].includes(anchor.grade)
    && anchor.adjudication?.status === "pending"
    && Array.isArray(anchor.adjudication?.reviewer_ids)
    && anchor.adjudication.reviewer_ids.length === 0
    && anchor.adjudication.reviewed_at === undefined;
}

function validateCitations(records, sources, label, {
  defining = false,
  definingSource = canDefineMethodRule,
} = {}) {
  const byId = new Map(sources.map((source) => [source.source_id, source]));
  const errors = [];
  for (const [index, record] of records.entries()) {
    if (!Array.isArray(record.source_ids) || !record.source_ids.length) {
      errors.push(`${label}[${index}] has no source_ids`);
      continue;
    }
    for (const id of record.source_ids) if (!byId.has(id)) errors.push(`${label}[${index}] cites unknown source ${JSON.stringify(id)}`);
    if (defining && !record.source_ids.some((id) => definingSource(byId.get(id)))) {
      errors.push(`${label}[${index}] has no source eligible for this build profile`);
    }
  }
  return errors;
}

function loadV3PackForProfile(packDir, expectedBuildProfile) {
  if (!existsSync(packDir) || !statSync(packDir).isDirectory()) fail(`PersonaPack directory is missing: ${packDir}`);
  const manifestFile = physicalComponent(packDir, "manifest.json", "manifest.json");
  const manifest = parseJson(manifestFile, "manifest.json");
  const manifestErrors = validateManifest(manifest, packDir);
  const declaredBuildProfile = manifest.build_profile || "production";
  if (declaredBuildProfile !== expectedBuildProfile) {
    manifestErrors.push(expectedBuildProfile === "solo_test"
      ? "manifest build_profile must be solo_test for the provisional loader"
      : "solo_test packs require the explicit provisional loader and are forbidden in production");
  }
  if (manifestErrors.length) fail(`invalid PersonaPack v3 manifest:\n- ${manifestErrors.join("\n- ")}`, { packDir });

  const files = {};
  const components = {};
  for (const name of COMPONENTS) {
    files[name] = physicalComponent(packDir, manifest.components[name], `components.${name}`);
    components[name] = COLLECTIONS.has(name)
      ? parseJsonl(files[name], `components.${name}`)
      : parseJson(files[name], `components.${name}`);
  }
  files.voice_en = physicalComponent(packDir, manifest.voice.en, "voice.en");
  files.voice_zh = physicalComponent(packDir, manifest.voice.zh, "voice.zh");
  const voice = {
    en: readFileSync(files.voice_en, "utf8").trim(),
    zh: readFileSync(files.voice_zh, "utf8").trim(),
  };
  if (!voice.en || !voice.zh) fail("voice files must be non-empty");

  const sourceErrors = [];
  const ids = new Set();
  const sourceCutoff = inclusiveCutoffTime(manifest.identity.source_cutoff);
  for (const [index, source] of components.sources.entries()) {
    sourceErrors.push(...validateSourceAnchor(source, { file: `sources[${index}]` }));
    if (ids.has(source.source_id)) sourceErrors.push(`sources[${index}]: duplicate source_id ${JSON.stringify(source.source_id)}`);
    ids.add(source.source_id);
    const publicAt = Date.parse(source.public_at);
    const knownAt = source.known_at === undefined || source.known_at === null
      ? publicAt : Date.parse(source.known_at);
    if (Number.isFinite(publicAt) && publicAt > sourceCutoff) {
      sourceErrors.push(`sources[${index}]: public_at exceeds identity.source_cutoff`);
    }
    if (Number.isFinite(knownAt) && knownAt > sourceCutoff) {
      sourceErrors.push(`sources[${index}]: known_at exceeds identity.source_cutoff`);
    }
    if (declaredBuildProfile === "solo_test" && !soloTestProxyCanDefine(source)) {
      sourceErrors.push(`sources[${index}]: solo_test sources must be unreviewed D/E derived_proxy or editorial_choice anchors`);
    }
  }
  const definingSource = declaredBuildProfile === "solo_test"
    ? soloTestProxyCanDefine : canDefineMethodRule;
  sourceErrors.push(...validateCitations(components.doctrine, components.sources, "doctrine", {
    defining: true,
    definingSource,
  }));
  const vetoes = Array.isArray(components.decision_policy?.hard_vetoes)
    ? components.decision_policy.hard_vetoes : [];
  sourceErrors.push(...validateCitations(vetoes, components.sources, "decision_policy.hard_vetoes", {
    defining: true,
    definingSource,
  }));
  sourceErrors.push(...validateCitations(
    Array.isArray(components.decision_policy?.eligibility?.all)
      ? components.decision_policy.eligibility.all : [],
    components.sources,
    "decision_policy.eligibility.all",
    { defining: true, definingSource },
  ));
  sourceErrors.push(...validateCitations(
    Array.isArray(components.decision_policy?.scoring?.rules)
      ? components.decision_policy.scoring.rules : [],
    components.sources,
    "decision_policy.scoring.rules",
    { defining: true, definingSource },
  ));
  sourceErrors.push(...validateCitations(components.tools, components.sources, "tools", {
    defining: true,
    definingSource,
  }));
  sourceErrors.push(...validateDeterministicPolicyArtifacts({
    policy: components.decision_policy,
    tools: components.tools,
    requiredFactTypes: manifest.capability.required_fact_types,
    optionalFactTypes: manifest.capability.optional_fact_types,
    pipeline: manifest.computation.pipeline,
    dslVersion: manifest.computation.dsl_version,
    nativeDecisionSchema: manifest.capability.native_decision_schema,
  }));
  sourceErrors.push(...validateExperimentDocument(components.experiments, {
    personaId: manifest.identity.persona_id,
  }));
  if (components.decision_policy?.abstention_policy !== "fail_closed") sourceErrors.push("decision_policy.abstention_policy must be fail_closed");
  if (components.memory_policy?.leak_rule !== "public_at <= as_of AND memory_created_at <= as_of") sourceErrors.push("memory_policy.leak_rule must carry both time clauses");
  if (components.decision_policy?.native_decision_schema !== manifest.capability.native_decision_schema) sourceErrors.push("decision_policy.native_decision_schema must match manifest capability");
  if (sourceErrors.length) fail(`invalid PersonaPack v3 corpus:\n- ${sourceErrors.join("\n- ")}`, { packDir });

  const snapshot = canonicalValue({
    pack_dir: realpathSync(packDir),
    manifest_file: realpathSync(manifestFile),
    manifest,
    components,
    voice,
    component_files: Object.fromEntries(Object.entries(files)
      .map(([key, file]) => [key, portableRelativePath(realpathSync(packDir), file)])),
  });
  return deepFreeze(snapshot);
}

/** Load a production-eligible schema-v3 pack. A solo_test manifest is always rejected. */
export function loadV3Pack(packDir) {
  return loadV3PackForProfile(packDir, "production");
}

/**
 * Load an explicitly provisional physical pack for a one-principal test build.
 *
 * This path accepts only pending D/E project-derived anchors with no reviewers. It therefore
 * cannot turn a model-generated claim into a source approval, and normal admission continues
 * to count every such anchor/rule/tool as ineligible for operational or higher maturity.
 */
export function loadSoloTestV3Pack(packDir) {
  return loadV3PackForProfile(packDir, "solo_test");
}

export function loadV3Packs({ dir = defaultKnowledgeDir() } = {}) {
  if (!existsSync(dir)) {
    return Object.freeze({
      packs: Object.freeze([]),
      legacy_ids: Object.freeze([]),
      get: () => undefined,
    });
  }
  const packs = [];
  const legacyIds = [];
  for (const entry of readdirSync(dir).sort()) {
    const packDir = join(dir, entry);
    if (!statSync(packDir).isDirectory()) continue;
    const unresolvedManifest = join(packDir, "manifest.json");
    if (!existsSync(unresolvedManifest)) continue;
    const manifestFile = physicalComponent(packDir, "manifest.json", `${entry}/manifest.json`);
    const manifest = parseJson(manifestFile, `${entry}/manifest.json`);
    if (manifest.schema_version !== 3) { legacyIds.push(entry); continue; }
    packs.push(loadV3Pack(packDir));
  }
  const byId = new Map(packs.map((pack) => [pack.manifest.identity.persona_id, pack]));
  if (byId.size !== packs.length) fail("duplicate PersonaPack v3 persona_id across directories");
  return Object.freeze({
    packs: Object.freeze([...packs]),
    legacy_ids: Object.freeze(legacyIds),
    get: (id) => byId.get(id),
  });
}

/** Load only explicit solo_test packs from an isolated root. */
export function loadSoloTestV3Packs({ dir } = {}) {
  if (!dir) fail("solo_test pack root is required");
  if (!existsSync(dir)) {
    return Object.freeze({
      packs: Object.freeze([]),
      legacy_ids: Object.freeze([]),
      get: () => undefined,
    });
  }
  const rootStat = lstatSync(dir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail("solo_test pack root must be a plain directory");
  }
  const root = realpathSync(dir);
  const packs = [];
  for (const entry of readdirSync(root).sort()) {
    const packDir = join(root, entry);
    const entryStat = lstatSync(packDir);
    if (entryStat.isSymbolicLink()) fail(`solo_test pack directory must not be a symlink: ${entry}`);
    if (!entryStat.isDirectory()) continue;
    const physical = realpathSync(packDir);
    if (!inside(root, physical)) fail(`solo_test pack directory escapes its root: ${entry}`);
    if (!existsSync(join(packDir, "manifest.json"))) continue;
    packs.push(loadSoloTestV3Pack(physical));
  }
  const byId = new Map(packs.map((pack) => [pack.manifest.identity.persona_id, pack]));
  if (byId.size !== packs.length) fail("duplicate solo_test PersonaPack v3 persona_id across directories");
  return Object.freeze({
    packs: Object.freeze([...packs]),
    legacy_ids: Object.freeze([]),
    get: (id) => byId.get(id),
  });
}
