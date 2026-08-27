import { canonicalValue, sha256 } from "./canonical.mjs";

export const UNSOURCED_AI_PROPOSAL = "unsourced_ai_proposal";
export const POLICY_NUMERIC_BASELINE_HASH = "sha256:74ada6c069d56edf1a2051ceeef543159a178a09d69d3caa18f6413581de13ba";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const BINARY_CONDITIONS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte",
  "date_gt", "date_gte", "date_lt", "date_lte",
]);
const POINT_IN_TIME_FIELDS = new Set([
  "as_of", "public_at", "known_at", "published_at", "memory_created_at",
]);
const SIMULATION_IDENTITY_FIELD = /(^|_)(hash|digest)$/u;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function records(policy) {
  return {
    eligibility: policy?.eligibility?.all || [],
    vetoes: policy?.hard_vetoes || [],
    scoring_rules: policy?.scoring?.rules || [],
    score_bands: policy?.score_bands || [],
  };
}

function provenanceStatus(value, path) {
  if (!isObject(value)) throw new Error(`${path}: provenance is required`);
  if (value.status === UNSOURCED_AI_PROPOSAL && Object.keys(value).length === 1) return value.status;
  if (value.status === "sourced"
    && Object.keys(value).sort().join(",") === "source_id,status"
    && typeof value.source_id === "string" && value.source_id.trim()) return value.status;
  throw new Error(`${path}: invalid provenance shape`);
}

/** Count policy-record labels without treating a proxy source id as evidence. */
export function provenanceSummary(policy) {
  if (!isObject(policy)) throw new Error("decision policy is required");
  const groups = records(policy);
  const breakdown = {};
  let unsourced = 0;
  let sourced = 0;
  for (const [group, values] of Object.entries(groups)) {
    let groupUnsourced = 0;
    values.forEach((record, index) => {
      const status = provenanceStatus(record?.provenance, `${group}[${index}]`);
      if (status === UNSOURCED_AI_PROPOSAL) { unsourced += 1; groupUnsourced += 1; }
      else sourced += 1;
    });
    breakdown[group] = groupUnsourced;
  }
  const structural = provenanceStatus(policy.provenance, "decision_policy") === UNSOURCED_AI_PROPOSAL;
  return Object.freeze(canonicalValue({
    unsourced,
    sourced,
    breakdown,
    structural_unsourced: structural,
  }));
}

/** Remove only the new metadata field so the pre-WP-3F policy subject remains hash-locked. */
export function stripPolicyProvenance(value) {
  if (Array.isArray(value)) return value.map(stripPolicyProvenance);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "provenance")
    .map(([key, child]) => [key, stripPolicyProvenance(child)]));
}

export function policySubjectHash(seats) {
  return sha256((seats || []).map(({ persona_id, decision_policy }) => ({
    persona_id,
    decision_policy: stripPolicyProvenance(decision_policy),
  })));
}

/** Strip only identity metadata permitted to drift in the WP-3F simulation rebind. */
export function stripSimulationIdentity(value) {
  if (Array.isArray(value)) return value.map(stripSimulationIdentity);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "byte_length" && !SIMULATION_IDENTITY_FIELD.test(key))
    .map(([key, child]) => [key, stripSimulationIdentity(child)]));
}

export function factIdsIn(value, out = new Set()) {
  if (!value || typeof value !== "object") return out;
  if (typeof value.fact_id === "string") out.add(value.fact_id);
  for (const child of Object.values(value)) factIdsIn(child, out);
  return out;
}

/**
 * Three current vetoes are a single comparison between two live operands. The v1 harness
 * records them as pending instead of pretending a literal-bound witness proves them.
 */
export function rootNonliteralComparison(condition) {
  return BINARY_CONDITIONS.has(condition?.op)
    && !Object.hasOwn(condition?.left || {}, "literal")
    && !Object.hasOwn(condition?.right || {}, "literal");
}

