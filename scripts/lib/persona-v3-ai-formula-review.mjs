/**
 * Isolated AI-assisted cross-review lane for the 52 solo-test derived proxies.
 *
 * This lane reviews mechanical reproducibility only. Its three reviewers are explicitly
 * machine principals. It cannot emit a human approval, make a tool production eligible,
 * or satisfy the formal formula-review compiler/GA path.
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
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { deterministicToolSchemaHashes } from "../../mcp/lib/personas-v3/tool-schema-hashes.mjs";
import {
  CANONICAL_MASTER_COUNT,
  CANONICAL_MASTER_IDS,
  defaultStagingRoot,
} from "../../mcp/lib/personas-v3/staging.mjs";
import {
  DEFAULT_SOLO_TEST_FORMULA_ROOT,
  planSoloTestFormulaCompilation,
} from "./persona-v3-solo-formula-pipeline.mjs";

export const AI_FORMULA_REVIEW_DIRNAME = "persona-v3-ai-formula-reviews";
export const DEFAULT_AI_FORMULA_REVIEW_ROOT = resolve(
  defaultStagingRoot(),
  "../..",
  "ai-assisted-solo",
  "reviews",
  AI_FORMULA_REVIEW_DIRNAME,
);
export const AI_FORMULA_REVIEW_SCHEMA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../schemas/persona-v3-ai-formula-cross-review-v1.schema.json",
);
export const AI_FORMULA_REVIEW_ASSURANCE = "provisional_ai_cross_review";
export const AI_FORMULA_REVIEW_ROLE_SEQUENCE = Object.freeze([
  "deriver",
  "adversarial_checker",
  "adjudicator",
]);

export const AI_FORMULA_REVIEW_HASH_DOMAINS = Object.freeze({
  subject: "alphacouncil.persona-v3.ai-formula-review-subject.v1",
  prompt: "alphacouncil.persona-v3.ai-formula-review-prompt.v1",
  artifact: "alphacouncil.persona-v3.ai-formula-cross-review-artifact.v1",
  manifest: "alphacouncil.persona-v3.ai-formula-cross-review-manifest.v1",
});

export const AI_FORMULA_REVIEW_PROMPTS = Object.freeze(canonicalValue({
  deriver: {
    prompt_id: "ai_formula_deriver_v1",
    prompt_text: "Re-derive test expectations only from the hash-bound DSL formula and executable contracts. Preserve unknown semantic fidelity and never issue a human or production approval.",
  },
  adversarial_checker: {
    prompt_id: "ai_formula_adversarial_checker_v1",
    prompt_text: "Independently recompute schema hashes, evidence hashes, test vectors, missing-input behavior, and invariants. Record disagreement or unknown explicitly; never trust the deriver result by assertion.",
  },
  adjudicator: {
    prompt_id: "ai_formula_adjudicator_v1",
    prompt_text: "Compare the two machine records and adjudicate mechanical consistency only. Semantic fidelity to a named investor remains unknown without source and human review; production eligibility must remain false.",
  },
}));

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ARTIFACT_FIELDS = new Set([
  "schema_version", "artifact_kind", "assurance_class", "reviewer_kind", "execution_mode",
  "human_reviewed", "human_claims", "production_effect", "production_eligible",
  "method_model_eligible", "persona_id", "tool_id", "review_schema_hash", "review_subject",
  "review_subject_hash", "role_sequence", "roles", "role_artifact_hashes", "vector_summary",
  "invariant_summary", "disagreement", "unknowns", "adjudication_status",
  "review_artifact_hash",
]);
const ROLE_FIELDS = new Set([
  "role_id", "reviewer_kind", "machine_actor_id", "human_principal", "prompt_id",
  "prompt_text", "prompt_hash", "subject_hash", "result", "artifact_hash",
]);
const SUPPORTED_OPERATIONS = new Set([
  "identity", "add", "subtract", "multiply", "divide", "sum", "mean",
  "min", "max", "abs", "negate", "clamp",
]);
const SEMANTIC_UNKNOWNS = Object.freeze([
  "semantic_equivalence_to_named_investor_method",
  "appropriateness_of_first_declared_input",
  "appropriateness_of_output_as_decision_signal",
  "source_doctrine_fidelity",
]);

export class PersonaV3AIFormulaReviewError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaV3AIFormulaReviewError";
    this.details = canonicalValue(details);
  }
}

function fail(message, details = {}) {
  throw new PersonaV3AIFormulaReviewError(message, details);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function physicalStagingRoot(root, expectedBasename, label, { requireExisting = true } = {}) {
  const resolved = resolve(root);
  if (basename(resolved) !== expectedBasename) fail(`${label} basename must be ${expectedBasename}`);
  const parts = resolved.split(sep);
  const isolatedReviewRoot = parts.includes("staging")
    || (parts.includes("ai-assisted-solo") && parts.includes("reviews"))
    || basename(dirname(resolved)) === "solo-test";
  if (!isolatedReviewRoot) fail(`${label} must be below an isolated staging or AI-assisted review directory`);
  if (!existsSync(resolved)) {
    if (requireExisting) fail(`${label} is missing: ${resolved}`);
    return resolved;
  }
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a plain directory`);
  const physical = realpathSync(resolved);
  const physicalParts = physical.split(sep);
  const physicalIsolated = physicalParts.includes("staging")
    || (physicalParts.includes("ai-assisted-solo") && physicalParts.includes("reviews"))
    || basename(dirname(physical)) === "solo-test";
  if (!physicalIsolated) fail(`${label} must physically resolve below an isolated review directory`);
  return physical;
}

function readPlainJson(root, relativePath, label) {
  const file = resolve(root, relativePath);
  if (!inside(root, file) || !existsSync(file)) fail(`${label} is missing: ${relativePath}`);
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a plain file: ${relativePath}`);
  const physical = realpathSync(file);
  if (!inside(root, physical)) fail(`${label} escapes its root: ${relativePath}`);
  try {
    return JSON.parse(readFileSync(physical, "utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${relativePath} (${error.message})`);
  }
}

function collectFiles(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) fail(`AI formula review tree contains a symlink: ${prefix}${entry.name}`);
    const path = resolve(dir, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...collectFiles(path, `${relativePath}/`));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(relativePath);
    else fail(`AI formula review tree contains an unsupported entry: ${relativePath}`);
  }
  return files;
}

function toolLeaf(personaId, toolId) {
  const prefix = `${personaId}.`;
  if (!toolId.startsWith(prefix)) fail(`${toolId}: tool is not prefixed by ${personaId}`);
  const leaf = toolId.slice(prefix.length);
  if (!/^[a-z][a-z0-9_.-]{1,119}$/u.test(leaf)) fail(`unsafe tool id: ${toolId}`);
  return leaf;
}

export function aiFormulaReviewRelativePath(personaId, toolId) {
  return `${personaId}/reviews/${toolLeaf(personaId, toolId)}.ai-review.json`;
}

function parsedReviewSchema() {
  const parent = dirname(AI_FORMULA_REVIEW_SCHEMA_PATH);
  return readPlainJson(parent, basename(AI_FORMULA_REVIEW_SCHEMA_PATH), "AI formula review schema");
}

export function computeAIFormulaReviewSubjectHash(subject) {
  return sha256({ hash_domain: AI_FORMULA_REVIEW_HASH_DOMAINS.subject, subject });
}

export function computeAIFormulaPromptHash(promptId, promptText) {
  return sha256({
    hash_domain: AI_FORMULA_REVIEW_HASH_DOMAINS.prompt,
    prompt_id: promptId,
    prompt_text: promptText,
  });
}

export function computeAIFormulaRoleArtifactHash(role) {
  const { artifact_hash: _artifactHash, ...payload } = role;
  return sha256(payload);
}

export function computeAIFormulaReviewArtifactHash(artifact) {
  const { review_artifact_hash: _reviewArtifactHash, ...payload } = artifact;
  return sha256({ hash_domain: AI_FORMULA_REVIEW_HASH_DOMAINS.artifact, artifact: payload });
}

export function computeAIFormulaReviewManifestHash(manifest) {
  const { manifest_hash: _manifestHash, ...payload } = manifest;
  return sha256({ hash_domain: AI_FORMULA_REVIEW_HASH_DOMAINS.manifest, manifest: payload });
}

function physicalFormulaRecords(formulaRoot) {
  const root = physicalStagingRoot(
    formulaRoot,
    basename(DEFAULT_SOLO_TEST_FORMULA_ROOT),
    "solo formula root",
  );
  const plan = planSoloTestFormulaCompilation({ outputRoot: formulaRoot });
  const manifest = readPlainJson(root, "compilation-manifest.json", "solo formula manifest");
  if (manifest.compilation_hash !== plan.compilation_hash) {
    fail("physical solo formula manifest is not bound to the current 52-tool compilation", {
      expected: plan.compilation_hash,
      actual: manifest.compilation_hash,
    });
  }

  const records = [];
  const expectedFiles = ["compilation-manifest.json"];
  for (const personaId of CANONICAL_MASTER_IDS) {
    const toolsPath = `${personaId}/components/tools.json`;
    expectedFiles.push(toolsPath);
    const physicalTools = readPlainJson(root, toolsPath, `${personaId} solo tools`);
    const plannedTools = plan.tools.filter((tool) => tool.id.startsWith(`${personaId}.`));
    if (JSON.stringify(canonicalValue(physicalTools)) !== JSON.stringify(canonicalValue(plannedTools))) {
      fail(`${personaId}: physical solo tools drifted from the current compilation`);
    }
    for (const tool of physicalTools) {
      const evidencePath = `${personaId}/provisional-derivations/${toolLeaf(personaId, tool.id)}.derived-proxy-evidence.json`;
      expectedFiles.push(evidencePath);
      const evidence = readPlainJson(root, evidencePath, `${tool.id} derivation evidence`);
      const plannedEvidence = plan.evidence.find((entry) => entry.derivation_spec.tool_id === tool.id);
      if (!plannedEvidence || JSON.stringify(canonicalValue(evidence)) !== JSON.stringify(canonicalValue(plannedEvidence))) {
        fail(`${tool.id}: physical derivation evidence drifted from the current compilation`);
      }
      records.push({ personaId, tool: canonicalValue(tool), evidence: canonicalValue(evidence) });
    }
  }
  const actualFiles = collectFiles(root);
  expectedFiles.sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail("solo formula tree does not contain exactly the bound compilation artifacts", {
      expected: expectedFiles,
      actual: actualFiles,
    });
  }
  return { compilationHash: plan.compilation_hash, records };
}

function formulaContract(tool, evidence) {
  const formula = evidence?.derivation_spec?.formula;
  return canonicalValue({
    version: formula?.version,
    kind: formula?.kind,
    operation: formula?.operation,
    on_missing: formula?.on_missing,
    inputs: formula?.inputs?.map((input) => input.operand),
    input_contracts: formula?.inputs?.map(({ operand: _operand, ...contract }) => contract),
    output_id: formula?.output?.output_id,
    value_kind: formula?.output?.value_kind,
    unit: formula?.output?.unit,
    output_period: formula?.output?.period,
  });
}

function executableContract(tool) {
  return canonicalValue({
    version: tool.version,
    kind: tool.kind,
    operation: tool.operation,
    on_missing: tool.on_missing,
    inputs: tool.inputs,
    input_contracts: tool.input_contracts,
    output_id: tool.output_id,
    value_kind: tool.value_kind,
    unit: tool.unit,
    output_period: tool.output_period,
  });
}

function sampleValues(operation, inputCount, base) {
  const values = Array.from({ length: inputCount }, (_entry, index) => base + (index * 1.25));
  if (operation === "divide" && values[1] === 0) values[1] = 2;
  if (operation === "clamp" && values.length === 3) {
    values[1] = -2;
    values[2] = 2;
  }
  return values;
}

function testVectors(tool) {
  return canonicalValue([
    { vector_id: "finite_negative", input_values: sampleValues(tool.operation, tool.inputs.length, -7.25), missing_input_indexes: [] },
    { vector_id: "finite_zero_boundary", input_values: sampleValues(tool.operation, tool.inputs.length, 0), missing_input_indexes: [] },
    { vector_id: "finite_positive", input_values: sampleValues(tool.operation, tool.inputs.length, 13.5), missing_input_indexes: [] },
    { vector_id: "missing_first_input", input_values: sampleValues(tool.operation, tool.inputs.length, 1), missing_input_indexes: [0] },
  ]);
}

// Deliberately separate implementations: the checker does not call the deriver evaluator.
function deriverOperation(operation, values) {
  if (operation === "identity") return values[0];
  if (operation === "add" || operation === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (operation === "subtract") return values[0] - values[1];
  if (operation === "multiply") return values.reduce((product, value) => product * value, 1);
  if (operation === "divide") return values[1] === 0 ? null : values[0] / values[1];
  if (operation === "mean") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (operation === "min") return Math.min(...values);
  if (operation === "max") return Math.max(...values);
  if (operation === "abs") return Math.abs(values[0]);
  if (operation === "negate") return -values[0];
  if (operation === "clamp") return Math.min(Math.max(values[0], values[1]), values[2]);
  return undefined;
}

function checkerOperation(operation, values) {
  switch (operation) {
    case "identity": return values.at(0);
    case "add":
    case "sum": return values.reduce((accumulator, current) => accumulator + current, 0);
    case "subtract": return values.at(0) - values.at(1);
    case "multiply": return values.reduce((accumulator, current) => accumulator * current, 1);
    case "divide": return values.at(1) === 0 ? null : values.at(0) / values.at(1);
    case "mean": return values.reduce((accumulator, current) => accumulator + current, 0) / values.length;
    case "min": return values.reduce((current, value) => (value < current ? value : current), Number.POSITIVE_INFINITY);
    case "max": return values.reduce((current, value) => (value > current ? value : current), Number.NEGATIVE_INFINITY);
    case "abs": return values.at(0) < 0 ? -values.at(0) : values.at(0);
    case "negate": return 0 - values.at(0);
    case "clamp": return values.at(0) < values.at(1) ? values.at(1) : values.at(0) > values.at(2) ? values.at(2) : values.at(0);
    default: return undefined;
  }
}

function evaluateVector(vector, operation, evaluator) {
  if (vector.missing_input_indexes.length) {
    return canonicalValue({ status: "uncomputable", value: null, error_code: "MISSING_INPUT" });
  }
  if (!SUPPORTED_OPERATIONS.has(operation)) {
    return canonicalValue({ status: "unknown", value: null, error_code: "UNSUPPORTED_OPERATION" });
  }
  const value = evaluator(operation, vector.input_values);
  if (value === null && operation === "divide") {
    return canonicalValue({ status: "uncomputable", value: null, error_code: "DIVISION_BY_ZERO" });
  }
  if (value === undefined || !Number.isFinite(value)) {
    return canonicalValue({ status: "unknown", value: null, error_code: "NON_FINITE_OR_UNKNOWN" });
  }
  return canonicalValue({ status: "computed", value, error_code: null });
}

function promptRole(roleId, subjectHash, result) {
  const prompt = AI_FORMULA_REVIEW_PROMPTS[roleId];
  const payload = canonicalValue({
    role_id: roleId,
    reviewer_kind: "ai",
    machine_actor_id: `alphacouncil.machine.${roleId}.v1`,
    human_principal: false,
    prompt_id: prompt.prompt_id,
    prompt_text: prompt.prompt_text,
    prompt_hash: computeAIFormulaPromptHash(prompt.prompt_id, prompt.prompt_text),
    subject_hash: subjectHash,
    result,
  });
  return canonicalValue({ ...payload, artifact_hash: computeAIFormulaRoleArtifactHash(payload) });
}

function invariant(invariantId, status, evidence) {
  return canonicalValue({ invariant_id: invariantId, status, evidence });
}

function exact(value, expected) {
  return JSON.stringify(canonicalValue(value)) === JSON.stringify(canonicalValue(expected));
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && exact(Object.keys(value).sort(), [...expected].sort());
}

function reviewOne({ personaId, tool, evidence }, compilationHash, reviewSchemaHash) {
  const expectedSchemaHashes = deterministicToolSchemaHashes(tool);
  const subject = canonicalValue({
    schema_version: 1,
    formula_compilation_hash: compilationHash,
    persona_id: personaId,
    tool_id: tool.id,
    tool_content_hash: sha256(tool),
    derivation_evidence_content_hash: sha256(evidence),
    derivation_spec_hash: sha256(evidence.derivation_spec),
    formula_content_hash: sha256(evidence.derivation_spec.formula),
    declared_derivation_spec_hash: tool.derivation_spec_hash,
    declared_derivation_evidence_hash: tool.derivation_evidence_hash,
    declared_input_schema_hash: tool.input_schema_hash,
    declared_output_schema_hash: tool.output_schema_hash,
    recomputed_input_schema_hash: expectedSchemaHashes.input_schema_hash,
    recomputed_output_schema_hash: expectedSchemaHashes.output_schema_hash,
    review_schema_hash: reviewSchemaHash,
  });
  const subjectHash = computeAIFormulaReviewSubjectHash(subject);
  const vectors = testVectors(tool);
  const derivedVectors = vectors.map((vector) => canonicalValue({
    vector_id: vector.vector_id,
    expected: evaluateVector(vector, tool.operation, deriverOperation),
  }));
  const deriver = promptRole("deriver", subjectHash, canonicalValue({
    status: SUPPORTED_OPERATIONS.has(tool.operation) ? "derived" : "unknown",
    formula_contract_hash: sha256(formulaContract(tool, evidence)),
    executable_contract_hash: sha256(executableContract(tool)),
    vector_plan_hash: sha256(vectors),
    test_vectors: derivedVectors,
    semantic_fidelity: "unknown",
    production_disposition: "not_eligible",
  }));

  const recomputedVectors = vectors.map((vector, index) => {
    const actual = evaluateVector(vector, tool.operation, checkerOperation);
    const expected = derivedVectors[index].expected;
    return canonicalValue({
      vector_id: vector.vector_id,
      expected,
      recomputed: actual,
      status: exact(actual, expected) ? "pass" : "disagreement",
    });
  });
  const invariantResults = [
    invariant("input_schema_hash_exact", tool.input_schema_hash === expectedSchemaHashes.input_schema_hash ? "pass" : "fail", expectedSchemaHashes.input_schema_hash),
    invariant("output_schema_hash_exact", tool.output_schema_hash === expectedSchemaHashes.output_schema_hash ? "pass" : "fail", expectedSchemaHashes.output_schema_hash),
    invariant("derivation_evidence_hash_exact", tool.derivation_evidence_hash === sha256(evidence) ? "pass" : "fail", sha256(evidence)),
    invariant("derivation_spec_hash_exact", tool.derivation_spec_hash === sha256(evidence.derivation_spec) && evidence.derivation_spec_hash === sha256(evidence.derivation_spec) ? "pass" : "fail", sha256(evidence.derivation_spec)),
    invariant("formula_tool_contract_exact", exact(formulaContract(tool, evidence), executableContract(tool)) ? "pass" : "fail", sha256({ formula: formulaContract(tool, evidence), executable: executableContract(tool) })),
    invariant("test_vectors_recompute_exact", recomputedVectors.every((vector) => vector.status === "pass") ? "pass" : "fail", sha256(recomputedVectors)),
    invariant("missing_input_fails_closed", recomputedVectors.find((vector) => vector.vector_id === "missing_first_input")?.recomputed?.status === "uncomputable" && tool.on_missing === "fail" ? "pass" : "fail", tool.on_missing),
    invariant("provisional_boundary_intact", tool.production_eligible === false && evidence.production_eligible === false && evidence.method_model_eligible === false && evidence.human_reviewer_ids?.length === 0 && evidence.signature_count === 0 ? "pass" : "fail", "zero_human_zero_signature_non_production"),
  ];
  const disagreementItems = [
    ...recomputedVectors.filter((vector) => vector.status !== "pass").map((vector) => `vector:${vector.vector_id}`),
    ...invariantResults.filter((entry) => entry.status === "fail").map((entry) => `invariant:${entry.invariant_id}`),
  ];
  const unknownItems = [
    ...SEMANTIC_UNKNOWNS,
    ...invariantResults.filter((entry) => entry.status === "unknown").map((entry) => `invariant:${entry.invariant_id}`),
  ];
  const checkerStatus = disagreementItems.length ? "disagreement"
    : recomputedVectors.some((vector) => vector.recomputed.status === "unknown") ? "unknown"
      : "mechanically_consistent";
  const adversarialChecker = promptRole("adversarial_checker", subjectHash, canonicalValue({
    status: checkerStatus,
    bound_deriver_artifact_hash: deriver.artifact_hash,
    independently_recomputed_schema_hashes: expectedSchemaHashes,
    independently_recomputed_vectors: recomputedVectors,
    invariants: invariantResults,
    disagreements: disagreementItems,
    unknowns: unknownItems,
    production_disposition: "not_eligible",
  }));

  const adjudicationStatus = checkerStatus === "disagreement" ? "machine_disagreement"
    : checkerStatus === "unknown" ? "machine_unknown"
      : "machine_consistent_semantics_unknown";
  const adjudicator = promptRole("adjudicator", subjectHash, canonicalValue({
    status: adjudicationStatus,
    bound_deriver_artifact_hash: deriver.artifact_hash,
    bound_adversarial_checker_artifact_hash: adversarialChecker.artifact_hash,
    mechanical_consistency: checkerStatus === "mechanically_consistent" ? "pass" : checkerStatus,
    semantic_fidelity: "unknown",
    disagreements: disagreementItems,
    unknowns: unknownItems,
    human_review_disposition: "not_performed",
    production_disposition: "not_eligible",
  }));

  const vectorPassCount = recomputedVectors.filter((vector) => vector.status === "pass").length;
  const invariantPassCount = invariantResults.filter((entry) => entry.status === "pass").length;
  const payload = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_formula_cross_review",
    assurance_class: AI_FORMULA_REVIEW_ASSURANCE,
    reviewer_kind: "ai",
    execution_mode: "deterministic_review_harness",
    human_reviewed: false,
    human_claims: false,
    production_effect: "none",
    production_eligible: false,
    method_model_eligible: false,
    persona_id: personaId,
    tool_id: tool.id,
    review_schema_hash: reviewSchemaHash,
    review_subject: subject,
    review_subject_hash: subjectHash,
    role_sequence: AI_FORMULA_REVIEW_ROLE_SEQUENCE,
    roles: { deriver, adversarial_checker: adversarialChecker, adjudicator },
    role_artifact_hashes: {
      deriver: deriver.artifact_hash,
      adversarial_checker: adversarialChecker.artifact_hash,
      adjudicator: adjudicator.artifact_hash,
    },
    vector_summary: {
      total: recomputedVectors.length,
      pass: vectorPassCount,
      disagreement: recomputedVectors.length - vectorPassCount,
      vectors_hash: sha256(recomputedVectors),
    },
    invariant_summary: {
      total: invariantResults.length,
      pass: invariantPassCount,
      fail: invariantResults.filter((entry) => entry.status === "fail").length,
      unknown: invariantResults.filter((entry) => entry.status === "unknown").length,
      invariants_hash: sha256(invariantResults),
    },
    disagreement: {
      status: disagreementItems.length ? "present" : "none_detected_on_mechanical_contract",
      items: disagreementItems,
    },
    unknowns: unknownItems,
    adjudication_status: adjudicationStatus,
  });
  return canonicalValue({ ...payload, review_artifact_hash: computeAIFormulaReviewArtifactHash(payload) });
}

function validateRole(role, expectedRoleId, subjectHash, errors) {
  if (!exactKeys(role, ROLE_FIELDS)) errors.push(`roles.${expectedRoleId} fields do not match the review schema`);
  if (role?.role_id !== expectedRoleId) errors.push(`roles.${expectedRoleId}.role_id must be ${expectedRoleId}`);
  if (role?.reviewer_kind !== "ai") errors.push(`roles.${expectedRoleId}.reviewer_kind must be ai`);
  if (role?.human_principal !== false) errors.push(`roles.${expectedRoleId}.human_principal must be false`);
  if (role?.subject_hash !== subjectHash) errors.push(`roles.${expectedRoleId}.subject_hash mismatch`);
  const prompt = AI_FORMULA_REVIEW_PROMPTS[expectedRoleId];
  if (role?.prompt_id !== prompt.prompt_id || role?.prompt_text !== prompt.prompt_text) errors.push(`roles.${expectedRoleId} prompt drift`);
  if (role?.prompt_hash !== computeAIFormulaPromptHash(prompt.prompt_id, prompt.prompt_text)) errors.push(`roles.${expectedRoleId}.prompt_hash mismatch`);
  if (![role?.prompt_hash, role?.subject_hash, role?.artifact_hash].every((hash) => HASH.test(hash || ""))) errors.push(`roles.${expectedRoleId} contains an invalid hash`);
  if (role?.artifact_hash !== computeAIFormulaRoleArtifactHash(role)) errors.push(`roles.${expectedRoleId}.artifact_hash mismatch`);
}

export function validateAIFormulaReviewArtifact(artifact, { reviewSchemaHash = sha256(parsedReviewSchema()) } = {}) {
  const errors = [];
  if (!exactKeys(artifact, ARTIFACT_FIELDS)) errors.push("top-level fields do not match the review schema");
  if (artifact?.schema_version !== 1) errors.push("schema_version must be 1");
  if (artifact?.artifact_kind !== "persona_v3_ai_formula_cross_review") errors.push("artifact_kind mismatch");
  if (artifact?.assurance_class !== AI_FORMULA_REVIEW_ASSURANCE) errors.push("assurance_class mismatch");
  if (artifact?.reviewer_kind !== "ai") errors.push("reviewer_kind must be ai");
  if (artifact?.execution_mode !== "deterministic_review_harness") errors.push("execution_mode mismatch");
  if (artifact?.human_reviewed !== false || artifact?.human_claims !== false) errors.push("human claims must stay false");
  if (artifact?.production_effect !== "none" || artifact?.production_eligible !== false || artifact?.method_model_eligible !== false) errors.push("production boundary must stay closed");
  if (artifact?.review_schema_hash !== reviewSchemaHash) errors.push("review_schema_hash mismatch");
  if (![artifact?.review_schema_hash, artifact?.review_subject_hash, artifact?.review_artifact_hash].every((hash) => HASH.test(hash || ""))) errors.push("artifact contains an invalid hash");
  if (artifact?.review_subject_hash !== computeAIFormulaReviewSubjectHash(artifact?.review_subject)) errors.push("review_subject_hash mismatch");
  if (!exact(artifact?.role_sequence, AI_FORMULA_REVIEW_ROLE_SEQUENCE)) errors.push("role_sequence mismatch");
  for (const roleId of AI_FORMULA_REVIEW_ROLE_SEQUENCE) validateRole(artifact?.roles?.[roleId], roleId, artifact?.review_subject_hash, errors);
  if (new Set(AI_FORMULA_REVIEW_ROLE_SEQUENCE.map((roleId) => artifact?.roles?.[roleId]?.machine_actor_id)).size !== 3) errors.push("machine_actor_id values must be distinct");
  if (new Set(AI_FORMULA_REVIEW_ROLE_SEQUENCE.map((roleId) => artifact?.roles?.[roleId]?.prompt_id)).size !== 3) errors.push("prompt_id values must be distinct");
  for (const roleId of AI_FORMULA_REVIEW_ROLE_SEQUENCE) {
    if (artifact?.role_artifact_hashes?.[roleId] !== artifact?.roles?.[roleId]?.artifact_hash) errors.push(`role_artifact_hashes.${roleId} mismatch`);
  }
  if (artifact?.roles?.adversarial_checker?.result?.bound_deriver_artifact_hash !== artifact?.roles?.deriver?.artifact_hash) errors.push("checker does not bind deriver artifact");
  if (artifact?.roles?.adjudicator?.result?.bound_deriver_artifact_hash !== artifact?.roles?.deriver?.artifact_hash) errors.push("adjudicator does not bind deriver artifact");
  if (artifact?.roles?.adjudicator?.result?.bound_adversarial_checker_artifact_hash !== artifact?.roles?.adversarial_checker?.artifact_hash) errors.push("adjudicator does not bind checker artifact");
  if (!Array.isArray(artifact?.unknowns) || !artifact.unknowns.includes("semantic_equivalence_to_named_investor_method")) errors.push("semantic unknown is required");
  if (!["machine_consistent_semantics_unknown", "machine_disagreement", "machine_unknown"].includes(artifact?.adjudication_status)) errors.push("invalid adjudication_status");
  if (artifact?.review_artifact_hash !== computeAIFormulaReviewArtifactHash(artifact)) errors.push("review_artifact_hash mismatch");
  return errors;
}

/** Plan all 52 records without mutating the physical review tree. */
export function planAIFormulaCrossReviews({ formulaRoot = DEFAULT_SOLO_TEST_FORMULA_ROOT } = {}) {
  const schema = parsedReviewSchema();
  const reviewSchemaHash = sha256(schema);
  const input = physicalFormulaRecords(formulaRoot);
  const reviews = input.records.map((record) => reviewOne(record, input.compilationHash, reviewSchemaHash));
  if (reviews.length !== CANONICAL_MASTER_COUNT * 2 || new Set(reviews.map((review) => review.tool_id)).size !== CANONICAL_MASTER_COUNT * 2) {
    fail("AI formula cross-review must cover exactly 52 unique tools");
  }
  const invalid = reviews.flatMap((review) => validateAIFormulaReviewArtifact(review, { reviewSchemaHash })
    .map((message) => `${review.tool_id}: ${message}`));
  if (invalid.length) fail("generated AI formula reviews are invalid", { errors: invalid });
  const bindings = reviews.map((review) => canonicalValue({
    persona_id: review.persona_id,
    tool_id: review.tool_id,
    path: aiFormulaReviewRelativePath(review.persona_id, review.tool_id),
    review_subject_hash: review.review_subject_hash,
    review_artifact_hash: review.review_artifact_hash,
    review_file_content_hash: sha256(review),
    adjudication_status: review.adjudication_status,
  }));
  const stable = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_formula_cross_review_manifest",
    assurance_class: AI_FORMULA_REVIEW_ASSURANCE,
    reviewer_kind: "ai",
    execution_mode: "deterministic_review_harness",
    human_reviewed: false,
    human_claims: false,
    production_effect: "none",
    production_eligible: false,
    method_model_eligible: false,
    human_reviewer_count: 0,
    signature_count: 0,
    approval_count: 0,
    canonical_seat_count: CANONICAL_MASTER_COUNT,
    formula_compilation_hash: input.compilationHash,
    review_schema_path: "schemas/persona-v3-ai-formula-cross-review-v1.schema.json",
    review_schema_hash: reviewSchemaHash,
    tool_count: reviews.length,
    review_count: reviews.length,
    role_count: reviews.length * AI_FORMULA_REVIEW_ROLE_SEQUENCE.length,
    distinct_role_ids: AI_FORMULA_REVIEW_ROLE_SEQUENCE,
    distinct_prompt_ids: AI_FORMULA_REVIEW_ROLE_SEQUENCE.map((roleId) => AI_FORMULA_REVIEW_PROMPTS[roleId].prompt_id),
    test_vector_count: reviews.reduce((sum, review) => sum + review.vector_summary.total, 0),
    invariant_count: reviews.reduce((sum, review) => sum + review.invariant_summary.total, 0),
    mechanical_pass_count: reviews.filter((review) => review.adjudication_status === "machine_consistent_semantics_unknown").length,
    disagreement_count: reviews.filter((review) => review.adjudication_status === "machine_disagreement").length,
    machine_unknown_count: reviews.filter((review) => review.adjudication_status === "machine_unknown").length,
    semantic_unknown_count: reviews.filter((review) => review.unknowns.includes("semantic_equivalence_to_named_investor_method")).length,
    bindings,
  });
  const manifest = canonicalValue({ ...stable, manifest_hash: computeAIFormulaReviewManifestHash(stable) });
  return Object.freeze({ manifest: Object.freeze(manifest), reviews: Object.freeze(reviews) });
}

