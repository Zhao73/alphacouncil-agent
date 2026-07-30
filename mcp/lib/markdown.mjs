import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEBATE_ROLES, RECORDED_BENCH_MARKER_PREFIX, RECORDED_INSTRUMENT_MARKER_PREFIX, REPORT_SECTIONS } from "./constants.mjs";
import { writeJson } from "./fsutil.mjs";
import { headingIncludesAlias, normalizeHeading, parseHeadings } from "./headings.mjs";
import { isChineseLanguage, languageKey, localized } from "./lang.mjs";
import { sha256 } from "./personas-v3/canonical.mjs";
import { compiledPersonaPacks } from "./personas-v3/registry.mjs";
import { bullets, clip, clipAtBoundary, fence } from "./text.mjs";
import { completenessStatus, validateFinalReport, verificationStatus, withCompletenessBanner, withDisclaimer, withVerificationBanner } from "./gates.mjs";
import { isFundOrIndex } from "./instruments.mjs";
import { composeVoiceStatement, intentLabel, VOICE_FIELDS, voiceDisclaimer, voiceFieldLabel } from "./voice.mjs";
import { agentState, appendEvent, artifactPaths, runPath, taskState } from "./run-store.mjs";
import { personaTitle, registry } from "./personas/registry.mjs";

/**
 * Per-seat statement budget in the handoff.
 *
 * The governance contract requires every selected seat's statement in the handoff, so this is
 * the seat's only appearance there. At the old one-line budget a seat's conclusion was always
 * the part that got cut, which is how seven seats that all spoke read as seven seats that had
 * not. The complete statement stays in the report and in `master_<id>.md`.
 */
const MASTER_STATEMENT_CHARS = 2000;

export function renderPacketMarkdown(packet, index = 0, language = packet?.language) {
  const key = languageKey(language);
  const label = {
    zh: { title: "证据分析子代理", symbol: "代码", asOf: "截至", confidence: "置信度", richness: "信息丰富度", summary: "摘要", claims: "论断", evidence: "证据", sources: "来源", metrics: "指标", questions: "未决问题", raw: "原始 worker 响应（仅供审计）", none: "无" },
    en: { title: "Evidence Analyst Subagent", symbol: "Symbol", asOf: "As-of", confidence: "Confidence", richness: "Information richness", summary: "Summary", claims: "Claims", evidence: "Evidence", sources: "Sources", metrics: "Metrics", questions: "Open Questions", raw: "Raw Worker Response (audit only)", none: "None" },
    ja: { title: "証拠分析サブエージェント", symbol: "銘柄コード", asOf: "基準日", confidence: "信頼度", richness: "情報充足度", summary: "要約", claims: "主張", evidence: "根拠", sources: "出典", metrics: "指標", questions: "未解決事項", raw: "ワーカーの生応答（監査専用）", none: "なし" },
    ko: { title: "증거 분석 하위 에이전트", symbol: "종목 코드", asOf: "기준일", confidence: "신뢰도", richness: "정보 충실도", summary: "요약", claims: "주장", evidence: "근거", sources: "출처", metrics: "지표", questions: "미해결 질문", raw: "원본 워커 응답(감사 전용)", none: "없음" },
  }[key];
  const claims = packet.claims.length
    ? packet.claims.map((claim, claimIndex) => [
      `${claimIndex + 1}. ${claim.claim || ""}`,
      `   - ${label.evidence}: ${claim.evidence || ""}`,
      `   - ${label.confidence}: ${claim.confidence || "low"}`,
      `   - ${label.sources}: ${(claim.source_ids || []).join(", ") || label.none}`,
    ].join("\n")).join("\n")
    : `${label.none}.`;
  const sources = packet.sources.length
    ? packet.sources.map((source) => `- ${source.id || "S?"}: ${source.title || ""} (${source.published_at || "unknown"}) ${source.url || ""}`).join("\n")
    : `- ${label.none}`;
  return [
    `## ${label.title} ${index + 1}: ${packet.task}`,
    "",
    `- ${label.symbol}: ${packet.symbol}`,
    `- ${label.asOf}: ${packet.as_of}`,
    packet.thread_id ? `- Visible thread ID: ${packet.thread_id}` : "",
    packet.thread_title ? `- Visible thread title: ${packet.thread_title}` : "",
    `- ${label.confidence}: ${packet.confidence}`,
    `- ${label.richness}: ${packet.information_richness || "unrated"}`,
    "",
    `### ${label.summary}`,
    packet.summary || "",
    "",
    `### ${label.claims}`,
    claims,
    "",
    `### ${label.metrics}`,
    fence(packet.metrics || {}, "json"),
    "",
    `### ${label.sources}`,
    sources,
    "",
    `### ${label.questions}`,
    bullets(packet.open_questions),
    "",
    `### ${label.raw}`,
    fence(packet.raw_text || "", "text"),
  ].join("\n");
}

/**
 * A recorded master opinion, rendered so a reader can see what the lens actually said.
 *
 * Master opinions were stored, gated for completeness and weighted into the synthesis, and
 * then rendered nowhere: a run could select ten lenses, pass every gate, and emit a report
 * in which none of them were readable. `out_of_scope` is included deliberately — a method
 * declining to judge is a finding, and hiding it is how a bench looks unanimous.
 */
export function renderMasterMarkdown(opinion, lang) {
  if (!opinion) return "";
  const title = masterTitle(opinion.master, lang);
  const labels = {
    zh: { statement: "本轮方法席终局陈词（不是大师本人引语）", stance: "立场", verdict: "冻结判断", confidence: "置信度", worker: "陈词来源", summary: "方法席说明", findings: "关键发现", disagreements: "与分析师的分歧", disqualifiers: "触发的排除条件", change: "改变判断所需证据", sources: "来源" },
    en: { statement: "Final Method-Seat Statement (not a quote from the named person)", stance: "Stance", verdict: "Frozen verdict", confidence: "Confidence", worker: "Statement source", summary: "Method-seat explanation", findings: "Key Findings", disagreements: "Disagreements With The Analysts", disqualifiers: "Disqualifiers Triggered", change: "What Would Change The View", sources: "Sources" },
    ja: { statement: "メソッド席の最終見解（本人の発言・引用ではありません）", stance: "スタンス", verdict: "凍結済み判定", confidence: "信頼度", worker: "見解の生成元", summary: "メソッド席の説明", findings: "主な所見", disagreements: "分析担当との相違", disqualifiers: "発動した除外条件", change: "判断が変わる条件", sources: "出典" },
    ko: { statement: "방법론 좌석 최종 발언(본인의 실제 발언이나 인용이 아님)", stance: "입장", verdict: "동결된 판단", confidence: "신뢰도", worker: "발언 출처", summary: "방법론 좌석 설명", findings: "핵심 발견", disagreements: "분석가와의 이견", disqualifiers: "발동된 제외 조건", change: "판단 변경 조건", sources: "출처" },
  }[languageKey(lang)];
  return [
    `## ${title}`,
    "",
    `- ID: ${opinion.master}`,
    `- ${labels.stance}: ${opinion.stance || "unknown"}`,
    `- ${labels.verdict}: ${opinion.verdict || ""}`,
    `- ${labels.confidence}: ${opinion.confidence || "low"}`,
    `- ${labels.worker}: ${opinion.dedicated_worker?.status || opinion.voice_status || "not_recorded"}${opinion.dedicated_worker?.pid ? ` (pid ${opinion.dedicated_worker.pid})` : ""}`,
    opinion.thread_id ? `- Visible thread ID: ${opinion.thread_id}` : "",
    "",
    `### ${labels.statement}`,
    // When the statement was composed from the five voice fields, render those fields as
    // labelled lines -- a person reasoning, not one glued sentence. A statement from any
    // other origin (a flat worker statement, a deterministic template) is the authored
    // record and renders verbatim; the fields beside it may be a deterministic fallback
    // that would silently replace what the worker actually said.
    ...(opinion.voice && typeof opinion.voice === "object"
      && composeVoiceStatement(opinion.voice, lang) === opinion.voice_statement
      ? VOICE_FIELDS
        .map((field) => [field, String(opinion.voice[field] ?? "").trim()])
        .filter(([, text]) => text)
        .map(([field, text]) => `**${voiceFieldLabel(field, lang)}**: ${text}`)
      : [opinion.voice_statement || opinion.summary || ""]),
    "",
    `### ${labels.summary}`,
    opinion.deterministic_summary || opinion.summary || "",
    "",
    `### ${labels.findings}`,
    bullets(opinion.key_findings),
    "",
    `### ${labels.disagreements}`,
    bullets(opinion.disagreements),
    "",
    `### ${labels.disqualifiers}`,
    bullets(opinion.disqualifiers_triggered),
    "",
    `### ${labels.change}`,
    bullets(opinion.what_would_change_my_mind),
    "",
    `### ${labels.sources}`,
    (opinion.source_ids || []).length ? (opinion.source_ids || []).map((id) => `- ${id}`).join("\n") : "- None",
  ].filter((line) => line !== "").join("\n");
}

