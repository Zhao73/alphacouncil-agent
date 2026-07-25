import { join } from "node:path";
import { isChineseLanguage, resolveLanguage } from "./lang.mjs";
import { runPath } from "./run-store.mjs";
import { compactEvidence } from "./packets.mjs";
import { outputModeInstruction } from "./output-modes.mjs";
import { personaPrompt, registry } from "./personas/registry.mjs";

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

export function taskPrompt(task, symbol, asOfDate, userPrompt = "", language = "auto") {
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

  return `${base}\n\n${chinese ? "任务：" : "Task: "}${task}\n${body}`;
}

export function debatePrompt(role, run, context = {}) {
  const evidencePath = join(runPath(run.run_id), "evidence.json");
  const evidenceJson = JSON.stringify(compactEvidence(run));
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

  const roundThreeInstruction = context.round === 3
    ? (chinese
        ? "本轮为问答轮:在 `questions` 数组里给出恰好 3 个针对对方的尖锐问题,并在 `questions_answered` 数组里逐条回答对方提出的问题。"
        : "This is the Q&A round: in a `questions` array list exactly 3 sharp questions for the other side, and in a `questions_answered` array answer the 3 questions the other side asked you.")
    : "";

  return [
    // The original spread the preamble's lines as separate array elements, so they are
    // separated by blank lines in the final prompt. Preserve that exactly.
    ...base.split("\n"),
    roleText,
    roundThreeInstruction,
    context.round ? `Debate round: ${context.round}` : "",
    context.brief ? `Brief length for round 1: ${context.brief}` : "",
    context.otherCaseR1 ? `Opponent prior-round case JSON: ${JSON.stringify(context.otherCaseR1)}` : "",
    context.questionsForYou ? `Questions you must answer JSON: ${JSON.stringify(context.questionsForYou)}` : "",
    context.bull ? `Bull argument JSON: ${JSON.stringify(context.bull)}` : "",
    context.bear ? `Bear argument JSON: ${JSON.stringify(context.bear)}` : "",
    role === "portfolio_manager" ? outputModeInstruction(context.outputMode || "chat", language) : "",
    `Evidence JSON: ${evidenceJson}`,
  ].filter(Boolean).join("\n\n");
}
