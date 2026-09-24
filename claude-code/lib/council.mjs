// The council state machine. One implementation, two executors:
//   * Claude Code: the /alpha skill calls council_next and launches the returned tasks as
//     parallel subagents; subagents call council_record themselves.
//   * Terminal client: runs the same loop in-process and launches each task as `claude -p`.
// All state lives on disk under ~/.alphacouncil/runs/<run_id>/, so either executor can
// resume a run the other started.

import { existsSync } from "node:fs";
import { join } from "node:path";
import * as data from "./data.mjs";
import { evaluateLenses, LENS_IDS } from "./lenses.mjs";
import { handoffPrompt, taskPrompt } from "./prompts.mjs";
import { agentName, DEBATE_ROLES, MAX_ATTEMPTS, MODES, PACES, paceFor, VERSION } from "./spec.mjs";
import { appendEvent, newRunId, packetPath, readJson, runDir, writeJson } from "./store.mjs";
import { coercePacket, validateDebate, validateEvidence, validatePm } from "./validate.mjs";
import { renderReport } from "./report.mjs";

const BULL = "bull_researcher";
const BEAR = "bear_researcher";
const PM = "portfolio_manager";

export function slotOf(stage, role, round) {
  if (stage === "evidence") return `evidence/${role}`;
  if (stage === "debate") return `debate/r${round}/${role}`;
  if (stage === "pm") return `pm/${role}`;
  throw new Error(`unknown stage: ${stage}`);
}

// ---------------------------------------------------------------- plan / start

export function planCouncil({ symbol, mode = "full", pace = "normal", language = "en", lenses = LENS_IDS }) {
  if (!MODES[mode]) throw new Error(`mode must be full or quick (got ${mode})`);
  if (mode === "full" && !PACES[pace]) throw new Error(`pace must be fast, normal or slow (got ${pace})`);
  const spec = MODES[mode];
  const p = paceFor(mode, pace);
  const sel = normalizeLenses(lenses);
  return {
    symbol: data.normalizeSymbol(symbol),
    mode,
    pace: mode === "quick" ? null : pace,
    language,
    evidence_roles: spec.evidence,
    debate_rounds: spec.rounds,
    lenses: sel,
    all_lenses: LENS_IDS,
    stages: [
      `${spec.evidence.length} evidence analysts in parallel`,
      `${sel.length} deterministic method lenses (no model calls)`,
      spec.rounds === 1 ? "1 Bull/Bear round in parallel" : `${spec.rounds} Bull/Bear rounds (sides in parallel, rounds sequential)`,
      "portfolio manager decision",
      "report assembled by code from recorded packets",
    ],
    model_calls: spec.evidence.length + spec.rounds * 2 + 1,
    ceiling_minutes: p.total_ms / 60e3,
    ceiling_note: "Enforced by the terminal client. In Claude Code, subagent lifetimes are host-managed and the ceiling is advisory.",
  };
}

function normalizeLenses(lenses) {
  if (lenses === "all" || lenses === undefined || lenses === null) return [...LENS_IDS];
  const list = Array.isArray(lenses) ? lenses : String(lenses).split(/[,\s]+/).filter(Boolean);
  const unknown = list.filter((l) => !LENS_IDS.includes(l));
  if (unknown.length) throw new Error(`unknown lens id(s): ${unknown.join(", ")}; choose from ${LENS_IDS.join(", ")}`);
  return [...new Set(list)];
}

async function settle(label, fn, gaps) {
  try {
    return await fn();
  } catch (error) {
    gaps.push(`${label}: ${error.message}`);
    return null;
  }
}

/** Freeze grounding facts for the run. Every failure becomes a named gap. */
export async function gatherGrounding(symbol, { deep = true } = {}) {
  const gaps = [];
  const instrument = (await settle("instrument", () => data.resolveInstrument(symbol), gaps)) || { symbol, type: "unknown", route: "operating_company", gaps: [] };
  gaps.push(...(instrument.gaps || []).map((g) => `instrument: ${g}`));
  const [quote, history] = await Promise.all([
    settle("quote", () => data.getQuote(symbol), gaps),
    settle("price_history", () => data.getHistory(symbol, "2y"), gaps),
  ]);
  const fundamentals = await settle("fundamentals", () => data.getFundamentals(symbol, { instrument, price: quote?.price, currency: quote?.currency || "USD" }), gaps);
  if (fundamentals && fundamentals.available === false) gaps.push(`fundamentals: ${fundamentals.reason}`);
  const [filings, options] = deep
    ? await Promise.all([
      instrument.cik ? settle("filings", () => data.getFilings(symbol, { instrument, limit: 12 }), gaps) : null,
      settle("options", () => data.getOptions(symbol), gaps),
    ])
    : [null, null];
  if (options && options.available === false) gaps.push(`options: ${options.reason}`);
  const g = { instrument, quote, technicals: history?.technicals || null, fundamentals, filings, options, gaps };
  const sources = {};
  if (quote) sources["grounding:quote"] = quote.source;
  if (history?.technicals?.available) sources["grounding:technicals"] = history.source;
  if (fundamentals?.available) sources["grounding:fundamentals"] = fundamentals.source;
  if (filings?.available) sources["grounding:filings"] = filings.source;
  if (options?.available) sources["grounding:options"] = options.source;
  g.sources = sources;
  return g;
}

