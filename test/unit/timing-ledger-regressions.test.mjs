import assert from "node:assert/strict";
import test from "node:test";

import { deriveTimingLedger, replayTimingLedger } from "../../mcp/lib/timing-ledger.mjs";
import {
  fullTimingFixture,
  rehashTimingEvents,
  timingIso,
  truncatedTimingFixture,
} from "../helpers/timing-fixtures.mjs";

function issueCodes(ledger) {
  return ledger.issues.map((entry) => entry.code);
}

function rescheduleMarketData({ startMs, finishMs }) {
  const fixture = fullTimingFixture();
  fixture.events = fixture.events.map((event) => {
    if (event.invocation_key !== "evidence:market_data:1") return event;
    const updated = {
      ...event,
      started_at: timingIso(startMs),
      at: timingIso(event.type === "worker_attempt_started" ? startMs : finishMs + 1),
    };
    if (event.type === "worker_attempt_finished") {
      updated.finished_at = timingIso(finishMs);
      updated.elapsed_ms = finishMs - startMs;
    }
    return updated;
  });
  fixture.events.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  fixture.events = rehashTimingEvents(fixture.events);
  return fixture;
}

function replayProfile() {
  return {
    schema: "alphacouncil_timing_replay_profile_v1",
    schema_version: 1,
    profile_id: "stagger-regression",
    max_concurrency_by_stage: { evidence: 2 },
    timeout_cap_ms_by_stage: { evidence: 10_000 },
  };
}

function quickFixture({ includeForbiddenRoundTwo = false } = {}) {
  const fixture = fullTimingFixture();
  fixture.status.council_mode = "quick";
  fixture.evidence.council_mode = "quick";
  fixture.events = fixture.events
    .filter((event) => {
      if (event.stage === "debate_round_3") return false;
      if (event.stage === "debate_round_2") return includeForbiddenRoundTwo;
      if (event.type === "debate_round" && [2, 3].includes(event.round)) return false;
      return true;
    })
    .map((event) => event.type === "run_started" ? { ...event, council_mode: "quick" } : event);
  fixture.events = rehashTimingEvents(fixture.events);
  return fixture;
}

test("staggered settlement keeps the longest worker as the scheduling critical attempt", () => {
  const ledger = deriveTimingLedger(rescheduleMarketData({ startMs: 4_900, finishMs: 5_100 }));
  const evidence = ledger.stages.find((stage) => stage.stage === "evidence");
  const replay = replayTimingLedger({ ledger, profile: replayProfile() });
  const projected = replay.stages.find((stage) => stage.stage === "evidence");

  assert.equal(ledger.coverage.status, "observed_process_boundary");
  assert.equal(evidence.elapsed_ms, 5_100, "the observed stage still includes launch stagger and barrier delay");
  assert.equal(evidence.critical_invocation_key, "evidence:filings:1");
  assert.equal(evidence.worker_critical_elapsed_ms, 4_900);
  assert.equal(projected.observed_worker_elapsed_ms, 4_900);
  assert.equal(projected.projected_elapsed_ms, 4_900);
});

test("equal worker durations use the invocation key as the deterministic tie-break", () => {
  const ledger = deriveTimingLedger(rescheduleMarketData({ startMs: 200, finishMs: 5_100 }));
  const evidence = ledger.stages.find((stage) => stage.stage === "evidence");
  const replay = replayTimingLedger({ ledger, profile: replayProfile() });
  const projected = replay.stages.find((stage) => stage.stage === "evidence");

  assert.equal(evidence.critical_invocation_key, "evidence:filings:1");
  assert.equal(evidence.worker_critical_elapsed_ms, 4_900);
  assert.equal(projected.projected_elapsed_ms, 4_900);
});

test("quick uses its one-round topology and rejects a hidden round-two worker", () => {
  const valid = deriveTimingLedger(quickFixture());
  assert.equal(valid.coverage.status, "observed_process_boundary");
  assert.equal(valid.topology.status, "valid");
  assert.equal(valid.topology.verification_required, false);
  assert.deepEqual(valid.topology.stage_order, [
    "queue_and_grounding",
    "evidence",
    "methods",
    "debate_round_1",
    "portfolio_manager",
    "terminal_persistence",
  ]);

  const forbidden = deriveTimingLedger(quickFixture({ includeForbiddenRoundTwo: true }));
  assert.equal(forbidden.coverage.status, "structural_invalid");
  assert.ok(issueCodes(forbidden).includes("stage_topology_invalid"));
});

test("visible timing coverage cannot be promoted by an offline timeout cap", () => {
  const fixture = fullTimingFixture();
  fixture.status.execution_mode = "visible_host_threads";
  fixture.evidence.execution_mode = "visible_host_threads";
  const ledger = deriveTimingLedger(fixture);
  const replay = replayTimingLedger({ ledger, profile: {
    ...replayProfile(),
    timeout_cap_ms_by_stage: { evidence: 1_000 },
  } });

  assert.equal(ledger.coverage.status, "not_evaluable");
  assert.equal(replay.status, "not_evaluable");
  assert.equal(replay.projected_terminal_status, null);
  assert.deepEqual(replay.attempts, []);
  assert.deepEqual(replay.stages, []);
  assert.equal(replay.marketing_eligible, false);
  assert.ok(replay.issues.some((entry) => entry.message.includes("not_evaluable")));
});

test("a declared current headless terminal state requires an explicit terminal event", () => {
  const fixture = fullTimingFixture();
  fixture.events = rehashTimingEvents(fixture.events.filter((event) => event.type !== "run_complete"));
  const ledger = deriveTimingLedger(fixture);
  assert.equal(ledger.coverage.status, "structural_invalid");
  assert.ok(issueCodes(ledger).includes("terminal_event_missing"));

  const truncated = deriveTimingLedger(truncatedTimingFixture());
  assert.equal(truncated.coverage.status, "truncated");
  assert.equal(truncated.topology.status, "valid_truncated");
});

test("a current headless run with no declared terminal state remains not evaluable", () => {
  const fixture = fullTimingFixture();
  fixture.status.status = "running";
  fixture.status.phase = "running";
  fixture.evidence.status = "running";
  delete fixture.status.completed_at;
  delete fixture.evidence.completed_at;
  fixture.events = rehashTimingEvents(fixture.events.filter((event) => event.type !== "run_complete"));

  const ledger = deriveTimingLedger(fixture);
  assert.equal(ledger.coverage.status, "not_evaluable");
  assert.equal(ledger.coverage.reason, "run_not_terminal");
  assert.equal(ledger.topology.status, "valid");
  assert.deepEqual(ledger.stages, []);
  assert.equal(issueCodes(ledger).includes("terminal_event_missing"), false);
});
