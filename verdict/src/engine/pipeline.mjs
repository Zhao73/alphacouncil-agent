// The research engine. Deep (default): snapshot → 4 desks in parallel → bull & bear in
// parallel → portfolio manager. Fast: snapshot → 1 desk → portfolio manager.
// Emits events for a UI and saves every artifact under ~/.verdict/runs/<id>/.

import { join } from "node:path";
import { normalizeLanguage } from "./i18n.mjs";
import { knownIds, normalizeCase, normalizeDecision, normalizeDesk } from "./normalize.mjs";
import { casePrompt, decisionPrompt, DEEP_DESKS, deskPrompt, FAST_DESKS, followUpPrompt } from "./prompts.mjs";
import { renderReport } from "../render/markdown.mjs";
import { CASE_SCHEMA, DECISION_SCHEMA, DESK_SCHEMA } from "./schemas.mjs";
import { buildSnapshot, snapshotBrief } from "./snapshot.mjs";
import { appendJsonl, listRuns, newRunId, readJson, readJsonl, runDir, writeJson, writeText } from "./store.mjs";
import { normalizeSymbol } from "./data.mjs";
import { classifyQuestion } from "./intent.mjs";
import { partialString } from "./partial.mjs";
import { renderHtml } from "../render/html.mjs";

export const MODES = {
  deep: { desks: DEEP_DESKS, debate: true, deskTimeout: 240_000, searches: 5, ceiling: 12 * 60e3 },
  fast: { desks: FAST_DESKS, debate: false, deskTimeout: 180_000, searches: 8, ceiling: 6 * 60e3 },
};
const CASE_TIMEOUT = 150_000;
const DECISION_TIMEOUT = 240_000;
const QUICK_FAILURE_MS = 30_000; // a failure this fast (start-up, network) is worth one retry

function combine(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("run ceiling reached")), ms);
  signal?.addEventListener?.("abort", () => controller.abort(signal.reason), { once: true });
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function attempt(fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } catch (error) {
    if (Date.now() - t0 > QUICK_FAILURE_MS || /stopped|ceiling/.test(error.message)) throw error;
    return fn();
  }
}

// Each result is its own file: parallel Claude Code subagents submit concurrently.
const packetFile = (runId, task) => join(runDir(runId), "packets", `${task}.json`);

export function taskIds(run) {
  return [...Object.keys(run.desks || {}), ...(run.cases ? ["bull", "bear"] : []), "decision"];
}

function save(run) {
  const { snapshot, desks, cases, decision, ...meta } = run;
  writeJson(join(runDir(run.run_id), "run.json"), { ...meta, tasks: taskIds(run), rating: decision?.rating || null });
  if (snapshot) writeJson(join(runDir(run.run_id), "snapshot.json"), snapshot);
  for (const [id, p] of Object.entries(desks || {})) if (p) savePacket(run.run_id, id, p);
  for (const [id, p] of Object.entries(cases || {})) if (p) savePacket(run.run_id, id, p);
  if (decision) savePacket(run.run_id, "decision", decision);
}

export function savePacket(runId, task, packet) {
  writeJson(packetFile(runId, task), packet);
}

export function saveMeta(run) {
  const { snapshot, desks, cases, decision, ...meta } = run;
  writeJson(join(runDir(run.run_id), "run.json"), { ...meta, tasks: taskIds(run), rating: decision?.rating || null });
}

export function loadRun(runId) {
  const meta = readJson(join(runDir(runId), "run.json"));
  if (!meta) throw new Error(`run not found: ${runId}`);
  const tasks = meta.tasks || [];
  const desks = {};
  for (const id of tasks.filter((x) => !["bull", "bear", "decision"].includes(x))) desks[id] = readJson(packetFile(runId, id));
  const cases = tasks.includes("bull") ? { bull: readJson(packetFile(runId, "bull")), bear: readJson(packetFile(runId, "bear")) } : null;
  const { tasks: _t, ...rest } = meta;
  return { ...rest, snapshot: readJson(join(runDir(runId), "snapshot.json")), desks, cases, decision: readJson(packetFile(runId, "decision")) };
}

export function htmlPath(runId) {
  return join(runDir(runId), "report.html");
}