function writeStable(file, content, result) {
  const parent = dirname(file);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory()) fail(`unsafe AI formula review directory: ${parent}`);
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) fail(`unsafe AI formula review file: ${file}`);
    if (readFileSync(file, "utf8") === content) {
      result.unchanged.push(file);
      return;
    }
  }
  writeFileSync(file, content, { encoding: "utf8", mode: 0o644 });
  result.written.push(file);
}

/** Write only below the isolated staging review root. */
export function writeAIFormulaCrossReviews({
  outputRoot = DEFAULT_AI_FORMULA_REVIEW_ROOT,
  ...options
} = {}) {
  const plan = planAIFormulaCrossReviews(options);
  const root = physicalStagingRoot(outputRoot, AI_FORMULA_REVIEW_DIRNAME, "AI formula review output root", { requireExisting: false });
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const result = { written: [], unchanged: [] };
  for (const review of plan.reviews) {
    writeStable(
      resolve(root, aiFormulaReviewRelativePath(review.persona_id, review.tool_id)),
      `${JSON.stringify(review, null, 2)}\n`,
      result,
    );
  }
  writeStable(resolve(root, "review-manifest.json"), `${JSON.stringify(plan.manifest, null, 2)}\n`, result);
  return canonicalValue({
    ...plan.manifest,
    mode: "write_isolated_ai_formula_cross_reviews",
    output_root: root,
    written: result.written.map((file) => relative(root, file).split(sep).join("/")),
    unchanged: result.unchanged.map((file) => relative(root, file).split(sep).join("/")),
  });
}

