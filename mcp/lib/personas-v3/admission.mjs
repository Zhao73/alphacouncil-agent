/**
 * PersonaPack v3 corpus admission.
 *
 * Admission is computed from files that exist on disk. A manifest may describe a maturity
 * or repeat convenient corpus counts, but neither is evidence and neither participates in
 * the result. The three bars intentionally answer different questions:
 *
 *   operational  -- is there enough physical method machinery to run this pack honestly?
 *   candidate    -- is there enough corpus and evaluation material for shadow testing?
 *   method_model -- did the candidate pass every signed production-workflow experiment?
 *
 * A legacy Markdown prompt is reported as `prompt_lens`; a v2 inline pack is reported as an
 * `operator_lens`. Neither can become operational without a physical v3 pack.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  canonicalJson,
  canonicalValue,
  computePersonaArtifactHashes,
  sha256,
} from "./canonical.mjs";
import {
  ATTESTATION_KEY_ID,
  normalizeTrustedKeyRegistry,
  signCanonicalAttestation,
  verifyCanonicalAttestation,
} from "./attestations.mjs";
import { resolveActivePersonaKnowledgeDir } from "./production-root.mjs";
import { canDefineMethodRule, inclusiveCutoffTime, validateSourceAnchor } from "./source-anchor.mjs";

export const OPERATIONAL_BAR = Object.freeze({
  physical_v3_pack: 1,
  propositions: 10,
  method_sources: 3,
  ab_sources: 2,
  decision_cases: 2,
  failure_cases: 1,
  vetoes: 5,
  counterfactuals: 10,
  dedicated_tools: 2,
  private_research_paths: 1,
  disconfirming_queries: 1,
  native_decision_schemas: 1,
  fail_closed: 1,
  late_voice: 1,
});

export const CANDIDATE_EXPERIMENTS = Object.freeze([
  "source_fidelity",
  "policy_adherence",
  "host_parity",
]);

export const CANDIDATE_BAR = Object.freeze({
  ...OPERATIONAL_BAR,
  propositions: 25,
  ab_sources: 5,
  decision_cases: 5,
  failure_cases: 3,
  vetoes: 10,
  counterfactuals: 20,
  golden_cases: 12,
  dedicated_tools: 3,
  recomputation_tools: 2,
  pairwise_groups: 4,
  source_experiment_passes: 1,
  policy_experiment_passes: 1,
  host_experiment_passes: 1,
});

export const METHOD_MODEL_EXPERIMENTS = Object.freeze([
  ...CANDIDATE_EXPERIMENTS,
  "name_invariance",
  "voice_invariance",
  "policy_swap",
  "counterfactual_direction",
  "citation_support",
  "pairwise_differentiation",
  "blind_method_identification",
  "leave_one_out",
  "matched_cost",
]);

export const METHOD_MODEL_RULE_BAR = Object.freeze({
  dual_reviewed_propositions: CANDIDATE_BAR.propositions,
  dual_reviewed_vetoes: CANDIDATE_BAR.vetoes,
});

export const EXPERIMENT_RESULTS_PATH = "evaluation/experiments.json";
export const TRUSTED_EXPERIMENT_SIGNERS_ENV = "ALPHACOUNCIL_TRUSTED_EXPERIMENT_SIGNERS";
export const TRUSTED_EXPERIMENT_KEYS_ENV = "ALPHACOUNCIL_TRUSTED_EXPERIMENT_KEYS";

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const ED25519_SIGNATURE = /^ed25519:[A-Za-z0-9_-]{86}$/u;
const EXPERIMENT_SIGNER_ID = ATTESTATION_KEY_ID;
const EXPERIMENT_HASH_FIELDS = Object.freeze([
  "dataset_hash",
  "case_ledger_hash",
  "artifact_subject_hash",
  "corpus_hash",
  "policy_hash",
  "tool_graph_hash",
  "model_hash",
  "prompt_hash",
  "runner_hash",
  "host_hash",
]);
const LEGACY_EXPERIMENT_HASH_FIELDS = Object.freeze([
  "dataset_hash",
  "case_ledger_hash",
  "pack_hash",
  "policy_hash",
  "model_hash",
  "prompt_hash",
  "runner_hash",
  "host_hash",
]);
const EXPERIMENT_BINDING_FIELDS = Object.freeze([
  "artifact_subject_hash",
  "corpus_hash",
  "policy_hash",
  "tool_graph_hash",
  "prompt_hash",
]);
const EXPERIMENT_ENTRY_FIELDS = Object.freeze([
  "experiment_id",
  "status",
  ...EXPERIMENT_HASH_FIELDS,
  "pack_hash",
  "thresholds",
  "metrics",
  "started_at",
  "evaluated_at",
  "signer_key_id",
  "signature_algorithm",
  "signature",
]);

const V3_COMPONENTS = Object.freeze([
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

const COUNT_KEYS = Object.freeze([...new Set([
  ...Object.keys(OPERATIONAL_BAR),
  ...Object.keys(CANDIDATE_BAR),
  ...Object.keys(METHOD_MODEL_RULE_BAR),
  "signed_method_experiments",
])]);

export class PersonaAdmissionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaAdmissionError";
    this.details = details;
  }
}

export function defaultKnowledgeDir() {
  return resolveActivePersonaKnowledgeDir();
}

function fail(message, details = {}) {
  throw new PersonaAdmissionError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonEmptyFile(file) {
  if (!file || !existsSync(file)) return false;
  try {
    return statSync(file).isFile() && readFileSync(file, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function readJson(file, label = file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label}: invalid JSON (${error.message})`, { file });
  }
  return value;
}

function readJsonl(file, label = file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`${label}: unreadable (${error.code || error.message})`, { file });
  }
  const records = [];
  for (const [offset, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch (error) {
      fail(`${label}:${offset + 1}: invalid JSON (${error.message})`, { file, line: offset + 1 });
    }
    if (!isObject(value)) fail(`${label}:${offset + 1}: each JSONL record must be an object`, { file, line: offset + 1 });
    records.push(value);
  }
  return records;
}

function readCollection(file, label = file) {
  if (/\.jsonl$/i.test(file)) return readJsonl(file, label);
  const value = readJson(file, label);
  if (Array.isArray(value)) return value;
  if (isObject(value) && Array.isArray(value.records)) return value.records;
  if (isObject(value) && Array.isArray(value.items)) return value.items;
  fail(`${label}: expected a JSON array, {records: []}, {items: []}, or JSONL`, { file });
}

function inside(base, target) {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function componentPath(packDir, path, label) {
  if (!nonEmptyString(path)) return null;
  if (isAbsolute(path)) fail(`${label}: absolute component paths are forbidden`, { path });
  const base = realpathSync(packDir);
  const target = resolve(base, path);
  if (!inside(base, target)) fail(`${label}: component path escapes the pack directory`, { path });
  // Preserve the existing "missing artifact" behavior for absent paths. Existing paths must
  // be resolved physically so a symlink inside the pack cannot source admission material from
  // elsewhere on disk.
  if (!existsSync(target)) return target;
  const physical = realpathSync(target);
  if (!inside(base, physical)) fail(`${label}: symlink escapes the pack directory`, { path });
  return physical;
}

function componentFile(packDir, manifest, name, missing) {
  const path = componentPath(packDir, manifest?.components?.[name], `components.${name}`);
  if (!path || !isNonEmptyFile(path)) {
    missing.push(name);
    return null;
  }
  return path;
}

function stableId(record, keys) {
  for (const key of keys) if (nonEmptyString(record?.[key])) return record[key].trim();
  return null;
}

function uniqueRecords(records, keys) {
  const byId = new Map();
  for (const record of records) {
    if (!isObject(record)) continue;
    const id = stableId(record, keys);
    if (!id || byId.has(id)) continue;
    byId.set(id, record);
  }
  return [...byId.values()];
}

function legacyV2SourceAnchor(source) {
  return isObject(source)
    && nonEmptyString(source.id)
    && ["A", "B", "C"].includes(source.grade)
    && nonEmptyString(source.title)
    && nonEmptyString(source.url)
    && nonEmptyString(source.date);
}

function legacyV2SourceKey(source) {
  return `${source.url.trim()}|${source.date.trim()}|${source.title.trim()}`;
}

function normalizeLegacyV2Sources(sourcesRaw) {
  const sourceIds = new Set();
  const independentKeys = new Set();
  const anchors = [];
  for (const source of sourcesRaw) {
    if (!legacyV2SourceAnchor(source) || sourceIds.has(source.id)) continue;
    const key = legacyV2SourceKey(source);
    if (independentKeys.has(key)) continue;
    sourceIds.add(source.id);
    independentKeys.add(key);
    anchors.push(source);
  }
  return {
    anchors,
    methodSourceIds: new Set(anchors.map((source) => source.id)),
    dualReviewSourceIds: new Set(),
    errors: [],
  };
}

function normalizeV3Sources(sourcesRaw, sourceCutoff) {
  const sourceIds = new Set();
  const independentHashes = new Set();
  const anchors = [];
  const errors = [];
  const cutoff = inclusiveCutoffTime(sourceCutoff);
  if (!Number.isFinite(cutoff)) {
    return {
      anchors,
      methodSourceIds: new Set(),
      dualReviewSourceIds: new Set(),
      errors: ["identity.source_cutoff must be a valid dated string for v3 admission"],
    };
  }
  for (const [index, source] of sourcesRaw.entries()) {
    const label = `components.sources[${index}]`;
    const validationErrors = validateSourceAnchor(source, { file: label });
    if (validationErrors.length) {
      errors.push(...validationErrors);
      continue;
    }
    if (source.adjudication.status !== "approved") {
      errors.push(`${label}: adjudication.status must be approved for admission`);
      continue;
    }
    const publicAt = Date.parse(source.public_at);
    const knownAt = source.known_at === undefined || source.known_at === null
      ? publicAt : Date.parse(source.known_at);
    if (publicAt > cutoff || knownAt > cutoff) {
      if (publicAt > cutoff) errors.push(`${label}: public_at exceeds identity.source_cutoff`);
      if (knownAt > cutoff) errors.push(`${label}: known_at exceeds identity.source_cutoff`);
      continue;
    }
    if (sourceIds.has(source.source_id)) {
      errors.push(`${label}: duplicate source_id ${JSON.stringify(source.source_id)} is excluded`);
      continue;
    }
    if (independentHashes.has(source.content_hash)) {
      errors.push(`${label}: duplicate content_hash ${JSON.stringify(source.content_hash)} is not an independent source`);
      continue;
    }
    sourceIds.add(source.source_id);
    independentHashes.add(source.content_hash);
    anchors.push(source);
  }
  return {
    anchors,
    methodSourceIds: new Set(anchors.map((source) => source.source_id)),
    dualReviewSourceIds: new Set(anchors
      .filter((source) => canDefineMethodRule(source))
      .map((source) => source.source_id)),
    errors,
  };
}

function normalizeTools(value) {
  const records = Array.isArray(value) ? value : asArray(value?.tools);
  const seen = new Set();
  const tools = [];
  for (const record of records) {
    const id = typeof record === "string" ? record.trim()
      : stableId(record, ["id", "tool", "name"]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tools.push(typeof record === "string" ? { id } : { ...record, id });
  }
  return tools;
}

function approvedSourceLink(record, sourceIds) {
  const linked = asArray(record?.source_ids);
  return linked.length > 0
    && linked.every((id) => nonEmptyString(id) && sourceIds.has(id));
}

function completeCaseRecord(record, kind, sourceIds) {
  if (!isObject(record) || record.schema_version !== 1) return false;
  if (!Number.isFinite(Date.parse(record.as_of)) || !SHA256.test(record.fact_pack_hash || "")) return false;
  if (!approvedSourceLink(record, sourceIds)) return false;
  if (kind === "decision" || kind === "golden") {
    return nonEmptyString(record.expected_native_decision);
  }
  if (kind === "failure") {
    return nonEmptyString(record.failure_mode) && nonEmptyString(record.expected_correction);
  }
  if (kind === "counterfactual") {
    return nonEmptyString(record.base_case_id)
      && isObject(record.mutation) && Object.keys(record.mutation).length > 0
      && nonEmptyString(record.expected_direction);
  }
  if (kind === "pairwise") {
    return nonEmptyString(record.group_id)
      && nonEmptyString(record.peer_persona_id)
      && nonEmptyString(record.expected_relation);
  }
  return false;
}

function completeToolRecord(tool, sourceIds) {
  return isObject(tool)
    && tool.schema_version === 1
    && nonEmptyString(tool.id)
    && nonEmptyString(tool.version)
    && ["recomputation", "calculator", "retrieval", "transform"].includes(tool.kind)
    && SHA256.test(tool.input_schema_hash || "")
    && SHA256.test(tool.output_schema_hash || "")
    && nonEmptyString(tool.formula_spec_id)
    && SHA256.test(tool.formula_spec_hash || "")
    && SHA256.test(tool.formula_review_subject_hash || "")
    && SHA256.test(tool.approval_bundle_hash || "")
    && approvedSourceLink(tool, sourceIds);
}

function normalizeCorpus(corpus, promptPresent = false) {
  const sourcesRaw = asArray(corpus.sources);
  const normalizedSources = corpus.source_contract === "v3_anchor_v1"
    ? normalizeV3Sources(sourcesRaw, corpus.source_cutoff)
    : normalizeLegacyV2Sources(sourcesRaw);
  const { anchors, methodSourceIds, dualReviewSourceIds } = normalizedSources;
  const strictPhysicalRecords = corpus.source_contract === "v3_anchor_v1";

  const doctrineRaw = asArray(corpus.doctrine);
  const doctrine = uniqueRecords(doctrineRaw, ["rule_id", "id"])
    .filter((rule) => asArray(rule.source_ids).some((id) => methodSourceIds.has(id)));
  const dualReviewedDoctrine = doctrine
    .filter((rule) => asArray(rule.source_ids).some((id) => dualReviewSourceIds.has(id)));
  const decisionCasesRaw = asArray(corpus.decision_cases);
  const explicitFailuresRaw = asArray(corpus.failure_cases);
  const counterfactualsRaw = asArray(corpus.counterfactuals);
  const goldenCasesRaw = asArray(corpus.golden_cases);
  const pairwiseCasesRaw = asArray(corpus.pairwise_cases);
  const decisionCases = uniqueRecords(decisionCasesRaw, ["case_id", "id"])
    .filter((record) => !strictPhysicalRecords || completeCaseRecord(record, "decision", methodSourceIds));
  const explicitFailures = uniqueRecords(explicitFailuresRaw, ["case_id", "id"])
    .filter((record) => !strictPhysicalRecords || completeCaseRecord(record, "failure", methodSourceIds));
  const legacyFailures = strictPhysicalRecords || explicitFailures.length
    ? [] : doctrine.filter((rule) => asArray(rule.counterexamples).length > 0);
  const vetoesRaw = asArray(corpus.vetoes);
  const vetoes = uniqueRecords(vetoesRaw, ["veto_id", "id"])
    .filter((veto) => asArray(veto.source_ids).some((id) => methodSourceIds.has(id)));
  const dualReviewedVetoes = vetoes
    .filter((veto) => asArray(veto.source_ids).some((id) => dualReviewSourceIds.has(id)));
  const counterfactuals = uniqueRecords(counterfactualsRaw, ["case_id", "counterfactual_id", "id"])
    .filter((record) => !strictPhysicalRecords || completeCaseRecord(record, "counterfactual", methodSourceIds));
  const goldenCases = uniqueRecords(goldenCasesRaw, ["case_id", "id"])
    .filter((record) => !strictPhysicalRecords || completeCaseRecord(record, "golden", methodSourceIds));
  const pairwiseCases = uniqueRecords(pairwiseCasesRaw, ["case_id", "id"])
    .filter((record) => !strictPhysicalRecords || completeCaseRecord(record, "pairwise", methodSourceIds));
  const pairwiseGroups = new Set(pairwiseCases.map((record) => (
    stableId(record, ["group_id", "pairwise_group", "group"])
  )).filter(Boolean));
  const normalizedTools = normalizeTools(corpus.tools);
  const tools = normalizedTools
    .filter((tool) => !strictPhysicalRecords || completeToolRecord(tool, methodSourceIds));
  const recomputationTools = tools.filter((tool) => (
    tool.kind === "recomputation" || tool.recomputes === true || asArray(tool.tags).includes("recomputation")
  ));
  const research = isObject(corpus.research_policy) ? corpus.research_policy : {};
  const privatePaths = [
    ...asArray(research.private_research_paths),
    ...asArray(research.private_paths),
    ...asArray(research.evidence_slice),
  ].filter(nonEmptyString);
  const disconfirming = [
    ...asArray(research.mandatory_disconfirming_queries),
    ...asArray(research.must_seek_disconfirming),
  ].filter(nonEmptyString);

  return {
    counts: {
      prompt_files: promptPresent ? 1 : 0,
      physical_v3_pack: corpus.physical_v3_pack ? 1 : 0,
      propositions: doctrine.length,
      method_sources: anchors.length,
      ab_sources: anchors.filter((source) => ["A", "B"].includes(source.grade)).length,
      dual_reviewed_propositions: dualReviewedDoctrine.length,
      dual_reviewed_vetoes: dualReviewedVetoes.length,
      decision_cases: decisionCases.length,
      failure_cases: explicitFailures.length || legacyFailures.length,
      vetoes: vetoes.length,
      counterfactuals: counterfactuals.length,
      dedicated_tools: tools.length,
      recomputation_tools: recomputationTools.length,
      private_research_paths: new Set(privatePaths).size,
      disconfirming_queries: new Set(disconfirming).size,
      native_decision_schemas: corpus.native_decision_schema ? 1 : 0,
      fail_closed: corpus.fail_closed ? 1 : 0,
      late_voice: corpus.late_voice ? 1 : 0,
      golden_cases: goldenCases.length,
      pairwise_groups: pairwiseGroups.size,
      source_experiment_passes: 0,
      policy_experiment_passes: 0,
      host_experiment_passes: 0,
      signed_method_experiments: 0,
    },
    raw_counts: {
      propositions: doctrineRaw.length,
      method_sources: sourcesRaw.length,
      decision_cases: decisionCasesRaw.length,
      failure_cases: explicitFailuresRaw.length,
      vetoes: vetoesRaw.length,
      counterfactuals: counterfactualsRaw.length,
      dedicated_tools: Array.isArray(corpus.tools) ? corpus.tools.length : asArray(corpus.tools?.tools).length,
      golden_cases: goldenCasesRaw.length,
      pairwise_cases: pairwiseCasesRaw.length,
    },
    excluded_counts: {
      propositions: doctrineRaw.length - doctrine.length,
      method_sources: sourcesRaw.length - anchors.length,
      vetoes: vetoesRaw.length - vetoes.length,
      decision_cases: decisionCasesRaw.length - decisionCases.length,
      failure_cases: explicitFailuresRaw.length - explicitFailures.length,
      counterfactuals: counterfactualsRaw.length - counterfactuals.length,
      dedicated_tools: normalizedTools.length - tools.length,
      golden_cases: goldenCasesRaw.length - goldenCases.length,
      pairwise_cases: pairwiseCasesRaw.length - pairwiseCases.length,
    },
    source_contract: corpus.source_contract || "v2_legacy",
    source_anchor_errors: normalizedSources.errors,
    failure_case_source: explicitFailures.length ? "failure_cases" : legacyFailures.length ? "doctrine_counterexamples" : "none",
  };
}

function inlineV2Corpus(manifest) {
  return {
    source_contract: "v2_legacy",
    physical_v3_pack: false,
    sources: asArray(manifest.sources),
    doctrine: asArray(manifest.doctrine),
    decision_cases: asArray(manifest.decision_cases),
    failure_cases: asArray(manifest.failure_cases),
    vetoes: asArray(manifest.decision_policy?.vetoes),
    counterfactuals: asArray(manifest.counterfactuals),
    research_policy: manifest.research_policy,
    decision_policy: manifest.decision_policy,
    tools: manifest.tools,
    golden_cases: [],
    pairwise_cases: [],
    experiments: null,
    native_decision_schema: null,
    fail_closed: false,
    late_voice: false,
  };
}

function loadV3Corpus(packDir, manifest) {
  const missing = [];
  const files = {};
  for (const name of V3_COMPONENTS) files[name] = componentFile(packDir, manifest, name, missing);

  const voiceFiles = Object.fromEntries(["en", "zh"].map((lang) => {
    const path = componentPath(packDir, manifest?.voice?.[lang], `voice.${lang}`);
    if (!path || !isNonEmptyFile(path)) missing.push(`voice.${lang}`);
    return [lang, path && isNonEmptyFile(path) ? path : null];
  }));

  const collection = (name) => files[name] ? readCollection(files[name], `components.${name}`) : [];
  const object = (name) => {
    if (!files[name]) return {};
    const value = readJson(files[name], `components.${name}`);
    if (!isObject(value)) fail(`components.${name}: expected a JSON object`, { file: files[name] });
    return value;
  };
  const componentValues = {
    sources: collection("sources"),
    doctrine: collection("doctrine"),
    decision_cases: collection("decision_cases"),
    failures: collection("failures"),
    counterfactuals: collection("counterfactuals"),
    research_policy: object("research_policy"),
    decision_policy: object("decision_policy"),
    tools: files.tools ? readJson(files.tools, "components.tools") : [],
    memory_policy: object("memory_policy"),
    golden_cases: collection("golden_cases"),
    pairwise_cases: collection("pairwise_cases"),
    calibration_cases: collection("calibration_cases"),
    experiments: object("experiments"),
  };
  const voice = Object.fromEntries(Object.entries(voiceFiles)
    .map(([lang, file]) => [lang, file ? readFileSync(file, "utf8").trim() : ""]));
  const artifactHashes = missing.length === 0
    ? computePersonaArtifactHashes({ manifest, components: componentValues, voice })
    : null;
  const researchPolicy = componentValues.research_policy;
  const decisionPolicy = componentValues.decision_policy;
  const manifestNative = manifest?.capability?.native_decision_schema;
  const policyNative = decisionPolicy.native_decision_schema || decisionPolicy.native_output;

  return {
    corpus: {
      source_contract: "v3_anchor_v1",
      source_cutoff: manifest?.identity?.source_cutoff,
      physical_v3_pack: missing.length === 0,
      sources: componentValues.sources,
      doctrine: componentValues.doctrine,
      decision_cases: componentValues.decision_cases,
      failure_cases: componentValues.failures,
      vetoes: asArray(decisionPolicy.hard_vetoes).length
        ? decisionPolicy.hard_vetoes : asArray(decisionPolicy.vetoes),
      counterfactuals: componentValues.counterfactuals,
      research_policy: researchPolicy,
      decision_policy: decisionPolicy,
      tools: componentValues.tools,
      golden_cases: componentValues.golden_cases,
      pairwise_cases: componentValues.pairwise_cases,
      experiments: componentValues.experiments,
      native_decision_schema: nonEmptyString(manifestNative) && nonEmptyString(policyNative)
        ? manifestNative : null,
      fail_closed: manifest?.decision?.abstention_policy === "fail_closed"
        && decisionPolicy.abstention_policy === "fail_closed",
      late_voice: manifest?.voice?.load_after_decision_freeze === true
        && Object.values(voiceFiles).every(Boolean),
    },
    artifact_hashes: artifactHashes,
    missing_artifacts: missing,
    component_files: Object.fromEntries(Object.entries(files)
      .map(([key, value]) => [key, value ? relative(realpathSync(packDir), value) : null])),
  };
}

function trustedSignerTokens(value) {
  if (value === undefined) return trustedSignerTokens(process.env[TRUSTED_EXPERIMENT_SIGNERS_ENV] || "");
  if (value === null) return [];
  if (value instanceof Set || Array.isArray(value)) return [...value];
  if (typeof value === "string") return value.split(",");
  throw new Error("trusted experiment signer allowlist must be a string, array, or Set");
}

export function resolveTrustedExperimentSignerIds(value = undefined) {
  const ids = new Set();
  for (const raw of trustedSignerTokens(value)) {
    const id = String(raw).trim();
    if (!id) continue;
    if (!EXPERIMENT_SIGNER_ID.test(id)) throw new Error(`invalid trusted experiment signer key id ${JSON.stringify(id)}`);
    ids.add(id);
  }
  return ids;
}

export function resolveTrustedExperimentKeyRegistry(value = undefined) {
  let registryValue = value;
  if (registryValue === undefined) {
    const encoded = process.env[TRUSTED_EXPERIMENT_KEYS_ENV];
    if (!encoded?.trim()) return new Map();
    try {
      registryValue = JSON.parse(encoded);
    } catch (error) {
      throw new Error(`${TRUSTED_EXPERIMENT_KEYS_ENV} must be a JSON key registry (${error.message})`);
    }
  }
  return normalizeTrustedKeyRegistry(registryValue);
}

export function experimentSignedPayload(entry, signerKeyId = entry?.signer_key_id) {
  if (!isObject(entry)) throw new Error("experiment entry must be an object");
  if (!EXPERIMENT_SIGNER_ID.test(signerKeyId || "")) throw new Error("experiment signer_key_id is invalid");
  if (entry.signer_key_id !== undefined && entry.signer_key_id !== signerKeyId) {
    throw new Error("experiment signer_key_id does not match the signing key id");
  }
  return canonicalValue(Object.fromEntries(EXPERIMENT_ENTRY_FIELDS
    .filter((field) => field !== "signature" && entry[field] !== undefined)
    .map((field) => [field, field === "signer_key_id" ? signerKeyId : entry[field]])));
}

/**
 * Deprecated migration helper for fixtures that still need to read a legacy record.
 * The resulting sha256 value is deliberately never accepted as an attestation.
 */
