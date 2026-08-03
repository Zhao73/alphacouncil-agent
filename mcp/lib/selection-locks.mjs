import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { LIMITS, SELECTIONS_DIR } from "./constants.mjs";
import { invalidParams } from "./errors.mjs";
import {
  captureLockOwnerIdentity,
  classifyLockOwner,
  defaultPidProbe,
  normalizeLockOwnerIdentity,
} from "./lock-owner-identity.mjs";

export { defaultPidProbe } from "./lock-owner-identity.mjs";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
export const SELECTION_LOCK_IDS = Object.freeze({
  selection: new RegExp(`^SEL-${UUID}$`, "i"),
  receipt: new RegExp(`^RCP-${UUID}$`, "i"),
});

export const SELECTION_LOCK_RULES = Object.freeze({
  schema_version: 1,
  lease_ms: LIMITS.SELECTION_LOCK_LEASE_MS,
  dead_owner_grace_ms: LIMITS.SELECTION_LOCK_DEAD_GRACE_MS,
  max_acquire_attempts: 4,
  max_clock_skew_ms: 5 * 60 * 1000,
});

function boundedDuration(value, fallback, label, maximum = 30 * 24 * 60 * 60 * 1000) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > maximum) {
    throw invalidParams(`${label} must be between 0 and ${maximum} milliseconds.`, { reason: "INVALID_SELECTION_LOCK_POLICY" });
  }
  return resolved;
}

function assertStoreRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw invalidParams("Selection lock store must be an absolute path.", { reason: "UNSAFE_SELECTION_LOCK_PATH" });
  }
  const resolved = resolve(root);
  if (resolved === resolve(sep)) {
    throw invalidParams("Selection lock store cannot be the filesystem root.", { reason: "UNSAFE_SELECTION_LOCK_PATH" });
  }
  return resolved;
}

function assertPlainDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw invalidParams(`Selection store path is not a plain directory: ${path}`, { reason: "UNSAFE_SELECTION_LOCK_PATH" });
  }
}

export function ensureSelectionLockStore(selectionsDir = SELECTIONS_DIR) {
  const root = assertStoreRoot(selectionsDir);
  const receipts = join(root, "receipts");
  const candidates = join(root, ".lock-candidates");
  assertPlainDirectory(root);
  assertPlainDirectory(receipts);
  assertPlainDirectory(candidates);
  return Object.freeze({ root, receipts, candidates });
}

export function selectionResourcePath(kind, id, { selectionsDir = SELECTIONS_DIR } = {}) {
  if (!Object.hasOwn(SELECTION_LOCK_IDS, kind) || !SELECTION_LOCK_IDS[kind].test(String(id || ""))) {
    throw invalidParams(`Invalid ${kind || "selection"} lock resource id.`, { reason: "INVALID_SELECTION_LOCK_RESOURCE" });
  }
  const store = ensureSelectionLockStore(selectionsDir);
  const parent = kind === "receipt" ? store.receipts : store.root;
  const target = join(parent, `${id}.json`);
  const rel = relative(store.root, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw invalidParams("Selection lock resource leaves the selection store.", { reason: "UNSAFE_SELECTION_LOCK_PATH" });
  }
  return target;
}

export function selectionLockPath(kind, id, options = {}) {
  return `${selectionResourcePath(kind, id, options)}.lock`;
}

function parseLock(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "missing", path };
    return { status: "unreadable", path, error: error.message };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: "unsafe", path, mtime_ms: stat.mtimeMs };
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { status: "malformed", path, mtime_ms: stat.mtimeMs, error: error.message };
  }
  return { status: "parsed", path, mtime_ms: stat.mtimeMs, metadata };
}

function validMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  if (metadata.schema_version !== 1 || metadata.lock_kind !== "alphacouncil_selection_exclusive") return false;
  if (!Object.hasOwn(SELECTION_LOCK_IDS, metadata.resource_kind)) return false;
  if (!SELECTION_LOCK_IDS[metadata.resource_kind].test(String(metadata.resource_id || ""))) return false;
  if (typeof metadata.operation !== "string" || !metadata.operation) return false;
  if (typeof metadata.token !== "string" || !/^[0-9a-f-]{36}$/i.test(metadata.token)) return false;
  if (!Number.isInteger(metadata.owner_pid) || metadata.owner_pid <= 0) return false;
  if (typeof metadata.owner_hostname !== "string" || !metadata.owner_hostname) return false;
  if (metadata.owner_identity !== undefined && !normalizeLockOwnerIdentity(metadata.owner_identity)) return false;
  if (!Number.isFinite(Date.parse(metadata.created_at)) || !Number.isFinite(Date.parse(metadata.lease_expires_at))) return false;
  return true;
}