/**
 * Create a run: freeze grounding and lenses, write run.json. `grounding` can be injected
 * (tests, offline replays); otherwise it is fetched.
 */
export async function startCouncil({ symbol, mode = "full", pace = "normal", language = "en", lenses = "all", question = "", executor = "claude-code", enforceDeadline = false, grounding = null } = {}) {
  const plan = planCouncil({ symbol, mode, pace, language, lenses });
  const runId = newRunId(plan.symbol);
  const g = grounding || (await gatherGrounding(plan.symbol, { deep: mode === "full" }));
  const lensResults = evaluateLenses(g, plan.lenses, language);
  const created = new Date();
  const run = {
    run_id: runId,
    version: VERSION,
    symbol: plan.symbol,
    mode,
    pace: plan.pace,
    language,
    question: question || `Research ${plan.symbol}`,
    lenses: plan.lenses,
    executor,
    enforce_deadline: Boolean(enforceDeadline),
    created_at: created.toISOString(),
    as_of: created.toISOString().slice(0, 10),
    deadline_at: new Date(created.getTime() + paceFor(mode, pace).total_ms).toISOString(),
    instrument: g.instrument,
    evidence_roles: plan.evidence_roles,
    rounds: plan.debate_rounds,
  };
  writeJson(join(runDir(runId), "run.json"), run);
  writeJson(join(runDir(runId), "grounding.json"), g);
  writeJson(join(runDir(runId), "lenses.json"), lensResults);
  writeJson(join(runDir(runId), "attempts.json"), {});
  writeJson(join(runDir(runId), "status.json"), { state: "running", stage: "evidence", updated_at: created.toISOString() });
  appendEvent(runId, { type: "run_started", symbol: run.symbol, mode, pace: run.pace, executor });
  return { run, grounding: g, lenses: lensResults, plan };
}

// ---------------------------------------------------------------- state

export function loadRun(runId) {
  const run = readJson(join(runDir(runId), "run.json"));
  if (!run) throw new Error(`run not found: ${runId}`);
  return run;
}

function readPacket(runId, slot) {
  return readJson(packetPath(runId, slot));
}

/** Slots per stage, in order. */
export function stagePlan(run) {
  const stages = [{ stage: "evidence", round: null, slots: run.evidence_roles.map((role) => ({ role, slot: slotOf("evidence", role) })) }];
  for (let r = 1; r <= run.rounds; r += 1) {
    stages.push({ stage: "debate", round: r, slots: [BULL, BEAR].map((role) => ({ role, slot: slotOf("debate", role, r) })) });
  }
  stages.push({ stage: "pm", round: null, slots: [{ role: PM, slot: slotOf("pm", PM) }] });
  return stages;
}

/** Status of every slot: done | failed | issued | pending. */
export function computeState(runId) {
  const run = loadRun(runId);
  const attempts = readJson(join(runDir(runId), "attempts.json"), {});
  const status = readJson(join(runDir(runId), "status.json"), {});
  const stages = stagePlan(run).map((st) => ({
    ...st,
    slots: st.slots.map((s) => {
      const a = attempts[s.slot] || { attempts: 0 };
      const done = existsSync(packetPath(runId, s.slot));
      const st2 = done ? "done" : a.failed ? "failed" : a.attempts > 0 ? "issued" : "pending";
      return { ...s, status: st2, attempts: a.attempts || 0, last_error: a.last_error || null };
    }),
  }));
  return { run, stages, status, attempts };
}

