import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

import { cleanupSelectionStore } from "../../mcp/lib/selection-cleanup.mjs";
import {
  acquireSelectionLock,
  inspectSelectionLock,
  selectionLockPath,
  selectionResourcePath,
} from "../../mcp/lib/selection-locks.mjs";

const SELECTION_A = "SEL-11111111-1111-4111-8111-111111111111";
const SELECTION_B = "SEL-22222222-2222-4222-8222-222222222222";
const SELECTION_C = "SEL-33333333-3333-4333-8333-333333333333";
const RECEIPT_A = "RCP-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function store() {
  return mkdtempSync(join(tmpdir(), "alphacouncil-selection-locks-"));
}

function identity(machine, birth, boot = "b") {
  const part = (source, value) => ({ capability: "verified", source, fingerprint: `sha256:${value.repeat(64)}` });
  return { schema_version: 1, machine: part("test_machine", machine), boot: part("test_boot", boot), process_birth: part("test_birth", birth) };
}

function lockSpec(id = SELECTION_A) {
  return { kind: "selection", id, operation: "test", contentionReason: "TEST_LOCKED" };
}

function record(path, id, expiresAt, kind = "selection") {
  const key = kind === "selection" ? "selection_id" : "selection_receipt";
  writeFileSync(path, `${JSON.stringify({ schema_version: 1, [key]: id, expires_at: new Date(expiresAt).toISOString() }, null, 2)}\n`);
}

