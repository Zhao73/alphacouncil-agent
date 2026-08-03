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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { LIMITS, RUNS_DIR } from "./constants.mjs";
import { invalidParams } from "./errors.mjs";
import {
  captureLockOwnerIdentity,
  classifyLockOwner,
  normalizeLockOwnerIdentity,
} from "./lock-owner-identity.mjs";

const RUN_ID = /^[A-Z0-9.^=+\-_]{1,80}$/;
const MAX_ATTEMPTS = 4;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function boundedDuration(value, fallback, name) {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 30 * 24 * 60 * 60 * 1000) {
    throw invalidParams(`${name} is outside the bounded run-lock policy.`, { reason: "INVALID_RUN_LOCK_POLICY" });
  }
  return resolved;
}

function ensureRunLockStore(runsDir = RUNS_DIR) {
  if (typeof runsDir !== "string" || !isAbsolute(runsDir) || resolve(runsDir) === resolve(sep)) {
    throw invalidParams("Run lock store must be an absolute non-root path.", { reason: "UNSAFE_RUN_LOCK_PATH" });
  }
  const root = resolve(runsDir);
  const candidates = join(root, ".lock-candidates");
  for (const directory of [root, candidates]) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw invalidParams(`Run lock path is not a plain directory: ${directory}`, { reason: "UNSAFE_RUN_LOCK_PATH" });
    }
  }
  return { root, candidates };
}

export function runLockPath(id, { runsDir = RUNS_DIR } = {}) {
  if (typeof id !== "string" || !RUN_ID.test(id)) {
    throw invalidParams("run_id is invalid for locking.", { reason: "INVALID_RUN_LOCK_RESOURCE" });
  }
  const store = ensureRunLockStore(runsDir);
  const path = join(store.root, `.${id}.lock`);
  const rel = relative(store.root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw invalidParams("Run lock leaves RUNS_DIR.", { reason: "UNSAFE_RUN_LOCK_PATH" });
  }
  return path;
}

function parse(path) {
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    return error.code === "ENOENT" ? { status: "missing", path } : { status: "unreadable", path, error: error.message };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { status: "unsafe", path };
  try {
    return { status: "parsed", path, metadata: JSON.parse(readFileSync(path, "utf8")), mtime_ms: stat.mtimeMs };
  } catch (error) {
    return { status: "malformed", path, error: error.message, mtime_ms: stat.mtimeMs };
  }
}

function valid(metadata, id) {
  return metadata?.schema_version === 1
    && metadata?.lock_kind === "alphacouncil_run_exclusive"
    && metadata?.resource_kind === "run"
    && metadata?.resource_id === id
    && RUN_ID.test(metadata.resource_id)
    && typeof metadata.operation === "string" && metadata.operation.length > 0
    && typeof metadata.token === "string" && /^[0-9a-f-]{36}$/i.test(metadata.token)
    && Number.isInteger(metadata.owner_pid) && metadata.owner_pid > 0
    && typeof metadata.owner_hostname === "string" && metadata.owner_hostname.length > 0
    && (metadata.owner_identity === undefined || Boolean(normalizeLockOwnerIdentity(metadata.owner_identity)))
    && Number.isFinite(Date.parse(metadata.created_at))
    && Number.isFinite(Date.parse(metadata.lease_expires_at));
}

export function inspectRunLock(id, options = {}) {
  const path = options.path || runLockPath(id, options);
  const parsed = parse(path);
  if (parsed.status !== "parsed") return { ...parsed, owner_state: "unknown", reclaimable: false };
  if (!valid(parsed.metadata, id)) return { ...parsed, status: "invalid_metadata", owner_state: "unknown", reclaimable: false };
  const now = Number(options.now ?? Date.now());
  const created = Date.parse(parsed.metadata.created_at);
  const leaseExpires = Date.parse(parsed.metadata.lease_expires_at);
  if (!Number.isFinite(now) || created > now + CLOCK_SKEW_MS || leaseExpires < created) {
    return { ...parsed, status: "invalid_time", owner_state: "unknown", reclaimable: false };
  }
  const owner = classifyLockOwner(parsed.metadata, options);
  const ownerState = owner.owner_state;
  const ageMs = Math.max(0, now - created);
  const graceMs = boundedDuration(options.deadOwnerGraceMs, LIMITS.SELECTION_LOCK_DEAD_GRACE_MS, "deadOwnerGraceMs");
  return {
    ...parsed,
    status: ownerState === "alive" ? "active" : ownerState === "dead" ? "dead_owner" : "unverifiable",
    ...owner,
    age_ms: ageMs,
    lease_expired: leaseExpires <= now,
    reclaimable: ownerState === "dead" && ageMs >= graceMs,
  };
}

