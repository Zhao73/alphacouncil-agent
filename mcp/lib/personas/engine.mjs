/**
 * One maturity-aware master engine boundary.
 *
 * A physical v3 pack owns its seat. It may deterministically decline or block because its
 * typed facts/executor are unavailable, but it may never fall through to a v2/v1 prompt.
 * Seats with no physical v3 pack keep the explicit legacy path during the 0.9 feature-flag
 * migration. The release gate later requires that legacy set to be empty.
 */

import { compiledPersonaPacks } from "../personas-v3/registry.mjs";
import { buildFactPack } from "../personas-v3/typed-facts.mjs";
import { typedFactPackFromGrounding } from "../personas-v3/grounding-adapter.mjs";
import { buildAnonymousPreDecision, freezeAnonymousDecision } from "../personas-v3/runtime.mjs";
import { executeDeterministicPersonaPolicy } from "../personas-v3/deterministic-executor.mjs";
import { isChineseLanguage } from "../lang.mjs";
import {
  declinedOpinion as v2DeclinedOpinion,
  planMasters as planLegacyMasters,
  reconcileOpinion as reconcileLegacyOpinion,
} from "../personas-v2/bridge.mjs";

function v3FactPack(run) {
  if (run?.grounding?.typed_fact_pack) return run.grounding.typed_fact_pack;
  const asOf = run?.as_of;
  if (run?.grounding && typeof run.grounding === "object") {
    return typedFactPackFromGrounding(run.grounding, {
      asOf,
      knowledgeAsOf: run?.knowledge_as_of || asOf,
    });
  }
  return buildFactPack([], { asOf, knowledgeAsOf: run?.knowledge_as_of || asOf });
}

function v3DecisionRecord(id, pack, preDecision, frozenDecision = null) {
  const result = frozenDecision?.structured_decision?.result || null;
  return {
    persona_id: id,
    engine: "v3_method_runtime",
    dsl_version: pack.dsl_version || pack.manifest.computation.dsl_version,
    kind: pack.maturity,
    pack_hash: pack.pack_hash,
    corpus_hash: pack.corpus_hash,
    policy_hash: pack.policy_hash,
    tool_graph_hash: pack.tool_graph_hash,
    fact_pack_hash: preDecision.fact_pack.fact_pack_hash,
    evidence_snapshot_hash: preDecision.evidence_snapshot_hash,
    deterministic_core_hash: preDecision.deterministic_core_hash,
    eligibility: preDecision.eligibility,
    stance: result?.stance || "out_of_scope",
    reason: result?.reason || preDecision.eligibility.status,
    score: result?.score || null,
    ratio: result?.ratio ?? null,
    vetoes_triggered: result?.vetoes_triggered || [],
    native_decision: result?.native_decision || null,
    native_state: result?.native_decision?.state || null,
    common_projection: result?.common_projection || null,
    policy_execution_hash: result?.policy_execution_hash || null,
    frozen_decision: frozenDecision,
  };
}

function planV3Seat(run, id, pack) {
  let preDecision;
  try {
    preDecision = buildAnonymousPreDecision({
      compiledPack: pack,
      factPack: v3FactPack(run),
      privateEvidence: [],
    });
  } catch (error) {
    return {
      id,
      engine: "v3_method_runtime",
      blocked: true,
      reason: "invalid_typed_grounding",
      error: error.message,
      pack,
    };
  }
  if (preDecision.eligibility.status !== "ready") {
    const frozenDecision = freezeAnonymousDecision(preDecision);
    return {
      id,
      engine: "v3_method_runtime",
      declined: true,
      reason: preDecision.eligibility.status,
      pack,
      preDecision,
      frozenDecision,
      decision: v3DecisionRecord(id, pack, preDecision, frozenDecision),
    };
  }

  try {
    const execution = executeDeterministicPersonaPolicy(preDecision);
    const frozenDecision = execution.frozen_decision;
    return {
      id,
      engine: "v3_method_runtime",
      completed: true,
      reason: frozenDecision.structured_decision.result.reason,
      pack,
      preDecision,
      frozenDecision,
      execution,
      decision: v3DecisionRecord(id, pack, preDecision, frozenDecision),
    };
  } catch (error) {
    // A malformed policy, unknown operation, missing declared fact, or arithmetic failure
    // blocks this physical v3 seat. The seat still owns the ID and never falls through to a
    // legacy prompt or an LLM-authored stance.
    return {
      id,
      engine: "v3_method_runtime",
      blocked: true,
      reason: "v3_policy_execution_failed",
      error: error.message,
      error_code: error.code || "V3_POLICY_EXECUTION_FAILED",
      pack,
      preDecision,
      decision: v3DecisionRecord(id, pack, preDecision),
    };
  }
}

