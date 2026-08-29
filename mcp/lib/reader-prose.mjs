const NAMED_HTML_ENTITIES = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  hyphen: "-",
  lt: "<",
  nbsp: " ",
  quot: '"',
});

const PROTECTED_RATING_AUTHORITY = Object.freeze([
  Object.freeze({
    heading: "服务端校验的评级依据",
    authority: "以下字段已经过服务端契约校验；若后续模型撰写正文与之冲突，以本节为准，冲突正文不具权威性。",
  }),
  Object.freeze({
    heading: "Server-Validated Rating Basis",
    authority: "These fields passed the server contract. If later model-authored prose conflicts with them, this section governs and the conflicting prose is non-authoritative.",
  }),
  Object.freeze({
    heading: "サーバー検証済み評価根拠",
    authority: "以下の項目はサーバー契約で検証済みです。後続のモデル作成本文と矛盾する場合は本節を正とします。",
  }),
  Object.freeze({
    heading: "서버 검증 등급 근거",
    authority: "다음 필드는 서버 계약 검증을 통과했습니다. 뒤의 모델 작성 본문과 충돌하면 이 절이 우선합니다.",
  }),
]);

const CONFUSABLE_LATIN = Object.freeze({
  "Ѕ": "s", "А": "a", "В": "b", "Е": "e", "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p", "С": "c", "Т": "t", "Х": "x",
  "а": "a", "в": "b", "е": "e", "і": "i", "ј": "j", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ԁ": "d", "ӏ": "l",
  "Α": "a", "Β": "b", "Ε": "e", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "y", "χ": "x",
  "ı": "i", "ɩ": "i", "ɡ": "g", "ɑ": "a",
});

function confusableLatinProjection(value) {
  return [...String(value || "")]
    .map((character) => CONFUSABLE_LATIN[character] || character)
    .join("");
}

function decodeVisibleHtmlEntities(value) {
  return String(value ?? "")
    // Browsers accept many numeric references without a trailing semicolon. Decode that
    // conservative subset too so `bu&#121;` cannot differ between the validator and reader.
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?/giu, (entity, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replace(/&(amp|apos|gt|hyphen|lt|nbsp|quot);?/giu, (entity, name) => (
      NAMED_HTML_ENTITIES[String(name).toLowerCase()] ?? entity
    ));
}

/**
 * Remove tag syntax while respecting quoted `>` characters. Two projections are used:
 * inline markup must join `b<span>u</span>y`, while block markup must also permit an `I`
 * and `would buy` split across tags to be read as separate words.
 */
function withoutHtmlTags(value, separator) {
  const input = String(value ?? "");
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== "<") {
      output += input[index];
      continue;
    }
    let quote = null;
    let cursor = index + 1;
    let closed = false;
    for (; cursor < input.length; cursor += 1) {
      const character = input[cursor];
      if (quote) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === ">") {
        closed = true;
        break;
      }
    }
    if (!closed) {
      output += input[index];
      continue;
    }
    output += separator;
    index = cursor;
  }
  return output;
}

