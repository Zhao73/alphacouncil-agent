/**
 * Minimal PersonaPack v3 deterministic runtime.
 *
 * This module deliberately stops before orchestration. It creates the anonymous input for a
 * method decision, refuses missing required facts without dispatching a decision layer, freezes
 * the structured result, and only then permits a voice-only explanation request.
 */

import { canonicalValue, sha256 } from "./canonical.mjs";
import { deterministicToolSchemaHashes } from "./tool-schema-hashes.mjs";
import { validateTypedFact } from "./typed-facts.mjs";

const HASH = /^sha256:[a-f0-9]{64}$/;
const LANGUAGES = new Set(["en", "zh"]);
const ANONYMOUS_FORBIDDEN_KEYS = new Set([
  "persona_id",
  "public_label",
  "operator_label",
  "admitted_label",
  "display_name",
  "persona_name",
  "voice",
  "voice_en",
  "voice_zh",
]);
const PRE_FREEZE_PROSE_KEYS = new Set([
  ...ANONYMOUS_FORBIDDEN_KEYS,
  "explanation",
  "explanation_text",
  "narrative",
  "report",
  "report_markdown",
]);

export class PersonaV3RuntimeError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaV3RuntimeError";
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new PersonaV3RuntimeError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireHash(value, field) {
  if (!HASH.test(value || "")) fail(`${field} must be sha256:<64 lowercase hex>`);
  return value;
}

function canonicalCopy(value, label) {
  try {
    return canonicalValue(value);
  } catch (error) {
    fail(`${label} is not canonical JSON: ${error.message}`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizedKey(key) {
  return String(key).trim().toLowerCase().replaceAll("-", "_");
}

function findForbiddenKey(value, forbidden, path = "$") {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const found = findForbiddenKey(child, forbidden, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(normalizedKey(key))) return `${path}.${key}`;
    const found = findForbiddenKey(child, forbidden, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

function stringsIn(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((child) => stringsIn(child, out));
  else if (isObject(value)) Object.values(value).forEach((child) => stringsIn(child, out));
  return out;
}

function identityMarkers(compiledPack) {
  const identity = compiledPack?.manifest?.identity || {};
  const values = [
    compiledPack?.persona_id,
    identity.persona_id,
    ...Object.values(identity.public_label || {}),
    ...Object.values(identity.operator_label || {}),
    ...Object.values(compiledPack?.admitted_label || {}),
    ...Object.values(compiledPack?.voice || {}),
  ].filter((value) => nonEmptyString(value));
  const personaId = identity.persona_id || compiledPack?.persona_id;
  const suffix = typeof personaId === "string" && personaId.startsWith("master_")
    ? personaId.slice("master_".length) : "";
  if (suffix.length >= 5) {
    values.push(suffix);
    values.push(suffix.replaceAll("_", " "));
  }
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 2))];
}

function assertNoIdentityValues(value, compiledPack, label) {
  const haystacks = stringsIn(value).map((text) => text.toLocaleLowerCase("en-US"));
  for (const marker of identityMarkers(compiledPack)) {
    const needle = marker.toLocaleLowerCase("en-US");
    if (haystacks.some((text) => text.includes(needle))) {
      fail(`${label} contains a persona identity or pre-freeze voice marker`, { marker });
    }
  }
}

function assertAnonymous(value, compiledPack, label) {
  const forbiddenPath = findForbiddenKey(value, ANONYMOUS_FORBIDDEN_KEYS);
  if (forbiddenPath) fail(`${label} contains forbidden pre-freeze identity/voice field ${forbiddenPath}`);
  assertNoIdentityValues(value, compiledPack, label);
}

const TECHNICAL_ID = /^[a-z][a-z0-9_.:-]{1,159}$/u;

function technicalIdentityAliases(value, compiledPack) {
  const markers = identityMarkers(compiledPack)
    .map((marker) => marker.toLocaleLowerCase("en-US"))
    .sort((a, b) => b.length - a.length);
  const aliases = new Map();
  for (const text of stringsIn(value)) {
    if (!TECHNICAL_ID.test(text)) continue;
    const normalized = text.toLocaleLowerCase("en-US");
    if (!markers.some((marker) => normalized.includes(marker))) continue;
    let neutral = normalized;
    for (const marker of markers) neutral = neutral.replaceAll(marker, "<identity>");
    aliases.set(text, `anon_${sha256({ identity_neutral_technical_id: neutral }).slice("sha256:".length, 24)}`);
  }
  return aliases;
}

function applyTechnicalAliases(value, aliases) {
  if (typeof value === "string") return aliases.get(value) || value;
  if (Array.isArray(value)) return value.map((child) => applyTechnicalAliases(child, aliases));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, applyTechnicalAliases(child, aliases)]));
}

