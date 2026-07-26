import { join } from "node:path";
import { LIMITS, MASTER_STANCES, RATINGS } from "./constants.mjs";
import { internalError } from "./errors.mjs";
import { isChineseLanguage } from "./lang.mjs";
import { cleanLog, clip } from "./text.mjs";
import { scopedSourceId } from "./gates.mjs";
import { runPath } from "./run-store.mjs";
import { packetSummary } from "./markdown.mjs";

export function rawRecordText(packet) {
  if (typeof packet?.raw_text === "string" && packet.raw_text.trim()) return packet.raw_text;
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return JSON.stringify(packet || {}, null, 2);
  const { raw_text, ...withoutRawText } = packet;
  return JSON.stringify(withoutRawText, null, 2);
}

export function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw internalError("subagent did not return JSON");
  }
}

export function normalizePacket(packet, task, symbol, asOfDate, raw = "") {
  const sourceIdMap = new Map();
  const sources = Array.isArray(packet?.sources) ? packet.sources.map((source, index) => {
    const original = String(source?.id || `S${index + 1}`);
    const id = scopedSourceId(task, original, index);
    sourceIdMap.set(original, id);
    return { ...(source && typeof source === "object" ? source : {}), id };
  }) : [];
  const claims = Array.isArray(packet?.claims) ? packet.claims.map((claim) => ({
    ...(claim && typeof claim === "object" ? claim : {}),
    source_ids: Array.isArray(claim?.source_ids)
      ? claim.source_ids.map((id) => sourceIdMap.get(String(id)) || scopedSourceId(task, id)).filter(Boolean)
      : [],
  })) : [];
  return {
    task,
    symbol,
    as_of: asOfDate,
    summary: typeof packet?.summary === "string" ? packet.summary : raw.slice(0, LIMITS.CLEAN_LOG_BYTES),
    claims,
    metrics: packet?.metrics && typeof packet.metrics === "object" ? packet.metrics : {},
    sources,
    open_questions: Array.isArray(packet?.open_questions) ? packet.open_questions : [],
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low",
    // How much material this task actually had. Deliberately separate from confidence:
    // a rich-but-contradictory task can be A/low, a sparse-but-decisive one C/high.
    information_richness: ["A", "B", "C"].includes(packet?.information_richness) ? packet.information_richness : "unrated",
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    thread_title: typeof packet?.thread_title === "string" ? packet.thread_title : undefined,
    execution_mode: typeof packet?.execution_mode === "string" ? packet.execution_mode : undefined,
    raw_text: raw,
  };
}

export function normalizeDebate(packet, role, run, raw = "") {
  return {
    role,
    symbol: run.symbol,
    as_of: run.as_of,
    verdict: typeof packet?.verdict === "string" ? packet.verdict : "",
    rating: RATINGS.includes(packet?.rating) ? packet.rating : "Hold",
    winner: ["bull", "bear", "balanced", "unknown"].includes(packet?.winner) ? packet.winner : "unknown",
    summary: typeof packet?.summary === "string" ? packet.summary : raw.slice(0, LIMITS.CLEAN_LOG_BYTES),
    long_thesis: Array.isArray(packet?.long_thesis) ? packet.long_thesis : [],
    short_thesis: Array.isArray(packet?.short_thesis) ? packet.short_thesis : [],
    valuation_range: typeof packet?.valuation_range === "string" ? packet.valuation_range : "",
    catalysts: Array.isArray(packet?.catalysts) ? packet.catalysts : [],
    risks: Array.isArray(packet?.risks) ? packet.risks : [],
    position: typeof packet?.position === "string" ? packet.position : "",
    invalidation: Array.isArray(packet?.invalidation) ? packet.invalidation : [],
    source_ids: Array.isArray(packet?.source_ids) ? packet.source_ids : [],
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low",
    questions: Array.isArray(packet?.questions) ? packet.questions : [],
    questions_answered: Array.isArray(packet?.questions_answered) ? packet.questions_answered : [],
    debate_rounds: Array.isArray(packet?.debate_rounds) ? packet.debate_rounds : [],
    report_markdown: typeof packet?.report_markdown === "string" ? packet.report_markdown : "",
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    thread_title: typeof packet?.thread_title === "string" ? packet.thread_title : undefined,
    execution_mode: typeof packet?.execution_mode === "string" ? packet.execution_mode : undefined,
    raw_text: raw,
  };
}