export function inspectSelectionLock(kind, id, options = {}) {
  const path = options.path || selectionLockPath(kind, id, options);
  const parsed = parseLock(path);
  if (parsed.status !== "parsed") return { ...parsed, reclaimable: false, owner_state: "unknown" };
  const metadata = parsed.metadata;
  if (!validMetadata(metadata) || metadata.resource_kind !== kind || metadata.resource_id !== id) {
    return { ...parsed, status: "invalid_metadata", reclaimable: false, owner_state: "unknown" };
  }
  const now = Number(options.now ?? Date.now());
  const created = Date.parse(metadata.created_at);
  const leaseExpires = Date.parse(metadata.lease_expires_at);
  if (created > now + SELECTION_LOCK_RULES.max_clock_skew_ms || leaseExpires < created) {
    return { ...parsed, status: "invalid_time", reclaimable: false, owner_state: "unknown" };
  }
  const owner = classifyLockOwner(metadata, options);
  const ownerState = owner.owner_state;
  const ageMs = Math.max(0, now - created);
  const deadOwnerGraceMs = boundedDuration(
    options.deadOwnerGraceMs,
    SELECTION_LOCK_RULES.dead_owner_grace_ms,
    "deadOwnerGraceMs",
  );
  return {
    ...parsed,
    status: ownerState === "alive" ? "active" : ownerState === "dead" ? "dead_owner" : "unverifiable",
    ...owner,
    age_ms: ageMs,
    lease_expired: leaseExpires <= now,
    reclaimable: ownerState === "dead" && ageMs >= deadOwnerGraceMs,
  };
}

function lockMetadata(kind, id, operation, options, token) {
  const now = Number(options.now ?? Date.now());
  const leaseMs = boundedDuration(options.leaseMs, SELECTION_LOCK_RULES.lease_ms, "leaseMs");
  const ownerPid = Number(options.ownerPid ?? process.pid);
  const ownerHostname = String(options.hostname || os.hostname());
  if (!Number.isFinite(now) || !Number.isInteger(ownerPid) || ownerPid <= 0 || !ownerHostname || typeof operation !== "string" || !operation) {
    throw invalidParams("Selection lock owner, operation, and timestamps must be valid.", { reason: "INVALID_SELECTION_LOCK_POLICY" });
  }
  return Object.freeze({
    schema_version: 1,
    lock_kind: "alphacouncil_selection_exclusive",
    resource_kind: kind,
    resource_id: id,
    operation,
    token,
    owner_pid: ownerPid,
    owner_hostname: ownerHostname,
    owner_identity: captureLockOwnerIdentity(ownerPid, options),
    created_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + leaseMs).toISOString(),
  });
}

function writeCandidate(store, metadata) {
  const path = join(store.candidates, `${metadata.resource_kind}-${metadata.token}.json`);
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return path;
}

