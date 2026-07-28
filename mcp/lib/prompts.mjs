import { join } from "node:path";
import { isChineseLanguage, resolveLanguage } from "./lang.mjs";
import { runPath } from "./run-store.mjs";
import { compactDebateContext, compactEvidence, compactMasterOpinions, compactQuickEvidence } from "./packets.mjs";
import { outputModeInstruction } from "./output-modes.mjs";
import { resolveSeatWeights, weightTableMarkdown } from "./weights.mjs";
import { groundingBlock } from "./grounding.mjs";
import { personaPrompt, personaTitle, registry, selectRoster } from "./personas/registry.mjs";

/**
 * Prompt text lives in personas/, not here.
 *
 * It used to be two parallel blocks of string literals inside a 2000-line module -- one
 * Chinese, one English -- which had already drifted apart, and which neither a human
 * reviewer nor a host could see. These functions now only compose: preamble + persona
 * body + run-specific context.
 */

/** Fill {{placeholders}} in a persona body. Unknown keys are left alone, not blanked. */
function render(template, values) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (match, key) =>
    (Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? "") : match));
}

export function taskPrompt(task, symbol, asOfDate, userPrompt = "", language = "auto", grounding = null) {
  const resolvedLanguage = resolveLanguage({ language, prompt: userPrompt });
  const chinese = isChineseLanguage(resolvedLanguage);
  const reg = registry();

  const base = [
    render(personaPrompt(reg.get("_evidence_base"), resolvedLanguage), {
      symbol,
      as_of: asOfDate,
      language: resolvedLanguage,
    }),
    userPrompt ? (chinese ? `用户目标：${userPrompt}` : `User objective: ${userPrompt}`) : "",
  ].filter(Boolean).join("\n");

  const body = render(personaPrompt(reg.get(task), resolvedLanguage), { symbol, as_of: asOfDate, language: resolvedLanguage })
    || (chinese ? "收集与投资决策相关的证据。" : "Collect evidence relevant to the investment decision.");

  // Grounding goes AFTER the role brief: the analyst must know its job before it is told
  // which facts are already settled, or it reads them as the whole assignment.
  const grounded = groundingBlock(grounding, resolvedLanguage);
  return [`${base}\n\n${chinese ? "任务：" : "Task: "}${task}\n${body}`, grounded].filter(Boolean).join("\n\n");
}

