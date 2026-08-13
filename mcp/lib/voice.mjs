/**
 * The reader-facing shape of a method seat's statement.
 *
 * A frozen stance plus a paragraph of machine diagnostics is technically complete and
 * practically useless: "master_buffett: no_required_fact_types_present" tells a reader that
 * something broke, not what the method concluded. This module defines the five things a
 * reader actually wants -- what the method saw, how its own standard reads that, whether it
 * would act, what would change it, and where it disagrees with the room -- and the vocabulary
 * for the one field that expresses intent.
 *
 * The stance stays frozen and deterministic. Intent is a NARROWING of the stance, never a
 * second vote: each stance admits only intents that mean the same thing, so a worker can pick
 * the honest shade without being able to convert an `opposed` into a `would_buy`.
 */

import { localized } from "./lang.mjs";

export const FIRST_PERSON_VOICE_MODE = "first_person_public_method_simulation_v1";
export const FIRST_PERSON_DISCLOSURE_ACK = "alphacouncil.first_person_public_method_simulation.v1";

export const POSITION_INTENTS = Object.freeze([
  "would_buy",
  "would_add",
  "would_hold",
  "would_watch",
  "would_pass",
  "would_avoid",
  "not_in_my_circle",
]);

/**
 * Which intents each frozen stance admits. Enforced server-side on the way in, exactly like
 * the acknowledged-stance check, so a persuasive narrative cannot widen its own mandate.
 */
const INTENTS_BY_STANCE = Object.freeze({
  constructive: Object.freeze(["would_buy", "would_add"]),
  cautious: Object.freeze(["would_hold", "would_watch"]),
  opposed: Object.freeze(["would_pass", "would_avoid"]),
  // A withheld vote has two different causes and a reader needs to tell them apart.
  // `not_in_my_circle` is a judgment the method itself makes -- an index lens looking at one
  // operating company, a country lens looking outside its geography -- and it stays true no
  // matter how much more data arrives. `inputs_unavailable` is the opposite: the method applies
  // squarely to this company, but a fact it requires was never produced, so the vote waits on
  // the pipeline rather than on the company. Reporting the second as the first told readers a
  // valuation lens found a semiconductor company outside its circle, which is simply untrue.
  out_of_scope: Object.freeze(["not_in_my_circle", "inputs_unavailable"]),
});

export function intentsForStance(stance) {
  return INTENTS_BY_STANCE[String(stance || "")] || INTENTS_BY_STANCE.out_of_scope;
}

export function defaultIntentForStance(stance) {
  return intentsForStance(stance)[0];
}

/** Eligibility-gate reasons: the method fits, but a fact it requires was never produced. */
const INPUT_GAP_REASONS = new Set(["no_required_fact_types_present", "missing_required_fact_types"]);

/**
 * The intent a withheld vote should carry, given WHY it was withheld.
 *
 * An eligibility gate that never opened is a pipeline gap, not a verdict about the company.
 * Defaulting those to `not_in_my_circle` published a valuation lens declaring a semiconductor
 * company outside its circle, when the truth was that two company-level DCF facts are not
 * produced by any tool yet. A score band or an explicit method judgment keeps the circle
 * language, because there the method really did look and rule itself out.
 */
export function withheldVoteIntent(reason) {
  return INPUT_GAP_REASONS.has(String(reason || "")) ? "inputs_unavailable" : "not_in_my_circle";
}

export function isIntentAllowed(intent, stance) {
  return intentsForStance(stance).includes(String(intent || ""));
}

/** The five reader-facing fields, in the order a reader wants them. */
export const VOICE_FIELDS = Object.freeze([
  "would_i_act",
  "what_i_see",
  "how_my_method_reads_it",
  "where_i_disagree",
  "what_changes_my_mind",
]);