function hashBoundDeterministicTool(tool) {
  return isObject(tool)
    && tool.dsl_version === "1.1"
    && nonEmptyString(tool.id)
    && nonEmptyString(tool.version)
    && nonEmptyString(tool.operation)
    && Array.isArray(tool.inputs)
    && Array.isArray(tool.input_contracts)
    && nonEmptyString(tool.output_id)
    && HASH.test(tool.input_schema_hash || "")
    && HASH.test(tool.output_schema_hash || "");
}

function physicalToolSchemaHashesValid(tool) {
  if (!hashBoundDeterministicTool(tool)) return false;
  const expected = deterministicToolSchemaHashes(tool);
  return tool.input_schema_hash === expected.input_schema_hash
    && tool.output_schema_hash === expected.output_schema_hash;
}

function validateCompiledPack(compiledPack) {
  if (!isObject(compiledPack) || compiledPack.schema_version !== 3) {
    fail("compiledPack must be a compiled PersonaPack v3 object");
  }
  for (const field of ["corpus_hash", "tool_graph_hash", "policy_hash"]) {
    requireHash(compiledPack[field], `compiledPack.${field}`);
  }
  const capability = compiledPack.manifest?.capability;
  const required = capability?.required_fact_types;
  const optional = capability?.optional_fact_types;
  if (!Array.isArray(required) || required.some((id) => !nonEmptyString(id))) {
    fail("compiledPack.manifest.capability.required_fact_types must be a string array");
  }
  if (!Array.isArray(optional) || optional.some((id) => !nonEmptyString(id))) {
    fail("compiledPack.manifest.capability.optional_fact_types must be a string array");
  }
  if (!required.length && !optional.length) fail("required_fact_types and optional_fact_types cannot both be empty");
  if (new Set(required).size !== required.length) fail("required_fact_types contains duplicates");
  if (new Set(optional).size !== optional.length) fail("optional_fact_types contains duplicates");
  const overlap = required.filter((id) => optional.includes(id));
  if (overlap.length) fail(`required_fact_types and optional_fact_types overlap: ${overlap.join(", ")}`);
  if (!nonEmptyString(capability.native_decision_schema)) {
    fail("compiledPack.manifest.capability.native_decision_schema is required");
  }
  if (compiledPack.manifest?.computation?.dsl_version !== "1.1") {
    fail("compiledPack.manifest.computation.dsl_version must be 1.1");
  }
  if (!Array.isArray(compiledPack.manifest?.computation?.pipeline)) {
    fail("compiledPack.manifest.computation.pipeline must be an array");
  }
  if (!isObject(compiledPack.manifest?.decision)) fail("compiledPack.manifest.decision is required");
  if (compiledPack.manifest.decision.abstention_policy !== "fail_closed") {
    fail("compiledPack decision policy must be fail_closed");
  }
  if (!isObject(compiledPack.components)) fail("compiledPack.components is required");
  return { required, optional };
}