/** Verify exact file membership and byte-stable JSON against a fresh recomputation. */
export function verifyAIFormulaCrossReviewTree({
  reviewRoot = DEFAULT_AI_FORMULA_REVIEW_ROOT,
  ...options
} = {}) {
  const plan = planAIFormulaCrossReviews(options);
  const root = physicalStagingRoot(reviewRoot, AI_FORMULA_REVIEW_DIRNAME, "AI formula review root");
  const expected = new Map([
    ["review-manifest.json", `${JSON.stringify(plan.manifest, null, 2)}\n`],
    ...plan.reviews.map((review) => [
      aiFormulaReviewRelativePath(review.persona_id, review.tool_id),
      `${JSON.stringify(review, null, 2)}\n`,
    ]),
  ]);
  const actualFiles = collectFiles(root);
  const expectedFiles = [...expected.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    fail("AI formula review tree file membership drift", { expected: expectedFiles, actual: actualFiles });
  }
  for (const [relativePath, content] of expected) {
    const actual = readFileSync(resolve(root, relativePath), "utf8");
    if (actual !== content) fail(`AI formula review artifact drift: ${relativePath}`);
  }
  return canonicalValue({
    ...plan.manifest,
    mode: "verify_isolated_ai_formula_cross_reviews",
    review_root: root,
    tree_verified: true,
    physical_file_count: actualFiles.length,
  });
}
