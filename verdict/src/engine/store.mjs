// Runs live in ~/.verdict/runs/<run_id>/ (override with VERDICT_HOME). One file per artifact,
// written atomically, so a terminal run and a Claude Code / Codex run share the same layout.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function homeDir() {
  return process.env.VERDICT_HOME || join(homedir(), ".verdict");
}

export function runsDir() {
  return join(homeDir(), "runs");
}

export function runDir(runId) {
  if (!/^[A-Za-z0-9._-]{6,80}$/.test(String(runId))) throw new Error(`invalid run id: ${runId}`);
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

export function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

export function readJsonl(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function listRuns() {
  if (!existsSync(runsDir())) return [];
  return readdirSync(runsDir())
    .map((id) => {
      const run = readJson(join(runsDir(), id, "run.json"));
      if (!run) return null;
      return { run_id: id, symbol: run.symbol, name: run.name || null, mode: run.mode, language: run.language, created_at: run.created_at, state: run.state || "running", rating: run.rating || null };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export function resolveRun(ref) {
  if (ref && ref !== "latest") {
    const runs = listRuns();
    const exact = runs.find((r) => r.run_id === ref);
    if (exact) return exact.run_id;
    const bySymbol = runs.find((r) => r.symbol === String(ref).toUpperCase());
    if (bySymbol) return bySymbol.run_id;
    throw new Error(`no run matches ${ref}`);
  }
  const latest = listRuns()[0];
  if (!latest) throw new Error("no saved research yet");
  return latest.run_id;
}
