// Host mode: Claude Code or Codex does the model work itself (subagents or in sequence) while
// the MCP server supplies the snapshot, the exact instructions for each task, validation and
// the final report. Same prompts, schemas, normalization and report as the terminal engine.

import { knownIds, normalizeCase, normalizeDecision, normalizeDesk } from "./normalize.mjs";
import { createRun, finishRun, loadRun, MODES, reportPath, saveMeta, savePacket } from "./pipeline.mjs";
import { casePrompt, decisionPrompt, deskPrompt, DESKS } from "./prompts.mjs";
import { CASE_SCHEMA, check, coerce, DECISION_SCHEMA, DESK_SCHEMA } from "./schemas.mjs";
import { buildSnapshot, snapshotBrief } from "./snapshot.mjs";
import { upside } from "./report.mjs";
import { runDir, writeJson } from "./store.mjs";
import { join } from "node:path";

export async function startHostRun({ symbol, mode = "deep", language = "en", question = "", host = "host", snapshot = null }) {
  const run = createRun({ symbol, mode, language, question, engine: host });
  run.snapshot = snapshot || (await buildSnapshot(run.symbol));
  run.name = run.snapshot.instrument?.name || null;
  saveMeta(run);
  writeJson(join(runDir(run.run_id), "snapshot.json"), run.snapshot);
  return run;
}

function schemaFor(task) {
  if (task === "decision") return DECISION_SCHEMA;
  if (task === "bull" || task === "bear") return CASE_SCHEMA;
  return DESK_SCHEMA;
}

function readiness(run, task) {
  const desksDone = Object.values(run.desks).filter(Boolean).length;
  const need = Math.min(2, Object.keys(run.desks).length);
  if ((task === "bull" || task === "bear" || task === "decision") && desksDone < need) {
    return `needs at least ${need} research desk result(s) first (have ${desksDone}); submit the desks, or finalize the run as incomplete`;
  }
  return null;
}

export function briefTask(runId, task) {
  const run = loadRun(runId);
  if (!(task in run.desks) && !(run.cases && task in run.cases) && task !== "decision") {
    throw new Error(`unknown task ${task}; this run's tasks are ${[...Object.keys(run.desks), ...(run.cases ? ["bull", "bear"] : []), "decision"].join(", ")}`);
  }
  const blocked = readiness(run, task);
  if (blocked) throw new Error(`${task} ${blocked}`);
  const snapshotText = snapshotBrief(run.snapshot);
  const record = { desks: run.desks, snapshotText };
  let p;
  if (task in run.desks) p = deskPrompt({ desk: task, snapshotText, run });
  else if (task === "bull" || task === "bear") p = casePrompt({ side: task, record, run });
  else p = decisionPrompt({ record, cases: run.cases, run });
  const web = task in run.desks;
  return [
    `# AlphaCouncil task: ${task} (run ${runId})`,
    `## Role\n${p.system}`,
    `## Input\n${p.user}`,
    `## Output\n${web ? "Use web search and web fetch for your research. " : "Do not browse; work from the input above. "}Then call \`research_submit\` with {"run_id": "${runId}", "task": "${task}", "result": <a JSON object matching this schema>}. If it returns errors, fix exactly those and submit again.`,
    "```json",
    JSON.stringify(schemaFor(task), null, 1),
    "```",
  ].join("\n\n");
}

export function submitTask(runId, task, result) {
  const run = loadRun(runId);
  if (run.state !== "running") return { ok: false, errors: [`run is already ${run.state}`] };
  const blocked = readiness(run, task);
  if (blocked) return { ok: false, errors: [`${task} ${blocked}`] };
  const value = coerce(result);
  const errors = check(schemaFor(task), value);
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  let norm;
  if (task in run.desks) norm = normalizeDesk(value, { desk: task, snapshot: run.snapshot, asOf: run.as_of });
  else if (task === "bull" || task === "bear") {
    if (!run.cases) return { ok: false, errors: [`this ${run.mode} run has no debate`] };
    norm = normalizeCase(value, { known: knownIds(run.snapshot, run.desks) });
  } else if (task === "decision") norm = normalizeDecision(value, { known: knownIds(run.snapshot, run.desks), snapshot: run.snapshot });
  else return { ok: false, errors: [`unknown task ${task}`] };
  if (!norm.ok) return { ok: false, errors: ["fewer than two findings cite a listed source; add sources (S1, S2 with URLs) or snapshot IDs to your findings"], warnings: norm.warnings };
  savePacket(runId, task, norm.packet);
  if (norm.warnings.length) {
    run.warnings = { ...run.warnings, [task]: norm.warnings };
    saveMeta(run);
  }
  const fresh = loadRun(runId);
  const missing = [...Object.entries(fresh.desks), ...Object.entries(fresh.cases || {}), ["decision", fresh.decision]].filter(([, v]) => !v).map(([k]) => k);
  return { ok: true, task, warnings: norm.warnings, remaining: missing };
}

export function finalizeHostRun(runId, { reason = null } = {}) {
  const run = loadRun(runId);
  if (run.state !== "running") return { run_id: runId, state: run.state, report: reportPath(runId), already: true };
  for (const [k, v] of [...Object.entries(run.desks), ...Object.entries(run.cases || {})]) if (!v) run.failures[k] = "not submitted";
  const done = finishRun(run, { reason });
  return { run_id: runId, state: done.state, rating: done.rating, report: reportPath(runId), summary: summaryMarkdown(done) };
}

/** A compact hand-off for the chat, built from the saved run. */
export function summaryMarkdown(run) {
  const d = run.decision;
  const q = run.snapshot?.quote;
  if (!d) return `**${run.symbol} — ${run.state}**: ${run.reason || ""}`;
  const up = upside(run);
  return [
    `**${run.symbol}${run.name ? ` (${run.name})` : ""}: ${d.rating}** · confidence ${d.confidence}${q ? ` · price ${q.price} ${q.currency}` : ""} · value ${d.valuation.bear} / **${d.valuation.base}** / ${d.valuation.bull} ${d.valuation.currency}${up === null ? "" : ` (${up >= 0 ? "+" : ""}${up.toFixed(0)}% to base)`}`,
    "",
    d.conclusion,
    "",
    `- **Bull:** ${run.cases?.bull?.thesis || d.bull_case}`,
    `- **Bear:** ${run.cases?.bear?.thesis || d.bear_case}`,
    d.debate_winner !== "none" ? `- **Verdict:** ${d.debate_winner} — ${d.debate_reason}` : null,
    `- **Price levels:** ${d.price_levels.map((l) => `${l.range} → ${l.action}`).join(" · ")}`,
    `- **Position:** ${d.position.action} · ${d.position.sizing}`,
    d.risks.length ? `- **Top risks:** ${d.risks.slice(0, 3).map((r) => r.risk).join("; ")}` : null,
    `- Status: ${run.state}${run.reason ? ` (${run.reason})` : ""}`,
  ].filter((x) => x !== null).join("\n");
}

export { DESKS, MODES };
