export function normalizeLanguage(value) {
  const text = String(value || "").trim();
  if (!text || /^(?:auto|default|same|follow|跟随|默认)$/i.test(text)) return "";
  if (/^(zh|zh-cn|cn|chinese|中文|简体中文|繁体中文)$/i.test(text)) return "中文";
  if (/^(en|en-us|english|英文)$/i.test(text)) return "English";
  if (/^(ja|jp|ja-jp|japanese|日文|日本語)$/i.test(text)) return "日本語";
  if (/^(ko|kr|ko-kr|korean|韩文|韓文|한국어)$/i.test(text)) return "한국어";
  return text.slice(0, 40);
}

export function inferLanguage(text = "") {
  if (/[\u3040-\u30ff]/.test(text)) return "日本語";
  if (/[\uac00-\ud7af]/.test(text)) return "한국어";
  if (/[\u3400-\u9fff]/.test(text)) return "中文";
  return "English";
}

export function resolveLanguage(args = {}) {
  return normalizeLanguage(args.language || args.output_language || args.user_language) || inferLanguage(args.prompt || args.user_prompt || "");
}

export function isChineseLanguage(language) {
  return /中文|chinese|zh/i.test(String(language || ""));
}

export function languageKey(language) {
  const text = String(language || "");
  if (/中文|chinese|zh/i.test(text)) return "zh";
  if (/日本語|japanese|ja/i.test(text)) return "ja";
  if (/한국어|korean|ko/i.test(text)) return "ko";
  return "en";
}

export function localized(language, messages) {
  const key = languageKey(language);
  return messages?.[key] ?? messages?.en ?? "";
}

const count = (value, pattern) => (value.match(pattern) || []).length;

/**
 * Detect reader prose without pretending that Han characters alone distinguish
 * Chinese from Japanese. URLs, stable ids, tickers and JSON keys are removed first.
 * The result is deliberately tri-state: an all-Han fragment can be shared_script,
 * while a whole report or worker packet must still provide positive target-language
 * evidence before it is accepted.
 */
export function readerLanguageStatus(text, language, { minimumTargetCharacters = 4, minimumRatio = 0.08 } = {}) {
  const requested = languageKey(language);
  const value = String(text || "").replace(
    /https?:\/\/\S+|`[^`]+`|\b[a-z]+(?:_[a-z0-9]+)+\b|\b[A-Z0-9_:-]{3,}\b/gu,
    "",
  );
  const scripts = {
    latin: count(value, /[A-Za-z]/gu),
    han: count(value, /\p{Script=Han}/gu),
    kana: count(value, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu),
    hangul: count(value, /\p{Script=Hangul}/gu),
  };
  const scriptCharacters = scripts.latin + scripts.han + scripts.kana + scripts.hangul;
  const englishWords = count(value, /\b[A-Za-z][A-Za-z'-]{1,}\b/gu);
  // Strong Japanese orthography covers legitimate finance fragments that contain
  // only Kanji, such as "売上高100億円、営業利益20億円。".
  const japaneseMarkers = count(
    value,
    /売上高|営業利益|経常利益|前年同期|億円|兆円|株価|一株当たり|見通し|割安|割高/gu,
  );
  // zh-CN needs positive Chinese evidence rather than treating every Han-only
  // fragment as Chinese. The character set intentionally uses simplified forms;
  // common Chinese function words also cover natural traditional-Chinese prose.
  const chineseMarkers = count(
    value,
    /[这们为与后发资价长净现应从过还将对门间时来买卖稳处务审计报损证据实认风险经营让给开关币额节把已核验断确录场环恶状况财变达点则无并区进增论结师话量闻值仓催剂数议项标属声说]|的|了|是|在|和|以及|因此|但是|如果|本轮|本节|未知|不可用/gu,
  );
  const ratios = Object.fromEntries(Object.entries(scripts).map(([key, hits]) => [
    key,
    scriptCharacters ? hits / scriptCharacters : 0,
  ]));

  let observed = "undetermined";
  if (scripts.hangul >= 2 && ratios.hangul >= 0.2) observed = "ko";
  else if ((scripts.kana >= 2 && (scripts.kana / Math.max(1, scripts.kana + scripts.han)) >= 0.03) || japaneseMarkers >= 2) observed = "ja";
  else if (scripts.latin >= 12 && englishWords >= 3 && ratios.latin >= 0.6) observed = "en";
  else if (scripts.han >= 4 && scripts.kana === 0 && scripts.hangul === 0 && ratios.han >= 0.6) {
    observed = chineseMarkers > 0 ? "zh" : "shared_han";
  }

  const targets = {
    en: scripts.latin,
    zh: scripts.han,
    ja: scripts.kana + japaneseMarkers,
    ko: scripts.hangul,
  };
  const target = targets[requested] || 0;
  const targetRatio = {
    en: ratios.latin,
    zh: ratios.han,
    ja: scriptCharacters ? (scripts.kana + Math.min(scripts.han, japaneseMarkers * 4)) / scriptCharacters : 0,
    ko: ratios.hangul,
  }[requested] || 0;
  const positive = {
    en: observed === "en",
    zh: observed === "zh" && japaneseMarkers < 2,
    ja: observed === "ja",
    ko: observed === "ko",
  }[requested] === true;
  const enough = requested === "en"
    ? scripts.latin >= Math.max(12, minimumTargetCharacters) && englishWords >= 3 && targetRatio >= Math.max(0.6, minimumRatio)
    : target >= minimumTargetCharacters && targetRatio >= minimumRatio;
  return {
    status: positive && enough ? "passed" : "failed",
    requested_locale: requested,
    observed_locale: observed,
    target_characters: target,
    reader_characters: scriptCharacters,
    ratio: targetRatio,
    scripts,
    english_words: englishWords,
    japanese_markers: japaneseMarkers,
    chinese_markers: chineseMarkers,
  };
}

export function assertReaderLanguage(text, language, label = "worker output") {
  const result = readerLanguageStatus(text, language);
  if (result.status === "passed") return result;
  const error = new Error(`${label} reader language mismatch: requested=${result.requested_locale}; target_characters=${result.target_characters}; ratio=${result.ratio}`);
  error.code = "READER_LANGUAGE_MISMATCH";
  error.data = result;
  throw error;
}
