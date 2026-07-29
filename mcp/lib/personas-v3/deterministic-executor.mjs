/**
 * PersonaPack v3 deterministic policy executor, DSL 1.1.
 *
 * Pure data interpreter: exact typed-fact IDs, earlier tool outputs, scalar literals,
 * whitelisted arithmetic and whitelisted conditions only. No eval, callbacks, property
 * paths, regular expressions, clock, filesystem, network, randomness or model call.
 */

import { canonicalValue, sha256 } from "./canonical.mjs";
import { freezeAnonymousDecision } from "./runtime.mjs";
import {
  PROVISIONAL_DERIVED_PROXY_ASSURANCE,
  deterministicToolEvidenceBinding,
  deterministicToolSchemaHashes,
} from "./tool-schema-hashes.mjs";

export {
  PROVISIONAL_DERIVED_PROXY_ASSURANCE,
  deterministicToolEvidenceBinding,
  deterministicToolSchemaHashes,
};

const DSL_VERSION = "1.1";
const ID = /^[a-z][a-z0-9_.:-]{1,159}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const STANCES = new Set(["constructive", "cautious", "opposed", "out_of_scope"]);
const TOOL_KINDS = new Set(["recomputation", "calculator", "transform"]);
const TOOL_OPERATIONS = new Set([
  "identity", "add", "subtract", "multiply", "divide", "sum", "mean",
  "min", "max", "abs", "negate", "clamp",
]);
const BINARY_CONDITIONS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte",
  "date_gt", "date_gte", "date_lt", "date_lte",
]);
const LOGICAL_CONDITIONS = new Set(["all", "any"]);
const POLICY_FIELDS = new Set([
  "schema_version", "dsl_version", "native_decision_schema", "native_states",
  "abstention_policy", "fact_gate", "eligibility", "hard_vetoes", "scoring",
  "score_bands", "native_output_fields",
]);
const TOOL_BASE_FIELDS = new Set([
  "schema_version", "dsl_version", "id", "version", "kind", "operation", "on_missing",
  "inputs", "input_contracts", "output_id", "value_kind", "unit", "output_period", "input_schema_hash",
  "output_schema_hash", "source_ids",
]);
const REVIEWED_FORMULA_BINDING_FIELDS = new Set([
  "formula_spec_id", "formula_spec_hash", "formula_review_subject_hash", "approval_bundle_hash",
]);
const PROVISIONAL_DERIVATION_BINDING_FIELDS = new Set([
  "assurance_class", "review_status", "intended_use", "production_eligible",
  "derivation_spec_id", "derivation_spec_hash", "derivation_evidence_hash",
]);
const TOOL_FIELDS = new Set([
  ...TOOL_BASE_FIELDS,
  ...REVIEWED_FORMULA_BINDING_FIELDS,
  ...PROVISIONAL_DERIVATION_BINDING_FIELDS,
]);
const MAPPING_FIELDS = new Set(["native_state", "common_stance"]);

export class PersonaV3PolicyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PersonaV3PolicyError";
    this.code = code;
    this.details = canonicalValue(details);
  }
}

function policyFail(code, message, details = {}) {
  throw new PersonaV3PolicyError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function add(errors, path, message) {
  errors.push(`${path}: ${message}`);
}

function exactFields(value, path, allowed, required, errors) {
  if (!isObject(value)) {
    add(errors, path, "must be an object");
    return false;
  }
  for (const key of Object.keys(value)) if (!allowed.has(key)) add(errors, path, `unknown field ${JSON.stringify(key)}`);
  for (const key of required) if (!hasOwn(value, key)) add(errors, path, `missing required field ${key}`);
  return true;
}

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

function validateIds(values, path, errors, { nonEmpty = true } = {}) {
  if (!Array.isArray(values) || (nonEmpty && values.length === 0)) {
    add(errors, path, `must be ${nonEmpty ? "a non-empty" : "an"} array`);
    return;
  }
  const seen = new Set();
  values.forEach((value, index) => {
    if (!validId(value)) add(errors, `${path}[${index}]`, "is invalid");
    else if (seen.has(value)) add(errors, `${path}[${index}]`, `duplicate ${JSON.stringify(value)}`);
    seen.add(value);
  });
}

function validateSourceIds(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    add(errors, path, "must be a non-empty array");
    return;
  }
  const seen = new Set();
  value.forEach((id, index) => {
    if (typeof id !== "string" || !id.trim()) add(errors, `${path}[${index}]`, "must be a non-empty string");
    else if (seen.has(id)) add(errors, `${path}[${index}]`, `duplicate ${JSON.stringify(id)}`);
    seen.add(id);
  });
}

function validateUniqueId(records, field, path, errors) {
  const seen = new Set();
  records.forEach((record, index) => {
    const value = record?.[field];
    if (!validId(value)) add(errors, `${path}[${index}].${field}`, "is invalid");
    else if (seen.has(value)) add(errors, `${path}[${index}].${field}`, `duplicate ${JSON.stringify(value)}`);
    seen.add(value);
  });
}

function validateOperand(operand, path, errors, references, { numericLiteral = false } = {}) {
  if (!isObject(operand)) {
    add(errors, path, "must be an operand object");
    return;
  }
  const keys = Object.keys(operand);
  if (keys.length !== 1 || !["fact_id", "output_id", "literal"].includes(keys[0])) {
    add(errors, path, "must contain exactly one of fact_id, output_id, or literal");
    return;
  }
  if (keys[0] === "fact_id") {
    if (!validId(operand.fact_id)) add(errors, `${path}.fact_id`, "is invalid");
    else references.factIds.add(operand.fact_id);
    return;
  }
  if (keys[0] === "output_id") {
    if (!validId(operand.output_id)) add(errors, `${path}.output_id`, "is invalid");
    else references.outputIds.add(operand.output_id);
    return;
  }
  const literal = operand.literal;
  const scalar = literal === null || ["string", "number", "boolean"].includes(typeof literal);
  if (!scalar || (typeof literal === "number" && !Number.isFinite(literal))) {
    add(errors, `${path}.literal`, "must be a finite JSON scalar");
  } else if (numericLiteral && (typeof literal !== "number" || !Number.isFinite(literal))) {
    add(errors, `${path}.literal`, "must be a finite number in a tool input");
  }
}

