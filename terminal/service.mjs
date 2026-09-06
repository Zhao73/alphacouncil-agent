import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { ALL_ANALYST_TASKS, DATA_DIR, RUNS_DIR } from "../mcp/lib/constants.mjs";
import { readJson, readJsonl, writeJson } from "../mcp/lib/fsutil.mjs";
import { renderDebateMarkdown, renderDebateRounds, renderMasterMarkdown, renderPacketMarkdown } from "../mcp/lib/markdown.mjs";
import { runId, runPath, safeSymbol } from "../mcp/lib/run-store.mjs";

const RUNNER_DIR = join(DATA_DIR, "terminal", "runners");
const TERMINAL = new Set(["complete", "completed", "degraded", "incomplete", "failed", "needs_revision", "needs_verification"]);
const PRIVATE_FIELDS = new Set(["raw_text", "raw_response", "stdout", "stderr", "prompt", "prompts", "thinking", "reasoning", "reasoning_content", "chain_of_thought", "api_key", "apiKey", "access_token", "refresh_token", "secret"]);
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

function safeText(value) {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "");
}

function publicValue(value) {
  if (typeof value === "string") return safeText(value);
  if (Array.isArray(value)) return value.map(publicValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_FIELDS.has(key)).map(([key, item]) => [key, publicValue(item)]));
}

function localRunDir(id) {
  if (id === "." || id === "..") throw new Error("RUN_PATH_UNSAFE");
  const dir = runPath(id);
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()
    || realpathSync(dir) !== join(realpathSync(RUNS_DIR), id))) throw new Error("RUN_PATH_UNSAFE");
  return dir;
}

function fileInRun(id, name) {
  const path = join(localRunDir(id), name);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ARTIFACT_PATH_UNSAFE");
  if (stat.size > MAX_ARTIFACT_BYTES) throw new Error("ARTIFACT_TOO_LARGE");
  return path;
}

function runJson(id, name) {
  const path = fileInRun(id, name);
  return path ? readJson(path) : null;
}

export function runnerPath(id, suffix = ".json") {
  if (id === "." || id === "..") throw new Error("RUNNER_PATH_INVALID");
  runPath(id);
  if (![".json", ".stop.json"].includes(suffix)) throw new Error("RUNNER_PATH_INVALID");
  return join(RUNNER_DIR, `${id}${suffix}`);
}

export function readRunnerState(id) {
  const path = runnerPath(id);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) throw new Error("RUNNER_PATH_UNSAFE");
  return readJson(path);
}

export function writeRunnerState(id, state) {
  mkdirSync(RUNNER_DIR, { recursive: true, mode: 0o700 });
  if (lstatSync(RUNNER_DIR).isSymbolicLink()) throw new Error("RUNNER_PATH_UNSAFE");
  writeJson(runnerPath(id), { ...state, run_id: id, updated_at: new Date().toISOString() }, { mode: 0o600 });
}

function runnerSummary(id) {
  const state = readRunnerState(id);
  if (!state) return null;
  let alive = false;
  if (Number.isInteger(state.pid) && state.pid > 0 && ["starting", "running", "stopping"].includes(state.state)) {
    try { process.kill(state.pid, 0); alive = Date.now() - Date.parse(state.updated_at) < 15_000; } catch {}
  }
  const { owner_token, ...visible } = state;
  return { ...visible, alive };
}

async function callCore(name, args) {
  const { dispatchRequest } = await import("../mcp/lib/rpc.mjs");
  const response = await dispatchRequest({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name, arguments: args } });
  if (response?.error) {
    const error = new Error(response.error.message);
    error.code = response.error.data?.reason || response.error.code;
    error.data = response.error.data;
    throw error;
  }
  if (!response?.result?.structuredContent) throw new Error("CORE_RESPONSE_INVALID");
  return response.result.structuredContent;
}

export async function beginSelection(research) {
  return callCore("begin_council_selection", { ...research, host: "alphacouncil-terminal" });
}

export async function confirmSelection(selection, submitted) {
  if (submitted?.display_ack !== true) throw new Error("SELECTION_DISPLAY_ACK_REQUIRED");
  return callCore("confirm_master_selection", {
    ...submitted,
    selection_id: selection.selection_id,
    catalog_hash: selection.catalog_hash,
    ...(selection.recommendation_hash ? { recommendation_hash: selection.recommendation_hash } : {}),
    ...(selection.decision_context_hash ? { decision_context_hash: selection.decision_context_hash } : {}),
  });
}

