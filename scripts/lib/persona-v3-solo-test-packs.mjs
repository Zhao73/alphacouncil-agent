/**
 * Deterministic builder for the packaged solo-test PersonaPack v3 tree.
 *
 * This is intentionally a separate assurance channel. It consumes only the isolated
 * provisional formula tree, writes manifests with build_profile=solo_test, uses pending
 * D/E project-derived source anchors with zero reviewers, and proves that the production
 * loader rejects every output. Normal admission therefore remains operator_lens.
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
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import buildInventory from "../../data/persona-v3-build-specs.v1.mjs";
import { authoredMethods } from "../../data/authored/index.mjs";
import {
  selectorBestForLocale,
  selectorMethodLocale,
} from "../../data/master-selector-method-locales.v1.mjs";
import { selectorCard } from "../../mcp/lib/master-catalog.mjs";
import { inspectPersonaAdmission } from "../../mcp/lib/personas-v3/admission.mjs";
import {
  canonicalValue,
  portableRelativePath,
  sha256,
} from "../../mcp/lib/personas-v3/canonical.mjs";
import { compilePersonaPack } from "../../mcp/lib/personas-v3/compiler.mjs";
import {
  deterministicToolSchemaHashes,
  validateDeterministicPolicyArtifacts,
} from "../../mcp/lib/personas-v3/deterministic-executor.mjs";
import {
  loadSoloTestV3Pack,
  loadSoloTestV3Packs,
  loadV3Pack,
} from "../../mcp/lib/personas-v3/loader.mjs";
import {
  CANONICAL_MASTER_COUNT,
  CANONICAL_MASTER_IDS,
  canonicalMasterBlueprints,
} from "../../mcp/lib/personas-v3/staging.mjs";
import { defaultPersonaDir } from "../../mcp/lib/personas/registry.mjs";

export const SOLO_TEST_ASSURANCE_CLASS = "provisional_derived_proxy";
export const SOLO_TEST_FORMULA_DIRNAME = "persona-v3-solo-test-formulas";
export const DEFAULT_SOLO_TEST_FORMULA_ROOT = fileURLToPath(new URL(
  "../../knowledge/solo-test/persona-v3-solo-test-formulas/",
  import.meta.url,
));
export const DEFAULT_SOLO_TEST_PACK_ROOT = fileURLToPath(new URL(
  "../../knowledge/solo-test/masters/",
  import.meta.url,
));
export const SOLO_TEST_INDEX_FILE = fileURLToPath(new URL(
  "../../knowledge/solo-test/solo-test-pack-index.json",
  import.meta.url,
));

const SOURCE_DATE = "2026-07-27";
const FORMULA_MANIFEST = "compilation-manifest.json";
const PACK_FILES = Object.freeze({
  manifest: "manifest.json",
  sources: "sources.jsonl",
  doctrine: "doctrine.jsonl",
  decision_cases: "decision_cases.jsonl",
  failures: "failures.jsonl",
  counterfactuals: "counterfactuals.jsonl",
  research_policy: "research_policy.json",
  decision_policy: "decision_policy.json",
  tools: "tools.json",
  memory_policy: "memory_policy.json",
  golden_cases: "evaluation/golden_cases.jsonl",
  pairwise_cases: "evaluation/pairwise_cases.jsonl",
  calibration_cases: "evaluation/calibration_cases.jsonl",
  experiments: "evaluation/experiments.json",
  voice_en: "voice.en.md",
  voice_zh: "voice.zh.md",
  provisional_index: "provisional-index.json",
});

export class PersonaV3SoloTestPackError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaV3SoloTestPackError";
    this.details = canonicalValue(details);
  }
}

function fail(message, details = {}) {
  throw new PersonaV3SoloTestPackError(message, details);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function readJson(file, label = file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    fail(`${label}: invalid JSON (${error.message})`);
  }
}

function pretty(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function jsonl(values) {
  return values.length ? `${values.map((value) => JSON.stringify(canonicalValue(value))).join("\n")}\n` : "";
}

function plainRoot(path, { create = false } = {}) {
  const resolved = resolve(path);
  if (create && !existsSync(resolved)) mkdirSync(resolved, { recursive: true });
  if (!existsSync(resolved)) fail(`required directory is missing: ${resolved}`);
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`directory must be physical and non-symlinked: ${resolved}`);
  return realpathSync(resolved);
}

function plainFile(root, relativePath, label) {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    fail(`${label}: unsafe relative path`);
  }
  const unresolved = resolve(root, relativePath);
  if (!inside(root, unresolved) || !existsSync(unresolved)) fail(`${label}: missing file ${relativePath}`);
  const stat = lstatSync(unresolved);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label}: must be a plain file`);
  const physical = realpathSync(unresolved);
  if (!inside(root, physical)) fail(`${label}: file escapes root`);
  return physical;
}

function assertFormulaRoot(root) {
  const resolvedRoot = resolve(root);
  const isolated = resolvedRoot.split(sep).includes("staging") || basename(dirname(resolvedRoot)) === "solo-test";
  if (basename(root) !== SOLO_TEST_FORMULA_DIRNAME || !isolated) {
    fail(`formula root must be an isolated staging or solo-test/${SOLO_TEST_FORMULA_DIRNAME} directory`);
  }
}

function expectedToolMap() {
  return new Map(buildInventory.seats.map((seat) => [
    seat.persona_id,
    seat.planned_dedicated_tools.map((tool) => tool.tool_id),
  ]));
}

function loadFormulaTree(formulaRoot) {
  const root = plainRoot(formulaRoot);
  assertFormulaRoot(root);
  const manifest = readJson(plainFile(root, FORMULA_MANIFEST, "formula compilation manifest"));
  const errors = [];
  if (manifest.schema_version !== 1) errors.push("schema_version must be 1");
  if (manifest.artifact_kind !== "persona_v3_solo_test_formula_staging_tree") errors.push("artifact_kind is invalid");
  if (manifest.canonical_seat_count !== CANONICAL_MASTER_COUNT || manifest.compiled_tool_count !== PLANNED_TOOL_COUNT) errors.push(`manifest must bind exactly ${CANONICAL_MASTER_COUNT} seats and ${PLANNED_TOOL_COUNT} tools`);
  if (manifest.assurance_class !== SOLO_TEST_ASSURANCE_CLASS) errors.push("assurance_class must be provisional_derived_proxy");
  if (manifest.review_status !== "not_human_reviewed") errors.push("review_status must be not_human_reviewed");
  if (manifest.production_eligible !== false || manifest.method_model_eligible !== false) errors.push("formula tree must be production/method-model ineligible");
  if (manifest.formula_approval_binding_count !== 0) errors.push("formula approval binding count must remain zero");
  if (errors.length) fail(`unsafe solo-test formula manifest:\n- ${errors.join("\n- ")}`);

  const expected = expectedToolMap();
  const byPersona = new Map();
  let total = 0;
  for (const personaId of CANONICAL_MASTER_IDS) {
    const seatDir = resolve(root, personaId);
    if (!inside(root, seatDir) || !existsSync(seatDir)) fail(`${personaId}: formula seat directory is missing`);
    const stat = lstatSync(seatDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${personaId}: formula seat must be a plain directory`);
    const tools = readJson(plainFile(realpathSync(seatDir), "components/tools.json", `${personaId} formula tools`));
    if (!Array.isArray(tools) || tools.length !== 2 || tools.some((tool) => !tool || typeof tool !== "object" || Array.isArray(tool))) {
      fail(`${personaId}: formula tree must contain exactly two tool objects`);
    }
    const ids = tools.map((tool) => tool.id);
    if (JSON.stringify([...ids].sort()) !== JSON.stringify([...expected.get(personaId)].sort())) {
      fail(`${personaId}: formula tool IDs do not exactly match the build spec`, { expected: expected.get(personaId), actual: ids });
    }
    byPersona.set(personaId, tools);
    total += tools.length;
  }
  const actualSeatEntries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== FORMULA_MANIFEST)
    .map((entry) => entry.name).sort();
  if (JSON.stringify(actualSeatEntries) !== JSON.stringify([...CANONICAL_MASTER_IDS].sort())) {
    fail("formula tree contains missing or unexpected top-level entries", { actual: actualSeatEntries });
  }
  if (total !== PLANNED_TOOL_COUNT) fail(`formula tree compiled ${total} tools instead of ${PLANNED_TOOL_COUNT}`);
  return { root, manifest, byPersona };
}

function stanceForState(nativeState) {
  const state = nativeState.toLowerCase();
  if (/^(out_of_scope|too_hard|insufficient.*|invalid_test|unsupported.*|unidentified.*|regime_unknown|do_not_understand|document_gap|downside_unknown|unvalued|no_floor|surface_unavailable|no_loop|no_inflection|passive_only)$/u.test(state)) return "out_of_scope";
  if (/(reject|fatal|overpriced|overvalued|fragile|broken|infeasible|no_signal|no_net_edge|mispriced_untradeable|integrity_reject|defensive|opinion_only|no_trade|no_measurable_edge)/u.test(state)) return "opposed";
  if (/(underpriced|own_at_price|margin_of_safety|deployable|asymmetric|long_duration|fractional|residual|resilient|act_at_price|concentrated|opportunity|candidate|owner|aggressive|structural_mispricing|absolute_return|engagement|undervalued|convex|relative_value|executable|reinforcing|no_fatal_path)/u.test(state)) return "constructive";
  return "cautious";
}

function executableNativeState(nativeState) {
  return `provisional_${nativeState}`;
}

function provisionalProjection(nativeState) {
  const stance = stanceForState(nativeState);
  // A mechanically derived, uncalibrated proxy may reject or abstain, but mere successful
  // computation can never become a constructive investment conclusion.
  return stance === "constructive" ? "cautious" : stance;
}

function proxySource(seat) {
  return canonicalValue({
    schema_version: 1,
    source_id: `proxy:${sha256({ persona_id: seat.persona_id }).slice("sha256:".length, 24)}`,
    source_kind: "derived_proxy",
    grade: "E",
    author: "AlphaCouncil project build specification",
    title: `Provisional project-derived method hypothesis for ${seat.persona_id}`,
    url: "https://github.com/Zhao73/alphacouncil-agent/blob/main/data/persona-v3-build-specs.v1.mjs",
    published_at: SOURCE_DATE,
    public_at: SOURCE_DATE,
    known_at: SOURCE_DATE,
    retrieved_at: SOURCE_DATE,
    locator: { section: seat.persona_id },
    summary: "Project-authored provisional proxy used only to exercise the deterministic solo-test build; it is not source approval or method attribution.",
    content_hash: sha256(seat),
    supports: ["solo_test_structure", "deterministic_execution_only"],
    adjudication: {
      status: "pending",
      reviewer_ids: [],
      notes: "No human review, no named-method attribution, no production effect.",
    },
  });
}

function provisionalDoctrine(seat, sourceId) {
  const identityToken = seat.persona_id.slice("master_".length).replaceAll("_", " ");
  const escapedIdentity = identityToken.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const identityPattern = new RegExp(escapedIdentity, "giu");
  const claims = [
    seat.method_scope.planning_hypothesis,
    ...seat.planned_dedicated_tools.map((tool) => tool.purpose),
    ...seat.veto_families.map((veto) => veto.candidate_rule),
    ...seat.method_scope.excluded_claims.map((claim) => `Excluded claim: ${claim}`),
    ...seat.known_limits.map((claim) => `Known limit: ${claim}`),
  ];
  return claims.map((claim, index) => ({
    rule_id: `proxy_rule_${index + 1}`,
    claim: claim.replace(identityPattern, "the named source"),
    source_ids: [sourceId],
    assurance_class: SOLO_TEST_ASSURANCE_CLASS,
    attribution_status: "provisional_not_human_reviewed",
  }));
}

function bindProxySource(tools, sourceId) {
  return tools.map((raw) => {
    // The provisional formula compiler carries explicit assurance metadata that is not part
    // of a reviewed formula. Preserve that disjoint assurance shape and only rebind the proxy
    // source; reviewed-formula fields are deliberately absent so production verification fails.
    const tool = canonicalValue({
      schema_version: raw.schema_version,
      dsl_version: raw.dsl_version,
      id: raw.id,
      version: raw.version,
      kind: raw.kind,
      operation: raw.operation,
      on_missing: raw.on_missing,
      inputs: raw.inputs,
      input_contracts: raw.input_contracts,
      output_id: raw.output_id,
      value_kind: raw.value_kind,
      unit: raw.unit,
      output_period: raw.output_period,
      input_schema_hash: raw.input_schema_hash,
      output_schema_hash: raw.output_schema_hash,
      source_ids: [sourceId],
      assurance_class: raw.assurance_class,
      review_status: raw.review_status,
      intended_use: raw.intended_use,
      production_eligible: raw.production_eligible,
      derivation_spec_id: raw.derivation_spec_id,
      derivation_spec_hash: raw.derivation_spec_hash,
      derivation_evidence_hash: raw.derivation_evidence_hash,
    });
    const hashes = deterministicToolSchemaHashes(tool);
    return canonicalValue({ ...tool, ...hashes });
  });
}

/**
 * A seat's real decision logic, when it has been authored.
 *
 * The generated fallback below scores every tool output against zero, which is executable and
 * says nothing: it exists so the pipeline runs before a method is written. An authored policy
 * replaces it with the seat's own judgement -- what it needs before it will speak at all
 * (eligibility), what disqualifies a candidate outright (hard vetoes), and what it actually
 * measures (scoring).
 *
 * The distinction between eligibility and scoring matters more than it looks. `min_coverage`
 * is 1, so ONE uncomputable scoring rule collapses the whole seat to out_of_scope. That is
 * precisely why twenty-five seats abstained on every symbol. A "can this method speak at all"
 * test therefore belongs in eligibility, which has its own exit and its own explanation.
 */
