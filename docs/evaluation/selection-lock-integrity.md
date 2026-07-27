# Selection, receipt and run-start lock integrity

Status: implemented for the v0.9 development line.

The selection gate mutates two one-run records:

```text
<data>/selections/SEL-<uuid>.json
<data>/selections/receipts/RCP-<uuid>.json
```

Confirmation locks the selection record; receipt consumption locks the receipt record. A
lock is an exact sibling ending in `.json.lock`. Cleanup is restricted to those two
AlphaCouncil directories and those exact UUID-shaped names.

Run creation and idempotent replay use the same discipline under the exact runs directory:

```text
<data>/runs/.<validated-run-id>.lock
```

The run lock is held from receipt validation through run creation or replay and released by
the outer `withSelectedRun` finally block. Every retry acquires the lease before reading
`evidence.json`, closing the old check-then-create race.

## Atomic acquisition

The implementation does not create an empty lock and fill it later. It first writes and
`fsync`s a complete, unique candidate under `selections/.lock-candidates/`, then uses a
same-filesystem hard link to create the public `.lock` name atomically. A process that dies
before the link leaves no controlling lock; a process that dies after the link leaves a
complete inspectable record.

Each lock carries:

```json
{
  "schema_version": 1,
  "lock_kind": "alphacouncil_selection_exclusive or alphacouncil_run_exclusive",
  "resource_kind": "selection, receipt or run",
  "resource_id": "SEL-..., RCP-... or validated run ID",
  "operation": "confirm_selection, consume_receipt or start_or_replay_run",
  "token": "unique UUID",
  "owner_pid": 12345,
  "owner_hostname": "host name",
  "created_at": "ISO timestamp",
  "lease_expires_at": "ISO timestamp"
}
```

Release re-reads the lock and removes it only when the token still belongs to the releasing
owner. An obsolete process cannot delete its successor's lock, and repeated release is a
no-op.

## Recovery rules

Recovery is deliberately asymmetric:

- A same-host PID that is alive is never pre-empted, even after the advertised two-minute
  lease expires. Lease expiry is diagnostic, not permission to steal.
- `EPERM` and unknown PID-probe errors fail closed as alive or unverifiable.
- A same-host dead PID may be reclaimed only after the five-second dead-owner grace.
- A foreign-host owner cannot be proven dead by a local PID probe and is never reclaimed
  automatically.
- A malformed, empty, symlinked, mismatched or future-dated lock is never guessed stale.
- Recovery uses a short `.reclaim` marker. Every normal acquirer checks the marker before
  linking, preventing another active owner from entering the dead-lock replacement window.
- Dead-owner candidate and recovery artifacts are swept by the same owner rules. Active or
  foreign artifacts remain untouched.

Contention errors expose only operational lock metadata: owner PID, host, creation time,
lease time, owner state and whether recovery is in progress. No prompt or selection content
is stored in a lock.

## Expiry cleanup

Opening a new selection runs a bounded cleanup pass. The default policy keeps an expired
selection and receipt for 24 hours so an old caller can receive an explicit expiry result.
After retention:

1. only plain regular files matching the exact `SEL-<uuid>.json` or
   `RCP-<uuid>.json` grammar are considered;
2. the JSON's embedded ID must match its filename and `expires_at` must be parseable;
3. cleanup acquires the same exclusive lock as normal mutation;
4. the record is re-read after acquisition before deletion;
5. active locks are skipped; corrupt records, symlinks, directories and unknown names are
   reported or ignored, never followed;
6. the pass is capped by `SELECTION_CLEANUP_MAX_FILES` for each scanned record/lock class.

Cleanup is idempotent. A second pass reports zero removals. It does not recursively delete,
does not touch the runs directory, does not follow a symlink out of the selection store and
does not modify arbitrary files beside recognized records.

Run records have their own lifecycle and are not expiry-deleted by this cleanup. A dead
same-host run-start lock is recovered on the next attempt using the same PID, hostname,
grace, recovery marker and token-safe release rules. A live run process remains
`RUN_IN_PROGRESS` even when its advertised lease is old. Recovery happens before receipt
consumption, so contention does not burn the one-run selection receipt.

## Test contract

`test/unit/selection-lock-recovery.test.mjs` covers:

- inspectable owner/time metadata and token-safe idempotent release;
- active contention after lease expiry;
- dead-owner recovery before and after grace;
- foreign and malformed fail-closed behavior;
- retained-expired selection and receipt cleanup;
- active cleanup exclusion and dead orphan recovery;
- candidate/recovery artifact cleanup;
- path traversal, root and symlink refusal;
- a real child process holding a lock until process death.

`test/unit/run-lock-recovery.test.mjs` and
`test/integration/run-lock-recovery.test.mjs` apply the same checks to run-start locks and
prove through the real RPC server that a dead owner recovers, an active owner remains
protected after lease expiry, and a blocked retry can reuse its unconsumed receipt once the
active lock is released.

These tests establish local filesystem and same-host process semantics. They do not claim
that a shared network filesystem offers reliable cross-host PID liveness; cross-host locks
therefore remain fail-closed and require operator intervention.
