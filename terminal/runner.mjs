import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "../mcp/lib/fsutil.mjs";
import { runPath } from "../mcp/lib/run-store.mjs";
import { readRunnerState, runnerPath, writeRunnerState } from "./service.mjs";

const FINAL_STATES = new Set(["complete", "degraded", "incomplete", "failed", "needs_revision", "needs_verification"]);

export async function executeRun(payload, { dispatch, withConnection, notify = () => {} } = {}) {
  const id = payload.run_id;
  let state = readRunnerState(id);
  if (!state || state.owner_token !== payload.owner_token || state.pid !== process.pid) throw new Error("RUNNER_OWNER_MISMATCH");
  const controller = new AbortController();
  let stopRequested = false;
  const persist = (patch) => {
    state = { ...state, ...patch };
    writeRunnerState(id, state);
  };
  const checkStop = () => {
    const path = runnerPath(id, ".stop.json");
    if (!stopRequested && existsSync(path)) {
      const request = readJson(path);
      if (request.owner_token === payload.owner_token && request.run_id === id) {
        stopRequested = true;
        persist({ state: "stopping", stop_reason: "user_cancelled", stop_requested_at: request.requested_at });
        controller.abort(new Error("user_cancelled"));
      }
    }
  };
  const onSignal = () => {
    stopRequested = true;
    persist({ state: "stopping", stop_reason: "runner_terminated", stop_requested_at: new Date().toISOString() });
    controller.abort(new Error("runner_terminated"));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  const heartbeat = setInterval(() => {
    try { checkStop(); persist({}); } catch { controller.abort(new Error("runner_control_unavailable")); }
  }, 500);
  try {
    dispatch ||= (await import("../mcp/lib/rpc.mjs")).dispatchRequest;
    if (payload.connection) withConnection ||= (await import("./providers.mjs")).withConnection;
    checkStop();
    if (stopRequested) return;
    persist({ state: "running" });
    notify({ type: "ready", run_id: id, owner_token: payload.owner_token });
    const operation = async () => dispatch({ jsonrpc: "2.0", id: "terminal-run", method: "tools/call", params: { name: "analyze_symbol", arguments: { ...payload.research, run_id: id, wait_for_completion: true } } });
    const response = payload.connection
      ? await withConnection(payload.connection, operation, { apiKey: payload.apiKey, signal: controller.signal, sessionId: id })
      : await operation();
    const statusPath = join(runPath(id), "status.json");
    const status = existsSync(statusPath) ? readJson(statusPath) : null;
    if (response?.error && !FINAL_STATES.has(status?.status) && existsSync(join(runPath(id), "evidence.json"))) {
      const { finalizeUnhandledBackgroundFailure } = await import("../mcp/lib/orchestrator.mjs");
      finalizeUnhandledBackgroundFailure(id, payload.research.prompt, new Error(stopRequested ? "user_cancelled" : "terminal_runner_failed"));
    }
    persist({ state: stopRequested ? "stopped" : response?.error ? "failed" : "completed",
      completed_at: new Date().toISOString(), ...(response?.error ? { error: response.error.data?.reason || "RESEARCH_FAILED" } : {}) });
  } catch {
    const statusPath = join(runPath(id), "status.json");
    const status = existsSync(statusPath) ? readJson(statusPath) : null;
    if (!FINAL_STATES.has(status?.status) && existsSync(join(runPath(id), "evidence.json"))) {
      try {
        const { finalizeUnhandledBackgroundFailure } = await import("../mcp/lib/orchestrator.mjs");
        finalizeUnhandledBackgroundFailure(id, payload.research.prompt, new Error(stopRequested ? "user_cancelled" : "terminal_runner_failed"));
      } catch {}
    }
    persist({ state: stopRequested ? "stopped" : "failed", error: stopRequested ? "USER_CANCELLED" : "RUNNER_FAILED", completed_at: new Date().toISOString() });
    notify({ type: "failed", run_id: id, owner_token: payload.owner_token, code: stopRequested ? "USER_CANCELLED" : "RUNNER_FAILED" });
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    payload.apiKey = undefined;
    if (stopRequested && state.state === "stopping") persist({ state: "stopped", completed_at: new Date().toISOString() });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const startupTimer = setTimeout(() => process.exit(1), 15_000);
  process.once("message", (payload) => {
    clearTimeout(startupTimer);
    if (payload?.type !== "start") { process.exitCode = 1; return; }
    void executeRun(payload, { notify(message) { if (process.connected) process.send(message); } })
      .catch(() => { process.exitCode = 1; })
      .finally(() => { if (process.connected) process.disconnect(); });
  });
}
