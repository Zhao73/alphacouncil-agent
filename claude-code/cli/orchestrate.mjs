// Deterministic executor for the council state machine: the terminal client owns every worker's
// lifecycle, so it enforces per-task caps and the run's global deadline.

import { existsSync } from "node:fs";
import { computeState, finalizeCouncil, loadRun, nextTasks, reportFailure, stagePlan } from "../lib/council.mjs";
import { packetPath, readJson } from "../lib/store.mjs";
import { runWorker } from "./worker.mjs";

const DEADLINE_RESERVE_MS = 15_000;

export const DEFAULT_MODELS = { evidence: "sonnet", debate: "sonnet", pm: "opus" };

/** Live view model consumed by the dashboard. */
export function createView(runId) {
  const run = loadRun(runId);
  const view = { run, stage: null, round: null, started: Date.parse(run.created_at), costUsd: 0, seats: new Map(), log: [], done: false, result: null };
  const state = computeState(runId);
  for (const st of stagePlan(run)) {
    for (const s of st.slots) {
      const cur = state.stages.flatMap((x) => x.slots).find((x) => x.slot === s.slot);
      view.seats.set(s.slot, { slot: s.slot, role: s.role, stage: st.stage, round: st.round, status: cur?.status === "done" ? "done" : cur?.status === "failed" ? "failed" : "waiting", attempt: cur?.attempts || 0, activity: "", tools: 0, costUsd: 0, startedAt: null, endedAt: null, signal: null, error: cur?.last_error || null });
    }
  }
  return view;
}

function log(view, text) {
  view.log.push({ at: new Date(), text });
  if (view.log.length > 200) view.log.shift();
}

async function pool(items, limit, fn) {
  const queue = [...items];
  const runners = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(runners);
}

export async function runCouncil(runId, { models = DEFAULT_MODELS, concurrency = 8, budgetUsd = null, onUpdate = () => {}, signal, view = createView(runId) } = {}) {
  const run = view.run;
  const deadline = Date.parse(run.deadline_at);
  let reason = null;
  for (;;) {
    if (signal?.aborted) {
      reason = "stopped by user";
      break;
    }
    const next = nextTasks(runId);
    if (next.done) {
      reason = next.reason;
      break;
    }
    view.stage = next.stage;
    view.round = next.round;
    log(view, `${next.stage}${next.round ? ` round ${next.round}` : ""}: ${next.tasks.length} task(s)`);
    onUpdate(view);
    await pool(next.tasks, concurrency, async (task) => {
      const seat = view.seats.get(task.slot);
      const remaining = deadline - Date.now() - DEADLINE_RESERVE_MS;
      if (run.enforce_deadline && remaining < 10_000) {
        reportFailure(runId, { role: task.role, stage: task.stage, round: task.round, reason: "no time left before the run deadline" });
        Object.assign(seat, { status: "failed", error: "deadline" });
        return;
      }
      const timeout = run.enforce_deadline ? Math.min(task.timeout_ms, remaining) : task.timeout_ms;
      Object.assign(seat, { status: "running", attempt: task.attempt, startedAt: Date.now(), endedAt: null, activity: task.attempt > 1 ? "repair attempt" : "starting", error: null });
      onUpdate(view);
      const res = await runWorker({ ...task, run_id: runId, timeout_ms: timeout }, {
        model: models[task.stage === "pm" ? "pm" : task.stage] || DEFAULT_MODELS[task.stage],
        budgetUsd,
        signal,
        onActivity: (text) => {
          seat.activity = text;
          seat.tools += 1;
          onUpdate(view);
        },
      });
      seat.endedAt = Date.now();
      seat.costUsd += res.costUsd || 0;
      view.costUsd += res.costUsd || 0;
      if (existsSync(packetPath(runId, task.slot))) {
        const p = readJson(packetPath(runId, task.slot))?.packet || {};
        Object.assign(seat, { status: "done", signal: p.signal || p.rating || null, activity: "" });
        log(view, `✓ ${task.role}${task.round ? ` r${task.round}` : ""}${seat.signal ? ` (${seat.signal})` : ""}`);
      } else {
        const why = res.error || `ended without recording${res.reply ? `: ${res.reply}` : ""}`;
        reportFailure(runId, { role: task.role, stage: task.stage, round: task.round, reason: why });
        Object.assign(seat, { status: task.attempt >= 2 ? "failed" : "retry", error: why, activity: "" });
        log(view, `✗ ${task.role}${task.round ? ` r${task.round}` : ""}: ${why}`);
      }
      onUpdate(view);
    });
  }
  const fin = finalizeCouncil(runId, { reason });
  view.done = true;
  view.result = fin;
  log(view, `run ${fin.state}${fin.rating ? ` — ${fin.rating}` : ""}`);
  onUpdate(view);
  return fin;
}