function validateFactPack(factPack) {
  if (!isObject(factPack) || factPack.schema_version !== 1 || !Array.isArray(factPack.facts)) {
    fail("factPack must be a typed fact pack v1");
  }
  if (!Number.isFinite(Date.parse(factPack.as_of))) fail("factPack.as_of is invalid");
  if (!Number.isFinite(Date.parse(factPack.knowledge_as_of))) fail("factPack.knowledge_as_of is invalid");
  requireHash(factPack.fact_pack_hash, "factPack.fact_pack_hash");
  const errors = [];
  const ids = new Set();
  factPack.facts.forEach((fact, index) => {
    errors.push(...validateTypedFact(fact, {
      file: `factPack.facts[${index}]`,
      expectedAsOf: factPack.as_of,
      knowledgeAsOf: factPack.knowledge_as_of,
    }));
    if (ids.has(fact?.fact_id)) errors.push(`factPack.facts[${index}]: duplicate fact_id ${JSON.stringify(fact?.fact_id)}`);
    else if (fact?.fact_id) ids.add(fact.fact_id);
  });
  if (errors.length) fail(`invalid typed fact pack:\n- ${errors.join("\n- ")}`);
  const payload = canonicalCopy({
    schema_version: 1,
    as_of: factPack.as_of,
    knowledge_as_of: factPack.knowledge_as_of,
    facts: factPack.facts,
  }, "factPack");
  const expectedHash = sha256(payload);
  if (factPack.fact_pack_hash !== expectedHash) {
    fail("factPack.fact_pack_hash does not match its physical facts", {
      expected: expectedHash,
      actual: factPack.fact_pack_hash,
    });
  }
  return { ...payload, fact_pack_hash: factPack.fact_pack_hash };
}

function anonymousMethodContract(compiledPack, factTypes) {
  const manifest = compiledPack.manifest;
  const unaliased = canonicalCopy({
    schema_version: 1,
    dsl_version: manifest.computation.dsl_version,
    source_cutoff: compiledPack.source_cutoff,
    required_fact_types: factTypes.required,
    optional_fact_types: factTypes.optional,
    computation_pipeline: manifest.computation.pipeline,
    decision_contract: {
      eligibility: manifest.decision.eligibility,
      hard_vetoes: manifest.decision.hard_vetoes,
      native_output: manifest.decision.native_output,
      common_projection: manifest.decision.common_projection,
      abstention_policy: manifest.decision.abstention_policy,
      confidence_calibrator: manifest.decision.confidence_calibrator ?? null,
    },
    doctrine: compiledPack.components.doctrine || [],
    decision_policy: compiledPack.components.decision_policy || {},
    tools: compiledPack.components.tools || [],
  }, "anonymous method contract");
  // Seat-specific IDs remain useful in the physical artifact but are identity-bearing in a
  // pre-decision. Alias every exact technical token and then re-hash the aliased executable
  // contracts. This mutates only the anonymous copy; physical tool/pack hashes stay intact.
  const aliases = technicalIdentityAliases(unaliased, compiledPack);
  const aliased = applyTechnicalAliases(unaliased, aliases);
  const contract = canonicalCopy({
    ...aliased,
    tools: (aliased.tools || []).map((tool, index) => physicalToolSchemaHashesValid(unaliased.tools?.[index])
      ? { ...tool, ...deterministicToolSchemaHashes(tool) }
      : tool),
  }, "anonymous method contract");
  assertAnonymous(contract, compiledPack, "anonymous method contract");
  return contract;
}

function eligibilityFor(requiredFactTypes, optionalFactTypes, facts) {
  const factIds = new Set(facts.map((fact) => fact.fact_id));
  const present = requiredFactTypes.filter((id) => factIds.has(id));
  const missing = requiredFactTypes.filter((id) => !factIds.has(id));
  const presentOptional = optionalFactTypes.filter((id) => factIds.has(id));
  const missingOptional = optionalFactTypes.filter((id) => !factIds.has(id));
  const status = missing.length === 0 ? "ready"
    : present.length === 0 ? "out_of_scope"
      : "insufficient_grounding";
  return {
    status,
    reason: status === "ready" ? "all_critical_fact_types_present"
      : status === "out_of_scope" ? "no_required_fact_types_present"
        : "missing_required_fact_types",
    required_fact_types: [...requiredFactTypes],
    present_required_fact_types: present,
    missing_required_fact_types: missing,
    optional_fact_types: [...optionalFactTypes],
    present_optional_fact_types: presentOptional,
    missing_optional_fact_types: missingOptional,
    coverage: {
      present: present.length,
      required: requiredFactTypes.length,
      ratio: requiredFactTypes.length ? present.length / requiredFactTypes.length : 1,
    },
    optional_coverage: {
      present: presentOptional.length,
      declared: optionalFactTypes.length,
      ratio: optionalFactTypes.length ? presentOptional.length / optionalFactTypes.length : 1,
    },
  };
}