export function reportPath(runId) {
  return join(runDir(runId), "report.md");
}

/** A finished run for the same symbol/mode/language within maxAgeMs, if any. */
export function recentRun({ symbol, mode, language, maxAgeMs = 6 * 3600e3 }) {
  const s = normalizeSymbol(symbol);
  return listRuns().find((r) => r.symbol === s && r.mode === mode && r.language === language && r.state !== "running" && r.state !== "incomplete" && Date.now() - Date.parse(r.created_at) < maxAgeMs) || null;
}

export function createRun({ symbol, mode = "deep", language = "en", question = "", engine = "host", models = {} }) {
  if (!MODES[mode]) throw new Error(`mode must be deep or fast (got ${mode})`);
  const sym = normalizeSymbol(symbol);
  const now = new Date();
  const run = {
    run_id: newRunId(sym), version: 3, symbol: sym, name: null, mode, language: normalizeLanguage(language), question: question || "",
    as_of: now.toISOString().slice(0, 10), created_at: now.toISOString(), engine, models, state: "running", intent: classifyQuestion(question),
    desks: Object.fromEntries(MODES[mode].desks.map((d) => [d, null])), cases: MODES[mode].debate ? { bull: null, bear: null } : null, decision: null,
    failures: {}, warnings: {}, cost_usd: 0, elapsed_ms: 0,
  };
  save(run);
  return run;
}

/** Close a run: pick its terminal state, write report.md and return the run. */
export function finishRun(run, { reason = null, started = Date.parse(run.created_at) } = {}) {
  const desksOk = Object.values(run.desks).every(Boolean);
  const casesOk = !run.cases || Object.values(run.cases).every(Boolean);
  run.state = !run.decision ? "incomplete" : desksOk && casesOk ? "complete" : "degraded";
  run.reason = reason || (run.state === "complete" ? "" : run.state === "degraded" ? `finished without: ${[...Object.entries(run.desks), ...Object.entries(run.cases || {})].filter(([, v]) => !v).map(([k]) => k).join(", ")}` : "no decision was produced");
  run.rating = run.decision?.rating || null;
  run.elapsed_ms = Date.now() - started;
  save(run);
  writeText(reportPath(run.run_id), renderReport(run));
  try {
    writeText(htmlPath(run.run_id), renderHtml(run));
  } catch {
    // the HTML export is a convenience; the markdown report is the record
  }
  return run;
}