function validateCondition(condition, path, errors, references, depth = 0) {
  if (depth > 32) {
    add(errors, path, "condition nesting exceeds 32 levels");
    return;
  }
  if (!isObject(condition) || typeof condition.op !== "string") {
    add(errors, path, "must be a condition object with op");
    return;
  }
  if (BINARY_CONDITIONS.has(condition.op)) {
    if (!exactFields(condition, path, new Set(["op", "left", "right"]), ["op", "left", "right"], errors)) return;
    validateOperand(condition.left, `${path}.left`, errors, references);
    validateOperand(condition.right, `${path}.right`, errors, references);
    return;
  }
  if (condition.op === "exists") {
    if (!exactFields(condition, path, new Set(["op", "value"]), ["op", "value"], errors)) return;
    validateOperand(condition.value, `${path}.value`, errors, references);
    return;
  }
  if (LOGICAL_CONDITIONS.has(condition.op)) {
    if (!exactFields(condition, path, new Set(["op", "conditions"]), ["op", "conditions"], errors)) return;
    if (!Array.isArray(condition.conditions) || condition.conditions.length === 0) {
      add(errors, `${path}.conditions`, "must be a non-empty array");
      return;
    }
    condition.conditions.forEach((child, index) => validateCondition(child, `${path}.conditions[${index}]`, errors, references, depth + 1));
    return;
  }
  if (condition.op === "not") {
    if (!exactFields(condition, path, new Set(["op", "condition"]), ["op", "condition"], errors)) return;
    validateCondition(condition.condition, `${path}.condition`, errors, references, depth + 1);
    return;
  }
  add(errors, `${path}.op`, `unknown operation ${JSON.stringify(condition.op)}`);
}

function validateMapping(mapping, path, errors, mappedStates, {
  requireOutOfScope = false,
  allowedStances = null,
} = {}) {
  if (!exactFields(mapping, path, MAPPING_FIELDS, [...MAPPING_FIELDS], errors)) return;
  if (!validId(mapping.native_state)) add(errors, `${path}.native_state`, "is invalid");
  else {
    mappedStates.add(mapping.native_state);
    if (STANCES.has(mapping.native_state)) add(errors, `${path}.native_state`, "must be method-specific and distinct from the four common stances");
  }
  if (!STANCES.has(mapping.common_stance)) add(errors, `${path}.common_stance`, "is invalid");
  if (requireOutOfScope && mapping.common_stance !== "out_of_scope") add(errors, `${path}.common_stance`, "must be out_of_scope for fail-closed abstention");
  if (allowedStances && STANCES.has(mapping.common_stance) && !allowedStances.has(mapping.common_stance)) {
    add(errors, `${path}.common_stance`, `must be one of ${[...allowedStances].join(", ")}`);
  }
}

function validatePeriodContract(period, path, errors) {
  const fields = new Set(["basis", "window", "alignment"]);
  if (!exactFields(period, path, fields, [...fields], errors)) return;
  if (!["instant", "duration", "forecast_horizon", "not_applicable"].includes(period.basis)) add(errors, `${path}.basis`, "is invalid");
  if (!["exact", "same_period", "as_of", "not_applicable"].includes(period.alignment)) add(errors, `${path}.alignment`, "is invalid");
  if (period.window !== null && (typeof period.window !== "string" || !/^(P[1-9]\d*[DMY]|ANY)$/u.test(period.window))) add(errors, `${path}.window`, "must be null, ANY, or P<n>D, P<n>M, or P<n>Y");
  if (["instant", "not_applicable"].includes(period.basis) && period.window !== null) add(errors, `${path}.window`, `must be null for ${period.basis}`);
  if (["duration", "forecast_horizon"].includes(period.basis) && period.window === null) add(errors, `${path}.window`, `is required for ${period.basis}`);
  if (period.basis === "not_applicable" && period.alignment !== "not_applicable") add(errors, `${path}.alignment`, "must be not_applicable");
  if (period.basis !== "not_applicable" && period.alignment === "not_applicable") add(errors, `${path}.alignment`, "cannot be not_applicable");
}

function validateInputContract(contract, index, tool, path, errors) {
  const inputPath = `${path}.input_contracts[${index}]`;
  const fields = new Set(["value_kind", "unit", "period", "on_missing"]);
  if (!exactFields(contract, inputPath, fields, [...fields], errors)) return;
  if (!["monetary", "ratio", "count", "scalar"].includes(contract.value_kind)) add(errors, `${inputPath}.value_kind`, "is invalid");
  if (typeof contract.unit !== "string" || !contract.unit.trim()) add(errors, `${inputPath}.unit`, "is required");
  validatePeriodContract(contract.period, `${inputPath}.period`, errors);
  if (!["fail", "skip"].includes(contract.on_missing)) add(errors, `${inputPath}.on_missing`, "must be fail or skip");
  if (contract.on_missing !== tool.on_missing) add(errors, `${inputPath}.on_missing`, "must equal tool.on_missing");
}

