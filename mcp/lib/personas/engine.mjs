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
import { adaptGroundingToTypedFacts } from "../personas-v3/grounding-adapter.mjs";
import {
  buildAnonymousPreDecision,
  executeDeterministicPersonaPolicy,
  freezeAnonymousDecision,
  technicalIdReadableMap,
} from "../personas-v3/runtime.mjs";
import { languageKey, localized } from "../lang.mjs";
import { displayMasterLabel } from "../markdown.mjs";
import { factsInCondition, voiceFromDecision, voiceFromDecline } from "../voice-from-decision.mjs";
import {
  declinedOpinion as v2DeclinedOpinion,
  planMasters as planLegacyMasters,
  reconcileOpinion as reconcileLegacyOpinion,
} from "../personas-v2/bridge.mjs";

export function ensureV3FactPack(run) {
  if (run?.grounding?.typed_fact_pack) return run.grounding.typed_fact_pack;
  const asOf = run?.as_of;
  if (run?.grounding && typeof run.grounding === "object") {
    const adapted = adaptGroundingToTypedFacts(run.grounding, {
      asOf,
      knowledgeAsOf: run?.knowledge_as_of || asOf,
    });
    // Caller-supplied grounding can arrive before the standard gatherer has attached its typed
    // view. Persist the exact adapter result on the run so the deterministic seat and
    // source_manifest.json cannot observe different fact lineages.
    run.grounding = {
      ...run.grounding,
      typed_fact_pack: adapted.fact_pack,
      typed_fact_sources: adapted.sources,
      typed_fact_diagnostics: adapted.diagnostics,
    };
    return adapted.fact_pack;
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
    company_dossier_hash: preDecision.private_evidence?.company_dossier_hash || null,
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
      factPack: ensureV3FactPack(run),
      // The deterministic policy still consumes only typed facts. Bind every selected seat to
      // the same completed dossier hash so provenance can prove which full evidence snapshot
      // its post-freeze explanation received; no method-specific private packet is allowed.
      privateEvidence: run?.company_dossier?.content_hash
        ? {
          contract_id: run.company_dossier.contract_id,
          company_dossier_hash: run.company_dossier.content_hash,
          coverage_status: run.company_dossier.status,
          retrieval_status: run.company_dossier.retrieval_status,
        }
        : [],
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
    if (preDecision?.eligibility?.status === "insufficient_grounding"
      && ["INSUFFICIENT_GROUNDING", "MISSING_TOOL_INPUT"].includes(error?.code)) {
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
 * Investment evidence and method-definition provenance are different source domains.
 *
 * PersonaPack rules cite the documents that define the provisional method. Those IDs prove
 * where the formula came from; they do not prove the company facts fed into the formula. The
 * reader-facing opinion therefore cites the point-in-time fact sources separately, while the
 * pack sources stay available as auditable method provenance.
 */
function methodSourceIds(item) {
  return uniqueStrings((item?.pack?.components?.sources || [])
    .map((source) => source?.id || source?.source_id));
}

function evidenceSourceIds(item) {
  const policy = item?.pack?.components?.decision_policy;
  const tools = item?.pack?.components?.tools || [];
  const factIds = uniqueStrings([
    ...(policy?.eligibility?.all || []).flatMap((record) => factsInCondition(record?.condition)),
    ...(policy?.hard_vetoes || []).flatMap((record) => factsInCondition(record?.condition)),
    ...(policy?.scoring?.rules || []).flatMap((record) => factsInCondition(record?.condition)),
    ...tools.flatMap((tool) => factsInCondition(tool?.inputs)),
  ]);
  const facts = new Map((item?.preDecision?.fact_pack?.facts || [])
    .map((fact) => [fact?.fact_id, fact]));
  return uniqueStrings(factIds.flatMap((id) => facts.get(id)?.source_ids || []));
}

/**
 * Whether a frozen seat still needs a model worker to become readable.
 *
 * Every selected seat gets its isolated voice worker, including an abstaining seat. Strong
 * first-person, method-specific expression is a reader contract, not an optional cost
 * optimization. The deterministic first-person rendering remains only as an auditable
 * failure/dry-run fallback and never substitutes a generic third-person summary.
 */
export function needsMethodVoiceWorker() {
  return true;
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
    en: { abstain: (reasons) => `Speaking through the ${label} method on ${run.symbol}: this seat owes you its reading of this company, and the frozen record below is what my discipline could establish before its own gate closed (${reasons}). What I withhold is the scored vote, not the view. Read that precisely: it is neither bearish nor a vote against the asset -- a method that guesses without its inputs stops being a method. Put those inputs in front of me and this seat returns to the table at once.`, withheld: (pct) => `${pct}% coverage; score withheld`, unscored: "not scored", verdict: (stance, reason) => `${label} frozen decision: ${stance} (${reason})`, summary: (score) => `Using the ${label} method on ${run.symbol}, the PersonaPack v3 deterministic policy executed with score ${score}. Typed facts, hard vetoes, and score bands produced this stance; no language model selected it.`, hit: (id) => `score hit: ${id}`, miss: (id) => `score miss: ${id}`, eligibility: (id) => `eligibility condition ${id} becomes satisfied`, veto: (id) => `hard veto ${id} no longer triggers`, score: (id) => `score condition ${id} becomes satisfied` },
    zh: { abstain: (reasons) => `按${label}方法看 ${run.symbol}：这个席位欠你一份对这家公司的读数，下面冻结的记录就是我的纪律在自己的闸门关上之前所能确立的部分（${reasons}）。我保留的是那张记分的票，不是观点。请准确理解：这不是看空，也不是一张反对票——缺着输入硬猜，方法就不再是方法。把这些输入摆到我面前，这个席位立刻回到桌上重新评估。`, withheld: (pct) => `覆盖率 ${pct}%，分数被保留不发布`, unscored: "未评分", verdict: (stance, reason) => `${label}的冻结结论：${stance}（${reason}）`, summary: (score) => `按${label}方法审视 ${run.symbol}：PersonaPack v3 确定性政策已执行，得分 ${score}。该立场由结构化事实、硬否决和评分带产生，没有让语言模型选择立场。`, hit: (id) => `评分命中：${id}`, miss: (id) => `评分未命中：${id}`, eligibility: (id) => `资格条件 ${id} 变为满足`, veto: (id) => `硬否决 ${id} 不再触发`, score: (id) => `评分条件 ${id} 变为满足` },
    ja: { abstain: (reasons) => `${label}の方法で ${run.symbol} を見ます。この席はこの企業についての読みをお伝えする義務があり、以下の凍結された記録は、私の規律が自らのゲートが閉じる前に確立できた範囲です（${reasons}）。私が保留するのは採点された一票であって、見解ではありません。正確に読んでください。これは弱気判断でも反対票でもありません——入力なしに推測すれば、それはもはや方法ではないからです。この入力が揃い次第、この席は直ちに再評価に戻ります。`, withheld: (pct) => `カバレッジ ${pct}% のためスコアは非公開`, unscored: "未採点", verdict: (stance, reason) => `${label}の凍結済み判断：${stance}（${reason}）`, summary: (score) => `${label}の方法で ${run.symbol} を評価し、PersonaPack v3 の決定論的ポリシーを実行した結果、スコアは ${score}。構造化事実、ハード拒否条件、スコア帯がこの立場を生成しており、言語モデルは立場を選択していない。`, hit: (id) => `採点条件を満たす：${id}`, miss: (id) => `採点条件を満たさない：${id}`, eligibility: (id) => `適格条件 ${id} が満たされる`, veto: (id) => `ハード拒否条件 ${id} が解除される`, score: (id) => `採点条件 ${id} が満たされる` },
    ko: { abstain: (reasons) => `${label} 방법으로 ${run.symbol}을 봅니다. 이 좌석은 이 회사에 대한 판독을 전할 의무가 있으며, 아래 동결된 기록은 제 원칙이 자신의 게이트가 닫히기 전까지 확립할 수 있었던 부분입니다(${reasons}). 제가 보류하는 것은 채점된 한 표이지 견해가 아닙니다. 정확히 읽어 주십시오. 이는 약세 판단도 반대표도 아닙니다 — 입력 없이 추측하면 그것은 더 이상 방법이 아니기 때문입니다. 이 입력이 갖춰지는 즉시 이 좌석은 곧바로 재평가로 돌아옵니다.`, withheld: (pct) => `커버리지 ${pct}%로 점수를 공개하지 않음`, unscored: "미채점", verdict: (stance, reason) => `${label}의 동결된 판단: ${stance}(${reason})`, summary: (score) => `${label} 방법으로 ${run.symbol}을 검토하여 PersonaPack v3 결정론적 정책을 실행했으며 점수는 ${score}입니다. 구조화된 사실, 하드 거부 조건, 점수 구간이 이 입장을 만들었고 언어 모델은 입장을 선택하지 않았습니다.`, hit: (id) => `점수 조건 충족: ${id}`, miss: (id) => `점수 조건 미충족: ${id}`, eligibility: (id) => `적격 조건 ${id} 충족`, veto: (id) => `하드 거부 조건 ${id} 해제`, score: (id) => `점수 조건 ${id} 충족` },
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
  const methodSources = uniqueStrings([
    ...methodSourceIds(item),
    ...(result.eligibility?.checks || []).flatMap((check) => check.source_ids || []),
    ...(result.vetoes_triggered || []).flatMap((veto) => veto.source_ids || []),
    ...(result.score?.hits || []).flatMap((rule) => rule.source_ids || []),
    ...(result.score?.misses || []).flatMap((rule) => rule.source_ids || []),
  ]);
  const evidenceSources = evidenceSourceIds(item);
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
    // `source_ids` remains the investment-evidence field consumed by the downstream source
    // gate. A project-authored proxy may explain the method, but can never satisfy that gate.
    source_ids: evidenceSources,
    evidence_source_ids: evidenceSources,
    method_source_ids: methodSources,
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
    en: { none: "none", verdict: `${label} cannot evaluate ${run.symbol}: ${eligibility.reason}`, summary: (missing) => `The v3 typed-fact gate returned ${eligibility.status}; missing: ${missing}. No legacy prompt or narrative decision layer was called.`, fundContext: fundOrIndex ? `${run.symbol} is classified as ${instrument.asset_type}; this method must use dated holdings or aggregate index evidence rather than treating the instrument as an operating company. ` : "", statement: (missing, context) => `${context}Speaking through the ${label} method: I went looking for what my discipline runs on, and the point-in-time record lacks ${missing}. Without it I refuse to improvise a substitute, so I issue no directional view on ${run.symbol} in this run. That refusal is a judgment about the record, not about the asset -- it is neither bearish nor a vote against the asset. Hand me those method-critical facts from a dated source and I reassess on the spot.`, available: (id) => `${id} becomes available from a point-in-time source` },
    zh: { none: "无", verdict: `${label}无法评估 ${run.symbol}：${eligibility.reason}`, summary: (missing) => `v3 typed-fact 闸门返回 ${eligibility.status}；缺失：${missing}。系统未调用旧提示词或叙述决策层。`, fundContext: fundOrIndex ? `${run.symbol} 已识别为 ${instrument.asset_type}；该方法必须通过带时点的持仓穿透或指数聚合证据使用，不能把它当成经营公司。` : "", statement: (missing, context) => `${context}按${label}方法发言：我先去找我的纪律赖以运转的材料，结果时点一致的资料缺少：${missing}。缺了它我拒绝拿代理数字凑合，所以本轮对 ${run.symbol} 不作方向判断。这个拒绝是对资料的判断，不是对资产的判断——这不是看空，也不是一张反对票。把这些带时点的方法关键事实交到我手上，我当场重新评估。`, available: (id) => `${id} 可从时点一致的来源取得` },
    ja: { none: "なし", verdict: `${label}は ${run.symbol} を評価できません：${eligibility.reason}`, summary: (missing) => `v3 typed-fact ゲートは ${eligibility.status} を返しました。欠落：${missing}。旧プロンプトや叙述型の判断層は呼び出していません。`, fundContext: fundOrIndex ? `${run.symbol} は ${instrument.asset_type} に分類されており、事業会社として扱わず、基準日付き保有銘柄のルックスルーまたは指数集計証拠を用いる必要があります。` : "", statement: (missing, context) => `${context}${label}の方法として発言します。私の規律が拠って立つ材料を探しに行きましたが、時点整合した記録には ${missing} が欠けています。それなしに代理の数字で間に合わせることは拒みます。したがって今回は ${run.symbol} の方向判断を出しません。この拒否は記録に対する判断であって、資産に対する判断ではありません——弱気判断でも反対票でもありません。基準日付きの出典からこれらの事実が届き次第、その場で再評価します。`, available: (id) => `${id} が時点整合した出典から利用可能になる` },
    ko: { none: "없음", verdict: `${label}은 ${run.symbol}을 평가할 수 없습니다: ${eligibility.reason}`, summary: (missing) => `v3 typed-fact 게이트가 ${eligibility.status}을 반환했습니다. 누락: ${missing}. 기존 프롬프트나 서술형 판단 계층은 호출하지 않았습니다.`, fundContext: fundOrIndex ? `${run.symbol}은 ${instrument.asset_type}로 분류되므로 영업회사처럼 취급하지 않고 기준일이 있는 보유 종목 룩스루 또는 지수 집계 증거를 사용해야 합니다. ` : "", statement: (missing, context) => `${context}${label} 방법으로 말합니다. 제 원칙이 딛고 서는 자료를 찾으러 갔지만, 시점 일치 기록에는 ${missing}이 없습니다. 그것 없이 대용 숫자로 때우는 것은 거부합니다. 따라서 이번 실행에서 ${run.symbol}의 방향 판단을 내리지 않습니다. 이 거부는 기록에 대한 판단이지 자산에 대한 판단이 아닙니다 — 약세 판단도 반대표도 아닙니다. 기준일 있는 출처에서 이 핵심 사실들을 건네주시면 그 자리에서 재평가하겠습니다.`, available: (id) => `${id}을 시점 일치 출처에서 확보할 수 있게 됨` },
  });
  const missing = eligibility.missing_required_fact_types.join(", ") || copy.none;
  const deterministicStatement = copy.statement(missing, copy.fundContext);
  const evidenceSources = evidenceSourceIds(item);
  const methodSources = methodSourceIds(item);
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
    source_ids: evidenceSources,
    evidence_source_ids: evidenceSources,
    method_source_ids: methodSources,
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
