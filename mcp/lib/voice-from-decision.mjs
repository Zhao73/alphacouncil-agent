/**
 * The five-field voice, composed from the frozen decision rather than written about it.
 *
 * A seat that computed a real verdict from real facts was reporting it in one sentence, and a
 * reader could not see what it had looked at. The five fields existed and nothing filled them.
 *
 * The deterministic record already holds everything they need: which facts were read and what
 * they were, which tools ran and what they produced, which scoring rules hit and missed, which
 * vetoes fired, the band the score landed in, and the conditions that would move it. Composing
 * the fields FROM that record has a property that asking a model to restate a sentence does
 * not: the explanation cannot drift from the verdict, because it is derived from it. If the
 * text says a rule missed, the rule missed.
 *
 * Nothing here is a claim about a named person. It is a rendering of arithmetic the seat's own
 * policy performed, in the report's language.
 */

import { localized } from "./lang.mjs";
import { defaultIntentForStance } from "./voice.mjs";

const MAX_ITEMS = 4;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Numbers a reader can scan: decimals stay short, big money keeps its magnitude. */
export function readableValue(fact) {
  const value = fact?.value;
  if (!finite(value)) return String(value ?? "—");
  if (fact.unit === "decimal" && Math.abs(value) < 10) return `${(value * 100).toFixed(1)}%`;
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  return Number(value.toFixed(4)).toString();
}

/** Every fact id a condition reads, in the order it reads them. */
export function factsInCondition(node, into = []) {
  if (!node || typeof node !== "object") return into;
  if (typeof node.fact_id === "string") into.push(node.fact_id);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((entry) => factsInCondition(entry, into));
    else if (value && typeof value === "object") factsInCondition(value, into);
  }
  return into;
}

