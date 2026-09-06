export const RESEARCH_LANGUAGES = Object.freeze([
  { locale: "zh-CN", key: "zh", name: "中文", aliases: ["zh", "cn", "chinese", "简体中文", "繁体中文"] },
  { locale: "en", key: "en", name: "English", aliases: ["en-US", "英文"] },
  { locale: "ja", key: "ja", name: "日本語", aliases: ["jp", "ja-JP", "japanese", "日文"] },
  { locale: "ko", key: "ko", name: "한국어", aliases: ["kr", "ko-KR", "korean", "韩文", "韓文"] },
  { locale: "es", key: "es", name: "Español", aliases: ["es-ES", "spanish", "西班牙语"] },
  { locale: "fr", key: "fr", name: "Français", aliases: ["fr-FR", "french", "法语"] },
  { locale: "de", key: "de", name: "Deutsch", aliases: ["de-DE", "german", "德语"] },
  { locale: "pt-BR", key: "pt-BR", name: "Português (Brasil)", aliases: ["pt", "português", "portuguese", "brazilian portuguese", "葡萄牙语"] },
  { locale: "it", key: "it", name: "Italiano", aliases: ["it-IT", "italian", "意大利语"] },
  { locale: "ru", key: "ru", name: "Русский", aliases: ["ru-RU", "russian", "俄语"] },
  { locale: "vi", key: "vi", name: "Tiếng Việt", aliases: ["vi-VN", "vietnamese", "越南语"] },
  { locale: "id", key: "id", name: "Bahasa Indonesia", aliases: ["id-ID", "indonesian", "印尼语"] },
].map((entry) => Object.freeze({ ...entry, aliases: Object.freeze(entry.aliases) })));

export function researchLanguage(value) {
  const text = String(value || "").trim().toLowerCase();
  return RESEARCH_LANGUAGES.find((entry) => [entry.locale, entry.key, entry.name, ...entry.aliases]
    .some((alias) => alias.toLowerCase() === text)) || null;
}

export function normalizeLanguage(value) {
  const text = String(value || "").trim();
  if (!text || /^(?:auto|default|same|follow|跟随|默认)$/i.test(text)) return "";
  return researchLanguage(text)?.name || text.slice(0, 40);
}

export function inferLanguage(text = "") {
  if (/[\u3040-\u30ff]/.test(text)) return "日本語";
  if (/[\uac00-\ud7af]/.test(text)) return "한국어";
  if (/[\u3400-\u9fff]/.test(text)) return "中文";
  if (/\p{Script=Cyrillic}/u.test(text)) return "Русский";
  const latin = latinLanguageEvidence(text);
  if (latin.locale) return researchLanguage(latin.locale).name;
  return "English";
}

export function resolveLanguage(args = {}) {
  return normalizeLanguage(args.language || args.output_language || args.user_language) || inferLanguage(args.prompt || args.user_prompt || "");
}

export function isChineseLanguage(language) {
  return /中文|chinese|zh/i.test(String(language || ""));
}

export function languageKey(language) {
  return researchLanguage(language)?.key || "en";
}

export function localized(language, messages) {
  const key = languageKey(language);
  return messages?.[key] ?? messages?.en ?? "";
}