export function dryPacket(task, symbol, asOfDate, prompt, language = "English") {
  const chinese = isChineseLanguage(language);
  return normalizePacket({
    summary: chinese ? `已计划 ${symbol} 的 ${task} 子代理。` : `Planned ${task} subagent for ${symbol}.`,
    claims: [{
      claim: chinese ? "仅 dry run；没有执行外部研究。" : "Dry run only; no external research executed.",
      evidence: chinese ? "生成的 prompt 已保存在 raw_text。" : "The generated prompt is stored in raw_text.",
      confidence: "low",
      source_ids: [],
    }],
    open_questions: [chinese ? "不要传 dry_run，或传 dry_run=false，即可执行 Codex 子代理。" : "Run again without dry_run, or with dry_run=false, to execute Codex subagents."],
    confidence: "low",
  }, task, symbol, asOfDate, prompt);
}

export function dryDebate(role, run, prompt) {
  const chinese = isChineseLanguage(run.language);
  return normalizeDebate({
    verdict: "DRY_RUN",
    rating: "Hold",
    winner: "unknown",
    summary: chinese ? `已计划 ${run.symbol} 的 ${role} 综合。` : `Planned ${role} synthesis for ${run.symbol}.`,
    confidence: "low",
    report_markdown: chinese ? `# ${run.symbol} ${role}\n\n仅 dry run。\n` : `# ${run.symbol} ${role}\n\nDry run only.\n`,
  }, role, run, prompt);
}

export function compactEvidence(run) {
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    packets: run.packets.map((packet) => ({
      task: packet.task,
      summary: packet.summary,
      claims: packet.claims,
      metrics: packet.metrics,
      sources: packet.sources,
      open_questions: packet.open_questions,
      confidence: packet.confidence,
    })),
  };
}

export function debateFromCodex(result, role, run, fallbackPrompt) {
  if (!result.ok) return dryDebate(role, run, cleanLog(result.stderr || result.text || fallbackPrompt));
  try {
    return normalizeDebate(extractJson(result.text), role, run, result.text);
  } catch {
    return normalizeDebate({
      verdict: "PARSE_FAILED",
      rating: "Hold",
      winner: "unknown",
      summary: `${role} returned non-JSON output.`,
      confidence: "low",
      report_markdown: cleanLog(result.text),
    }, role, run, cleanLog(result.text));
  }
}

export function mergeDebateRounds(rounds) {
  const list = (rounds || []).filter(Boolean);
  if (list.length === 0) return null;
  const base = list[list.length - 1];
  const debate_rounds = list.map((packet, index) => ({
    round: index + 1,
    summary: packet.summary || "",
    long_thesis: packet.long_thesis || [],
    short_thesis: packet.short_thesis || [],
    questions: packet.questions || [],
    questions_answered: packet.questions_answered || [],
    raw_text: packet.raw_text || "",
  }));
  return { ...base, debate_rounds };
}

export function confidenceScore(value) {
  return ({ high: 3, medium: 2, low: 1 })[value] || 1;
}

export function summarizeRun(run, userPrompt = "") {
  const claims = run.packets.flatMap((packet) =>
    packet.claims.map((claim) => ({ ...claim, task: packet.task, packet_confidence: packet.confidence }))
  );
  const avg = run.packets.reduce((sum, packet) => sum + confidenceScore(packet.confidence), 0) / Math.max(1, run.packets.length);
  const confidence = avg >= 2.5 ? "high" : avg >= 1.7 ? "medium" : "low";
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    objective: userPrompt,
    final_decision: run.dry_run ? "DRY_RUN" : "NEEDS_MANAGER_REVIEW",
    confidence,
    thesis: claims.slice(0, 12),
    open_questions: [...new Set(run.packets.flatMap((packet) => packet.open_questions || []))],
    source_count: run.packets.reduce((sum, packet) => sum + (packet.sources?.length || 0), 0),
    evidence_path: join(runPath(run.run_id), "evidence.json"),
  };
}