function cutoff(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(ISO_DAY.test(value) ? `${value}T23:59:59.999Z` : value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Validate evaluation rows only when they exist; an empty corpus remains explicitly empty. */
export function caseAsOfErrors(cases, { kind = "case" } = {}) {
  const errors = [];
  (cases || []).forEach((record, index) => {
    const path = `${kind}[${index}]`;
    if (!isObject(record)) { errors.push(`${path}: must be an object`); return; }
    const caseCutoff = cutoff(record.case_as_of);
    if (caseCutoff === null) {
      errors.push(`${path}.case_as_of: required valid date or zoned timestamp`);
      return;
    }
    if (caseIsLabeled(record)) {
      const labelCutoff = cutoff(record.label_as_of);
      if (labelCutoff === null) {
        errors.push(`${path}.label_as_of: required for a labeled case`);
      } else if (labelCutoff <= caseCutoff) {
        errors.push(`${path}.label_as_of: must be later than case_as_of`);
      }
    }
    const visit = (value, currentPath) => {
      if (Array.isArray(value)) {
        value.forEach((child, childIndex) => visit(child, `${currentPath}[${childIndex}]`));
        return;
      }
      if (!isObject(value)) return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = `${currentPath}.${key}`;
        if (POINT_IN_TIME_FIELDS.has(key) && key !== "case_as_of") {
          const time = cutoff(child);
          if (time === null) errors.push(`${childPath}: must be a valid date or zoned timestamp`);
          else if (time > caseCutoff) errors.push(`${childPath}: exceeds case_as_of`);
        }
        visit(child, childPath);
      }
    };
    visit(record, path);
  });
  return errors;
}

export function caseIsLabeled(record) {
  if (!isObject(record)) return false;
  return Object.keys(record).some((key) => key === "label" || key.startsWith("expected_"));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function validateImpersonationLintConfig(config) {
  if (!isObject(config) || config.schema_version !== 1
    || config.artifact_kind !== "alphacouncil_impersonation_lint") {
    throw new Error("invalid impersonation lint header");
  }
  if (!Array.isArray(config.rules) || !Array.isArray(config.identity_templates)) {
    throw new Error("impersonation lint rules and identity_templates are required");
  }
  const ids = new Set();
  for (const [index, rule] of config.rules.entries()) {
    if (!isObject(rule)
      || Object.keys(rule).sort().join(",") !== "description,flags,id,pattern"
      || typeof rule.id !== "string" || typeof rule.pattern !== "string"
      || typeof rule.flags !== "string" || typeof rule.description !== "string") {
      throw new Error(`impersonation lint rule ${index} is invalid`);
    }
    if (ids.has(rule.id)) throw new Error(`duplicate impersonation lint rule ${rule.id}`);
    ids.add(rule.id);
    new RegExp(rule.pattern, rule.flags);
  }
  for (const [index, template] of config.identity_templates.entries()) {
    if (!isObject(template)
      || Object.keys(template).sort().join(",") !== "flags,id,pattern"
      || !template.pattern.includes("{identity}")) {
      throw new Error(`impersonation identity template ${index} is invalid`);
    }
  }
  return config;
}

export function impersonationHits(text, config, { identities = [] } = {}) {
  validateImpersonationLintConfig(config);
  const hits = [];
  for (const rule of config.rules) {
    const match = new RegExp(rule.pattern, rule.flags).exec(String(text || ""));
    if (match) hits.push({ rule_id: rule.id, match: match[0] });
  }
  for (const template of config.identity_templates) {
    for (const identity of identities.filter((value) => typeof value === "string" && value.trim())) {
      const pattern = template.pattern.replaceAll("{identity}", escapeRegex(identity.trim()));
      const match = new RegExp(pattern, template.flags).exec(String(text || ""));
      if (match) hits.push({ rule_id: template.id, match: match[0] });
    }
  }
  return canonicalValue(hits);
}

export function thresholdDisclosure(summary) {
  const b = summary.breakdown;
  return `thresholds: ${summary.unsourced} AI-proposed, unsourced (${b.eligibility}/${b.vetoes}/${b.scoring_rules}/${b.score_bands}); structural parameters: unsourced`;
}

export function validateDerivationBindings(tools, bindings) {
  const errors = [];
  const expected = new Map((bindings || []).map((binding) => [`${binding.persona_id}\0${binding.tool_id}`, binding]));
  for (const tool of tools || []) {
    const key = `${tool.persona_id}\0${tool.tool.id}`;
    const binding = expected.get(key);
    if (!binding) { errors.push(`${tool.persona_id}/${tool.tool.id}: missing formula binding`); continue; }
    for (const field of ["derivation_spec_hash", "derivation_evidence_hash"]) {
      if (!HASH.test(tool.tool[field] || "")) errors.push(`${tool.persona_id}/${tool.tool.id}.${field}: invalid hash`);
      if (tool.tool[field] !== binding[field]) errors.push(`${tool.persona_id}/${tool.tool.id}.${field}: binding mismatch`);
    }
    if (tool.tool.derivation_spec_id !== binding.derivation_spec_id) {
      errors.push(`${tool.persona_id}/${tool.tool.id}.derivation_spec_id: binding mismatch`);
    }
    expected.delete(key);
  }
  for (const key of expected.keys()) errors.push(`${key.replace("\0", "/")}: unused formula binding`);
  return errors;
}