function copyFor(language) {
  return localized(language, {
    en: {
      readFacts: (list) => `Facts this method read: ${list}.`,
      noFacts: "The point-in-time record supplied none of the facts this method reads.",
      computed: (list) => `It computed ${list}.`,
      hits: (n, total, list) => `${n} of ${total} scoring conditions held: ${list}.`,
      misses: (list) => `Conditions that did not hold: ${list}.`,
      noRules: "No scoring condition could be evaluated on what was available.",
      veto: (list) => `A hard veto decided this before scoring: ${list}.`,
      band: (stance, ratio) => `The score of ${ratio} places it in the ${stance} band.`,
      intent: (label) => `On this evidence the method's position is: ${label}.`,
      changes: (list) => `This changes if: ${list}.`,
      noChanges: "No stated condition would move this within the method's own rules.",
      disagree: "This is a single method run on frozen facts. It is not a forecast, and where it differs from the analyst sections the difference is the method's scope, not a correction of them.",
      declineWhat: (list) => `This method requires ${list}, and the point-in-time record did not carry ${list === "" ? "them" : "all of it"}.`,
      declineWhy: "It abstains rather than substituting a proxy, because a number the method did not compute is not the method's answer.",
    },
    zh: {
      readFacts: (list) => `本方法读取的事实：${list}。`,
      noFacts: "时点一致的记录没有提供本方法需要的任何事实。",
      computed: (list) => `据此计算得到：${list}。`,
      hits: (n, total, list) => `${total} 条评分条件中有 ${n} 条成立：${list}。`,
      misses: (list) => `未成立的条件：${list}。`,
      noRules: "在可得资料上没有任何评分条件能够求值。",
      veto: (list) => `在评分之前已由硬否决决定：${list}。`,
      band: (stance, ratio) => `得分 ${ratio}，落在「${stance}」档。`,
      intent: (label) => `基于这些证据，本方法的立场是：${label}。`,
      changes: (list) => `以下情况会改变这一判断：${list}。`,
      noChanges: "在本方法自身的规则内，没有任何已陈述的条件会改变它。",
      disagree: "这是一次在冻结事实上运行的单一方法，不是预测。与分析师各席的差异来自方法的适用范围，不构成对他们的更正。",
      declineWhat: (list) => `本方法需要 ${list}，而时点一致的记录没有全部提供。`,
      declineWhy: "它选择弃权而不是用替代值补位，因为方法没有计算出来的数字不是方法的答案。",
    },
    ja: {
      readFacts: (list) => `この手法が読んだ事実：${list}。`,
      noFacts: "時点整合した記録に、この手法が読む事実はありませんでした。",
      computed: (list) => `そこから算出：${list}。`,
      hits: (n, total, list) => `${total} 件の採点条件のうち ${n} 件が成立：${list}。`,
      misses: (list) => `成立しなかった条件：${list}。`,
      noRules: "利用可能な資料では採点条件を評価できませんでした。",
      veto: (list) => `採点の前にハード拒否で決着：${list}。`,
      band: (stance, ratio) => `スコア ${ratio}、「${stance}」の帯に入ります。`,
      intent: (label) => `この証拠に基づく手法の立場：${label}。`,
      changes: (list) => `次の場合に判断は変わります：${list}。`,
      noChanges: "手法自身の規則の範囲では、判断を動かす条件は示されていません。",
      disagree: "凍結された事実に対する単一手法の実行であり、予測ではありません。アナリスト各席との差異は手法の適用範囲によるもので、訂正ではありません。",
      declineWhat: (list) => `この手法は ${list} を必要としますが、時点整合した記録が揃いませんでした。`,
      declineWhy: "代替値で埋めず棄権します。手法が計算していない数値は手法の答えではないからです。",
    },
    ko: {
      readFacts: (list) => `이 방법이 읽은 사실: ${list}.`,
      noFacts: "시점이 일치하는 기록에 이 방법이 읽는 사실이 없었습니다.",
      computed: (list) => `이로부터 산출: ${list}.`,
      hits: (n, total, list) => `채점 조건 ${total}개 중 ${n}개 성립: ${list}.`,
      misses: (list) => `성립하지 않은 조건: ${list}.`,
      noRules: "확보된 자료로는 어떤 채점 조건도 평가할 수 없었습니다.",
      veto: (list) => `채점 전에 하드 비토로 결정됨: ${list}.`,
      band: (stance, ratio) => `점수 ${ratio}, "${stance}" 구간에 해당합니다.`,
      intent: (label) => `이 증거에서 이 방법의 입장: ${label}.`,
      changes: (list) => `다음의 경우 판단이 바뀝니다: ${list}.`,
      noChanges: "방법 자체의 규칙 안에서 판단을 움직일 조건은 제시되지 않았습니다.",
      disagree: "동결된 사실에 대한 단일 방법 실행이며 예측이 아닙니다. 애널리스트 좌석과의 차이는 방법의 적용 범위 차이이지 정정이 아닙니다.",
      declineWhat: (list) => `이 방법은 ${list}이 필요하지만 시점 일치 기록이 이를 모두 담고 있지 않았습니다.`,
      declineWhy: "대체값으로 메우지 않고 기권합니다. 방법이 계산하지 않은 숫자는 방법의 답이 아니기 때문입니다.",
    },
  });
}

/**
 * Compose the five fields for a seat that reached a stance.
 *
 * `result` is the frozen `structured_decision.result`; `policy` is the seat's decision policy,
 * which supplies the human-readable condition ids the result refers to by index.
 * `readableIds` maps each anonymised id back to the declared one exactly; prefer it over the
 * positional fallback, which assumes the executor's hits/misses/uncomputable split happens to
 * come back in declaration order and silently swaps two condition names when it does not.
 */