function markdownVisibleProjection(value, htmlSeparator, { literalMarkup = false } = {}) {
  // Boundary sanitization intentionally encodes an existing entity's ampersand. Decode a
  // bounded number of layers for validation so that `bu&amp;#121;` is still recognized as the
  // reader-visible word `buy`, without creating an unbounded entity-expansion loop.
  let decoded = String(value ?? "");
  for (let pass = 0; pass < 3; pass += 1) decoded = decodeVisibleHtmlEntities(decoded);
  decoded = decoded.normalize("NFKC");
  if (!literalMarkup) decoded = decoded.replace(/<!--[\s\S]*?-->/gu, htmlSeparator);
  // The raw reader and the persisted reader do not always see the same thing. Raw HTML tags
  // and comments disappear, but this module's trust boundary escapes them before publication,
  // making their contents literal reader text. Keep both projections: stripping tags catches
  // `b<span>u</span>y`; retaining markup catches `<buy>` and `<!-- I would buy -->` after escape.
  const visible = (literalMarkup ? decoded : withoutHtmlTags(decoded, htmlSeparator))
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, "$1")
    .replace(/\\([^\p{L}\p{N}\s])/gu, "$1")
    .replace(/[*_~`]/gu, "")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
  return confusableLatinProjection(visible);
}

/** Candidate texts approximating what a Markdown/HTML reader can see. */
export function readerVisibleTextCandidates(value) {
  return [...new Set([
    markdownVisibleProjection(value, ""),
    markdownVisibleProjection(value, " "),
    markdownVisibleProjection(value, "", { literalMarkup: true }),
  ].filter(Boolean))];
}

function compactVisible(value) {
  return confusableLatinProjection(String(value || "").toLocaleLowerCase())
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const PROTECTED_COMPACT = Object.freeze(PROTECTED_RATING_AUTHORITY.map((entry) => Object.freeze({
  heading: compactVisible(entry.heading),
  authority: compactVisible(entry.authority),
})));

function occurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, offset);
    if (at < 0) break;
    count += 1;
    offset = at + needle.length;
  }
  return count;
}

/** Count protected claims after Markdown, entity, Unicode and HTML normalization. */
export function protectedRatingAuthorityOccurrences(value) {
  const candidates = readerVisibleTextCandidates(value).map(compactVisible);
  const countFor = (key) => Math.max(0, ...candidates.map((candidate) => (
    PROTECTED_COMPACT.reduce((total, entry) => total + occurrences(candidate, entry[key]), 0)
  )));
  return {
    heading_count: countFor("heading"),
    authority_count: countFor("authority"),
  };
}

export function containsProtectedRatingAuthority(value) {
  const counts = protectedRatingAuthorityOccurrences(value);
  return counts.heading_count > 0
    || counts.authority_count > 0
    || containsSemanticRatingAuthorityHeading(value)
    || containsStrongRatingAuthorityClaim(value);
}

function ratingAuthoritySignals(value) {
  return readerVisibleTextCandidates(value).some((candidate) => {
    // Technical headings can legitimately describe the implementation of a rating formula or
    // its validation dataset. They do not claim that the resulting investment rating is an
    // authoritative server decision. Keep these narrow, noun-bound exceptions ahead of the
    // semantic authority triad so ordinary math/model documentation retains its heading.
    const technicalContext = /\b(?:rating|ratings|recommendation|recommendations)(?:\s+basis)?\s+(?:functions?|vectors?|formulae?|formulas?|equations?|models?|schemas?|tests?|test\s+fixtures?|validation\s+data)\b/iu.test(candidate)
      || /(?:评级|評級|评分|評分|等级|等級)(?:依据|依據|基礎)?(?:函数|函數|向量|公式|方程|模型|模式|架構|架构|驗證數據|验证数据|測試數據|测试数据)/u.test(candidate)
      || /(?:評価|格付け|レーティング)(?:の)?(?:根拠)?(?:関数|ベクトル|公式|数式|方程式|モデル|スキーマ|テスト|検証データ)/u.test(candidate)
      || /(?:評価|格付け|レーティング)(?:の)?検証(?:用)?(?:データ|方法|モデル|指標)/u.test(candidate)
      || /(?:등급|평가)(?:\s*근거)?\s*(?:함수|벡터|공식|방정식|모델|스키마|테스트|검증\s*데이터)/u.test(candidate);
    if (technicalContext) return false;
    const source = /\b(?:server|system|machine|official|contract|backend|platform|service|engine|runtime|host|application|app|api|tool|pipeline|cloud|infrastructure|gateway|database|algorithm|automated)\b/iu.test(candidate)
      || /(?:服务端|服務端|服务器|服務器|伺服器|系统|系統|官方|机器|機器|后端|後端|平台|运行时|運行時|工具|管道|云端|雲端|基础设施|基礎設施|网关|網關|数据库|數據庫|資料庫|算法|演算法|自动化|自動化)/u.test(candidate)
      || /(?:サーバー|サーバ|システム|機械|バックエンド|プラットフォーム|ランタイム|ホスト|ツール|パイプライン|クラウド|インフラ|ゲートウェイ|データベース|アルゴリズム|自動化)/u.test(candidate)
      || /(?:서버|시스템|공식|기계|백엔드|플랫폼|런타임|호스트|도구|파이프라인|클라우드|인프라|게이트웨이|데이터베이스|알고리즘|자동화)/u.test(candidate);
    const rating = /\b(?:rating|ratings|recommendation|recommendations|investment\s+(?:verdict|conclusion|view))\b/iu.test(candidate)
      || /(?:评级|評級|投资评级|投資評級|评分|評分|等级|等級|投资建议|投資建議|投资结论|投資結論)/u.test(candidate)
      || /(?:評価|格付け|投資判断|投資結論|投資推奨|レーティング)/u.test(candidate)
      || /(?:등급|평가|투자\s*등급|투자\s*의견|투자\s*결론|투자\s*권고)/u.test(candidate);
    const authority = /\b(?:basis|confirm\w*|validat\w*|verif\w*|certif\w*|approv\w*|attest\w*|audit\w*|authoriz\w*|endors\w*|guarant\w*|warrant\w*|accredit\w*|trust(?:ed|worthy)?|signed|authority|authoritative|official|governs?|controls?|overrides?|prevails?)\b/iu.test(candidate)
      || /(?:校验|校驗|核验|核驗|验证|驗證|认证|認證|审核|審核|审定|審定|核准|批准|认可|認可|背书|背書|公认|公認|保证|保證|权威|權威|可信|依据|依據|根據|为准|為準|优先|優先)/u.test(candidate)
      // In Japanese, 公式 also means a mathematical formula. It is not an authority signal
      // by itself; explicit verification/certification language still protects the rating block.
      || /(?:検証|認証|承認|監査|審査済み|確認済み|保証済み|公認|信頼済み|根拠|優先|正とします|正とする)/u.test(candidate)
      || /(?:검증|인증|승인|감사|확인\s*완료|확인됨|보증|공인|신뢰됨|근거|권위|우선|기준으로)/u.test(candidate);
    return source && rating && authority;
  });
}

function strongRatingAuthoritySignals(value) {
  return readerVisibleTextCandidates(value).some((candidate) => {
    const clauses = candidate.split(/[.!?。！？；;]+/u);
    return clauses.some((clause) => ratingAuthoritySignals(clause));
  });
}

function markdownHeadingText(line) {
  const match = String(line || "").match(
    /^\s*(?:(?:>\s*)|(?:[-+*]\s+)|(?:\d+[.)]\s+))*#{1,6}[\t ]+(.+?)\s*#*\s*$/u,
  );
  return match?.[1] || null;
}

function setextUnderline(line) {
  return /^\s*(?:(?:>\s*)|(?:[-+*]\s+)|(?:\d+[.)]\s+))*[=-]{2,}\s*$/u.test(String(line || ""));
}

function outsideFencedCodeLines(value) {
  const output = [];
  let fence = null;
  for (const line of String(value || "").split("\n")) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/u)?.[1] || null;
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (!fence) output.push(line);
  }
  return output;
}

function ratingAuthorityHeadings(value) {
  const raw = outsideFencedCodeLines(value).join("\n");
  const headings = [];
  // Only literal raw HTML is an HTML heading. Entity-escaped `<h2>` remains visible text and
  // must not be reinterpreted as markup during this structural count.
  for (const match of raw.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/giu)) {
    headings.push(match[1]);
  }
  const lines = outsideFencedCodeLines(value);
  for (let index = 0; index < lines.length; index += 1) {
    const atx = markdownHeadingText(lines[index]);
    if (atx !== null) headings.push(atx);
    if (index > 0 && setextUnderline(lines[index])) headings.push(lines[index - 1]);
  }
  return headings;
}

export function serverRatingAuthorityHeadingCount(value) {
  return ratingAuthorityHeadings(value)
    .filter((heading) => ratingAuthoritySignals(heading))
    .length;
}

export function containsSemanticRatingAuthorityHeading(value) {
  return serverRatingAuthorityHeadingCount(value) > 0;
}

function containsStrongRatingAuthorityClaim(value) {
  return strongRatingAuthoritySignals(value);
}

function neutralizeUntrustedAuthorityHeadings(value) {
  const lines = String(value || "").split("\n");
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const marker = lines[index].match(/^\s*(`{3,}|~{3,})/u)?.[1] || null;
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = markdownHeadingText(lines[index]);
    if (atx !== null && ratingAuthoritySignals(atx)) {
      // A heading marker can appear after blockquote/list syntax (`- ##`, `> ###`) at any
      // supported ATX level. Escaping every hash on this authority-like line is deliberately
      // simpler and safer than attempting to reimplement all CommonMark containers.
      lines[index] = lines[index].replace(/(^|[^\\])#/gu, "$1\\#");
    }
    // Setext headings derive their title from the preceding line. Break only an authority-like
    // title; ordinary Japanese, accented Latin and mathematical headings remain untouched.
    if (index + 1 < lines.length && setextUnderline(lines[index + 1])
      && ratingAuthoritySignals(lines[index])) {
      lines[index + 1] = lines[index + 1].replace(/([=-])/u, "\\$1");
    }
  }
  return lines.join("\n");
}