export function managerFallback(run, userPrompt = "") {
  const summary = summarizeRun(run, userPrompt);
  const chinese = isChineseLanguage(run.language);
  const analystLog = run.packets.length
    ? run.packets.map((packet) => {
        const claims = (packet.claims || []).slice(0, 5).map((claim) => `  - ${claim.claim}`).join("\n");
        const gaps = (packet.open_questions || []).slice(0, 3).map((item) => `  - ${item}`).join("\n");
        return `### ${packet.task}\n- Confidence: ${packet.confidence || "unknown"}\n- Summary: ${packet.summary || "None"}\n${claims ? `- Key findings:\n${claims}\n` : ""}${gaps ? `- Data gaps:\n${gaps}\n` : ""}`;
      }).join("\n\n")
    : (chinese ? "未生成 evidence packets。" : "No evidence packets were generated.");
  const debateRecord = chinese
    ? "经理综合子代理未完成，因此没有完整多空交叉辩论记录；以上证据只能作为投资委员会初稿。"
    : "The manager synthesis subagent did not complete, so a full bull/bear cross-debate record is unavailable; the evidence above is only an investment-committee draft.";
  return normalizeDebate({
    verdict: summary.final_decision,
    rating: "Hold",
    winner: "unknown",
    summary: chinese ? "证据已收集，但未运行经理综合子代理。" : "Evidence was collected, but the manager synthesis subagent did not run.",
    long_thesis: summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => claim.claim),
    short_thesis: summary.open_questions.slice(0, 6),
    confidence: summary.confidence,
    report_markdown: chinese
      ? `# ${run.symbol} 投资委员会初稿\n\n## 结论\n${summary.final_decision}\n\n## 分析师工作记录\n${analystLog}\n\n## 多空辩论记录\n${debateRecord}\n\n## 多头观点\n${summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => `- ${claim.claim}`).join("\n") || "- 本轮没有可用多头论点。"}\n\n## 空头观点\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- 本轮没有可用空头论点。"}\n\n## 市场预期与隐含门槛\n${clip(packetSummary(run, "forward_expectations"), 900) || "- 本轮没有前瞻预期证据。"}\n\n## 分析师评级/目标价变化\n${clip(packetSummary(run, "sell_side_revisions"), 900) || "- 本轮没有卖方修正证据。"}\n\n## 电话会管理层信号\n${clip(packetSummary(run, "earnings_call_transcript"), 900) || "- 本轮没有电话会证据。"}\n\n## 量化/因子视角\n${clip(packetSummary(run, "quant_factor"), 900) || "- 本轮没有量化因子证据。"}\n\n## 新闻和公司/行业人物发言信号\n${clip([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join("\n"), 1200) || "- 本轮没有新闻或人物发言证据。"}\n\n## short interest / borrow / options 信息\n${clip(packetSummary(run, "quant_factor"), 700) || "- 本轮没有 short interest / borrow / options 数据。"}\n\n## 战略交易 / 银行事件\n${clip(packetSummary(run, "ib_event_analysis"), 900) || "- 本轮没有交易事件证据。"}\n\n## 估值区间\n${clip(packetSummary(run, "valuation_long_short"), 900) || "- 本轮没有估值证据。"}\n\n## 价位参考\n- 经理综合未完成，无法给出价格条件表。需要：估值区间、最差年份盈利、历史估值分位。\n\n## 关键催化剂\n- 等待 portfolio_manager 完整综合。\n\n## 主要风险\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- 暂未发现额外风险。"}\n\n## 仓位建议\n- 经理综合未完成前仅作为初稿，不给正式仓位。\n\n## 短线 1-4 周判断\n- 需等待完整经理综合。\n\n## 中期 3-6 个月判断\n- 需等待完整经理综合。\n\n## 长期 12 个月判断\n- 需等待完整经理综合。\n\n## 数据缺口/未覆盖项\n${summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : "- 未发现关键数据缺口。"}\n\n## 反证条件\n- 若证据来源缺失或完整经理综合失败，本初稿不能作为正式结论。\n\n## 置信度\n${summary.confidence}\n\n## 来源表\n- 来源数量: ${summary.source_count}\n`
      : `# ${run.symbol} Investment Committee Draft\n\n## Conclusion\n${summary.final_decision}\n\n## Analyst Work Log\n${analystLog}\n\n## Bull/Bear Debate Record\n${debateRecord}\n\n## Long Thesis\n${summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => `- ${claim.claim}`).join("\n") || "- No usable long thesis yet."}\n\n## Short Thesis\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- No usable short thesis yet."}\n\n## Market Expectations and Implied Thresholds\n${clip(packetSummary(run, "forward_expectations"), 900) || "- No forward-expectations evidence in this run."}\n\n## Analyst Rating and Target-Price Revisions\n${clip(packetSummary(run, "sell_side_revisions"), 900) || "- No sell-side revision evidence in this run."}\n\n## Earnings Call Management Signals\n${clip(packetSummary(run, "earnings_call_transcript"), 900) || "- No earnings-call evidence in this run."}\n\n## Quant Factor / Technical Risk View\n${clip(packetSummary(run, "quant_factor"), 900) || "- No quant-factor evidence in this run."}\n\n## News and Company / Industry Voice Signals\n${clip([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join("\n"), 1200) || "- No news or voice evidence in this run."}\n\n## Short Interest / Borrow / Options Information\n${clip(packetSummary(run, "quant_factor"), 700) || "- No short interest / borrow / options data in this run."}\n\n## Strategic Transaction or Banking Event\n${clip(packetSummary(run, "ib_event_analysis"), 900) || "- No transaction evidence in this run."}\n\n## Valuation Range\n${clip(packetSummary(run, "valuation_long_short"), 900) || "- No valuation evidence in this run."}\n\n## Price Levels\n- Manager synthesis did not complete, so no price-condition table can be given. Needed: a valuation range, worst-year earnings, and the historical valuation percentile.\n\n## Key Catalysts\n- Wait for completed portfolio-manager synthesis.\n\n## Major Risks\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- No additional risks surfaced yet."}\n\n## Position Recommendation\n- Draft only; no formal position before completed manager synthesis.\n\n## Short-Term 1-4 Week View\n- Requires completed manager synthesis.\n\n## Medium-Term 3-6 Month View\n- Requires completed manager synthesis.\n\n## Long-Term 12 Month View\n- Requires completed manager synthesis.\n\n## Data Gaps / Unavailable Data\n${summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : "- No critical data gaps were found."}\n\n## Invalidation Conditions\n- If evidence sources are missing or manager synthesis fails, this draft cannot stand as the final decision.\n\n## Confidence\n${summary.confidence}\n\n## Source Table\n- Source count: ${summary.source_count}\n`,
  }, "portfolio_manager", run);
}

