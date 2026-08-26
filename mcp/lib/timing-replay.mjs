import { createHash } from "node:crypto";

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;
}

function issue(code, message, details) {
  return { code, message, ...(details === undefined ? {} : { details }) };
}

function positiveInteger(value, fallback = 1) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function finiteDuration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function listSchedule(attempts, concurrency, caps) {
  const slots = Array.from({ length: positiveInteger(concurrency) }, () => 0);
  const scheduled = [];
  for (const attempt of [...attempts].sort((left, right) =>
    left.invocation_key.localeCompare(right.invocation_key))) {
    let slot = 0;
    for (let index = 1; index < slots.length; index += 1) {
      if (slots[index] < slots[slot]) slot = index;
    }
    const observed = finiteDuration(attempt.elapsed_ms);
    const cap = Number.isFinite(caps) && caps >= 0 ? Math.floor(caps) : observed;
    const projected = Math.min(observed, cap);
    const projectedStart = slots[slot];
    const projectedFinish = projectedStart + projected;
    slots[slot] = projectedFinish;
    scheduled.push({
      invocation_key: attempt.invocation_key,
      stage: attempt.stage,
      attempt: attempt.attempt,
      attempt_kind: attempt.attempt_kind,
      observed_elapsed_ms: observed,
      projected_elapsed_ms: projected,
      projected_start_offset_ms: projectedStart,
      projected_finish_offset_ms: projectedFinish,
      timed_out_observation: attempt.timed_out === true,
    });
  }
  return {
    attempts: scheduled.sort((left, right) => left.invocation_key.localeCompare(right.invocation_key)),
    elapsed_ms: Math.max(0, ...slots),
  };
}

/**
 * Deterministically replay only observed worker durations under alternate concurrency/caps.
 *
 * This function has no clock, filesystem, child-process or network dependency. It does not
 * predict provider/model/content improvements. Stage projections are worker list-schedule
 * makespans and deliberately exclude observed launch stagger, barrier delay and persistence
 * overhead, so they are lower than end-to-end wall time unless those costs are added outside
 * this diagnostic.
 */
export function replayTimingLedger({ ledger, profile } = {}) {
  const safeLedger = ledger && typeof ledger === "object" ? ledger : {};
  const safeProfile = profile && typeof profile === "object" ? profile : {};
  const issues = [];
  const coverage = safeLedger.coverage?.status || "not_evaluable";
  const replayableCoverage = ["observed_process_boundary", "truncated"].includes(coverage);
  const observedAttempts = replayableCoverage && Array.isArray(safeLedger.attempts)
    ? safeLedger.attempts
    : [];
  const stageOrder = replayableCoverage && Array.isArray(safeLedger.topology?.stage_order)
    ? safeLedger.topology.stage_order
    : [];
  let status = "complete_estimate";
  let projectedTerminalStatus = "complete";

  if (!replayableCoverage) {
    status = "not_evaluable";
    projectedTerminalStatus = null;
    issues.push(issue("timing_coverage_not_replayable", `timing coverage is ${coverage}`));
  }

  const concurrencyByStage = safeProfile.max_concurrency_by_stage || {};
  const capByStage = safeProfile.timeout_cap_ms_by_stage || {};
  const stages = [];
  const projectedAttempts = [];
  let projectedTimeout = false;
  let censored = false;

  for (const stageName of stageOrder) {
    const attempts = observedAttempts.filter((attempt) => attempt.stage === stageName);
    if (!attempts.length) continue;
    const concurrency = positiveInteger(concurrencyByStage[stageName], attempts.length);
    const cap = Number.isFinite(capByStage[stageName]) && capByStage[stageName] >= 0
      ? Math.floor(capByStage[stageName])
      : Math.max(...attempts.map((attempt) => finiteDuration(attempt.budget_ms || attempt.elapsed_ms)));
    for (const attempt of attempts) {
      const observed = finiteDuration(attempt.elapsed_ms);
      if (attempt.timed_out === true && cap > observed) {
        censored = true;
        issues.push(issue(
          "observed_duration_right_censored",
          `${attempt.invocation_key} timed out at ${observed} ms; a higher cap cannot predict completion`,
        ));
      } else if (attempt.timed_out === true || observed > cap) {
        projectedTimeout = true;
      }
    }
    const scheduled = listSchedule(attempts, concurrency, cap);
    projectedAttempts.push(...scheduled.attempts);
    const observedStage = (safeLedger.stages || []).find((stage) => stage.stage === stageName) || {};
    stages.push({
      stage: stageName,
      max_concurrency: concurrency,
      timeout_cap_ms: cap,
      observed_worker_elapsed_ms: finiteDuration(observedStage.worker_critical_elapsed_ms),
      projected_elapsed_ms: scheduled.elapsed_ms,
      attempt_count: attempts.length,
    });
  }

  if (censored) {
    status = "not_evaluable_censored";
    projectedTerminalStatus = null;
  } else if (projectedTimeout) {
    status = "projected_timeout";
    projectedTerminalStatus = "incomplete";
  }

  const timingLedgerHash = digest(safeLedger);
  const profileHash = digest(safeProfile);
  return {
    schema: "alphacouncil_timing_replay_v1",
    schema_version: 1,
    status,
    projected_terminal_status: projectedTerminalStatus,
    counterfactual_estimate: true,
    marketing_eligible: false,
    duration_scope: "observed_worker_process_boundaries_only",
    assumptions: [
      "Observed worker durations are unchanged.",
      "Only configured concurrency and timeout caps change.",
      "Projected stage time excludes launch stagger, barrier delay and terminal persistence.",
    ],
    anchors: {
      event_tail_hash: safeLedger.anchors?.event_tail_hash || null,
      status_sha256: safeLedger.anchors?.status_sha256 || null,
      evidence_sha256: safeLedger.anchors?.evidence_sha256 || null,
      timing_ledger_sha256: timingLedgerHash,
      profile_sha256: profileHash,
    },
    attempts: projectedAttempts.sort((left, right) => left.invocation_key.localeCompare(right.invocation_key)),
    stages,
    issues,
  };
}