export function computeExperimentSignature(entry, signerKeyId = entry?.signer_key_id) {
  return sha256(`${canonicalJson(experimentSignedPayload(entry, signerKeyId))}${signerKeyId}`);
}

export function signExperimentEntry(entry, { privateKey, signerKeyId = entry?.signer_key_id } = {}) {
  return signCanonicalAttestation(experimentSignedPayload(entry, signerKeyId), {
    privateKey,
    signerKeyId,
  });
}

function timestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function exactFields(value, fields, label, errors, { required = fields } = {}) {
  if (!isObject(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) if (!allowed.has(field)) errors.push(`${label}.${field} is not allowed`);
  for (const field of required) if (!(field in value)) errors.push(`${label}.${field} is required`);
}

function experimentEntryValidation(id, entry) {
  const errors = [];
  const legacySignature = isObject(entry)
    && entry.signature_algorithm === undefined
    && SHA256.test(entry.signature || "");
  const requiredFields = [
    "experiment_id",
    "status",
    ...(legacySignature ? LEGACY_EXPERIMENT_HASH_FIELDS : EXPERIMENT_HASH_FIELDS),
    "thresholds",
    "metrics",
    "started_at",
    "evaluated_at",
    "signer_key_id",
    ...(legacySignature ? [] : ["signature_algorithm"]),
    "signature",
  ];
  exactFields(entry, EXPERIMENT_ENTRY_FIELDS, `experiments.${id}`, errors, { required: requiredFields });
  if (!isObject(entry)) return { errors, unsigned: true, signature_valid: false };
  if (entry.experiment_id !== id) errors.push(`experiments.${id}.experiment_id must equal its map key`);
  if (!["passed", "failed"].includes(entry.status)) errors.push(`experiments.${id}.status must be passed or failed`);
  for (const field of legacySignature ? LEGACY_EXPERIMENT_HASH_FIELDS : EXPERIMENT_HASH_FIELDS) {
    if (!SHA256.test(entry[field] || "")) errors.push(`experiments.${id}.${field} must be a sha256 hash`);
  }
  if (entry.pack_hash !== undefined && !SHA256.test(entry.pack_hash || "")) {
    errors.push(`experiments.${id}.pack_hash must be a sha256 hash when present`);
  }

  const thresholds = entry.thresholds;
  if (!isObject(thresholds) || Object.keys(thresholds).length === 0) {
    errors.push(`experiments.${id}.thresholds must be a non-empty object`);
  } else {
    for (const [thresholdId, threshold] of Object.entries(thresholds)) {
      if (!nonEmptyString(thresholdId)) errors.push(`experiments.${id}.thresholds has an empty id`);
      const label = `experiments.${id}.thresholds.${thresholdId}`;
      exactFields(threshold, ["operator", "value", "unit"], label, errors);
      if (!isObject(threshold)) continue;
      if (![">", ">=", "<", "<=", "==", "!="].includes(threshold.operator)) errors.push(`${label}.operator is invalid`);
      if (!Number.isFinite(threshold.value)) errors.push(`${label}.value must be finite`);
      if (!(threshold.unit === null || nonEmptyString(threshold.unit))) errors.push(`${label}.unit must be null or a non-empty string`);
    }
  }

  const metrics = entry.metrics;
  if (!isObject(metrics) || Object.keys(metrics).length === 0) {
    errors.push(`experiments.${id}.metrics must be a non-empty object`);
  } else {
    for (const [metricId, metric] of Object.entries(metrics)) {
      if (!nonEmptyString(metricId)) errors.push(`experiments.${id}.metrics has an empty id`);
      const label = `experiments.${id}.metrics.${metricId}`;
      exactFields(metric, ["value", "unit", "sample_size", "threshold_id", "passed"], label, errors);
      if (!isObject(metric)) continue;
      if (!Number.isFinite(metric.value)) errors.push(`${label}.value must be finite`);
      if (!(metric.unit === null || nonEmptyString(metric.unit))) errors.push(`${label}.unit must be null or a non-empty string`);
      if (!Number.isSafeInteger(metric.sample_size) || metric.sample_size < 1) errors.push(`${label}.sample_size must be a positive integer`);
      if (!nonEmptyString(metric.threshold_id) || !isObject(thresholds?.[metric.threshold_id])) {
        errors.push(`${label}.threshold_id must name a declared threshold`);
      }
      if (typeof metric.passed !== "boolean") errors.push(`${label}.passed must be boolean`);
    }
    const metricValues = Object.values(metrics).filter(isObject);
    if (entry.status === "passed" && metricValues.some((metric) => metric.passed !== true)) {
      errors.push(`experiments.${id}: passed status requires every metric to pass`);
    }
    if (entry.status === "failed" && metricValues.length && metricValues.every((metric) => metric.passed === true)) {
      errors.push(`experiments.${id}: failed status requires at least one failed metric`);
    }
  }

  if (!timestamp(entry.started_at)) errors.push(`experiments.${id}.started_at must be a valid timestamp`);
  if (!timestamp(entry.evaluated_at)) errors.push(`experiments.${id}.evaluated_at must be a valid timestamp`);
  if (timestamp(entry.started_at) && timestamp(entry.evaluated_at)
    && Date.parse(entry.evaluated_at) < Date.parse(entry.started_at)) {
    errors.push(`experiments.${id}.evaluated_at must not precede started_at`);
  }
  if (!EXPERIMENT_SIGNER_ID.test(entry.signer_key_id || "")) errors.push(`experiments.${id}.signer_key_id is invalid`);

  const unsigned = !nonEmptyString(entry.signature);
  if (!legacySignature && entry.signature_algorithm !== "ed25519") {
    errors.push(`experiments.${id}.signature_algorithm must be ed25519`);
  }
  if (!unsigned && !legacySignature && !ED25519_SIGNATURE.test(entry.signature)) {
    errors.push(`experiments.${id}.signature must be an ed25519 base64url signature`);
  }
  return {
    errors,
    unsigned,
    legacy_signature: legacySignature,
    signature_valid: false,
  };
}

function experimentDocumentHeaderErrors(document, personaId = null) {
  const errors = [];
  exactFields(document, ["schema_version", "persona_id", "experiments"], "experiment document", errors);
  if (!isObject(document)) return errors;
  if (document.schema_version !== 1) errors.push("experiment document.schema_version must be 1");
  if (!/^[a-z0-9_]{2,48}$/u.test(document.persona_id || "")) errors.push("experiment document.persona_id is invalid");
  if (personaId && document.persona_id !== personaId) errors.push("experiment document.persona_id does not match the pack");
  if (!isObject(document.experiments)) errors.push("experiment document.experiments must be an object");
  else for (const id of Object.keys(document.experiments)) {
    if (!METHOD_MODEL_EXPERIMENTS.includes(id)) errors.push(`experiment document contains unknown experiment ${JSON.stringify(id)}`);
  }
  return errors;
}

export function validateExperimentDocument(document, { personaId = null } = {}) {
  const errors = experimentDocumentHeaderErrors(document, personaId);
  if (!isObject(document?.experiments)) return errors;
  for (const [id, entry] of Object.entries(document.experiments)) {
    const validation = experimentEntryValidation(id, entry);
    errors.push(...validation.errors);
  }
  return errors;
}

export function evaluateMethodModelExperiments(document, {
  file = null,
  personaId = null,
  trustedSignerKeys = undefined,
  trustedSignerKeyIds = undefined,
  expectedArtifactHashes = null,
} = {}) {
  const passed = [];
  const failed = [];
  const unsigned = [];
  const untrusted = [];
  const invalid = [];
  const invalidSignature = [];
  const legacySignature = [];
  const unbound = [];
  const bindingMismatch = [];
  const missing = [];
  const errorDetails = {};
  const verificationErrors = {};
  const bindingErrors = {};
  const documentErrors = document ? experimentDocumentHeaderErrors(document, personaId) : [];
  const values = isObject(document?.experiments) ? document.experiments : {};
  const legacyIdInput = trustedSignerKeyIds === undefined
    || typeof trustedSignerKeyIds === "string"
    || trustedSignerKeyIds instanceof Set
    || (Array.isArray(trustedSignerKeyIds)
      && trustedSignerKeyIds.every((value) => typeof value === "string"))
    ? trustedSignerKeyIds : null;
  const legacyTrustedIds = resolveTrustedExperimentSignerIds(legacyIdInput);
  const registryInput = trustedSignerKeys === undefined
    && trustedSignerKeyIds !== undefined
    && legacyIdInput === null
    ? trustedSignerKeyIds : trustedSignerKeys;
  const trusted = resolveTrustedExperimentKeyRegistry(registryInput);
  const documentHeaderValid = documentErrors.length === 0;

  for (const id of METHOD_MODEL_EXPERIMENTS) {
    if (!(id in values)) { missing.push(id); continue; }
    const entry = values[id];
    const validation = experimentEntryValidation(id, entry);
    const structuralErrors = validation.errors.filter((error) => !error.includes(`experiments.${id}.signature `));
    if (structuralErrors.length) {
      invalid.push(id);
      errorDetails[id] = structuralErrors;
      continue;
    }
    if (validation.unsigned) { unsigned.push(id); continue; }
    if (validation.legacy_signature) {
      legacySignature.push(id);
      invalidSignature.push(id);
      verificationErrors[id] = "legacy_non_cryptographic_signature";
      continue;
    }
    if (!trusted.has(entry.signer_key_id)) { untrusted.push(id); continue; }
    if (!documentHeaderValid) {
      invalid.push(id);
      errorDetails[id] = [...documentErrors];
      continue;
    }
    const verification = verifyCanonicalAttestation(experimentSignedPayload(entry), {
      signature: entry.signature,
      signerKeyId: entry.signer_key_id,
      trustedKeyRegistry: trusted,
      purpose: "persona_experiment",
      at: entry.evaluated_at,
    });
    if (!verification.valid) {
      invalidSignature.push(id);
      verificationErrors[id] = verification.reason;
      continue;
    }
    if (!expectedArtifactHashes) {
      unbound.push(id);
      continue;
    }
    const mismatches = EXPERIMENT_BINDING_FIELDS
      .filter((field) => entry[field] !== expectedArtifactHashes[field])
      .map((field) => ({
        field,
        expected: expectedArtifactHashes[field] ?? null,
        actual: entry[field] ?? null,
      }));
    if (mismatches.length) {
      bindingMismatch.push(id);
      bindingErrors[id] = mismatches;
      continue;
    }
    if (entry.status === "failed") failed.push(id);
    else passed.push(id);
  }

  const status = !document ? "not_started"
    : failed.length ? "failed"
      : documentErrors.length || missing.length || unsigned.length || untrusted.length
        || invalid.length || invalidSignature.length || unbound.length || bindingMismatch.length
        ? "incomplete"
        : "passed";
  return {
    status,
    file,
    required: [...METHOD_MODEL_EXPERIMENTS],
    trusted_signer_key_ids: [...trusted.keys()].sort(),
    legacy_trusted_signer_ids_ignored: [...legacyTrustedIds].sort(),
    passed,
    failed,
    unsigned,
    untrusted,
    invalid,
    invalid_signature: invalidSignature,
    legacy_signature: legacySignature,
    unbound,
    binding_mismatch: bindingMismatch,
    missing,
    document_errors: documentErrors,
    error_details: errorDetails,
    verification_errors: verificationErrors,
    binding_errors: bindingErrors,
  };
}

export function deltaToBar(counts, bar) {
  const delta = {};
  for (const [key, required] of Object.entries(bar)) {
    const have = Number.isFinite(counts?.[key]) ? counts[key] : 0;
    delta[key] = Math.max(0, required - have);
  }
  return delta;
}

export function gapDetails(counts, bar) {
  const delta = deltaToBar(counts, bar);
  return Object.fromEntries(Object.entries(delta)
    .filter(([, missing]) => missing > 0)
    .map(([key, missing]) => [key, {
      have: Number.isFinite(counts?.[key]) ? counts[key] : 0,
      required: bar[key],
      missing,
    }]));
}

function clears(delta) {
  return Object.values(delta).every((value) => value === 0);
}

function candidateExperimentCounts(experiments) {
  const pass = new Set(experiments.passed);
  return {
    source_experiment_passes: pass.has("source_fidelity") ? 1 : 0,
    policy_experiment_passes: pass.has("policy_adherence") ? 1 : 0,
    host_experiment_passes: pass.has("host_parity") ? 1 : 0,
    signed_method_experiments: experiments.passed.length,
  };
}

function methodModelRuleReviewStatus(counts) {
  const delta = deltaToBar(counts, METHOD_MODEL_RULE_BAR);
  return {
    status: clears(delta) ? "passed" : "incomplete",
    required: { ...METHOD_MODEL_RULE_BAR },
    counted: Object.fromEntries(Object.keys(METHOD_MODEL_RULE_BAR)
      .map((key) => [key, Number.isFinite(counts?.[key]) ? counts[key] : 0])),
    gaps: Object.fromEntries(Object.entries(delta).filter(([, missing]) => missing > 0)),
  };
}

/** Inspect one canonical persona without trusting any declared maturity or admission block. */
export function inspectPersonaAdmission({
  persona_id,
  prompt_file = null,
  pack_dir = null,
  trustedSignerKeys = undefined,
  trustedSignerKeyIds = undefined,
  expectedArtifactHashes = null,
  allowMethodModelPromotion = false,
} = {}) {
  if (!nonEmptyString(persona_id)) fail("persona_id is required");
  const promptPresent = isNonEmptyFile(prompt_file);
  let manifest = null;
  let packFormat = "v1_prompt";
  let corpus = {
    source_contract: "none",
    physical_v3_pack: false,
    sources: [], doctrine: [], decision_cases: [], failure_cases: [], vetoes: [],
    counterfactuals: [], research_policy: {}, decision_policy: {}, tools: [],
    golden_cases: [], pairwise_cases: [], experiments: null, native_decision_schema: null,
    fail_closed: false, late_voice: false,
  };
  let missingArtifacts = [];
  let componentFiles = {};
  let artifactHashes = null;

  if (pack_dir && existsSync(pack_dir)) {
    if (!statSync(pack_dir).isDirectory()) fail(`${persona_id}: pack path is not a directory`, { pack_dir });
    const manifestFile = componentPath(pack_dir, "manifest.json", `${persona_id}/manifest.json`);
    if (!isNonEmptyFile(manifestFile)) fail(`${persona_id}: pack directory exists without a non-empty manifest.json`, { pack_dir });
    manifest = readJson(manifestFile, `${persona_id}/manifest.json`);
    if (!isObject(manifest)) fail(`${persona_id}/manifest.json: expected a JSON object`, { manifestFile });
    if (manifest.schema_version === 2) {
      packFormat = "v2_inline";
      corpus = inlineV2Corpus(manifest);
    } else if (manifest.schema_version === 3) {
      packFormat = "v3_physical";
      const loaded = loadV3Corpus(pack_dir, manifest);
      corpus = loaded.corpus;
      artifactHashes = loaded.artifact_hashes;
      missingArtifacts = loaded.missing_artifacts;
      componentFiles = loaded.component_files;
    } else {
      fail(`${persona_id}/manifest.json: unsupported schema_version ${JSON.stringify(manifest.schema_version)}`, { manifestFile });
    }
  }

  if (expectedArtifactHashes && artifactHashes
    && canonicalJson(expectedArtifactHashes) !== canonicalJson(artifactHashes)) {
    fail(`${persona_id}: loaded pack changed between compilation and admission hash binding`, {
      expected_artifact_hashes: expectedArtifactHashes,
      actual_artifact_hashes: artifactHashes,
    });
  }

  const normalized = normalizeCorpus(corpus, promptPresent);
  const experimentFile = componentFiles.experiments || EXPERIMENT_RESULTS_PATH;
  const experiments = evaluateMethodModelExperiments(corpus.experiments, {
    file: experimentFile,
    personaId: persona_id,
    trustedSignerKeys,
    trustedSignerKeyIds,
    expectedArtifactHashes: artifactHashes,
  });
  const counts = {
    ...Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])),
    ...normalized.counts,
    ...candidateExperimentCounts(experiments),
  };
  const deltaOperational = deltaToBar(counts, OPERATIONAL_BAR);
  const deltaCandidate = deltaToBar(counts, CANDIDATE_BAR);
  const operationalClear = clears(deltaOperational);
  const candidateClear = clears(deltaCandidate);
  const ruleReview = methodModelRuleReviewStatus(counts);
  const methodModelReady = candidateClear
    && ruleReview.status === "passed"
    && experiments.status === "passed";

  let admissionLevel;
  if (methodModelReady && allowMethodModelPromotion === true) admissionLevel = "method_model";
  else if (candidateClear) admissionLevel = "candidate";
  else if (operationalClear) admissionLevel = "operational";
  else if (packFormat === "v1_prompt") admissionLevel = "prompt_lens";
  else admissionLevel = "operator_lens";

  const declaredMaturity = manifest?.identity?.maturity || manifest?.kind || null;
  const selfClaimPresent = Boolean(manifest?.admission || declaredMaturity || manifest?.method_model_experiment_status);
  return {
    persona_id,
    admission_level: admissionLevel,
    pack_format: packFormat,
    prompt_present: promptPresent,
    manifest_present: Boolean(manifest),
    schema_version: manifest?.schema_version || 1,
    declared_maturity: declaredMaturity,
    declared_admission_ignored: Boolean(manifest?.admission),
    manifest_self_claim_effective: false,
    manifest_self_claim_present: selfClaimPresent,
    physical_corpus_counts: counts,
    raw_physical_counts: normalized.raw_counts,
    excluded_physical_counts: normalized.excluded_counts,
    source_contract: normalized.source_contract,
    source_anchor_errors: normalized.source_anchor_errors,
    failure_case_source: normalized.failure_case_source,
    artifact_hashes: artifactHashes,
    missing_artifacts: missingArtifacts,
    component_files: componentFiles,
    delta_to_operational: deltaOperational,
    delta_to_candidate: deltaCandidate,
    gaps_to_operational: gapDetails(counts, OPERATIONAL_BAR),
    gaps_to_candidate: gapDetails(counts, CANDIDATE_BAR),
    operational_clear: operationalClear,
    candidate_clear: candidateClear,
    method_model_ready: methodModelReady,
    method_model_promotion_enabled: allowMethodModelPromotion === true,
    method_model_promotion_blocked_reason: methodModelReady && allowMethodModelPromotion !== true
      ? "migration_gate_closed" : null,
    method_model_rule_review_status: ruleReview,
    method_model_experiment_status: experiments,
  };
}

/** Resolve a path relative to this module; useful to callers running from arbitrary cwd. */
export function moduleRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
}