function methodArtifactHashes(compiledPack) {
  return {
    corpus_hash: compiledPack.corpus_hash,
    tool_graph_hash: compiledPack.tool_graph_hash,
    policy_hash: compiledPack.policy_hash,
  };
}

function deterministicCorePayload(preDecision) {
  return {
    schema_version: 1,
    anonymous_method_hash: preDecision.anonymous_method_hash,
    method_artifact_hashes: preDecision.method_artifact_hashes,
    fact_pack_hash: preDecision.fact_pack.fact_pack_hash,
    evidence_snapshot_hash: preDecision.evidence_snapshot_hash,
    native_decision_schema: preDecision.native_decision_schema,
    eligibility: preDecision.eligibility,
  };
}

function expectedExecutionGate(eligibility) {
  return {
    anonymous_decision_allowed: eligibility.status === "ready",
    narrative_layer_allowed: false,
    late_voice_allowed: false,
  };
}

/** Build an identity-free, voice-free input for the method's anonymous decision pass. */
export function buildAnonymousPreDecision({ compiledPack, factPack, privateEvidence = [] } = {}) {
  const factTypes = validateCompiledPack(compiledPack);
  const verifiedFactPack = validateFactPack(factPack);
  if (!Array.isArray(privateEvidence) && !isObject(privateEvidence)) {
    fail("privateEvidence must be a JSON array or object");
  }
  const evidence = canonicalCopy(privateEvidence, "privateEvidence");
  assertAnonymous(evidence, compiledPack, "privateEvidence");
  const methodContract = anonymousMethodContract(compiledPack, factTypes);
  const eligibility = eligibilityFor(factTypes.required, factTypes.optional, verifiedFactPack.facts);
  const evidenceSnapshotHash = sha256({
    fact_pack_hash: verifiedFactPack.fact_pack_hash,
    private_evidence: evidence,
  });
  const draft = {
    schema_version: 1,
    phase: "anonymous_pre_decision",
    anonymous: true,
    native_decision_schema: methodContract.decision_policy.native_decision_schema,
    method_artifact_hashes: methodArtifactHashes(compiledPack),
    anonymous_method_contract: methodContract,
    anonymous_method_hash: sha256(methodContract),
    fact_pack: verifiedFactPack,
    private_evidence: evidence,
    evidence_snapshot_hash: evidenceSnapshotHash,
    eligibility,
    execution_gate: expectedExecutionGate(eligibility),
  };
  const preDecision = {
    ...draft,
    deterministic_core_hash: sha256(deterministicCorePayload(draft)),
  };
  return deepFreeze(canonicalCopy(preDecision, "anonymous pre-decision"));
}