test("lock files contain inspectable ownership and time metadata and release is token-idempotent", () => {
  const dir = store();
  try {
    const lock = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 1_000,
      leaseMs: 2_000,
      ownerPid: 4242,
      hostname: "lock-test-host",
    });
    const metadata = JSON.parse(readFileSync(lock.path, "utf8"));
    assert.deepEqual(metadata, lock.metadata);
    assert.equal(metadata.lock_kind, "alphacouncil_selection_exclusive");
    assert.equal(metadata.resource_kind, "selection");
    assert.equal(metadata.resource_id, SELECTION_A);
    assert.equal(metadata.owner_pid, 4242);
    assert.equal(metadata.owner_hostname, "lock-test-host");
    assert.equal(metadata.created_at, "1970-01-01T00:00:01.000Z");
    assert.equal(metadata.lease_expires_at, "1970-01-01T00:00:03.000Z");
    assert.match(metadata.token, /^[0-9a-f-]{36}$/);
    assert.equal(lock.release(), true);
    assert.equal(lock.release(), false);
    assert.equal(existsSync(lock.path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a live same-host owner is never stolen even after its advertised lease expires", () => {
  const dir = store();
  try {
    const first = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 1_000,
      leaseMs: 1,
      ownerPid: 4242,
      hostname: "same-host",
    });
    assert.throws(
      () => acquireSelectionLock(lockSpec(), {
        selectionsDir: dir,
        now: 1_000_000,
        deadOwnerGraceMs: 0,
        hostname: "same-host",
        probePid: () => true,
      }),
      (error) => {
        assert.equal(error?.data?.reason, "TEST_LOCKED");
        assert.equal(error?.data?.lock_owner_pid, 4242);
        assert.equal(error?.data?.lock_owner_state, "alive");
        return true;
      },
    );
    assert.equal(JSON.parse(readFileSync(first.path, "utf8")).token, first.metadata.token);
    first.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a same-host dead owner is reclaimed only after the explicit grace", () => {
  const dir = store();
  try {
    const dead = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 1_000,
      ownerPid: 999_999,
      hostname: "same-host",
    });
    assert.throws(() => acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 5_999,
      deadOwnerGraceMs: 5_000,
      hostname: "same-host",
      probePid: () => false,
    }), (error) => error?.data?.reason === "TEST_LOCKED");

    const recovered = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 6_000,
      deadOwnerGraceMs: 5_000,
      hostname: "same-host",
      probePid: (pid) => pid === 999_999 ? false : true,
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recovered_lock.token, dead.metadata.token);
    assert.notEqual(recovered.metadata.token, dead.metadata.token);
    assert.equal(dead.release(), false, "an obsolete owner may not unlink its successor");
    assert.equal(JSON.parse(readFileSync(recovered.path, "utf8")).token, recovered.metadata.token);
    recovered.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stable machine identity survives hostname rename and rejects a reused PID after grace", () => {
  const dir = store();
  try {
    const first = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir, now: 1_000, ownerPid: 4242, hostname: "old-name", ownerIdentity: identity("a", "c"),
    });
    const live = inspectSelectionLock("selection", SELECTION_A, {
      selectionsDir: dir, now: 2_000, hostname: "new-name", probePid: () => true, identityProbe: () => identity("a", "c"),
    });
    assert.equal(live.owner_state, "alive");
    assert.equal(live.same_host, false);
    assert.equal(live.same_machine, true);
    const recovered = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir, now: 6_000, deadOwnerGraceMs: 5_000, hostname: "new-name",
      probePid: () => true, identityProbe: () => identity("a", "d"),
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recovered_lock.token, first.metadata.token);
    assert.equal(first.release(), false);
    recovered.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("foreign-host and malformed locks fail closed instead of being guessed dead", () => {
  const dir = store();
  try {
    const foreign = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 1_000,
      ownerPid: 999_999,
      hostname: "same-name",
      ownerIdentity: identity("a", "c"),
    });
    assert.throws(() => acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 999_999,
      deadOwnerGraceMs: 0,
      hostname: "same-name",
      probePid: () => false,
      identityProbe: () => identity("d", "e"),
    }), (error) => error?.data?.lock_owner_state === "foreign_unverifiable");
    foreign.release();

    const path = selectionLockPath("selection", SELECTION_A, { selectionsDir: dir });
    writeFileSync(path, "legacy empty-or-corrupt lock\n");
    assert.throws(() => acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 999_999,
      deadOwnerGraceMs: 0,
      hostname: "this-host",
      probePid: () => false,
    }), (error) => error?.data?.lock_owner_state === "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy hostname-and-pid metadata remains readable but cannot prove an owner dead", () => {
  const dir = store();
  try {
    const seeded = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir, now: 1_000, ownerPid: 4242, hostname: "legacy-host",
    });
    const legacy = { ...seeded.metadata };
    delete legacy.owner_identity;
    seeded.release();
    writeFileSync(seeded.path, `${JSON.stringify(legacy, null, 2)}\n`);

    const live = inspectSelectionLock("selection", SELECTION_A, {
      selectionsDir: dir, now: 9_000, hostname: "legacy-host", probePid: () => true, deadOwnerGraceMs: 0,
    });
    assert.equal(live.owner_state, "alive");
    assert.equal(live.identity_format, "legacy_hostname_pid_v1");

    const unverifiable = inspectSelectionLock("selection", SELECTION_A, {
      selectionsDir: dir, now: 9_000, hostname: "legacy-host", probePid: () => false, deadOwnerGraceMs: 0,
    });
    assert.equal(unverifiable.owner_state, "unknown");
    assert.equal(unverifiable.reclaimable, false);
    assert.throws(() => acquireSelectionLock(lockSpec(), {
      selectionsDir: dir, now: 9_000, hostname: "legacy-host", probePid: () => false, deadOwnerGraceMs: 0,
    }), (error) => error?.data?.lock_owner_state === "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup removes only retained-expired exact records and is idempotent", () => {
  const dir = store();
  const outside = join(tmpdir(), `alphacouncil-selection-sentinel-${process.pid}.txt`);
  try {
    writeFileSync(outside, "keep\n");
    const expiredSelection = selectionResourcePath("selection", SELECTION_A, { selectionsDir: dir });
    const freshSelection = selectionResourcePath("selection", SELECTION_B, { selectionsDir: dir });
    const expiredReceipt = selectionResourcePath("receipt", RECEIPT_A, { selectionsDir: dir });
    record(expiredSelection, SELECTION_A, 1_000);
    record(freshSelection, SELECTION_B, 9_500);
    record(expiredReceipt, RECEIPT_A, 1_000, "receipt");
    writeFileSync(join(dir, "do-not-touch.txt"), "keep\n");
    writeFileSync(join(dir, "SEL-33333333-3333-4333-8333-333333333333.json"), "corrupt\n");
    symlinkSync(outside, join(dir, "SEL-44444444-4444-4444-8444-444444444444.json"));

    const first = cleanupSelectionStore({ selectionsDir: dir, now: 10_000, retentionMs: 1_000 });
    assert.equal(first.selections_removed, 1);
    assert.equal(first.receipts_removed, 1);
    assert.equal(first.invalid_records_skipped, 1);
    assert.equal(first.unsafe_entries_skipped, 1);
    assert.equal(existsSync(expiredSelection), false);
    assert.equal(existsSync(expiredReceipt), false);
    assert.equal(existsSync(freshSelection), true);
    assert.equal(readFileSync(join(dir, "do-not-touch.txt"), "utf8"), "keep\n");
    assert.equal(readFileSync(outside, "utf8"), "keep\n");

    const second = cleanupSelectionStore({ selectionsDir: dir, now: 10_000, retentionMs: 1_000 });
    assert.equal(second.selections_removed, 0);
    assert.equal(second.receipts_removed, 0);
    assert.equal(readFileSync(outside, "utf8"), "keep\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});

test("cleanup skips an active expired record and later recovers a dead orphan lock", () => {
  const dir = store();
  try {
    const path = selectionResourcePath("selection", SELECTION_A, { selectionsDir: dir });
    record(path, SELECTION_A, 1_000);
    const active = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 2_000,
      ownerPid: 4242,
      hostname: "cleanup-host",
    });
    const skipped = cleanupSelectionStore({
      selectionsDir: dir,
      now: 10_000,
      retentionMs: 0,
      lockOptions: { hostname: "cleanup-host", probePid: () => true, deadOwnerGraceMs: 0 },
    });
    assert.equal(skipped.selections_removed, 0);
    assert.ok(skipped.active_locks_skipped >= 1);
    assert.equal(existsSync(path), true);
    active.release();

    const removed = cleanupSelectionStore({ selectionsDir: dir, now: 10_000, retentionMs: 0 });
    assert.equal(removed.selections_removed, 1);

    const dead = acquireSelectionLock(lockSpec(SELECTION_C), {
      selectionsDir: dir,
      now: 20_000,
      ownerPid: 999_999,
      hostname: "cleanup-host",
    });
    const recovered = cleanupSelectionStore({
      selectionsDir: dir,
      now: 30_000,
      retentionMs: 0,
      lockOptions: { hostname: "cleanup-host", probePid: () => false, deadOwnerGraceMs: 0 },
    });
    assert.equal(recovered.dead_locks_reclaimed, 1);
    assert.equal(existsSync(dead.path), false);
    assert.equal(dead.release(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup removes dead-owner candidate and recovery artifacts but never arbitrary files", () => {
  const dir = store();
  try {
    const dead = acquireSelectionLock(lockSpec(), {
      selectionsDir: dir,
      now: 1_000,
      ownerPid: 999_999,
      hostname: "artifact-host",
    });
    const metadata = `${JSON.stringify(dead.metadata, null, 2)}\n`;
    dead.release();
    const candidate = join(dir, ".lock-candidates", `selection-${dead.metadata.token}.json`);
    const recovery = `${selectionLockPath("selection", SELECTION_A, { selectionsDir: dir })}.reclaim`;
    writeFileSync(candidate, metadata);
    writeFileSync(recovery, metadata);
    writeFileSync(join(dir, ".lock-candidates", "unrelated.txt"), "keep\n");

    const result = cleanupSelectionStore({
      selectionsDir: dir,
      now: 10_000,
      retentionMs: 0,
      lockOptions: { hostname: "artifact-host", probePid: () => false, deadOwnerGraceMs: 0 },
    });
    assert.equal(result.lock_candidates_removed, 1);
    assert.equal(result.recovery_markers_removed, 1);
    assert.equal(existsSync(candidate), false);
    assert.equal(existsSync(recovery), false);
    assert.equal(readFileSync(join(dir, ".lock-candidates", "unrelated.txt"), "utf8"), "keep\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock paths reject traversal, wrong kinds, filesystem root and symlinked store directories", () => {
  const dir = store();
  const outside = store();
  try {
    assert.throws(() => selectionLockPath("selection", "../../escape", { selectionsDir: dir }), /Invalid selection lock resource id/);
    assert.throws(() => selectionLockPath("unknown", SELECTION_A, { selectionsDir: dir }), /Invalid unknown lock resource id/);
    assert.throws(() => selectionLockPath("selection", SELECTION_A, { selectionsDir: "relative/path" }), /absolute path/);
    assert.throws(() => selectionLockPath("selection", SELECTION_A, { selectionsDir: "/" }), /filesystem root/);
    const linked = join(dir, "linked-store");
    symlinkSync(outside, linked);
    assert.throws(() => selectionLockPath("selection", SELECTION_A, { selectionsDir: linked }), /not a plain directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a real child process owns the lock until death, then the next process recovers it", async () => {
  const dir = store();
  const moduleUrl = pathToFileURL(join(process.cwd(), "mcp/lib/selection-locks.mjs")).href;
  const code = `
    import { acquireSelectionLock } from ${JSON.stringify(moduleUrl)};
    acquireSelectionLock(
      { kind: "selection", id: ${JSON.stringify(SELECTION_A)}, operation: "child_hold", contentionReason: "CHILD_LOCKED" },
      { selectionsDir: process.env.TEST_SELECTION_DIR }
    );
    process.stdout.write("READY\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    cwd: process.cwd(),
    env: { ...process.env, TEST_SELECTION_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child lock timeout: ${stderr}`)), 5_000);
      child.stdout.on("data", (chunk) => {
        if (!String(chunk).includes("READY")) return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (codeValue) => {
        clearTimeout(timer);
        reject(new Error(`child exited before lock ready (${codeValue}): ${stderr}`));
      });
    });
    assert.throws(() => acquireSelectionLock(lockSpec(), { selectionsDir: dir, deadOwnerGraceMs: 0 }), (error) => {
      assert.equal(error?.data?.reason, "TEST_LOCKED");
      assert.equal(error?.data?.lock_owner_pid, child.pid);
      assert.equal(error?.data?.lock_owner_state, "alive");
      return true;
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const recovered = acquireSelectionLock(lockSpec(), { selectionsDir: dir, deadOwnerGraceMs: 0 });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.recovered_lock.owner_pid, child.pid);
    recovered.release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
