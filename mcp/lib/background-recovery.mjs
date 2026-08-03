import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { RUNS_DIR } from "./constants.mjs";
import { readJson, readJsonl } from "./fsutil.mjs";
import { acquireRunLock } from "./run-locks.mjs";
import { appendEvent, artifactPaths, readPublicationManifest, runPath, saveRun } from "./run-store.mjs";

const TERMINAL_ANALYSIS_STATUSES = new Set([
  "complete",
  "degraded",
  "incomplete",
  "needs_verification",
  "needs_revision",
  "failed",
]);
const INTERRUPTIBLE_STATES = new Set(["running", "waiting"]);
const DEFAULT_SCAN_LIMIT = 2_000;
const INTERRUPTION_MESSAGE = "AlphaCouncil MCP process ended before the background analysis reached a terminal state.";

function interruptedCandidate(run) {
  return run?.entry_tool === "analyze_symbol"
    && ["background_codex_exec", "dry_run"].includes(run?.execution_mode)
    && !TERMINAL_ANALYSIS_STATUSES.has(run?.status);
}

function failActiveStates(states, completedAt) {
  return Object.fromEntries(Object.entries(states || {}).map(([id, state]) => [id,
    INTERRUPTIBLE_STATES.has(state?.status)
      ? {
        ...state,
        status: "failed",
        error: "server_interrupted",
        completed_at: completedAt,
        updated_at: completedAt,
        pid: null,
      }
      : state,
  ]));
}

/**
 * Mark background analyses abandoned by a dead MCP process as terminal.
 *
 * An active run in another host process retains its run lock and is skipped. A same-host
 * dead owner can be reclaimed immediately because there is no remaining writer. Visible
 * host-thread runs and evidence-only calls are never touched: they are intentionally able
 * to span MCP process lifetimes.
 */
export function recoverInterruptedBackgroundRuns({ scanLimit = DEFAULT_SCAN_LIMIT } = {}) {
  const result = { scanned: 0, recovered: 0, active_skipped: 0, invalid_skipped: 0, truncated: false };
  if (!existsSync(RUNS_DIR)) return result;
  const boundedLimit = Number.isInteger(scanLimit) && scanLimit > 0
    ? Math.min(scanLimit, DEFAULT_SCAN_LIMIT)
    : DEFAULT_SCAN_LIMIT;
  const entries = readdirSync(RUNS_DIR, { withFileTypes: true });
  result.truncated = entries.length > boundedLimit;

  for (const entry of entries.slice(0, boundedLimit)) {
    result.scanned += 1;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      result.invalid_skipped += 1;
      continue;
    }
    let dir;
    try {
      dir = runPath(entry.name);
      if (lstatSync(dir).isSymbolicLink()) throw new Error("symlinked run directory");
    } catch {
      result.invalid_skipped += 1;
      continue;
    }
    const evidencePath = join(dir, "evidence.json");
    if (!existsSync(evidencePath)) continue;
    let run;
    try {
      const evidenceStat = lstatSync(evidencePath);
      if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink()) throw new Error("unsafe evidence file");
      run = readJson(evidencePath);
    } catch {
      result.invalid_skipped += 1;
      continue;
    }
    const publicationPath = artifactPaths(run).publication_manifest_json;
    if (existsSync(publicationPath)) {
      try {
        readPublicationManifest(run);
      } catch {
        result.invalid_skipped += 1;
      }
      // A valid marker is already terminal; an inconsistent marker is fail-closed above.
      // Recovery must never turn either case into a new failed state beside that marker.
      continue;
    }
    if (!interruptedCandidate(run)) continue;

    let lock;
    try {
      lock = acquireRunLock(entry.name, {
        operation: "recover_interrupted_background_run",
        deadOwnerGraceMs: 0,
      });
    } catch (error) {
      if (error?.data?.reason === "RUN_IN_PROGRESS") result.active_skipped += 1;
      else result.invalid_skipped += 1;
      continue;
    }
    try {
      // Re-read after taking the lock; a writer may have reached a terminal state between
      // the directory scan and lock acquisition.
      run = readJson(evidencePath);
      if (existsSync(artifactPaths(run).publication_manifest_json)) {
        readPublicationManifest(run);
        continue;
      }
      if (!interruptedCandidate(run)) continue;
      // Validate the audit log before mutating evidence. A recoverable trailing half-line
      // is repaired by appendEvent; middle corruption or a broken hash chain fails closed.
      readJsonl(join(dir, "events.jsonl"));
      const completedAt = new Date().toISOString();
      const previousStatus = run.status;
      const previousPhase = run.phase;
      run.status = "failed";
      run.phase = "server_interrupted";
      run.completed_at = completedAt;
      run.background_error = INTERRUPTION_MESSAGE;
      run.task_status = failActiveStates(run.task_status, completedAt);
      run.agent_status = failActiveStates(run.agent_status, completedAt);
      run.master_status = failActiveStates(run.master_status, completedAt);
      saveRun(run);
      appendEvent(run, "background_run_interrupted", {
        previous_status: previousStatus,
        previous_phase: previousPhase,
        error: "server_interrupted",
      });
      result.recovered += 1;
    } catch {
      result.invalid_skipped += 1;
    } finally {
      lock.release();
    }
  }
  return result;
}

export const BACKGROUND_INTERRUPTION_MESSAGE = INTERRUPTION_MESSAGE;