export async function research({ symbol, mode = "deep", language = "en", question = "", backend, onEvent = () => {}, signal, snapshot = null }) {
  const cfg = MODES[mode];
  if (!cfg) throw new Error(`mode must be deep or fast (got ${mode})`);
  const started = Date.now();
  const run = createRun({ symbol, mode, language, question, engine: backend.name, models: backend.models });
  const emit = (e) => onEvent({ run_id: run.run_id, at: Date.now(), ...e });
  const spend = (usd) => {
    run.cost_usd += usd || 0;
    emit({ type: "cost", usd: run.cost_usd });
  };
  const g = combine(signal, cfg.ceiling);
  emit({ type: "run", run });
  try {
    emit({ type: "stage", stage: "snapshot" });
    run.snapshot = snapshot || (await backend.snapshotFor?.(run.symbol)) || (await buildSnapshot(run.symbol));
    run.name = run.snapshot.instrument?.name || null;
    save(run);
    emit({ type: "snapshot", snapshot: run.snapshot });
    const snapText = snapshotBrief(run.snapshot);

    emit({ type: "stage", stage: "desks" });
    await Promise.all(cfg.desks.map(async (desk) => {
      emit({ type: "task", task: desk, status: "running" });
      try {
        const p = deskPrompt({ desk, snapshotText: snapText, run });
        const r = await attempt(() => backend.call({ tier: "research", system: p.system, user: p.user, schema: DESK_SCHEMA, web: true, effort: "medium", maxSearches: cfg.searches, timeoutMs: cfg.deskTimeout, signal: g.signal, onActivity: (text) => emit({ type: "activity", task: desk, text }) }));
        spend(r.costUsd);
        const norm = normalizeDesk(r.data, { desk, snapshot: run.snapshot, asOf: run.as_of });
        if (norm.warnings.length) run.warnings[desk] = norm.warnings;
        if (!norm.ok) throw new Error("fewer than two sourced findings");
        run.desks[desk] = norm.packet;
        emit({ type: "task", task: desk, status: "done", stance: norm.packet.stance });
      } catch (error) {
        run.failures[desk] = error.message;
        emit({ type: "task", task: desk, status: "failed", error: error.message });
      }
    }));
    save(run);
    const okDesks = Object.values(run.desks).filter(Boolean).length;
    if (okDesks < Math.min(2, cfg.desks.length)) return finish(`research coverage too low (${okDesks}/${cfg.desks.length} desks)`);

    const record = { desks: run.desks, snapshotText: snapText };
    const known = knownIds(run.snapshot, run.desks);
    if (cfg.debate) {
      emit({ type: "stage", stage: "debate" });
      await Promise.all(["bull", "bear"].map(async (side) => {
        emit({ type: "task", task: side, status: "running" });
        try {
          const p = casePrompt({ side, record, run });
          const r = await attempt(() => backend.call({ tier: "debate", system: p.system, user: p.user, schema: CASE_SCHEMA, effort: "low", timeoutMs: CASE_TIMEOUT, signal: g.signal }));
          spend(r.costUsd);
          const norm = normalizeCase(r.data, { known });
          if (norm.warnings.length) run.warnings[side] = norm.warnings;
          run.cases[side] = norm.packet;
          emit({ type: "task", task: side, status: "done" });
        } catch (error) {
          run.failures[side] = error.message;
          emit({ type: "task", task: side, status: "failed", error: error.message });
        }
      }));
      save(run);
    }

    emit({ type: "stage", stage: "decision" });
    emit({ type: "task", task: "decision", status: "running" });
    try {
      const p = decisionPrompt({ record, cases: run.cases, run });
      let raw = "";
      let shown = "";
      const onText = (d) => {
        raw += d;
        const rating = partialString(raw, "rating");
        const draft = partialString(raw, "conclusion");
        if (draft && draft.value !== shown) {
          shown = draft.value;
          emit({ type: "draft", task: "decision", rating: rating?.done ? rating.value : null, text: shown });
        } else if (!draft) emit({ type: "activity", task: "decision", text: `writing… ${raw.length}` });
      };
      const r = await attempt(() => {
        raw = "";
        return backend.call({ tier: "decision", system: p.system, user: p.user, schema: DECISION_SCHEMA, effort: "medium", timeoutMs: DECISION_TIMEOUT, signal: g.signal, onText });
      });
      spend(r.costUsd);
      const norm = normalizeDecision(r.data, { known, snapshot: run.snapshot });
      if (norm.warnings.length) run.warnings.decision = norm.warnings;
      run.decision = norm.packet;
      emit({ type: "task", task: "decision", status: "done", rating: run.decision.rating });
    } catch (error) {
      run.failures.decision = error.message;
      emit({ type: "task", task: "decision", status: "failed", error: error.message });
    }
    return finish(signal?.aborted ? "stopped by user" : null);
  } catch (error) {
    return finish(error.message);
  } finally {
    g.clear();
  }

  function finish(reason) {
    finishRun(run, { reason, started });
    emit({ type: "done", run });
    return run;
  }
}

/** Follow-up question on a finished run; answers stream through onText. */
export async function ask({ runId, question, backend, onText, onActivity, signal }) {
  const run = loadRun(runId);
  const { readFileSync } = await import("node:fs");
  const report = readFileSync(reportPath(runId), "utf8");
  const history = readJsonl(join(runDir(runId), "followups.jsonl")).slice(-4);
  const p = followUpPrompt({ reportMarkdown: report, run });
  const user = [p.context, ...history.map((h) => `Q: ${h.question}\nA: ${h.answer}`), `Q: ${question}`].join("\n\n");
  const r = await backend.call({ tier: "chat", system: p.system, user, web: true, maxSearches: 3, effort: "medium", timeoutMs: 180_000, signal, onText, onActivity });
  appendJsonl(join(runDir(runId), "followups.jsonl"), { at: new Date().toISOString(), question, answer: r.text, cost_usd: r.costUsd });
  return r;
}
