import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fullTimingFixture,
  legacyTimingFixture,
  rehashTimingEvents,
  timingIso,
  truncatedTimingFixture,
} from "../helpers/timing-fixtures.mjs";

async function timingApi() {
  return import("../../mcp/lib/timing-ledger.mjs");
}

function issueCodes(result) {
  return (result.issues || []).map((issue) => typeof issue === "string" ? issue : issue.code);
}

function replayProfile(overrides = {}) {
  return {
    schema: "alphacouncil_timing_replay_profile_v1",
    schema_version: 1,
    profile_id: "ci-balanced",
    max_concurrency_by_stage: {
      evidence: 2,
      methods: 2,
      debate_round_1: 2,
      debate_round_2: 2,
      debate_round_3: 2,
      portfolio_manager: 1,
    },
    timeout_cap_ms_by_stage: {
      evidence: 10_000,
      methods: 10_000,
      debate_round_1: 10_000,
      debate_round_2: 10_000,
      debate_round_3: 10_000,
      portfolio_manager: 10_000,
    },
    ...overrides,
  };
}

test("timing derivation rejects hash, sequence and append-clock tampering", async () => {
  const { deriveTimingLedger } = await timingApi();
  const base = fullTimingFixture();
  const cases = [
    {
      code: "event_hash_invalid",
      mutate(events) { events[2].event_hash = "0".repeat(64); return events; },
    },
    {
      code: "event_sequence_invalid",
      mutate(events) { events[2].seq = 99; return events; },
    },
    {
      code: "event_timestamp_not_monotonic",
      mutate(events) { events[5].at = timingIso(50); return rehashTimingEvents(events); },
    },
  ];
  for (const fixtureCase of cases) {
    const result = deriveTimingLedger({
      status: structuredClone(base.status),
      evidence: structuredClone(base.evidence),
      events: fixtureCase.mutate(structuredClone(base.events)),
    });
    assert.equal(result.coverage.status, "structural_invalid", fixtureCase.code);
    assert.ok(issueCodes(result).includes(fixtureCase.code), fixtureCase.code);
    assert.equal(result.marketing_eligible, false);
  }
});

test("parallel stage duration uses first start to barrier, never summed worker time", async () => {
  const { deriveTimingLedger } = await timingApi();
  const input = fullTimingFixture();
  const ledger = deriveTimingLedger(input);
  const evidence = ledger.stages.find((stage) => stage.stage === "evidence");
  assert.equal(ledger.coverage.status, "observed_process_boundary");
  assert.equal(evidence.started_at, timingIso(100));
  assert.equal(evidence.barrier_completed_at, timingIso(5_200));
  assert.equal(evidence.elapsed_ms, 5_100);
  assert.equal(evidence.worker_elapsed_ms_sum, 9_790);
  assert.notEqual(evidence.elapsed_ms, evidence.worker_elapsed_ms_sum);
  assert.equal(
    evidence.critical_invocation_key,
    "evidence:filings:1",
    "same-millisecond settlements use the lexicographically smallest invocation key",
  );
  assert.equal(ledger.total.elapsed_ms, 20_000);
  assert.equal(
    ledger.unattributed_ms,
    ledger.total.elapsed_ms - ledger.classified_interval_union_ms,
  );
  assert.ok(ledger.unattributed_ms >= 0);
});

test("attempt_kind preserves primary, timeout-retry and parse-repair causality within stages", async () => {
  const { deriveTimingLedger } = await timingApi();
  const input = fullTimingFixture();
  input.events = rehashTimingEvents(input.events.map((event) => {
    if (event.invocation_key === "evidence:market_data:1") {
      return { ...event, attempt: 2, attempt_kind: "timeout_retry" };
    }
    if (event.invocation_key === "methods:master_taleb:1") {
      return { ...event, attempt: 2, attempt_kind: "parse_repair" };
    }
    return event;
  }));
  const ledger = deriveTimingLedger(input);
  const byStage = ledger.attempts.reduce((groups, attempt) => {
    (groups[attempt.stage] ||= []).push(attempt);
    return groups;
  }, {});
  assert.deepEqual(
    [...new Set(byStage.evidence.map((attempt) => attempt.attempt_kind))].sort(),
    ["primary", "timeout_retry"],
  );
  assert.deepEqual(
    [...new Set(byStage.methods.map((attempt) => attempt.attempt_kind))].sort(),
    ["parse_repair", "primary"],
  );
});

test("full topology is queue, evidence, optional verification, methods, R1-R3, PM, persistence", async () => {
  const { deriveTimingLedger } = await timingApi();
  const ledger = deriveTimingLedger(fullTimingFixture());
  assert.deepEqual(ledger.topology.stage_order, [
    "queue_and_grounding",
    "evidence",
    "methods",
    "debate_round_1",
    "debate_round_2",
    "debate_round_3",
    "portfolio_manager",
    "terminal_persistence",
  ]);
  assert.equal(ledger.topology.verification_required, false);
  assert.equal(ledger.topology.status, "valid");
});