/** Reader-facing labels for the method-seat section, one entry per supported run language. */
const MASTER_STATEMENT_COPY = Object.freeze({
  zh: {
    heading: "\u9010\u5e2d\u65b9\u6cd5\u8f93\u51fa", acted: "\u6709\u5224\u65ad\u7684\u5e2d\u4f4d", abstained: "\u8bf4\u8fd9\u4e0d\u5f52\u5b83\u7ba1\u7684\u5e2d\u4f4d",
    stance: "\u7acb\u573a", intent: "\u610f\u5411", origin: "\u9648\u8bcd\u6765\u6e90", statement: "\u672c\u8f6e\u53d1\u8a00\uff08\u4e0d\u662f\u672c\u4eba\u5f15\u8bed\uff09",
    findings: "\u5173\u952e\u53d1\u73b0", disagreements: "\u4e0e\u5206\u6790\u5e08\u5206\u6b67", change: "\u6539\u53d8\u5224\u65ad\u6761\u4ef6", sources: "\u6765\u6e90\u6216\u660e\u786e\u7f3a\u53e3",
    abstainLead: (n) => `\u53e6\u6709 ${n} \u5e2d\u672c\u8f6e\u672a\u80fd\u53d6\u5f97\u5176\u65b9\u6cd5\u5fc5\u9700\u7684\u8f93\u5165\uff0c\u56e0\u6b64\u6ca1\u6709\u7ed9\u51fa\u65b9\u5411\u3002\u8fd9\u662f\u6570\u636e\u7f3a\u53e3\uff0c\u4e0d\u662f\u770b\u7a7a\u7968\uff1a`,
    declined: "\u770b\u8fc7\u4e4b\u540e\u51b3\u5b9a\u4e0d\u53c2\u4e0e\u7684\u5e2d\u4f4d",
    declinedLead: (n) => `\u4ee5\u4e0b ${n} \u5e2d\u7684\u65b9\u6cd5\u8dd1\u5b8c\u4e86\uff0c\u5e76\u4e14\u5f97\u51fa\u4e86\u201c\u4e0d\u662f\u8fd9\u4e2a\u201d\u3002\u8fd9\u662f\u5224\u65ad\uff0c\u4e0d\u662f\u7f3a\u6570\u636e\uff1a`,
  },
  en: {
    heading: "Method-Seat Outputs", acted: "Seats with a view", abstained: "Seats that say this is not theirs to call",
    stance: "Stance", intent: "Intent", origin: "Statement source", statement: "Recorded statement (not a quote)",
    findings: "Key findings", disagreements: "Disagreements", change: "What would change the view", sources: "Sources or explicit gaps",
    abstainLead: (n) => `A further ${n} seat(s) issue no direction because a method-critical input did not arrive this round. This is a data gap, not a bearish vote:`,
    declined: "Seats whose method examined this and declined",
    declinedLead: (n) => `${n} seat(s) ran their method to completion and it returned "not this one". These are judgments, not missing data:`,
  },
  ja: {
    heading: "\u30e1\u30bd\u30c3\u30c9\u5e2d\u3054\u3068\u306e\u51fa\u529b", acted: "\u5224\u65ad\u3092\u793a\u3057\u305f\u5e2d", abstained: "\u81ea\u5206\u306e\u62c5\u5f53\u3067\u306f\u306a\u3044\u3068\u3057\u305f\u5e2d",
    stance: "\u30b9\u30bf\u30f3\u30b9", intent: "\u610f\u5411", origin: "\u898b\u89e3\u306e\u751f\u6210\u5143", statement: "\u4eca\u56de\u306e\u767a\u8a00\uff08\u672c\u4eba\u306e\u5f15\u7528\u3067\u306f\u3042\u308a\u307e\u305b\u3093\uff09",
    findings: "\u4e3b\u306a\u6240\u898b", disagreements: "\u5206\u6790\u62c5\u5f53\u3068\u306e\u76f8\u9055", change: "\u5224\u65ad\u304c\u5909\u308f\u308b\u6761\u4ef6", sources: "\u51fa\u5178\u307e\u305f\u306f\u660e\u793a\u7684\u306a\u6b20\u843d",
    abstainLead: (n) => `\u4ed6\u306b ${n} \u5e2d\u306f\u3001\u30e1\u30bd\u30c3\u30c9\u306b\u5fc5\u8981\u306a\u5165\u529b\u304c\u4eca\u56de\u5c4a\u304b\u306a\u304b\u3063\u305f\u305f\u3081\u65b9\u5411\u6027\u3092\u793a\u3057\u307e\u305b\u3093\u3002\u30c7\u30fc\u30bf\u306e\u6b20\u843d\u3067\u3042\u308a\u3001\u5f31\u6c17\u7968\u3067\u306f\u3042\u308a\u307e\u305b\u3093\uff1a`,
    declined: "\u691c\u8a0e\u3057\u305f\u4e0a\u3067\u898b\u9001\u3063\u305f\u5e2d",
    declinedLead: (n) => `\u6b21\u306e ${n} \u5e2d\u306f\u30e1\u30bd\u30c3\u30c9\u3092\u6700\u5f8c\u307e\u3067\u5b9f\u884c\u3057\u3001\u300c\u3053\u308c\u3067\u306f\u306a\u3044\u300d\u3068\u7d50\u8ad6\u3057\u307e\u3057\u305f\u3002\u30c7\u30fc\u30bf\u4e0d\u8db3\u3067\u306f\u306a\u304f\u5224\u65ad\u3067\u3059\uff1a`,
  },
  ko: {
    heading: "\ubc29\ubc95\ub860 \uc88c\uc11d\ubcc4 \ucd9c\ub825", acted: "\ud310\ub2e8\uc744 \ub0b8 \uc88c\uc11d", abstained: "\uc790\uae30 \uc18c\uad00\uc774 \uc544\ub2c8\ub77c\uace0 \ubc1d\ud78c \uc88c\uc11d",
    stance: "\uc785\uc7a5", intent: "\uc758\ud5a5", origin: "\ubc1c\uc5b8 \ucd9c\ucc98", statement: "\uc774\ubc88 \ubc1c\uc5b8(\ubcf8\uc778 \uc778\uc6a9\uc774 \uc544\ub2d8)",
    findings: "\ud575\uc2ec \ubc1c\uacac", disagreements: "\ubd84\uc11d\uac00\uc640\uc758 \uc774\uacac", change: "\ud310\ub2e8 \ubcc0\uacbd \uc870\uac74", sources: "\ucd9c\ucc98 \ub610\ub294 \uba85\uc2dc\uc801 \ub370\uc774\ud130 \uacf5\ubc31",
    abstainLead: (n) => `\uadf8 \uc678 ${n}\uac1c \uc88c\uc11d\uc740 \ubc29\ubc95\ub860\uc5d0 \ud544\uc694\ud55c \uc785\ub825\uc774 \uc774\ubc88 \ud68c\ucc28\uc5d0 \ub3c4\ucc29\ud558\uc9c0 \uc54a\uc544 \ubc29\ud5a5\uc744 \uc81c\uc2dc\ud558\uc9c0 \uc54a\uc2b5\ub2c8\ub2e4. \ub370\uc774\ud130 \uacf5\ubc31\uc774\uba70 \uc57d\uc138 \ud22c\ud45c\uac00 \uc544\ub2d9\ub2c8\ub2e4:`,
    declined: "\uac80\ud1a0 \ud6c4 \ucc38\uc5ec\ud558\uc9c0 \uc54a\uae30\ub85c \ud55c \uc88c\uc11d",
    declinedLead: (n) => `\ub2e4\uc74c ${n}\uac1c \uc88c\uc11d\uc740 \ubc29\ubc95\ub860\uc744 \ub05d\uae4c\uc9c0 \uc218\ud589\ud588\uace0 "\uc774\uac83\uc740 \uc544\ub2c8\ub2e4"\ub77c\ub294 \uacb0\ub860\uc5d0 \ub3c4\ub2ec\ud588\uc2b5\ub2c8\ub2e4. \ub370\uc774\ud130 \ubd80\uc871\uc774 \uc544\ub2c8\ub77c \ud310\ub2e8\uc785\ub2c8\ub2e4:`,
  },
});

/**
 * Seats that reached a decision are what a reader came for; seats that could not are context.
 *
 * The previous layout gave both the same weight, so a run where twenty-five seats abstained
 * printed twenty-five near-identical rows and buried the one seat that had a view. Deciding
 * seats now get room to speak and abstaining seats collapse into one readable paragraph.
 * Every selected stable ID still appears in this section: the publication gate checks for
 * exactly that, and it is also the honest requirement -- no seat may quietly vanish.
 */
function renderMasterStatements(run) {
  const key = languageKey(run?.language);
  const copy = MASTER_STATEMENT_COPY[key] || MASTER_STATEMENT_COPY.en;
  const voiced = (run?.master_opinions || []).filter((opinion) => Boolean(opinion.voice_statement));
  if (!voiced.length) return "";
  const acted = voiced.filter((opinion) => opinion.stance && opinion.stance !== "out_of_scope");
  const abstained = voiced.filter((opinion) => !opinion.stance || opinion.stance === "out_of_scope");

  const seatBlock = (opinion) => {
    const intent = opinion.position_intent ? intentLabel(opinion.position_intent, run.language) : null;
    const lines = [
      `##### ${masterTitle(opinion.master, run.language)} (\`${opinion.master}\`)`,
      `- ${copy.stance}: ${opinion.stance || "unknown"}${intent ? ` \u2014 ${copy.intent}: *${intent}*` : ""}`,
      `- ${copy.origin}: ${opinion.dedicated_worker?.status || opinion.voice_status || "not_recorded"}`,
    ];
    // The five-field voice reads as prose; a legacy flat statement keeps its single line.
    if (opinion.voice && typeof opinion.voice === "object") {
      for (const field of VOICE_FIELDS) {
        const text = String(opinion.voice[field] ?? "").trim();
        if (text) lines.push(`- **${voiceFieldLabel(field, run.language)}**: ${text}`);
      }
    } else {
      lines.push(`- ${copy.statement}: ${opinion.voice_statement || opinion.verdict || opinion.summary || ""}`);
    }
    lines.push(`- ${copy.findings}: ${(opinion.key_findings || []).slice(0, 4).join("\uFF1B") || "\u2014"}`);
    lines.push(`- ${copy.disagreements}: ${(opinion.disagreements || []).slice(0, 3).join("\uFF1B") || "\u2014"}`);
    lines.push(`- ${copy.change}: ${(opinion.what_would_change_my_mind || []).slice(0, 3).join("\uFF1B") || "\u2014"}`);
    lines.push(`- ${copy.sources}: ${(opinion.source_ids || []).join(", ") || (opinion.disqualifiers_triggered || []).join(", ") || "\u2014"}`);
    return lines.join("\n");
  };

  const sections = [`### ${copy.heading}`, voiceDisclaimer(run.language)];
  if (acted.length) sections.push(`#### ${copy.acted}`, acted.map(seatBlock).join("\n\n"));
  if (abstained.length) {
    // Two reasons wear the same word and they are not the same event. A seat whose method
    // examined the subject and declined has ANSWERED -- Graham finding no asset floor, a
    // volatility seat finding no testable observation -- and reporting that as "missing an
    // input" tells a reader the system broke when the method spoke. A seat whose required
    // fact never arrived genuinely is a gap. Rendering them together made every run read as
    // the second kind, which is the complaint this split exists to answer.
    // One block per seat, not twenty-five names glued into a run-on paragraph: each seat
    // speaks its own statement, because a reader asked for the bench precisely to hear each
    // method say in its own words why this is or is not its call. The stable IDs stay
    // visible so the gate and the reader can both account for every selected seat.
    const merged = (group) => group
      .map((opinion) => `**${masterTitle(opinion.master, run.language)}** (\`${opinion.master}\`)\n\n> ${opinion.voice_statement}`)
      .join("\n\n");
    const declined = abstained.filter((opinion) => methodDeclined(opinion));
    const ungrounded = abstained.filter((opinion) => !methodDeclined(opinion));
    if (declined.length) {
      sections.push(`#### ${copy.declined}`, `${copy.declinedLead(declined.length)}\n\n${merged(declined)}`);
    }
    if (ungrounded.length) {
      sections.push(`#### ${copy.abstained}`, `${copy.abstainLead(ungrounded.length)}\n\n${merged(ungrounded)}`);
    }
  }
  return sections.join("\n\n");
}

/**
 * Printed above every rendered bench, in the report's language.
 *
 * Master seats share a base model, an evidence brief and a context window, so their errors
 * are correlated and their agreement is not independent confirmation. Published measurements
 * put LLM error correlation above 60%, which is why a tally of concurring seats is the
 * weakest thing a council produces and the dissenting seat is the informative one. Stating
 * this next to the opinions is the difference between a bench and a vote count.
 */
/**
 * Did the seat's own method reach this, or did the data never arrive?
 *
 * A fired veto and a false eligibility condition are both the method running to completion and
 * returning "not this one". Anything else -- an unmet required fact type, a coverage shortfall,
 * an executor refusal -- is the run failing to give the method what it asked for.
 */
export function methodDeclined(opinion) {
  const reason = String(opinion?.decision?.reason || opinion?.reason || "");
  return reason === "veto" || reason === "eligibility";
}

export function masterCorrelationNote(run) {
  const opinions = run?.master_opinions || [];
  if (!opinions.length) return "";
  const stances = new Map();
  for (const opinion of opinions) {
    const key = opinion.stance || "unknown";
    stances.set(key, (stances.get(key) || 0) + 1);
  }
  const spread = [...stances.entries()].map(([stance, n]) => `${stance}=${n}`).join(", ");
  const key = languageKey(run?.language);
  return {
    zh: [
      "> **这些席位不是独立样本。** 它们共享同一个基础模型、同一份证据简报和同一个上下文，",
      `> 因此错误是相关的。本次立场分布（${spread}）**不能当作票数来计算**：一致本身是预期结果，`,
      "> 不是发现。有信息量的是分歧席位，以及它的分歧来自信息差还是方法差。",
    ].join("\n")
    ,
    en: [
      "> **These seats are not independent samples.** They share a base model, an evidence",
      `> brief and a context window, so their errors are correlated. The stance spread (${spread})`,
      "> **is not a vote count**: agreement is the expected outcome, not a finding. The",
      "> informative seat is the dissenting one, and why it dissents.",
    ].join("\n"),
    ja: [
      "> **これらの席は独立標本ではありません。** 同じ基盤モデル、証拠要約、コンテキストを共有するため、",
      `> 誤りも相関します。立場の分布（${spread}）を**投票数として数えてはいけません**。一致は予想される結果であり、発見ではありません。`,
      "> 情報量が高いのは反対する席と、その相違が情報差か方法差かという点です。",
    ].join("\n"),
    ko: [
      "> **이 좌석들은 독립 표본이 아닙니다.** 동일한 기반 모델, 증거 요약, 컨텍스트를 공유하므로 오류도 상관되어 있습니다.",
      `> 입장 분포(${spread})를 **투표수로 계산하면 안 됩니다**. 일치는 예상되는 결과이지 새로운 발견이 아닙니다.`,
      "> 정보량이 높은 부분은 반대 좌석과 그 차이가 정보 차이인지 방법론 차이인지입니다.",
    ].join("\n"),
  }[key];
}

/**
 * The bench, ordered so the dissent is read first.
 *
 * A concurring seat is the weakest thing a council produces and the minority is where the
 * information is -- measurements put the minority right in roughly one divergent case in
 * four, and a majority rule discards exactly that. Printing the concurring block first
 * reproduces the tally in prose even when the numbers have been removed, so the order is
 * part of the fix rather than presentation.
 */