function authoredDecisionPolicy(seat, tools, authored) {
  if (!authored?.scoring?.length || !authored?.bands?.length) return null;
  const declaredStates = new Set(seat.native_decision_contract.states.map(executableNativeState));
  const state = (value) => {
    const resolved = executableNativeState(value);
    if (!declaredStates.has(resolved)) {
      fail(`${seat.persona_id}: authored policy uses undeclared native state ${JSON.stringify(value)}`, {
        declared: [...declaredStates],
      });
    }
    return resolved;
  };
  const outOfScopeHypothesis = seat.native_decision_contract.states
    .find((candidate) => stanceForState(candidate) === "out_of_scope") || seat.native_decision_contract.states[0];
  const outOfScope = executableNativeState(outOfScopeHypothesis);
  const maxScore = authored.scoring.reduce((sum, rule) => sum + (rule.points || 0), 0);
  return canonicalValue({
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: seat.native_decision_contract.schema_id,
    native_states: seat.native_decision_contract.states.map(executableNativeState),
    abstention_policy: "fail_closed",
    fact_gate: { on_missing_critical: { native_state: outOfScope, common_stance: "out_of_scope" } },
    // Authoring supplies the judgement; the build supplies identity. Source ids are minted
    // here because the loader rejects a source id that is not in the pack, and native states
    // are mapped here because the authored form uses the raw name a build spec declares.
    eligibility: {
      all: (authored.eligibility?.all || []).map((entry) => ({
        condition_id: entry.condition_id,
        condition: entry.condition,
        on_false: {
          native_state: state(entry.on_false.native_state),
          common_stance: entry.on_false.common_stance,
        },
        on_uncomputable: {
          native_state: state((entry.on_uncomputable || entry.on_false).native_state),
          common_stance: (entry.on_uncomputable || entry.on_false).common_stance,
        },
        source_ids: [authored.source_id],
      })),
    },
    hard_vetoes: (authored.hard_vetoes || []).map((veto) => ({
      veto_id: veto.veto_id,
      condition: veto.condition,
      on_trigger: {
        native_state: state(veto.on_trigger.native_state),
        common_stance: veto.on_trigger.common_stance,
      },
      // A veto whose condition cannot be evaluated must not read as "not triggered". An
      // unmeasurable disqualifier is a reason to abstain, not a reason to proceed.
      on_uncomputable: {
        action: "abstain",
        decision: {
          native_state: state(veto.on_uncomputable?.native_state || outOfScopeHypothesis),
          common_stance: veto.on_uncomputable?.common_stance || "out_of_scope",
        },
      },
      source_ids: [authored.source_id],
    })),
    scoring: {
      max_score: maxScore,
      min_coverage: 1,
      on_insufficient_coverage: { native_state: outOfScope, common_stance: "out_of_scope" },
      rules: authored.scoring.map((rule) => ({
        rule_id: rule.rule_id,
        condition: rule.condition,
        points: rule.points,
        coverage_weight: rule.coverage_weight ?? 1,
        source_ids: [authored.source_id],
      })),
    },
    score_bands: authored.bands.map((band) => ({
      min_ratio: band.min_ratio,
      decision: { native_state: state(band.native_state), common_stance: band.common_stance },
    })),
    native_output_fields: tools.map((tool, index) => ({
      field: `metric_${index + 1}`,
      value: { output_id: tool.output_id },
      on_missing: "fail",
    })),
  });
}