function verifyAnonymousPreDecision(preDecision) {
  if (!isObject(preDecision) || preDecision.schema_version !== 1 || preDecision.phase !== "anonymous_pre_decision") {
    fail("preDecision must be an anonymous pre-decision v1 payload");
  }
  if (preDecision.anonymous !== true) fail("preDecision.anonymous must be true");
  const forbiddenPath = findForbiddenKey(preDecision, ANONYMOUS_FORBIDDEN_KEYS);
  if (forbiddenPath) fail(`preDecision contains forbidden identity/voice field ${forbiddenPath}`);
  const factPack = validateFactPack(preDecision.fact_pack);
  const expectedEvidenceHash = sha256({
    fact_pack_hash: factPack.fact_pack_hash,
    private_evidence: preDecision.private_evidence,
  });
  if (preDecision.evidence_snapshot_hash !== expectedEvidenceHash) fail("preDecision evidence_snapshot_hash is invalid");
  if (preDecision.anonymous_method_hash !== sha256(preDecision.anonymous_method_contract)) {
    fail("preDecision anonymous_method_hash is invalid");
  }
  for (const [field, value] of Object.entries(preDecision.method_artifact_hashes || {})) requireHash(value, `preDecision.method_artifact_hashes.${field}`);
  if (Object.keys(preDecision.method_artifact_hashes || {}).sort().join(",") !== "corpus_hash,policy_hash,tool_graph_hash") {
    fail("preDecision.method_artifact_hashes is incomplete");
  }
  const expectedCoreHash = sha256(deterministicCorePayload(preDecision));
  if (preDecision.deterministic_core_hash !== expectedCoreHash) fail("preDecision deterministic_core_hash is invalid");
  const expectedGate = expectedExecutionGate(preDecision.eligibility);
  if (sha256(preDecision.execution_gate) !== sha256(expectedGate)) fail("preDecision execution_gate contradicts eligibility");
  return true;
}

function deterministicRefusal(preDecision) {
  const mapping = preDecision.anonymous_method_contract?.decision_policy?.fact_gate?.on_missing_critical;
  if (!isObject(mapping) || !nonEmptyString(mapping.native_state) || mapping.common_stance !== "out_of_scope") {
    fail("decision_policy.fact_gate.on_missing_critical must map critical fact gaps to an explicit native state and out_of_scope");
  }
  const missing = preDecision.eligibility.missing_required_fact_types;
  return {
    outcome: "out_of_scope",
    stance: "out_of_scope",
    reason: preDecision.eligibility.reason,
    narratable: false,
    eligibility: {
      eligible: false,
      status: preDecision.eligibility.status,
      coverage: preDecision.eligibility.coverage,
      optional_coverage: preDecision.eligibility.optional_coverage,
      present_required_fact_types: preDecision.eligibility.present_required_fact_types,
      missing_required_fact_types: missing,
      present_optional_fact_types: preDecision.eligibility.present_optional_fact_types,
      missing_optional_fact_types: preDecision.eligibility.missing_optional_fact_types,
    },
    computations: { outputs: {}, trace: [] },
    score: null,
    ratio: null,
    vetoes_triggered: [],
    reason_codes: missing,
    native_decision: {
      schema_id: preDecision.native_decision_schema,
      state: mapping.native_state,
      metrics: {},
      metric_status: {},
    },
    common_projection: {
      schema_id: preDecision.anonymous_method_contract.decision_contract.common_projection,
      stance: mapping.common_stance,
      reason: preDecision.eligibility.reason,
      score_ratio: null,
      coverage: preDecision.eligibility.coverage.ratio,
      veto_ids: [],
      confidence: "low",
      confidence_score: 0,
    },
  };
}

function frozenHashPayload(frozenDecision) {
  return {
    schema_version: 1,
    deterministic_core_hash: frozenDecision.deterministic_core_hash,
    evidence_snapshot_hash: frozenDecision.evidence_snapshot_hash,
    anonymous_method_hash: frozenDecision.anonymous_method_hash,
    method_artifact_hashes: frozenDecision.method_artifact_hashes,
    structured_decision_hash: frozenDecision.structured_decision_hash,
  };
}