/**
 * Common ways a caller says a stance that is not one of the four we store.
 *
 * Mapping these is not politeness. An unmapped value used to fall through to "cautious",
 * which is a real stance carrying real weight -- so a caller writing "avoid" got a seat
 * that looked deliberate and voted. Ten such seats render as unanimity that no master
 * produced.
 */
const STANCE_SYNONYMS = new Map([
  ["long", "constructive"], ["bullish", "constructive"], ["buy", "constructive"],
  ["positive", "constructive"], ["overweight", "constructive"],
  ["neutral", "cautious"], ["hold", "cautious"], ["mixed", "cautious"], ["wait", "cautious"],
  ["short", "opposed"], ["bearish", "opposed"], ["sell", "opposed"], ["avoid", "opposed"],
  ["negative", "opposed"], ["underweight", "opposed"],
  ["n/a", "out_of_scope"], ["na", "out_of_scope"], ["skip", "out_of_scope"],
  ["abstain", "out_of_scope"], ["unknown", "out_of_scope"],
]);

/**
 * Never silently invent a stance.
 *
 * Anything we cannot map becomes `out_of_scope`, which weights.mjs already treats as
 * carrying zero weight. Guessing "cautious" for an unrecognised value manufactures a
 * confident-looking seat out of a caller's typo; declining to score it does not.
 */
export function coerceStance(value, masterId = "") {
  if (MASTER_STANCES.includes(value)) return value;
  if (typeof value === "string") {
    const mapped = STANCE_SYNONYMS.get(value.trim().toLowerCase());
    if (mapped) return mapped;
  }
  if (value !== undefined && value !== null && value !== "") {
    process.emitWarning(
      `alphacouncil: unrecognised master stance ${JSON.stringify(value)}`
      + `${masterId ? ` from ${masterId}` : ""}; recorded as out_of_scope (zero weight). `
      + `Allowed: ${MASTER_STANCES.join(", ")}.`
    );
  }
  return "out_of_scope";
}

/**
 * A master's opinion. Deliberately NOT a debate packet: a master issues no rating and
 * declares no winner. out_of_scope is a first-class stance -- "by my method this name is
 * outside what I can judge" is a conclusion, not an abstention.
 */
export function normalizeMasterOpinion(packet, masterId, run, raw = "") {
  const list = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === "string") : []);
  return {
    master: masterId,
    symbol: run.symbol,
    as_of: run.as_of,
    verdict: typeof packet?.verdict === "string" ? packet.verdict : "",
    stance: coerceStance(packet?.stance, masterId),
    summary: typeof packet?.summary === "string" ? packet.summary : raw.slice(0, LIMITS.CLEAN_LOG_BYTES),
    key_findings: list(packet?.key_findings),
    disagreements: list(packet?.disagreements),
    disqualifiers_triggered: list(packet?.disqualifiers_triggered),
    what_would_change_my_mind: list(packet?.what_would_change_my_mind),
    source_ids: list(packet?.source_ids),
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low",
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    raw_text: raw,
  };
}

/** Compact master opinions for injection into the debate prompt. */
export function compactMasterOpinions(run) {
  return (run.master_opinions || []).map((opinion) => ({
    master: opinion.master,
    stance: opinion.stance,
    verdict: opinion.verdict,
    key_findings: opinion.key_findings,
    disagreements: opinion.disagreements,
    disqualifiers_triggered: opinion.disqualifiers_triggered,
    confidence: opinion.confidence,
  }));
}
