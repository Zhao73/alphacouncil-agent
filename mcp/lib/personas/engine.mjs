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
import { languageKey, localized } from "../lang.mjs";
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
  const locale = languageKey(run.language);
  const label = item.pack.admitted_label?.[locale]
    || item.pack.admitted_label?.en || item.id;
  const copy = localized(run.language, {
    en: { withheld: (pct) => `${pct}% coverage; score withheld`, unscored: "not scored", verdict: (stance, reason) => `${label} frozen decision: ${stance} (${reason})`, summary: (score) => `The PersonaPack v3 deterministic policy executed with score ${score}. Typed facts, hard vetoes, and score bands produced this stance; no language model selected it.`, hit: (id) => `score hit: ${id}`, miss: (id) => `score miss: ${id}`, eligibility: (id) => `eligibility condition ${id} becomes satisfied`, veto: (id) => `hard veto ${id} no longer triggers`, score: (id) => `score condition ${id} becomes satisfied` },
    zh: { withheld: (pct) => `覆盖率 ${pct}%，分数被保留不发布`, unscored: "未评分", verdict: (stance, reason) => `${label}的冻结结论：${stance}（${reason}）`, summary: (score) => `PersonaPack v3 确定性政策已执行；得分 ${score}。该立场由结构化事实、硬否决和评分带产生，没有让语言模型选择立场。`, hit: (id) => `评分命中：${id}`, miss: (id) => `评分未命中：${id}`, eligibility: (id) => `资格条件 ${id} 变为满足`, veto: (id) => `硬否决 ${id} 不再触发`, score: (id) => `评分条件 ${id} 变为满足` },
    ja: { withheld: (pct) => `カバレッジ ${pct}% のためスコアは非公開`, unscored: "未採点", verdict: (stance, reason) => `${label}の凍結済み判断：${stance}（${reason}）`, summary: (score) => `PersonaPack v3 の決定論的ポリシーを実行し、スコアは ${score}。構造化事実、ハード拒否条件、スコア帯がこの立場を生成しており、言語モデルは立場を選択していない。`, hit: (id) => `採点条件を満たす：${id}`, miss: (id) => `採点条件を満たさない：${id}`, eligibility: (id) => `適格条件 ${id} が満たされる`, veto: (id) => `ハード拒否条件 ${id} が解除される`, score: (id) => `採点条件 ${id} が満たされる` },
    ko: { withheld: (pct) => `커버리지 ${pct}%로 점수를 공개하지 않음`, unscored: "미채점", verdict: (stance, reason) => `${label}의 동결된 판단: ${stance}(${reason})`, summary: (score) => `PersonaPack v3 결정론적 정책을 실행했으며 점수는 ${score}입니다. 구조화된 사실, 하드 거부 조건, 점수 구간이 이 입장을 만들었고 언어 모델은 입장을 선택하지 않았습니다.`, hit: (id) => `점수 조건 충족: ${id}`, miss: (id) => `점수 조건 미충족: ${id}`, eligibility: (id) => `적격 조건 ${id} 충족`, veto: (id) => `하드 거부 조건 ${id} 해제`, score: (id) => `점수 조건 ${id} 충족` },
  });
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
    ? copy.withheld(Math.round(result.score.coverage * 100))
    : result.score
      ? `${result.score.score}/${result.score.max_possible} (${Math.round((result.ratio || 0) * 100)}%)`
    : copy.unscored;
  return {
    master: item.id,
    symbol: run.symbol,
    as_of: run.as_of,
    stance: result.stance,
    verdict: copy.verdict(result.stance, result.reason),
    summary: copy.summary(scoreText),
    key_findings: uniqueStrings([
      ...hitIds.map(copy.hit),
      ...missIds.map(copy.miss),
    ]),
    disagreements: [],
    disqualifiers_triggered: uniqueStrings([...unmet, ...vetoIds]),
    what_would_change_my_mind: uniqueStrings([
      ...unmet.map(copy.eligibility),
      ...vetoIds.map(copy.veto),
      ...missIds.map(copy.score),
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
  const locale = languageKey(run.language);
  const label = item.pack.admitted_label?.[locale]
    || item.pack.admitted_label?.en || item.id;
  const copy = localized(run.language, {
    en: { none: "none", verdict: `${label} cannot evaluate ${run.symbol}: ${eligibility.reason}`, summary: (missing) => `The v3 typed-fact gate returned ${eligibility.status}; missing: ${missing}. No legacy prompt or narrative decision layer was called.`, available: (id) => `${id} becomes available from a point-in-time source` },
    zh: { none: "无", verdict: `${label}无法评估 ${run.symbol}：${eligibility.reason}`, summary: (missing) => `v3 typed-fact 闸门返回 ${eligibility.status}；缺失：${missing}。系统未调用旧提示词或叙述决策层。`, available: (id) => `${id} 可从时点一致的来源取得` },
    ja: { none: "なし", verdict: `${label}は ${run.symbol} を評価できません：${eligibility.reason}`, summary: (missing) => `v3 typed-fact ゲートは ${eligibility.status} を返しました。欠落：${missing}。旧プロンプトや叙述型の判断層は呼び出していません。`, available: (id) => `${id} が時点整合した出典から利用可能になる` },
    ko: { none: "없음", verdict: `${label}은 ${run.symbol}을 평가할 수 없습니다: ${eligibility.reason}`, summary: (missing) => `v3 typed-fact 게이트가 ${eligibility.status}을 반환했습니다. 누락: ${missing}. 기존 프롬프트나 서술형 판단 계층은 호출하지 않았습니다.`, available: (id) => `${id}을 시점 일치 출처에서 확보할 수 있게 됨` },
  });
  const missing = eligibility.missing_required_fact_types.join(", ") || copy.none;
  return {
    master: item.id,
    symbol: run.symbol,
    as_of: run.as_of,
    stance: "out_of_scope",
    verdict: copy.verdict,
    summary: copy.summary(missing),
    key_findings: [],
    disagreements: [],
    disqualifiers_triggered: eligibility.missing_required_fact_types,
    what_would_change_my_mind: eligibility.missing_required_fact_types.map(copy.available),
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