const RESEARCH_LANGUAGE_INSTRUCTIONS = Object.freeze({
  es: "IDIOMA OBLIGATORIO: escribe en español todo el análisis, las explicaciones del método, los argumentos del debate, los resúmenes y el informe final. En cada campo de voz del método usa explícitamente yo, mi o mis. Conserva sin traducir las claves JSON, enumeraciones, identificadores, cifras, fórmulas y citas originales; explica las citas en español. El idioma de las fuentes o de las instrucciones técnicas no cambia el idioma de salida.",
  fr: "LANGUE OBLIGATOIRE : rédige en français toute l’analyse, les explications de méthode, le débat, les résumés et le rapport final. Dans chaque champ de voix de méthode, utilise explicitement je, mon ou mes. Ne traduis pas les clés JSON, énumérations, identifiants, chiffres, formules et citations originales ; explique les citations en français. La langue des sources ou des consignes techniques ne change pas la langue de sortie.",
  de: "VERBINDLICHE SPRACHE: Schreibe sämtliche Analysen, Methodenerklärungen, Debattenbeiträge, Zusammenfassungen und den Abschlussbericht auf Deutsch. Verwende in jedem Methodenfeld ausdrücklich ich, mein oder meine. JSON-Schlüssel, Enumerationen, Kennungen, Zahlen, Formeln und Originalzitate bleiben unverändert; erläutere Zitate auf Deutsch. Die Sprache der Quellen oder technischen Anweisungen ändert die Ausgabesprache nicht.",
  "pt-BR": "IDIOMA OBRIGATÓRIO: escreva toda a análise, as explicações dos métodos, os argumentos do debate, os resumos e o relatório final em português do Brasil. Em cada campo de voz do método, use explicitamente eu, meu ou minha. Preserve as chaves JSON, enumerações, identificadores, números, fórmulas e citações originais; explique as citações em português. O idioma das fontes ou das instruções técnicas não altera o idioma da resposta.",
  it: "LINGUA OBBLIGATORIA: scrivi in italiano tutte le analisi, le spiegazioni dei metodi, gli argomenti del dibattito, i riepiloghi e il rapporto finale. In ogni campo della voce del metodo usa esplicitamente io, mio o mia. Mantieni invariati chiavi JSON, enumerazioni, identificatori, numeri, formule e citazioni originali; spiega le citazioni in italiano. La lingua delle fonti o delle istruzioni tecniche non modifica la lingua della risposta.",
  ru: "ОБЯЗАТЕЛЬНЫЙ ЯЗЫК: пиши весь анализ, объяснения методов, аргументы обсуждения, резюме и итоговый отчёт на русском языке. В каждом поле метода явно используй я, мой или моя. Сохраняй ключи JSON, перечисления, идентификаторы, числа, формулы и исходные цитаты; поясняй цитаты по-русски. Язык источников и технических инструкций не меняет язык ответа.",
  vi: "NGÔN NGỮ BẮT BUỘC: viết toàn bộ phân tích, giải thích phương pháp, lập luận tranh luận, tóm tắt và báo cáo cuối cùng bằng tiếng Việt. Mỗi trường lời giải thích phương pháp phải có từ tôi hoặc của tôi. Giữ nguyên khóa JSON, giá trị liệt kê, mã định danh, số liệu, công thức và trích dẫn gốc; giải thích trích dẫn bằng tiếng Việt. Ngôn ngữ nguồn hoặc hướng dẫn kỹ thuật không thay đổi ngôn ngữ đầu ra.",
  id: "BAHASA WAJIB: tulis seluruh analisis, penjelasan metode, argumen debat, ringkasan, dan laporan akhir dalam bahasa Indonesia. Gunakan saya atau menurut saya secara eksplisit dalam setiap kolom penjelasan metode. Pertahankan kunci JSON, enumerasi, pengenal, angka, rumus, dan kutipan asli; jelaskan kutipan dalam bahasa Indonesia. Bahasa sumber atau petunjuk teknis tidak mengubah bahasa keluaran.",
});

export function researchLanguageInstruction(language) {
  return RESEARCH_LANGUAGE_INSTRUCTIONS[languageKey(language)] || "";
}

const count = (value, pattern) => (value.match(pattern) || []).length;