const FIELD_LABELS = Object.freeze({
  what_i_see: { en: "What I see", zh: "我看到的", ja: "私が見ているもの", ko: "내가 보는 것" },
  how_my_method_reads_it: {
    en: "How my standard reads it", zh: "用我的标准怎么看", ja: "私の基準での読み方", ko: "내 기준으로 본 해석",
  },
  would_i_act: { en: "Would I act", zh: "我会不会动手", ja: "私なら動くか", ko: "나라면 움직이는가" },
  what_changes_my_mind: {
    en: "What would change my mind", zh: "什么会让我改主意", ja: "何があれば考えを変えるか", ko: "무엇이 내 생각을 바꾸는가",
  },
  where_i_disagree: { en: "Where I disagree", zh: "我和谁分歧", ja: "どこで意見が分かれるか", ko: "어디서 의견이 갈리는가" },
});

export function voiceFieldLabel(field, language) {
  return localized(language, FIELD_LABELS[field] || {}) || field;
}

const INTENT_LABELS = Object.freeze({
  would_buy: { en: "would buy", zh: "会买", ja: "買う", ko: "매수한다" },
  would_add: { en: "would add", zh: "会加仓", ja: "買い増す", ko: "추가 매수한다" },
  would_hold: { en: "would hold", zh: "会持有", ja: "保有する", ko: "보유한다" },
  would_watch: { en: "would watch", zh: "会观望", ja: "様子を見る", ko: "지켜본다" },
  would_pass: { en: "would pass", zh: "会放弃", ja: "見送る", ko: "보류한다" },
  would_avoid: { en: "would avoid", zh: "会回避", ja: "回避する", ko: "회피한다" },
  not_in_my_circle: {
    en: "outside my circle of competence",
    zh: "在我的能力圈之外",
    ja: "私の能力の輪の外",
    ko: "내 능력 범위 밖",
  },
});

export function intentLabel(intent, language) {
  return localized(language, INTENT_LABELS[intent] || {}) || intent;
}

/**
 * The disclaimer that must accompany first-person method prose.
 *
 * First person is what makes the output readable, and it is also exactly what could be
 * mistaken for a quotation. The wording is deliberate: it describes what the METHOD concludes,
 * and never asserts what the living person currently thinks.
 */
export const VOICE_DISCLOSURES = Object.freeze({
  en: "AI public-method simulation — not the named person's words.",
  zh: "AI 公开方法模拟，非本人原话。",
  ja: "AIによる公開メソッドのシミュレーションであり、本人の発言ではありません。",
  ko: "AI 공개 방법론 시뮬레이션이며 본인의 실제 발언이 아닙니다.",
});

export function voiceDisclaimer(language) {
  return localized(language, VOICE_DISCLOSURES);
}

/**
 * A method voice is first-person in every reader-facing field, not merely under a
 * first-person heading. This is intentionally a small lexical gate: style fidelity is
 * evaluated elsewhere, while this function prevents a worker from silently falling back
 * to "Buffett would..." or another neutral third-person summary.
 */
export function hasFirstPersonMarker(value, language) {
  const text = String(value || "");
  const key = String(language || "").toLowerCase();
  if (/中文|chinese|zh/u.test(key)) return /我/u.test(text);
  if (/日本語|japanese|ja/u.test(key)) return /私/u.test(text);
  if (/한국어|korean|ko/u.test(key)) return /(?:나|내|저|제)/u.test(text);
  return /\b(?:I|I'm|I've|I'd|I'll|me|my|mine|myself)\b/iu.test(text);
}

export function hasAnyFirstPersonMarker(value) {
  return hasFirstPersonMarker(value, "English")
    || hasFirstPersonMarker(value, "中文")
    || hasFirstPersonMarker(value, "日本語")
    || hasFirstPersonMarker(value, "한국어");
}

/**
 * Compose the five fields into one continuous statement for surfaces that carry a single
 * line per seat. Empty fields are dropped rather than rendered as an empty heading.
 */
export function composeVoiceStatement(voice, language) {
  if (!voice || typeof voice !== "object") return "";
  return VOICE_FIELDS
    .map((field) => [field, String(voice[field] ?? "").trim()])
    .filter(([, text]) => text.length > 0)
    .map(([field, text]) => `${voiceFieldLabel(field, language)}: ${text}`)
    .join(" ");
}
