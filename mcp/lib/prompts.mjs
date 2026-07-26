import { join } from "node:path";
import { isChineseLanguage, resolveLanguage } from "./lang.mjs";
import { runPath } from "./run-store.mjs";
import { compactEvidence, compactMasterOpinions } from "./packets.mjs";
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
    // The masters ran before the debate; the bull and bear must argue with their
    // disagreements rather than restate the evidence unopposed.
    (run.master_opinions || []).length
      ? `Master seat opinions JSON (read the disagreements; you must engage with them, not ignore them): ${JSON.stringify(compactMasterOpinions(run))}`
      : "",
    context.bull ? `Bull argument JSON: ${JSON.stringify(context.bull)}` : "",
    context.bear ? `Bear argument JSON: ${JSON.stringify(context.bear)}` : "",
    // The PM must reproduce the weighting rather than average the seats silently.
    role === "portfolio_manager"
      ? [
        chinese
          ? "各席位权重如下。你的最终裁决必须按这个权重加权，并且必须在报告里原样复现这张表（含核验调整原因）。权重为 0 的席位（自述超出判断范围）不计入。若你的结论与高权重席位相反，必须明确说明为什么。"
          : "Seat weights follow. Weight your verdict by them, and reproduce this table verbatim in the report, including the adjustment reasons. Seats at weight 0 declared themselves out of scope and do not count. If your conclusion opposes a high-weight seat, say explicitly why.",
        weightTableMarkdown(resolveSeatWeights(run, run.seat_weight_overrides || {}), language),
      ].filter(Boolean).join("\n\n")
      : "",
    role === "portfolio_manager" ? outputModeInstruction(context.outputMode || "chat", language) : "",
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
    `${packetLabel}\nEvidence JSON: ${JSON.stringify(compactEvidence(run))}`,
  ].filter(Boolean).join("\n\n");
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