function validateTool(tool, index, errors, references) {
  const path = `tools[${index}]`;
  if (!exactFields(tool, path, TOOL_FIELDS, [...TOOL_BASE_FIELDS], errors)) return;
  if (tool.schema_version !== 1) add(errors, `${path}.schema_version`, "must be 1");
  if (tool.dsl_version !== DSL_VERSION) add(errors, `${path}.dsl_version`, `must be ${DSL_VERSION}`);
  if (!validId(tool.id)) add(errors, `${path}.id`, "is invalid");
  if (!/^\d+\.\d+\.\d+$/.test(tool.version || "")) add(errors, `${path}.version`, "must be semver x.y.z");
  if (!TOOL_KINDS.has(tool.kind)) add(errors, `${path}.kind`, `unsupported deterministic kind ${JSON.stringify(tool.kind)}`);
  if (!TOOL_OPERATIONS.has(tool.operation)) add(errors, `${path}.operation`, `unknown operation ${JSON.stringify(tool.operation)}`);
  if (!["fail", "skip"].includes(tool.on_missing)) add(errors, `${path}.on_missing`, "must be fail or skip");
  if (!Array.isArray(tool.inputs) || tool.inputs.length === 0) add(errors, `${path}.inputs`, "must be a non-empty array");
  else tool.inputs.forEach((operand, operandIndex) => validateOperand(operand, `${path}.inputs[${operandIndex}]`, errors, references, { numericLiteral: true }));
  if (!Array.isArray(tool.input_contracts) || tool.input_contracts.length !== tool.inputs?.length) add(errors, `${path}.input_contracts`, "must align one-for-one with inputs");
  else tool.input_contracts.forEach((contract, contractIndex) => validateInputContract(contract, contractIndex, tool, path, errors));
  if (!validId(tool.output_id)) add(errors, `${path}.output_id`, "is invalid");
  if (!["monetary", "ratio", "count", "scalar"].includes(tool.value_kind)) add(errors, `${path}.value_kind`, "is invalid");
  if (typeof tool.unit !== "string" || !tool.unit.trim()) add(errors, `${path}.unit`, "is required");
  validatePeriodContract(tool.output_period, `${path}.output_period`, errors);
  if (!HASH.test(tool.input_schema_hash || "")) add(errors, `${path}.input_schema_hash`, "is invalid");
  if (!HASH.test(tool.output_schema_hash || "")) add(errors, `${path}.output_schema_hash`, "is invalid");
  validateSourceIds(tool.source_ids, `${path}.source_ids`, errors);
  const provisional = tool.assurance_class === PROVISIONAL_DERIVED_PROXY_ASSURANCE;
  if (provisional) {
    for (const field of PROVISIONAL_DERIVATION_BINDING_FIELDS) {
      if (!hasOwn(tool, field)) add(errors, path, `missing required provisional field ${field}`);
    }
    for (const field of REVIEWED_FORMULA_BINDING_FIELDS) {
      if (hasOwn(tool, field)) add(errors, `${path}.${field}`, "must be absent from a provisional derived proxy");
    }
    if (tool.review_status !== "not_human_reviewed") add(errors, `${path}.review_status`, "must be not_human_reviewed");
    if (tool.intended_use !== "local_test_only") add(errors, `${path}.intended_use`, "must be local_test_only");
    if (tool.production_eligible !== false) add(errors, `${path}.production_eligible`, "must be false");
    if (!validId(tool.derivation_spec_id)) add(errors, `${path}.derivation_spec_id`, "is invalid");
    for (const field of ["derivation_spec_hash", "derivation_evidence_hash"]) {
      if (!HASH.test(tool[field] || "")) add(errors, `${path}.${field}`, "is invalid");
    }
  } else {
    if (hasOwn(tool, "assurance_class")) add(errors, `${path}.assurance_class`, "is invalid");
    for (const field of PROVISIONAL_DERIVATION_BINDING_FIELDS) {
      if (hasOwn(tool, field)) add(errors, `${path}.${field}`, "requires assurance_class provisional_derived_proxy");
    }
    for (const field of REVIEWED_FORMULA_BINDING_FIELDS) {
      if (!hasOwn(tool, field)) add(errors, path, `missing required reviewed-formula field ${field}`);
    }
    if (!validId(tool.formula_spec_id)) add(errors, `${path}.formula_spec_id`, "is invalid");
    for (const field of ["formula_spec_hash", "formula_review_subject_hash", "approval_bundle_hash"]) {
      if (!HASH.test(tool[field] || "")) add(errors, `${path}.${field}`, "is invalid");
    }
  }
  if (validId(tool.id) && validId(tool.output_id) && Array.isArray(tool.inputs)) {
    const expected = deterministicToolSchemaHashes(tool);
    if (tool.input_schema_hash !== expected.input_schema_hash) add(errors, `${path}.input_schema_hash`, `does not match executable input contract; expected ${expected.input_schema_hash}`);
    if (tool.output_schema_hash !== expected.output_schema_hash) add(errors, `${path}.output_schema_hash`, `does not match executable output contract; expected ${expected.output_schema_hash}`);
  }
}

function operationArity(operation) {
  if (["identity", "abs", "negate"].includes(operation)) return [1, 1];
  if (["subtract", "divide"].includes(operation)) return [2, 2];
  if (operation === "clamp") return [3, 3];
  return [1, Number.POSITIVE_INFINITY];
}

