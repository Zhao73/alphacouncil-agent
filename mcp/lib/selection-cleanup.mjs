import { lstatSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { LIMITS, SELECTIONS_DIR } from "./constants.mjs";
import {
  SELECTION_LOCK_IDS,
  ensureSelectionLockStore,
  reclaimDeadSelectionLock,
  sweepSelectionLockArtifacts,
  withSelectionLock,
} from "./selection-locks.mjs";
import { invalidParams } from "./errors.mjs";

function bounded(value, fallback, name, minimum, maximum) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw invalidParams(`${name} must be an integer between ${minimum} and ${maximum}.`, {
      reason: "INVALID_SELECTION_CLEANUP_POLICY",
    });
  }
  return resolved;
}

function recordCandidate(entry, kind) {
  if (!entry.isFile() || entry.isSymbolicLink()) return null;
  const prefix = kind === "selection" ? "SEL-" : "RCP-";
  if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".json")) return null;
  const id = entry.name.slice(0, -5);
  return SELECTION_LOCK_IDS[kind].test(id) ? id : null;
}

function lockCandidate(entry, kind) {
  if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json.lock")) return null;
  const id = entry.name.slice(0, -10);
  return SELECTION_LOCK_IDS[kind].test(id) ? id : null;
}

function safeJson(path) {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return { safe: false, record: null };
    return { safe: true, record: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { safe: true, record: null };
  }
}

function oldEnough(record, id, kind, now, retentionMs) {
  const key = kind === "selection" ? "selection_id" : "selection_receipt";
  if (!record || record[key] !== id) return false;
  const expiresAt = Date.parse(record.expires_at);
  return Number.isFinite(expiresAt) && expiresAt + retentionMs <= now;
}

function cleanupRecords({ kind, directory, now, retentionMs, maxFiles, selectionsDir, lockOptions }, result) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  let considered = 0;
  for (const entry of entries) {
    const id = recordCandidate(entry, kind);
    if (!id) {
      if (entry.isSymbolicLink() && /^(?:SEL|RCP)-/i.test(entry.name)) result.unsafe_entries_skipped += 1;
      continue;
    }
    if (considered >= maxFiles) { result.scan_truncated = true; break; }
    considered += 1;
    const path = join(directory, entry.name);
    const first = safeJson(path);
    if (!first.safe) { result.unsafe_entries_skipped += 1; continue; }
    if (!first.record) { result.invalid_records_skipped += 1; continue; }
    if (!oldEnough(first.record, id, kind, now, retentionMs)) continue;
    try {
      withSelectionLock({
        kind,
        id,
        operation: "expired_record_cleanup",
        contentionReason: "MASTER_SELECTION_CLEANUP_LOCKED",
      }, () => {
        // Re-read after lock acquisition. A concurrent confirm/consume may have replaced
        // the record between the scan and the lock, and cleanup may never trust the scan.
        const current = safeJson(path);
        if (!current.safe || !oldEnough(current.record, id, kind, now, retentionMs)) return;
        unlinkSync(path);
        if (kind === "selection") result.selections_removed += 1;
        else result.receipts_removed += 1;
      }, { ...lockOptions, selectionsDir, now });
    } catch (error) {
      if (error?.data?.reason === "MASTER_SELECTION_CLEANUP_LOCKED") result.active_locks_skipped += 1;
      else throw error;
    }
  }
  result.files_considered += considered;
}

function cleanupOrphanLocks({ kind, directory, maxFiles, selectionsDir, lockOptions, now }, result) {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  let considered = 0;
  for (const entry of entries) {
    const id = lockCandidate(entry, kind);
    if (!id) continue;
    if (considered >= maxFiles) { result.scan_truncated = true; break; }
    considered += 1;
    const recovered = reclaimDeadSelectionLock(kind, id, { ...lockOptions, selectionsDir, now });
    if (recovered.reclaimed) result.dead_locks_reclaimed += 1;
    else if (["active", "unverifiable"].includes(recovered.inspection?.status)) result.active_locks_skipped += 1;
  }
  result.lock_files_considered += considered;
}

/**
 * Remove only expired AlphaCouncil selection/receipt records and recoverable lock files.
 * Unknown names, subdirectories, symlinks, corrupt records and foreign-host locks survive.
 */
export function cleanupSelectionStore({
  selectionsDir = SELECTIONS_DIR,
  now = Date.now(),
  retentionMs,
  maxFiles,
  lockOptions = {},
} = {}) {
  const store = ensureSelectionLockStore(selectionsDir);
  const resolvedNow = Number(now);
  if (!Number.isFinite(resolvedNow)) {
    throw invalidParams("Selection cleanup now must be a finite timestamp.", { reason: "INVALID_SELECTION_CLEANUP_POLICY" });
  }
  const resolvedRetention = bounded(
    retentionMs,
    LIMITS.SELECTION_EXPIRED_RETENTION_MS,
    "retentionMs",
    0,
    30 * 24 * 60 * 60 * 1000,
  );
  const resolvedMax = bounded(maxFiles, LIMITS.SELECTION_CLEANUP_MAX_FILES, "maxFiles", 1, LIMITS.SELECTION_CLEANUP_MAX_FILES);
  const result = {
    selections_removed: 0,
    receipts_removed: 0,
    dead_locks_reclaimed: 0,
    lock_candidates_removed: 0,
    recovery_markers_removed: 0,
    active_locks_skipped: 0,
    invalid_records_skipped: 0,
    unsafe_entries_skipped: 0,
    files_considered: 0,
    lock_files_considered: 0,
    scan_truncated: false,
  };
  const args = {
    now: resolvedNow,
    retentionMs: resolvedRetention,
    maxFiles: resolvedMax,
    selectionsDir: store.root,
    lockOptions,
  };
  cleanupRecords({ ...args, kind: "selection", directory: store.root }, result);
  cleanupRecords({ ...args, kind: "receipt", directory: store.receipts }, result);
  cleanupOrphanLocks({ ...args, kind: "selection", directory: store.root }, result);
  cleanupOrphanLocks({ ...args, kind: "receipt", directory: store.receipts }, result);
  const artifacts = sweepSelectionLockArtifacts({ ...lockOptions, selectionsDir: store.root, now: resolvedNow, maxFiles: resolvedMax });
  result.lock_candidates_removed = artifacts.candidates_removed;
  result.recovery_markers_removed = artifacts.recovery_markers_removed;
  result.active_locks_skipped += artifacts.active_skipped;
  result.invalid_records_skipped += artifacts.invalid_skipped;
  result.scan_truncated ||= artifacts.scan_truncated;
  return Object.freeze(result);
}
