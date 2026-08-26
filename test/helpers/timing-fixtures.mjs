import { jsonlEntryHash } from "../../mcp/lib/fsutil.mjs";

const EPOCH_MS = Date.parse("2026-08-26T00:00:00.000Z");

export function timingIso(offsetMs) {
  return new Date(EPOCH_MS + offsetMs).toISOString();
}

export function rehashTimingEvents(events) {
  return events.map((source, index, rebuilt) => {
    const event = {
      ...source,
      seq: index + 1,
      prev_hash: rebuilt[index - 1]?.event_hash || null,
    };
    delete event.event_hash;
    event.event_hash = jsonlEntryHash(event);
    return event;
  });
}

function append(events, offsetMs, type, fields = {}) {
  const event = {
    schema_version: 1,
    seq: events.length + 1,
    prev_hash: events.at(-1)?.event_hash || null,
    at: timingIso(offsetMs),
    type,
    ...fields,
  };
  event.event_hash = jsonlEntryHash(event);
  events.push(event);
}

function appendAttempt(events, {
  invocationKey,
  stage,
  attempt = 1,
  attemptKind = "primary",
  startMs,
  finishMs,
  finishAppendMs = finishMs,
  budgetMs = 10_000,
  outcome = "completed",
  timedOut = false,
  forcedSettle = false,
  pid = 10_001,
  searchEnabled = true,
}) {
  const common = {
    invocation_key: invocationKey,
    stage,
    attempt,
    attempt_kind: attemptKind,
    budget_ms: budgetMs,
    search_enabled: searchEnabled,
    started_at: timingIso(startMs),
    pid,
  };
  append(events, startMs, "worker_attempt_started", common);
  append(events, finishAppendMs, "worker_attempt_finished", {
    ...common,
    finished_at: timingIso(finishMs),
    elapsed_ms: finishMs - startMs,
    outcome,
    timed_out: timedOut,
    forced_settle: forcedSettle,
  });
}

function appendParallelAttempts(events, attempts) {
  const pending = attempts.flatMap((attempt) => {
    const {
      invocationKey,
      stage,
      startMs,
      finishMs,
      finishAppendMs = finishMs,
      attempt: attemptNumber = 1,
      attemptKind = "primary",
      budgetMs = 10_000,
      outcome = "completed",
      timedOut = false,
      forcedSettle = false,
      pid,
      searchEnabled = true,
    } = attempt;
    const common = {
      invocation_key: invocationKey,
      stage,
      attempt: attemptNumber,
      attempt_kind: attemptKind,
      budget_ms: budgetMs,
      search_enabled: searchEnabled,
      started_at: timingIso(startMs),
      pid,
    };
    return [
      { atMs: startMs, type: "worker_attempt_started", fields: common },
      {
        atMs: finishAppendMs,
        type: "worker_attempt_finished",
        fields: {
          ...common,
          finished_at: timingIso(finishMs),
          elapsed_ms: finishMs - startMs,
          outcome,
          timed_out: timedOut,
          forced_settle: forcedSettle,
        },
      },
    ];
  }).sort((left, right) => left.atMs - right.atMs
    || left.type.localeCompare(right.type)
    || left.fields.invocation_key.localeCompare(right.fields.invocation_key));
  for (const item of pending) append(events, item.atMs, item.type, item.fields);
}

function baseArtifacts(overrides = {}) {
  const status = {
    run_id: "TIMING-FIXTURE-1",
    symbol: "TEST",
    status: "complete",
    phase: "complete",
    execution_mode: "background_codex_exec",
    council_mode: "full",
    started_at: timingIso(0),
    completed_at: timingIso(20_000),
    selected_analysts: ["market_data", "filings"],
    selected_masters: ["master_buffett", "master_taleb"],
    verification_policy: { required: false },
    ...overrides,
  };
  const evidence = {
    run_id: status.run_id,
    symbol: status.symbol,
    status: status.status,
    execution_mode: status.execution_mode,
    council_mode: status.council_mode,
    started_at: status.started_at,
    completed_at: status.completed_at,
    tasks: ["market_data", "filings"],
    masters: ["master_buffett", "master_taleb"],
    verification_policy: status.verification_policy,
  };
  return { status, evidence };
}