/** Validate the physical policy and graph without executing them. */
export function validateDeterministicPolicyArtifacts({
  policy,
  tools,
  requiredFactTypes,
  optionalFactTypes,
  pipeline,
  dslVersion,
  nativeDecisionSchema,
} = {}) {
  const errors = [];
  const references = { factIds: new Set(), outputIds: new Set() };
  const mappedStates = new Set();
  if (!exactFields(policy, "decision_policy", POLICY_FIELDS, [...POLICY_FIELDS], errors)) return errors;
  if (policy.schema_version !== 1) add(errors, "decision_policy.schema_version", "must be 1");
  if (policy.dsl_version !== DSL_VERSION) add(errors, "decision_policy.dsl_version", `must be ${DSL_VERSION}`);
  if (dslVersion !== DSL_VERSION) add(errors, "manifest.computation.dsl_version", `must be ${DSL_VERSION}`);
  if (!validId(policy.native_decision_schema)) add(errors, "decision_policy.native_decision_schema", "is invalid");
  if (nativeDecisionSchema && policy.native_decision_schema !== nativeDecisionSchema) add(errors, "decision_policy.native_decision_schema", "must match manifest capability.native_decision_schema");
  if (policy.abstention_policy !== "fail_closed") add(errors, "decision_policy.abstention_policy", "must be fail_closed");
  validateIds(policy.native_states, "decision_policy.native_states", errors);
  if (Array.isArray(policy.native_states) && policy.native_states.length < 2) add(errors, "decision_policy.native_states", "must declare at least two method-specific states");
  for (const state of policy.native_states || []) if (STANCES.has(state)) add(errors, "decision_policy.native_states", `${JSON.stringify(state)} is a common stance, not a method-specific native state`);

  if (exactFields(policy.fact_gate, "decision_policy.fact_gate", new Set(["on_missing_critical"]), ["on_missing_critical"], errors)) {
    validateMapping(policy.fact_gate.on_missing_critical, "decision_policy.fact_gate.on_missing_critical", errors, mappedStates, { requireOutOfScope: true });
  }

  if (!exactFields(policy.eligibility, "decision_policy.eligibility", new Set(["all"]), ["all"], errors)) {
    // reported above
  } else if (!Array.isArray(policy.eligibility.all)) add(errors, "decision_policy.eligibility.all", "must be an array");
  else {
    validateUniqueId(policy.eligibility.all, "condition_id", "decision_policy.eligibility.all", errors);
    policy.eligibility.all.forEach((record, index) => {
      const path = `decision_policy.eligibility.all[${index}]`;
      const fields = new Set(["condition_id", "condition", "source_ids", "on_false", "on_uncomputable"]);
      if (!exactFields(record, path, fields, [...fields], errors)) return;
      validateCondition(record.condition, `${path}.condition`, errors, references);
      validateSourceIds(record.source_ids, `${path}.source_ids`, errors);
      validateMapping(record.on_false, `${path}.on_false`, errors, mappedStates, { requireOutOfScope: true });
      validateMapping(record.on_uncomputable, `${path}.on_uncomputable`, errors, mappedStates, { requireOutOfScope: true });
    });
  }

  if (!Array.isArray(policy.hard_vetoes)) add(errors, "decision_policy.hard_vetoes", "must be an array");
  else {
    validateUniqueId(policy.hard_vetoes, "veto_id", "decision_policy.hard_vetoes", errors);
    policy.hard_vetoes.forEach((record, index) => {
      const path = `decision_policy.hard_vetoes[${index}]`;
      const fields = new Set(["veto_id", "condition", "source_ids", "on_trigger", "on_uncomputable"]);
      if (!exactFields(record, path, fields, [...fields], errors)) return;
      validateCondition(record.condition, `${path}.condition`, errors, references);
      validateSourceIds(record.source_ids, `${path}.source_ids`, errors);
      validateMapping(record.on_trigger, `${path}.on_trigger`, errors, mappedStates, {
        allowedStances: new Set(["opposed", "out_of_scope"]),
      });
      const missing = record.on_uncomputable;
      if (exactFields(missing, `${path}.on_uncomputable`, new Set(["action", "decision"]), ["action", "decision"], errors)) {
        if (!["trigger", "abstain"].includes(missing.action)) add(errors, `${path}.on_uncomputable.action`, "must be trigger or abstain");
        validateMapping(missing.decision, `${path}.on_uncomputable.decision`, errors, mappedStates, {
          requireOutOfScope: missing.action === "abstain",
          allowedStances: new Set(["opposed", "out_of_scope"]),
        });
      }
    });
  }

  const scoring = policy.scoring;
  const scoringFields = new Set(["max_score", "min_coverage", "on_insufficient_coverage", "rules"]);
  if (exactFields(scoring, "decision_policy.scoring", scoringFields, [...scoringFields], errors)) {
    if (!Number.isFinite(scoring.max_score) || scoring.max_score <= 0) add(errors, "decision_policy.scoring.max_score", "must be positive and finite");
    if (!Number.isFinite(scoring.min_coverage) || scoring.min_coverage < 0 || scoring.min_coverage > 1) add(errors, "decision_policy.scoring.min_coverage", "must be between 0 and 1");
    validateMapping(scoring.on_insufficient_coverage, "decision_policy.scoring.on_insufficient_coverage", errors, mappedStates, { requireOutOfScope: true });
    if (!Array.isArray(scoring.rules) || scoring.rules.length === 0) add(errors, "decision_policy.scoring.rules", "must be a non-empty array");
    else {
      validateUniqueId(scoring.rules, "rule_id", "decision_policy.scoring.rules", errors);
      scoring.rules.forEach((record, index) => {
        const path = `decision_policy.scoring.rules[${index}]`;
        const fields = new Set(["rule_id", "condition", "points", "coverage_weight", "source_ids"]);
        if (!exactFields(record, path, fields, [...fields], errors)) return;
        if (!Number.isFinite(record.points) || record.points <= 0) add(errors, `${path}.points`, "must be positive and finite");
        if (!Number.isFinite(record.coverage_weight) || record.coverage_weight <= 0) add(errors, `${path}.coverage_weight`, "must be positive and finite");
        validateCondition(record.condition, `${path}.condition`, errors, references);
        validateSourceIds(record.source_ids, `${path}.source_ids`, errors);
      });
      const sum = scoring.rules.reduce((total, rule) => total + (Number.isFinite(rule?.points) ? rule.points : 0), 0);
      if (Number.isFinite(scoring.max_score) && sum !== scoring.max_score) add(errors, "decision_policy.scoring.max_score", `must equal the exact rule-point sum ${sum}`);
    }
  }

  if (!Array.isArray(policy.score_bands) || policy.score_bands.length === 0) add(errors, "decision_policy.score_bands", "must be a non-empty array");
  else {
    const ratios = new Set();
    policy.score_bands.forEach((band, index) => {
      const path = `decision_policy.score_bands[${index}]`;
      if (!exactFields(band, path, new Set(["min_ratio", "decision"]), ["min_ratio", "decision"], errors)) return;
      if (!Number.isFinite(band.min_ratio) || band.min_ratio < 0 || band.min_ratio > 1) add(errors, `${path}.min_ratio`, "must be between 0 and 1");
      else if (ratios.has(band.min_ratio)) add(errors, `${path}.min_ratio`, `duplicate ${band.min_ratio}`);
      ratios.add(band.min_ratio);
      validateMapping(band.decision, `${path}.decision`, errors, mappedStates);
    });
    if (!ratios.has(0)) add(errors, "decision_policy.score_bands", "must include a min_ratio 0 fallback");
  }

  if (!Array.isArray(policy.native_output_fields)) add(errors, "decision_policy.native_output_fields", "must be an array");
  else {
    validateUniqueId(policy.native_output_fields, "field", "decision_policy.native_output_fields", errors);
    policy.native_output_fields.forEach((record, index) => {
      const path = `decision_policy.native_output_fields[${index}]`;
      const fields = new Set(["field", "value", "on_missing"]);
      if (!exactFields(record, path, fields, [...fields], errors)) return;
      validateOperand(record.value, `${path}.value`, errors, references);
      if (!["fail", "omit", "null"].includes(record.on_missing)) add(errors, `${path}.on_missing`, "must be fail, omit or null");
    });
  }

  const declaredStateSet = new Set(policy.native_states || []);
  for (const state of mappedStates) if (!declaredStateSet.has(state)) add(errors, "decision_policy.native_states", `does not declare mapped state ${JSON.stringify(state)}`);
  for (const state of declaredStateSet) if (!mappedStates.has(state)) add(errors, "decision_policy.native_states", `declares unused state ${JSON.stringify(state)}`);

  if (!Array.isArray(tools)) add(errors, "tools", "must be an array");
  else {
    validateUniqueId(tools, "id", "tools", errors);
    validateUniqueId(tools, "output_id", "tools", errors);
    tools.forEach((tool, index) => validateTool(tool, index, errors, references));
  }

  const required = Array.isArray(requiredFactTypes) ? requiredFactTypes : [];
  const optional = Array.isArray(optionalFactTypes) ? optionalFactTypes : [];
  validateIds(required, "manifest.capability.required_fact_types", errors, { nonEmpty: false });
  validateIds(optional, "manifest.capability.optional_fact_types", errors, { nonEmpty: false });
  if (!required.length && !optional.length) add(errors, "manifest.capability", "required and optional fact types cannot both be empty");
  const overlap = required.filter((id) => optional.includes(id));
  if (overlap.length) add(errors, "manifest.capability", `required and optional fact types overlap: ${overlap.join(", ")}`);
  const declaredFacts = new Set([...required, ...optional]);
  for (const factId of references.factIds) if (!declaredFacts.has(factId)) add(errors, "decision_policy", `references undeclared fact ${JSON.stringify(factId)}`);

  const orderedPipeline = Array.isArray(pipeline) ? pipeline : [];
  validateIds(orderedPipeline, "manifest.computation.pipeline", errors);
  const toolById = new Map((Array.isArray(tools) ? tools : []).map((tool) => [tool?.id, tool]));
  const outputProducer = new Map((Array.isArray(tools) ? tools : []).map((tool) => [tool?.output_id, tool?.id]));
  const pipelineIndex = new Map(orderedPipeline.map((id, index) => [id, index]));
  for (const id of orderedPipeline) if (!toolById.has(id)) add(errors, "manifest.computation.pipeline", `references unknown tool ${JSON.stringify(id)}`);
  for (const outputId of references.outputIds) {
    const producer = outputProducer.get(outputId);
    if (!producer) add(errors, "decision_policy", `references unknown tool output ${JSON.stringify(outputId)}`);
    else if (!pipelineIndex.has(producer)) add(errors, "decision_policy", `references output ${JSON.stringify(outputId)} from tool not present in the pipeline`);
  }
  for (const [index, id] of orderedPipeline.entries()) {
    const tool = toolById.get(id);
    for (const [inputIndex, input] of (tool?.inputs || []).entries()) {
      if (!hasOwn(input, "output_id")) continue;
      const producer = outputProducer.get(input.output_id);
      if (producer && pipelineIndex.has(producer) && pipelineIndex.get(producer) >= index) add(errors, `tools.${id}.inputs`, `output ${JSON.stringify(input.output_id)} is a forward reference or cycle`);
      const producerTool = toolById.get(producer);
      const contract = tool?.input_contracts?.[inputIndex];
      if (producerTool && contract && (contract.value_kind !== producerTool.value_kind
        || contract.unit !== producerTool.unit
        || JSON.stringify(canonicalValue(contract.period)) !== JSON.stringify(canonicalValue(producerTool.output_period)))) {
        add(errors, `tools.${id}.input_contracts[${inputIndex}]`, `does not match producer ${producer} output contract`);
      }
    }
    if (tool && TOOL_OPERATIONS.has(tool.operation) && Array.isArray(tool.inputs)) {
      const [minimum, maximum] = operationArity(tool.operation);
      if (tool.inputs.length < minimum || tool.inputs.length > maximum) add(errors, `tools.${id}.inputs`, `${tool.operation} requires ${minimum === maximum ? minimum : `at least ${minimum}`} input(s)`);
    }
  }
  return errors;
}

