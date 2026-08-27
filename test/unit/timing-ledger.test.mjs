import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { jsonlEntryHash } from "../../mcp/lib/fsutil.mjs";

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

test("timing fixture rehash is identity-stable and rebuilds a valid chain after splice", () => {
  const original = fullTimingFixture().events;
  assert.equal(JSON.stringify(rehashTimingEvents(structuredClone(original))), JSON.stringify(original));

  const spliced = structuredClone(original);
  spliced.splice(2, 1);
  const rebuilt = rehashTimingEvents(spliced);
  for (const [index, event] of rebuilt.entries()) {
    const hashInput = { ...event };
    delete hashInput.event_hash;
    assert.equal(event.seq, index + 1);
    assert.equal(event.prev_hash, rebuilt[index - 1]?.event_hash || null);
    assert.equal(event.event_hash, jsonlEntryHash(hashInput));
  }
});

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

test("evidence-wave proof fails when a finish is appended before the eighth start", async () => {
  const { workerAttemptWaveOrder } = await timingApi();
  const invocationKeys = Array.from({ length: 8 }, (_, index) => `evidence:task_${index + 1}:primary:1`);
  const started = (invocationKey, index) => ({
    schema_version: 1,
    at: timingIso(100 + index),
    type: "worker_attempt_started",
    invocation_key: invocationKey,
    stage: "evidence",
    attempt: 1,
    attempt_kind: "primary",
  });
  const finished = {
    schema_version: 1,
    at: timingIso(108),
    type: "worker_attempt_finished",
    invocation_key: invocationKeys[0],
    stage: "evidence",
    attempt: 1,
    attempt_kind: "primary",
  };
  const starts = invocationKeys.map(started);

  const invalidEvents = rehashTimingEvents([
    ...starts.slice(0, 7),
    finished,
    { ...starts[7], at: timingIso(109) },
  ]);
  const invalid = workerAttemptWaveOrder(invalidEvents, {
    stage: "evidence",
    expectedInvocationKeys: invocationKeys,
  });
  assert.equal(invalid.status, "failed");
  assert.ok(invalid.issues.some((item) => item.code === "worker_wave_finish_precedes_all_starts"));
  assert.equal(invalid.first_finish_seq, 8);
  assert.equal(invalid.last_start_seq, 9);

  const validEvents = rehashTimingEvents([
    ...starts,
    { ...finished, at: timingIso(109) },
  ]);
  const valid = workerAttemptWaveOrder(validEvents, {
    stage: "evidence",
    expectedInvocationKeys: invocationKeys,
  });
  assert.equal(valid.status, "passed", JSON.stringify(valid.issues));
  assert.equal(valid.last_start_seq, 8);
  assert.equal(valid.first_finish_seq, 9);
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

test("identity replay preserves every observed worker duration without a hidden speed multiplier", async () => {
  const { deriveTimingLedger, replayTimingLedger } = await timingApi();
  const ledger = deriveTimingLedger(fullTimingFixture());
  const replay = replayTimingLedger({ ledger, profile: replayProfile() });
  const replayAttempts = new Map(replay.attempts.map((attempt) => [attempt.invocation_key, attempt]));
  for (const observed of ledger.attempts) {
    const projected = replayAttempts.get(observed.invocation_key);
    assert.ok(projected, observed.invocation_key);
    assert.equal(projected.observed_elapsed_ms, observed.elapsed_ms, observed.invocation_key);
    assert.equal(projected.projected_elapsed_ms, observed.elapsed_ms, observed.invocation_key);
  }
  const replayStages = new Map(replay.stages.map((stage) => [stage.stage, stage]));
  for (const observed of ledger.stages.filter((stage) => stage.worker_attempt_count > 0)) {
    const projected = replayStages.get(observed.stage);
    assert.ok(projected, observed.stage);
    assert.equal(projected.observed_worker_elapsed_ms, observed.worker_critical_elapsed_ms, observed.stage);
    assert.equal(projected.projected_elapsed_ms, observed.worker_critical_elapsed_ms, observed.stage);
  }
  assert.equal(replayStages.get("evidence").projected_elapsed_ms, 4_900);
  assert.doesNotMatch(JSON.stringify(replay), /(?:speedup|speed_up|scale_factor|duration_multiplier|acceleration)/iu);
  assert.equal(replay.counterfactual_estimate, true);
  assert.equal(replay.marketing_eligible, false);
});

test("replay list-schedules evidence workers serially when concurrency falls from two to one", async () => {
  const { deriveTimingLedger, replayTimingLedger } = await timingApi();
  const ledger = deriveTimingLedger(fullTimingFixture());
  const profile = replayProfile({
    max_concurrency_by_stage: {
      ...replayProfile().max_concurrency_by_stage,
      evidence: 1,
    },
  });
  const first = replayTimingLedger({ ledger, profile });
  const second = replayTimingLedger({ ledger, profile });
  const observed = ledger.stages.find((stage) => stage.stage === "evidence");
  const projected = first.stages.find((stage) => stage.stage === "evidence");
  assert.equal(projected.projected_elapsed_ms, 9_790);
  assert.ok(projected.projected_elapsed_ms > observed.elapsed_ms);
  assert.equal(projected.max_concurrency, 1);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.counterfactual_estimate, true);
  assert.equal(first.marketing_eligible, false);
});

test("a round-two worker starting before the round-one barrier is structural_invalid", async () => {
  const { deriveTimingLedger } = await timingApi();
  const input = fullTimingFixture();
  input.events = rehashTimingEvents(input.events.map((event) => {
    if (event.invocation_key !== "debate_round_2:bear:1") return event;
    if (event.type === "worker_attempt_started") {
      return { ...event, at: timingIso(10_000), started_at: timingIso(10_000) };
    }
    return {
      ...event,
      at: timingIso(10_700),
      started_at: timingIso(10_000),
      finished_at: timingIso(10_700),
      elapsed_ms: 700,
    };
  }).sort((left, right) => Date.parse(left.at) - Date.parse(right.at)
    || left.type.localeCompare(right.type)
    || String(left.invocation_key || "").localeCompare(String(right.invocation_key || ""))));
  const ledger = deriveTimingLedger(input);
  assert.equal(ledger.coverage.status, "structural_invalid");
  assert.ok(
    (ledger.issues || []).some((issue) => /topology|stage order|barrier/iu.test(`${issue.code || ""} ${issue.message || ""}`)),
    "a topology issue must explain the R2-before-R1 barrier violation",
  );
  assert.equal(ledger.marketing_eligible, false);
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