test("duplicate or missing attempt events are structural_invalid, not truncated", async () => {
  const { deriveTimingLedger } = await timingApi();
  const base = fullTimingFixture();
  const startIndex = base.events.findIndex((event) => event.type === "worker_attempt_started");
  const finishIndex = base.events.findIndex((event) => event.type === "worker_attempt_finished");

  const duplicate = structuredClone(base.events);
  duplicate.splice(startIndex + 1, 0, { ...duplicate[startIndex] });
  const duplicateLedger = deriveTimingLedger({
    status: base.status,
    evidence: base.evidence,
    events: rehashTimingEvents(duplicate),
  });
  assert.equal(duplicateLedger.coverage.status, "structural_invalid");
  assert.ok(issueCodes(duplicateLedger).includes("worker_attempt_duplicate_start"));

  const missing = structuredClone(base.events);
  missing.splice(finishIndex, 1);
  const missingLedger = deriveTimingLedger({
    status: base.status,
    evidence: base.evidence,
    events: rehashTimingEvents(missing),
  });
  assert.equal(missingLedger.coverage.status, "structural_invalid");
  assert.ok(issueCodes(missingLedger).includes("worker_attempt_missing_finish"));
});

test("an explicit early terminal run has a valid truncated ledger and a named frontier", async () => {
  const { deriveTimingLedger } = await timingApi();
  const ledger = deriveTimingLedger(truncatedTimingFixture());
  assert.equal(ledger.coverage.status, "truncated");
  assert.equal(ledger.topology.status, "valid_truncated");
  assert.equal(ledger.topology.frontier, "evidence");
  assert.deepEqual(ledger.topology.missing_stages, [
    "methods",
    "debate_round_1",
    "debate_round_2",
    "debate_round_3",
    "portfolio_manager",
  ]);
  assert.equal(issueCodes(ledger).includes("worker_attempt_missing_finish"), false);
  assert.equal(ledger.marketing_eligible, false);
});

test("offline replay is byte-deterministic and performs no fetch or filesystem write", async () => {
  const { deriveTimingLedger, replayTimingLedger } = await timingApi();
  const ledger = deriveTimingLedger(fullTimingFixture());
  const profile = replayProfile();
  const scratch = mkdtempSync(join(tmpdir(), "alphacouncil-replay-pure-"));
  const before = readdirSync(scratch);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("replay attempted network"); };
  try {
    const first = replayTimingLedger({ ledger, profile });
    const second = replayTimingLedger({ ledger, profile });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(fetchCalls, 0);
    assert.deepEqual(readdirSync(scratch), before);
    assert.equal(first.counterfactual_estimate, true);
    assert.equal(first.marketing_eligible, false);
    assert.equal(first.anchors.event_tail_hash, ledger.anchors.event_tail_hash);
    for (const key of ["status_sha256", "evidence_sha256", "timing_ledger_sha256", "profile_sha256"]) {
      assert.match(first.anchors[key], /^sha256:[0-9a-f]{64}$/u, key);
    }
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a replay cap below an observed completed duration projects timeout and incomplete", async () => {
  const { deriveTimingLedger, replayTimingLedger } = await timingApi();
  const ledger = deriveTimingLedger(fullTimingFixture());
  const replay = replayTimingLedger({
    ledger,
    profile: replayProfile({
      timeout_cap_ms_by_stage: {
        ...replayProfile().timeout_cap_ms_by_stage,
        evidence: 1_000,
      },
    }),
  });
  assert.equal(replay.status, "projected_timeout");
  assert.equal(replay.projected_terminal_status, "incomplete");
  assert.equal(replay.marketing_eligible, false);
  assert.notEqual(replay.projected_terminal_status, "complete");
});

test("legacy stage-only and visible runs are never upgraded to current process coverage", async () => {
  const { deriveTimingLedger } = await timingApi();
  const legacy = deriveTimingLedger(legacyTimingFixture());
  assert.equal(legacy.coverage.status, "legacy_stage_only");
  assert.equal(legacy.marketing_eligible, false);
  const visible = deriveTimingLedger(legacyTimingFixture({ visible: true }));
  assert.equal(visible.coverage.status, "not_evaluable");
  assert.equal(visible.coverage.reason, "visible_host_timing_not_observed");
  assert.equal(visible.marketing_eligible, false);
});

test("a timed-out observation is right-censored and a higher-cap replay stays not evaluable", async () => {
  const { deriveTimingLedger, replayTimingLedger } = await timingApi();
  const ledger = deriveTimingLedger(truncatedTimingFixture());
  const replay = replayTimingLedger({
    ledger,
    profile: replayProfile({
      timeout_cap_ms_by_stage: {
        ...replayProfile().timeout_cap_ms_by_stage,
        evidence: 2_000,
      },
    }),
  });
  assert.equal(replay.status, "not_evaluable_censored");
  assert.ok(issueCodes(replay).includes("observed_duration_right_censored"));
  assert.equal(replay.projected_terminal_status, null);
  assert.equal(replay.marketing_eligible, false);
});