function unlinkIfToken(path, token) {
  const parsed = parseLock(path);
  if (parsed.status !== "parsed" || parsed.metadata?.token !== token) return false;
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function clearRecoverableMarker(kind, id, recoveryPath, options) {
  const inspection = inspectSelectionLock(kind, id, { ...options, path: recoveryPath });
  if (!inspection.reclaimable) return false;
  return unlinkIfToken(recoveryPath, inspection.metadata.token);
}

function installCandidate(kind, id, lockPath, candidatePath, metadata, options) {
  const recoveryPath = `${lockPath}.reclaim`;
  for (let attempt = 0; attempt < SELECTION_LOCK_RULES.max_acquire_attempts; attempt += 1) {
    if (existsSync(recoveryPath)) {
      if (clearRecoverableMarker(kind, id, recoveryPath, options)) continue;
      return { acquired: false, inspection: inspectSelectionLock(kind, id, { ...options, path: recoveryPath }), recovery_in_progress: true };
    }
    try {
      linkSync(candidatePath, lockPath);
      return { acquired: true, recovered: false };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const inspection = inspectSelectionLock(kind, id, options);
    if (!inspection.reclaimable) return { acquired: false, inspection, recovery_in_progress: false };

    // One reclaimer at a time. Every normal acquirer checks this marker before linking, so
    // nobody can install a new active lock between removal of the dead inode and our link.
    try {
      linkSync(candidatePath, recoveryPath);
    } catch (error) {
      if (error.code === "EEXIST") return { acquired: false, inspection, recovery_in_progress: true };
      throw error;
    }
    try {
      const current = inspectSelectionLock(kind, id, options);
      if (!current.reclaimable || current.metadata?.token !== inspection.metadata?.token) {
        return { acquired: false, inspection: current, recovery_in_progress: true };
      }
      if (!unlinkIfToken(lockPath, inspection.metadata.token)) continue;
      try {
        linkSync(candidatePath, lockPath);
        return { acquired: true, recovered: true, recovered_lock: inspection.metadata };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } finally {
      unlinkIfToken(recoveryPath, metadata.token);
    }
  }
  return { acquired: false, inspection: inspectSelectionLock(kind, id, options), recovery_in_progress: false };
}

export function acquireSelectionLock({ kind, id, operation, contentionReason }, options = {}) {
  const store = ensureSelectionLockStore(options.selectionsDir);
  const path = selectionLockPath(kind, id, { selectionsDir: store.root });
  const token = randomUUID();
  const metadata = lockMetadata(kind, id, operation, options, token);
  const candidatePath = writeCandidate(store, metadata);
  let installed;
  try {
    installed = installCandidate(kind, id, path, candidatePath, metadata, { ...options, selectionsDir: store.root });
  } finally {
    try { unlinkSync(candidatePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!installed.acquired) {
    const inspection = installed.inspection || {};
    throw invalidParams("This selection is already being confirmed, consumed, or recovered. Retry the same request.", {
      reason: contentionReason || "MASTER_SELECTION_LOCKED",
      lock_owner_pid: inspection.metadata?.owner_pid || null,
      lock_owner_hostname: inspection.metadata?.owner_hostname || null,
      lock_created_at: inspection.metadata?.created_at || null,
      lock_lease_expires_at: inspection.metadata?.lease_expires_at || null,
      lock_owner_state: inspection.owner_state || "unknown",
      recovery_in_progress: installed.recovery_in_progress === true,
    });
  }
  let released = false;
  return Object.freeze({
    path,
    metadata,
    recovered: installed.recovered === true,
    recovered_lock: installed.recovered_lock || null,
    release() {
      if (released) return false;
      released = true;
      return unlinkIfToken(path, token);
    },
  });
}

export function withSelectionLock(spec, fn, options = {}) {
  const lock = acquireSelectionLock(spec, options);
  try {
    return fn(lock);
  } finally {
    lock.release();
  }
}

export function reclaimDeadSelectionLock(kind, id, options = {}) {
  const inspection = inspectSelectionLock(kind, id, options);
  if (!inspection.reclaimable) return { reclaimed: false, inspection };
  const lock = acquireSelectionLock({ kind, id, operation: "cleanup_recovery", contentionReason: "MASTER_SELECTION_CLEANUP_LOCKED" }, options);
  const result = { reclaimed: lock.recovered, recovered_lock: lock.recovered_lock, metadata: lock.metadata };
  lock.release();
  return result;
}

/** Remove only dead-owner recovery markers and dead-owner pre-link candidates. */
export function sweepSelectionLockArtifacts(options = {}) {
  const store = ensureSelectionLockStore(options.selectionsDir);
  const maximum = Number(options.maxFiles ?? LIMITS.SELECTION_CLEANUP_MAX_FILES);
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > LIMITS.SELECTION_CLEANUP_MAX_FILES) {
    throw invalidParams(`maxFiles must be between 1 and ${LIMITS.SELECTION_CLEANUP_MAX_FILES}.`, {
      reason: "INVALID_SELECTION_LOCK_POLICY",
    });
  }
  const result = { candidates_removed: 0, recovery_markers_removed: 0, active_skipped: 0, invalid_skipped: 0, scan_truncated: false };
  let seen = 0;
  const inspectAndRemove = (path, expectedKind = null, expectedId = null, counter) => {
    if (seen >= maximum) { result.scan_truncated = true; return; }
    seen += 1;
    const parsed = parseLock(path);
    if (parsed.status !== "parsed" || !validMetadata(parsed.metadata)) { result.invalid_skipped += 1; return; }
    const kind = expectedKind || parsed.metadata.resource_kind;
    const id = expectedId || parsed.metadata.resource_id;
    const inspection = inspectSelectionLock(kind, id, { ...options, path });
    if (inspection.reclaimable && unlinkIfToken(path, parsed.metadata.token)) result[counter] += 1;
    else if (["active", "unverifiable", "dead_owner"].includes(inspection.status)) result.active_skipped += 1;
    else result.invalid_skipped += 1;
  };

  for (const entry of readdirSync(store.candidates, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (result.scan_truncated) break;
    if (!entry.isFile() || entry.isSymbolicLink() || !/^(?:selection|receipt)-[0-9a-f-]{36}\.json$/i.test(entry.name)) continue;
    inspectAndRemove(join(store.candidates, entry.name), null, null, "candidates_removed");
  }
  for (const [kind, directory] of [["selection", store.root], ["receipt", store.receipts]]) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (result.scan_truncated) break;
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json.lock.reclaim")) continue;
      const id = entry.name.slice(0, -18);
      if (!SELECTION_LOCK_IDS[kind].test(id)) continue;
      inspectAndRemove(join(directory, entry.name), kind, id, "recovery_markers_removed");
    }
  }
  return Object.freeze(result);
}