/** Freeze a structured decision. Ineligible inputs accept no externally supplied decision. */
export function freezeAnonymousDecision(preDecision, structuredDecision = null) {
  verifyAnonymousPreDecision(preDecision);
  const eligible = preDecision.eligibility.status === "ready";
  if (!eligible && structuredDecision !== null && structuredDecision !== undefined) {
    fail("an ineligible pre-decision cannot accept a decision-layer result");
  }
  if (eligible && !isObject(structuredDecision)) {
    fail("an eligible pre-decision requires a structured decision object");
  }
  const decisionResult = eligible
    ? canonicalCopy(structuredDecision, "structuredDecision")
    : deterministicRefusal(preDecision);
  const forbiddenPath = findForbiddenKey(decisionResult, PRE_FREEZE_PROSE_KEYS);
  if (forbiddenPath) fail(`structuredDecision contains a forbidden identity/voice/prose field ${forbiddenPath}`);
  const structured = canonicalCopy({
    schema_version: 1,
    native_decision_schema: preDecision.native_decision_schema,
    status: eligible ? "decided" : preDecision.eligibility.status,
    result: decisionResult,
  }, "structured decision envelope");
  const draft = {
    schema_version: 1,
    phase: "decision_frozen",
    anonymous: true,
    deterministic_core_hash: preDecision.deterministic_core_hash,
    evidence_snapshot_hash: preDecision.evidence_snapshot_hash,
    anonymous_method_hash: preDecision.anonymous_method_hash,
    method_artifact_hashes: preDecision.method_artifact_hashes,
    structured_decision: structured,
    structured_decision_hash: sha256(structured),
    late_voice_allowed: true,
  };
  return deepFreeze(canonicalCopy({
    ...draft,
    frozen_decision_hash: sha256(frozenHashPayload(draft)),
  }, "frozen decision"));
}

export function assertFrozenDecisionIntegrity(frozenDecision) {
  if (!isObject(frozenDecision) || frozenDecision.schema_version !== 1 || frozenDecision.phase !== "decision_frozen") {
    fail("frozenDecision must be a decision_frozen v1 payload");
  }
  if (frozenDecision.anonymous !== true || frozenDecision.late_voice_allowed !== true) {
    fail("frozenDecision has invalid phase gates");
  }
  requireHash(frozenDecision.deterministic_core_hash, "frozenDecision.deterministic_core_hash");
  requireHash(frozenDecision.evidence_snapshot_hash, "frozenDecision.evidence_snapshot_hash");
  requireHash(frozenDecision.anonymous_method_hash, "frozenDecision.anonymous_method_hash");
  if (frozenDecision.structured_decision_hash !== sha256(frozenDecision.structured_decision)) {
    fail("frozenDecision structured_decision_hash is invalid");
  }
  if (frozenDecision.frozen_decision_hash !== sha256(frozenHashPayload(frozenDecision))) {
    fail("frozenDecision frozen_decision_hash is invalid");
  }
  return true;
}

/**
 * Dispatch a decision the seat can still reach.
 *
 * `out_of_scope` -- none of the required facts present -- never calls the layer, because there
 * is no method left to run. `insufficient_grounding` does: the policy's own vetoes and
 * `on_missing` rules are how a method states what an absent input means, and refusing to
 * execute them reported the runtime's own gate instead of the method's answer.
 */
export async function runAnonymousDecisionLayer(preDecision, decisionLayer) {
  verifyAnonymousPreDecision(preDecision);
  if (preDecision.eligibility.status === "out_of_scope") {
    return deepFreeze({
      decision_layer_called: false,
      frozen_decision: freezeAnonymousDecision(preDecision),
    });
  }
  if (typeof decisionLayer !== "function") fail("decisionLayer must be a function for an eligible pre-decision");
  const result = await decisionLayer(preDecision);
  return deepFreeze({
    decision_layer_called: true,
    frozen_decision: freezeAnonymousDecision(preDecision, result),
  });
}

function assertPackMatchesFrozen(compiledPack, frozenDecision) {
  const factTypes = validateCompiledPack(compiledPack);
  assertFrozenDecisionIntegrity(frozenDecision);
  const expectedArtifacts = methodArtifactHashes(compiledPack);
  if (sha256(expectedArtifacts) !== sha256(frozenDecision.method_artifact_hashes)) {
    fail("compiledPack does not match the frozen decision's method artifacts");
  }
  const contract = anonymousMethodContract(compiledPack, factTypes);
  if (sha256(contract) !== frozenDecision.anonymous_method_hash) {
    fail("compiledPack does not match the frozen decision's anonymous method contract");
  }
}

