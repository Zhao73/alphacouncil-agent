// Task prompts: the mechanics of one seat's job (IDs, schema, recording). The seat's expertise
// lives in agents/<agent>.md, which Claude Code loads as the subagent definition and the
// terminal client passes as the worker's system prompt.

import { EVIDENCE_ROLES, paceFor, roleTitle } from "./spec.mjs";

const EVIDENCE_SCHEMA = `{
  "summary": "2-5 sentences: what this seat found and why it matters",
  "signal": "bullish | bearish | neutral | mixed",
  "confidence": "low | medium | high",
  "findings": [
    { "claim": "one specific, dated, numeric where possible claim", "impact": "bullish | bearish | neutral | mixed", "sources": ["S1"] }
  ],
  "sources": [
    { "id": "S1", "title": "document or page title", "url": "https://... or tool:<tool_name>", "publisher": "optional", "date": "YYYY-MM-DD (optional)" }
  ],
  "metrics": { "optional name": "value with unit" },
  "data_gaps": ["anything you could not retrieve; empty array if none"]
}`;

const DEBATE_SCHEMAS = {
  1: `{
  "thesis": "your side's thesis in 2-4 sentences",
  "arguments": [ { "point": "argument", "evidence": ["market_data:S2", "grounding:fundamentals", "lens:quality_compounder"] } ],
  "concessions": ["optional: the strongest point for the other side you accept"]
}`,
  2: `{
  "rebuttals": [ { "target": "the opponent argument you attack", "response": "why it is wrong or overstated", "evidence": ["valuation_long_short:S1"] } ],
  "questions": [ { "id": "Q1", "question": "a pointed question the opponent must answer in round 3" } ]
}`,
  3: `{
  "answers": [ { "question_id": "Q1", "answer": "direct answer to the opponent's question", "evidence": ["earnings_deep_dive:S3"] } ],
  "closing": "closing statement: where your case stands after cross-examination"
}`,
};

const PM_SCHEMA = `{
  "rating": "Buy | Overweight | Hold | Underweight | Sell",
  "conclusion": "the decision and the two or three facts that drive it",
  "confidence": "low | medium | high",
  "confidence_rationale": "what would raise or lower confidence",
  "debate_winner": "bull | bear | balanced",
  "debate_assessment": "who won which points and why; unresolved questions",
  "long_thesis": "...", "short_thesis": "...",
  "market_expectations": "what the current price implies (growth, margins, multiple) and the thresholds that would re-rate it",
  "valuation": { "currency": "USD", "bear": 0, "base": 0, "bull": 0, "method": "how the per-share values were derived", "horizon": "12 months" },
  "price_levels": [ { "range": "> 250", "meaning": "what this price implies", "action": "avoid / start / add" } ],
  "catalysts": [ { "event": "...", "timing": "e.g. late Oct 2026", "direction": "positive | negative | either" } ],
  "risks": [ { "risk": "...", "severity": "low | medium | high", "mitigant": "optional" } ],
  "position": { "action": "e.g. initiate small long", "sizing": "...", "entry": "...", "exit": "..." },
  "horizons": { "short_term": "1-4 weeks view", "medium_term": "3-6 months view", "long_term": "12 months view" },
  "invalidation": ["condition that proves the thesis wrong"],
  "data_gaps": ["material gaps that limit the decision; empty if none"],
  "key_sources": ["market_data:S1", "grounding:quote"]
}`;

const ROUTE_GUIDANCE = {
  fund_lookthrough: "This is a fund/ETF. Do NOT use issuer revenue, EPS, guidance or Form 4 as if it were a company. Research dated holdings and weights, methodology, concentration, fees, flows, tracking and a same-date aggregate valuation with its coverage weight. Record company-only items as not applicable.",
  index_aggregate: "This is an index. Do NOT build index revenue, EPS or management guidance from a few constituents. Research methodology, constituents and weights, concentration, aggregate valuation with coverage weight, breadth and rebalances. Record company-only items as not applicable.",
};

function header(run, task) {
  const inst = run.instrument || {};
  const where = task.stage === "debate" ? ` round ${task.round} of ${run.rounds}` : "";
  return [
    `AlphaCouncil run \`${run.run_id}\` — ${run.symbol}${inst.name ? ` (${inst.name})` : ""}, ${inst.type || "unknown type"}, route ${inst.route || "operating_company"}. As of ${run.as_of}. Mode: ${run.mode}.`,
    `Your seat: ${roleTitle(task.role, "en")} (\`${task.role}\`), stage ${task.stage}${where}.${task.attempt > 1 ? " This is a REPAIR attempt: the previous attempt did not record a valid packet." : ""}`,
    `User request: ${JSON.stringify(run.question || `Research ${run.symbol}`)}`,
    `Write every prose value in ${run.language}. Keep JSON keys, enum values, IDs, tickers and numbers unchanged.`,
  ].join("\n");
}