function unique(values) {
  return [...new Set(values)];
}

function resolveOperand(operand, facts, outputs) {
  if (hasOwn(operand, "literal")) return { computable: true, value: operand.literal, missing_input_ids: [] };
  if (hasOwn(operand, "fact_id")) {
    if (!facts.has(operand.fact_id)) return { computable: false, value: null, missing_input_ids: [`fact:${operand.fact_id}`] };
    return { computable: true, value: facts.get(operand.fact_id).value, missing_input_ids: [] };
  }
  if (hasOwn(operand, "output_id")) {
    if (!outputs.has(operand.output_id)) return { computable: false, value: null, missing_input_ids: [`output:${operand.output_id}`] };
    return { computable: true, value: outputs.get(operand.output_id), missing_input_ids: [] };
  }
  policyFail("INVALID_OPERAND", "invalid operand reached execution");
}

function finiteNumber(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) policyFail("TYPE_MISMATCH", `${path}: expected a finite number`);
  return value;
}

function runOperation(operation, values, path) {
  const numbers = values.map((value, index) => finiteNumber(value, `${path}.inputs[${index}]`));
  let result;
  switch (operation) {
    case "identity": result = numbers[0]; break;
    case "add":
    case "sum": result = numbers.reduce((total, value) => total + value, 0); break;
    case "subtract": result = numbers[0] - numbers[1]; break;
    case "multiply": result = numbers.reduce((total, value) => total * value, 1); break;
    case "divide":
      if (numbers[1] === 0) policyFail("DIVISION_BY_ZERO", `${path}: division by zero`);
      result = numbers[0] / numbers[1];
      break;
    case "mean": result = numbers.reduce((total, value) => total + value, 0) / numbers.length; break;
    case "min": result = Math.min(...numbers); break;
    case "max": result = Math.max(...numbers); break;
    case "abs": result = Math.abs(numbers[0]); break;
    case "negate": result = -numbers[0]; break;
    case "clamp":
      if (numbers[1] > numbers[2]) policyFail("INVALID_CLAMP", `${path}: clamp minimum exceeds maximum`);
      result = Math.min(numbers[2], Math.max(numbers[1], numbers[0]));
      break;
    default: policyFail("UNKNOWN_TOOL_OPERATION", `${path}: unknown tool operation ${JSON.stringify(operation)}`);
  }
  if (!Number.isFinite(result)) policyFail("NON_FINITE_TOOL_RESULT", `${path}: operation produced a non-finite result`);
  return Object.is(result, -0) ? 0 : result;
}

function periodTuple(fact) {
  return [fact.period_start, fact.period_end, fact.fiscal_year];
}

/** Window token for a duration whose length is set by data availability, not by the method. */
export const ANY_REPORTING_INTERVAL = "ANY";

