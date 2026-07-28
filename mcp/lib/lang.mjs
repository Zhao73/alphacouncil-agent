export function normalizeLanguage(value) {
  const text = String(value || "").trim();
  if (!text || /^auto|default|same|follow|跟随|默认$/i.test(text)) return "";
  if (/^(zh|zh-cn|cn|chinese|中文|简体中文|繁体中文)$/i.test(text)) return "中文";
  if (/^(en|en-us|english|英文)$/i.test(text)) return "English";
  if (/^(ja|jp|ja-jp|japanese|日文|日本語)$/i.test(text)) return "日本語";
  if (/^(ko|kr|korean|韩文|韓文|한국어)$/i.test(text)) return "한국어";
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