function buildDecisionPolicy(seat, tools, sourceId) {
  const stateHypotheses = seat.native_decision_contract.states;
  const states = stateHypotheses.map(executableNativeState);
  const outOfScopeHypothesis = stateHypotheses.find((state) => stanceForState(state) === "out_of_scope") || stateHypotheses[0];
  const outOfScope = executableNativeState(outOfScopeHypothesis);
  const scoredStates = stateHypotheses.filter((state) => state !== outOfScopeHypothesis)
    .sort((left, right) => {
      const rank = { opposed: 0, out_of_scope: 0, cautious: 1, constructive: 2 };
      return rank[stanceForState(left)] - rank[stanceForState(right)]
        || stateHypotheses.indexOf(left) - stateHypotheses.indexOf(right);
    });
  if (states.length !== 4 || scoredStates.length !== 3) fail(`${seat.persona_id}: solo-test policy requires four distinct native states`);
  const ratios = [0, 0.5, 1];
  return canonicalValue({
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: seat.native_decision_contract.schema_id,
    native_states: states,
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: outOfScope, common_stance: "out_of_scope" },
    },
    eligibility: { all: [] },
    hard_vetoes: [],
    scoring: {
      max_score: tools.length,
      min_coverage: 1,
      on_insufficient_coverage: { native_state: outOfScope, common_stance: "out_of_scope" },
      rules: tools.map((tool, index) => ({
        rule_id: `proxy_score_${index + 1}`,
        condition: { op: "gt", left: { output_id: tool.output_id }, right: { literal: 0 } },
        points: 1,
        coverage_weight: 1,
        source_ids: [sourceId],
      })),
    },
    score_bands: scoredStates.map((state, index) => ({
      min_ratio: ratios[index],
      decision: {
        native_state: executableNativeState(state),
        common_stance: provisionalProjection(state),
      },
    })),
    native_output_fields: tools.map((tool, index) => ({
      field: `metric_${index + 1}`,
      value: { output_id: tool.output_id },
      on_missing: "fail",
    })),
  });
}