function evidenceCoverage(run, evidenceStage) {
  const spec = MODES[run.mode];
  const done = evidenceStage.slots.filter((s) => s.status === "done").map((s) => s.role);
  const missingRequired = spec.required.filter((r) => !done.includes(r));
  const ok = missingRequired.length === 0 && done.length >= spec.minEvidence;
  return { ok, done, missingRequired, needed: spec.minEvidence };
}

/** The stage currently accepting packets, or null once everything is settled. */
function openStage(state) {
  for (const st of state.stages) {
    if (st.slots.some((s) => s.status === "issued" || s.status === "pending")) return st;
  }
  return null;
}

function setStatus(runId, patch) {
  const path = join(runDir(runId), "status.json");
  writeJson(path, { ...readJson(path, {}), ...patch, updated_at: new Date().toISOString() });
}

function markAttempt(runId, slot, patch) {
  const path = join(runDir(runId), "attempts.json");
  const all = readJson(path, {});
  all[slot] = { ...(all[slot] || { attempts: 0 }), ...patch };
  writeJson(path, all);
  return all[slot];
}

/** Executors report a worker that died, timed out or ended without recording. */
export function reportFailure(runId, { role, stage, round = null, reason = "worker ended without recording" }) {
  const slot = slotOf(stage, role, round);
  markAttempt(runId, slot, { last_error: String(reason).slice(0, 500) });
  appendEvent(runId, { type: "task_failed", slot, reason: String(reason).slice(0, 500) });
}

/**
 * Advance the state machine. Call it only after every task from the previous call has
 * returned: an issued slot without a packet counts as a failed attempt and is re-issued once
 * as a repair, then marked failed.
 */
export function nextTasks(runId) {
  let state = computeState(runId);
  const { run } = state;
  if (state.status.state && state.status.state !== "running") {
    return { run_id: runId, done: true, finalized: true, state: state.status.state, tasks: [] };
  }
  if (run.enforce_deadline && Date.now() > Date.parse(run.deadline_at)) {
    appendEvent(runId, { type: "deadline_reached" });
    return { run_id: runId, done: true, finalize: true, reason: "global deadline reached", tasks: [] };
  }
  // An issued slot still without a packet is a finished, unsuccessful attempt. Once its
  // attempts are spent it is failed; otherwise it is re-issued below as a repair.
  let settledAny = false;
  for (const st of state.stages) {
    for (const s of st.slots) {
      if (s.status === "issued" && s.attempts >= MAX_ATTEMPTS) {
        markAttempt(runId, s.slot, { failed: true });
        appendEvent(runId, { type: "slot_failed", slot: s.slot, reason: s.last_error || "no valid packet after all attempts" });
        settledAny = true;
      }
    }
  }
  if (settledAny) state = computeState(runId);
  const stages = state.stages;
  // Evidence coverage gate: once evidence is settled, too little coverage stops the run.
  const ev = stages[0];
  const evSettled = ev.slots.every((s) => s.status === "done" || s.status === "failed");
  if (evSettled) {
    const cov = evidenceCoverage(run, ev);
    if (!cov.ok) {
      appendEvent(runId, { type: "coverage_failed", ...cov });
      return { run_id: runId, done: true, finalize: true, reason: `evidence coverage too low: need ${cov.needed} incl. ${MODES[run.mode].required.join(", ")}; have ${cov.done.join(", ") || "none"}`, tasks: [] };
    }
  }
  for (const st of stages.slice(1)) {
    const prior = stages[stages.indexOf(st) - 1];
    if (prior.stage !== "evidence" && prior.slots.some((s) => s.status === "failed")) {
      return { run_id: runId, done: true, finalize: true, reason: `${prior.stage}${prior.round ? ` round ${prior.round}` : ""} failed: ${prior.slots.filter((s) => s.status === "failed").map((s) => s.role).join(", ")}`, tasks: [] };
    }
    if (st.slots.every((s) => s.status === "done")) continue;
    if (!prior.slots.every((s) => s.status === "done" || s.status === "failed")) break;
  }
  const open = openStage(state);
  if (!open) {
    const last = stages.at(-1);
    if (last.slots.some((s) => s.status === "failed")) return { run_id: runId, done: true, finalize: true, reason: "portfolio manager failed", tasks: [] };
    return { run_id: runId, done: true, finalize: true, reason: "all stages recorded", tasks: [] };
  }
  const tasks = [];
  for (const s of open.slots) {
    if (s.status === "done" || s.status === "failed") continue;
    const a = markAttempt(runId, s.slot, { attempts: s.attempts + 1, issued_at: new Date().toISOString() });
    const task = { task_id: `${s.slot}#${a.attempts}`, slot: s.slot, role: s.role, agent: agentName(s.role), stage: open.stage, round: open.round, attempt: a.attempts };
    task.timeout_ms = timeoutFor(run, open.stage);
    task.prompt = taskPrompt(run, task, { briefing: buildBriefing(runId, task) });
    task.handoff = handoffPrompt(run, task);
    tasks.push(task);
    appendEvent(runId, { type: "task_issued", slot: s.slot, attempt: a.attempts });
  }
  setStatus(runId, { state: "running", stage: open.stage, round: open.round });
  return { run_id: runId, done: false, stage: open.stage, round: open.round, tasks };
}

