import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { internalError, invalidParams } from "./errors.mjs";

/**
 * Write JSON atomically.
 *
 * collectEvidence commits packets from up to CONCURRENCY_MAX workers, and each commit
 * rewrites evidence.json. A plain writeFileSync leaves a window where a concurrent
 * reader (or a crash) sees a half-written file; write-then-rename does not.
 */
export function writeJson(path, value, { mode } = {}) {
  const tmp = `${path}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeFileSync(tmp, body, Number.isInteger(mode) ? { mode } : undefined);
    if (Number.isInteger(mode) && process.platform !== "win32") chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    throw internalError(`failed to write ${path}: ${error.message}`);
  }
}

export function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw invalidParams(`not found: ${path}`);
    throw internalError(`failed to read ${path}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw internalError(`corrupt JSON at ${path}: ${error.message}`);
  }
}

/**
 * Read newline-delimited JSON, skipping unparseable lines.
 *
 * events.jsonl is append-only and a crashed run can leave one truncated line. That must
 * not make the whole run unreadable, so bad lines are counted and reported instead of
 * thrown.
 */
export function readJsonl(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { entries: [], parse_errors: 0 };
    throw internalError(`failed to read ${path}: ${error.message}`);
  }
  const entries = [];
  let parse_errors = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      parse_errors += 1;
    }
  }
  return { entries, parse_errors };
}
