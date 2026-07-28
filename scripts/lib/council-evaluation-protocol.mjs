import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { registry, selectRoster } from "../../mcp/lib/personas/registry.mjs";
import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CANONICAL_PROTOCOL_FILE = resolve(REPO_ROOT, "data/council-evaluation-protocol.v1.json");
export const CANONICAL_ARM_IDS = Object.freeze(["A", "B", "C", "D13", "D26", "E", "H"]);
export const PRIORITY_13_MASTER_IDS = Object.freeze([
  "master_damodaran",
  "master_graham",
  "master_ackman",
  "master_cathie_wood",
  "master_munger",
  "master_burry",
  "master_pabrai",
  "master_taleb",
  "master_lynch",
  "master_fisher",
  "master_jhunjhunwala",
  "master_druckenmiller",
  "master_buffett",
]);
export const CANONICAL_METRIC_IDS = Object.freeze([
  "fact_accuracy",
  "citation_validity",
  "calibration",
  "abstention_quality",
  "unique_information_contribution",
  "cost",
  "latency",
]);

const TOP_LEVEL_FIELDS = [
  "schema_version", "protocol_id", "protocol_status", "purpose", "canonical_arm_order",
  "registry_snapshot", "registration", "case_design", "point_in_time_controls",
  "anti_leakage_controls", "resource_accounting", "adjudication", "metrics", "arms",
  "comparison_policy",
];
const REGISTRATION_FIELDS = [
  "registered_at", "registration_hash", "dataset_hash", "case_ledger_hash",
  "model_matrix_hash", "prompt_bundle_hash", "runner_hash", "host_matrix_hash",
  "randomization_hash", "adjudication_rubric_hash", "signer_key_id", "signature",
];
const ARM_FIELDS = [
  "arm_id", "description", "execution_mode", "analyst_ids", "master_ids", "verifier_ids",
  "base_arm_ids", "master_execution_mode", "bounded_repair", "human_reference",
  "result_status", "results", "signatures", "passed_claims",
];
const METRIC_FIELDS = [
  "metric_id", "family", "estimand", "unit", "direction", "aggregation",
  "reported_statistics", "requires_blind_adjudication", "result",
];
const COMPARISON_FIELDS = [
  "primary_pairs", "matched_cost_pairs_required", "human_reference_role",
  "agreement_is_not_independence", "seat_count_is_not_sample_size", "promotion_thresholds",
  "multiplicity_policy", "release_claims", "promotion_effect",
];
const METRIC_FAMILIES = Object.freeze({
  fact_accuracy: "fact",
  citation_validity: "citation",
  calibration: "calibration",
  abstention_quality: "abstention",
  unique_information_contribution: "unique_contribution",
  cost: "cost",
  latency: "latency",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactFields(value, expected, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!same(actual, wanted)) {
    const missing = wanted.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !wanted.includes(key));
    if (missing.length) errors.push(`${path} is missing fields: ${missing.join(", ")}`);
    if (unknown.length) errors.push(`${path} has unknown fields: ${unknown.join(", ")}`);
  }
  return true;
}

