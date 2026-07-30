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
import { buildAnonymousPreDecision, freezeAnonymousDecision, technicalIdReadableMap } from "../personas-v3/runtime.mjs";
import { executeDeterministicPersonaPolicy } from "../personas-v3/deterministic-executor.mjs";
import { languageKey, localized } from "../lang.mjs";
import { displayMasterLabel } from "../markdown.mjs";
import { voiceFromDecision, voiceFromDecline } from "../voice-from-decision.mjs";
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
  // A seat with SOME of its required facts still runs its own policy.
  //
  // Several seats are authored with a veto that says, in the method's own words, what an absent
  // fact means -- Pabrai passing without a downside floor, Graham without an asset floor. Those
  // facts are also tool inputs, so a missing one used to end the run at this gate and the veto
  // written for exactly that case never executed. The seat then reported "missing X", which is
  // the runtime describing itself rather than the method answering.
  //
  // Vetoes are evaluated before scoring, and every tool, veto and rule already declares its own
  // `on_missing` and `on_uncomputable` behaviour, so letting the policy run does not invent an
  // answer: it reaches the authored one. A seat with NONE of its required facts is still a hard
  // decline -- there is no method left to run.
  if (preDecision.eligibility.status === "out_of_scope") {
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
    // A seat that could not run because a fact it needs is absent has DECLINED, not broken.
    // Partially grounded seats now execute so their authored vetoes can answer, and a seat
    // without such a veto reaches the same clean abstention it always did -- reporting that as
    // a blocked policy would turn "there was nothing to compute with" into "the system
    // failed", which is the confusion this whole pass exists to remove.
    if (preDecision?.eligibility?.status === "insufficient_grounding" && error?.code === "MISSING_TOOL_INPUT") {
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
    // A malformed policy, unknown operation, or arithmetic failure blocks this physical v3
    // seat. The seat still owns the ID and never falls through to a legacy prompt or an
    // LLM-authored stance.
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

/**
 * Whether a frozen seat still needs a model worker to become readable.
 *
 * A seat that reached a stance has a reading worth explaining: which condition decided it, at
 * what number, and what would move it. A seat whose gate never opened has no reading. Its
 * deterministic statement already names the condition that closed the gate and says an
 * abstention is not a bearish vote, which is the whole of what an out_of_scope seat is asked
 * to say -- so an isolated worker there buys prose, not information. The declined path reached
 * this conclusion earlier for the same reason; this applies it to a seat that executed its
 * policy and abstained. On a real seven-seat run four such seats took most of the method phase
 * to report, at length, that they had no opinion.
 *
 * Set ALPHACOUNCIL_VOICE_ABSTAINING_SEATS=1 to give every seat a worker again.
 */
export function needsMethodVoiceWorker(opinion, { env = process.env } = {}) {
  if (env?.ALPHACOUNCIL_VOICE_ABSTAINING_SEATS === "1") return true;
  return (opinion?.stance || "out_of_scope") !== "out_of_scope";
}

/** Render a post-freeze, model-free opinion from the DSL result. */
export function completedMasterOpinion(run, item) {
  if (item?.engine !== "v3_method_runtime" || !item?.completed) {
    throw new Error("completedMasterOpinion requires a completed v3 deterministic seat");
  }
  const result = item.frozenDecision.structured_decision.result;
  const locale = languageKey(run.language);
  // The pack's admitted label carries a maturity suffix -- "provisional operator lens" and its
  // translations -- which belongs in the assurance section, not inside a sentence about the
  // company. Left in, every statement read "using the X provisional operator lens method",
  // which is both ungrammatical and a second copy of a disclosure the report already makes.
  const label = displayMasterLabel(item.pack.admitted_label?.[locale]
    || item.pack.admitted_label?.en || item.id);
  const copy = localized(run.language, {
    en: { abstain: (reasons) => `Using the ${label} method, I do not issue a directional view on ${run.symbol} in this run: the method gate did not open (${reasons}). This is neither bearish nor a vote against the asset; the seat reassesses only once that gate can be satisfied.`, withheld: (pct) => `${pct}% coverage; score withheld`, unscored: "not scored", verdict: (stance, reason) => `${label} frozen decision: ${stance} (${reason})`, summary: (score) => `Using the ${label} method on ${run.symbol}, the PersonaPack v3 deterministic policy executed with score ${score}. Typed facts, hard vetoes, and score bands produced this stance; no language model selected it.`, hit: (id) => `score hit: ${id}`, miss: (id) => `score miss: ${id}`, eligibility: (id) => `eligibility condition ${id} becomes satisfied`, veto: (id) => `hard veto ${id} no longer triggers`, score: (id) => `score condition ${id} becomes satisfied` },
    zh: { abstain: (reasons) => `按${label}方法审视 ${run.symbol}，本轮不作方向判断：方法闸门未打开（${reasons}）。这不是看空，也不是一张反对票；只有该闸门可被满足后，该席位才会重新评估。`, withheld: (pct) => `覆盖率 ${pct}%，分数被保留不发布`, unscored: "未评分", verdict: (stance, reason) => `${label}的冻结结论：${stance}（${reason}）`, summary: (score) => `按${label}方法审视 ${run.symbol}：PersonaPack v3 确定性政策已执行，得分 ${score}。该立场由结构化事实、硬否决和评分带产生，没有让语言模型选择立场。`, hit: (id) => `评分命中：${id}`, miss: (id) => `评分未命中：${id}`, eligibility: (id) => `资格条件 ${id} 变为满足`, veto: (id) => `硬否决 ${id} 不再触发`, score: (id) => `评分条件 ${id} 变为满足` },
    ja: { abstain: (reasons) => `${label}の方法では、メソッドのゲートが開かなかったため（${reasons}）、今回は ${run.symbol} の方向判断を出しません。弱気判断や反対票ではなく、そのゲートが満たせるようになった時点で再評価します。`, withheld: (pct) => `カバレッジ ${pct}% のためスコアは非公開`, unscored: "未採点", verdict: (stance, reason) => `${label}の凍結済み判断：${stance}（${reason}）`, summary: (score) => `${label}の方法で ${run.symbol} を評価し、PersonaPack v3 の決定論的ポリシーを実行した結果、スコアは ${score}。構造化事実、ハード拒否条件、スコア帯がこの立場を生成しており、言語モデルは立場を選択していない。`, hit: (id) => `採点条件を満たす：${id}`, miss: (id) => `採点条件を満たさない：${id}`, eligibility: (id) => `適格条件 ${id} が満たされる`, veto: (id) => `ハード拒否条件 ${id} が解除される`, score: (id) => `採点条件 ${id} が満たされる` },
    ko: { abstain: (reasons) => `${label} 방법으로는 방법론 게이트가 열리지 않아(${reasons}) 이번 실행에서 ${run.symbol}의 방향 판단을 내리지 않습니다. 이는 약세 판단이나 반대표가 아니며, 해당 게이트가 충족될 수 있을 때에만 재평가합니다.`, withheld: (pct) => `커버리지 ${pct}%로 점수를 공개하지 않음`, unscored: "미채점", verdict: (stance, reason) => `${label}의 동결된 판단: ${stance}(${reason})`, summary: (score) => `${label} 방법으로 ${run.symbol}을 검토하여 PersonaPack v3 결정론적 정책을 실행했으며 점수는 ${score}입니다. 구조화된 사실, 하드 거부 조건, 점수 구간이 이 입장을 만들었고 언어 모델은 입장을 선택하지 않았습니다.`, hit: (id) => `점수 조건 충족: ${id}`, miss: (id) => `점수 조건 미충족: ${id}`, eligibility: (id) => `적격 조건 ${id} 충족`, veto: (id) => `하드 거부 조건 ${id} 해제`, score: (id) => `점수 조건 ${id} 충족` },
  });
  // Every condition id in a frozen decision was hashed before the policy ran so the decision
  // layer could not recognise the seat. Past this point the seat is named in the report and in
  // the explanation worker's own prompt, so the hash only stops the seat from telling a reader
  // which condition decided it. Resolve each id back to the one the pack declares.
  const readableIds = technicalIdReadableMap(item.pack);
  const readable = (id) => readableIds.get(id) || id;
  const vetoIds = (result.vetoes_triggered || []).map((veto) => readable(veto.veto_id));
  const unmet = (result.eligibility?.unmet_condition_ids || []).map(readable);
  const hitIds = (result.score?.hits || []).map((rule) => readable(rule.rule_id));
  const missIds = (result.score?.misses || []).map((rule) => readable(rule.rule_id));
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
  // An eligibility gate that closes produces a frozen out_of_scope with no score band, and the
  // generic execution sentence says nothing a reader can use: not which condition closed the
  // gate, and not that an abstention is not a bearish vote. The decline path has said both for
  // a while; say the same here so no seat has to spend a model worker to state it.
  const abstained = result.stance === "out_of_scope";
  const abstainReasons = uniqueStrings([
    ...(result.eligibility?.unmet_condition_ids || []).map(readable),
    ...(result.eligibility?.uncomputable_condition_ids || []).map(readable),
    ...(result.eligibility?.missing_required_fact_types || []),
  ]);
  // `summary` stays the provenance sentence -- it is what records that no language model chose
  // the stance. Only the reader-facing statement changes, exactly as the decline path splits it.
  const provenanceSummary = copy.summary(scoreText);
  const deterministicStatement = abstained
    ? copy.abstain(abstainReasons.join("; ") || result.reason || copy.unscored)
    : provenanceSummary;
  return {
    master: item.id,
    symbol: run.symbol,
    as_of: run.as_of,
    stance: result.stance,
    verdict: copy.verdict(result.stance, result.reason),
    summary: provenanceSummary,
    voice_statement: deterministicStatement,
    // The five fields, composed from the frozen decision rather than written about it: which
    // facts were read and their values, what the tools produced, which scoring conditions held
    // and which did not, and what would move the verdict. A one-line statement told a reader
    // the stance and nothing about how it was reached.
    voice: voiceFromDecision({
      result,
      policy: item.pack.components?.decision_policy,
      factPack: item.preDecision?.fact_pack,
      readableIds,
      language: run.language,
    }),
    voice_status: "deterministic_fallback",
    voice_language: run.language,
    statement_origin: "deterministic_policy_fallback",
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
    // The frozen decision keeps its anonymised ids -- they are inside the hash. This is the
    // reader-facing copy, so resolve the veto ids here and leave the frozen artifact alone.
    common_projection: result.common_projection
      ? { ...result.common_projection, veto_ids: (result.common_projection.veto_ids || []).map(readable) }
      : result.common_projection,
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
  // The pack's admitted label carries a maturity suffix -- "provisional operator lens" and its
  // translations -- which belongs in the assurance section, not inside a sentence about the
  // company. Left in, every statement read "using the X provisional operator lens method",
  // which is both ungrammatical and a second copy of a disclosure the report already makes.
  const label = displayMasterLabel(item.pack.admitted_label?.[locale]
    || item.pack.admitted_label?.en || item.id);
  const instrument = run?.grounding?.instrument;
  const fundOrIndex = instrument?.fund_like === true || instrument?.index_like === true
    || ["etf", "mutual_fund", "index"].includes(instrument?.asset_type);
  const copy = localized(run.language, {
    en: { none: "none", verdict: `${label} cannot evaluate ${run.symbol}: ${eligibility.reason}`, summary: (missing) => `The v3 typed-fact gate returned ${eligibility.status}; missing: ${missing}. No legacy prompt or narrative decision layer was called.`, fundContext: fundOrIndex ? `${run.symbol} is classified as ${instrument.asset_type}; this method must use dated holdings or aggregate index evidence rather than treating the instrument as an operating company. ` : "", statement: (missing, context) => `${context}Using the ${label} method, I do not issue a directional view on ${run.symbol} in this run because the point-in-time record lacks ${missing}. This is neither bearish nor a vote against the asset. I would reassess only after those method-critical facts are available.`, available: (id) => `${id} becomes available from a point-in-time source` },
    zh: { none: "无", verdict: `${label}无法评估 ${run.symbol}：${eligibility.reason}`, summary: (missing) => `v3 typed-fact 闸门返回 ${eligibility.status}；缺失：${missing}。系统未调用旧提示词或叙述决策层。`, fundContext: fundOrIndex ? `${run.symbol} 已识别为 ${instrument.asset_type}；该方法必须通过带时点的持仓穿透或指数聚合证据使用，不能把它当成经营公司。` : "", statement: (missing, context) => `${context}按${label}方法审视 ${run.symbol}，本轮不作方向判断，因为时点一致的资料缺少：${missing}。这不是看空，也不是一张反对票；只有取得这些方法关键事实后，该席位才会重新评估。`, available: (id) => `${id} 可从时点一致的来源取得` },
    ja: { none: "なし", verdict: `${label}は ${run.symbol} を評価できません：${eligibility.reason}`, summary: (missing) => `v3 typed-fact ゲートは ${eligibility.status} を返しました。欠落：${missing}。旧プロンプトや叙述型の判断層は呼び出していません。`, fundContext: fundOrIndex ? `${run.symbol} は ${instrument.asset_type} に分類されており、事業会社として扱わず、基準日付き保有銘柄のルックスルーまたは指数集計証拠を用いる必要があります。` : "", statement: (missing, context) => `${context}${label}の方法では、時点整合した資料に ${missing} が欠けているため、今回は ${run.symbol} の方向判断を出しません。弱気判断や反対票ではなく、これらの方法上重要な事実が揃った時点で再評価します。`, available: (id) => `${id} が時点整合した出典から利用可能になる` },
    ko: { none: "없음", verdict: `${label}은 ${run.symbol}을 평가할 수 없습니다: ${eligibility.reason}`, summary: (missing) => `v3 typed-fact 게이트가 ${eligibility.status}을 반환했습니다. 누락: ${missing}. 기존 프롬프트나 서술형 판단 계층은 호출하지 않았습니다.`, fundContext: fundOrIndex ? `${run.symbol}은 ${instrument.asset_type}로 분류되므로 영업회사처럼 취급하지 않고 기준일이 있는 보유 종목 룩스루 또는 지수 집계 증거를 사용해야 합니다. ` : "", statement: (missing, context) => `${context}${label} 방법으로는 시점 일치 자료에 ${missing}이 없어 이번 실행에서 ${run.symbol}의 방향 판단을 내리지 않습니다. 이는 약세 판단이나 반대표가 아니며, 해당 핵심 사실이 확보된 뒤에만 재평가합니다.`, available: (id) => `${id}을 시점 일치 출처에서 확보할 수 있게 됨` },
  });
  const missing = eligibility.missing_required_fact_types.join(", ") || copy.none;
  const deterministicStatement = copy.statement(missing, copy.fundContext);
  return {
    master: item.id,
    symbol: run.symbol,
    as_of: run.as_of,
    stance: "out_of_scope",
    verdict: copy.verdict,
    summary: copy.summary(missing),
    voice_statement: deterministicStatement,
    // The five fields, composed from the frozen decision rather than written about it: which
    // facts were read and their values, what the tools produced, which scoring conditions held
    // and which did not, and what would move the verdict. A one-line statement told a reader
    // the stance and nothing about how it was reached.
    // An abstention is readable too: what the method did have, what it needed, and why it will
    // not substitute a proxy for the difference.
    voice: voiceFromDecline({ eligibility, language: run.language }),
    voice_status: "deterministic_scope",
    voice_language: run.language,
    statement_origin: "deterministic_scope_fallback",
    key_findings: [deterministicStatement],
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