function metadata(id, options, token) {
  const now = Number(options.now ?? Date.now());
  const leaseMs = boundedDuration(options.leaseMs, LIMITS.SELECTION_LOCK_LEASE_MS, "leaseMs");
  const ownerPid = Number(options.ownerPid ?? process.pid);
  const hostname = String(options.hostname || os.hostname());
  if (!Number.isFinite(now) || !Number.isInteger(ownerPid) || ownerPid <= 0 || !hostname) {
    throw invalidParams("Run lock owner and timestamp are invalid.", { reason: "INVALID_RUN_LOCK_POLICY" });
  }
  return Object.freeze({
    schema_version: 1,
    lock_kind: "alphacouncil_run_exclusive",
    resource_kind: "run",
    resource_id: id,
    operation: String(options.operation || "start_or_replay_run"),
    token,
    owner_pid: ownerPid,
    owner_hostname: hostname,
    owner_identity: captureLockOwnerIdentity(ownerPid, options),
    created_at: new Date(now).toISOString(),
    lease_expires_at: new Date(now + leaseMs).toISOString(),
  });
}

function writeCandidate(store, value) {
  const path = join(store.candidates, `run-${value.token}.json`);
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return path;
}

function unlinkToken(path, token) {
  const current = parse(path);
  if (current.status !== "parsed" || current.metadata?.token !== token) return false;
  try { unlinkSync(path); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function clearDeadRecovery(id, recoveryPath, options) {
  const inspection = inspectRunLock(id, { ...options, path: recoveryPath });
  return inspection.reclaimable ? unlinkToken(recoveryPath, inspection.metadata.token) : false;
}

function install(id, path, candidate, value, options) {
  const recoveryPath = `${path}.reclaim`;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (existsSync(recoveryPath)) {
      if (clearDeadRecovery(id, recoveryPath, options)) continue;
      return { acquired: false, recovery: true, inspection: inspectRunLock(id, { ...options, path: recoveryPath }) };
    }
    try { linkSync(candidate, path); return { acquired: true, recovered: false }; } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stale = inspectRunLock(id, options);
    if (!stale.reclaimable) return { acquired: false, recovery: false, inspection: stale };
    try { linkSync(candidate, recoveryPath); } catch (error) {
      if (error.code === "EEXIST") return { acquired: false, recovery: true, inspection: stale };
      throw error;
    }
    try {
      const current = inspectRunLock(id, options);
      if (!current.reclaimable || current.metadata?.token !== stale.metadata?.token) return { acquired: false, recovery: true, inspection: current };
      if (!unlinkToken(path, stale.metadata.token)) continue;
      try {
        linkSync(candidate, path);
        return { acquired: true, recovered: true, recovered_lock: stale.metadata };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } finally {
      unlinkToken(recoveryPath, value.token);
    }
  }
  return { acquired: false, recovery: false, inspection: inspectRunLock(id, options) };
}

export function acquireRunLock(id, options = {}) {
  const store = ensureRunLockStore(options.runsDir);
  const path = runLockPath(id, { runsDir: store.root });
  const token = randomUUID();
  const value = metadata(id, options, token);
  const candidate = writeCandidate(store, value);
  let result;
  try { result = install(id, path, candidate, value, { ...options, runsDir: store.root }); }
  finally { try { unlinkSync(candidate); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  if (!result.acquired) {
    const owner = result.inspection || {};
    throw invalidParams(`Run ${id} is already starting, executing, or recovering.`, {
      reason: "RUN_IN_PROGRESS",
      run_id: id,
      lock_owner_pid: owner.metadata?.owner_pid || null,
      lock_owner_hostname: owner.metadata?.owner_hostname || null,
      lock_created_at: owner.metadata?.created_at || null,
      lock_lease_expires_at: owner.metadata?.lease_expires_at || null,
      lock_owner_state: owner.owner_state || "unknown",
      recovery_in_progress: result.recovery === true,
    });
  }
  let released = false;
  return Object.freeze({
    path,
    metadata: value,
    recovered: result.recovered === true,
    recovered_lock: result.recovered_lock || null,
    release() {
      if (released) return false;
      released = true;
      return unlinkToken(path, token);
    },
  });
}