function exactValue(actual, expected, path, errors) {
  if (!same(actual, expected)) errors.push(`${path} drifted; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function nonEmptyStrings(value, path, errors, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    errors.push(`${path} must be ${allowEmpty ? "an" : "a non-empty"} array`);
    return;
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) errors.push(`${path}[${index}] must be a non-empty string`);
    if (seen.has(item)) errors.push(`${path}[${index}] duplicates ${JSON.stringify(item)}`);
    seen.add(item);
  }
}

export function loadCouncilEvaluationProtocol(file = CANONICAL_PROTOCOL_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function liveSnapshot() {
  const reg = registry();
  const masters = reg.ids("master");
  const verifiers = selectRoster(reg, { kind: "verifier", roster: "verify" }).map((persona) => persona.id);
  return {
    reg,
    default_analyst_ids: [...DEFAULT_TASKS],
    verifier_ids: verifiers,
    canonical_26_master_ids: masters,
  };
}

function validateNoResults(protocol, errors) {
  exactFields(protocol.registration, REGISTRATION_FIELDS, "registration", errors);
  for (const field of REGISTRATION_FIELDS) {
    if (protocol.registration?.[field] !== null) {
      errors.push(`registration.${field} must remain null in draft_unregistered protocol`);
    }
  }
  if (protocol.comparison_policy?.promotion_thresholds !== null) errors.push("comparison_policy.promotion_thresholds must remain null before registration");
  if (protocol.comparison_policy?.multiplicity_policy !== null) errors.push("comparison_policy.multiplicity_policy must remain null before registration");
  if (!Array.isArray(protocol.comparison_policy?.release_claims) || protocol.comparison_policy.release_claims.length) {
    errors.push("comparison_policy.release_claims must remain empty; a draft cannot claim a result");
  }
  if (protocol.comparison_policy?.promotion_effect !== "none") errors.push("comparison_policy.promotion_effect must remain none");
  for (const [index, metric] of (protocol.metrics || []).entries()) {
    if (metric?.result !== null) errors.push(`metrics[${index}].result must remain null before execution`);
  }
  for (const [index, arm] of (protocol.arms || []).entries()) {
    const path = `arms[${index}]`;
    if (arm?.result_status !== "not_run") errors.push(`${path}.result_status must remain not_run`);
    if (arm?.results !== null) errors.push(`${path}.results must remain null`);
    if (!Array.isArray(arm?.signatures) || arm.signatures.length) errors.push(`${path}.signatures must remain empty`);
    if (!Array.isArray(arm?.passed_claims) || arm.passed_claims.length) errors.push(`${path}.passed_claims must remain empty`);
  }
}

function validateControls(protocol, errors) {
  const expected = {
    case_design: {
      case_unit: "company_x_as_of_x_event",
      minimum_shared_cases: 48,
      minimum_historical_clusters: 36,
      cluster_keys: ["issuer", "event", "market_regime"],
      same_frozen_cases_across_machine_arms: true,
      human_arm_receives_same_case_question: true,
      prospective_shadow_cases_required: true,
      shadow_beta_interpretation: "operational_only_not_outcome_validation",
      returns_role: "recorded_lagging_outcome_never_a_standalone_promotion_gate",
    },
    point_in_time_controls: {
      fact_visibility_rule: "public_at <= as_of AND known_at <= as_of",
      filing_visibility_rule: "filed_at <= as_of",
      memory_visibility_rule: "public_at <= as_of AND memory_created_at <= as_of",
      prediction_freeze_rule: "all_arm_predictions_frozen_before_outcome_or_adjudication_access",
      outcome_visibility: "withheld_until_prediction_freeze",
      restatement_rule: "use_only_restatements_public_by_as_of",
      source_retrieval_log_required: true,
    },
    anti_leakage_controls: {
      frozen_case_membership_before_execution: true,
      frozen_arm_order_before_execution: true,
      survivorship_universe_as_of_required: true,
      prompt_model_runner_host_hashes_required: true,
      post_as_of_search_results_forbidden: true,
      cross_arm_context_sharing_forbidden: true,
      human_adjudicators_blinded_to_arm: true,
      case_outcomes_hidden_from_models: true,
      known_training_contamination_recorded_not_self_cleared: true,
      threshold_tuning_on_shadow_beta_forbidden: true,
    },
    resource_accounting: {
      record_wall_clock_critical_path: true,
      record_cpu_time_when_available: true,
      record_model_input_tokens: true,
      record_model_output_tokens: true,
      record_tool_calls: true,
      record_network_requests: true,
      record_provider_billed_cost: true,
      record_failed_and_retried_work: true,
      matched_cost_secondary_analysis_required: true,
      unmatched_quality_and_cost_reported_together: true,
    },
    adjudication: {
      material_claim_unit: "normalized_claim_cluster",
      fact_adjudicators_minimum: 2,
      disagreement_adjudicator_count: 1,
      arm_identity_blinded: true,
      source_documents_visible_to_adjudicators: true,
      native_decisions_scored_before_common_projection: true,
      agreement_reported_separately_from_independence: true,
      n_eff_policy: "separate_preregistered_resolved_outcome_protocol_or_null",
    },
  };
  for (const [field, value] of Object.entries(expected)) exactValue(protocol[field], value, field, errors);
}

function validateMetrics(protocol, errors) {
  if (!Array.isArray(protocol.metrics)) {
    errors.push("metrics must be an array");
    return;
  }
  exactValue(protocol.metrics.map((metric) => metric?.metric_id), CANONICAL_METRIC_IDS, "metrics metric order", errors);
  for (const [index, metric] of protocol.metrics.entries()) {
    const path = `metrics[${index}]`;
    if (!exactFields(metric, METRIC_FIELDS, path, errors)) continue;
    if (metric.family !== METRIC_FAMILIES[metric.metric_id]) errors.push(`${path}.family does not match ${metric.metric_id}`);
    for (const field of ["estimand", "unit", "aggregation"]) {
      if (typeof metric[field] !== "string" || !metric[field].trim()) errors.push(`${path}.${field} must be non-empty`);
    }
    if (!["higher_is_better", "lower_is_better"].includes(metric.direction)) errors.push(`${path}.direction is invalid`);
    if (typeof metric.requires_blind_adjudication !== "boolean") errors.push(`${path}.requires_blind_adjudication must be boolean`);
    nonEmptyStrings(metric.reported_statistics, `${path}.reported_statistics`, errors);
  }
}

function expectedArm(id, live) {
  const defaultAnalysts = live.default_analyst_ids;
  const masters = live.canonical_26_master_ids;
  const common = { verifier_ids: [], bounded_repair: null, human_reference: null };
  if (id === "A") return { execution_mode: "single_agent_baseline", analyst_ids: [], master_ids: [], base_arm_ids: [], master_execution_mode: "none", ...common };
  if (id === "B") return { execution_mode: "machine_council", analyst_ids: defaultAnalysts, master_ids: [], base_arm_ids: [], master_execution_mode: "none", ...common };
  if (id === "C") return { execution_mode: "machine_council", analyst_ids: defaultAnalysts, master_ids: masters, base_arm_ids: ["B"], master_execution_mode: "legacy_prompt_snapshot", ...common };
  if (id === "D13") return { execution_mode: "machine_council", analyst_ids: defaultAnalysts, master_ids: [...PRIORITY_13_MASTER_IDS], base_arm_ids: ["B"], master_execution_mode: "persona_v3_deterministic", ...common };
  if (id === "D26") return { execution_mode: "machine_council", analyst_ids: defaultAnalysts, master_ids: masters, base_arm_ids: ["B"], master_execution_mode: "persona_v3_deterministic", ...common };
  if (id === "E") return {
    execution_mode: "machine_council_verified_variants",
    analyst_ids: defaultAnalysts,
    master_ids: [],
    verifier_ids: live.verifier_ids,
    base_arm_ids: ["D13", "D26"],
    master_execution_mode: "inherited_persona_v3_deterministic",
    bounded_repair: {
      maximum_rounds: 2,
      redispatch_scope: "only_agents_with_parse_failure_missing_sources_or_disputed_material_claims",
      residual_gaps_must_be_reported: true,
    },
    human_reference: null,
  };
  return {
    execution_mode: "human_reference",
    analyst_ids: [],
    master_ids: [],
    verifier_ids: [],
    base_arm_ids: [],
    master_execution_mode: "none",
    bounded_repair: null,
    human_reference: {
      minimum_independent_analysts: 2,
      maximum_independent_analysts: 3,
      blinded_adjudicator_count: 1,
      automated_vote: false,
      independent_before_adjudication: true,
    },
  };
}

function validateArms(protocol, live, errors) {
  if (!Array.isArray(protocol.arms)) {
    errors.push("arms must be an array");
    return;
  }
  exactValue(protocol.arms.map((arm) => arm?.arm_id), CANONICAL_ARM_IDS, "canonical arm order", errors);
  for (const [index, arm] of protocol.arms.entries()) {
    const path = `arms[${index}]`;
    if (!exactFields(arm, ARM_FIELDS, path, errors)) continue;
    if (typeof arm.description !== "string" || arm.description.length < 24) errors.push(`${path}.description is too short`);
    for (const field of ["analyst_ids", "master_ids", "verifier_ids", "base_arm_ids"]) nonEmptyStrings(arm[field], `${path}.${field}`, errors, { allowEmpty: true });
    const expected = expectedArm(arm.arm_id, live);
    for (const [field, value] of Object.entries(expected)) exactValue(arm[field], value, `${path}.${field}`, errors);
  }
}

export function validateCouncilEvaluationProtocol(protocol = loadCouncilEvaluationProtocol()) {
  const errors = [];
  if (!isObject(protocol)) return { valid: false, errors: ["protocol must be an object"] };
  exactFields(protocol, TOP_LEVEL_FIELDS, "protocol", errors);
  if (protocol.schema_version !== 1) errors.push("schema_version must be 1");
  if (protocol.protocol_id !== "alphacouncil_canonical_arm_comparison_v1") errors.push("protocol_id is invalid");
  if (protocol.protocol_status !== "draft_unregistered") errors.push("protocol_status must remain draft_unregistered");
  if (typeof protocol.purpose !== "string" || protocol.purpose.length < 40) errors.push("purpose is too short");
  exactValue(protocol.canonical_arm_order, CANONICAL_ARM_IDS, "canonical_arm_order", errors);

  const live = liveSnapshot();
  exactFields(protocol.registry_snapshot, ["default_analyst_ids", "verifier_ids", "priority_13_master_ids", "canonical_26_master_ids"], "registry_snapshot", errors);
  exactValue(protocol.registry_snapshot?.default_analyst_ids, live.default_analyst_ids, "registry_snapshot.default_analyst_ids vs live DEFAULT_TASKS", errors);
  exactValue(protocol.registry_snapshot?.verifier_ids, live.verifier_ids, "registry_snapshot.verifier_ids vs live verify roster", errors);
  exactValue(protocol.registry_snapshot?.priority_13_master_ids, PRIORITY_13_MASTER_IDS, "registry_snapshot.priority_13_master_ids", errors);
  exactValue(protocol.registry_snapshot?.canonical_26_master_ids, live.canonical_26_master_ids, "registry_snapshot.canonical_26_master_ids vs live master registry", errors);
  if (live.canonical_26_master_ids.length !== CANONICAL_MASTER_COUNT) errors.push(`live master registry must contain exactly ${CANONICAL_MASTER_COUNT} enabled seats, got ${live.canonical_26_master_ids.length}`);
  if (live.verifier_ids.length !== 3) errors.push(`live verify roster must contain exactly 3 verifiers, got ${live.verifier_ids.length}`);
  for (const id of live.default_analyst_ids) {
    const persona = live.reg.get(id);
    if (!persona || persona.kind !== "analyst" || persona.enabled === false) errors.push(`default analyst ${id} is missing, disabled or wrong kind`);
  }

  validateNoResults(protocol, errors);
  validateControls(protocol, errors);
  validateMetrics(protocol, errors);
  validateArms(protocol, live, errors);
  exactFields(protocol.comparison_policy, COMPARISON_FIELDS, "comparison_policy", errors);
  exactValue(protocol.comparison_policy?.primary_pairs, ["D13-B", "D26-B", "E(D13)-D13", "E(D26)-D26", "C-B"], "comparison_policy.primary_pairs", errors);
  exactValue(protocol.comparison_policy?.matched_cost_pairs_required, ["C-D13", "C-D26", "D13-D26"], "comparison_policy.matched_cost_pairs_required", errors);
  if (protocol.comparison_policy?.agreement_is_not_independence !== true) errors.push("comparison_policy must separate agreement from independence");
  if (protocol.comparison_policy?.seat_count_is_not_sample_size !== true) errors.push("comparison_policy must reject seat count as sample size");
  if (protocol.comparison_policy?.human_reference_role !== "blinded_quality_reference_not_vote_or_ground_truth_by_authority") errors.push("comparison_policy.human_reference_role drifted");

  return {
    valid: errors.length === 0,
    errors,
    live: {
      default_analyst_ids: live.default_analyst_ids,
      verifier_ids: live.verifier_ids,
      canonical_26_master_ids: live.canonical_26_master_ids,
    },
  };
}

export function councilEvaluationProtocolReport(protocol = loadCouncilEvaluationProtocol()) {
  const validation = validateCouncilEvaluationProtocol(protocol);
  const arms = Array.isArray(protocol?.arms) ? protocol.arms : [];
  const signatures = arms.reduce((count, arm) => count + (Array.isArray(arm?.signatures) ? arm.signatures.length : 0), 0)
    + (protocol?.registration?.signature ? 1 : 0);
  const passedClaims = arms.reduce((count, arm) => count + (Array.isArray(arm?.passed_claims) ? arm.passed_claims.length : 0), 0)
    + (Array.isArray(protocol?.comparison_policy?.release_claims) ? protocol.comparison_policy.release_claims.length : 0);
  return canonicalValue({
    protocol_id: protocol?.protocol_id || null,
    status: protocol?.protocol_status || null,
    valid: validation.valid,
    draft_hash: sha256(protocol),
    registered: protocol?.registration?.registered_at !== null,
    dataset_hash: protocol?.registration?.dataset_hash ?? null,
    case_ledger_hash: protocol?.registration?.case_ledger_hash ?? null,
    result_count: Array.isArray(protocol?.metrics) ? protocol.metrics.filter((metric) => metric?.result !== null).length : 0,
    signature_count: signatures,
    passed_claim_count: passedClaims,
    arm_count: arms.length,
    metric_ids: Array.isArray(protocol?.metrics) ? protocol.metrics.map((metric) => metric.metric_id) : [],
    arms: arms.map((arm) => ({
      arm_id: arm.arm_id,
      execution_mode: arm.execution_mode,
      analysts: arm.analyst_ids?.length || 0,
      masters: arm.master_ids?.length || 0,
      verifiers: arm.verifier_ids?.length || 0,
      base_arm_ids: arm.base_arm_ids || [],
      result_status: arm.result_status,
    })),
    blockers: [
      ...(protocol?.registration?.dataset_hash === null ? ["dataset_hash_not_frozen"] : []),
      ...(protocol?.registration?.case_ledger_hash === null ? ["case_ledger_hash_not_frozen"] : []),
      ...(protocol?.registration?.registration_hash === null ? ["protocol_not_registered"] : []),
      ...(protocol?.comparison_policy?.promotion_thresholds === null ? ["promotion_thresholds_not_preregistered"] : []),
      ...(protocol?.comparison_policy?.multiplicity_policy === null ? ["multiplicity_policy_not_preregistered"] : []),
    ],
    errors: validation.errors,
  });
}