function timeoutFor(run, stage) {
  const p = paceFor(run.mode, run.pace);
  return stage === "evidence" ? p.evidence_ms : stage === "debate" ? p.debate_ms : p.pm_ms;
}

/** Full instructions for an issued task, regenerated from disk (Claude Code subagents fetch this). */
export function taskBrief(runId, taskId) {
  const m = String(taskId || "").match(/^(evidence|debate\/r(\d)|pm)\/([a-z_]+)#(\d+)$/);
  if (!m) throw new Error(`invalid task_id: ${taskId} (expected e.g. evidence/market_data#1)`);
  const stage = m[1].startsWith("debate") ? "debate" : m[1];
  const task = { role: m[3], stage, round: m[2] ? Number(m[2]) : null, attempt: Number(m[4]) };
  const run = loadRun(runId);
  return taskPrompt(run, task, { briefing: buildBriefing(runId, task) });
}

// ---------------------------------------------------------------- record

export function knownIds(runId) {
  const g = readJson(join(runDir(runId), "grounding.json"), {});
  const lenses = readJson(join(runDir(runId), "lenses.json"), []);
  const run = loadRun(runId);
  const ids = new Set(Object.keys(g.sources || {}));
  for (const l of lenses) ids.add(`lens:${l.id}`);
  for (const role of run.evidence_roles) {
    const p = readPacket(runId, slotOf("evidence", role));
    for (const s of p?.packet?.sources || []) ids.add(`${role}:${s.id}`);
  }
  return ids;
}

export function recordPacket(runId, { role, stage, round = null, packet }) {
  const state = computeState(runId);
  const { run } = state;
  if (state.status.state && state.status.state !== "running") return { ok: false, errors: [`run is already ${state.status.state}`] };
  round = stage === "debate" ? Number(round) : null;
  let slot;
  try {
    slot = slotOf(stage, role, round);
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
  const target = state.stages.find((st) => st.slots.some((s) => s.slot === slot));
  if (!target) return { ok: false, errors: [`${role} has no ${stage}${round ? ` round ${round}` : ""} seat in this ${run.mode} run`] };
  const open = openStage(state);
  if (!open || open !== target) {
    return { ok: false, errors: [`stage ${stage}${round ? ` round ${round}` : ""} is not open (open stage: ${open ? `${open.stage}${open.round ? ` round ${open.round}` : ""}` : "none"})`] };
  }
  const p = coercePacket(packet);
  const pace = paceFor(run.mode, run.pace);
  let result;
  if (stage === "evidence") {
    result = validateEvidence(p, { maxFindings: pace.maxFindings, role, asOf: run.as_of });
  } else if (stage === "debate") {
    const opponent = role === BULL ? BEAR : BULL;
    const opponentR2 = round === 3 ? readPacket(runId, slotOf("debate", opponent, 2)) : null;
    result = validateDebate(p, { round, known: knownIds(runId), opponentQuestions: opponentR2?.packet?.questions || [] });
  } else {
    result = validatePm(p, { known: knownIds(runId), mode: run.mode });
  }
  if (result.errors.length) {
    markAttempt(runId, slot, { last_error: result.errors.slice(0, 3).join("; ") });
    appendEvent(runId, { type: "record_rejected", slot, errors: result.errors.slice(0, 10) });
    return { ok: false, errors: result.errors, warnings: result.warnings };
  }
  const attempts = readJson(join(runDir(runId), "attempts.json"), {})[slot]?.attempts || 0;
  writeJson(packetPath(runId, slot), { role, stage, round, attempt: attempts, recorded_at: new Date().toISOString(), packet: p });
  markAttempt(runId, slot, { last_error: null });
  appendEvent(runId, { type: "recorded", slot, signal: p.signal || p.rating || null });
  return { ok: true, slot, warnings: result.warnings };
}

// ---------------------------------------------------------------- briefing

const fmtNum = (x) => (x === null || x === undefined ? "n/a" : typeof x === "number" && Math.abs(x) >= 1e6 ? `${(x / 1e9).toFixed(2)}B` : String(x));

function groundingMarkdown(g) {
  const lines = [];
  const q = g.quote;
  if (q) lines.push(`- grounding:quote — ${q.symbol} ${q.price} ${q.currency} (delayed, ${q.market_time || "time n/a"}), day ${q.change_pct ?? "n/a"}%, 52w ${q.low_52w}–${q.high_52w}, dividend yield ${q.dividend_yield_pct ?? "n/a"}%`);
  const t = g.technicals;
  if (t?.available) lines.push(`- grounding:technicals — returns 1m ${t.return_1m_pct}%, 3m ${t.return_3m_pct}%, 12m ${t.return_12m_pct}%; vs SMA50 ${t.pct_vs_sma50}%, vs SMA200 ${t.pct_vs_sma200}%; RSI14 ${t.rsi14}; 30d vol ${t.realized_vol_30d_pct}%; from 52w high ${t.pct_from_52w_high}%; 1y max drawdown ${t.max_drawdown_1y_pct}%`);
  const f = g.fundamentals;
  if (f?.available) {
    const m = f.metrics;
    const r = f.ratios;
    lines.push(`- grounding:fundamentals — SEC XBRL (USD, TTM): revenue ${fmtNum(m.revenue?.value)} (as of ${m.revenue?.as_of || "n/a"}), net income ${fmtNum(m.net_income?.value)}, FCF ${fmtNum(m.free_cash_flow?.value)}, EPS ${m.eps_diluted?.value ?? "n/a"}; margins gross ${r.gross_margin_pct ?? "n/a"}% / op ${r.operating_margin_pct ?? "n/a"}% / net ${r.net_margin_pct ?? "n/a"}%; revenue growth ${r.revenue_growth_pct ?? "n/a"}% (3y CAGR ${r.revenue_cagr_3y_pct ?? "n/a"}%); ROE ${r.roe_pct ?? "n/a"}%; D/E ${r.debt_to_equity ?? "n/a"}; market cap ${fmtNum(r.market_cap)}; P/E ${r.pe_ttm ?? "n/a"}, P/S ${r.ps_ttm ?? "n/a"}, P/B ${r.pb ?? "n/a"}, EV/Rev ${r.ev_to_revenue ?? "n/a"}, FCF yield ${r.fcf_yield_pct ?? "n/a"}%, PEG ${r.peg ?? "n/a"}; share count 1y ${r.share_count_change_pct ?? "n/a"}%`);
  }
  if (g.filings?.available) lines.push(`- grounding:filings — recent: ${g.filings.filings.slice(0, 8).map((x) => `${x.form} ${x.filed}`).join(", ")}`);
  const o = g.options;
  if (o?.available) lines.push(`- grounding:options — put/call OI ${o.put_call_oi_ratio}, volume ${o.put_call_volume_ratio}; ATM IV term ${o.term_structure.slice(0, 5).map((x) => `${x.days}d ${x.atm_iv_pct}%${x.skew_25d_pct !== null ? ` (skew ${x.skew_25d_pct})` : ""}`).join(", ")}`);
  if (g.gaps?.length) lines.push(`- grounding gaps: ${g.gaps.join("; ")}`);
  return lines.join("\n") || "- no grounding data could be retrieved; every number must come from your own research";
}

function lensesMarkdown(lenses) {
  return lenses.map((l) => {
    const checks = l.checks.map((c) => `${c.label} ${c.display} (${c.rule}) ${c.pass === null ? "–" : c.pass ? "✓" : "✗"}`).join("; ");
    return `- lens:${l.id} — ${l.name}: **${l.stance}**${l.score !== null ? ` (${l.score})` : ""}. ${l.rationale}${checks ? ` Checks: ${checks}` : ""}`;
  }).join("\n");
}

function evidenceMarkdown(runId, run) {
  const out = [];
  for (const role of run.evidence_roles) {
    const rec = readPacket(runId, slotOf("evidence", role));
    if (!rec) {
      out.push(`### ${role} — FAILED / not available (treat as a data gap)`);
      continue;
    }
    const p = rec.packet;
    out.push(`### ${role} — ${p.signal}, confidence ${p.confidence}\n${p.summary}`);
    for (const f of p.findings) out.push(`- (${f.impact}) ${f.claim} [${f.sources.map((s) => `${role}:${s}`).join(", ")}]`);
    if (p.data_gaps?.length) out.push(`- gaps: ${p.data_gaps.join("; ")}`);
    out.push(`- sources: ${p.sources.map((s) => `${role}:${s.id} ${s.title}${s.date ? ` (${s.date})` : ""}`).join(" | ")}`);
  }
  return out.join("\n");
}

function debateMarkdown(runId, run, uptoRound) {
  const out = [];
  for (let r = 1; r <= uptoRound; r += 1) {
    for (const role of [BULL, BEAR]) {
      const rec = readPacket(runId, slotOf("debate", role, r));
      if (!rec) continue;
      out.push(`### Round ${r} — ${DEBATE_ROLES[role].side.toUpperCase()}\n\`\`\`json\n${JSON.stringify(rec.packet, null, 1)}\n\`\`\``);
    }
  }
  return out.join("\n\n") || "(no debate recorded yet)";
}

export function buildBriefing(runId, { role, stage, round = null }) {
  const run = loadRun(runId);
  const g = readJson(join(runDir(runId), "grounding.json"), {});
  const lenses = readJson(join(runDir(runId), "lenses.json"), []);
  const parts = [`## Frozen grounding facts\n${groundingMarkdown(g)}`];
  if (stage === "evidence") return parts.join("\n\n");
  parts.push(`## Deterministic method lenses (frozen before any debate)\n${lensesMarkdown(lenses)}`);
  parts.push(`## Evidence packets\n${evidenceMarkdown(runId, run)}`);
  const upto = stage === "pm" ? run.rounds : Number(round) - 1;
  if (upto >= 1) parts.push(`## Debate so far\n${debateMarkdown(runId, run, upto)}`);
  if (stage === "debate" && Number(round) === 3) {
    const opponent = role === BULL ? BEAR : BULL;
    const q = readPacket(runId, slotOf("debate", opponent, 2))?.packet?.questions || [];
    parts.push(`## Questions you must answer (from ${opponent}, round 2)\n${q.map((x) => `- ${x.id}: ${x.question}`).join("\n") || "(none recorded)"}`);
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------- finalize

export function finalizeCouncil(runId, { reason = null } = {}) {
  const state = computeState(runId);
  const { run } = state;
  if (state.status.state && state.status.state !== "running") {
    return { run_id: runId, state: state.status.state, already_final: true, dir: runDir(runId), report: join(runDir(runId), "final_report.md") };
  }
  const failed = [];
  const skipped = [];
  for (const st of state.stages) {
    for (const s of st.slots) {
      if (s.status === "failed") failed.push(s.slot);
      else if (s.status !== "done") skipped.push(s.slot);
    }
  }
  const pmDone = state.stages.at(-1).slots[0].status === "done";
  const terminal = !pmDone ? "incomplete" : failed.length ? "degraded" : "complete";
  const pm = pmDone ? readPacket(runId, slotOf("pm", PM)).packet : null;
  const finishedAt = new Date();
  const status = {
    state: terminal,
    rating: pm?.rating || null,
    reason: reason || (terminal === "complete" ? "all stages recorded" : terminal === "degraded" ? `completed with failed seats: ${failed.join(", ")}` : `stopped before the PM decision${failed.length ? `; failed: ${failed.join(", ")}` : ""}`),
    failed,
    skipped,
    finished_at: finishedAt.toISOString(),
    elapsed_ms: finishedAt - Date.parse(run.created_at),
    deadline_at: run.deadline_at,
    past_deadline: finishedAt > Date.parse(run.deadline_at),
  };
  const out = renderReport(runId, status);
  writeJson(join(runDir(runId), "status.json"), { ...status, stage: "final", updated_at: finishedAt.toISOString() });
  appendEvent(runId, { type: "run_finalized", state: terminal, rating: status.rating });
  return { run_id: runId, state: terminal, rating: status.rating, reason: status.reason, failed, skipped, dir: runDir(runId), files: out.files, handoff_markdown: out.handoff, quality: out.quality };
}

export function councilStatus(runId) {
  const state = computeState(runId);
  return {
    run_id: runId,
    symbol: state.run.symbol,
    mode: state.run.mode,
    state: state.status.state || "running",
    stage: state.status.stage || null,
    rating: state.status.rating || null,
    created_at: state.run.created_at,
    deadline_at: state.run.deadline_at,
    dir: runDir(runId),
    slots: state.stages.flatMap((st) => st.slots.map((s) => ({ slot: s.slot, status: s.status, attempts: s.attempts, last_error: s.last_error }))),
  };
}