export function planMasterSeats(
  run,
  masterIds,
  { v3Registry = compiledPersonaPacks(), legacyPlanner = planLegacyMasters } = {},
) {
  const selected = [...(masterIds || [])];
  const legacyIds = [];
  const v3ById = new Map();
  for (const id of selected) {
    const pack = v3Registry.get(id);
    if (!pack) legacyIds.push(id);
    else v3ById.set(id, planV3Seat(run, id, pack));
  }
  const legacy = legacyIds.length
    ? legacyPlanner(run, legacyIds)
    : { facts: null, decisions: [], to_run: [], declined: [] };
  const legacyToRun = new Map((legacy.to_run || []).map((item) => [item.id, item]));
  const legacyDeclined = new Map((legacy.declined || []).map((item) => [item.id, item]));
  const toRun = [];
  const declined = [];
  const completed = [];
  const blocked = [];
  const decisions = [];

  for (const id of selected) {
    const v3 = v3ById.get(id);
    if (v3) {
      if (v3.decision) decisions.push(v3.decision);
      if (v3.declined) declined.push(v3);
      else if (v3.completed) completed.push(v3);
      else if (v3.blocked) blocked.push(v3);
      continue;
    }
    const runnable = legacyToRun.get(id);
    const decline = legacyDeclined.get(id);
    if (runnable) toRun.push(runnable);
    if (decline) declined.push(decline);
  }
  decisions.push(...(legacy.decisions || []));
  const factPackHashes = uniqueStrings([...v3ById.values()]
    .map((item) => item.preDecision?.fact_pack?.fact_pack_hash));
  if (factPackHashes.length > 1) {
    throw new Error("selected v3 seats did not receive one immutable shared fact pack");
  }
  return {
    facts: legacy.facts,
    decisions,
    to_run: toRun,
    declined,
    completed,
    blocked,
    shared_fact_pack_hash: factPackHashes[0] || null,
    v3_ids: [...v3ById.keys()],
    legacy_ids: legacyIds,
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length))];
}

/** Render a post-freeze, model-free opinion from the DSL result. */
export function completedMasterOpinion(run, item) {
  if (item?.engine !== "v3_method_runtime" || !item?.completed) {
    throw new Error("completedMasterOpinion requires a completed v3 deterministic seat");
  }
  const result = item.frozenDecision.structured_decision.result;
  const zh = isChineseLanguage(run.language);
  const label = item.pack.admitted_label?.[zh ? "zh" : "en"]
    || item.pack.admitted_label?.en || item.id;
  const vetoIds = (result.vetoes_triggered || []).map((veto) => veto.veto_id);
  const unmet = result.eligibility?.unmet_condition_ids || [];
  const hitIds = (result.score?.hits || []).map((rule) => rule.rule_id);
  const missIds = (result.score?.misses || []).map((rule) => rule.rule_id);
  const sourceIds = uniqueStrings([
    ...(result.eligibility?.checks || []).flatMap((check) => check.source_ids || []),
    ...(result.vetoes_triggered || []).flatMap((veto) => veto.source_ids || []),
    ...(result.score?.hits || []).flatMap((rule) => rule.source_ids || []),
    ...(result.score?.misses || []).flatMap((rule) => rule.source_ids || []),
  ]);
  const scoreText = result.score?.status === "insufficient_coverage"
    ? zh
      ? `覆盖率 ${Math.round(result.score.coverage * 100)}%，分数被保留不发布`
      : `${Math.round(result.score.coverage * 100)}% coverage; score withheld`
    : result.score
      ? `${result.score.score}/${result.score.max_possible} (${Math.round((result.ratio || 0) * 100)}%)`
    : zh ? "未评分" : "not scored";
  return {
    master: item.id,
    symbol: run.symbol,
    as_of: run.as_of,
    stance: result.stance,
    verdict: zh
      ? `${label}的冻结结论：${result.stance}（${result.reason}）`
      : `${label} frozen decision: ${result.stance} (${result.reason})`,
    summary: zh
      ? `PersonaPack v3 确定性政策已执行；得分 ${scoreText}。该立场由结构化事实、硬否决和评分带产生，没有让语言模型选择立场。`
      : `The PersonaPack v3 deterministic policy executed with score ${scoreText}. Typed facts, hard vetoes, and score bands produced this stance; no language model selected it.`,
    key_findings: uniqueStrings([
      ...hitIds.map((id) => zh ? `评分命中：${id}` : `score hit: ${id}`),
      ...missIds.map((id) => zh ? `评分未命中：${id}` : `score miss: ${id}`),
    ]),
    disagreements: [],
    disqualifiers_triggered: uniqueStrings([...unmet, ...vetoIds]),
    what_would_change_my_mind: uniqueStrings([
      ...unmet.map((id) => zh ? `资格条件 ${id} 变为满足` : `eligibility condition ${id} becomes satisfied`),
      ...vetoIds.map((id) => zh ? `硬否决 ${id} 不再触发` : `hard veto ${id} no longer triggers`),
      ...missIds.map((id) => zh ? `评分条件 ${id} 变为满足` : `score condition ${id} becomes satisfied`),
    ]),
    source_ids: sourceIds,
    confidence: result.common_projection?.confidence || "low",
    engine: "v3_method_runtime",
    dsl_version: item.pack.dsl_version || item.pack.manifest.computation.dsl_version,
    deterministic_stance: result.stance,
    decision_reason: result.reason,
    native_decision: result.native_decision,
    native_state: result.native_decision.state,
    common_projection: result.common_projection,
    pack_hash: item.pack.pack_hash,
    corpus_hash: item.pack.corpus_hash,
    policy_hash: item.pack.policy_hash,
    tool_graph_hash: item.pack.tool_graph_hash,
    fact_pack_hash: item.preDecision.fact_pack.fact_pack_hash,
    evidence_snapshot_hash: item.preDecision.evidence_snapshot_hash,
    deterministic_core_hash: item.preDecision.deterministic_core_hash,
    policy_execution_hash: result.policy_execution_hash,
    structured_decision_hash: item.frozenDecision.structured_decision_hash,
    frozen_decision_hash: item.frozenDecision.frozen_decision_hash,
  };
}