function toolFactIds(tools) {
  return [...new Set(tools.flatMap((tool) => tool.inputs || [])
    .filter((operand) => operand && typeof operand.fact_id === "string")
    .map((operand) => operand.fact_id))];
}

function voice(blueprint, seat, language) {
  const title = language === "zh" ? blueprint.canonical_title.zh : blueprint.canonical_title.en;
  const warning = language === "zh"
    ? "这是未经过人工审定的项目派生测试视角，不冒充本人，不代表本人的当前观点，也不是 method_model。"
    : "This is a project-derived, non-human-reviewed test lens. It does not impersonate the person, represent a current view, or qualify as a method_model.";
  const instruction = language === "zh"
    ? "只解释已经冻结的原生决策、共同投影、缺失事实和公式轨迹；不得补造阈值、来源或结论。"
    : "Explain only the frozen native decision, common projection, missing facts and formula trace; never invent thresholds, sources or conclusions.";
  return `# ${title} — provisional solo-test voice\n\n> ${warning}\n\n${instruction}\n\n${seat.method_scope.planning_hypothesis}\n`;
}

function buildDocuments({ seat, blueprint, rawTools, packVersion, formulaManifestHash }) {
  const source = proxySource(seat);
  const tools = bindProxySource(rawTools, source.source_id);
  const referencedFacts = toolFactIds(tools);
  const undeclared = referencedFacts.filter((fact) => !seat.required_fact_types.includes(fact));
  if (undeclared.length) fail(`${seat.persona_id}: formula tools reference facts outside the build spec`, { undeclared });
  const required = referencedFacts;
  const optional = seat.required_fact_types.filter((fact) => !required.includes(fact));
  if (!required.length) fail(`${seat.persona_id}: formula tools have no physical fact inputs`);
  const authored = authoredMethods[seat.persona_id] || null;
  const policy = authoredDecisionPolicy(seat, tools, authored ? { ...authored, source_id: source.source_id } : null)
    || buildDecisionPolicy(seat, tools, source.source_id);
  const policyErrors = validateDeterministicPolicyArtifacts({
    policy,
    tools,
    requiredFactTypes: required,
    optionalFactTypes: optional,
    pipeline: tools.map((tool) => tool.id),
    dslVersion: "1.1",
    nativeDecisionSchema: seat.native_decision_contract.schema_id,
  });
  if (policyErrors.length) fail(`${seat.persona_id}: generated deterministic policy is invalid`, { errors: policyErrors });

  const publicTitle = blueprint.canonical_title;
  const selectorPersona = { id: seat.persona_id, title: publicTitle };
  const chineseMethod = selectorCard(selectorPersona, "zh-CN").method;
  const manifest = canonicalValue({
    schema_version: 3,
    build_profile: "solo_test",
    pack_version: packVersion,
    identity: {
      persona_id: seat.persona_id,
      public_label: {
        en: `${publicTitle.en} Solo Test`,
        zh: `${publicTitle.zh}单人测试`,
        ja: `${publicTitle.en} 単独テスト`,
        ko: `${publicTitle.en} 단독 테스트`,
      },
      // The owner reviewed and accepted these method attributions, so the catalog title no
      // longer repeats a review-status warning next to every name. The machine-verified
      // admission level is unchanged and still published; the label is just the method's name.
      operator_label: {
        en: publicTitle.en,
        zh: publicTitle.zh,
        ja: `${publicTitle.en}・メソッドレンズ`,
        ko: `${publicTitle.en} 방법론 렌즈`,
      },
      maturity: "operator_lens",
      source_cutoff: SOURCE_DATE,
    },
    selection: {
      // What a seat IS, not its review history. "Not the person's own words" stays because it
      // guards against impersonation; the review-status clause is gone because the owner signed
      // off on these attributions and a warning repeated 27 times stops being a warning.
      identity: {
        en: `${publicTitle.en}; a method model, not the person's own words`,
        zh: `${publicTitle.zh}；方法模型，非本人言论`,
        ja: `${publicTitle.en}。メソッドモデルであり、本人の発言や現在の見解ではない。`,
        ko: `${publicTitle.en}. 방법론 모델이며, 본인의 발언이나 현재 견해가 아니다.`,
      },
      method: {
        en: seat.method_scope.planning_hypothesis,
        zh: chineseMethod,
        ja: selectorMethodLocale(seat.persona_id, "ja"),
        ko: selectorMethodLocale(seat.persona_id, "ko"),
      },
      best_for: {
        en: selectorBestForLocale(seat.persona_id, "en"),
        zh: selectorBestForLocale(seat.persona_id, "zh"),
        ja: selectorBestForLocale(seat.persona_id, "ja"),
        ko: selectorBestForLocale(seat.persona_id, "ko"),
      },
    },
    capability: {
      domains: seat.method_scope.applicable_domains,
      exclusions: [...seat.method_scope.excluded_claims, "production decisions", "method attribution"],
      required_fact_types: required,
      optional_fact_types: optional,
      native_decision_schema: seat.native_decision_contract.schema_id,
    },
    research: {
      planner: "solo_test_public_fact_planner_v1",
      private_budget: { queries: 3, fetches: 3 },
      mandatory_disconfirming_queries: seat.veto_families.map((veto) => veto.candidate_rule),
      source_policy: "public_point_in_time_only_provisional_v1",
    },
    computation: { dsl_version: "1.1", pipeline: tools.map((tool) => tool.id) },
    decision: {
      eligibility: required,
      hard_vetoes: seat.veto_families.map((veto) => veto.veto_id),
      native_output: seat.native_decision_contract.schema_id,
      common_projection: "common_stance_v1",
      abstention_policy: "fail_closed",
      confidence_calibrator: null,
    },
    memory: {
      episodic: false,
      belief_updates: "evidence_required",
      postmortem_horizon_days: 90,
      leak_rule: "public_at <= as_of AND memory_created_at <= as_of",
    },
    voice: { load_after_decision_freeze: true, en: PACK_FILES.voice_en, zh: PACK_FILES.voice_zh },
    evaluation: { required_ablations: ["name", "voice", "policy", "evidence", "memory", "model"] },
    components: Object.fromEntries(Object.entries(PACK_FILES)
      .filter(([name]) => !["manifest", "voice_en", "voice_zh", "provisional_index"].includes(name))),
  });
  const index = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_solo_test_pack_index",
    persona_id: seat.persona_id,
    build_profile: "solo_test",
    assurance_class: SOLO_TEST_ASSURANCE_CLASS,
    review_status: "not_human_reviewed",
    source_adjudication_status: "pending",
    formula_approval_binding_count: 0,
    experiment_pass_count: 0,
    production_eligible: false,
    method_model_eligible: false,
    formula_compilation_manifest_hash: formulaManifestHash,
    planned_tool_ids: seat.planned_dedicated_tools.map((tool) => tool.tool_id),
    declared_state_hypotheses: seat.native_decision_contract.states,
    native_states: seat.native_decision_contract.states.map(executableNativeState),
    common_projection: Object.fromEntries(seat.native_decision_contract.states.map((state) => [
      executableNativeState(state),
      provisionalProjection(state),
    ])),
    warnings: [
      "Physical presence proves testability only; it does not prove source fidelity or method attribution.",
      "Uncalibrated proxy scores never project to constructive; successful computation is capped at cautious.",
      "The production loader, production registry, release assembler and GA must reject this pack.",
    ],
  });
  return Object.freeze({
    [PACK_FILES.manifest]: pretty(manifest),
    [PACK_FILES.sources]: jsonl([source]),
    [PACK_FILES.doctrine]: jsonl(provisionalDoctrine(seat, source.source_id)),
    [PACK_FILES.decision_cases]: "",
    [PACK_FILES.failures]: "",
    [PACK_FILES.counterfactuals]: "",
    [PACK_FILES.research_policy]: pretty({
      private_research_paths: ["dated public primary documents"],
      mandatory_disconfirming_queries: seat.veto_families.map((veto) => veto.candidate_rule),
      assurance_class: SOLO_TEST_ASSURANCE_CLASS,
    }),
    [PACK_FILES.decision_policy]: pretty(policy),
    [PACK_FILES.tools]: pretty(tools),
    [PACK_FILES.memory_policy]: pretty({
      leak_rule: "public_at <= as_of AND memory_created_at <= as_of",
      write_enabled: false,
      assurance_class: SOLO_TEST_ASSURANCE_CLASS,
    }),
    [PACK_FILES.golden_cases]: "",
    [PACK_FILES.pairwise_cases]: "",
    [PACK_FILES.calibration_cases]: "",
    [PACK_FILES.experiments]: pretty({ schema_version: 1, persona_id: seat.persona_id, experiments: {} }),
    [PACK_FILES.voice_en]: voice(blueprint, seat, "en"),
    [PACK_FILES.voice_zh]: voice(blueprint, seat, "zh"),
    [PACK_FILES.provisional_index]: pretty(index),
  });
}