export function renderBenchSummary(run) {
  const opinions = run?.master_opinions || [];
  if (!opinions.length) return "";
  const key = languageKey(run?.language);
  const counts = new Map();
  for (const o of opinions) counts.set(o.stance || "unknown", (counts.get(o.stance || "unknown") || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const majority = ranked[0]?.[0];
  const minority = opinions.filter((o) => (o.stance || "unknown") !== majority);
  const concurring = opinions.filter((o) => (o.stance || "unknown") === majority);

  // The table is the frozen deterministic judgment; the dedicated worker statement is
  // rendered once in the per-seat detail block below. Keeping them separate prevents a
  // fluent explanation from being mistaken for, or duplicating, the frozen method result.
  const row = (o) => `| ${masterTitle(o.master, run?.language)} (\`${o.master}\`) | ${o.stance || "unknown"} | ${o.confidence || "low"} | ${clip(o.verdict || o.deterministic_summary || o.summary || o.voice_statement || "", 140)} |`;
  const copy = {
    zh: { head: ["| 方法 | 立场 | 置信度 | 判断 |", "|---|---|---|---|"], minority: "### 少数派（先读这个）", minorityNone: "### 少数派：无\n\n所有席位立场一致。鉴于它们共享模型与证据，一致是预期结果而非确认——本轮没有产生任何独立的反对意见。", divergence: `${minority.length} 席与多数不同。分歧席位是本轮信息量最高的部分——请先判断分歧来自信息差还是方法差。`, rest: "### 其余席位" },
    en: { head: ["| Method | Stance | Confidence | Verdict |", "|---|---|---|---|"], minority: "### Minority report (read this first)", minorityNone: "### Minority report: none\n\nEvery seat agreed. Given a shared model and a shared brief, agreement is the expected outcome rather than confirmation: this run produced no independent dissent.", divergence: `${minority.length} seat(s) diverge. Divergence is the highest-information part of this run: establish whether it comes from the evidence slice or from the method.`, rest: "### Concurring seats" },
    ja: { head: ["| メソッド | スタンス | 信頼度 | 判定 |", "|---|---|---|---|"], minority: "### 少数意見（最初に読む）", minorityNone: "### 少数意見：なし\n\n全席が一致しました。同じモデルと証拠を共有するため、一致は確認ではなく予想される結果です。本輪では独立した反対意見が出ませんでした。", divergence: `${minority.length}席が多数と異なります。最も情報量が高い部分なので、相違が証拠範囲と方法のどちらに由来するか確認してください。`, rest: "### その他の席" },
    ko: { head: ["| 방법론 | 입장 | 신뢰도 | 판단 |", "|---|---|---|---|"], minority: "### 소수 의견(먼저 확인)", minorityNone: "### 소수 의견: 없음\n\n모든 좌석이 일치했습니다. 동일한 모델과 증거를 공유하므로 일치는 확인이 아니라 예상되는 결과입니다. 이번 실행에는 독립적인 반대 의견이 없었습니다.", divergence: `${minority.length}개 좌석이 다수와 다릅니다. 가장 정보량이 높은 부분이므로 차이가 증거 범위와 방법론 중 어디에서 비롯됐는지 확인하십시오.`, rest: "### 나머지 좌석" },
  }[key];
  const head = copy.head;

  const sections = [masterCorrelationNote(run), ""];
  if (minority.length) {
    sections.push(
      copy.minority,
      "",
      copy.divergence,
      "",
      ...head,
      ...minority.map(row),
      "",
    );
  } else {
    sections.push(
      copy.minorityNone,
      "",
    );
  }
  sections.push(
    copy.rest,
    "",
    ...head,
    ...concurring.map(row),
  );
  return sections.filter((s) => s !== undefined).join("\n");
}

/**
 * The deterministic half, printed as evidence rather than as a vote.
 *
 * Shows what each method could actually measure. `coverage` is the honest column: a score
 * produced from a fifth of a rule set has sampled the company, not judged it.
 */
export function renderDecisionTable(decisions, lang) {
  if (!Array.isArray(decisions) || !decisions.length) return "";
  const zh = isChineseLanguage(lang);
  const head = zh
    ? ["| 方法 | 可评估 | 得分 | 覆盖率 | 立场 | 依据 |", "|---|---|---|---|---|---|"]
    : ["| Method | Eligible | Score | Coverage | Stance | Basis |", "|---|---|---|---|---|---|"];
  const rows = decisions.map((d) => {
    const eligible = d.reason === "eligibility" ? (zh ? "否" : "no") : (zh ? "是" : "yes");
    const score = d.score && d.score.max_possible ? `${d.score.score}/${d.score.max_possible}` : "—";
    const coverage = d.score && d.score.declared_max ? `${Math.round((d.score.coverage || 0) * 100)}%` : "—";
    return `| ${d.persona_id} | ${eligible} | ${score} | ${coverage} | ${d.stance} | ${d.reason} |`;
  });
  return [
    zh ? "### 确定性评分（模型调用之前）" : "### Deterministic scoring (before any model call)",
    "",
    ...head,
    ...rows,
    "",
    zh
      ? "> 覆盖率是这张表最重要的一列：只跑得动一小部分规则的方法是抽样了这家公司，不是判断了它。`可评估=否` 的席位没有花费任何模型调用。"
      : "> Coverage is the column that matters: a method that could run a fraction of its rules sampled the company rather than judging it. Rows marked not eligible cost no model call.",
  ].join("\n");
}

/** Registry title when the persona resolves, the raw id when it does not. */
/**
 * Maturity vocabulary belongs in metadata, not in a heading a reader has to parse.
 *
 * `admitted_label` carries the governance suffix ("... Provisional Operator Lens") so that an
 * internal artifact can never be mistaken for a validated method model. A reader scanning a
 * report does not need that phrase repeated on all twenty-six headings; the section already
 * carries a disclaimer and the admission level travels with the pack. Strip it for display
 * only -- the label itself, and every hash over it, is untouched.
 */
const MATURITY_SUFFIX = /[\s\u3000]*(provisional operator lens|\u4e34\u65f6\u64cd\u4f5c\u89c6\u89d2|\u66ab\u5b9a\u30aa\u30da\u30ec\u30fc\u30bf\u30fc\u30ec\u30f3\u30ba|\uc784\uc2dc \uc624\ud37c\ub808\uc774\ud130 \ub80c\uc988)[\s\u3000]*$/iu;

export function displayMasterLabel(label) {
  const text = String(label || "").trim();
  const stripped = text.replace(MATURITY_SUFFIX, "").trim();
  return stripped || text;
}

function masterTitle(id, lang) {
  if (!id) return "Master";
  try {
    const v3 = compiledPersonaPacks().get(id);
    const v3Title = v3?.admitted_label?.[languageKey(lang)];
    if (v3Title) return displayMasterLabel(v3Title);
    const persona = registry().get(id);
    const title = personaTitle(persona, lang);
    return title && title !== id ? title : id;
  } catch {
    return id;
  }
}

export function renderDebateRounds(rounds, language = "English") {
  if (!Array.isArray(rounds) || rounds.length === 0) return "";
  const key = languageKey(language);
  const label = {
    zh: { round: "轮次", long: "多头论据", short: "空头论据", questions: "提出的问题", answered: "逐题回答", raw: "原始 worker 响应（仅供审计）", title: "辩论轮次" },
    en: { round: "Round", long: "Long Thesis", short: "Short Thesis", questions: "Questions", answered: "Questions Answered", raw: "Raw Worker Response (audit only)", title: "Debate Rounds" },
    ja: { round: "ラウンド", long: "強気論拠", short: "弱気論拠", questions: "質問", answered: "質問への回答", raw: "ワーカーの生応答（監査専用）", title: "討論ラウンド" },
    ko: { round: "라운드", long: "강세 논거", short: "약세 논거", questions: "질문", answered: "질문별 답변", raw: "원본 워커 응답(감사 전용)", title: "토론 라운드" },
  }[key];
  const blocks = rounds.map((round) => [
    `#### ${label.round} ${round.round}`,
    "",
    round.summary || "",
    "",
    `##### ${label.long}`,
    bullets(round.long_thesis),
    "",
    `##### ${label.short}`,
    bullets(round.short_thesis),
    "",
    `##### ${label.questions}`,
    bullets(round.questions),
    "",
    `##### ${label.answered}`,
    bullets(round.questions_answered),
    "",
    `##### ${label.raw}`,
    fence(round.raw_text || "", "text"),
  ].join("\n"));
  return [`### ${label.title}`, "", ...blocks].join("\n\n");
}

export function renderDebateMarkdown(agent, language = agent?.language) {
  if (!agent) return "";
  const key = languageKey(language);
  const label = {
    zh: { rating: "评级", winner: "胜方", verdict: "判断", confidence: "置信度", summary: "摘要", long: "多头论据", short: "空头论据", valuation: "估值区间", catalysts: "催化剂", risks: "风险", position: "仓位", invalidation: "失效条件", sources: "来源 ID", report: "报告正文", raw: "原始 worker 响应（仅供审计）", none: "无" },
    en: { rating: "Rating", winner: "Winner", verdict: "Verdict", confidence: "Confidence", summary: "Summary", long: "Long Thesis", short: "Short Thesis", valuation: "Valuation Range", catalysts: "Catalysts", risks: "Risks", position: "Position", invalidation: "Invalidation", sources: "Source IDs", report: "Report Markdown", raw: "Raw Worker Response (audit only)", none: "None" },
    ja: { rating: "評価", winner: "優勢側", verdict: "判断", confidence: "信頼度", summary: "要約", long: "強気論拠", short: "弱気論拠", valuation: "評価レンジ", catalysts: "カタリスト", risks: "リスク", position: "ポジション", invalidation: "無効化条件", sources: "出典 ID", report: "レポート本文", raw: "ワーカーの生応答（監査専用）", none: "なし" },
    ko: { rating: "등급", winner: "우세 측", verdict: "판단", confidence: "신뢰도", summary: "요약", long: "강세 논거", short: "약세 논거", valuation: "가치평가 범위", catalysts: "촉매", risks: "위험", position: "포지션", invalidation: "무효화 조건", sources: "출처 ID", report: "보고서 본문", raw: "원본 워커 응답(감사 전용)", none: "없음" },
  }[key];
  return [
    `## ${agent.role}`,
    "",
    `- ${label.rating}: ${agent.rating}`,
    `- ${label.winner}: ${agent.winner}`,
    `- ${label.verdict}: ${agent.verdict}`,
    `- ${label.confidence}: ${agent.confidence}`,
    agent.thread_id ? `- Visible thread ID: ${agent.thread_id}` : "",
    agent.thread_title ? `- Visible thread title: ${agent.thread_title}` : "",
    "",
    `### ${label.summary}`,
    agent.summary || "",
    "",
    `### ${label.long}`,
    bullets(agent.long_thesis),
    "",
    `### ${label.short}`,
    bullets(agent.short_thesis),
    "",
    `### ${label.valuation}`,
    agent.valuation_range || label.none,
    "",
    `### ${label.catalysts}`,
    bullets(agent.catalysts),
    "",
    `### ${label.risks}`,
    bullets(agent.risks),
    "",
    `### ${label.position}`,
    agent.position || label.none,
    "",
    `### ${label.invalidation}`,
    bullets(agent.invalidation),
    "",
    `### ${label.sources}`,
    bullets(agent.source_ids),
    "",
    `### ${label.report}`,
    agent.report_markdown || "",
    "",
    renderDebateRounds(agent.debate_rounds, language),
    `### ${label.raw}`,
    fence(agent.raw_text || "", "text"),
  ].filter(Boolean).join("\n");
}

export function writeAllAgentsMarkdown(run, debate = {}) {
  const dir = runPath(run.run_id);
  const key = languageKey(run.language);
  const label = {
    zh: { title: "全部代理审计追踪", metadata: "运行元数据", runId: "运行 ID", symbol: "代码", asOf: "截至", language: "语言", execution: "执行模式", visibility: "要求可见", dry: "演练", status: "状态", phase: "阶段", started: "开始", updated: "更新", completed: "完成", tasks: "任务", taskStatus: "证据席状态", debateStatus: "辩论席状态", evidence: "证据分析子代理", masters: "方法席", debate: "多空辩论与组合经理", none: "无" },
    en: { title: "Full Agent Audit Trace", metadata: "Run Metadata", runId: "Run ID", symbol: "Symbol", asOf: "As-of", language: "Language", execution: "Execution mode", visibility: "Visibility required", dry: "Dry run", status: "Status", phase: "Phase", started: "Started", updated: "Updated", completed: "Completed", tasks: "Tasks", taskStatus: "Evidence-Seat Status", debateStatus: "Debate-Seat Status", evidence: "Evidence Analyst Subagents", masters: "Method-Seat Bench", debate: "Bull/Bear Debate and Portfolio Manager", none: "None" },
    ja: { title: "全エージェント監査トレース", metadata: "実行メタデータ", runId: "実行 ID", symbol: "銘柄コード", asOf: "基準日", language: "言語", execution: "実行モード", visibility: "可視性要件", dry: "ドライラン", status: "状態", phase: "フェーズ", started: "開始", updated: "更新", completed: "完了", tasks: "タスク", taskStatus: "証拠席の状態", debateStatus: "討論席の状態", evidence: "証拠分析サブエージェント", masters: "メソッド席", debate: "強気・弱気討論とポートフォリオ管理者", none: "なし" },
    ko: { title: "전체 에이전트 감사 추적", metadata: "실행 메타데이터", runId: "실행 ID", symbol: "종목 코드", asOf: "기준일", language: "언어", execution: "실행 모드", visibility: "가시성 요구", dry: "드라이런", status: "상태", phase: "단계", started: "시작", updated: "갱신", completed: "완료", tasks: "작업", taskStatus: "증거 좌석 상태", debateStatus: "토론 좌석 상태", evidence: "증거 분석 하위 에이전트", masters: "방법론 좌석", debate: "강세·약세 토론 및 포트폴리오 관리자", none: "없음" },
  }[key];
  const taskStatus = run.tasks.map((task) => {
    const state = taskState(run, task);
    return `- ${task}: ${state.status}${state.output ? ` (${state.output})` : ""}${state.error ? ` - ${state.error}` : ""}`;
  }).join("\n");
  const agentStatus = DEBATE_ROLES.map((role) => {
    const state = agentState(run, role);
    return `- ${role}: ${state.status}${state.output ? ` (${state.output})` : ""}${state.error ? ` - ${state.error}` : ""}`;
  }).join("\n");
  const sections = [
    `# AlphaCouncil Agent ${label.title}: ${run.symbol}`,
    "",
    `## ${label.metadata}`,
    "",
    `- ${label.runId}: ${run.run_id}`,
    `- ${label.symbol}: ${run.symbol}`,
    `- ${label.asOf}: ${run.as_of}`,
    `- ${label.language}: ${run.language || "auto"}`,
    `- ${label.execution}: ${run.execution_mode || "background_codex_exec"}`,
    `- ${label.visibility}: ${run.visibility_required || false}`,
    `- ${label.dry}: ${run.dry_run}`,
    `- ${label.status}: ${run.status || "unknown"}`,
    `- ${label.phase}: ${run.phase || "unknown"}`,
    `- ${label.started}: ${run.started_at}`,
    `- ${label.updated}: ${run.updated_at || ""}`,
    `- ${label.completed}: ${run.completed_at || ""}`,
    `- ${label.tasks}: ${run.tasks.join(", ")}`,
    "",
    `## ${label.taskStatus}`,
    "",
    taskStatus || `- ${label.none}`,
    "",
    `## ${label.debateStatus}`,
    "",
    agentStatus || `- ${label.none}`,
    "",
    `# ${label.evidence}`,
    "",
    ...run.packets.map((packet, index) => renderPacketMarkdown(packet, index, run.language)),
  ];
  const opinions = run.master_opinions || [];
  if (opinions.length) {
    sections.push(
      "",
      `# ${label.masters}`,
      "",
      renderBenchSummary(run),
      "",
      ...opinions.map((opinion) => renderMasterMarkdown(opinion, run.language)),
    );
  }
  if (debate.bull || debate.bear || debate.manager) {
    sections.push(
      "",
      `# ${label.debate}`,
      "",
      renderDebateMarkdown(debate.bull, run.language),
      "",
      renderDebateMarkdown(debate.bear, run.language),
      "",
      renderDebateMarkdown(debate.manager, run.language),
    );
  }
  const path = join(dir, "all_agents.md");
  writeFileSync(path, `${sections.filter(Boolean).join("\n\n")}\n`);
  return path;
}

export function writeAnalystMarkdownFiles(run, debate = {}) {
  const dir = runPath(run.run_id);
  for (const [index, packet] of (run.packets || []).entries()) {
    writeFileSync(join(dir, `${packet.task}.md`), `${renderPacketMarkdown(packet, index, run.language)}\n`);
  }
  const debateFiles = [
    ["bull_researcher", debate.bull],
    ["bear_researcher", debate.bear],
    ["portfolio_manager", debate.manager],
  ];
  for (const [role, packet] of debateFiles) {
    if (packet) writeFileSync(join(dir, `${role}.md`), `${renderDebateMarkdown({ ...packet, role }, run.language)}\n`);
  }
  for (const opinion of run.master_opinions || []) {
    writeFileSync(join(dir, `${opinion.master}.md`), `${renderMasterMarkdown(opinion, run.language)}\n`);
  }
}

export function writeReportQuality(run, markdown) {
  const quality = validateFinalReport(markdown, run);
  run.report_quality = quality;
  writeJson(join(runPath(run.run_id), "report_quality.json"), quality);
  return quality;
}

// Shared with the quality gate through constants so the gate can find the system-owned
// section by anchor instead of by heading text. See the note next to the constants.

function recordedBenchMarker(run) {
  const subject = (run?.master_opinions || []).map((opinion) => ({
    confidence: String(opinion?.confidence || "low"),
    master: String(opinion?.master || ""),
    stance: String(opinion?.stance || "unknown"),
    summary: String(opinion?.summary || ""),
    verdict: String(opinion?.verdict || ""),
    voice_statement: String(opinion?.voice_statement || ""),
    voice_status: String(opinion?.voice_status || ""),
  }));
  return `<!-- ${RECORDED_BENCH_MARKER_PREFIX}${sha256(subject)} -->`;
}

function isMasterBenchHeading(title) {
  const normalized = normalizeHeading(title);
  const section = REPORT_SECTIONS.find(({ id }) => id === "master_bench");
  return Boolean(normalized && section?.aliases.some((alias) => headingIncludesAlias(title, alias)));
}

function isInstrumentStructureHeading(title) {
  const normalized = normalizeHeading(title);
  const section = REPORT_SECTIONS.find(({ id }) => id === "instrument_structure");
  return Boolean(normalized && section?.aliases.some((alias) => headingIncludesAlias(title, alias)));
}

/**
 * Own the ETF/index structure section at the deterministic system boundary.
 *
 * PM prose may discuss a fund, but it cannot turn a fund into an operating company. The
 * classifier owns the research route and any PM-authored section is retained as commentary.
 */
function withRecordedInstrumentStructure(run, markdown) {
  const instrument = run?.grounding?.instrument;
  if (!isFundOrIndex(instrument)) return String(markdown || "");
  const body = String(markdown || "");
  const lines = body.split(/\r?\n/);
  const headings = parseHeadings(body);
  const removals = [];
  const commentaryTitle = localized(run.language, {
    zh: "PM 对资产研究路径的叙述（非系统记录）",
    en: "PM Commentary on the Instrument Research Path (non-authoritative)",
    ja: "PMによる銘柄調査経路の説明（非公式記録）",
    ko: "PM의 종목 조사 경로 설명(비공식 기록)",
  });
  for (const [index, heading] of headings.entries()) {
    if (heading.level > 2 || !isInstrumentStructureHeading(heading.title)) continue;
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const start = heading.line - 1;
    const end = next ? next.line - 1 : lines.length;
    if (heading.body.includes(`<!-- ${RECORDED_INSTRUMENT_MARKER_PREFIX}`)) removals.push([start, end]);
    else lines[start] = `${"#".repeat(heading.level)} ${commentaryTitle}`;
  }
  for (const [start, end] of removals.sort((left, right) => right[0] - left[0])) {
    lines.splice(start, end - start);
  }

  const copy = {
    zh: {
      heading: "## 基金与指数结构", asset: "资产类型", model: "研究模型", source: "分类依据", raw: "数据源原始类型", company: "经营公司财务路径", noCompany: "不适用；不得把基金或指数当作经营公司读取营收、公司 EPS、管理层指引或 Form 4", required: "强制研究项目", requirements: instrument.index_like
        ? "指数方法、带时点的成分与权重、集中度、行业/因子暴露、广度、再平衡、聚合盈利与估值口径、宏观敏感度，以及可用的衍生品定位"
        : "跟踪指数与方法、带时点的持仓和权重、前十大及行业集中度、费用率、规模、流动性、溢折价或跟踪差、资金流、借贷/衍生品、再平衡、税务结构与持仓穿透基本面",
      aggregation: "聚合纪律", aggregationRule: "必须披露同日口径和覆盖权重；不得把少数成分股相加成基金或指数自身的营收、EPS或现金流", notApplicable: "明确不适用项",
    },
    en: {
      heading: "## Fund and Index Structure", asset: "Asset type", model: "Research model", source: "Classification source", raw: "Raw feed type", company: "Operating-company financial route", noCompany: "not applicable; do not treat a fund or index as a company with its own revenue, company EPS, management guidance or Form 4 activity", required: "Required research", requirements: instrument.index_like
        ? "index methodology, dated constituents and weights, concentration, sector/factor exposures, breadth, rebalances, aggregate earnings and valuation methodology, macro sensitivity, and listed-derivative positioning when available"
        : "tracked index and methodology, dated holdings and weights, top-ten and sector concentration, fee, AUM, liquidity, premium/discount or tracking difference, flows, lending/derivatives, rebalances, tax structure, and holdings-level fundamental look-through",
      aggregation: "Aggregation discipline", aggregationRule: "state one-date methodology and coverage weight; never add a few constituents into fund or index revenue, EPS, or cash flow", notApplicable: "Explicitly not applicable",
    },
    ja: {
      heading: "## ファンドと指数の構造", asset: "資産タイプ", model: "調査モデル", source: "分類根拠", raw: "データ源の原分類", company: "事業会社の財務経路", noCompany: "適用外。ファンドや指数を、固有の売上高・企業EPS・経営陣ガイダンス・Form 4を持つ事業会社として扱わない", required: "必須調査項目", requirements: instrument.index_like
        ? "指数算出方法、基準日付き構成銘柄とウェイト、集中度、業種・ファクター、ブレッドス、リバランス、集計利益・評価方法、マクロ感応度、利用可能なデリバティブ需給"
        : "連動指数と方法、基準日付き保有銘柄とウェイト、上位10銘柄・業種集中度、経費率、純資産、流動性、乖離・トラッキング差、資金フロー、貸株・デリバティブ、リバランス、税制、保有銘柄ルックスルー",
      aggregation: "集計規律", aggregationRule: "同一基準日の方法とカバーウェイトを明記し、一部構成銘柄を足してファンド・指数固有の売上高、EPS、CFにしない", notApplicable: "明示的な適用外項目",
    },
    ko: {
      heading: "## 펀드와 지수 구조", asset: "자산 유형", model: "조사 모델", source: "분류 근거", raw: "데이터 소스 원본 유형", company: "영업회사 재무 경로", noCompany: "적용되지 않음. 펀드나 지수를 자체 매출, 기업 EPS, 경영진 가이던스 또는 Form 4가 있는 영업회사로 취급하지 않음", required: "필수 조사 항목", requirements: instrument.index_like
        ? "지수 방법론, 기준일이 있는 구성 종목과 비중, 집중도, 섹터·팩터 노출, 시장 폭, 리밸런싱, 집계 이익·밸류에이션 방법, 거시 민감도 및 가능한 파생상품 포지셔닝"
        : "추종 지수와 방법론, 기준일이 있는 보유 종목과 비중, 상위 10개·섹터 집중도, 보수, AUM, 유동성, 괴리율·추적 차이, 자금 흐름, 대차·파생상품, 리밸런싱, 세금 구조 및 보유 종목 룩스루",
      aggregation: "집계 원칙", aggregationRule: "동일 기준일 방법론과 커버 비중을 밝히며 일부 구성 종목을 더해 펀드·지수 자체 매출, EPS 또는 현금흐름으로 만들지 않음", notApplicable: "명시적 적용 제외",
    },
  }[languageKey(run.language)];
  const notApplicable = (run?.grounding?.not_applicable || []).length
    ? run.grounding.not_applicable.map((item) => `  - ${item}`).join("\n")
    : "  - —";
  const marker = `<!-- ${RECORDED_INSTRUMENT_MARKER_PREFIX}${sha256({ instrument, not_applicable: run?.grounding?.not_applicable || [] })} -->`;
  const systemSection = [
    copy.heading,
    "",
    marker,
    `- ${copy.asset}: ${instrument.asset_type}`,
    `- ${copy.model}: ${instrument.research_model}`,
    `- ${copy.source}: ${instrument.classification_source}`,
    `- ${copy.raw}: ${instrument.raw_instrument_type || "unknown"}`,
    `- ${copy.company}: ${copy.noCompany}`,
    `- ${copy.required}: ${copy.requirements}`,
    `- ${copy.aggregation}: ${copy.aggregationRule}`,
    `- ${copy.notApplicable}:`,
    notApplicable,
  ].join("\n");
  const cleaned = lines.join("\n").trimEnd();
  return `${cleaned ? `${cleaned}\n\n` : ""}${systemSection}\n`;
}

/**
 * Make the recorded Master Bench a system-owned section.
 *
 * PM prose is untrusted narrative: even a long section can omit or contradict the opinions
 * frozen on the run. Existing PM bench headings are therefore relabelled as commentary,
 * while a previously generated system section is replaced. This preserves useful prose,
 * leaves exactly one quality-gate-visible bench and makes repeated assembly idempotent.
 */
function withRecordedMasterBench(run, markdown) {
  const body = String(markdown || "");
  if (!(run?.master_opinions || []).length) return body;
  const lines = body.split(/\r?\n/);
  const headings = parseHeadings(body);
  const removals = [];
  const commentaryTitle = localized(run.language, {
    zh: "PM 对方法席位的叙述（非系统记录）",
    en: "PM Commentary on Method Seats (non-authoritative)",
    ja: "PMによるメソッド席の説明（非公式記録）",
    ko: "PM의 방법론 좌석 설명(비공식 기록)",
  });

  for (const [index, heading] of headings.entries()) {
    // Only a publication section can own the bench. Localized per-seat subheadings such as
    // Japanese "メソッド席" may contain a bench alias, but they are level 3+ details and
    // must not be scheduled for a second overlapping removal during idempotent assembly.
    if (heading.level > 2 || !isMasterBenchHeading(heading.title)) continue;
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const start = heading.line - 1;
    const end = next ? next.line - 1 : lines.length;
    if (heading.body.includes(`<!-- ${RECORDED_BENCH_MARKER_PREFIX}`)) {
      removals.push([start, end]);
    } else {
      lines[start] = `${"#".repeat(heading.level)} ${commentaryTitle}`;
    }
  }

  for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) {
    lines.splice(start, end - start);
  }
  const cleaned = lines.join("\n").trimEnd();
  const heading = localized(run.language, {
    zh: "## 大师席位",
    en: "## Master Bench",
    ja: "## マスター・ベンチ",
    ko: "## 마스터 벤치",
  });
  const systemBench = `${heading}\n\n${recordedBenchMarker(run)}\n\n${renderBenchSummary(run)}\n\n${renderMasterStatements(run)}`;
  return `${cleaned ? `${cleaned}\n\n` : ""}${systemBench}\n`;
}

function withRecordedPriceSnapshot(run, markdown) {
  const markerStart = "<!-- alphacouncil:recorded-price-snapshot:v1:begin -->";
  const markerEnd = "<!-- alphacouncil:recorded-price-snapshot:v1:end -->";
  let cleaned = String(markdown || "");
  let start = cleaned.indexOf(markerStart);
  while (start !== -1) {
    const end = cleaned.indexOf(markerEnd, start + markerStart.length);
    cleaned = end === -1
      ? cleaned.slice(0, start)
      : `${cleaned.slice(0, start)}${cleaned.slice(end + markerEnd.length)}`;
    start = cleaned.indexOf(markerStart);
  }
  const quote = run?.grounding?.quote;
  const key = languageKey(run?.language);
  const heading = { zh: "## 系统记录价格快照", en: "## System-Recorded Price Snapshot", ja: "## システム記録価格スナップショット", ko: "## 시스템 기록 가격 스냅샷" }[key];
  const unavailable = { zh: "本轮未取得可验证报价；不得补造价格。", en: "No verifiable quote was retrieved; no price was invented.", ja: "検証可能な価格を取得できなかったため、価格は補完していません。", ko: "검증 가능한 시세를 가져오지 못했으며 가격을 임의로 만들지 않았습니다." }[key];
  const label = {
    zh: { symbol: "代码", price: "价格", change: "涨跌", time: "报价时间", exchange: "交易所", feed: "数据源", source: "原始链接", unknown: "未知", unavailable: "不可用", delayed: "延迟数据" },
    en: { symbol: "Symbol", price: "Price", change: "Change", time: "Quote time", exchange: "Exchange", feed: "Feed", source: "Source", unknown: "unknown", unavailable: "unavailable", delayed: "delayed data" },
    ja: { symbol: "銘柄コード", price: "価格", change: "騰落", time: "価格時刻", exchange: "取引所", feed: "データ源", source: "原典リンク", unknown: "不明", unavailable: "取得不可", delayed: "遅延データ" },
    ko: { symbol: "종목 코드", price: "가격", change: "등락", time: "시세 시각", exchange: "거래소", feed: "데이터 소스", source: "원문 링크", unknown: "알 수 없음", unavailable: "확인 불가", delayed: "지연 데이터" },
  }[key];
  const body = quote && Number.isFinite(Number(quote.price))
    ? [
      `- ${label.symbol}: ${quote.symbol || run.symbol}`,
      `- ${label.price}: ${quote.price} ${quote.currency || ""}`.trimEnd(),
      `- ${label.change}: ${quote.change ?? label.unavailable} (${quote.change_pct ?? label.unavailable}%)`,
      `- ${label.time}: ${quote.quote_time || label.unknown}`,
      `- ${label.exchange}: ${quote.exchange || label.unknown}`,
      `- ${label.feed}: ${quote.source || label.unknown}; ${quote.note || label.delayed}`,
      `- ${label.source}: ${quote.source_url || label.unavailable}`,
    ].join("\n")
    : `- ${unavailable}`;
  return `${cleaned.trimEnd()}\n\n${markerStart}\n${heading}\n\n${body}\n${markerEnd}\n`;
}

function withDegradedLedger(run, markdown, completeness) {
  const markerStart = "<!-- alphacouncil:degraded-ledger:v1:begin -->";
  const markerEnd = "<!-- alphacouncil:degraded-ledger:v1:end -->";
  let cleaned = String(markdown || "");
  let start = cleaned.indexOf(markerStart);
  while (start !== -1) {
    const end = cleaned.indexOf(markerEnd, start + markerStart.length);
    cleaned = end === -1
      ? cleaned.slice(0, start)
      : `${cleaned.slice(0, start)}${cleaned.slice(end + markerEnd.length)}`;
    start = cleaned.indexOf(markerStart);
  }
  const tasks = completeness.degraded_evidence || [];
  const roles = completeness.degraded_debate || [];
  if (!tasks.length && !roles.length) return cleaned;
  const key = languageKey(run.language);
  const unavailable = { zh: "证据不可用", en: "evidence unavailable", ja: "証拠を取得できません", ko: "증거를 확보하지 못함" }[key];
  const debateUnavailable = { zh: "辩论席不可用", en: "debate seat unavailable", ja: "討論席を利用できません", ko: "토론 좌석을 사용할 수 없음" }[key];
  const deadlineText = { zh: "全局时限耗尽", en: "global deadline exhausted", ja: "全体期限を超過", ko: "전체 기한 소진" }[key];
  const rows = [
    ...tasks.map((task) => {
      const state = taskState(run, task);
      return `- ${task}: ${state.status}; ${state.error || unavailable}${state.deadline_exhausted ? `; ${deadlineText}` : ""}`;
    }),
    ...roles.map((role) => {
      const state = agentState(run, role);
      return `- ${role}: ${state.status}; ${state.error || debateUnavailable}`;
    }),
  ].join("\n");
  const intro = {
    zh: "**QUICK 运行已降级——一个或多个席位失败。** 报告结构可能通过质量检查，但下列席位没有提供可用证据；本轮不代表完整覆盖：",
    en: "**DEGRADED QUICK RUN — one or more seats failed.** The report structure may pass quality checks, but the following seats supplied no usable evidence and this run is not full coverage:",
    ja: "**QUICK 実行は縮退しました——1つ以上の席が失敗しました。** レポート構造が品質検査を通っても、次の席は利用可能な証拠を提供していないため、完全な網羅ではありません：",
    ko: "**QUICK 실행 성능 저하—하나 이상의 좌석이 실패했습니다.** 보고서 구조가 품질 검사를 통과해도 다음 좌석은 사용 가능한 증거를 제공하지 않았으므로 전체 범위를 대표하지 않습니다:",
  }[key];
  const banner = `> [!WARNING]\n> ${intro}\n>\n${rows.split("\n").map((line) => `> ${line}`).join("\n")}`;
  return `${markerStart}\n${banner}\n${markerEnd}\n\n${cleaned.trimStart()}`;
}

function withQuickScope(run, markdown) {
  const markerStart = "<!-- alphacouncil:quick-scope:v1:begin -->";
  const markerEnd = "<!-- alphacouncil:quick-scope:v1:end -->";
  let cleaned = String(markdown || "");
  let start = cleaned.indexOf(markerStart);
  while (start !== -1) {
    const end = cleaned.indexOf(markerEnd, start + markerStart.length);
    cleaned = end === -1
      ? cleaned.slice(0, start)
      : `${cleaned.slice(0, start)}${cleaned.slice(end + markerEnd.length)}`;
    start = cleaned.indexOf(markerStart);
  }
  if (run.council_mode !== "quick") return cleaned;
  const copy = {
    zh: "**QUICK_V1 范围。** 本轮不是 full council：固定 4 个核心证据席、1–4 个方法席、一次并行多空陈述和短 PM；没有三轮交叉问答或对抗核验。`full_council_equivalent=false`。",
    en: "**QUICK_V1 SCOPE.** This is not a full council: four fixed core evidence seats, one to four method seats, one parallel bull/bear statement and a short PM; no three-round cross-exam or adversarial verifier. `full_council_equivalent=false`.",
    ja: "**QUICK_V1 の範囲。** full council ではありません。固定4つの中核証拠席、1〜4のメソッド席、強気・弱気の並列1ラウンド、短いPMのみで、3ラウンドの交差質問や対抗検証はありません。`full_council_equivalent=false`。",
    ko: "**QUICK_V1 범위.** full council이 아닙니다. 고정된 4개 핵심 증거 좌석, 1~4개 방법론 좌석, 병렬 강세·약세 1라운드와 짧은 PM만 실행하며 3라운드 교차 질문이나 적대적 검증은 없습니다. `full_council_equivalent=false`.",
  }[languageKey(run.language)];
  const banner = `> [!NOTE]\n> ${copy}`;
  return `${markerStart}\n${banner}\n${markerEnd}\n\n${cleaned.trimStart()}`;
}

export function finalReportMarkdown(run, manager) {
  const gate = verificationStatus(run);
  const completeness = completenessStatus(run);
  const reportBody = withRecordedMasterBench(
    run,
    withRecordedInstrumentStructure(
      run,
      withRecordedPriceSnapshot(run, manager.report_markdown || manager.summary),
    ),
  );
  return withDisclaimer(
    withCompletenessBanner(
      withQuickScope(
        run,
        withDegradedLedger(run, withVerificationBanner(reportBody, gate, run.language), completeness),
      ),
      completeness,
      run.language
    ),
    run.language
  );
}

export function writeArtifactIndex(run, debate = {}) {
  const artifacts = artifactPaths(run);
  const key = languageKey(run.language);
  const label = {
    zh: { title: "AlphaCouncil 工件索引", run: "运行 ID", status: "状态", quality: "报告质量", main: "主要文件", final: "最终报告", handoff: "聊天交接摘要", trace: "全部代理审计追踪", evidence: "证据 JSON", decision: "决策 JSON", sources: "来源清单", statusFile: "状态", events: "事件", qualityFile: "报告质量", analysts: "分析师 Markdown 文件", masters: "方法席 Markdown 文件" },
    en: { title: "AlphaCouncil Artifact Index", run: "Run ID", status: "Status", quality: "Report quality", main: "Main Files", final: "Final report", handoff: "Chat handoff summary", trace: "Full agent audit trace", evidence: "Evidence JSON", decision: "Decision JSON", sources: "Source manifest", statusFile: "Status", events: "Events", qualityFile: "Report quality", analysts: "Analyst Markdown Files", masters: "Method-Seat Markdown Files" },
    ja: { title: "AlphaCouncil 成果物索引", run: "実行 ID", status: "状態", quality: "レポート品質", main: "主要ファイル", final: "最終レポート", handoff: "チャット引継ぎ要約", trace: "全エージェント監査トレース", evidence: "証拠 JSON", decision: "判断 JSON", sources: "出典一覧", statusFile: "状態", events: "イベント", qualityFile: "レポート品質", analysts: "分析担当 Markdown ファイル", masters: "メソッド席 Markdown ファイル" },
    ko: { title: "AlphaCouncil 산출물 색인", run: "실행 ID", status: "상태", quality: "보고서 품질", main: "주요 파일", final: "최종 보고서", handoff: "채팅 인계 요약", trace: "전체 에이전트 감사 추적", evidence: "증거 JSON", decision: "판단 JSON", sources: "출처 목록", statusFile: "상태", events: "이벤트", qualityFile: "보고서 품질", analysts: "분석가 Markdown 파일", masters: "방법론 좌석 Markdown 파일" },
  }[key];
  const lines = [
    `# ${run.symbol} ${label.title}`,
    "",
    `- ${label.run}: ${run.run_id}`,
    `- ${label.status}: ${run.status}`,
    `- ${label.quality}: ${run.report_quality?.status || "not_checked"}`,
    "",
    `## ${label.main}`,
    "",
    `- ${label.final}: ${artifacts.final_report_md}`,
    `- ${label.handoff}: ${artifacts.user_response_md}`,
    `- ${label.trace}: ${artifacts.all_agents_md}`,
    `- ${label.evidence}: ${artifacts.evidence_json}`,
    `- ${label.decision}: ${artifacts.decision_json}`,
    `- ${label.sources}: ${artifacts.source_manifest_json}`,
    `- ${label.statusFile}: ${artifacts.status_json}`,
    `- ${label.events}: ${artifacts.events_jsonl}`,
    `- ${label.qualityFile}: ${artifacts.report_quality_json}`,
    "",
    `## ${label.analysts}`,
    "",
    ...(run.tasks || []).map((task) => `- ${task}: ${artifacts.analyst_markdown[task]}`),
    debate.bull ? `- bull_researcher: ${artifacts.analyst_markdown.bull_researcher}` : "",
    debate.bear ? `- bear_researcher: ${artifacts.analyst_markdown.bear_researcher}` : "",
    debate.manager ? `- portfolio_manager: ${artifacts.analyst_markdown.portfolio_manager}` : "",
    ...((run.master_opinions || []).length
      ? ["", `## ${label.masters}`, "",
        ...(run.master_opinions || []).map((o) => `- ${o.master} (${o.stance || "unknown"}): ${join(runPath(run.run_id), `${o.master}.md`)}`)]
      : []),
  ].filter(Boolean);
  writeFileSync(artifacts.artifact_index_md, `${lines.join("\n")}\n`);
  return artifacts.artifact_index_md;
}

export function packetSummary(run, task) {
  return (run.packets || []).find((packet) => packet.task === task)?.summary || "";
}

function quickUserResponse(run, manager, artifacts, chinese) {
  const managerCompleted = agentState(run, "portfolio_manager").status === "completed"
    && manager?.decision_available !== false;
  const masters = (run.master_opinions || []).map((opinion) =>
    `- ${masterTitle(opinion.master, run.language)} (\`${opinion.master}\`) — ${opinion.stance || "unknown"}, ${opinion.confidence || "low"}: ${clipAtBoundary(opinion.voice_statement || opinion.summary || opinion.verdict, 360)}`,
  ).join("\n") || (chinese ? "- 没有已记录的方法席结论。" : "- No recorded method-seat conclusion.");
  const analysts = (run.tasks || []).map((task) => {
    const packet = (run.packets || []).find((item) => item.task === task);
    const status = taskState(run, task).status;
    return `- \`${task}\` [${status}/${packet?.confidence || "low"}]: ${clipAtBoundary(packet?.summary || "", 420) || (chinese ? "无可用证据。" : "No usable evidence.")}`;
  }).join("\n");
  const newsPacket = (run.packets || []).find((packet) => packet.task === "news_industry_management");
  const asOfTime = Date.parse(`${String(run.as_of || "").slice(0, 10)}T23:59:59.999Z`);
  const recentCutoff = Number.isFinite(asOfTime) ? asOfTime - (120 * 24 * 60 * 60 * 1000) : -Infinity;
  const newsSources = (newsPacket?.sources || []).slice();
  const excludedNews = { undated: 0, future: 0, stale: 0 };
  const recentNewsSources = newsSources.filter((source) => {
    const published = Date.parse(source?.published_at || "");
    if (!Number.isFinite(published)) { excludedNews.undated += 1; return false; }
    if (Number.isFinite(asOfTime) && published > asOfTime) { excludedNews.future += 1; return false; }
    if (Number.isFinite(asOfTime) && published < recentCutoff) { excludedNews.stale += 1; return false; }
    return true;
  });
  const datedNews = recentNewsSources
    .sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")))
    .slice(0, 6)
    .map((source) => `- ${source.published_at || "unknown"} — ${clipAtBoundary(source.title || "Untitled", 220)}${source.url ? ` — ${source.url}` : ""}`)
    .join("\n") || (chinese ? "- 本轮没有取得带日期的公司/行业新闻来源。" : "- No dated company/industry news source was retrieved.");
  const gaps = [...new Set([
    ...(run.tasks || []).filter((task) => taskState(run, task).status !== "completed")
      .map((task) => `${task}: ${taskState(run, task).error || taskState(run, task).status}`),
    ...(run.packets || []).flatMap((packet) => packet.open_questions || []),
    ...((excludedNews.undated || excludedNews.future || excludedNews.stale)
      ? [chinese
          ? `近期新闻门禁排除 ${excludedNews.undated + excludedNews.future + excludedNews.stale} 个来源：无日期 ${excludedNews.undated}、晚于 as_of ${excludedNews.future}、超过 120 天 ${excludedNews.stale}。`
          : `Recent-news gate excluded ${excludedNews.undated + excludedNews.future + excludedNews.stale} source(s): ${excludedNews.undated} undated, ${excludedNews.future} after as_of, ${excludedNews.stale} older than 120 days.`]
      : []),
  ])].slice(0, 8).map((item) => `- ${clipAtBoundary(item, 360)}`).join("\n")
    || (chinese ? "- 未记录额外缺口。" : "- No additional gap was recorded.");

  return chinese ? [
    `# ${run.symbol} AlphaCouncil 快速摘要`,
    "",
    "## 状态与边界",
    `- Run status: ${run.status}`,
    `- Report quality: ${run.report_quality?.status || "not_checked"} (${run.report_quality?.contract_id || "quick_v1"})`,
    "- 这是 quick_v1：4 个核心证据席、所选方法席、一次并行多空陈述和短 PM；没有三轮交叉问答或对抗核验，不等同 full council。",
    "",
    "## 结论",
    `- 评级: ${managerCompleted ? manager.rating : "unavailable"}`,
    `- 多空胜负: ${managerCompleted ? (manager.winner || "unknown") : "unavailable"}`,
    `- 置信度: ${managerCompleted ? (manager.confidence || "low") : "unavailable"}`,
    `- 判断: ${managerCompleted ? clipAtBoundary(manager.verdict || manager.summary, 620) : "NEEDS_MANAGER_REVIEW；工具或经理综合未完成，不能从失败路径推导投资评级。"}`,
    "",
    "## 大师方法席本轮记录（不是大师本人引语）",
    masters,
    "",
    "## 分析师逐席观点",
    analysts,
    "",
    "## 近期公司与行业新闻",
    `- 新闻席摘要: ${clipAtBoundary(newsPacket?.summary || "", 620) || "未覆盖。"}`,
    datedNews,
    "",
    "## 估值与仓位",
    `- 估值/价位: ${managerCompleted ? (clipAtBoundary(manager.valuation_range, 520) || "未覆盖。") : "unavailable"}`,
    `- 仓位: ${managerCompleted ? (clipAtBoundary(manager.position, 420) || "未覆盖。") : "unavailable"}`,
    "",
    "## 风险、未知与失败席",
    gaps,
    "",
    "## 文件位置",
    `- 完整快速报告: ${artifacts.final_report_md}`,
    `- 分析师全文索引: ${artifacts.artifact_index_md}`,
    `- 全部代理追踪: ${artifacts.all_agents_md}`,
    `- 报告质量检查: ${artifacts.report_quality_json}`,
  ].join("\n") : [
    `# ${run.symbol} AlphaCouncil Quick Summary`,
    "",
    "## Status and Scope",
    `- Run status: ${run.status}`,
    `- Report quality: ${run.report_quality?.status || "not_checked"} (${run.report_quality?.contract_id || "quick_v1"})`,
    "- This is quick_v1: four core evidence seats, selected method seats, one parallel bull/bear statement and a short PM. It has no three-round cross-exam or adversarial verification and is not equivalent to full council.",
    "",
    "## Conclusion",
    `- Rating: ${managerCompleted ? manager.rating : "unavailable"}`,
    `- Debate winner: ${managerCompleted ? (manager.winner || "unknown") : "unavailable"}`,
    `- Confidence: ${managerCompleted ? (manager.confidence || "low") : "unavailable"}`,
    `- Judgment: ${managerCompleted ? clipAtBoundary(manager.verdict || manager.summary, 620) : "NEEDS_MANAGER_REVIEW; a tool or manager-synthesis failure cannot be converted into an investment rating."}`,
    "",
    "## Recorded Method-Seat Views (not quotes from the named people)",
    masters,
    "",
    "## Analyst Views",
    analysts,
    "",
    "## Recent Company and Industry News",
    `- News-seat summary: ${clipAtBoundary(newsPacket?.summary || "", 620) || "Not covered."}`,
    datedNews,
    "",
    "## Valuation and Position",
    `- Valuation / price range: ${managerCompleted ? (clipAtBoundary(manager.valuation_range, 520) || "Not covered.") : "unavailable"}`,
    `- Position: ${managerCompleted ? (clipAtBoundary(manager.position, 420) || "Not covered.") : "unavailable"}`,
    "",
    "## Risks, Unknowns and Failed Seats",
    gaps,
    "",
    "## File Locations",
    `- Full quick report: ${artifacts.final_report_md}`,
    `- Analyst file index: ${artifacts.artifact_index_md}`,
    `- Full agent trace: ${artifacts.all_agents_md}`,
    `- Report quality check: ${artifacts.report_quality_json}`,
  ].join("\n");
}

function legacyUserResponseMarkdown(run, manager) {
  const chinese = isChineseLanguage(run.language);
  const artifacts = artifactPaths(run);
  const decisionAvailable = manager?.decision_available !== false;
  const invalidation = decisionAvailable
    ? (manager.invalidation || []).slice(0, 3).map((item) => `- ${clipAtBoundary(item, 220)}`).join("\n") || "- None"
    : (chinese ? "- 经理综合未完成；没有正式失效条件。" : "- Manager synthesis did not complete; no formal invalidation conditions are available.");
  if (run.council_mode === "quick") return quickUserResponse(run, manager, artifacts, chinese);
  if (chinese) {
    return [
      `# ${run.symbol} AlphaCouncil 摘要`,
      "",
      "## 结论",
      `- 评级: ${decisionAvailable ? manager.rating : "unavailable"}`,
      `- 多空胜负: ${decisionAvailable ? (manager.winner || "unknown") : "unavailable"}`,
      `- 置信度: ${decisionAvailable ? (manager.confidence || "low") : "unavailable"}`,
      `- 判断: ${decisionAvailable ? clipAtBoundary(manager.verdict || manager.summary, 620) : "NEEDS_MANAGER_REVIEW；工具或经理综合失败不能转换成投资评级。"}`,
      "",
      "## 关键内容",
      `- 最新财报: ${clipAtBoundary(packetSummary(run, "earnings_deep_dive"), 420) || "未覆盖。"}`,
      `- 前瞻门槛: ${clipAtBoundary(packetSummary(run, "forward_expectations"), 420) || "未覆盖。"}`,
      `- 新闻/行业信号: ${clipAtBoundary([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join(" "), 520) || "未覆盖。"}`,
      `- 估值/价位: ${decisionAvailable ? (clipAtBoundary(manager.valuation_range, 520) || "未覆盖。") : "unavailable"}`,
      `- 仓位: ${decisionAvailable ? (clipAtBoundary(manager.position, 420) || "未覆盖。") : "unavailable"}`,
      "",
      "## 失效条件",
      invalidation,
      "",
      "## 文件位置",
      `- 完整报告: ${artifacts.final_report_md}`,
      `- 分析师全文索引: ${artifacts.artifact_index_md}`,
      `- 全部代理追踪: ${artifacts.all_agents_md}`,
      `- 报告质量检查: ${artifacts.report_quality_json}`,
    ].join("\n");
  }
  return [
    `# ${run.symbol} AlphaCouncil Summary`,
    "",
    "## Conclusion",
    `- Rating: ${decisionAvailable ? manager.rating : "unavailable"}`,
    `- Debate winner: ${decisionAvailable ? (manager.winner || "unknown") : "unavailable"}`,
    `- Confidence: ${decisionAvailable ? (manager.confidence || "low") : "unavailable"}`,
    `- Judgment: ${decisionAvailable ? clipAtBoundary(manager.verdict || manager.summary, 620) : "NEEDS_MANAGER_REVIEW; a tool or manager-synthesis failure cannot be converted into an investment rating."}`,
    "",
    "## Key Content",
    `- Latest earnings: ${clipAtBoundary(packetSummary(run, "earnings_deep_dive"), 420) || "Not covered."}`,
    `- Forward thresholds: ${clipAtBoundary(packetSummary(run, "forward_expectations"), 420) || "Not covered."}`,
    `- News / industry signal: ${clipAtBoundary([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join(" "), 520) || "Not covered."}`,
    `- Valuation / price range: ${decisionAvailable ? (clipAtBoundary(manager.valuation_range, 520) || "Not covered.") : "unavailable"}`,
    `- Position: ${decisionAvailable ? (clipAtBoundary(manager.position, 420) || "Not covered.") : "unavailable"}`,
    "",
    "## Invalidation",
    invalidation,
    "",
    "## File Locations",
    `- Full report: ${artifacts.final_report_md}`,
    `- Analyst file index: ${artifacts.artifact_index_md}`,
    `- Full agent trace: ${artifacts.all_agents_md}`,
    `- Report quality check: ${artifacts.report_quality_json}`,
  ].join("\n");
}

function handoffCopy(language) {
  return {
    zh: {
      title: "AlphaCouncil 运行摘要", status: "运行状态与时限", statusLabel: "状态", contract: "报告契约", scope: "执行范围", elapsed: "耗时", deadline: "硬截止时间", deadlineMet: "是否在截止前落盘",
      fullScope: "full_v2：8 个证据席、全部已选方法席的可审计终局陈词、三轮多空交叉问答和 PM；插件托管运行硬上限 30 分钟。", quickScope: "quick_v1：4 个证据席、1–4 个方法席、单轮多空和短 PM；不等同 full council。",
      price: "系统记录价格", noPrice: "未取得可验证报价；没有补造价格。", delayed: "延迟行情", instrument: "资产识别与研究路径", assetType: "资产类型", researchModel: "研究模型", classifiedBy: "识别来源", conclusion: "结论", rating: "评级", winner: "多空胜负", confidence: "置信度", judgment: "判断", noDecision: "NEEDS_MANAGER_REVIEW；工具或 PM 失败不能转换成投资评级。",
      masters: "结尾：逐席方法陈词（不是本人引语）", analysts: "分析师逐席内容", worker: "陈词来源", record: "冻结记录", key: "关键内容", earnings: "最新财报", forward: "前瞻门槛", news: "新闻/行业信号", recentNews: "近期公司与行业新闻", newsSummary: "新闻席摘要", noDatedNews: "本轮没有取得 as_of 之前 120 天内且带日期的新闻来源。", newsExcluded: "新闻时间门禁排除", valuation: "估值/价位", position: "仓位", gaps: "数据缺口与失败席", invalidation: "失效条件", files: "文件位置", report: "完整报告", index: "代理工件索引", trace: "全部代理追踪", quality: "报告质量检查", missing: "未覆盖。", noGaps: "未记录额外缺口。", noInvalidation: "没有正式失效条件。",
    },
    en: {
      title: "AlphaCouncil Run Summary", status: "Run Status and Deadline", statusLabel: "Status", contract: "Report contract", scope: "Execution scope", elapsed: "Elapsed", deadline: "Hard deadline", deadlineMet: "Persisted before deadline",
      fullScope: "full_v2: eight evidence seats, an auditable final statement for every selected method seat, three-round cross-examination and PM; plugin-managed runs have a hard thirty-minute ceiling.", quickScope: "quick_v1: four evidence seats, one to four method seats, one debate round and short PM; not equivalent to full council.",
      price: "System-Recorded Price", noPrice: "No verifiable quote was retrieved; no price was invented.", delayed: "delayed quote", instrument: "Instrument Classification and Research Path", assetType: "Asset type", researchModel: "Research model", classifiedBy: "Classified by", conclusion: "Conclusion", rating: "Rating", winner: "Debate winner", confidence: "Confidence", judgment: "Judgment", noDecision: "NEEDS_MANAGER_REVIEW; a tool or PM failure cannot be converted into an investment rating.",
      masters: "Final Per-Seat Method Statements (not quotes from the named people)", analysts: "Analyst Views by Seat", worker: "statement source", record: "Frozen record", key: "Key Content", earnings: "Latest earnings", forward: "Forward thresholds", news: "News / industry signal", recentNews: "Recent Company and Industry News", newsSummary: "News-seat summary", noDatedNews: "No dated news source inside the 120 days through as_of was retrieved.", newsExcluded: "Recent-news gate excluded", valuation: "Valuation / price range", position: "Position", gaps: "Data Gaps and Failed Seats", invalidation: "Invalidation", files: "File Locations", report: "Full report", index: "Agent artifact index", trace: "Full agent trace", quality: "Report quality check", missing: "Not covered.", noGaps: "No additional gap was recorded.", noInvalidation: "No formal invalidation conditions are available.",
    },
    ja: {
      title: "AlphaCouncil 実行サマリー", status: "実行状況と期限", statusLabel: "状態", contract: "レポート契約", scope: "実行範囲", elapsed: "所要時間", deadline: "ハード期限", deadlineMet: "期限内に保存", fullScope: "full_v2：8つの証拠席、選択された全メソッド席の監査可能な最終見解、3ラウンドの多空質疑、PM。プラグイン管理実行は30分で必ず終端状態になります。", quickScope: "quick_v1：4つの証拠席、1–4のメソッド席、1ラウンドの多空議論、短いPM。full council相当ではありません。", price: "システム記録価格", noPrice: "検証可能な価格を取得できず、価格は補完していません。", delayed: "遅延価格", instrument: "銘柄分類と調査経路", assetType: "資産タイプ", researchModel: "調査モデル", classifiedBy: "分類根拠", conclusion: "結論", rating: "評価", winner: "勝者", confidence: "信頼度", judgment: "判断", noDecision: "NEEDS_MANAGER_REVIEW。ツールまたはPMの失敗を投資評価に変換できません。", masters: "最後：メソッド席ごとの最終見解（本人の発言・引用ではありません）", analysts: "分析担当ごとの内容", worker: "見解の生成元", record: "凍結済み記録", key: "主要内容", earnings: "直近決算", forward: "先行条件", news: "ニュース・業界シグナル", recentNews: "直近の企業・業界ニュース", newsSummary: "ニュース席の要約", noDatedNews: "as_of までの120日間にある日付付きニュース出典を取得できませんでした。", newsExcluded: "ニュース時刻ゲートで除外", valuation: "評価レンジ・価格条件", position: "ポジション", gaps: "データ欠落と失敗した席", invalidation: "無効化条件", files: "ファイル", report: "完全レポート", index: "代理成果物一覧", trace: "全代理トレース", quality: "レポート品質検査", missing: "未取得。", noGaps: "追加の欠落は記録されていません。", noInvalidation: "正式な無効化条件はありません。",
    },
    ko: {
      title: "AlphaCouncil 실행 요약", status: "실행 상태 및 기한", statusLabel: "상태", contract: "보고서 계약", scope: "실행 범위", elapsed: "소요 시간", deadline: "하드 기한", deadlineMet: "기한 내 저장", fullScope: "full_v2: 8개 증거 좌석, 선택된 모든 방법론 좌석의 감사 가능한 최종 발언, 3라운드 롱/숏 질의응답, PM. 플러그인 관리 실행은 30분 안에 반드시 종단 상태가 됩니다.", quickScope: "quick_v1: 4개 증거 좌석, 1–4개 방법론 좌석, 단일 롱/숏 라운드, 짧은 PM. full council과 동등하지 않습니다.", price: "시스템 기록 가격", noPrice: "검증 가능한 시세를 가져오지 못했으며 가격을 임의로 만들지 않았습니다.", delayed: "지연 시세", instrument: "종목 분류 및 조사 경로", assetType: "자산 유형", researchModel: "조사 모델", classifiedBy: "분류 근거", conclusion: "결론", rating: "등급", winner: "토론 승자", confidence: "신뢰도", judgment: "판단", noDecision: "NEEDS_MANAGER_REVIEW. 도구 또는 PM 실패를 투자 등급으로 바꿀 수 없습니다.", masters: "마지막: 방법론 좌석별 최종 발언(본인의 실제 발언이나 인용이 아님)", analysts: "분석가 좌석별 내용", worker: "발언 출처", record: "동결 기록", key: "핵심 내용", earnings: "최근 실적", forward: "선행 조건", news: "뉴스·산업 신호", recentNews: "최근 기업 및 산업 뉴스", newsSummary: "뉴스 좌석 요약", noDatedNews: "as_of까지 120일 이내의 날짜가 있는 뉴스 출처를 확보하지 못했습니다.", newsExcluded: "뉴스 시간 게이트에서 제외", valuation: "가치평가 범위·가격 조건", position: "포지션", gaps: "데이터 공백 및 실패 좌석", invalidation: "무효화 조건", files: "파일 위치", report: "전체 보고서", index: "에이전트 산출물 색인", trace: "전체 에이전트 추적", quality: "보고서 품질 검사", missing: "미확보.", noGaps: "추가 공백이 기록되지 않았습니다.", noInvalidation: "공식 무효화 조건이 없습니다.",
    },
  }[languageKey(language)];
}

function localizedFailure(error, language) {
  const value = String(error || "");
  const key = languageKey(language);
  const labels = {
    zh: { parse_failed: "返回格式无法修复", timeout: "超时", timed_out: "超时", global_deadline: "全局时限耗尽", qna_incomplete: "问答不完整", unexpected_error: "意外工具错误", failed: "子代理未成功返回", skipped: "因上游门禁未运行", degraded: "降级", pending: "尚未运行", missing: "缺失" },
    en: { parse_failed: "response format could not be repaired", timeout: "timed out", timed_out: "timed out", global_deadline: "global deadline exhausted", qna_incomplete: "Q&A was incomplete", unexpected_error: "unexpected tool error", failed: "subagent did not return successfully", skipped: "not run because an upstream gate failed", degraded: "degraded", pending: "not started", missing: "missing" },
    ja: { parse_failed: "応答形式を修復できませんでした", timeout: "タイムアウト", timed_out: "タイムアウト", global_deadline: "全体期限を超過", qna_incomplete: "質疑応答が不完全", unexpected_error: "予期しないツールエラー", failed: "サブエージェントが正常に応答しませんでした", skipped: "上流ゲートの失敗により未実行", degraded: "縮退", pending: "未開始", missing: "欠落" },
    ko: { parse_failed: "응답 형식을 복구하지 못함", timeout: "시간 초과", timed_out: "시간 초과", global_deadline: "전체 기한 소진", qna_incomplete: "질의응답 불완전", unexpected_error: "예기치 않은 도구 오류", failed: "하위 에이전트가 정상 응답하지 못함", skipped: "상위 게이트 실패로 실행하지 않음", degraded: "성능 저하", pending: "시작 전", missing: "누락" },
  }[key];
  if (value.startsWith("exit code")) return labels.failed;
  if (value.includes("gate_failed") || value.startsWith("global_deadline_before")) return labels.skipped;
  return labels[value] || labels.missing;
}

function recentNewsHandoff(run, copy) {
  const packet = (run.packets || []).find((item) => item.task === "news_industry_management");
  const asOfTime = Date.parse(`${String(run.as_of || "").slice(0, 10)}T23:59:59.999Z`);
  const cutoff = Number.isFinite(asOfTime) ? asOfTime - (120 * 24 * 60 * 60 * 1000) : -Infinity;
  const excluded = { undated: 0, future: 0, stale: 0 };
  const eligible = (packet?.sources || []).filter((source) => {
    const published = Date.parse(source?.published_at || "");
    if (!Number.isFinite(published)) { excluded.undated += 1; return false; }
    if (Number.isFinite(asOfTime) && published > asOfTime) { excluded.future += 1; return false; }
    if (Number.isFinite(asOfTime) && published < cutoff) { excluded.stale += 1; return false; }
    return true;
  }).sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || ""))).slice(0, 6);
  const sources = eligible.length
    ? eligible.map((source) => `- ${source.published_at} — ${clipAtBoundary(source.title || "", 240)}${source.url ? ` — ${source.url}` : ""}`).join("\n")
    : `- ${copy.noDatedNews}`;
  const totalExcluded = excluded.undated + excluded.future + excluded.stale;
  const exclusion = totalExcluded ? {
    zh: `- ${copy.newsExcluded} ${totalExcluded} 个来源：无日期 ${excluded.undated}、晚于 as_of ${excluded.future}、早于 120 天窗口 ${excluded.stale}。`,
    en: `- ${copy.newsExcluded} ${totalExcluded}: undated=${excluded.undated}, after_as_of=${excluded.future}, older_than_120d=${excluded.stale}.`,
    ja: `- ${copy.newsExcluded}：合計 ${totalExcluded} 件（日付なし ${excluded.undated}、as_of 後 ${excluded.future}、120日超 ${excluded.stale}）。`,
    ko: `- ${copy.newsExcluded}: 총 ${totalExcluded}개(날짜 없음 ${excluded.undated}, as_of 이후 ${excluded.future}, 120일 초과 ${excluded.stale}).`,
  }[languageKey(run.language)] : "";
  return { packet, sources, exclusion };
}

