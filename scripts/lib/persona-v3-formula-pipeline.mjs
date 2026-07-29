/**
 * Fail-closed PersonaPack v3 formula authoring and DSL 1.1 compilation pipeline.
 *
 * Inventory construction and compilation are pure functions. Filesystem helpers only read
 * the canonical staging prototypes or, after an explicit caller action, write isolated
 * non-production formula-candidate artifacts. Nothing here writes knowledge/masters,
 * manifests, release evidence, or production registrations.
 */

import { PLANNED_TOOL_COUNT } from "../../data/persona-v3-build-specs.v1.mjs";
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

import buildInventory from "../../data/persona-v3-build-specs.v1.mjs";
import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { deterministicToolSchemaHashes } from "../../mcp/lib/personas-v3/deterministic-executor.mjs";
import {
  completeFormulaSpecHash,
  formulaApprovalEvidenceRelativePath,
  formulaReviewSubject,
  formulaReviewSubjectHash,
  verifyFormulaApprovalBundle,
} from "../../mcp/lib/personas-v3/formula-review-attestations.mjs";
import { CANONICAL_MASTER_COUNT, CANONICAL_MASTER_IDS, defaultStagingRoot } from "../../mcp/lib/personas-v3/staging.mjs";

export { formulaReviewSubject, formulaReviewSubjectHash };

export const FORMULA_SPEC_SCHEMA_VERSION = 1;
export const FORMULA_DSL_VERSION = "1.1";
export const FORMULA_CANDIDATE_DIRNAME = "persona-v3-formula-candidates";
export const DEFAULT_FORMULA_CANDIDATE_ROOT = resolve(defaultStagingRoot(), "..", FORMULA_CANDIDATE_DIRNAME);
export const COMPILED_FORMULA_DIRNAME = "persona-v3-compiled-formulas";
export const DEFAULT_COMPILED_FORMULA_ROOT = resolve(defaultStagingRoot(), "..", COMPILED_FORMULA_DIRNAME);
export const FORMULA_AUTHORING_STATUS = "needs_formula_authorship";
export const FORMULA_EXECUTABLE_STATUS = "executable_candidate";

const ID = /^[a-z][a-z0-9_.:-]{1,159}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const SEMVER = /^\d+\.\d+\.\d+$/u;
const ISO_DURATION = /^P[1-9]\d*[DMY]$/u;
const VALUE_KINDS = new Set(["monetary", "ratio", "count", "scalar"]);
const TOOL_KINDS = new Set(["recomputation", "calculator", "transform"]);
const OPERATIONS = new Set([
  "identity", "add", "subtract", "multiply", "divide", "sum", "mean",
  "min", "max", "abs", "negate", "clamp",
]);
const PERIOD_BASES = new Set(["instant", "duration", "forecast_horizon", "not_applicable"]);
const PERIOD_ALIGNMENTS = new Set(["exact", "same_period", "as_of", "not_applicable"]);
const PROVENANCE_BASES = new Set(["primary_source_formula", "standard_definition", "reviewed_internal_derivation"]);
const UNRESOLVED_CONTRACTS = Object.freeze([
  "formula", "operation", "input", "output", "unit", "period", "on_missing", "provenance", "review",
]);
const EXACT_OPERATION_ARITY = Object.freeze({
  identity: [1, 1],
  abs: [1, 1],
  negate: [1, 1],
  subtract: [2, 2],
  divide: [2, 2],
  clamp: [3, 3],
  add: [1, Infinity],
  multiply: [1, Infinity],
  sum: [1, Infinity],
  mean: [1, Infinity],
  min: [1, Infinity],
  max: [1, Infinity],
});

export class PersonaV3FormulaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaV3FormulaError";
    this.details = canonicalValue(details);
  }
}