export async function launch({ research, confirmation, connection }) {
  if (!confirmation?.selection_receipt) throw new Error("MASTER_SELECTION_REQUIRED");
  const symbol = safeSymbol(research.symbol);
  if (!connection && research.dry_run !== true) throw new Error("MODEL_CONNECTION_REQUIRED");
  const id = `${runId(symbol)}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const ownerToken = randomUUID();
  let profile = null;
  let apiKey;
  if (connection) {
    const { getConnectionSecret, normalizeConnection } = await import("./connections.mjs");
    profile = { ...normalizeConnection(connection), capabilities: { ...connection.capabilities } };
    if (profile.provider !== "codex") apiKey = await getConnectionSecret(connection);
  }
  const child = fork(fileURLToPath(new URL("./runner.mjs", import.meta.url)), [], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    execArgv: [], windowsHide: true,
  });
  const initial = {
    schema_version: 1, owner_token: ownerToken, pid: child.pid, state: "starting",
    symbol, language: research.language, created_at: new Date().toISOString(),
    connection: profile ? { id: profile.id, name: profile.name, provider: profile.provider, model: profile.model } : null,
  };
  writeRunnerState(id, initial);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners("message");
      if (child.connected) child.disconnect();
      child.unref();
      apiKey = undefined;
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("RUNNER_START_TIMEOUT")), 15_000);
    child.once("error", () => { writeRunnerState(id, { ...initial, state: "failed", error: "RUNNER_START_FAILED" }); finish(new Error("RUNNER_START_FAILED")); });
    child.once("exit", () => { if (!settled) finish(new Error("RUNNER_EXITED_BEFORE_START")); });
    child.on("message", (message) => {
      if (message?.run_id !== id || message?.owner_token !== ownerToken) return;
      if (message.type === "ready") finish(null, { run_id: id, pid: child.pid, status: "running" });
      if (message.type === "failed") finish(new Error(message.code || "RUNNER_START_FAILED"));
    });
    child.send({ type: "start", run_id: id, owner_token: ownerToken,
      research: { ...research, symbol, run_id: id, selection_receipt: confirmation.selection_receipt,
        council_mode: confirmation.council_mode, council_pace: confirmation.council_pace || undefined,
        analyst_scope: confirmation.analyst_scope, wait_for_completion: true },
      connection: profile, apiKey,
    }, (error) => { if (error) finish(new Error("RUNNER_IPC_FAILED")); });
  });
}

export function stop(id) {
  const state = readRunnerState(id);
  if (!state) throw new Error("RUNNER_NOT_FOUND");
  const status = runJson(id, "status.json");
  if (TERMINAL.has(status?.status) || !["starting", "running", "stopping"].includes(state.state)) {
    return { run_id: id, status: status?.status || state.state };
  }
  if (!runnerSummary(id)?.alive) throw new Error("RUNNER_NOT_RUNNING");
  writeJson(runnerPath(id, ".stop.json"), { run_id: id, owner_token: state.owner_token,
    requested_at: new Date().toISOString(), reason: "user_cancelled" }, { mode: 0o600 });
  return { run_id: id, status: "stopping" };
}

export function listRuns({ query = "", limit = 100 } = {}) {
  const ids = new Set(existsSync(RUNS_DIR) ? readdirSync(RUNS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name) : []);
  if (existsSync(RUNNER_DIR)) for (const name of readdirSync(RUNNER_DIR)) {
    if (name.endsWith(".json") && !name.endsWith(".stop.json")) ids.add(name.slice(0, -5));
  }
  return [...ids].flatMap((id) => {
    try {
      const status = runJson(id, "status.json");
      const runner = runnerSummary(id);
      if (!status && !runner) return [];
      const row = { run_id: id, symbol: status?.symbol || runner?.symbol,
        language: status?.language || runner?.language, status: status?.status || runner?.state,
        phase: status?.phase || "starting", started_at: status?.started_at || runner?.created_at,
        updated_at: status?.updated_at || runner?.updated_at, council_mode: status?.council_mode,
        runner_alive: runner?.alive === true };
      return JSON.stringify(row).toLowerCase().includes(String(query).toLowerCase()) ? [row] : [];
    } catch { return []; }
  }).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))).slice(0, Math.max(1, Math.min(1000, limit)));
}

export function listArtifacts(id) {
  const status = runJson(id, "status.json") || {};
  const entries = [];
  for (const [key, file] of [["report", "final_report.md"], ["handoff", "user_response.md"], ["sources", "source_manifest.json"]]) {
    entries.push({ id: key, kind: key === "sources" ? "sources" : "report", status: status.status || "pending", available: Boolean(fileInRun(id, file)) });
  }
  const tasks = Array.isArray(status.tasks) ? status.tasks : [];
  for (const task of tasks) {
    const role = typeof task === "string" ? task : task.task;
    if (!ALL_ANALYST_TASKS.includes(role)) continue;
    entries.push({ id: `evidence:${role}`, kind: "evidence", role, status: task.status || "pending", available: Boolean(fileInRun(id, `${role}.json`)) });
  }
  const masters = Array.isArray(status.masters) ? status.masters : [];
  for (const master of masters) {
    const role = typeof master === "string" ? master : master.master;
    if (!/^master_[a-z_]+$/u.test(role || "")) continue;
    entries.push({ id: `method:${role}`, kind: "method", role, status: master.status || "pending", available: Boolean(fileInRun(id, `${role}.json`)) });
  }
  for (const role of ["bull_researcher", "bear_researcher"]) {
    const combined = runJson(id, `${role}.json`);
    for (let round = 1; round <= (status.council_mode === "quick" ? 1 : 3); round += 1) {
      const available = Boolean(fileInRun(id, `${role}.round-${round}.json`)
        || combined?.debate_rounds?.some((item) => item.round === round)
        || (status.council_mode === "quick" && combined));
      entries.push({ id: `debate:${role}:${round}`, kind: "debate", role, round, status: available ? "completed" : "pending", available });
    }
  }
  entries.push({ id: "decision", kind: "decision", role: "portfolio_manager", status: status.status || "pending", available: Boolean(fileInRun(id, "decision.json")) });
  return entries;
}

export function readArtifact(id, artifactId) {
  const item = listArtifacts(id).find((candidate) => candidate.id === artifactId);
  if (!item) throw new Error("ARTIFACT_NOT_ALLOWED");
  if (!item.available) throw new Error("ARTIFACT_NOT_READY");
  const language = runJson(id, "status.json")?.language;
  let content;
  let format = "markdown";
  if (artifactId === "report" || artifactId === "handoff") {
    content = readFileSync(fileInRun(id, artifactId === "report" ? "final_report.md" : "user_response.md"), "utf8");
  } else if (artifactId === "sources") {
    content = JSON.stringify(publicValue(runJson(id, "source_manifest.json")), null, 2);
    format = "json";
  } else if (item.kind === "evidence") {
    const packet = publicValue(runJson(id, `${item.role}.json`));
    content = renderPacketMarkdown({ ...packet, claims: packet.claims || [], sources: packet.sources || [], raw_text: "" }, 0, language);
  } else if (item.kind === "method") {
    content = renderMasterMarkdown(publicValue(runJson(id, `${item.role}.json`)), language);
  } else {
    let packet = item.kind === "decision" ? runJson(id, "decision.json") : runJson(id, `${item.role}.round-${item.round}.json`);
    if (!packet && item.kind === "debate") {
      const combined = runJson(id, `${item.role}.json`);
      packet = combined?.debate_rounds?.find((round) => round.round === item.round)
        || (runJson(id, "status.json")?.council_mode === "quick" ? combined : null);
    }
    content = item.kind === "debate"
      ? renderDebateRounds([{ ...publicValue(packet), round: item.round }], language)
      : renderDebateMarkdown({ ...publicValue(packet), role: item.role, raw_text: "" }, language);
  }
  return { ...item, content: safeText(content), format };
}

export function loadRun(id) {
  const status = runJson(id, "status.json");
  const runner = runnerSummary(id);
  if (!status && !runner) throw new Error("RUN_NOT_FOUND");
  const eventPath = fileInRun(id, "events.jsonl");
  const fields = ["seq", "at", "type", "stage", "task", "role", "master", "round", "status", "ok", "elapsed_ms", "failure_kind", "reason"];
  const events = eventPath ? readJsonl(eventPath).entries.slice(-30).map((event) => Object.fromEntries(fields.filter((key) => event[key] !== undefined).map((key) => [key, publicValue(event[key])]))) : [];
  return { run_id: id, status: publicValue(status || { run_id: id, symbol: runner.symbol, status: runner.state, phase: "starting" }), runner: publicValue(runner), items: listArtifacts(id), events };
}