function localizedDisplayValue(value, language) {
  const key = languageKey(language);
  const token = value === true ? "true" : value === false ? "false" : String(value || "unknown");
  const maps = {
    zh: { unknown: "未知", unavailable: "不可用", true: "是", false: "否", pending: "待运行", running: "运行中", waiting: "等待中", completed: "已完成", complete: "完整", failed: "失败", degraded: "降级", incomplete: "不完整", skipped: "未运行", declined: "不适用", constructive: "建设性", cautious: "谨慎", opposed: "反对", out_of_scope: "证据范围外", deterministic_fallback: "确定性方法规则", completed_worker: "隔离方法席代理", recorded: "已记录", high: "高", medium: "中", low: "低", Buy: "买入", Overweight: "增持", Hold: "持有", Underweight: "减持", Sell: "卖出", bull: "多方", bear: "空方", balanced: "平衡" },
    en: { unknown: "unknown", unavailable: "unavailable", true: "yes", false: "no", deterministic_fallback: "deterministic method policy", completed_worker: "isolated method-seat worker", recorded: "recorded" },
    ja: { unknown: "不明", unavailable: "取得不可", true: "はい", false: "いいえ", pending: "待機中", running: "実行中", waiting: "待機中", completed: "完了", complete: "完了", failed: "失敗", degraded: "縮退", incomplete: "不完全", skipped: "未実行", declined: "適用外", constructive: "前向き", cautious: "慎重", opposed: "反対", out_of_scope: "証拠範囲外", deterministic_fallback: "決定論的メソッド規則", completed_worker: "分離メソッド席ワーカー", recorded: "記録済み", high: "高", medium: "中", low: "低", Buy: "買い", Overweight: "オーバーウェイト", Hold: "中立", Underweight: "アンダーウェイト", Sell: "売り", bull: "強気", bear: "弱気", balanced: "均衡" },
    ko: { unknown: "알 수 없음", unavailable: "확인 불가", true: "예", false: "아니요", pending: "대기 중", running: "실행 중", waiting: "대기 중", completed: "완료", complete: "완료", failed: "실패", degraded: "성능 저하", incomplete: "불완전", skipped: "미실행", declined: "적용 범위 밖", constructive: "긍정적", cautious: "신중", opposed: "반대", out_of_scope: "증거 범위 밖", deterministic_fallback: "결정론적 방법 규칙", completed_worker: "격리 방법론 좌석 워커", recorded: "기록됨", high: "높음", medium: "중간", low: "낮음", Buy: "매수", Overweight: "비중 확대", Hold: "보유", Underweight: "비중 축소", Sell: "매도", bull: "강세", bear: "약세", balanced: "균형" },
  };
  return maps[key]?.[token] || token;
}

