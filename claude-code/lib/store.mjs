// File-backed run store. Every packet is its own file so parallel workers in separate
// processes (terminal client) or one shared MCP server (Claude Code) never contend on a write.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export function homeDir() {
  return process.env.ALPHACOUNCIL_HOME || join(homedir(), ".alphacouncil");
}

export function runsDir() {
  return join(homeDir(), "runs");
}

export function runDir(runId) {
  if (!/^[A-Za-z0-9._-]{6,80}$/.test(String(runId))) throw new Error(`invalid run_id: ${runId}`);
  return join(runsDir(), runId);
}

export function newRunId(symbol) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${stamp}-${symbol.replace(/[^A-Za-z0-9]/g, "")}-${randomBytes(2).toString("hex")}`;
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function appendEvent(runId, event) {
  const path = join(runDir(runId), "events.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export function readEvents(runId, limit = 200) {
  try {
    const lines = readFileSync(join(runDir(runId), "events.jsonl"), "utf8").trim().split("\n");
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function packetPath(runId, slot) {
  return join(runDir(runId), "packets", `${slot}.json`);
}

export function listRuns() {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir())
    .map((id) => {
      const run = readJson(join(runsDir(), id, "run.json"));
      if (!run) return null;
      const status = readJson(join(runsDir(), id, "status.json"), {});
      return { run_id: id, symbol: run.symbol, mode: run.mode, created_at: run.created_at, status: status.state || "running", rating: status.rating || null };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function resolveRunId(ref) {
  if (ref && ref !== "latest") return ref;
  const latest = listRuns()[0];
  if (!latest) throw new Error("no runs found");
  return latest.run_id;
}