export function debatePrompt(role, run, context = {}) {
  const evidencePath = join(runPath(run.run_id), "evidence.json");
  const quick = run.council_mode === "quick";
  const evidenceJson = JSON.stringify(quick ? compactQuickEvidence(run) : compactEvidence(run));
  const language = run.language || "English";
  const chinese = isChineseLanguage(language);
  const reg = registry();

  const base = render(personaPrompt(reg.get("_debate_base"), language), {
    symbol: run.symbol,
    as_of: run.as_of,
    evidence_path: evidencePath,
    language,
    role,
  });

  const roleText = render(personaPrompt(reg.get(role), language), { symbol: run.symbol, as_of: run.as_of, language, role })
    || (chinese ? "产出投资组合辩论 memo。" : "Produce a portfolio debate memo.");

  const roundTwoInstruction = context.round === 2
    ? (chinese
        ? "本轮为交叉反驳轮：在完成反驳后，必须在 `questions` 数组里向对方提出恰好 3 个尖锐、可回答的问题；本轮 `questions_answered` 留空。"
        : "This is the cross-rebuttal round. After the rebuttal, ask exactly 3 sharp, answerable opponent questions in `questions`; leave `questions_answered` empty in this round.")
    : "";
  const roundThreeInstruction = context.round === 3
    ? (chinese
        ? "本轮为问答回答轮：把你在第 2 轮提出的 3 个问题原样复制到 `questions`。`questions_answered` 必须是恰好 3 个 `{question, answer}` 对象；每个 `question` 按数组位置逐字复制输入的对方问题，`answer` 给出对应回答。"
        : "This is the Q&A response round. Copy your 3 round 2 questions exactly into `questions`. `questions_answered` must contain exactly 3 `{question, answer}` objects; each `question` must copy the supplied opponent question verbatim at the same array index, and `answer` must answer it.")
    : "";
  const quickInstruction = quick
    ? role === "portfolio_manager"
      ? (chinese
          ? "这是 quick_v1 快速委员会，不是 full council。只发生了一次并行多空陈述，没有三轮交叉问答，也没有对抗核验。请写紧凑报告，必须有真实 Markdown 标题：结论、分析师工作记录（逐一写出 4 个计划席位及失败/缺口）、多空辩论记录、电话会管理层信号、近期公司与行业新闻、估值区间、价格条件、主要风险、仓位建议、数据缺口、置信度、来源表。不得声称 quick 等同 full。"
          : "This is a quick_v1 council, not a full council. It ran one parallel bull/bear statement, no three-round cross-exam, and no adversarial verification. Write a compact report with real Markdown headings for Conclusion, Analyst Work Log (name every planned seat and any failure/gap), Bull/Bear Debate Record, Earnings Call Management Signals, Recent Company and Industry News, Valuation Range, Price Levels, Major Risks, Position Recommendation, Data Gaps, Confidence, and Source Table. Never claim quick is equivalent to full.")
      : (chinese
          ? "这是快速委员会的唯一多空陈述轮。只给最有信息量的 4–6 条论点，使用已提供来源 ID，明确回应方法席分歧；不要生成第二/第三轮问题，也不要写长报告。"
          : "This is the quick council's only bull/bear statement round. Give only the 4-6 highest-information arguments, use supplied source IDs, and engage with method-seat disagreements. Do not create round-2/3 questions or a long report.")
    : "";

  return [
    // The original spread the preamble's lines as separate array elements, so they are
    // separated by blank lines in the final prompt. Preserve that exactly.
    ...base.split("\n"),
    roleText,
    quickInstruction,
    roundTwoInstruction,
    roundThreeInstruction,
    context.round ? `Debate round: ${context.round}` : "",
    context.brief ? `Brief length for round 1: ${context.brief}` : "",
    context.otherCaseR1 ? `Opponent prior-round case JSON: ${JSON.stringify(compactDebateContext(context.otherCaseR1))}` : "",
    context.questionsYouAsked ? `Your round 2 questions to preserve JSON: ${JSON.stringify(context.questionsYouAsked)}` : "",
    context.questionsForYou ? `Questions you must answer JSON: ${JSON.stringify(context.questionsForYou)}` : "",
    // The masters ran before the debate; the bull and bear must argue with their
    // disagreements rather than restate the evidence unopposed.
    (run.master_opinions || []).length
      ? `Master seat opinions JSON (read the disagreements; you must engage with them, not ignore them): ${JSON.stringify(compactMasterOpinions(run))}`
      : "",
    context.bull ? `Bull argument JSON: ${JSON.stringify(compactDebateContext(context.bull))}` : "",
    context.bear ? `Bear argument JSON: ${JSON.stringify(compactDebateContext(context.bear))}` : "",
    // The PM must reproduce the weighting rather than average the seats silently.
    role === "portfolio_manager"
      ? [
        chinese
          ? "各席位权重如下。你的最终裁决必须按这个权重加权，并且必须在报告里原样复现这张表（含核验调整原因）。权重为 0 的席位（自述超出判断范围）不计入。若你的结论与高权重席位相反，必须明确说明为什么。"
          : "Seat weights follow. Weight your verdict by them, and reproduce this table verbatim in the report, including the adjustment reasons. Seats at weight 0 declared themselves out of scope and do not count. If your conclusion opposes a high-weight seat, say explicitly why.",
        weightTableMarkdown(resolveSeatWeights(run, run.seat_weight_overrides || {}), language),
      ].filter(Boolean).join("\n\n")
      : "",
    role === "portfolio_manager" && !quick ? outputModeInstruction(context.outputMode || "chat", language) : "",
    `Evidence JSON: ${evidenceJson}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * A master seat reads the finished evidence through one philosophy.
 *
 * Masters deliberately run after the evidence stage and before the debate: they are a
 * judgment layer, not an evidence layer, and their disagreements are what the bull and
 * bear then have to argue with.
 */
export function masterPrompt(masterId, run) {
  const reg = registry();
  const persona = reg.get(masterId);
  if (!persona || persona.kind !== "master") throw new Error(`unknown master persona: ${masterId}`);
  const language = run.language || "English";
  const values = { symbol: run.symbol, as_of: run.as_of, language };

  const chinese = isChineseLanguage(language);
  // Masters see the same established facts the analysts saw, not only what the analysts
  // chose to report. A master's value is a different selection from the same facts --
  // Munger looking at incentives, Burry at the notes -- and reading only the analysts'
  // packets destroys exactly that. It also means one weak packet would bias all 21 seats
  // identically, which is the worst kind of error: large and perfectly correlated.
  const grounded = groundingBlock(run.grounding, language);
  const packetLabel = chinese
    ? "以下是分析师席位的证据包。这是**其他席位对同一批事实的解读**，不是事实本身。"
      + "你可以不同意他们的读法，但必须说明你依据的是上面哪一条原始事实。"
    : "Below are the analyst seats' evidence packets. These are **other seats' readings of the "
      + "same facts**, not the facts themselves. You may disagree with a reading, but say which "
      + "established fact above your disagreement rests on.";

  return [
    render(personaPrompt(reg.get("_master_base"), language), values),
    `Master: ${personaTitle(persona, language)} (${persona.id})`,
    render(personaPrompt(persona, language), values),
    `Walk-away conditions you must check explicitly: ${(persona.disqualifiers || []).join(" | ")}`,
    grounded,
    `${packetLabel}\nEvidence JSON: ${JSON.stringify(run.council_mode === "quick" ? compactQuickEvidence(run) : compactEvidence(run))}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * One isolated worker per selected physical v3 method, after its structured decision is
 * frozen. The worker may explain and challenge the evidence, but it cannot vote again.
 */
export function masterVoicePrompt(masterId, run, frozenOpinion) {
  const reg = registry();
  const persona = reg.get(masterId);
  if (!persona || persona.kind !== "master") throw new Error(`unknown master persona: ${masterId}`);
  const language = run.language || "English";
  const values = { symbol: run.symbol, as_of: run.as_of, language };
  const evidence = JSON.stringify(run.council_mode === "quick" ? compactQuickEvidence(run) : compactEvidence(run));
  return [
    `You are the dedicated, isolated method-seat explanation worker for ${personaTitle(persona, language)} (${masterId}) in the ${run.symbol} council.`,
    `Write every reader-facing field in ${language}. Keep stable IDs, tickers and source IDs unchanged.`,
    "This is a project-derived provisional method lens, not the named person's current statement, endorsement, or quotation.",
    "The structured method decision below is already frozen. You MUST NOT change, soften, strengthen or reinterpret its stance. Explain why that frozen result follows, identify the highest-information facts or missing facts, state any disagreement with analyst interpretation, and say what evidence would change the method result. Do not browse or add facts.",
    `Frozen method result JSON: ${JSON.stringify({
      master: masterId,
      stance: frozenOpinion?.stance,
      verdict: frozenOpinion?.verdict,
      summary: frozenOpinion?.summary,
      disqualifiers_triggered: frozenOpinion?.disqualifiers_triggered || [],
      what_would_change_my_mind: frozenOpinion?.what_would_change_my_mind || [],
      source_ids: frozenOpinion?.source_ids || [],
      deterministic_core_hash: frozenOpinion?.deterministic_core_hash || null,
      frozen_decision_hash: frozenOpinion?.frozen_decision_hash || null,
    })}`,
    `Method instructions (for explanation only):\n${render(personaPrompt(persona, language), values)}`,
    "Return ONLY one valid JSON object, no Markdown fence. Schema: {\"master\":\"stable id\",\"acknowledged_stance\":\"constructive|cautious|opposed|out_of_scope\",\"statement\":\"reader-facing explanation\",\"key_findings\":[\"string\"],\"disagreements\":[\"string\"],\"what_would_change_my_mind\":[\"string\"],\"source_ids\":[\"task:S1\"],\"confidence\":\"high|medium|low\"}.",
    `Bounded shared evidence JSON: ${evidence}`,
  ].join("\n\n");
}

/** The master ids a run has selected, from an explicit list or a roster name. */
export function selectedMasters(run) {
  const reg = registry();
  if (Array.isArray(run.masters) && run.masters.length) {
    return selectRoster(reg, { ids: run.masters }).filter((p) => p.kind === "master").map((p) => p.id);
  }
  if (run.masters_roster) {
    return selectRoster(reg, { kind: "master", roster: run.masters_roster }).map((p) => p.id);
  }
  return [];
}