export function fullTimingFixture() {
  const { status, evidence } = baseArtifacts();
  const events = [];
  append(events, 10, "run_started", { council_mode: "full" });
  appendParallelAttempts(events, [{
    invocationKey: "evidence:filings:1",
    stage: "evidence",
    startMs: 100,
    finishMs: 5_000,
    pid: 10_101,
  }, {
    invocationKey: "evidence:market_data:1",
    stage: "evidence",
    startMs: 110,
    finishMs: 5_000,
    finishAppendMs: 5_001,
    pid: 10_102,
  }]);
  append(events, 5_200, "evidence_complete", { barrier_satisfied: true });
  append(events, 5_250, "masters_started", { total: 2 });
  appendParallelAttempts(events, [{
    invocationKey: "methods:master_buffett:1",
    stage: "methods",
    startMs: 5_300,
    finishMs: 9_000,
    pid: 10_201,
  }, {
    invocationKey: "methods:master_taleb:1",
    stage: "methods",
    startMs: 5_310,
    finishMs: 9_000,
    finishAppendMs: 9_001,
    pid: 10_202,
  }]);
  append(events, 9_200, "masters_complete", { completed: 2, total: 2, missing: [] });
  append(events, 9_250, "debate_started", { rounds: 3 });
  appendParallelAttempts(events, [{
    invocationKey: "debate_round_1:bear:1",
    stage: "debate_round_1",
    startMs: 9_300,
    finishMs: 11_000,
    pid: 10_301,
    searchEnabled: false,
  }, {
    invocationKey: "debate_round_1:bull:1",
    stage: "debate_round_1",
    startMs: 9_310,
    finishMs: 11_000,
    finishAppendMs: 11_001,
    pid: 10_302,
    searchEnabled: false,
  }]);
  append(events, 11_200, "debate_round", { round: 1, format: "parallel_per_round" });
  appendParallelAttempts(events, [{
    invocationKey: "debate_round_2:bear:1",
    stage: "debate_round_2",
    startMs: 11_300,
    finishMs: 13_000,
    pid: 10_401,
    searchEnabled: false,
  }, {
    invocationKey: "debate_round_2:bull:1",
    stage: "debate_round_2",
    startMs: 11_310,
    finishMs: 13_000,
    finishAppendMs: 13_001,
    pid: 10_402,
    searchEnabled: false,
  }]);
  append(events, 13_200, "debate_round", { round: 2, format: "parallel_per_round" });
  appendParallelAttempts(events, [{
    invocationKey: "debate_round_3:bear:1",
    stage: "debate_round_3",
    startMs: 13_300,
    finishMs: 15_000,
    pid: 10_501,
    searchEnabled: false,
  }, {
    invocationKey: "debate_round_3:bull:1",
    stage: "debate_round_3",
    startMs: 13_310,
    finishMs: 15_000,
    finishAppendMs: 15_001,
    pid: 10_502,
    searchEnabled: false,
  }]);
  append(events, 15_200, "debate_round", { round: 3, format: "parallel_per_round" });
  appendAttempt(events, {
    invocationKey: "portfolio_manager:portfolio_manager:1",
    stage: "portfolio_manager",
    startMs: 15_300,
    finishMs: 18_000,
    pid: 10_601,
    searchEnabled: false,
  });
  append(events, 18_050, "agent_role_completed", { role: "portfolio_manager", round: 4 });
  append(events, 18_100, "run_complete", { decision: "hold" });
  return { status, evidence, events };
}

export function legacyTimingFixture({ visible = false } = {}) {
  const executionMode = visible ? "visible_host_orchestration" : "background_codex_exec";
  const { status, evidence } = baseArtifacts({ execution_mode: executionMode });
  evidence.execution_mode = executionMode;
  const events = [];
  append(events, 10, "run_started", { council_mode: "full" });
  append(events, 100, "master_running", { master: "master_buffett", started_at: timingIso(100) });
  append(events, 5_000, "master_completed", { master: "master_buffett", completed_at: timingIso(5_000) });
  append(events, 18_100, "run_complete", { decision: "hold" });
  return { status, evidence, events };
}

export function truncatedTimingFixture() {
  const { status, evidence } = baseArtifacts({
    status: "incomplete",
    phase: "incomplete",
    completed_at: timingIso(1_200),
  });
  evidence.status = status.status;
  evidence.completed_at = status.completed_at;
  const events = [];
  append(events, 10, "run_started", { council_mode: "full" });
  appendAttempt(events, {
    invocationKey: "evidence:market_data:1",
    stage: "evidence",
    startMs: 100,
    finishMs: 1_100,
    budgetMs: 1_000,
    outcome: "timed_out",
    timedOut: true,
    forcedSettle: true,
  });
  append(events, 1_150, "incomplete", { missing_evidence: ["market_data"] });
  return { status, evidence, events };
}