function fail(message, details = {}) {
  throw new PersonaV3FormulaError(message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exactKeys(value, expected, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path}: must be an object`);
    return false;
  }
  const actual = Object.keys(value);
  for (const key of expected) if (!hasOwn(value, key)) errors.push(`${path}: missing required field ${key}`);
  for (const key of actual) if (!expected.includes(key)) errors.push(`${path}: unknown field ${JSON.stringify(key)}`);
  return true;
}

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

function validateUniqueStrings(value, path, errors, { nonEmpty = true, ids = false } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    errors.push(`${path}: must be ${nonEmpty ? "a non-empty" : "an"} array`);
    return;
  }
  const seen = new Set();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim() || (ids && !validId(item))) errors.push(`${path}[${index}]: is invalid`);
    else if (seen.has(item)) errors.push(`${path}[${index}]: duplicate ${JSON.stringify(item)}`);
    seen.add(item);
  });
}

function validatePeriod(period, path, errors) {
  if (!exactKeys(period, ["basis", "window", "alignment"], path, errors)) return;
  if (!PERIOD_BASES.has(period.basis)) errors.push(`${path}.basis: is invalid`);
  if (!PERIOD_ALIGNMENTS.has(period.alignment)) errors.push(`${path}.alignment: is invalid`);
  const windowValid = period.window === null || (typeof period.window === "string" && ISO_DURATION.test(period.window));
  if (!windowValid) errors.push(`${path}.window: must be null or an ISO-8601 duration`);
  if (["instant", "not_applicable"].includes(period.basis) && period.window !== null) errors.push(`${path}.window: must be null for ${period.basis}`);
  if (["duration", "forecast_horizon"].includes(period.basis) && period.window === null) errors.push(`${path}.window: is required for ${period.basis}`);
  if (period.basis === "not_applicable" && period.alignment !== "not_applicable") errors.push(`${path}.alignment: must be not_applicable`);
  if (period.basis !== "not_applicable" && period.alignment === "not_applicable") errors.push(`${path}.alignment: cannot be not_applicable`);
}

function validateOperand(operand, path, errors) {
  if (!isObject(operand)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  const keys = Object.keys(operand);
  if (keys.length !== 1 || !["fact_id", "output_id", "literal"].includes(keys[0])) {
    errors.push(`${path}: must contain exactly one of fact_id, output_id, or literal`);
    return;
  }
  if (keys[0] === "literal") {
    if (typeof operand.literal !== "number" || !Number.isFinite(operand.literal)) errors.push(`${path}.literal: must be a finite number`);
  } else if (!validId(operand[keys[0]])) errors.push(`${path}.${keys[0]}: is invalid`);
}

function validateInput(input, index, formula, spec, errors) {
  const path = `formula.inputs[${index}]`;
  if (!exactKeys(input, ["operand", "value_kind", "unit", "period", "on_missing"], path, errors)) return;
  validateOperand(input.operand, `${path}.operand`, errors);
  if (!VALUE_KINDS.has(input.value_kind)) errors.push(`${path}.value_kind: is invalid`);
  if (typeof input.unit !== "string" || !input.unit.trim()) errors.push(`${path}.unit: is required`);
  validatePeriod(input.period, `${path}.period`, errors);
  if (!["fail", "skip"].includes(input.on_missing)) errors.push(`${path}.on_missing: must be fail or skip`);
  if (input.on_missing !== formula.on_missing) errors.push(`${path}.on_missing: must equal formula.on_missing`);
  if (hasOwn(input.operand || {}, "fact_id") && !spec.authorship_request.candidate_input_fact_types.includes(input.operand.fact_id)) {
    errors.push(`${path}.operand.fact_id: is not declared by the source prototype`);
  }
}

function validateFormula(formula, spec, errors) {
  const fields = ["version", "kind", "operation", "on_missing", "inputs", "output"];
  if (!exactKeys(formula, fields, "formula", errors)) return;
  if (!SEMVER.test(formula.version || "")) errors.push("formula.version: must be semver x.y.z");
  if (!TOOL_KINDS.has(formula.kind)) errors.push("formula.kind: is invalid");
  if (!OPERATIONS.has(formula.operation)) errors.push("formula.operation: is not supported by DSL 1.1");
  if (!["fail", "skip"].includes(formula.on_missing)) errors.push("formula.on_missing: must be fail or skip");
  if (!Array.isArray(formula.inputs) || formula.inputs.length === 0) errors.push("formula.inputs: must be a non-empty array");
  else formula.inputs.forEach((input, index) => validateInput(input, index, formula, spec, errors));
  if (OPERATIONS.has(formula.operation) && Array.isArray(formula.inputs)) {
    const [minimum, maximum] = EXACT_OPERATION_ARITY[formula.operation];
    if (formula.inputs.length < minimum || formula.inputs.length > maximum) {
      errors.push(`formula.inputs: ${formula.operation} requires ${minimum === maximum ? minimum : `at least ${minimum}`} input(s)`);
    }
  }
  if (exactKeys(formula.output, ["output_id", "value_kind", "unit", "period"], "formula.output", errors)) {
    if (!validId(formula.output.output_id)) errors.push("formula.output.output_id: is invalid");
    if (!spec.authorship_request.candidate_output_fact_types.includes(formula.output.output_id)) {
      errors.push("formula.output.output_id: must select one output declared by the source prototype");
    }
    if (!VALUE_KINDS.has(formula.output.value_kind)) errors.push("formula.output.value_kind: is invalid");
    if (typeof formula.output.unit !== "string" || !formula.output.unit.trim()) errors.push("formula.output.unit: is required");
    validatePeriod(formula.output.period, "formula.output.period", errors);
  }
}

function validateProvenance(provenance, errors) {
  const fields = ["basis_type", "source_ids", "formula_citation", "author_id", "authored_at", "source_as_of"];
  if (!exactKeys(provenance, fields, "provenance", errors)) return;
  if (!PROVENANCE_BASES.has(provenance.basis_type)) errors.push("provenance.basis_type: is invalid");
  validateUniqueStrings(provenance.source_ids, "provenance.source_ids", errors);
  for (const field of ["formula_citation", "author_id", "authored_at", "source_as_of"]) {
    if (typeof provenance[field] !== "string" || !provenance[field].trim()) errors.push(`provenance.${field}: is required`);
  }
  if (typeof provenance.authored_at === "string" && !Number.isFinite(Date.parse(provenance.authored_at))) errors.push("provenance.authored_at: must be an ISO date-time");
  if (typeof provenance.source_as_of === "string" && !/^\d{4}-\d{2}-\d{2}$/u.test(provenance.source_as_of)) errors.push("provenance.source_as_of: must be YYYY-MM-DD");
}

function validateReview(review, errors) {
  const fields = ["status", "reviewer_ids", "reviewed_at", "approval_reference", "review_subject_hash"];
  if (!exactKeys(review, fields, "review", errors)) return;
  if (!["pending_human_adjudication", "approved", "rejected"].includes(review.status)) errors.push("review.status: is invalid");
  validateUniqueStrings(review.reviewer_ids, "review.reviewer_ids", errors, { nonEmpty: false });
  if (review.reviewed_at !== null && (typeof review.reviewed_at !== "string" || !Number.isFinite(Date.parse(review.reviewed_at)))) errors.push("review.reviewed_at: must be null or an ISO date-time");
  if (review.approval_reference !== null && (typeof review.approval_reference !== "string" || !review.approval_reference.trim())) errors.push("review.approval_reference: must be null or non-empty");
  if (review.review_subject_hash !== null && !HASH.test(review.review_subject_hash)) errors.push("review.review_subject_hash: is invalid");
}

/** Exact semantic validation used even when a JSON-Schema engine is unavailable. */
export function validateFormulaSpec(spec) {
  const errors = [];
  const fields = [
    "schema_version", "artifact_kind", "artifact_status", "formula_spec_id", "persona_id",
    "prototype_id", "tool_id", "dsl_target", "production_effect", "prototype_provenance", "authorship_request",
    "formula", "provenance", "review",
  ];
  if (!exactKeys(spec, fields, "formula_spec", errors)) return errors;
  if (spec.schema_version !== FORMULA_SPEC_SCHEMA_VERSION) errors.push("schema_version: must be 1");
  if (spec.artifact_kind !== "persona_v3_formula_spec") errors.push("artifact_kind: is invalid");
  if (![FORMULA_AUTHORING_STATUS, FORMULA_EXECUTABLE_STATUS].includes(spec.artifact_status)) errors.push("artifact_status: is invalid");
  for (const field of ["formula_spec_id", "prototype_id", "tool_id"]) if (!validId(spec[field])) errors.push(`${field}: is invalid`);
  if (typeof spec.persona_id !== "string" || !/^master_[a-z0-9_]+$/u.test(spec.persona_id)) errors.push("persona_id: is invalid");
  if (validId(spec.tool_id) && !spec.tool_id.startsWith(`${spec.persona_id}.`)) errors.push("tool_id: must be persona-prefixed");
  if (validId(spec.prototype_id) && spec.prototype_id !== `${spec.tool_id}.prototype_v1`) errors.push("prototype_id: must match tool_id");
  if (validId(spec.formula_spec_id) && spec.formula_spec_id !== `${spec.prototype_id}.formula_spec_v1`) errors.push("formula_spec_id: must match prototype_id");
  if (spec.dsl_target !== FORMULA_DSL_VERSION) errors.push("dsl_target: must be 1.1");
  if (spec.production_effect !== "none") errors.push("production_effect: must be none");
  if (exactKeys(spec.prototype_provenance, ["source_path", "source_content_hash"], "prototype_provenance", errors)) {
    const expectedPath = `knowledge/staging/personas-v3/${spec.persona_id}/artifacts/tools.json`;
    if (spec.prototype_provenance.source_path !== expectedPath) errors.push(`prototype_provenance.source_path: must be ${expectedPath}`);
    if (!HASH.test(spec.prototype_provenance.source_content_hash || "")) errors.push("prototype_provenance.source_content_hash: is invalid");
  }

  const requestFields = [
    "operation_family", "purpose", "candidate_input_fact_types", "candidate_output_fact_types",
    "computation_steps", "unresolved_contracts", "blocking_reasons",
  ];
  if (exactKeys(spec.authorship_request, requestFields, "authorship_request", errors)) {
    if (typeof spec.authorship_request.operation_family !== "string" || !spec.authorship_request.operation_family.trim()) errors.push("authorship_request.operation_family: is required");
    if (typeof spec.authorship_request.purpose !== "string" || !spec.authorship_request.purpose.trim()) errors.push("authorship_request.purpose: is required");
    validateUniqueStrings(spec.authorship_request.candidate_input_fact_types, "authorship_request.candidate_input_fact_types", errors, { ids: true });
    validateUniqueStrings(spec.authorship_request.candidate_output_fact_types, "authorship_request.candidate_output_fact_types", errors, { ids: true });
    validateUniqueStrings(spec.authorship_request.computation_steps, "authorship_request.computation_steps", errors);
    validateUniqueStrings(spec.authorship_request.unresolved_contracts, "authorship_request.unresolved_contracts", errors);
    validateUniqueStrings(spec.authorship_request.blocking_reasons, "authorship_request.blocking_reasons", errors);
  }
  validateReview(spec.review, errors);

  if (spec.artifact_status === FORMULA_AUTHORING_STATUS) {
    if (spec.formula !== null) errors.push("formula: must be null until authored and approved");
    if (spec.provenance !== null) errors.push("provenance: must be null until authored and approved");
    if (spec.review?.status !== "pending_human_adjudication") errors.push("review.status: must remain pending_human_adjudication");
    if (spec.review?.reviewer_ids?.length) errors.push("review.reviewer_ids: must remain empty");
    for (const field of ["reviewed_at", "approval_reference", "review_subject_hash"]) if (spec.review?.[field] !== null) errors.push(`review.${field}: must remain null`);
  }
  if (spec.artifact_status === FORMULA_EXECUTABLE_STATUS) {
    if (!isObject(spec.formula)) errors.push("formula: is required for executable_candidate");
    else validateFormula(spec.formula, spec, errors);
    if (!isObject(spec.provenance)) errors.push("provenance: is required for executable_candidate");
    else validateProvenance(spec.provenance, errors);
    if (spec.review?.status !== "approved") errors.push("review.status: must be approved");
    if (!Array.isArray(spec.review?.reviewer_ids) || spec.review.reviewer_ids.length < 2) errors.push("review.reviewer_ids: requires at least two reviewers");
    if (!spec.review?.reviewed_at) errors.push("review.reviewed_at: is required");
    if (!spec.review?.approval_reference) errors.push("review.approval_reference: is required");
    if (spec.review?.review_subject_hash !== formulaReviewSubjectHash(spec)) errors.push("review.review_subject_hash: does not match the immutable review subject");
  }
  return errors;
}

function pendingFormulaSpec(prototype, prototypePath) {
  const blockingReasons = [
    "operation_family_does_not_select_one_exact_dsl_operation",
    "ordered_input_operands_and_literal_parameters_are_unresolved",
    "input_and_output_units_are_unresolved",
    "period_basis_window_and_alignment_are_unresolved",
    "on_missing_behavior_has_not_been_authored_at_formula_level",
    "formula_provenance_and_human_review_are_pending",
  ];
  if (prototype.output_fact_types.length !== 1) blockingReasons.push("one_primary_dsl_output_has_not_been_selected");
  return canonicalValue({
    schema_version: FORMULA_SPEC_SCHEMA_VERSION,
    artifact_kind: "persona_v3_formula_spec",
    artifact_status: FORMULA_AUTHORING_STATUS,
    formula_spec_id: `${prototype.prototype_id}.formula_spec_v1`,
    persona_id: prototype.persona_id,
    prototype_id: prototype.prototype_id,
    tool_id: prototype.tool_id,
    dsl_target: FORMULA_DSL_VERSION,
    production_effect: "none",
    prototype_provenance: {
      source_path: prototypePath,
      source_content_hash: prototype.content_hash,
    },
    authorship_request: {
      operation_family: prototype.operation_family,
      purpose: prototype.purpose,
      candidate_input_fact_types: prototype.input_fact_types,
      candidate_output_fact_types: prototype.output_fact_types,
      computation_steps: prototype.computation_steps,
      unresolved_contracts: UNRESOLVED_CONTRACTS,
      blocking_reasons: blockingReasons,
    },
    formula: null,
    provenance: null,
    review: {
      status: "pending_human_adjudication",
      reviewer_ids: [],
      reviewed_at: null,
      approval_reference: null,
      review_subject_hash: null,
    },
  });
}

/** Build the authoring queue from already-read prototype documents. */
export function buildFormulaAuthoringInventory(prototypeArtifacts) {
  if (!Array.isArray(prototypeArtifacts)) fail("prototypeArtifacts must be an array");
  const byPersona = new Map(prototypeArtifacts.map((artifact) => [artifact?.document?.persona_id, artifact]));
  const entries = [];
  const globalErrors = [];
  for (const personaId of CANONICAL_MASTER_IDS) {
    const artifact = byPersona.get(personaId);
    const document = artifact?.document;
    if (!artifact) {
      globalErrors.push(`${personaId}: missing tools.json prototype artifact`);
      continue;
    }
    if (document?.persona_id !== personaId || document?.artifact_kind !== "persona_v3_computation_prototypes_draft") {
      globalErrors.push(`${personaId}: invalid tools.json identity`);
      continue;
    }
    if (document.dsl_target !== FORMULA_DSL_VERSION || document.execution_allowed !== false || document.production_effect !== "none") {
      globalErrors.push(`${personaId}: prototype weakens the non-production DSL boundary`);
    }
    if (!Array.isArray(document.computations) || document.computations.length !== 2) {
      globalErrors.push(`${personaId}: expected exactly two computation prototypes`);
      continue;
    }
    for (const computation of document.computations) {
      const prototype = { ...computation, persona_id: personaId, content_hash: sha256(document) };
      if (computation.formula_status !== "not_encoded_pending_human_adjudication"
        || computation.implementation_status !== "planned_unverified"
        || computation.on_missing_critical !== "abstain") {
        globalErrors.push(`${computation.prototype_id || personaId}: prototype is not fail-closed and unearned`);
      }
      const formulaSpec = pendingFormulaSpec(prototype, artifact.relative_path);
      const errors = validateFormulaSpec(formulaSpec);
      entries.push(canonicalValue({
        queue_index: entries.length + 1,
        persona_id: personaId,
        prototype_id: computation.prototype_id,
        tool_id: computation.tool_id,
        source_prototype: {
          path: formulaSpec.prototype_provenance.source_path,
          content_hash: formulaSpec.prototype_provenance.source_content_hash,
        },
        artifact_status: formulaSpec.artifact_status,
        blocking_reasons: formulaSpec.authorship_request.blocking_reasons,
        formula_spec: formulaSpec,
        validation_errors: errors,
      }));
    }
  }
  const duplicatePrototypeIds = entries.map((entry) => entry.prototype_id)
    .filter((id, index, values) => values.indexOf(id) !== index);
  if (duplicatePrototypeIds.length) globalErrors.push(`duplicate prototype ids: ${[...new Set(duplicatePrototypeIds)].join(", ")}`);
  const candidateCount = entries.filter((entry) => entry.artifact_status === FORMULA_EXECUTABLE_STATUS).length;
  const pendingCount = entries.filter((entry) => entry.artifact_status === FORMULA_AUTHORING_STATUS).length;
  const stable = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_formula_authoring_inventory",
    inventory_status: "fail_closed_non_production",
    dsl_target: FORMULA_DSL_VERSION,
    canonical_seat_count: CANONICAL_MASTER_COUNT,
    prototype_count: entries.length,
    needs_formula_authorship_count: pendingCount,
    executable_candidate_count: candidateCount,
    dedicated_tool_count: 0,
    production_effect: "none",
    global_errors: globalErrors,
    entries,
  });
  return Object.freeze(canonicalValue({ ...stable, inventory_hash: sha256(stable) }));
}

function assertPrototypeBinding(spec, prototypeDocument) {
  if (!isObject(prototypeDocument)) fail("the current source prototype document is required for compilation");
  const actualHash = sha256(prototypeDocument);
  if (actualHash !== spec.prototype_provenance.source_content_hash) {
    fail("formula spec is not bound to the current source prototype", {
      expected: spec.prototype_provenance.source_content_hash,
      actual: actualHash,
    });
  }
  const prototype = prototypeDocument.computations?.find((entry) => entry.prototype_id === spec.prototype_id);
  if (!prototype || prototype.tool_id !== spec.tool_id) fail("formula spec prototype identity is absent from the bound source document");
}

/** Compile one content-bound, cryptographically approved formula spec to one exact DSL 1.1 tool. */
export function compileApprovedFormulaSpec(spec, {
  prototypeDocument,
  approvalBundle,
  trustedFormulaReviewerKeys,
  now = new Date(),
} = {}) {
  const errors = validateFormulaSpec(spec);
  if (errors.length) fail("formula spec is invalid or unapproved", { errors });
  if (spec.artifact_status !== FORMULA_EXECUTABLE_STATUS) {
    fail("formula spec fails closed until formula authorship and human approval are complete", { artifact_status: spec.artifact_status });
  }
  assertPrototypeBinding(spec, prototypeDocument);
  if (!approvalBundle) fail("a signed formula approval bundle is required for compilation");
  const approval = verifyFormulaApprovalBundle(approvalBundle, {
    trustedKeyRegistry: trustedFormulaReviewerKeys,
    now,
    expectedFormulaSpec: spec,
  });
  if (!approval.valid) fail(`formula approval bundle is invalid: ${approval.reason}`, { approval });
  const formula = spec.formula;
  const record = canonicalValue({
    schema_version: 1,
    dsl_version: FORMULA_DSL_VERSION,
    id: spec.tool_id,
    version: formula.version,
    kind: formula.kind,
    operation: formula.operation,
    on_missing: formula.on_missing,
    inputs: formula.inputs.map((input) => input.operand),
    input_contracts: formula.inputs.map(({ operand: _operand, ...contract }) => contract),
    output_id: formula.output.output_id,
    value_kind: formula.output.value_kind,
    unit: formula.output.unit,
    output_period: formula.output.period,
    source_ids: spec.provenance.source_ids,
    formula_spec_id: spec.formula_spec_id,
    formula_spec_hash: completeFormulaSpecHash(spec),
    formula_review_subject_hash: approval.review_subject_hash,
    approval_bundle_hash: approval.approval_bundle_hash,
  });
  return Object.freeze(canonicalValue({ ...record, ...deterministicToolSchemaHashes(record) }));
}

/** Compile an ordered approved set to the exact JSON array used by PersonaPack v3 tools.json. */
export function compileApprovedFormulaSpecs(specs, {
  prototypeDocuments = {},
  approvalBundles = {},
  trustedFormulaReviewerKeys,
  now = new Date(),
} = {}) {
  if (!Array.isArray(specs) || specs.length === 0) fail("at least one approved formula spec is required");
  const tools = specs.map((spec) => compileApprovedFormulaSpec(spec, {
    prototypeDocument: prototypeDocuments[spec.prototype_provenance?.source_path],
    approvalBundle: approvalBundles[spec.formula_spec_id] || approvalBundles[spec.tool_id],
    trustedFormulaReviewerKeys,
    now,
  }));
  const ids = tools.map((tool) => tool.id);
  const outputs = tools.map((tool) => tool.output_id);
  if (new Set(ids).size !== ids.length) fail("compiled tools contain duplicate tool ids");
  if (new Set(outputs).size !== outputs.length) fail("compiled tools contain duplicate output ids");
  const produced = new Set();
  for (const tool of tools) {
    for (const input of tool.inputs) {
      if (hasOwn(input, "output_id") && !produced.has(input.output_id)) {
        fail(`compiled tool ${tool.id} contains a forward or unknown output reference`, { output_id: input.output_id });
      }
    }
    produced.add(tool.output_id);
  }
  return Object.freeze(tools);
}

function formulaCandidateLeaf(personaId, toolId) {
  if (typeof toolId !== "string" || !toolId.startsWith(`${personaId}.`)) fail("formula candidate tool id is not persona-prefixed");
  const leaf = toolId.slice(personaId.length + 1);
  if (!/^[a-z][a-z0-9_.-]{1,119}$/u.test(leaf)) fail(`formula candidate tool id is unsafe: ${toolId}`);
  return leaf;
}

export function formulaSpecCandidateRelativePath(personaId, toolId) {
  return `specs/${personaId}/${formulaCandidateLeaf(personaId, toolId)}.formula-spec.json`;
}

export function formulaApprovalCandidateRelativePath(personaId, toolId) {
  return `approvals/${personaId}/${formulaCandidateLeaf(personaId, toolId)}.approval-bundle.json`;
}

function plainCandidateRoot(root) {
  const resolved = candidateRootSafe(root);
  if (!existsSync(resolved)) fail(`formula candidate root is missing: ${resolved}`);
  const physical = realpathSync(resolved);
  if (!physical.split(sep).includes("staging")) fail("formula candidate root must physically resolve below staging");
  return physical;
}

function readCandidateJson(root, relativePath) {
  const file = resolve(root, relativePath);
  if (!inside(root, file) || !existsSync(file)) fail(`formula candidate file is missing: ${relativePath}`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`formula candidate file must be a plain file: ${relativePath}`);
  const physical = realpathSync(file);
  if (!inside(root, physical)) fail(`formula candidate file escapes its root: ${relativePath}`);
  try { return JSON.parse(readFileSync(physical, "utf8")); } catch (error) {
    fail(`formula candidate file is invalid JSON: ${relativePath} (${error.message})`);
  }
}

function collectJsonFiles(root, dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) fail(`formula candidate tree contains a symlink: ${prefix}${entry.name}`);
    const path = resolve(dir, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) result.push(...collectJsonFiles(root, path, `${relativePath}/`));
    else if (entry.isFile() && entry.name.endsWith(".json")) result.push(relativePath);
    else fail(`formula candidate tree contains an unsupported entry: ${relativePath}`);
  }
  return result;
}

/** Read and verify every human-authored spec and dual-signed bundles without writing. */
export function planApprovedFormulaCompilation({
  candidateRoot = DEFAULT_FORMULA_CANDIDATE_ROOT,
  root = defaultStagingRoot(),
  trustedFormulaReviewerKeys,
  now = new Date(),
} = {}) {
  if (trustedFormulaReviewerKeys === undefined || trustedFormulaReviewerKeys === null) {
    fail("trusted formula reviewer keys are required for approved compilation");
  }
  const candidate = plainCandidateRoot(candidateRoot);
  const authoring = planPersonaV3FormulaPipeline({ root });
  if (authoring.errors.length) fail("formula prototype inventory is invalid", { errors: authoring.errors });
  const expectedSpecFiles = [];
  const expectedApprovalFiles = [];
  const specs = [];
  const approvalBundles = {};
  for (const entry of authoring.inventory.entries) {
    const specPath = formulaSpecCandidateRelativePath(entry.persona_id, entry.tool_id);
    const approvalPath = formulaApprovalCandidateRelativePath(entry.persona_id, entry.tool_id);
    expectedSpecFiles.push(specPath.slice("specs/".length));
    expectedApprovalFiles.push(approvalPath.slice("approvals/".length));
    const spec = readCandidateJson(candidate, specPath);
    const bundle = readCandidateJson(candidate, approvalPath);
    if (spec.formula_spec_id !== entry.formula_spec.formula_spec_id || spec.tool_id !== entry.tool_id) {
      fail(`${entry.tool_id}: formula spec does not match the planned inventory identity`);
    }
    specs.push(spec);
    approvalBundles[spec.formula_spec_id] = bundle;
  }
  const actualSpecFiles = collectJsonFiles(candidate, resolve(candidate, "specs"));
  const actualApprovalFiles = collectJsonFiles(candidate, resolve(candidate, "approvals"));
  if (JSON.stringify(actualSpecFiles) !== JSON.stringify(expectedSpecFiles.sort())) {
    fail("approved formula compilation requires exactly the planned spec files, one per tool", { expected: expectedSpecFiles.sort(), actual: actualSpecFiles });
  }
  if (JSON.stringify(actualApprovalFiles) !== JSON.stringify(expectedApprovalFiles.sort())) {
    fail("approved formula compilation requires exactly the planned approval bundles, one per tool", { expected: expectedApprovalFiles.sort(), actual: actualApprovalFiles });
  }
  const prototypeDocuments = Object.fromEntries(readFormulaPrototypeArtifacts({ root })
    .map((artifact) => [artifact.relative_path, artifact.document]));
  const tools = compileApprovedFormulaSpecs(specs, {
    prototypeDocuments,
    approvalBundles,
    trustedFormulaReviewerKeys,
    now,
  });
  const expectedIds = authoring.inventory.entries.map((entry) => entry.tool_id);
  const actualIds = tools.map((tool) => tool.id);
  if (actualIds.length !== PLANNED_TOOL_COUNT || new Set(actualIds).size !== PLANNED_TOOL_COUNT
    || JSON.stringify([...actualIds].sort()) !== JSON.stringify([...expectedIds].sort())) {
    fail("approved compilation must produce exactly the planned unique tool ids, one per tool", { expected_ids: expectedIds, actual_ids: actualIds });
  }
  const bindings = tools.map((tool) => canonicalValue({
    persona_id: tool.id.split(".")[0],
    tool_id: tool.id,
    formula_spec_id: tool.formula_spec_id,
    formula_spec_hash: tool.formula_spec_hash,
    formula_review_subject_hash: tool.formula_review_subject_hash,
    approval_bundle_hash: tool.approval_bundle_hash,
    reviewer_principal_ids: approvalBundles[tool.formula_spec_id].formula_spec.review.reviewer_ids,
    source_ids: tool.source_ids,
  }));
  const stable = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_approved_formula_compilation",
    mode: "check_only",
    production_effect: "none",
    canonical_seat_count: CANONICAL_MASTER_COUNT,
    planned_tool_count: PLANNED_TOOL_COUNT,
    compiled_tool_count: tools.length,
    formula_approval_binding_count: bindings.length,
    tool_ids: actualIds,
    bindings,
  });
  return Object.freeze({
    ...stable,
    compilation_hash: sha256(stable),
    tools: Object.freeze(tools),
    specs: Object.freeze(specs),
    approval_bundles: Object.freeze(canonicalValue(approvalBundles)),
  });
}

function compiledRootSafe(root) {
  const resolved = resolve(root);
  if (basename(resolved) !== COMPILED_FORMULA_DIRNAME) fail(`compiled root basename must be ${COMPILED_FORMULA_DIRNAME}`);
  if (!resolved.split(sep).includes("staging")) fail("compiled formulas may only be written below a staging directory");
  if (existsSync(resolved) && (lstatSync(resolved).isSymbolicLink() || !statSync(resolved).isDirectory())) fail("compiled formula root must be a real directory");
  return resolved;
}

/** Explicitly write verified tools and their exact evidence into an isolated staging tree. */
export function writeApprovedFormulaCompilation({ outputRoot = DEFAULT_COMPILED_FORMULA_ROOT, ...options } = {}) {
  const plan = planApprovedFormulaCompilation(options);
  const root = compiledRootSafe(outputRoot);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const result = { written: [], unchanged: [] };
  for (const personaId of CANONICAL_MASTER_IDS) {
    const tools = plan.tools.filter((tool) => tool.id.startsWith(`${personaId}.`));
    writeStable(resolve(root, personaId, "components/tools.json"), `${JSON.stringify(tools, null, 2)}\n`, result);
    for (const tool of tools) {
      const bundle = plan.approval_bundles[tool.formula_spec_id];
      writeStable(resolve(root, personaId, formulaApprovalEvidenceRelativePath(personaId, tool.id)), `${JSON.stringify(bundle, null, 2)}\n`, result);
    }
  }
  const manifest = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_compiled_formula_staging_tree",
    production_effect: "none",
    canonical_seat_count: plan.canonical_seat_count,
    compiled_tool_count: plan.compiled_tool_count,
    formula_approval_binding_count: plan.formula_approval_binding_count,
    compilation_hash: plan.compilation_hash,
    bindings: plan.bindings,
  });
  writeStable(resolve(root, "compilation-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, result);
  return Object.freeze(canonicalValue({
    ...manifest,
    mode: "write_isolated_staging_compilation",
    output_root: root,
    written: result.written.map((file) => relative(root, file).split(sep).join("/")),
    unchanged: result.unchanged.map((file) => relative(root, file).split(sep).join("/")),
  }));
}

export function readFormulaPrototypeArtifacts({ root = defaultStagingRoot() } = {}) {
  const resolvedRoot = resolve(root);
  return CANONICAL_MASTER_IDS.map((personaId) => {
    const file = resolve(resolvedRoot, personaId, "artifacts/tools.json");
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) fail(`${personaId}: tools.json must be a real file`);
    const relativePath = relative(resolve(resolvedRoot, "..", "..", ".."), file).split(sep).join("/");
    let document;
    try {
      document = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      fail(`${personaId}: invalid tools.json (${error.message})`);
    }
    return Object.freeze({ relative_path: relativePath, document });
  });
}

export function planPersonaV3FormulaPipeline(options = {}) {
  const inventory = buildFormulaAuthoringInventory(readFormulaPrototypeArtifacts(options));
  const expected = buildInventory.seats.reduce((total, seat) => total + seat.planned_dedicated_tools.length, 0);
  const errors = [...inventory.global_errors];
  if (inventory.canonical_seat_count !== buildInventory.seat_count) errors.push("canonical seat count drifted");
  if (inventory.prototype_count !== expected || expected !== PLANNED_TOOL_COUNT) errors.push(`prototype inventory must be exactly ${PLANNED_TOOL_COUNT}, got ${inventory.prototype_count}/${expected}`);
  if (inventory.entries.some((entry) => entry.validation_errors.length)) errors.push("one or more generated formula specs are invalid");
  if (inventory.executable_candidate_count !== 0 || inventory.dedicated_tool_count !== 0) errors.push("unreviewed prototypes must not become executable or dedicated tools");
  return Object.freeze(canonicalValue({ mode: "check_plan", errors, inventory }));
}

function candidateRootSafe(root) {
  const resolved = resolve(root);
  if (basename(resolved) !== FORMULA_CANDIDATE_DIRNAME) fail(`candidate root basename must be ${FORMULA_CANDIDATE_DIRNAME}`);
  if (!resolved.split(sep).includes("staging")) fail("formula candidates may only be written below a staging directory");
  if (existsSync(resolved) && (lstatSync(resolved).isSymbolicLink() || !statSync(resolved).isDirectory())) fail("candidate root must be a real directory");
  return resolved;
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function writeStable(file, content, result) {
  const parent = dirname(file);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory()) fail(`unsafe candidate directory: ${parent}`);
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) fail(`unsafe candidate file: ${file}`);
    if (readFileSync(file, "utf8") === content) {
      result.unchanged.push(file);
      return;
    }
  }
  writeFileSync(file, content, { encoding: "utf8", mode: 0o644 });
  result.written.push(file);
}

/** Explicit write path: isolated staging candidate specs and inventory only. */
export function writePersonaV3FormulaCandidates({ outputRoot = DEFAULT_FORMULA_CANDIDATE_ROOT, ...options } = {}) {
  const plan = planPersonaV3FormulaPipeline(options);
  if (plan.errors.length) fail("formula authoring plan is invalid", { errors: plan.errors });
  const root = candidateRootSafe(outputRoot);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const result = { written: [], unchanged: [] };
  const inventoryFile = resolve(root, "authoring-inventory.json");
  writeStable(inventoryFile, `${JSON.stringify(plan.inventory, null, 2)}\n`, result);
  for (const entry of plan.inventory.entries) {
    const filename = `${entry.tool_id.slice(entry.persona_id.length + 1)}.formula-spec.json`;
    const file = resolve(root, "specs", entry.persona_id, filename);
    if (!inside(root, file)) fail(`candidate path escapes staging root: ${entry.tool_id}`);
    writeStable(file, `${JSON.stringify(entry.formula_spec, null, 2)}\n`, result);
  }
  return Object.freeze(canonicalValue({
    mode: "write_staging_candidates_then_check",
    output_root: root,
    written: result.written.map((file) => relative(root, file).split(sep).join("/")),
    unchanged: result.unchanged.map((file) => relative(root, file).split(sep).join("/")),
    inventory: plan.inventory,
  }));
}

export function renderFormulaAuthoringPlan(plan) {
  return [
    "# PersonaPack v3 formula authoring queue",
    "",
    `Seats: ${plan.inventory.canonical_seat_count}`,
    `Prototypes: ${plan.inventory.prototype_count}/${PLANNED_TOOL_COUNT}`,
    `Needs formula authorship: ${plan.inventory.needs_formula_authorship_count}`,
    `Executable staging candidates: ${plan.inventory.executable_candidate_count}`,
    `Dedicated production tools: ${plan.inventory.dedicated_tool_count}`,
    `Inventory hash: \`${plan.inventory.inventory_hash}\``,
    "",
    "> Every entry fails closed until its exact formula, operands, units, period contract, missing-data behavior, provenance, review, and immutable review-subject hash are complete.",
    "",
    "| # | Persona | Prototype | Family | Status | Blocking reasons |",
    "|---:|---|---|---|---|---|",
    ...plan.inventory.entries.map((entry) => `| ${entry.queue_index} | \`${entry.persona_id}\` | \`${entry.prototype_id}\` | \`${entry.formula_spec.authorship_request.operation_family}\` | \`${entry.artifact_status}\` | ${entry.blocking_reasons.join("; ")} |`),
    "",
  ].join("\n");
}