export function userResponseMarkdown(run, manager) {
  const artifacts = artifactPaths(run);
  const copy = handoffCopy(run.language);
  const news = recentNewsHandoff(run, copy);
  const decisionAvailable = manager?.decision_available !== false;
  const quote = run?.grounding?.quote;
  const priceLine = quote && Number.isFinite(Number(quote.price))
    ? `${quote.price} ${quote.currency || ""}; ${quote.quote_time || localizedDisplayValue("unknown", run.language)}; ${quote.exchange || localizedDisplayValue("unknown", run.language)}; ${copy.delayed}; ${quote.source_url || localizedDisplayValue("unavailable", run.language)}`
    : copy.noPrice;
  const masterLines = (run.masters || []).map((id) => {
    const opinion = (run.master_opinions || []).find((item) => item.master === id);
    const state = run.master_status?.[id] || { status: "pending" };
    if (!opinion) return `- ${masterTitle(id, run.language)} (\`${id}\`) [${localizedDisplayValue(state.status, run.language)}]: ${localizedFailure(state.error, run.language) || copy.missing}`;
    const statementSource = opinion.dedicated_worker?.status || opinion.voice_status || "unknown";
    const frozenRecord = opinion.statement_origin || opinion.reason || opinion.engine || "recorded";
    // A seat's statement opens with the evidence it read and closes with what it would do, so
    // clipping the opening to one line spent the whole budget on background and cut the
    // conclusion. Lead with the reading that decided it and the action it implies -- both are
    // already composed from the frozen decision -- then quote the statement at a budget that
    // survives a paragraph, and leave provenance to its own line instead of the same sentence.
    const lead = [opinion.voice?.how_my_method_reads_it, opinion.voice?.would_i_act]
      .filter((part) => typeof part === "string" && part.trim().length)
      .join(" ");
    const statement = opinion.voice_statement || opinion.summary || opinion.verdict || "";
    return [
      `- ${masterTitle(id, run.language)} (\`${id}\`)`,
      lead ? `  - ${clipAtBoundary(lead, 700)}` : "",
      statement ? `  - ${clipAtBoundary(statement, MASTER_STATEMENT_CHARS)}` : "",
      `  - [${copy.record}: ${localizedDisplayValue(opinion.stance, run.language)}/${localizedDisplayValue(opinion.confidence || "low", run.language)}; ${copy.worker}: ${localizedDisplayValue(statementSource, run.language)}; ${frozenRecord}]`,
    ].filter(Boolean).join("\n");
  }).join("\n") || `- ${copy.missing}`;
  const analystLines = (run.tasks || []).map((task) => {
    const packet = (run.packets || []).find((item) => item.task === task);
    const state = taskState(run, task);
    return `- \`${task}\` [${localizedDisplayValue(state.status, run.language)}/${localizedDisplayValue(packet?.confidence || "low", run.language)}]: ${clipAtBoundary(packet?.summary || "", 520) || localizedFailure(state.error, run.language) || copy.missing}`;
  }).join("\n") || `- ${copy.missing}`;
  const gaps = [...new Set([
    ...(run.tasks || []).filter((task) => taskState(run, task).status !== "completed")
      .map((task) => `${task}: ${localizedFailure(taskState(run, task).error || taskState(run, task).status, run.language)}`),
    ...(run.masters || []).filter((id) => !(run.master_opinions || []).some((opinion) => opinion.master === id))
      .map((id) => `${id}: ${localizedFailure(run.master_status?.[id]?.error || run.master_status?.[id]?.status, run.language)}`),
    ...(run.packets || []).flatMap((packet) => packet.open_questions || []),
  ])].slice(0, 12).map((item) => `- ${clipAtBoundary(item, 360)}`).join("\n") || `- ${copy.noGaps}`;
  const invalidation = decisionAvailable
    ? (manager.invalidation || []).slice(0, 3).map((item) => `- ${clipAtBoundary(item, 260)}`).join("\n") || `- ${copy.noInvalidation}`
    : `- ${copy.noInvalidation}`;
  const elapsed = run.started_at
    ? Math.max(0, Date.parse(run.completed_at || new Date().toISOString()) - Date.parse(run.started_at))
    : localizedDisplayValue("unknown", run.language);
  return [
    `# ${run.symbol} ${copy.title}`,
    "",
    `## ${copy.status}`,
    `- ${copy.statusLabel}: ${localizedDisplayValue(run.status, run.language)}`,
    `- ${copy.contract}: ${run.council_mode === "quick" ? "quick_v1" : "full_v2"}`,
    `- ${copy.scope}: ${run.council_mode === "quick" ? copy.quickScope : copy.fullScope}`,
    `- ${copy.elapsed}: ${elapsed} ms`,
    `- ${copy.deadline}: ${run.deadline_at || localizedDisplayValue("unknown", run.language)}`,
    `- ${copy.deadlineMet}: ${localizedDisplayValue(run.deadline_at && run.completed_at ? Date.parse(run.completed_at) <= Date.parse(run.deadline_at) : "unknown", run.language)}`,
    "",
    `## ${copy.price}`,
    `- ${priceLine}`,
    "",
    `## ${copy.instrument}`,
    `- ${copy.assetType}: ${run?.grounding?.instrument?.asset_type || localizedDisplayValue("unknown", run.language)}`,
    `- ${copy.researchModel}: ${run?.grounding?.instrument?.research_model || localizedDisplayValue("unknown", run.language)}`,
    `- ${copy.classifiedBy}: ${run?.grounding?.instrument?.classification_source || localizedDisplayValue("unknown", run.language)}`,
    "",
    `## ${copy.conclusion}`,
    `- ${copy.rating}: ${localizedDisplayValue(decisionAvailable ? manager.rating : "unavailable", run.language)}`,
    `- ${copy.winner}: ${localizedDisplayValue(decisionAvailable ? (manager.winner || "unknown") : "unavailable", run.language)}`,
    `- ${copy.confidence}: ${localizedDisplayValue(decisionAvailable ? (manager.confidence || "low") : "unavailable", run.language)}`,
    `- ${copy.judgment}: ${decisionAvailable ? clipAtBoundary(manager.verdict || manager.summary, 720) : copy.noDecision}`,
    "",
    `## ${copy.analysts}`,
    analystLines,
    "",
    `## ${copy.recentNews}`,
    `- ${copy.newsSummary}: ${clipAtBoundary(news.packet?.summary || "", 620) || copy.missing}`,
    news.sources,
    news.exclusion,
    "",
    `## ${copy.key}`,
    `- ${copy.earnings}: ${clipAtBoundary(packetSummary(run, "earnings_deep_dive"), 520) || copy.missing}`,
    `- ${copy.forward}: ${clipAtBoundary(packetSummary(run, "forward_expectations"), 520) || copy.missing}`,
    `- ${copy.news}: ${clipAtBoundary(packetSummary(run, "news_industry_management"), 620) || copy.missing}`,
    `- ${copy.valuation}: ${decisionAvailable ? (clipAtBoundary(manager.valuation_range, 620) || copy.missing) : localizedDisplayValue("unavailable", run.language)}`,
    `- ${copy.position}: ${decisionAvailable ? (clipAtBoundary(manager.position, 520) || copy.missing) : localizedDisplayValue("unavailable", run.language)}`,
    "",
    `## ${copy.gaps}`,
    gaps,
    "",
    `## ${copy.invalidation}`,
    invalidation,
    "",
    `## ${copy.files}`,
    `- ${copy.report}: ${artifacts.final_report_md}`,
    `- ${copy.index}: ${artifacts.artifact_index_md}`,
    `- ${copy.trace}: ${artifacts.all_agents_md}`,
    `- ${copy.quality}: ${artifacts.report_quality_json}`,
    "",
    `## ${copy.masters} — ${(run.masters || []).length}`,
    masterLines,
  ].join("\n");
}

export function writeUserResponse(run, manager) {
  const markdown = userResponseMarkdown(run, manager);
  writeFileSync(artifactPaths(run).user_response_md, `${markdown}\n`);
  return markdown;
}

export function writeFinalArtifacts(run, debate = {}) {
  const manager = debate.manager;
  if (!manager) {
    writeAnalystMarkdownFiles(run, debate);
    writeArtifactIndex(run, debate);
    return { artifacts: artifactPaths(run) };
  }
  const finalMarkdown = finalReportMarkdown(run, manager);
  writeFileSync(artifactPaths(run).final_report_md, `${finalMarkdown}\n`);
  const quality = writeReportQuality(run, finalMarkdown);
  if (quality.status !== "passed" && completenessStatus(run).completeness === "complete" && verificationStatus(run).verification === "passed") {
    run.status = "needs_revision";
    run.phase = "needs_revision";
    appendEvent(run, "needs_revision", { missing: quality.missing });
  }
  writeAnalystMarkdownFiles(run, debate);
  const user_response_markdown = writeUserResponse(run, manager);
  writeArtifactIndex(run, debate);
  return { final_report_markdown: finalMarkdown, user_response_markdown, report_quality: quality, artifacts: artifactPaths(run) };
}
