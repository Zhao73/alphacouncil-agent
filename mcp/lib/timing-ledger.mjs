import { createHash } from "node:crypto";

export { replayTimingLedger } from "./timing-replay.mjs";

const ATTEMPT_KINDS = new Set(["primary", "timeout_retry", "parse_repair"]);
const WORKER_STAGES = Object.freeze([
  "evidence",
  "verification",
  "methods",
  "debate_round_1",
  "debate_round_2",
  "debate_round_3",
  "portfolio_manager",
]);
const TERMINAL_EVENT_TYPES = new Set([
  "run_complete",
  "incomplete",
  "needs_verification",
  "run_degraded",
  "background_run_failed",
  "needs_revision",
]);
const TERMINAL_STATUSES = new Set([
  "complete",
  "incomplete",
  "needs_verification",
  "degraded",
  "failed",
  "needs_revision",
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;
}

function eventHash(event) {
  const subject = { ...event };
  delete subject.event_hash;
  return `sha256:${createHash("sha256").update(JSON.stringify(subject)).digest("hex")}`;
}

function issue(code, message, details) {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function pushIssue(issues, value) {
  if (!issues.some((item) => item.code === value.code && item.message === value.message)) issues.push(value);
}

function time(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function terminalStatus(status, evidence) {
  return String(evidence?.status || status?.status || "unknown");
}

function verificationRequired(status, evidence) {
  return evidence?.verification_policy?.required === true
    || status?.verification_policy?.required === true
    || status?.verifier_required === true;
}

function topologyOrder(required, councilMode) {
  return [
    "queue_and_grounding",
    "evidence",
    ...(required ? ["verification"] : []),
    "methods",
    "debate_round_1",
    ...(councilMode === "quick" ? [] : ["debate_round_2", "debate_round_3"]),
    "portfolio_manager",
    "terminal_persistence",
  ];
}

function barrierEvents(events) {
  const first = (predicate) => events.find(predicate) || null;
  return {
    evidence: first((event) => ["evidence_complete", "evidence_degraded", "evidence_partial"].includes(event.type)),
    verification: first((event) => ["verification_complete", "needs_verification"].includes(event.type)),
    methods: first((event) => event.type === "masters_complete"),
    debate_round_1: first((event) => event.type === "debate_round" && event.round === 1),
    debate_round_2: first((event) => event.type === "debate_round" && event.round === 2),
    debate_round_3: first((event) => event.type === "debate_round" && event.round === 3),
    portfolio_manager: first((event) => event.type === "agent_role_completed" && event.role === "portfolio_manager"),
  };
}

function validateEventChain(events, issues) {
  let previousHash = null;
  let previousTime = -Infinity;
  events.forEach((event, index) => {
    const line = index + 1;
    if (event?.seq !== line) pushIssue(issues, issue("event_sequence_invalid", `event ${line} has seq ${String(event?.seq)}`));
    if (event?.prev_hash !== previousHash) pushIssue(issues, issue("event_previous_hash_invalid", `event ${line} has an invalid prev_hash`));
    const expectedHash = eventHash(event || {});
    if (event?.event_hash !== expectedHash) pushIssue(issues, issue("event_hash_invalid", `event ${line} hash mismatch`));
    const appendTime = time(event?.at);
    if (appendTime === null) pushIssue(issues, issue("event_timestamp_invalid", `event ${line} has an invalid append timestamp`));
    else if (appendTime < previousTime) pushIssue(issues, issue("event_timestamp_not_monotonic", `event ${line} append time moves backwards`));
    if (appendTime !== null) previousTime = appendTime;
    previousHash = event?.event_hash ?? null;
  });
}

function attemptPairs(events, issues) {
  const starts = new Map();
  const finishes = new Map();
  for (const event of events) {
    if (!["worker_attempt_started", "worker_attempt_finished"].includes(event?.type)) continue;
    const key = typeof event.invocation_key === "string" ? event.invocation_key : "";
    if (!key) {
      pushIssue(issues, issue("worker_attempt_key_invalid", "worker timing event has no invocation_key"));
      continue;
    }
    const target = event.type === "worker_attempt_started" ? starts : finishes;
    if (target.has(key)) {
      pushIssue(issues, issue(
        event.type === "worker_attempt_started" ? "worker_attempt_duplicate_start" : "worker_attempt_duplicate_finish",
        `${key} has more than one ${event.type}`,
      ));
    } else target.set(key, event);
  }

  for (const key of starts.keys()) {
    if (!finishes.has(key)) pushIssue(issues, issue("worker_attempt_missing_finish", `${key} has no worker_attempt_finished event`));
  }
  for (const key of finishes.keys()) {
    if (!starts.has(key)) pushIssue(issues, issue("worker_attempt_missing_start", `${key} has no worker_attempt_started event`));
  }

  const attempts = [];
  for (const key of [...starts.keys()].filter((value) => finishes.has(value)).sort()) {
    const start = starts.get(key);
    const finish = finishes.get(key);
    const startMs = time(start.started_at);
    const finishMs = time(finish.finished_at);
    const elapsed = finishMs === null || startMs === null ? null : finishMs - startMs;
    if (!WORKER_STAGES.includes(start.stage) || finish.stage !== start.stage) {
      pushIssue(issues, issue("worker_attempt_stage_invalid", `${key} has an invalid or inconsistent stage`));
    }
    if (!ATTEMPT_KINDS.has(start.attempt_kind) || finish.attempt_kind !== start.attempt_kind) {
      pushIssue(issues, issue("worker_attempt_kind_invalid", `${key} has an invalid or inconsistent attempt_kind`));
    }
    if (!Number.isInteger(start.attempt) || start.attempt < 1 || finish.attempt !== start.attempt) {
      pushIssue(issues, issue("worker_attempt_number_invalid", `${key} has an invalid or inconsistent attempt number`));
    }
    if (finish.started_at !== start.started_at || startMs === null || finishMs === null || elapsed < 0) {
      pushIssue(issues, issue("worker_attempt_boundary_invalid", `${key} has invalid process boundary timestamps`));
    }
    if (finish.elapsed_ms !== elapsed) {
      pushIssue(issues, issue("worker_attempt_elapsed_mismatch", `${key} elapsed_ms does not match its boundaries`));
    }
    const startAppend = time(start.at);
    const finishAppend = time(finish.at);
    if ((startAppend !== null && startMs !== null && startAppend < startMs)
      || (finishAppend !== null && finishMs !== null && finishAppend < finishMs)) {
      pushIssue(issues, issue("worker_attempt_append_precedes_boundary", `${key} was appended before its worker boundary`));
    }
    for (const field of ["stage", "attempt", "attempt_kind", "budget_ms", "search_enabled", "pid"]) {
      if (finish[field] !== start[field]) pushIssue(issues, issue("worker_attempt_metadata_mismatch", `${key} differs on ${field}`));
    }
    attempts.push({
      invocation_key: key,
      stage: start.stage,
      attempt: start.attempt,
      attempt_kind: start.attempt_kind,
      budget_ms: Number.isFinite(start.budget_ms) ? Math.max(0, Math.floor(start.budget_ms)) : null,
      search_enabled: start.search_enabled === true,
      pid: Number.isInteger(start.pid) && start.pid > 0 ? start.pid : null,
      started_at: start.started_at,
      finished_at: finish.finished_at,
      elapsed_ms: elapsed,
      outcome: String(finish.outcome || "unknown"),
      timed_out: finish.timed_out === true,
      forced_settle: finish.forced_settle === true,
      duration_scope: "local_child_spawn_to_settlement_wall_time",
    });
  }
  return attempts.sort((left, right) => time(left.started_at) - time(right.started_at)
    || left.invocation_key.localeCompare(right.invocation_key));
}

function validateTopology(attempts, barriers, order, totalStart, totalFinish, issues, complete) {
  const contentOrder = order.filter((stage) => WORKER_STAGES.includes(stage));
  for (const attempt of attempts) {
    const index = contentOrder.indexOf(attempt.stage);
    if (index < 0) {
      pushIssue(issues, issue(
        "stage_topology_invalid",
        `${attempt.invocation_key} uses ${attempt.stage} outside the declared topology`,
      ));
      continue;
    }
    const previousStage = contentOrder[index - 1];
    const lowerBound = previousStage ? time(barriers[previousStage]?.at) : totalStart;
    const ownBarrier = time(barriers[attempt.stage]?.at);
    const started = time(attempt.started_at);
    const finished = time(attempt.finished_at);
    if (lowerBound !== null && started !== null && started < lowerBound) {
      pushIssue(issues, issue(
        "stage_topology_invalid",
        `${attempt.invocation_key} starts before the ${previousStage || "run"} barrier`,
      ));
    }
    if (ownBarrier !== null && finished !== null && finished > ownBarrier) {
      pushIssue(issues, issue("stage_topology_invalid", `${attempt.invocation_key} finishes after its ${attempt.stage} barrier`));
    }
  }
  if (complete) {
    for (const stage of contentOrder) {
      if (!barriers[stage]) pushIssue(issues, issue("stage_topology_invalid", `complete run is missing the ${stage} barrier`));
    }
    if (totalFinish < totalStart) pushIssue(issues, issue("run_timing_invalid", "run completion precedes run start"));
  }
}

function unionLength(intervals) {
  const sorted = intervals
    .filter(([start, finish]) => Number.isFinite(start) && Number.isFinite(finish) && finish >= start)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  if (!sorted.length) return 0;
  let total = 0;
  let [start, finish] = sorted[0];
  for (const [nextStart, nextFinish] of sorted.slice(1)) {
    if (nextStart <= finish) finish = Math.max(finish, nextFinish);
    else {
      total += finish - start;
      start = nextStart;
      finish = nextFinish;
    }
  }
  return total + finish - start;
}

function criticalAttempt(attempts) {
  const duration = (attempt) => Number.isFinite(attempt.elapsed_ms) ? attempt.elapsed_ms : -1;
  return [...attempts].sort((left, right) => duration(right) - duration(left)
    || left.invocation_key.localeCompare(right.invocation_key))[0] || null;
}

function buildStages({ attempts, barriers, order, totalStart, totalFinish, truncated }) {
  const stages = [];
  const intervals = [];
  const firstAttemptStart = Math.min(...attempts.map((attempt) => time(attempt.started_at)).filter(Number.isFinite));
  const queueFinish = Number.isFinite(firstAttemptStart) ? firstAttemptStart : totalFinish;
  stages.push({
    stage: "queue_and_grounding",
    started_at: iso(totalStart),
    barrier_completed_at: iso(queueFinish),
    elapsed_ms: Math.max(0, queueFinish - totalStart),
    worker_attempt_count: 0,
    worker_elapsed_ms_sum: 0,
    worker_critical_elapsed_ms: 0,
    critical_invocation_key: null,
  });
  intervals.push([totalStart, queueFinish]);

  for (const stageName of order.filter((stage) => WORKER_STAGES.includes(stage))) {
    const workers = attempts.filter((attempt) => attempt.stage === stageName);
    if (!workers.length && !barriers[stageName]) continue;
    const starts = workers.map((attempt) => time(attempt.started_at)).filter(Number.isFinite);
    const stageStart = starts.length ? Math.min(...starts) : totalStart;
    const barrierTime = time(barriers[stageName]?.at);
    const stageFinish = barrierTime ?? (truncated && workers.length ? totalFinish : stageStart);
    const critical = criticalAttempt(workers);
    stages.push({
      stage: stageName,
      started_at: iso(stageStart),
      barrier_completed_at: barrierTime === null ? null : iso(stageFinish),
      elapsed_ms: Math.max(0, stageFinish - stageStart),
      worker_attempt_count: workers.length,
      worker_elapsed_ms_sum: workers.reduce((sum, attempt) => sum + Math.max(0, attempt.elapsed_ms || 0), 0),
      worker_critical_elapsed_ms: Math.max(0, critical?.elapsed_ms || 0),
      critical_invocation_key: critical?.invocation_key || null,
    });
    intervals.push([stageStart, stageFinish]);
  }

  const lastWorkerFinish = Math.max(totalStart, ...attempts.map((attempt) => time(attempt.finished_at)).filter(Number.isFinite));
  stages.push({
    stage: "terminal_persistence",
    started_at: iso(lastWorkerFinish),
    barrier_completed_at: iso(totalFinish),
    elapsed_ms: Math.max(0, totalFinish - lastWorkerFinish),
    worker_attempt_count: 0,
    worker_elapsed_ms_sum: 0,
    worker_critical_elapsed_ms: 0,
    critical_invocation_key: null,
  });
  intervals.push([lastWorkerFinish, totalFinish]);
  return { stages, intervals };
}

function frontierAndMissing(attempts, order) {
  const content = order.filter((stage) => WORKER_STAGES.includes(stage));
  let frontierIndex = -1;
  for (const attempt of attempts) frontierIndex = Math.max(frontierIndex, content.indexOf(attempt.stage));
  const frontier = frontierIndex >= 0 ? content[frontierIndex] : "queue_and_grounding";
  return { frontier, missing: content.slice(frontierIndex + 1) };
}

/** Derive a deterministic timing ledger only from persisted status/evidence/event bytes. */
export function deriveTimingLedger({ status, evidence, events } = {}) {
  const safeStatus = status && typeof status === "object" ? status : {};
  const safeEvidence = evidence && typeof evidence === "object" ? evidence : {};
  const safeEvents = Array.isArray(events) ? events : [];
  const issues = [];
  validateEventChain(safeEvents, issues);
  const attempts = attemptPairs(safeEvents, issues);
  const councilMode = (safeEvidence.council_mode || safeStatus.council_mode) === "quick" ? "quick" : "full";
  const required = councilMode === "quick" ? false : verificationRequired(safeStatus, safeEvidence);
  const order = topologyOrder(required, councilMode);
  const barriers = barrierEvents(safeEvents);
  const runStatus = terminalStatus(safeStatus, safeEvidence);
  const terminalDeclared = TERMINAL_STATUSES.has(runStatus);
  const totalStart = time(safeStatus.started_at || safeEvidence.started_at);
  const totalFinish = time(safeStatus.completed_at || safeEvidence.completed_at);
  if (totalStart === null
    || (terminalDeclared && totalFinish === null)
    || (totalStart !== null && totalFinish !== null && totalFinish < totalStart)) {
    pushIssue(issues, issue("run_timing_invalid", "status/evidence do not contain a valid nonnegative run interval"));
  }
  const safeStart = totalStart ?? 0;
  const observedTail = Math.max(
    safeStart,
    ...safeEvents.map((event) => time(event?.at)).filter(Number.isFinite),
    ...attempts.map((attempt) => time(attempt.finished_at)).filter(Number.isFinite),
  );
  const safeFinish = totalFinish ?? observedTail;
  const complete = runStatus === "complete";
  const executionMode = safeStatus.execution_mode || safeEvidence.execution_mode;
  const visible = executionMode === "visible_host_threads";
  const currentHeadless = executionMode === "background_codex_exec";
  const terminalEvent = [...safeEvents].reverse().find((event) => TERMINAL_EVENT_TYPES.has(event?.type));
  if (currentHeadless && attempts.length > 0 && terminalDeclared && totalFinish !== null && !terminalEvent) {
    pushIssue(issues, issue(
      "terminal_event_missing",
      `terminal ${runStatus} run has worker attempts but no explicit terminal event`,
    ));
  }
  validateTopology(attempts, barriers, order, safeStart, safeFinish, issues, complete && attempts.length > 0);

  let coverageStatus;
  if (issues.length) coverageStatus = "structural_invalid";
  else if (visible) coverageStatus = "not_evaluable";
  else if (!terminalDeclared) coverageStatus = "not_evaluable";
  else if (!attempts.length) coverageStatus = "legacy_stage_only";
  else if (complete) coverageStatus = "observed_process_boundary";
  else coverageStatus = "truncated";

  const { frontier, missing } = frontierAndMissing(attempts, order);
  const stageData = attempts.length && ["observed_process_boundary", "truncated"].includes(coverageStatus)
    ? buildStages({ attempts, barriers, order, totalStart: safeStart, totalFinish: safeFinish, truncated: !complete })
    : { stages: [], intervals: [] };
  const totalElapsed = Math.max(0, safeFinish - safeStart);
  const classified = Math.min(totalElapsed, unionLength(stageData.intervals));
  const topologyStatus = issues.length
    ? "invalid"
    : coverageStatus === "truncated" ? "valid_truncated" : "valid";
  return {
    schema: "alphacouncil_timing_ledger_v1",
    schema_version: 1,
    run_id: safeStatus.run_id || safeEvidence.run_id || null,
    duration_scope: "local_child_spawn_to_settlement_wall_time",
    marketing_eligible: false,
    coverage: {
      status: coverageStatus,
      ...(visible ? { reason: "visible_host_timing_not_observed" } : {}),
      ...(!visible && coverageStatus === "not_evaluable" ? { reason: "run_not_terminal" } : {}),
    },
    topology: {
      status: topologyStatus,
      stage_order: order,
      verification_required: required,
      ...(coverageStatus === "truncated" ? { frontier, missing_stages: missing } : {}),
    },
    total: {
      started_at: iso(safeStart),
      finished_at: iso(safeFinish),
      elapsed_ms: totalElapsed,
    },
    classified_interval_union_ms: classified,
    unattributed_ms: Math.max(0, totalElapsed - classified),
    critical_path: {
      elapsed_ms: classified,
      invocation_keys: stageData.stages.map((stage) => stage.critical_invocation_key).filter(Boolean),
    },
    attempts,
    stages: stageData.stages,
    issues,
    anchors: {
      event_tail_hash: safeEvents.at(-1)?.event_hash || null,
      status_sha256: canonicalDigest(safeStatus),
      evidence_sha256: canonicalDigest(safeEvidence),
    },
  };
}

export function stableTimingJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