function periodWindowMatches(fact, window) {
  if (!fact.period_start || !fact.period_end) return false;
  const start = Date.parse(fact.period_start);
  const end = Date.parse(fact.period_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  // Some aggregates cover as many periods as the filings supplied rather than a fixed span --
  // interest coverage is three years for one issuer and one for the next. Pinning a count there
  // would reject the fact for being honest about its own coverage; what still has to hold is
  // that it carries a real interval rather than a stray observation date.
  if (window === ANY_REPORTING_INTERVAL) return true;
  const match = /^P([1-9]\d*)([DMY])$/u.exec(window || "");
  if (!match) return false;
  const count = Number(match[1]);
  const elapsedDays = (end - start) / 86_400_000;
  if (match[2] === "D") return elapsedDays === count;
  if (match[2] === "M") return elapsedDays >= count * 27 && elapsedDays <= count * 32;
  // A fiscal year is 52 or 53 weeks, not 365 days, and it is measured between two fiscal
  // year-end dates -- so a real one-year filing span is routinely 363 or 364 days. Demanding
  // 365 rejected every issuer whose year ends on a weekday.
  return elapsedDays >= count * 364 - 2 && elapsedDays <= count * 366 + 1;
}

function assertFactInputContract(fact, contract, factPackAsOf, path) {
  if (fact.value_kind !== contract.value_kind) {
    policyFail("INPUT_CONTRACT_MISMATCH", `${path}: value_kind ${JSON.stringify(fact.value_kind)} does not match ${JSON.stringify(contract.value_kind)}`);
  }
  if (fact.unit !== contract.unit) {
    policyFail("INPUT_CONTRACT_MISMATCH", `${path}: unit ${JSON.stringify(fact.unit)} does not match ${JSON.stringify(contract.unit)}`);
  }
  const period = contract.period;
  if (period.basis === "not_applicable" && periodTuple(fact).some((value) => value !== null)) {
    policyFail("INPUT_CONTRACT_MISMATCH", `${path}: expected no reporting period`);
  }
  if (period.basis === "instant" && (fact.period_start !== null || fact.period_end !== null)) {
    policyFail("INPUT_CONTRACT_MISMATCH", `${path}: expected an instant fact without a duration interval`);
  }
  if (["duration", "forecast_horizon"].includes(period.basis) && !periodWindowMatches(fact, period.window)) {
    policyFail("INPUT_CONTRACT_MISMATCH", `${path}: reporting period does not satisfy ${period.window}`);
  }
  if (period.alignment === "as_of" && fact.as_of !== factPackAsOf) {
    policyFail("INPUT_CONTRACT_MISMATCH", `${path}: fact as_of ${JSON.stringify(fact.as_of)} does not match fact-pack as_of ${JSON.stringify(factPackAsOf)}`);
  }
}

function assertToolInputContracts(tool, facts, factPackAsOf) {
  let samePeriod = null;
  tool.inputs.forEach((operand, index) => {
    const contract = tool.input_contracts[index];
    if (hasOwn(operand, "fact_id") && facts.has(operand.fact_id)) {
      const fact = facts.get(operand.fact_id);
      assertFactInputContract(fact, contract, factPackAsOf, `tools.${tool.id}.inputs[${index}]`);
      if (contract.period.alignment === "same_period") {
        const tuple = JSON.stringify(periodTuple(fact));
        if (samePeriod !== null && tuple !== samePeriod) policyFail("INPUT_CONTRACT_MISMATCH", `tools.${tool.id}: same_period inputs do not share one reporting period`);
        samePeriod = tuple;
      }
    }
  });
}

function dateValue(value, path) {
  if (typeof value !== "string") policyFail("TYPE_MISMATCH", `${path}: expected a dated string`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) policyFail("INVALID_DATE", `${path}: invalid date ${JSON.stringify(value)}`);
  return parsed;
}

function comparable(value) {
  return value === null || ["number", "string", "boolean"].includes(typeof value);
}

function uncomputable(op, missing, children = undefined) {
  return { op, computable: false, value: null, missing_input_ids: unique(missing), ...(children ? { children } : {}) };
}

function evaluateCondition(condition, facts, outputs, path) {
  if (LOGICAL_CONDITIONS.has(condition.op)) {
    const children = condition.conditions.map((child, index) => evaluateCondition(child, facts, outputs, `${path}.conditions[${index}]`));
    const known = children.filter((child) => child.computable);
    const missing = children.flatMap((child) => child.missing_input_ids);
    if (condition.op === "all") {
      if (known.some((child) => child.value === false)) return { op: "all", computable: true, value: false, missing_input_ids: unique(missing), children };
      if (known.length !== children.length) return uncomputable("all", missing, children);
      return { op: "all", computable: true, value: true, missing_input_ids: [], children };
    }
    if (known.some((child) => child.value === true)) return { op: "any", computable: true, value: true, missing_input_ids: unique(missing), children };
    if (known.length !== children.length) return uncomputable("any", missing, children);
    return { op: "any", computable: true, value: false, missing_input_ids: [], children };
  }
  if (condition.op === "not") {
    const child = evaluateCondition(condition.condition, facts, outputs, `${path}.condition`);
    if (!child.computable) return uncomputable("not", child.missing_input_ids, [child]);
    return { op: "not", computable: true, value: !child.value, missing_input_ids: [], children: [child] };
  }
  if (condition.op === "exists") {
    const result = resolveOperand(condition.value, facts, outputs);
    return { op: "exists", computable: true, value: result.computable && result.value !== null && result.value !== "", missing_input_ids: result.missing_input_ids };
  }
  const left = resolveOperand(condition.left, facts, outputs);
  const right = resolveOperand(condition.right, facts, outputs);
  const missing = [...left.missing_input_ids, ...right.missing_input_ids];
  if (!left.computable || !right.computable) return uncomputable(condition.op, missing);
  let value;
  if (["date_gt", "date_gte", "date_lt", "date_lte"].includes(condition.op)) {
    const a = dateValue(left.value, `${path}.left`);
    const b = dateValue(right.value, `${path}.right`);
    if (condition.op === "date_gt") value = a > b;
    else if (condition.op === "date_gte") value = a >= b;
    else if (condition.op === "date_lt") value = a < b;
    else value = a <= b;
  } else if (["gt", "gte", "lt", "lte"].includes(condition.op)) {
    const a = finiteNumber(left.value, `${path}.left`);
    const b = finiteNumber(right.value, `${path}.right`);
    if (condition.op === "gt") value = a > b;
    else if (condition.op === "gte") value = a >= b;
    else if (condition.op === "lt") value = a < b;
    else value = a <= b;
  } else {
    if (!comparable(left.value) || !comparable(right.value)) policyFail("TYPE_MISMATCH", `${path}: equality accepts JSON scalars only`);
    value = condition.op === "eq" ? left.value === right.value : left.value !== right.value;
  }
  return { op: condition.op, computable: true, value, left: left.value, right: right.value, missing_input_ids: [] };
}

function confidenceFor(facts, referencedFactIds, coverage = 1) {
  const values = [...referencedFactIds].map((id) => facts.get(id)?.confidence).filter(Number.isFinite);
  const raw = values.length ? Math.min(...values) : 0;
  const score = raw * coverage;
  return { score, label: score >= 0.85 ? "high" : score >= 0.6 ? "medium" : "low" };
}

function policyReferences(policy, tools) {
  const references = { factIds: new Set(), outputIds: new Set() };
  const sink = [];
  for (const record of policy.eligibility.all) validateCondition(record.condition, "eligibility", sink, references);
  for (const record of policy.hard_vetoes) validateCondition(record.condition, "veto", sink, references);
  for (const record of policy.scoring.rules) validateCondition(record.condition, "scoring", sink, references);
  for (const record of policy.native_output_fields) validateOperand(record.value, "native_output", sink, references);
  for (const tool of tools) for (const input of tool.inputs) validateOperand(input, "tool_input", sink, references, { numericLiteral: true });
  return references;
}

function selectBand(bands, ratio) {
  return [...bands].sort((a, b) => b.min_ratio - a.min_ratio).find((band) => ratio >= band.min_ratio);
}

function nativeMetrics(policy, facts, outputs) {
  const metrics = {};
  const status = {};
  for (const record of policy.native_output_fields) {
    const resolved = resolveOperand(record.value, facts, outputs);
    if (resolved.computable) {
      metrics[record.field] = resolved.value;
      status[record.field] = { status: "present", missing_input_ids: [] };
    } else if (record.on_missing === "fail") {
      policyFail("MISSING_NATIVE_OUTPUT", `native output ${record.field} is missing`, { field: record.field, missing_input_ids: resolved.missing_input_ids });
    } else if (record.on_missing === "null") {
      metrics[record.field] = null;
      status[record.field] = { status: "null_missing", missing_input_ids: resolved.missing_input_ids };
    } else {
      status[record.field] = { status: "omitted_missing", missing_input_ids: resolved.missing_input_ids };
    }
  }
  return { metrics, status };
}

function executeValidatedPolicy(preDecision, policy, tools, pipeline) {
  const facts = new Map(preDecision.fact_pack.facts.map((fact) => [fact.fact_id, fact]));
  const outputs = new Map();
  const toolById = new Map(tools.map((tool) => [tool.id, tool]));
  const toolTrace = [];
  for (const toolId of pipeline) {
    const tool = toolById.get(toolId);
    assertToolInputContracts(tool, facts, preDecision.fact_pack.as_of);
    const resolved = tool.inputs.map((operand) => resolveOperand(operand, facts, outputs));
    const missing = unique(resolved.flatMap((input) => input.missing_input_ids));
    if (missing.length) {
      if (tool.on_missing === "fail") policyFail("MISSING_TOOL_INPUT", `tool ${tool.id} is missing an input`, { tool_id: tool.id, missing_input_ids: missing });
      toolTrace.push({
        tool_id: tool.id,
        tool_version: tool.version,
        operation: tool.operation,
        status: "skipped_missing_optional",
        output_id: tool.output_id,
        missing_input_ids: missing,
      });
      continue;
    }
    const inputs = resolved.map((input) => input.value);
    const value = runOperation(tool.operation, inputs, `tools.${toolId}`);
    outputs.set(tool.output_id, value);
    toolTrace.push({
      tool_id: tool.id,
      tool_version: tool.version,
      operation: tool.operation,
      status: "computed",
      inputs,
      output_id: tool.output_id,
      value,
      calculation_hash: sha256({ tool_id: tool.id, tool_version: tool.version, operation: tool.operation, inputs, value }),
      missing_input_ids: [],
    });
  }

  const eligibilityChecks = policy.eligibility.all.map((record, index) => ({
    condition_id: record.condition_id,
    source_ids: record.source_ids,
    ...evaluateCondition(record.condition, facts, outputs, `decision_policy.eligibility.all[${index}].condition`),
  }));
  const eligibilityFailure = eligibilityChecks.map((check, index) => {
    if (!check.computable) return { check, mapping: policy.eligibility.all[index].on_uncomputable, reason: "eligibility_uncomputable" };
    if (!check.value) return { check, mapping: policy.eligibility.all[index].on_false, reason: "eligibility" };
    return null;
  }).find(Boolean) || null;

  const vetoEvaluations = policy.hard_vetoes.map((record, index) => {
    const evaluation = evaluateCondition(record.condition, facts, outputs, `decision_policy.hard_vetoes[${index}].condition`);
    const resolution = evaluation.computable
      ? evaluation.value ? "condition_true" : "condition_false"
      : record.on_uncomputable.action === "trigger" ? "uncomputable_triggered" : "uncomputable_abstain";
    return {
      veto_id: record.veto_id,
      source_ids: record.source_ids,
      declared_index: index,
      on_uncomputable_action: record.on_uncomputable.action,
      resolution,
      ...evaluation,
    };
  });
  const vetoDecisive = vetoEvaluations.map((evaluation, index) => {
    const record = policy.hard_vetoes[index];
    if (!evaluation.computable) {
      return {
        evaluation,
        mapping: record.on_uncomputable.decision,
        reason: "veto_uncomputable",
        narratable: false,
      };
    }
    if (evaluation.value) return { evaluation, mapping: record.on_trigger, reason: "veto", narratable: true };
    return null;
  }).find(Boolean) || null;
  const vetoesTriggered = vetoEvaluations.map((evaluation, index) => {
    const record = policy.hard_vetoes[index];
    if (evaluation.computable && evaluation.value) return evaluation;
    if (!evaluation.computable && record.on_uncomputable.action === "trigger") return evaluation;
    return null;
  }).filter(Boolean);

  const evaluatedRules = policy.scoring.rules.map((record, index) => ({
    rule_id: record.rule_id,
    points: record.points,
    coverage_weight: record.coverage_weight,
    source_ids: record.source_ids,
    ...evaluateCondition(record.condition, facts, outputs, `decision_policy.scoring.rules[${index}].condition`),
  }));
  const computableRules = evaluatedRules.filter((rule) => rule.computable);
  const hits = computableRules.filter((rule) => rule.value);
  const misses = computableRules.filter((rule) => !rule.value);
  const uncomputableRules = evaluatedRules.filter((rule) => !rule.computable);
  const totalCoverageWeight = evaluatedRules.reduce((sum, rule) => sum + rule.coverage_weight, 0);
  const computableCoverageWeight = computableRules.reduce((sum, rule) => sum + rule.coverage_weight, 0);
  const coverage = totalCoverageWeight ? computableCoverageWeight / totalCoverageWeight : 0;
  const computableMax = computableRules.reduce((sum, rule) => sum + rule.points, 0);
  const insufficientCoverage = computableRules.length === 0 || coverage < policy.scoring.min_coverage;
  const earned = hits.reduce((sum, rule) => sum + rule.points, 0);
  const ratio = insufficientCoverage ? null : earned / computableMax;
  const score = {
    status: insufficientCoverage ? "insufficient_coverage" : "scored",
    score: insufficientCoverage ? null : earned,
    max_possible: computableMax,
    declared_max: policy.scoring.max_score,
    ratio,
    coverage,
    computable_coverage_weight: computableCoverageWeight,
    declared_coverage_weight: totalCoverageWeight,
    hits,
    misses,
    uncomputable: uncomputableRules,
  };

  let mapping;
  let reason;
  let narratable;
  if (eligibilityFailure) {
    mapping = eligibilityFailure.mapping;
    reason = eligibilityFailure.reason;
    narratable = false;
  } else if (vetoDecisive) {
    mapping = vetoDecisive.mapping;
    reason = vetoDecisive.reason;
    narratable = vetoDecisive.narratable;
  } else if (insufficientCoverage) {
    mapping = policy.scoring.on_insufficient_coverage;
    reason = "insufficient_grounding";
    narratable = false;
  } else {
    mapping = selectBand(policy.score_bands, ratio).decision;
    reason = "score";
    narratable = true;
  }

  const references = policyReferences(policy, tools);
  const confidenceCoverage = reason === "score" || reason === "insufficient_grounding"
    ? coverage
    : reason === "veto_uncomputable" || reason === "eligibility_uncomputable" ? 0 : 1;
  const confidence = confidenceFor(facts, references.factIds, confidenceCoverage);
  const native = nativeMetrics(policy, facts, outputs);
  const publishedScore = eligibilityFailure ? null : score;
  const publishedRatio = eligibilityFailure ? null : ratio;
  const publishedCoverage = eligibilityFailure ? null : coverage;
  const reasonCodes = eligibilityFailure ? [eligibilityFailure.check.condition_id]
    : vetoDecisive ? [vetoDecisive.evaluation.veto_id]
      : insufficientCoverage ? uncomputableRules.map((rule) => rule.rule_id)
        : hits.map((rule) => rule.rule_id);
  const resultWithoutHash = canonicalValue({
    outcome: mapping.common_stance,
    stance: mapping.common_stance,
    reason,
    narratable,
    eligibility: {
      eligible: !eligibilityFailure,
      checks: eligibilityChecks,
      unmet_condition_ids: eligibilityChecks.filter((check) => check.computable && !check.value).map((check) => check.condition_id),
      uncomputable_condition_ids: eligibilityChecks.filter((check) => !check.computable).map((check) => check.condition_id),
    },
    computations: { outputs: Object.fromEntries(outputs), trace: toolTrace },
    score: publishedScore,
    ratio: publishedRatio,
    coverage: publishedCoverage,
    vetoes_evaluated: vetoEvaluations,
    vetoes_triggered: vetoesTriggered,
    reason_codes: reasonCodes,
    native_decision: {
      schema_id: policy.native_decision_schema,
      state: mapping.native_state,
      metrics: native.metrics,
      metric_status: native.status,
    },
    common_projection: {
      schema_id: preDecision.anonymous_method_contract.decision_contract.common_projection,
      stance: mapping.common_stance,
      reason,
      score_ratio: publishedRatio,
      coverage: publishedCoverage,
      veto_ids: vetoesTriggered.map((veto) => veto.veto_id),
      confidence: confidence.label,
      confidence_score: confidence.score,
    },
  });
  return canonicalValue({
    ...resultWithoutHash,
    policy_execution_hash: sha256({ deterministic_core_hash: preDecision.deterministic_core_hash, result: resultWithoutHash }),
  });
}

/** Execute and freeze one ready anonymous pre-decision. */
export function executeDeterministicPersonaPolicy(preDecision) {
  if (!isObject(preDecision) || preDecision.phase !== "anonymous_pre_decision") policyFail("INVALID_PRE_DECISION", "expected an anonymous_pre_decision payload");
  if (preDecision.eligibility?.status !== "ready") policyFail("PRE_DECISION_NOT_READY", `typed-fact gate is ${preDecision.eligibility?.status || "invalid"}`);
  const contract = preDecision.anonymous_method_contract;
  const policy = contract?.decision_policy;
  const tools = contract?.tools;
  const pipeline = contract?.computation_pipeline;
  const errors = validateDeterministicPolicyArtifacts({
    policy,
    tools,
    requiredFactTypes: contract?.required_fact_types,
    optionalFactTypes: contract?.optional_fact_types,
    pipeline,
    dslVersion: contract?.dsl_version,
    nativeDecisionSchema: preDecision.native_decision_schema,
  });
  if (errors.length) policyFail("INVALID_POLICY_ARTIFACT", `invalid deterministic PersonaPack policy:\n- ${errors.join("\n- ")}`, { errors });
  const structuredDecision = executeValidatedPolicy(preDecision, policy, tools, pipeline);
  const frozenDecision = freezeAnonymousDecision(preDecision, structuredDecision);
  return deepFreeze(canonicalValue({
    decision_layer_called: true,
    executor: "persona_v3_deterministic_dsl_v1_1",
    policy_execution_hash: structuredDecision.policy_execution_hash,
    frozen_decision: frozenDecision,
  }));
}