export function declinedMasterOpinion(run, item) {
  if (item?.engine !== "v3_method_runtime") return v2DeclinedOpinion(run, item.id, item.decision);
  const eligibility = item.preDecision.eligibility;
  const zh = isChineseLanguage(run.language);
  const label = item.pack.admitted_label?.[zh ? "zh" : "en"]
    || item.pack.admitted_label?.en || item.id;
  const missing = eligibility.missing_required_fact_types.join(", ") || (zh ? "无" : "none");
  return {
    master: item.id,
    symbol: run.symbol,
    as_of: run.as_of,
    stance: "out_of_scope",
    verdict: zh
      ? `${label}无法评估 ${run.symbol}：${eligibility.reason}`
      : `${label} cannot evaluate ${run.symbol}: ${eligibility.reason}`,
    summary: zh
      ? `v3 typed-fact 闸门返回 ${eligibility.status}；缺失：${missing}。系统未调用旧提示词或叙述决策层。`
      : `The v3 typed-fact gate returned ${eligibility.status}; missing: ${missing}. No legacy prompt or narrative decision layer was called.`,
    key_findings: [],
    disagreements: [],
    disqualifiers_triggered: eligibility.missing_required_fact_types,
    what_would_change_my_mind: eligibility.missing_required_fact_types.map((id) => (
      zh ? `${id} 可从时点一致的来源取得` : `${id} becomes available from a point-in-time source`
    )),
    source_ids: [],
    // The refusal itself is deterministic, but the seat has insufficient evidence for an
    // investment judgment. Keep the reader-facing evidence confidence low so a mechanically
    // certain abstention cannot be mistaken for a high-confidence market view.
    confidence: "low",
    engine: "v3_method_runtime",
    dsl_version: item.pack.dsl_version || item.pack.manifest.computation.dsl_version,
    deterministic_stance: "out_of_scope",
    decision_reason: eligibility.status,
    native_decision: item.frozenDecision.structured_decision.result.native_decision,
    native_state: item.frozenDecision.structured_decision.result.native_decision.state,
    pack_hash: item.pack.pack_hash,
    corpus_hash: item.pack.corpus_hash,
    policy_hash: item.pack.policy_hash,
    tool_graph_hash: item.pack.tool_graph_hash,
    fact_pack_hash: item.preDecision.fact_pack.fact_pack_hash,
    evidence_snapshot_hash: item.preDecision.evidence_snapshot_hash,
    deterministic_core_hash: item.preDecision.deterministic_core_hash,
    frozen_decision_hash: item.frozenDecision.frozen_decision_hash,
  };
}

export function reconcileMasterOpinion(run, masterId, opinion, { v3Registry = compiledPersonaPacks() } = {}) {
  if (v3Registry.get(masterId)) {
    throw new Error(`v3 seat ${masterId} cannot be recorded through the legacy narrative opinion path`);
  }
  return reconcileLegacyOpinion(run, masterId, opinion);
}