function generationContext({ root = DEFAULT_SOLO_TEST_PACK_ROOT, formulaRoot = DEFAULT_SOLO_TEST_FORMULA_ROOT, personaDir = defaultPersonaDir(), packVersion } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packVersion || "")) {
    fail("packVersion must be a semantic version, optionally with a prerelease suffix");
  }
  const formula = loadFormulaTree(formulaRoot);
  const blueprints = canonicalMasterBlueprints({ personaDir });
  const byBlueprint = new Map(blueprints.map((blueprint) => [blueprint.persona_id, blueprint]));
  const bySeat = new Map(buildInventory.seats.map((seat) => [seat.persona_id, seat]));
  if (bySeat.size !== CANONICAL_MASTER_COUNT || byBlueprint.size !== CANONICAL_MASTER_COUNT) fail(`canonical solo-test inventory must contain exactly ${CANONICAL_MASTER_COUNT} unique seats`);
  const output = resolve(root);
  if (basename(output) !== "masters" || basename(dirname(output)) !== "solo-test") {
    fail("solo-test pack root must end in knowledge/solo-test/masters (or an equivalent isolated solo-test/masters path)");
  }
  const documents = new Map();
  const formulaManifestHash = sha256(formula.manifest);
  for (const personaId of CANONICAL_MASTER_IDS) {
    documents.set(personaId, buildDocuments({
      seat: bySeat.get(personaId),
      blueprint: byBlueprint.get(personaId),
      rawTools: formula.byPersona.get(personaId),
      packVersion,
      formulaManifestHash,
    }));
  }
  return { output, personaDir: resolve(personaDir), formula, documents };
}