const LATIN_LANGUAGE_WORDS = Object.freeze({
  en: "the and this that with from which would should because evidence company shares risks a an is are was were have has been for only not usable recorded available these those our their its without no",
  es: "el la lo que un una de se su sus por para como con no al más también sido son está están fue registrado datos información disponible decisión decisiones terminó hubo produjo análisis registrada yo mi mis nosotros nuestro una los las del pero porque según también empresa acciones riesgos ingresos fuentes análisis invertir veo considero",
  fr: "le la de du et est sont un ce se au aux par pas dans été aucun aucune enregistré disponible données je moi mon mes nous notre les des une cette mais avec pour dans selon entreprise actions risques revenus sources analyse investir vois considère",
  de: "ist sind wurde wurden kein keine keinen nicht eine mit von zu zur im am auf als bei weitere verfügbar ich mein meine wir unser der die das den dem und ein eine nicht mit für weil unternehmen aktien risiken umsatz quellen analyse investieren sehe",
  "pt-BR": "o a de do da que se um uma por como foi foram são está estão há sem dados disponível registrado decisão decisões terminou nenhuma produziu análise registrada eu meu minha meus nós nosso uma os as dos das não mas com para porque também empresa ações riscos receita fontes análise investir vejo considero",
  it: "il la lo che un uno di da del è sono è stato stati si nessun nessuna disponibile registrato dati io mio mia miei noi nostro gli dei delle una questa non ma con per perché anche azienda azioni rischi ricavi fonti analisi investire vedo considero",
  vi: "có đã được để thêm các cho trong hoặc chưa từ khi phải ghi nhận dùng gói bằng chứng tôi chúng của và là này một không nhưng với cho vì doanh nghiệp cổ phiếu rủi ro nguồn dữ liệu phân tích thấy",
  id: "ada sudah telah belum dapat dari pada dalam atau bukan adalah tersedia tercatat tambahan saya kami kita menurut dan yang ini itu tidak tetapi dengan untuk karena perusahaan saham risiko pendapatan sumber analisis melihat menilai",
});

function latinLanguageEvidence(value) {
  const words = new Set(String(value || "").normalize("NFC").toLowerCase().match(/\p{Script=Latin}+/gu) || []);
  const scores = Object.entries(LATIN_LANGUAGE_WORDS).map(([locale, vocabulary]) => ({
    locale,
    score: [...new Set(vocabulary.split(" "))].filter((word) => words.has(word)).length,
  })).sort((a, b) => b.score - a.score);
  const best = scores[0];
  return {
    locale: best.score >= 2 && best.score > scores[1].score ? best.locale : null,
    scores: Object.fromEntries(scores.map((entry) => [entry.locale, entry.score])),
  };
}

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
    latin: count(value, /\p{Script=Latin}/gu),
    han: count(value, /\p{Script=Han}/gu),
    kana: count(value, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu),
    hangul: count(value, /\p{Script=Hangul}/gu),
    cyrillic: count(value, /\p{Script=Cyrillic}/gu),
  };
  const scriptCharacters = Object.values(scripts).reduce((sum, hits) => sum + hits, 0);
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
  const latinEvidence = latinLanguageEvidence(value);
  if (scripts.hangul >= 2 && ratios.hangul >= 0.2) observed = "ko";
  else if ((scripts.kana >= 2 && (scripts.kana / Math.max(1, scripts.kana + scripts.han)) >= 0.03) || japaneseMarkers >= 2) observed = "ja";
  else if (scripts.cyrillic >= 4 && ratios.cyrillic >= 0.6) observed = "ru";
  else if (scripts.latin >= 12 && ratios.latin >= 0.6) observed = latinEvidence.locale || (["en", "zh", "ja", "ko"].includes(requested) && englishWords >= 3 ? "en" : "undetermined");
  else if (scripts.han >= 4 && scripts.kana === 0 && scripts.hangul === 0 && ratios.han >= 0.6) {
    observed = chineseMarkers > 0 ? "zh" : "shared_han";
  }

  const targets = {
    en: scripts.latin,
    zh: scripts.han,
    ja: scripts.kana + japaneseMarkers,
    ko: scripts.hangul,
    ru: scripts.cyrillic,
    ...Object.fromEntries(["es", "fr", "de", "pt-BR", "it", "vi", "id"].map((key) => [key, scripts.latin])),
  };
  const target = targets[requested] || 0;
  const targetRatio = {
    en: ratios.latin,
    zh: ratios.han,
    ja: scriptCharacters ? (scripts.kana + Math.min(scripts.han, japaneseMarkers * 4)) / scriptCharacters : 0,
    ko: ratios.hangul,
    ru: ratios.cyrillic,
    ...Object.fromEntries(["es", "fr", "de", "pt-BR", "it", "vi", "id"].map((key) => [key, ratios.latin])),
  }[requested] || 0;
  const positive = {
    en: observed === "en",
    zh: observed === "zh" && japaneseMarkers < 2,
    ja: observed === "ja",
    ko: observed === "ko",
    ...Object.fromEntries(["es", "fr", "de", "pt-BR", "it", "ru", "vi", "id"].map((key) => [key, observed === key])),
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
    lexical_evidence: latinEvidence.scores,
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