function recording(run, task, extra = "") {
  const roundArg = task.stage === "debate" ? `, "round": ${task.round}` : "";
  return [
    `When done, call the \`council_record\` tool with {"run_id": "${run.run_id}", "role": "${task.role}", "stage": "${task.stage}"${roundArg}, "packet": <your packet object>}.`,
    "If it returns errors, fix exactly those fields and call it again (at most two more tries). Do not write files.",
    extra,
    `Your final reply must be ONE line: \`RECORDED ${task.role}\` or \`FAILED ${task.role}: <reason>\`. Do not repeat the packet in the reply.`,
  ].filter(Boolean).join("\n");
}

function briefingBlock(briefing) {
  return `## Briefing (frozen for this run)\n\n${briefing}`;
}

/**
 * The short prompt a Claude Code orchestrator passes to a subagent. The subagent pulls its full
 * instructions with council_brief, so the main conversation never re-types long prompts.
 */
export function handoffPrompt(run, task) {
  const taskId = `${task.slot}#${task.attempt}`;
  return `AlphaCouncil task. run_id: ${run.run_id} · task_id: ${taskId}. First call the \`council_brief\` tool with {"run_id": "${run.run_id}", "task_id": "${taskId}"} and follow the instructions it returns exactly. Reply with one line when done.`;
}

export function taskPrompt(run, task, { briefing = null } = {}) {
  const pace = paceFor(run.mode, run.pace);
  const parts = [header(run, task)];
  if (task.stage === "evidence") {
    parts.push(`## Your focus\n${EVIDENCE_ROLES[task.role].focus}`);
    const route = ROUTE_GUIDANCE[run.instrument?.route];
    if (route) parts.push(`## Instrument route\n${route}`);
    parts.push(briefingBlock(briefing));
    parts.push([
      "## Method",
      "Research with web search/fetch and the AlphaCouncil data tools (quote, price_history, fundamentals, filings, news, options_snapshot, macro_snapshot). Every number must come from something retrieved in THIS run; never fill a value from memory. A missing item goes in data_gaps.",
      "Cite each finding with local source IDs (S1, S2, ...) from your own sources list. Data returned by a tool is cited with url `tool:<tool_name>`.",
      `At most ${pace.maxFindings} findings, at least 3. ${pace.style}`.trim(),
    ].join("\n"));
    parts.push(`## Packet schema (stage "evidence")\n\`\`\`json\n${EVIDENCE_SCHEMA}\n\`\`\``);
  } else if (task.stage === "debate") {
    const side = task.role === "bull_researcher" ? "BULL (long)" : "BEAR (short)";
    const goal = {
      1: `Round 1 — opening. Build the strongest honest ${side} case from the evidence.`,
      2: "Round 2 — rebuttal. Attack the opponent's round-1 arguments and ask 1-3 pointed questions they must answer.",
      3: "Round 3 — answers. Answer EVERY question the opponent asked you in round 2 (use their question IDs), then close.",
    }[task.round];
    parts.push(`## Your job\nYou argue the ${side} side. ${goal} Cite only IDs that appear in the briefing (evidence \`role:S#\`, \`grounding:*\`, \`lens:*\`). Do not browse for new facts; argue from the record. ${pace.style}`.trim());
    parts.push(briefingBlock(briefing));
    parts.push(`## Packet schema (stage "debate", round ${task.round})\n\`\`\`json\n${DEBATE_SCHEMAS[task.round]}\n\`\`\``);
  } else {
    parts.push("## Your job\nDecide. Weigh the evidence, the deterministic method lenses (an `out_of_scope` lens is a coverage gap, never a vote) and the debate. Do not count seats as votes. Price levels are conditions, not a target. Every data gap you inherit must be carried into data_gaps. Cite only IDs from the briefing.");
    if (run.mode === "quick") parts.push("Quick mode: `horizons` is optional; keep every field short.");
    parts.push(briefingBlock(briefing));
    parts.push(`## Packet schema (stage "pm")\n\`\`\`json\n${PM_SCHEMA}\n\`\`\``);
  }
  parts.push(`## Recording\n${recording(run, task)}`);
  return parts.join("\n\n");
}