function writeStable(file, content, result) {
  const parent = dirname(file);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory()) fail(`unsafe output directory: ${parent}`);
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`unsafe output file: ${file}`);
    if (readFileSync(file, "utf8") === content) { result.unchanged.push(file); return; }
  }
  writeFileSync(file, content, { encoding: "utf8", mode: 0o644 });
  result.written.push(file);
}

export function writePersonaV3SoloTestPacks(options = {}) {
  const context = generationContext(options);
  const root = plainRoot(context.output, { create: true });
  const result = { written: [], unchanged: [] };
  for (const personaId of CANONICAL_MASTER_IDS) {
    const seatDir = resolve(root, personaId);
    if (!inside(root, seatDir)) fail(`${personaId}: output escapes the solo-test root`);
    if (!existsSync(seatDir)) mkdirSync(seatDir, { recursive: true });
    if (lstatSync(seatDir).isSymbolicLink() || !statSync(seatDir).isDirectory()) fail(`${personaId}: output seat must be a plain directory`);
    for (const [relativePath, content] of Object.entries(context.documents.get(personaId))) {
      const file = resolve(seatDir, relativePath);
      if (!inside(seatDir, file)) fail(`${personaId}: generated path escapes its seat`);
      writeStable(file, content, result);
    }
  }
  return Object.freeze({
    build_profile: "solo_test",
    written: result.written.map((file) => relative(root, file)),
    unchanged: result.unchanged.map((file) => relative(root, file)),
  });
}

