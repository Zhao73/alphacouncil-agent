import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { acquireRunLock, inspectRunLock, runLockPath } from "../../mcp/lib/run-locks.mjs";

const RUN_ID = "TEST-RUN-001";

function store() {
  return mkdtempSync(join(tmpdir(), "alphacouncil-run-locks-"));
}

test("run locks contain owner/time metadata and release only their own token", () => {
  const dir = store();
  try {
    const lock = acquireRunLock(RUN_ID, { runsDir: dir, now: 1_000, leaseMs: 2_000, ownerPid: 4242, hostname: "run-host" });
    const metadata = JSON.parse(readFileSync(lock.path, "utf8"));
    assert.deepEqual(metadata, lock.metadata);
    assert.equal(metadata.lock_kind, "alphacouncil_run_exclusive");
    assert.equal(metadata.resource_kind, "run");
    assert.equal(metadata.resource_id, RUN_ID);
    assert.equal(metadata.owner_pid, 4242);
    assert.equal(metadata.created_at, "1970-01-01T00:00:01.000Z");
    assert.equal(metadata.lease_expires_at, "1970-01-01T00:00:03.000Z");
    assert.equal(lock.release(), true);
    assert.equal(lock.release(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an active run owner is never stolen after lease expiry", () => {
  const dir = store();
  try {
    const first = acquireRunLock(RUN_ID, { runsDir: dir, now: 1_000, leaseMs: 1, ownerPid: 4242, hostname: "run-host" });
    assert.throws(() => acquireRunLock(RUN_ID, {
      runsDir: dir,
      now: 999_999,
      deadOwnerGraceMs: 0,
      hostname: "run-host",
      probePid: () => true,
    }), (error) => {
      assert.equal(error?.data?.reason, "RUN_IN_PROGRESS");
      assert.equal(error?.data?.run_id, RUN_ID);
      assert.equal(error?.data?.lock_owner_pid, 4242);
      assert.equal(error?.data?.lock_owner_state, "alive");
      return true;
    });
    assert.equal(JSON.parse(readFileSync(first.path, "utf8")).token, first.metadata.token);
    first.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead same-host run owner recovers after grace and cannot unlink its successor", () => {
  const dir = store();
  try {
    const dead = acquireRunLock(RUN_ID, { runsDir: dir, now: 1_000, ownerPid: 999_999, hostname: "run-host" });
    assert.throws(() => acquireRunLock(RUN_ID, {
      runsDir: dir,
      now: 5_999,
      deadOwnerGraceMs: 5_000,
      hostname: "run-host",
      probePid: () => false,
    }), (error) => error?.data?.reason === "RUN_IN_PROGRESS");
    const recovered = acquireRunLock(RUN_ID, {
      runsDir: dir,
      now: 6_000,
      deadOwnerGraceMs: 5_000,
      hostname: "run-host",
      probePid: (pid) => pid === 999_999 ? false : true,
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recovered_lock.token, dead.metadata.token);
    assert.equal(dead.release(), false);
    assert.equal(JSON.parse(readFileSync(recovered.path, "utf8")).token, recovered.metadata.token);
    recovered.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("foreign, malformed, traversing and symlinked run locks fail closed", () => {
  const dir = store();
  const outside = store();
  try {
    const foreign = acquireRunLock(RUN_ID, { runsDir: dir, now: 1_000, ownerPid: 999_999, hostname: "foreign-host" });
    assert.throws(() => acquireRunLock(RUN_ID, {
      runsDir: dir,
      now: 99_999,
      deadOwnerGraceMs: 0,
      hostname: "local-host",
      probePid: () => false,
    }), (error) => error?.data?.lock_owner_state === "foreign_unverifiable");
    foreign.release();
    const path = runLockPath(RUN_ID, { runsDir: dir });
    writeFileSync(path, "old empty lock\n");
    assert.throws(() => acquireRunLock(RUN_ID, { runsDir: dir, now: 99_999, deadOwnerGraceMs: 0, probePid: () => false }), (error) => error?.data?.lock_owner_state === "unknown");
    assert.throws(() => runLockPath("../../escape", { runsDir: dir }), /run_id is invalid/);
    assert.throws(() => runLockPath(RUN_ID, { runsDir: "/" }), /absolute non-root/);
    const linked = join(dir, "linked");
    symlinkSync(outside, linked);
    assert.throws(() => runLockPath(RUN_ID, { runsDir: linked }), /not a plain directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a child process run lock blocks a peer and is recovered only after process death", async () => {
  const dir = store();
  const moduleUrl = pathToFileURL(join(process.cwd(), "mcp/lib/run-locks.mjs")).href;
  const code = `
    import { acquireRunLock } from ${JSON.stringify(moduleUrl)};
    acquireRunLock(${JSON.stringify(RUN_ID)}, { runsDir: process.env.TEST_RUNS_DIR });
    process.stdout.write("READY\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_RUNS_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child run lock timeout: ${stderr}`)), 5_000);
      child.stdout.on("data", (chunk) => {
        if (!String(chunk).includes("READY")) return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (codeValue) => {
        clearTimeout(timer);
        reject(new Error(`child exited before ready (${codeValue}): ${stderr}`));
      });
    });
    assert.throws(() => acquireRunLock(RUN_ID, { runsDir: dir, deadOwnerGraceMs: 0 }), (error) => {
      assert.equal(error?.data?.lock_owner_pid, child.pid);
      assert.equal(error?.data?.lock_owner_state, "alive");
      return true;
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const recovered = acquireRunLock(RUN_ID, { runsDir: dir, deadOwnerGraceMs: 0 });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recovered_lock.owner_pid, child.pid);
    recovered.release();
    assert.equal(existsSync(runLockPath(RUN_ID, { runsDir: dir })), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