function lateVoiceRequestHashPayload(request) {
  return {
    schema_version: 1,
    phase: request.phase,
    language: request.language,
    instruction: request.instruction,
    voice: request.voice,
    voice_hash: request.voice_hash,
    deterministic_core_hash: request.deterministic_core_hash,
    evidence_snapshot_hash: request.evidence_snapshot_hash,
    structured_decision: request.structured_decision,
    structured_decision_hash: request.structured_decision_hash,
    frozen_decision_hash: request.frozen_decision_hash,
  };
}

/** Voice becomes visible only after the frozen decision and hashes have been verified. */
export function buildLateVoiceExplanationRequest({ compiledPack, frozenDecision, language = "en" } = {}) {
  if (!LANGUAGES.has(language)) fail(`language must be one of: ${[...LANGUAGES].join(", ")}`);
  assertPackMatchesFrozen(compiledPack, frozenDecision);
  const voice = compiledPack.voice?.[language];
  if (!nonEmptyString(voice)) fail(`compiledPack.voice.${language} is required after freeze`);
  const draft = {
    schema_version: 1,
    phase: "late_voice_explanation",
    language,
    instruction: "Explain the frozen structured decision without changing its status, result, thresholds, hashes, or evidence boundary.",
    voice,
    voice_hash: sha256(voice),
    deterministic_core_hash: frozenDecision.deterministic_core_hash,
    evidence_snapshot_hash: frozenDecision.evidence_snapshot_hash,
    structured_decision: frozenDecision.structured_decision,
    structured_decision_hash: frozenDecision.structured_decision_hash,
    frozen_decision_hash: frozenDecision.frozen_decision_hash,
  };
  return deepFreeze(canonicalCopy({
    ...draft,
    late_voice_request_hash: sha256(lateVoiceRequestHashPayload(draft)),
  }, "late voice request"));
}

function verifyLateVoiceRequest(request, frozenDecision) {
  assertFrozenDecisionIntegrity(frozenDecision);
  if (!isObject(request) || request.schema_version !== 1 || request.phase !== "late_voice_explanation") {
    fail("voiceRequest must be a late_voice_explanation v1 payload");
  }
  if (request.late_voice_request_hash !== sha256(lateVoiceRequestHashPayload(request))) {
    fail("voiceRequest late_voice_request_hash is invalid");
  }
  for (const field of [
    "deterministic_core_hash",
    "evidence_snapshot_hash",
    "structured_decision_hash",
    "frozen_decision_hash",
  ]) {
    if (request[field] !== frozenDecision[field]) fail(`voiceRequest ${field} does not match frozenDecision`);
  }
  if (sha256(request.structured_decision) !== frozenDecision.structured_decision_hash) {
    fail("voiceRequest structured decision was modified");
  }
}

/** Attach text only; the frozen structured decision and all of its hashes are preserved. */
export function attachLateVoiceExplanation({ frozenDecision, voiceRequest, explanation } = {}) {
  verifyLateVoiceRequest(voiceRequest, frozenDecision);
  if (!nonEmptyString(explanation)) fail("explanation must be a non-empty string");
  const output = canonicalCopy({
    ...frozenDecision,
    phase: "decision_explained",
    late_voice_explanation: {
      language: voiceRequest.language,
      text: explanation.trim(),
      voice_hash: voiceRequest.voice_hash,
      request_hash: voiceRequest.late_voice_request_hash,
    },
  }, "explained frozen decision");
  if (output.structured_decision_hash !== frozenDecision.structured_decision_hash
    || output.frozen_decision_hash !== frozenDecision.frozen_decision_hash
    || sha256(output.structured_decision) !== frozenDecision.structured_decision_hash) {
    fail("late voice attempted to alter the frozen structured decision");
  }
  return deepFreeze(output);
}