export function voiceFromDecision({ result, policy, factPack, readableIds, language = "English" } = {}) {
  const copy = copyFor(language);
  const facts = new Map((factPack?.facts || []).map((fact) => [fact.fact_id, fact]));
  const stance = result?.common_projection?.stance || "out_of_scope";

  const readIds = [...new Set([
    ...(policy?.scoring?.rules || []).flatMap((rule) => factsInCondition(rule.condition)),
    ...(policy?.hard_vetoes || []).flatMap((veto) => factsInCondition(veto.condition)),
    ...(policy?.eligibility?.all || []).flatMap((check) => factsInCondition(check.condition)),
  ])].filter((id) => facts.has(id));
  const readList = readIds.slice(0, MAX_ITEMS)
    .map((id) => `${id} = ${readableValue(facts.get(id))}`).join("; ");

  const computed = (result?.computations?.trace || [])
    .filter((step) => step.status === "computed" && finite(step.value))
    .slice(0, MAX_ITEMS)
    .map((step) => `${readableIds?.get?.(step.output_id) || step.output_id} = ${Number(step.value.toFixed(4))}`)
    .join("; ");

  // The executor publishes the rules it evaluated already split into hits, misses and the ones
  // it could not compute. Reading its own split rather than re-deriving one is what keeps this
  // text unable to disagree with the verdict it describes.
  const scoring = result?.score || {};
  const hits = scoring.hits || [];
  const misses = scoring.misses || [];
  const uncomputable = scoring.uncomputable || [];
  const evaluated = [...hits, ...misses, ...uncomputable];
  // The runtime anonymises rule ids so the decision layer cannot recognise the seat. A reader
  // is not the decision layer: map each anonymous id back to the readable name in the seat's
  // own policy, which lists its rules in the same order the executor evaluated them.
  const readableRuleIds = new Map((policy?.scoring?.rules || [])
    .map((rule, index) => [index, rule.rule_id])
    .filter(([, id]) => typeof id === "string"));
  const anonOrder = new Map(evaluated
    .map((rule) => rule.rule_id)
    .filter(Boolean)
    .map((id, index) => [id, index]));
  const declaredName = (anon) => (anon && readableIds?.get?.(anon)) || null;
  const ruleName = (rule) => {
    const anon = rule.rule_id || rule.id;
    return declaredName(anon) || readableRuleIds.get(anonOrder.get(anon)) || anon || "rule";
  };

  // Vetoes went unmapped, so a hashed veto reached the reader while the scoring conditions
  // beside it were readable. That asymmetry is what made two seats speculate about their own
  // hard veto instead of naming it.
  const vetoes = (result?.vetoes_triggered || [])
    .map((veto) => declaredName(veto.veto_id) || veto.veto_id)
    .filter(Boolean);

  const whatISee = [
    readList ? copy.readFacts(readList) : copy.noFacts,
    computed ? copy.computed(computed) : "",
  ].filter(Boolean).join(" ");

  const howItReads = [
    vetoes.length ? copy.veto(vetoes.join("; ")) : "",
    evaluated.length
      ? copy.hits(hits.length, evaluated.length, hits.map(ruleName).join("; ") || "—")
      : copy.noRules,
    misses.length ? copy.misses(misses.map(ruleName).join("; ")) : "",
    finite(result?.common_projection?.score_ratio)
      ? copy.band(stance, Number(result.common_projection.score_ratio.toFixed(3)))
      : "",
  ].filter(Boolean).join(" ");

  const changes = [
    ...misses.map(ruleName),
    ...uncomputable.map(ruleName),
    ...vetoes,
  ].slice(0, MAX_ITEMS);

  return {
    what_i_see: whatISee,
    how_my_method_reads_it: howItReads,
    would_i_act: copy.intent(defaultIntentForStance(stance)),
    what_changes_my_mind: changes.length ? copy.changes(changes.join("; ")) : copy.noChanges,
    where_i_disagree: copy.disagree,
  };
}

/** The same five fields for a seat that could not run, so an abstention is also readable. */
export function voiceFromDecline({ eligibility, language = "English" } = {}) {
  const copy = copyFor(language);
  const missing = (eligibility?.missing_required_fact_types || []).slice(0, MAX_ITEMS).join("; ");
  const present = (eligibility?.present_required_fact_types || []).slice(0, MAX_ITEMS).join("; ");
  return {
    what_i_see: present ? copy.readFacts(present) : copy.noFacts,
    how_my_method_reads_it: copy.declineWhat(missing),
    would_i_act: copy.intent(defaultIntentForStance("out_of_scope")),
    what_changes_my_mind: missing ? copy.changes(missing) : copy.noChanges,
    where_i_disagree: copy.declineWhy,
  };
}
