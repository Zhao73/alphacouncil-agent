/**
 * Deterministic PersonaPack v3 editorial-prototype factory.
 *
 * These artifacts make every one of the 26 planned seats physically inspectable without
 * pretending that source adjudication, case labeling, experiments, or production promotion
 * happened. The production loader does not read this tree and a draft never contains a
 * `manifest.json`.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import inventory from "../../data/persona-v3-build-specs.v1.mjs";
import { defaultKnowledgeDir } from "../../mcp/lib/personas-v3/admission.mjs";
import { canonicalJson, canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { loadV3Packs } from "../../mcp/lib/personas-v3/loader.mjs";
import { inspectSourceAcquisitions } from "../../mcp/lib/personas-v3/source-acquisition.mjs";
import {
  CANONICAL_MASTER_COUNT,
  CANONICAL_MASTER_IDS,
  canonicalMasterBlueprints,
  createScaffoldDocument,
  defaultStagingRoot,
  inspectPersonaV3Staging,
} from "../../mcp/lib/personas-v3/staging.mjs";
import { defaultPersonaDir } from "../../mcp/lib/personas/registry.mjs";

export const DRAFT_STATUS = "editorial_prototype";
export const DRAFT_REVIEW_STATUS = "pending_human_adjudication";
export const DRAFT_ARTIFACT_FILES = Object.freeze({
  method_hypotheses: "artifacts/method-hypotheses.json",
  research_policy: "artifacts/research-policy.json",
  decision_policy: "artifacts/decision-policy.json",
  tools: "artifacts/tools.json",
  case_plan: "artifacts/case-plan.json",
  memory_policy: "artifacts/memory-policy.json",
  voice_en: "artifacts/voice-en.md",
  voice_zh: "artifacts/voice-zh.md",
  draft_pack_index: "artifacts/draft-pack-index.json",
});

const ARTIFACT_COUNT_PER_SEAT = Object.keys(DRAFT_ARTIFACT_FILES).length;
const FORBIDDEN_DRAFT_KEYS = new Set([
  "admission",
  "case_outcomes",
  "experiment_results",
  "grade",
  "manifest",
  "maturity",
  "reviewed_at",
  "reviewer",
  "reviewer_id",
  "reviewer_ids",
  "source_ids",
]);

export class PersonaV3DraftError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaV3DraftError";
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new PersonaV3DraftError(message, details);
}

function prettyJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function draftHeader(personaId, artifactKind) {
  return {
    schema_version: 1,
    artifact_kind: artifactKind,
    artifact_status: DRAFT_STATUS,
    human_adjudication_status: DRAFT_REVIEW_STATUS,
    persona_id: personaId,
    production_effect: "none",
  };
}

function factPartition(seat) {
  const criticalCount = Math.max(2, Math.min(seat.required_fact_types.length - 1, Math.ceil(seat.required_fact_types.length / 2)));
  return {
    critical: seat.required_fact_types.slice(0, criticalCount),
    optional: seat.required_fact_types.slice(criticalCount),
  };
}

function operationFamily(tool) {
  const text = `${tool.tool_id} ${tool.purpose}`.toLowerCase();
  const matches = [
    [/reverse/, "reverse_solver"],
    [/waterfall|floor/, "downside_waterfall"],
    [/forecast/, "forecast_model"],
    [/kelly|sizer|sizing|position/, "risk_sizing"],
    [/audit|leakage/, "integrity_audit"],
    [/stress/, "stress_test"],
    [/surface|curve/, "curve_construction"],
    [/classif/, "classification"],
    [/decompos|factor/, "decomposition"],
    [/graph|map|ledger/, "evidence_graph"],
    [/monitor/, "change_monitor"],
    [/rebuild|recomput|normalize/, "reconciliation"],
    [/payoff|edge/, "payoff_model"],
    [/bridge/, "linked_model"],
    [/valuation|value/, "valuation_model"],
    [/return/, "return_model"],
  ];
  return matches.find(([pattern]) => pattern.test(text))?.[1] || "deterministic_transform";
}

function operationSteps(family, purpose) {
  const steps = {
    reverse_solver: ["Freeze the observable market constraint set at as_of.", "Solve backward for the output assumptions required by that constraint.", "Perturb each load-bearing assumption and preserve the full sensitivity range."],
    downside_waterfall: ["Order claims and downside inputs before assigning residual value.", "Reconcile the state-contingent recovery or floor without an editorial threshold.", "Stress senior claims and recoveries independently."],
    forecast_model: ["Freeze the estimation window and feature availability dates.", "Produce a versioned forecast and retain its out-of-sample error measure.", "Compare the forecast error with the proposed decision margin."],
    risk_sizing: ["Recompute the payoff distribution after liquidity constraints.", "Apply ruin and dependence constraints before any sizing output.", "Return a cap or abstention; never infer a position from prose."],
    integrity_audit: ["Trace every input to its availability time and declared transformation.", "Flag leakage, unsupported adjustments, and unreconciled definitions.", "Fail closed while any load-bearing integrity flag remains unresolved."],
    stress_test: ["Establish the dated base state and its dependency structure.", "Shock one named driver at a time and then the coupled adverse state.", "Retain the worst reproducible result and the assumption that caused it."],
    curve_construction: ["Normalize conventions, timestamps, and comparable observations.", "Construct the curve or surface while preserving executable inputs.", "Reject relationships that disappear under convention or liquidity checks."],
    classification: ["Define mutually distinguishable candidate categories from observable facts.", "Assign the category only when its required facts are computable.", "Return an abstention state for ambiguous or conflicting classifications."],
    decomposition: ["Define the exposure or return basis before decomposition.", "Estimate each named component on the same dated sample.", "Keep residual and uncertainty separate from explained components."],
    evidence_graph: ["Create dated nodes for each relevant fact and relationship.", "Separate independent observations from repeated or dependent claims.", "Expose conflicts, missing links, and the path to the proposed output."],
    change_monitor: ["Freeze the initial state and observable break conditions.", "Recompute only from newly public facts within the as_of boundary.", "Emit the changed state and the exact triggering fact category."],
    reconciliation: ["Reconcile definitions and periods across all required inputs.", "Apply each adjustment as a separately inspectable transformation.", "Return the reconstructed output plus unresolved reconciliation gaps."],
    payoff_model: ["Enumerate state-contingent payoffs and executable costs.", "Compute gross and net payoff measures without a hidden threshold.", "Stress timing, friction, and adverse-state assumptions independently."],
    linked_model: ["Define the causal or accounting bridge between input groups.", "Compute each bridge step as a named intermediate output.", "Reverse-check the result against the original constraints."],
    valuation_model: ["Freeze dated operating inputs and capital claims.", "Compute a range from explicit scenarios rather than a point assertion.", "Reverse-test the range against price-implied assumptions."],
    return_model: ["Define the holding period and capital base consistently.", "Separate operating, reinvestment, financing, and valuation contributions.", "Stress the return against adverse assumptions and opportunity cost."],
    deterministic_transform: ["Freeze and validate every declared input.", `Implement the planned transformation: ${purpose}`, "Expose intermediate values and fail closed when a required input is missing."],
  };
  return steps[family];
}

function toolInputFacts(seat, tool, criticalFacts) {
  const roots = new Set(tool.output_fact_types.map((fact) => fact.split(".", 1)[0]));
  const matched = seat.required_fact_types.filter((fact) => roots.has(fact.split(".", 1)[0]));
  for (const fact of criticalFacts) if (matched.length < 2 && !matched.includes(fact)) matched.push(fact);
  return matched.length ? matched : criticalFacts;
}

function commonProjection(nativeState, index) {
  const state = nativeState.toLowerCase();
  if (/^(out_of_scope|too_hard|insufficient.*|invalid_test|unsupported.*|unidentified.*|regime_unknown|do_not_understand|document_gap|downside_unknown|unvalued|no_floor|surface_unavailable|no_loop|no_inflection|passive_only)$/u.test(state)) return "out_of_scope";
  if (/(reject|fatal|overpriced|overvalued|fragile|broken|infeasible|no_signal|no_net_edge|mispriced_untradeable|integrity_reject|defensive|opinion_only|no_trade|no_measurable_edge)/u.test(state)) return "opposed";
  if (/(underpriced|own_at_price|margin_of_safety|deployable|asymmetric|long_duration|fractional|residual|resilient|act_at_price|concentrated|opportunity|candidate|owner|aggressive|structural_mispricing|absolute_return|engagement|undervalued|convex|relative_value|executable|reinforcing|no_fatal_path)/u.test(state)) return "constructive";
  return index === 0 ? "out_of_scope" : "cautious";
}

function buildMethodHypotheses(seat) {
  return {
    ...draftHeader(seat.persona_id, "persona_v3_method_hypotheses_draft"),
    method_scope_hypothesis: seat.method_scope.planning_hypothesis,
    applicable_domains: seat.method_scope.applicable_domains,
    excluded_claims: seat.method_scope.excluded_claims,
    computation_hypotheses: seat.planned_dedicated_tools.map((tool) => ({
      hypothesis_id: `${tool.tool_id}.method_hypothesis`,
      planned_tool_id: tool.tool_id,
      proposition: tool.purpose,
      attribution_status: DRAFT_REVIEW_STATUS,
    })),
    veto_hypotheses: seat.veto_families.map((veto) => ({
      veto_id: veto.veto_id,
      candidate_rule: veto.candidate_rule,
      adjudication_status: DRAFT_REVIEW_STATUS,
      threshold: null,
    })),
    known_limits: seat.known_limits,
  };
}

function buildResearchPolicy(seat, partition, sourceSnapshot) {
  return {
    ...draftHeader(seat.persona_id, "persona_v3_research_policy_draft"),
    planner_status: "planned_unverified",
    scope: seat.method_scope,
    fact_contract: {
      classification_basis: "Editorial ordering hypothesis from the canonical build spec; priority requires human adjudication.",
      critical: partition.critical.map((factType) => ({ fact_type: factType, on_missing: "abstain" })),
      optional: partition.optional.map((factType) => ({ fact_type: factType, on_missing: "skip_and_reduce_coverage" })),
    },
    source_acquisition_targets: seat.primary_source_acquisition_targets.map((target) => ({
      target_id: target.target_id,
      source_family: target.source_family,
      acquisition_target: target.acquisition_target,
      acquisition_status: target.acquisition_status,
      human_adjudication_status: target.human_adjudication_status,
      raw_candidate_linkage_status: "not_established",
    })),
    raw_acquisition_snapshot: {
      status: sourceSnapshot.retrieved_unadjudicated_count ? "retrieved_unadjudicated" : "none",
      candidate_count: sourceSnapshot.retrieved_unadjudicated_count,
      target_linkage_status: "not_established",
      establishes_method_evidence: false,
    },
    disconfirmation_hypotheses: seat.veto_families.map((veto) => ({
      veto_id: veto.veto_id,
      search_goal: `Seek dated primary evidence that could trigger or falsify this veto hypothesis: ${veto.candidate_rule}`,
    })),
    evidence_boundary: {
      point_in_time_rule: "public_at <= as_of",
      raw_acquisition_is_method_evidence: false,
      unsupported_threshold_action: "abstain",
      private_information_allowed: false,
    },
  };
}

function buildDecisionPolicy(seat) {
  return {
    ...draftHeader(seat.persona_id, "persona_v3_decision_policy_draft"),
    dsl_target: "1.1",
    implementation_status: "planned_unverified",
    native_decision_schema: seat.native_decision_contract.schema_id,
    native_states: seat.native_decision_contract.states,
    common_projection_hypotheses: seat.native_decision_contract.states.map((nativeState, index) => ({
      native_state: nativeState,
      common_stance: commonProjection(nativeState, index),
      projection_status: DRAFT_REVIEW_STATUS,
    })),
    eligibility_hypotheses: seat.native_decision_contract.eligibility_facts.map((requirement, index) => ({
      condition_id: `${seat.persona_id}.eligibility_${index + 1}`,
      requirement,
      on_false: "out_of_scope",
      threshold: null,
      adjudication_status: DRAFT_REVIEW_STATUS,
    })),
    hard_veto_hypotheses: seat.veto_families.map((veto) => ({
      veto_id: veto.veto_id,
      candidate_rule: veto.candidate_rule,
      on_trigger: "opposed_or_out_of_scope",
      on_uncomputable: "out_of_scope",
      threshold: null,
      adjudication_status: DRAFT_REVIEW_STATUS,
    })),
    fail_closed_reasons: seat.native_decision_contract.fail_closed_reasons,
    required_outputs: seat.native_decision_contract.required_outputs,
    scoring_status: "not_encoded_pending_human_adjudication",
  };
}

function buildTools(seat, partition) {
  return {
    ...draftHeader(seat.persona_id, "persona_v3_computation_prototypes_draft"),
    dsl_target: "1.1",
    execution_allowed: false,
    computations: seat.planned_dedicated_tools.map((tool) => {
      const family = operationFamily(tool);
      return {
        prototype_id: `${tool.tool_id}.prototype_v1`,
        tool_id: tool.tool_id,
        operation_family: family,
        purpose: tool.purpose,
        input_fact_types: toolInputFacts(seat, tool, partition.critical),
        output_fact_types: tool.output_fact_types,
        computation_steps: operationSteps(family, tool.purpose),
        on_missing_critical: "abstain",
        formula_status: "not_encoded_pending_human_adjudication",
        implementation_status: "planned_unverified",
      };
    }),
  };
}

function buildCasePlan(seat) {
  const targets = Object.fromEntries(seat.case_acquisition_targets.map((target) => [target.case_family, {
    acquisition_target: target.acquisition_target,
    minimum_count: target.minimum_count,
    acquired_count: 0,
    acquisition_status: target.acquisition_status,
    label_status: target.human_adjudication_status,
  }]));
  return {
    ...draftHeader(seat.persona_id, "persona_v3_case_and_experiment_plan_draft"),
    case_acquisition_targets: targets,
    pairwise_plan: {
      execution_status: "not_started",
      comparison_groups: ["single_agent_baseline", "prompt_lens", "other_method_families", "same_method_near_neighbors"],
      measurement_hypotheses: ["decision disagreement", "abstention disagreement", "veto disagreement", "evidence dependency overlap"],
    },
    calibration_plan: {
      execution_status: "not_started",
      label_status: DRAFT_REVIEW_STATUS,
      measures: ["coverage", "abstention_rate", "false_constructive_rate", "directional_accuracy"],
    },
    experiment_plan: {
      execution_status: "not_started",
      required_ablations: ["name", "voice", "policy", "evidence", "memory", "model"],
      result_claims_allowed: false,
    },
  };
}

function buildMemoryPolicy(seat) {
  return {
    ...draftHeader(seat.persona_id, "persona_v3_memory_policy_draft"),
    leak_rule: "public_at <= as_of AND memory_created_at <= as_of",
    write_status: "disabled_until_human_adjudication",
    eligible_memory_hypotheses: [
      "Dated public facts with complete point-in-time provenance.",
      "Human-adjudicated method propositions within the declared method scope.",
      "Resolved case labels whose outcome and cutoff were independently reviewed.",
    ],
    forbidden_memory: [
      "Raw acquisitions treated as approved method evidence.",
      "Facts first public after the run as_of boundary.",
      "Model-generated claims without independent provenance.",
      "Current views or private decisions attributed to the named person.",
    ],
    seat_specific_limits: seat.known_limits,
  };
}

function voiceEn(seat, blueprint) {
  return [
    `# ${blueprint.canonical_title.en} — v3 voice draft`,
    "",
    `Artifact status: \`${DRAFT_STATUS}\``,
    `Human adjudication: \`${DRAFT_REVIEW_STATUS}\``,
    "",
    "> This is an analytical operator voice, not an impersonation or a claim about the named person's current view.",
    "",
    "## Reasoning posture",
    "",
    seat.method_scope.planning_hypothesis,
    "",
    `Lead with the native state (${seat.native_decision_contract.states.map((state) => `\`${state}\``).join(", ")}), then show the facts, computation gaps, vetoes, and invalidation conditions that produced it.`,
    "Do not fill missing facts with rhetoric. Abstain when a critical fact or a load-bearing computation is unavailable.",
    "",
    "## Required answer shape",
    "",
    ...seat.native_decision_contract.required_outputs.map((output) => `- ${output}`),
    "",
  ].join("\n");
}

function voiceZh(seat, blueprint) {
  return [
    `# ${blueprint.canonical_title.zh} — v3 表达草案`,
    "",
    `工件状态：\`${DRAFT_STATUS}\``,
    `人工审定：\`${DRAFT_REVIEW_STATUS}\``,
    "",
    "> 这是分析算子的表达层，不冒充本人，也不声称代表该人物的当前观点。",
    "",
    "## 推理姿态",
    "",
    seat.method_scope.planning_hypothesis,
    "",
    `先给出原生状态（${seat.native_decision_contract.states.map((state) => `\`${state}\``).join("、")}），再列事实、计算缺口、否决项和失效条件。`,
    "关键事实或承重计算缺失时必须拒答；不能用语气和故事补数据。",
    "",
    "## 必须输出",
    "",
    ...seat.native_decision_contract.required_outputs.map((output) => `- ${output}`),
    "",
  ].join("\n");
}

function buildDraftIndex(seat) {
  return {
    ...draftHeader(seat.persona_id, "persona_v3_draft_pack_index"),
    build_spec_inventory_id: inventory.inventory_id,
    build_spec_hash: sha256(seat),
    artifact_files: DRAFT_ARTIFACT_FILES,
    coverage_contract: {
      required_fact_types: seat.required_fact_types,
      planned_tool_ids: seat.planned_dedicated_tools.map((tool) => tool.tool_id),
      veto_ids: seat.veto_families.map((veto) => veto.veto_id),
      native_states: seat.native_decision_contract.states,
    },
    production_guard: {
      production_eligible: false,
      production_registration_allowed: false,
      production_loader_registered: false,
      manifest_allowed: false,
      promotion_effect: "none",
    },
    warnings: [
      "This directory is a physical draft slice, not a physical production PersonaPack v3.",
      "No source attribution, threshold, case label, experiment result, or maturity is established here.",
      "Promotion requires separate human adjudication, corpus construction, signed experiments, and release review.",
    ],
  };
}

function buildArtifactDocuments(seat, blueprint, sourceSnapshot) {
  const partition = factPartition(seat);
  return Object.freeze({
    [DRAFT_ARTIFACT_FILES.method_hypotheses]: prettyJson(buildMethodHypotheses(seat)),
    [DRAFT_ARTIFACT_FILES.research_policy]: prettyJson(buildResearchPolicy(seat, partition, sourceSnapshot)),
    [DRAFT_ARTIFACT_FILES.decision_policy]: prettyJson(buildDecisionPolicy(seat)),
    [DRAFT_ARTIFACT_FILES.tools]: prettyJson(buildTools(seat, partition)),
    [DRAFT_ARTIFACT_FILES.case_plan]: prettyJson(buildCasePlan(seat)),
    [DRAFT_ARTIFACT_FILES.memory_policy]: prettyJson(buildMemoryPolicy(seat)),
    [DRAFT_ARTIFACT_FILES.voice_en]: `${voiceEn(seat, blueprint)}\n`,
    [DRAFT_ARTIFACT_FILES.voice_zh]: `${voiceZh(seat, blueprint)}\n`,
    [DRAFT_ARTIFACT_FILES.draft_pack_index]: prettyJson(buildDraftIndex(seat)),
  });
}

function componentNotes(component, sourceSnapshot) {
  const notes = {
    sources: sourceSnapshot.retrieved_unadjudicated_count
      ? `Raw acquisition inventory contains ${sourceSnapshot.retrieved_unadjudicated_count} retrieved_unadjudicated candidate(s); no grade, adjudication, or method attribution is claimed.`
      : "No raw acquisition candidate is recorded; source acquisition and human adjudication remain pending.",
    doctrine: `Editorial prototype only: ${DRAFT_ARTIFACT_FILES.method_hypotheses}; pending human adjudication.`,
    decision_cases: `Acquisition plan only: ${DRAFT_ARTIFACT_FILES.case_plan}#case_acquisition_targets.decision; acquired_count=0.`,
    failures: `Acquisition plan only: ${DRAFT_ARTIFACT_FILES.case_plan}#case_acquisition_targets.failure; acquired_count=0.`,
    counterfactuals: `Acquisition plan only: ${DRAFT_ARTIFACT_FILES.case_plan}#case_acquisition_targets.counterfactual; acquired_count=0.`,
    research_policy: `Editorial prototype only: ${DRAFT_ARTIFACT_FILES.research_policy}; pending human adjudication.`,
    decision_policy: `Non-executable policy prototype only: ${DRAFT_ARTIFACT_FILES.decision_policy}; thresholds are unset.`,
    tools: `Non-executable computation prototypes only: ${DRAFT_ARTIFACT_FILES.tools}; formulas remain unencoded.`,
    memory_policy: `Editorial prototype only: ${DRAFT_ARTIFACT_FILES.memory_policy}; memory writes remain disabled.`,
    golden_cases: `Acquisition plan only: ${DRAFT_ARTIFACT_FILES.case_plan}#case_acquisition_targets.golden; acquired_count=0.`,
    pairwise_cases: `Evaluation plan only: ${DRAFT_ARTIFACT_FILES.case_plan}#pairwise_plan; execution_status=not_started.`,
    calibration_cases: `Evaluation plan only: ${DRAFT_ARTIFACT_FILES.case_plan}#calibration_plan; labels remain pending.`,
    experiments: `Experiment plan only: ${DRAFT_ARTIFACT_FILES.case_plan}#experiment_plan; no results are claimed.`,
    voice_en: `Late-rendering voice prototype only: ${DRAFT_ARTIFACT_FILES.voice_en}; not an impersonation.`,
    voice_zh: `Late-rendering voice prototype only: ${DRAFT_ARTIFACT_FILES.voice_zh}; not an impersonation.`,
  };
  return notes[component];
}

function buildDraftScaffold(blueprint, sourceSnapshot) {
  const scaffold = createScaffoldDocument(blueprint);
  scaffold.component_plan = scaffold.component_plan.map((item) => ({
    ...item,
    status: item.component === "sources" && sourceSnapshot.retrieved_unadjudicated_count === 0 ? "not_started" : "draft",
    artifact_hash: null,
    reviewer_ids: [],
    reviewed_at: null,
    notes: componentNotes(item.component, sourceSnapshot),
  }));
  return canonicalValue(scaffold);
}

function sourceInventory(options) {
  const report = inspectSourceAcquisitions({ ...options, allowTransientArtifacts: true });
  if (report.invalid_count || report.production_eligible_count || report.approved_count || report.graded_count) {
    fail("raw source-acquisition inventory is not safe for draft generation", { report });
  }
  return report;
}

function generationContext(options = {}) {
  const root = resolve(options.root || defaultStagingRoot());
  const productionRoot = resolve(options.productionRoot || defaultKnowledgeDir());
  const personaDir = resolve(options.personaDir || defaultPersonaDir());
  const staging = inspectPersonaV3Staging({ root, productionRoot, personaDir });
  if (staging.invalid_count || staging.unsafe_artifact_count || staging.global_errors.length) {
    fail("staging integrity must pass before draft generation", { staging });
  }
  const acquisition = sourceInventory({ root, productionRoot, personaDir });
  const blueprints = canonicalMasterBlueprints({ personaDir });
  const byBlueprint = new Map(blueprints.map((blueprint) => [blueprint.persona_id, blueprint]));
  const bySource = new Map(acquisition.personas.map((persona) => [persona.persona_id, persona]));
  const bySpec = new Map(inventory.seats.map((seat) => [seat.persona_id, seat]));
  if (bySpec.size !== CANONICAL_MASTER_COUNT) fail("canonical build-spec inventory is not exactly 26 unique seats");
  return { root, productionRoot, personaDir, staging, acquisition, byBlueprint, bySource, bySpec };
}

function safeTarget(root, personaId, relativePath) {
  if (!CANONICAL_MASTER_IDS.includes(personaId)) fail(`unknown draft seat ${personaId}`);
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    fail(`unsafe draft artifact path ${JSON.stringify(relativePath)}`);
  }
  const seatDir = resolve(root, personaId);
  const target = resolve(seatDir, relativePath);
  if (!inside(seatDir, target)) fail(`draft artifact escapes its seat: ${personaId}/${relativePath}`);
  return target;
}

function writeStableFile(file, content, result) {
  const parent = resolve(file, "..");
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory()) fail(`unsafe draft artifact directory: ${parent}`);
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) fail(`unsafe draft artifact file: ${file}`);
    if (readFileSync(file, "utf8") === content) {
      result.unchanged.push(file);
      return;
    }
  }
  writeFileSync(file, content, { encoding: "utf8", mode: 0o644 });
  result.written.push(file);
}

export function writePersonaV3DraftPacks(options = {}) {
  const context = generationContext(options);
  const result = { written: [], unchanged: [] };
  for (const personaId of CANONICAL_MASTER_IDS) {
    const seat = context.bySpec.get(personaId);
    const blueprint = context.byBlueprint.get(personaId);
    const sourceSnapshot = context.bySource.get(personaId);
    const documents = buildArtifactDocuments(seat, blueprint, sourceSnapshot);
    for (const [relativePath, content] of Object.entries(documents)) {
      writeStableFile(safeTarget(context.root, personaId, relativePath), content, result);
    }
    const scaffoldFile = safeTarget(context.root, personaId, "scaffold.json");
    writeStableFile(scaffoldFile, prettyJson(buildDraftScaffold(blueprint, sourceSnapshot)), result);
  }
  return Object.freeze({
    mode: "write_then_check",
    canonical_master_count: CANONICAL_MASTER_COUNT,
    written: Object.freeze(result.written.map((file) => relative(context.root, file))),
    unchanged: Object.freeze(result.unchanged.map((file) => relative(context.root, file))),
  });
}

function parseJson(file, errors, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${label}: invalid JSON (${error.message})`);
    return null;
  }
}

function collectForbiddenKeys(value, path = "$", found = []) {
  if (Array.isArray(value)) value.forEach((item, index) => collectForbiddenKeys(item, `${path}[${index}]`, found));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_DRAFT_KEYS.has(key)) found.push(`${path}.${key}`);
      collectForbiddenKeys(item, `${path}.${key}`, found);
    }
  }
  return found;
}

function setEqual(actual, expected) {
  return actual.length === expected.length && new Set(actual).size === actual.length
    && expected.every((item) => actual.includes(item));
}

function validateCoverage(personaId, seat, documents, errors) {
  const research = documents[DRAFT_ARTIFACT_FILES.research_policy];
  const decision = documents[DRAFT_ARTIFACT_FILES.decision_policy];
  const tools = documents[DRAFT_ARTIFACT_FILES.tools];
  const method = documents[DRAFT_ARTIFACT_FILES.method_hypotheses];
  const index = documents[DRAFT_ARTIFACT_FILES.draft_pack_index];
  const facts = [...(research?.fact_contract?.critical || []), ...(research?.fact_contract?.optional || [])]
    .map((entry) => entry.fact_type);
  if (!setEqual(facts, seat.required_fact_types)) errors.push(`${personaId}: critical/optional fact contracts do not exactly cover the build spec`);
  if (!(research?.fact_contract?.critical?.length >= 2) || !(research?.fact_contract?.optional?.length >= 1)) {
    errors.push(`${personaId}: fact contract must include both critical and optional facts`);
  }
  const toolIds = (tools?.computations || []).map((tool) => tool.tool_id);
  const expectedTools = seat.planned_dedicated_tools.map((tool) => tool.tool_id);
  if (!setEqual(toolIds, expectedTools) || toolIds.length < 2) errors.push(`${personaId}: computation prototypes do not cover all planned dedicated tools`);
  const vetoIds = (decision?.hard_veto_hypotheses || []).map((veto) => veto.veto_id);
  const methodVetoIds = (method?.veto_hypotheses || []).map((veto) => veto.veto_id);
  const expectedVetoes = seat.veto_families.map((veto) => veto.veto_id);
  if (!setEqual(vetoIds, expectedVetoes) || !setEqual(methodVetoIds, expectedVetoes) || vetoIds.length < 3) {
    errors.push(`${personaId}: veto hypotheses do not cover all build-spec veto families`);
  }
  const nativeStates = decision?.native_states || [];
  const projectedStates = (decision?.common_projection_hypotheses || []).map((entry) => entry.native_state);
  if (!setEqual(nativeStates, seat.native_decision_contract.states) || !setEqual(projectedStates, seat.native_decision_contract.states)) {
    errors.push(`${personaId}: native states and common projection do not exactly cover the build spec`);
  }
  if (index?.build_spec_hash !== sha256(seat)) errors.push(`${personaId}: draft index build-spec hash drifted`);
  if (index?.production_guard?.production_eligible !== false
    || index?.production_guard?.production_loader_registered !== false
    || index?.production_guard?.manifest_allowed !== false) {
    errors.push(`${personaId}: draft index weakens the production guard`);
  }
}

function validateScaffoldDraft(personaId, scaffold, sourceSnapshot, errors) {
  for (const component of scaffold?.component_plan || []) {
    const expectedStatus = component.component === "sources" && sourceSnapshot.retrieved_unadjudicated_count === 0
      ? "not_started" : "draft";
    if (component.status !== expectedStatus) errors.push(`${personaId}: ${component.component} must be ${expectedStatus}`);
    if (component.artifact_hash !== null || component.reviewed_at !== null) errors.push(`${personaId}: ${component.component} must not claim a reviewed artifact`);
    if (!Array.isArray(component.reviewer_ids) || component.reviewer_ids.length) errors.push(`${personaId}: ${component.component} must not claim reviewers`);
    if (typeof component.notes !== "string" || !component.notes) errors.push(`${personaId}: ${component.component} must point to its honest draft state`);
  }
  if (scaffold?.production_guard?.production_eligible !== false
    || scaffold?.production_guard?.production_manifest_allowed !== false
    || scaffold?.production_guard?.registry_registration_allowed !== false) {
    errors.push(`${personaId}: scaffold production guard is invalid`);
  }
}

function artifactDirectorySafety(root, personaId, errors) {
  const artifactsDir = safeTarget(root, personaId, "artifacts");
  if (!existsSync(artifactsDir)) return;
  if (lstatSync(artifactsDir).isSymbolicLink() || !statSync(artifactsDir).isDirectory()) {
    errors.push(`${personaId}/artifacts: must be a real directory`);
    return;
  }
  const expected = new Set(Object.values(DRAFT_ARTIFACT_FILES).map((path) => path.slice("artifacts/".length)));
  for (const entry of readdirSync(artifactsDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) errors.push(`${personaId}/artifacts/${entry.name}: symlink is forbidden`);
    if (!entry.isFile()) errors.push(`${personaId}/artifacts/${entry.name}: nested directories and special files are forbidden`);
    if (!expected.has(entry.name)) errors.push(`${personaId}/artifacts/${entry.name}: unexpected artifact`);
  }
}

export function inspectPersonaV3DraftPacks(options = {}) {
  const context = generationContext(options);
  const personas = [];
  let presentArtifactCount = 0;
  for (const personaId of CANONICAL_MASTER_IDS) {
    const errors = [];
    const contentForHash = {};
    const seat = context.bySpec.get(personaId);
    const blueprint = context.byBlueprint.get(personaId);
    const sourceSnapshot = context.bySource.get(personaId);
    const expectedDocuments = buildArtifactDocuments(seat, blueprint, sourceSnapshot);
    const actualDocuments = {};
    artifactDirectorySafety(context.root, personaId, errors);
    for (const [relativePath, expected] of Object.entries(expectedDocuments)) {
      const file = safeTarget(context.root, personaId, relativePath);
      if (!existsSync(file)) {
        errors.push(`${personaId}/${relativePath}: missing`);
        continue;
      }
      if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) {
        errors.push(`${personaId}/${relativePath}: must be a real file`);
        continue;
      }
      presentArtifactCount += 1;
      const actual = readFileSync(file, "utf8");
      contentForHash[relativePath] = actual;
      if (actual !== expected) errors.push(`${personaId}/${relativePath}: content drifted from the canonical editorial prototype`);
      if (relativePath.endsWith(".json")) {
        const parsed = parseJson(file, errors, `${personaId}/${relativePath}`);
        actualDocuments[relativePath] = parsed;
        for (const keyPath of collectForbiddenKeys(parsed)) errors.push(`${personaId}/${relativePath}: forbidden unearned claim key ${keyPath}`);
      }
    }
    validateCoverage(personaId, seat, actualDocuments, errors);
    const scaffoldFile = safeTarget(context.root, personaId, "scaffold.json");
    const scaffold = parseJson(scaffoldFile, errors, `${personaId}/scaffold.json`);
    contentForHash["scaffold.json"] = scaffold;
    const expectedScaffold = buildDraftScaffold(blueprint, sourceSnapshot);
    if (scaffold && canonicalJson(scaffold) !== canonicalJson(expectedScaffold)) errors.push(`${personaId}/scaffold.json: draft component plan drifted`);
    validateScaffoldDraft(personaId, scaffold, sourceSnapshot, errors);
    personas.push(canonicalValue({
      persona_id: personaId,
      draft_status: errors.length ? "invalid" : DRAFT_STATUS,
      artifact_count: Object.values(DRAFT_ARTIFACT_FILES).filter((relativePath) => existsSync(safeTarget(context.root, personaId, relativePath))).length,
      computation_prototypes: seat.planned_dedicated_tools.length,
      veto_hypotheses: seat.veto_families.length,
      fact_contracts: seat.required_fact_types.length,
      native_states: seat.native_decision_contract.states.length,
      retrieved_unadjudicated_sources: sourceSnapshot.retrieved_unadjudicated_count,
      draft_content_hash: sha256(contentForHash),
      production_eligible: false,
      errors,
    }));
  }
  const staging = inspectPersonaV3Staging({ root: context.root, productionRoot: context.productionRoot, personaDir: context.personaDir });
  const loaderView = loadV3Packs({ dir: context.root });
  const invalidCount = personas.filter((persona) => persona.errors.length).length;
  const totals = personas.reduce((sum, persona) => {
    sum.computation_prototypes += persona.computation_prototypes;
    sum.veto_hypotheses += persona.veto_hypotheses;
    sum.fact_contracts += persona.fact_contracts;
    sum.native_states += persona.native_states;
    sum.retrieved_unadjudicated_sources += persona.retrieved_unadjudicated_sources;
    return sum;
  }, { computation_prototypes: 0, veto_hypotheses: 0, fact_contracts: 0, native_states: 0, retrieved_unadjudicated_sources: 0 });
  const stable = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_draft_pack_inventory",
    inventory_status: "non_production_editorial_prototypes",
    canonical_master_count: CANONICAL_MASTER_COUNT,
    draft_pack_count: personas.filter((persona) => persona.artifact_count === ARTIFACT_COUNT_PER_SEAT).length,
    expected_artifact_count: CANONICAL_MASTER_COUNT * ARTIFACT_COUNT_PER_SEAT,
    present_artifact_count: presentArtifactCount,
    invalid_count: invalidCount,
    production_eligible_count: 0,
    production_loader_visible_count: loaderView.packs.length,
    staging_physical_v3_count: staging.physical_v3_pack_count,
    staging_unsafe_artifact_count: staging.unsafe_artifact_count,
    totals,
    personas,
  });
  return Object.freeze({
    staging_root: context.root,
    production_root: context.productionRoot,
    ...stable,
    draft_inventory_hash: sha256(stable),
  });
}

export function renderPersonaV3DraftReport(report) {
  const lines = [
    "# PersonaPack v3 non-production draft inventory",
    "",
    `Draft slices: ${report.draft_pack_count}/${report.canonical_master_count}`,
    `Physical draft artifacts: ${report.present_artifact_count}/${report.expected_artifact_count}`,
    `Production loader visibility: ${report.production_loader_visible_count}`,
    `Production-eligible drafts: ${report.production_eligible_count}`,
    `Inventory hash: \`${report.draft_inventory_hash}\``,
    "",
    "> These are editorial prototypes pending human adjudication. They are not production PersonaPack v3 packs, candidates, operator lenses, or method models.",
    "",
    "| Persona | Artifacts | Computations | Vetoes | Facts | Native states | Raw acquisitions | Errors |",
    "|---|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const persona of report.personas) {
    lines.push(`| \`${persona.persona_id}\` | ${persona.artifact_count} | ${persona.computation_prototypes} | ${persona.veto_hypotheses} | ${persona.fact_contracts} | ${persona.native_states} | ${persona.retrieved_unadjudicated_sources} | ${persona.errors.join("; ") || "none"} |`);
  }
  lines.push("");
  return lines.join("\n");
}