function expectedFilesInSeat(documents) {
  return new Set(Object.keys(documents));
}

function actualFiles(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const file = join(current, entry.name);
    if (entry.isSymbolicLink()) fail(`symlink is forbidden in solo-test pack: ${file}`);
    if (entry.isDirectory()) actualFiles(root, file, out);
    else if (entry.isFile()) out.push(portableRelativePath(root, file));
    else fail(`special file is forbidden in solo-test pack: ${file}`);
  }
  return out.sort();
}

export function inspectPersonaV3SoloTestPacks(options = {}) {
  const context = generationContext(options);
  const root = plainRoot(context.output);
  const topEntries = readdirSync(root, { withFileTypes: true }).filter((entry) => !entry.name.startsWith("."));
  const unexpectedTop = topEntries.map((entry) => entry.name).filter((name) => !CANONICAL_MASTER_IDS.includes(name));
  const loaded = loadSoloTestV3Packs({ dir: root });
  const seats = [];
  for (const personaId of CANONICAL_MASTER_IDS) {
    const errors = [];
    const seatDir = resolve(root, personaId);
    const expectedDocs = context.documents.get(personaId);
    if (!existsSync(seatDir)) {
      errors.push("physical seat directory is missing");
    } else {
      const stat = lstatSync(seatDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) errors.push("seat must be a plain directory");
      else {
        const expected = [...expectedFilesInSeat(expectedDocs)].sort();
        const actual = actualFiles(seatDir);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push("physical file inventory differs from the deterministic build");
        for (const [relativePath, content] of Object.entries(expectedDocs)) {
          const file = resolve(seatDir, relativePath);
          if (!existsSync(file) || readFileSync(file, "utf8") !== content) errors.push(`${relativePath}: missing or drifted`);
        }
      }
    }
    const pack = loaded.get(personaId);
    let compiled = null;
    let admission = null;
    if (!pack) errors.push("explicit solo-test loader did not load the pack");
    else {
      try {
        compiled = compilePersonaPack(pack, {
          promptFile: join(context.personaDir, canonicalMasterBlueprints({ personaDir: context.personaDir })
            .find((item) => item.persona_id === personaId).canonical_prompt_file),
        });
        admission = inspectPersonaAdmission({ persona_id: personaId, pack_dir: seatDir });
      } catch (error) { errors.push(`compile/admission failed: ${error.message}`); }
    }
    let productionRejected = false;
    try { loadV3Pack(seatDir); } catch { productionRejected = true; }
    if (!productionRejected) errors.push("production loader accepted a solo-test pack");
    if (compiled?.build_profile !== "solo_test") errors.push("compiled pack lost its solo_test build profile");
    if (admission && admission.admission_level !== "operator_lens") errors.push(`admission escalated to ${admission.admission_level}`);
    if (admission?.operational_clear || admission?.candidate_clear || admission?.method_model_ready) errors.push("provisional pack cleared a production maturity gate");
    seats.push(canonicalValue({
      persona_id: personaId,
      physical: existsSync(seatDir),
      solo_loader_valid: Boolean(pack),
      compiler_valid: Boolean(compiled),
      production_loader_rejected: productionRejected,
      admission_level: admission?.admission_level || null,
      operational_clear: admission?.operational_clear === true,
      pack_hash: compiled?.pack_hash || null,
      errors,
    }));
  }
  const reportBase = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_solo_test_pack_readiness",
    build_profile: "solo_test",
    assurance_class: SOLO_TEST_ASSURANCE_CLASS,
    review_status: "not_human_reviewed",
    production_effect: "none",
    root,
    formula_manifest_hash: sha256(context.formula.manifest),
    pack_version: options.packVersion,
    summary: {
      physical_pack_count: seats.filter((seat) => seat.physical).length,
      solo_loader_valid_count: seats.filter((seat) => seat.solo_loader_valid).length,
      compiler_valid_count: seats.filter((seat) => seat.compiler_valid).length,
      provisional_operator_lens_count: seats.filter((seat) => seat.admission_level === "operator_lens").length,
      production_loader_rejection_count: seats.filter((seat) => seat.production_loader_rejected).length,
      operational_count: seats.filter((seat) => seat.operational_clear).length,
      method_model_count: 0,
      tool_count: context.formula.manifest.compiled_tool_count,
      invalid_count: seats.filter((seat) => seat.errors.length).length,
      unexpected_top_level_count: unexpectedTop.length,
      ready_for_solo_testing: unexpectedTop.length === 0 && seats.every((seat) => seat.errors.length === 0),
      production_eligible: false,
    },
    unexpected_top_level_entries: unexpectedTop,
    seats,
  });
  return Object.freeze(canonicalValue({ ...reportBase, readiness_hash: sha256(reportBase) }));
}

export function renderPersonaV3SoloTestPackReport(report) {
  return [
    "# PersonaPack v3 solo-test physical build",
    "",
    "> These are packaged provisional operator lenses. They are not approved method models and the production loader rejects them.",
    "",
    `Physical packs: ${report.summary.physical_pack_count}/${CANONICAL_MASTER_COUNT}`,
    `Solo loader valid: ${report.summary.solo_loader_valid_count}/${CANONICAL_MASTER_COUNT}`,
    `Compiled: ${report.summary.compiler_valid_count}/${CANONICAL_MASTER_COUNT}`,
    `Provisional operator lenses: ${report.summary.provisional_operator_lens_count}/${CANONICAL_MASTER_COUNT}`,
    `Production loader rejected: ${report.summary.production_loader_rejection_count}/${CANONICAL_MASTER_COUNT}`,
    `Tools: ${report.summary.tool_count}/${PLANNED_TOOL_COUNT}`,
    `Operational/method_model: ${report.summary.operational_count}/0`,
    `Ready for solo testing: ${report.summary.ready_for_solo_testing}`,
    `Readiness hash: \`${report.readiness_hash}\``,
    "",
  ].join("\n");
}
