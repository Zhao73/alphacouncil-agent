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
      readFacts: (list) => `I read these facts: ${list}.`,
      noFacts: "I received none of the point-in-time facts my method reads.",
      computed: (list) => `I computed ${list}.`,
      hits: (n, total, list) => `I find ${n} of ${total} scoring conditions held: ${list}.`,
      misses: (list) => `I find these conditions did not hold: ${list}.`,
      noRules: "I could not evaluate a scoring condition on what was available.",
      veto: (list) => `I stop before scoring because this hard veto decided the case: ${list}.`,
      band: (stance, ratio) => `I place the score of ${ratio} in the ${stance} band.`,
      intent: (label) => `On this evidence I would: ${label}.`,
      changes: (list) => `I would change this reading if: ${list}.`,
      noChanges: "I have no stated condition that would move this within my method's rules.",
      disagree: "I am applying one method to frozen facts, not making a forecast. Where I differ from the analyst sections, the difference is my method's scope, not a correction of them.",
      declineWhat: (list) => `I require ${list}, and the point-in-time record did not carry ${list === "" ? "them" : "all of it"}.`,
      declineWhy: "I abstain instead of substituting a proxy, because a number I did not compute is not my method's answer.",
    },
    zh: {
      readFacts: (list) => `我读取的事实：${list}。`,
      noFacts: "我没有收到这个方法需要的任何时点一致事实。",
      computed: (list) => `我据此计算得到：${list}。`,
      hits: (n, total, list) => `我看到 ${total} 条评分条件中有 ${n} 条成立：${list}。`,
      misses: (list) => `我看到这些条件未成立：${list}。`,
      noRules: "我无法在可得资料上求值任何评分条件。",
      veto: (list) => `我在评分前就停下，因为这项硬否决已决定结果：${list}。`,
      band: (stance, ratio) => `我把得分 ${ratio} 归入「${stance}」档。`,
      intent: (label) => `基于这些证据，我会：${label}。`,
      changes: (list) => `如果出现以下情况，我会改变这一判断：${list}。`,
      noChanges: "在我这套方法的规则内，我没有已陈述的条件会改变这一判断。",
      disagree: "我是在冻结事实上运行一种方法，不是在预测。若我与分析师各席不同，分歧来自我的方法范围，而不是对他们作更正。",
      declineWhat: (list) => `我需要 ${list}，而时点一致的记录没有全部提供。`,
      declineWhy: "我选择弃权而不用替代值补位，因为我没有计算出来的数字不是我的答案。",
    },
    ja: {
      readFacts: (list) => `私が読んだ事実：${list}。`,
      noFacts: "私の手法が読む時点整合した事実は届きませんでした。",
      computed: (list) => `私はそこから算出しました：${list}。`,
      hits: (n, total, list) => `私は ${total} 件の採点条件のうち ${n} 件が成立したと読みます：${list}。`,
      misses: (list) => `私は次の条件が成立しなかったと読みます：${list}。`,
      noRules: "私は利用可能な資料で採点条件を評価できませんでした。",
      veto: (list) => `私は採点前に止まります。このハード拒否が決着させました：${list}。`,
      band: (stance, ratio) => `私はスコア ${ratio} を「${stance}」の帯に置きます。`,
      intent: (label) => `この証拠に基づき、私なら：${label}。`,
      changes: (list) => `次の場合、私は判断を変えます：${list}。`,
      noChanges: "私の手法自身の規則では、私の判断を動かす条件は示されていません。",
      disagree: "私は凍結された事実に一つの手法を適用しており、予測しているのではありません。分析担当と異なる箇所は私の手法の適用範囲によるもので、訂正ではありません。",
      declineWhat: (list) => `私は ${list} を必要としますが、時点整合した記録が揃いませんでした。`,
      declineWhy: "私は代替値で埋めず棄権します。私が計算していない数値は私の手法の答えではないからです。",
    },
    ko: {
      readFacts: (list) => `제가 읽은 사실: ${list}.`,
      noFacts: "제 방법이 읽는 시점 일치 사실을 받지 못했습니다.",
      computed: (list) => `저는 여기서 계산했습니다: ${list}.`,
      hits: (n, total, list) => `저는 채점 조건 ${total}개 중 ${n}개가 성립했다고 봅니다: ${list}.`,
      misses: (list) => `저는 다음 조건이 성립하지 않았다고 봅니다: ${list}.`,
      noRules: "저는 확보된 자료로 채점 조건을 평가할 수 없었습니다.",
      veto: (list) => `저는 채점 전에 멈춥니다. 이 하드 비토가 결정했습니다: ${list}.`,
      band: (stance, ratio) => `저는 점수 ${ratio}를 "${stance}" 구간에 둡니다.`,
      intent: (label) => `이 증거에서 저는: ${label}.`,
      changes: (list) => `다음의 경우 저는 판단을 바꿉니다: ${list}.`,
      noChanges: "제 방법의 규칙 안에서 제 판단을 움직일 조건은 제시되지 않았습니다.",
      disagree: "저는 동결된 사실에 하나의 방법을 적용하며 예측하는 것이 아닙니다. 애널리스트 좌석과 다르다면 그 차이는 제 방법의 범위에서 오며, 그들을 정정하는 것이 아닙니다.",
      declineWhat: (list) => `저는 ${list}이 필요하지만 시점 일치 기록이 이를 모두 담고 있지 않았습니다.`,
      declineWhy: "저는 대체값으로 메우지 않고 기권합니다. 제가 계산하지 않은 숫자는 제 방법의 답이 아니기 때문입니다.",
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