/** Disable raw HTML, entities and invisible formatting while retaining authored Markdown. */
export function sanitizeUntrustedMarkdown(value) {
  const escaped = String(value ?? "")
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    // Remote model-authored images can visually counterfeit an authority block even when the
    // Markdown text itself is clean. Reports do not require images, so retain the literal link
    // syntax while disabling image rendering.
    .replace(/!\[/gu, "\\![");
  // Only server-rating authority lookalikes lose heading status. Script-wide demotion is both
  // over-broad (Japanese long-vowel marks and ordinary accented names are valid) and weaker than
  // matching the protected semantic pair itself.
  return neutralizeUntrustedAuthorityHeadings(escaped);
}

/** Plain reader prose used inside system-owned Markdown rows and headings. */
export function sanitizeReaderInline(value) {
  // Collapsing line breaks removes every block-level Markdown primitive. Inline emphasis and
  // links may remain readable; raw HTML/entities and image rendering are disabled by the shared
  // sanitizer. Keeping ordinary underscores byte-stable is important for source IDs and audit
  // sentinels that also appear in reader prose.
  const flattened = sanitizeUntrustedMarkdown(String(value ?? "").replace(/\s+/gu, " ").trim());
  // The caller may place this string on an otherwise empty Markdown line. Flattening alone is
  // insufficient when the first bytes are `##`, `>`, a list marker or a fence, so neutralize
  // only that leading block primitive while leaving ordinary inline emphasis/underscores intact.
  return flattened
    .replace(/^(\s*)(#{1,6})(?=[\t ])/u, "$1\\$2")
    .replace(/^(\s*)(>|[-+*]|\d+[.)])(?=[\t ])/u, "$1\\$2")
    .replace(/^(\s*)(`{3,}|~{3,})/u, "$1\\$2");
}
