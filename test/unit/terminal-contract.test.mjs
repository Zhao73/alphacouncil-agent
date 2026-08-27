import { test } from "node:test";
import assert from "node:assert/strict";

import { COUNCIL_PACES, COUNCIL_PACE_STAGE_TOTAL, LIMITS } from "../../mcp/lib/constants.mjs";
import {
  applyTerminalContract,
  budgetAheadDecision,
  contractStageTotalMs,
  terminalContractState,
} from "../../mcp/lib/orchestrator.mjs";
import { finalReportMarkdown, terminalContractHeader } from "../../mcp/lib/markdown.mjs";
import { statusSnapshot } from "../../mcp/lib/run-store.mjs";

function debateRounds(count) {
  return Array.from({ length: count }, (_, index) => ({
    round: index + 1,
    bull: { summary: `bull ${index + 1}` },
    bear: { summary: `bear ${index + 1}` },
  }));
}

function completeRun(overrides = {}) {
  const run = {
    run_id: "TERMINAL-CONTRACT-FIXTURE",
    symbol: "QQQ",
    as_of: "2026-08-27",
    language: "English",
    execution_mode: "background_codex_exec",
    council_mode: "full",
    council_pace: "normal",
    debate_format: "three_round_cross_exam_parallel_per_round",
    entry_tool: "analyze_symbol",
    decision_requested: true,
    deadline_enforced: true,
    time_budget_ms: COUNCIL_PACES.normal.total_ms,
    started_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:10:00.000Z",
    completed_at: "2026-08-27T00:10:00.000Z",
    deadline_at: "2026-08-27T00:30:00.000Z",
    status: "complete",
    phase: "complete",
    tasks: ["market_data"],
    task_status: { market_data: { task: "market_data", status: "completed" } },
    packets: [{ task: "market_data", summary: "contract-valid packet", sources: [] }],
    masters: ["master_buffett"],
    master_selection: { status: "consumed" },
    master_status: {
      master_buffett: {
        master: "master_buffett",
        status: "completed",
        voice_status: "model_voice",
      },
    },
    master_opinions: [{
      master: "master_buffett",
      stance: "cautious",
      voice_status: "model_voice",
      voice_statement: "I would wait for a wider margin of safety.",
    }],
    agent_status: {
      bull_researcher: { role: "bull_researcher", status: "completed" },
      bear_researcher: { role: "bear_researcher", status: "completed" },
      portfolio_manager: { role: "portfolio_manager", status: "completed" },
    },
    verifier_verdicts: [],
    grounding: { instrument: { asset_type: "etf", research_model: "fund_lookthrough" } },
    report_quality: { status: "passed", missing: [] },
    ...overrides,
  };
  return run;
}

function completeManager(rounds = 3) {
  return {
    decision_available: true,
    rating: "Hold",
    winner: "balanced",
    debate_rounds: debateRounds(rounds),
    report_markdown: "# QQQ report",
  };
}

test("full_v2 terminal contract is complete only with every structural stage", () => {
  const state = terminalContractState(completeRun(), { manager: completeManager() });
  assert.equal(state.terminal, "complete");
  assert.equal(state.contract, "full_v2");
  assert.equal(state.debate_rounds_required, 3);
  assert.equal(state.debate_rounds_completed, 3);
  assert.deepEqual(state.missing, []);
  assert.deepEqual(state.notes, []);
});

test("every structural gap is incomplete and carries a concrete missing entry", () => {
  const fixtures = [
    {
      label: "evidence",
      run: completeRun({
        task_status: { market_data: { task: "market_data", status: "failed", error: "schema_mismatch" } },
        packets: [],
      }),
      manager: completeManager(),
      stage: "evidence",
    },
    {
      label: "method stance",
      run: completeRun({ master_opinions: [{ master: "master_buffett", voice_status: "model_voice" }] }),
      manager: completeManager(),
      stage: "methods",
    },
    {
      label: "method voice",
      run: completeRun({
        master_opinions: [{ master: "master_buffett", stance: "cautious", voice_status: "voice_contract_failure" }],
      }),
      manager: completeManager(),
      stage: "methods",
    },
    {
      label: "debate rounds",
      run: completeRun(),
      manager: completeManager(2),
      stage: "debate",
    },
    {
      label: "degraded debate side is still a structural gap",
      run: completeRun({
        agent_status: {
          bull_researcher: { role: "bull_researcher", status: "degraded", error: "timeout" },
          bear_researcher: { role: "bear_researcher", status: "completed" },
          portfolio_manager: { role: "portfolio_manager", status: "completed" },
        },
      }),
      manager: completeManager(),
      stage: "debate",
    },
    {
      label: "verification",
      run: completeRun({
        packets: [{
          task: "market_data",
          summary: "packet with an unresolved claim source",
          claims: [{ claim: "claim", source_ids: ["missing-source"] }],
          sources: [],
        }],
      }),
      manager: completeManager(),
      stage: "verification",
    },
    {
      label: "portfolio manager",
      run: completeRun({
        agent_status: {
          bull_researcher: { role: "bull_researcher", status: "completed" },
          bear_researcher: { role: "bear_researcher", status: "completed" },
          portfolio_manager: { role: "portfolio_manager", status: "skipped", error: "evidence_gate_failed" },
        },
      }),
      manager: { ...completeManager(), decision_available: false, rating: null },
      stage: "portfolio_manager",
    },
    {
      label: "report sections",
      run: completeRun({ report_quality: { status: "needs_revision", missing: ["missing section: risks"] } }),
      manager: completeManager(),
      stage: "report",
    },
  ];

  for (const fixture of fixtures) {
    const state = terminalContractState(fixture.run, { manager: fixture.manager });
    assert.equal(state.terminal, "incomplete", fixture.label);
    assert.ok(state.missing.length > 0, fixture.label);
    assert.ok(state.missing.some((item) => item.stage === fixture.stage), fixture.label);
  }
});

test("substitute execution is degraded only when no structural gap exists", () => {
  const run = completeRun({
    master_status: {
      master_buffett: { master: "master_buffett", status: "completed", voice_status: "deterministic_fallback" },
    },
    master_opinions: [{
      master: "master_buffett",
      stance: "cautious",
      voice_status: "deterministic_fallback",
      voice_statement: "Deterministic fallback statement.",
    }],
  });
  const degraded = terminalContractState(run, { manager: completeManager() });
  assert.equal(degraded.terminal, "degraded");
  assert.deepEqual(degraded.missing, []);
  assert.ok(degraded.notes.some((note) => note.reason === "deterministic_fallback"));

  run.task_status.market_data = { task: "market_data", status: "failed", error: "timeout" };
  run.packets = [];
  const incomplete = terminalContractState(run, { manager: completeManager() });
  assert.equal(incomplete.terminal, "incomplete");
  assert.ok(incomplete.missing.length > 0);
});

test("portfolio-manager absence reasons are exact and suppress every directional decision", () => {
  const fixtures = [
    ["not_started_global_deadline", "skipped", "budget_exhausted_ahead"],
    ["skipped_upstream_gate", "skipped", "evidence_gate_failed"],
    ["failed", "failed", "output_schema_rejected"],
  ];
  for (const [expected, status, error] of fixtures) {
    const run = completeRun({
      agent_status: {
        bull_researcher: { role: "bull_researcher", status: "completed" },
        bear_researcher: { role: "bear_researcher", status: "completed" },
        portfolio_manager: { role: "portfolio_manager", status, error },
      },
    });
    const manager = completeManager();
    const state = applyTerminalContract(run, { manager });
    assert.equal(state.stage_outcomes.portfolio_manager.absence_reason, expected);
    assert.equal(manager.pm_absence_reason, expected);
    assert.equal(manager.decision_available, false);
    assert.equal(manager.rating, null);
  }
});

test("budget-ahead reservations use only existing pace fields and terminate before the cap", () => {
  const run = completeRun({
    council_pace: "slow",
    time_budget_ms: COUNCIL_PACES.slow.total_ms,
    deadline_at: "2026-08-27T01:00:00.000Z",
    masters: Array.from({ length: 26 }, (_, index) => `master_${index + 1}`),
  });
  const profile = COUNCIL_PACES.slow;
  const beforeMethods = (profile.master_ms * profile.master_waves)
    + profile.verifier_ms
    + (3 * profile.debate_ms)
    + profile.pm_ms
    + profile.finalize_reserve_ms;
  const elapsed = profile.total_ms - beforeMethods + 1;
  let clockReads = 0;
  const decision = budgetAheadDecision(run, {
    checkpoint: "before_methods",
    clock: { now: () => {
      clockReads += 1;
      return Date.parse(run.started_at) + elapsed;
    } },
    remainingMasterWaves: profile.master_waves,
    verifierStageApplies: true,
  });
  assert.equal(clockReads, 1);
  assert.equal(decision.terminate, true);
  assert.equal(decision.reason, "budget_exhausted_ahead");
  assert.equal(decision.reservation_ms, beforeMethods);
  assert.equal(decision.remaining_ms, beforeMethods - 1);
  assert.ok(Date.parse(decision.terminated_at) < Date.parse(decision.cap_at));
  assert.equal(run.budget_ahead.applicability, "applicable");
  assert.equal(run.budget_ahead.total_ms, run.time_budget_ms);
  assert.equal(run.budget_ahead.stage_total_ms, COUNCIL_PACE_STAGE_TOTAL(profile));
  assert.equal(run.budget_ahead.termination, null);
  assert.deepEqual(run.budget_ahead.checkpoints[0], {
    checkpoint: "before_methods",
    at: decision.terminated_at,
    remaining_ms: beforeMethods - 1,
    reservation_ms: beforeMethods,
    terminate: true,
  });

  for (const round of [2, 3]) {
    const reservation = ((3 - round + 1) * profile.debate_ms)
      + profile.pm_ms
      + profile.finalize_reserve_ms;
    const probe = budgetAheadDecision(run, {
      checkpoint: `before_debate_round_${round}`,
      round,
      nowMs: Date.parse(run.started_at) + profile.total_ms - reservation + 1,
    });
    assert.equal(probe.terminate, true, `round ${round}`);
    assert.equal(probe.reservation_ms, reservation, `round ${round}`);
  }

  const beforePm = profile.pm_ms + profile.finalize_reserve_ms;
  const pm = budgetAheadDecision(run, {
    checkpoint: "before_pm",
    nowMs: Date.parse(run.started_at) + profile.total_ms - beforePm + 1,
  });
  assert.equal(pm.terminate, true);
  assert.equal(pm.reservation_ms, beforePm);
});

test("contract stage totals are finite and respect each report contract's debate depth", () => {
  for (const [pace, profile] of Object.entries(COUNCIL_PACES)) {
    const run = completeRun({ council_pace: pace, time_budget_ms: profile.total_ms });
    assert.equal(contractStageTotalMs(run), COUNCIL_PACE_STAGE_TOTAL(profile), pace);
    assert.equal(Number.isFinite(contractStageTotalMs(run)), true, pace);
  }

  const quick = completeRun({
    council_mode: "quick",
    council_pace: null,
    debate_format: "single_round_parallel",
    time_budget_ms: LIMITS.QUICK_TOTAL_MS,
  });
  const expected = LIMITS.QUICK_GROUNDING_MS
    + LIMITS.QUICK_EVIDENCE_MS
    + LIMITS.QUICK_MASTER_MS
    + LIMITS.QUICK_SYNTHESIS_MS
    + LIMITS.QUICK_SYNTHESIS_MS
    + LIMITS.QUICK_FINALIZE_RESERVE_MS;
  assert.equal(contractStageTotalMs(quick), expected);
  assert.equal(Number.isFinite(contractStageTotalMs(quick)), true);
});

test("budget-ahead binds to a reduced real budget and records non-representable budgets without terminating", () => {
  const profile = COUNCIL_PACES.slow;
  const startedMs = Date.parse("2026-08-27T00:00:00.000Z");
  const stageTotalMs = COUNCIL_PACE_STAGE_TOTAL(profile);
  const representableTotalMs = Math.floor((stageTotalMs + profile.total_ms) / 2);
  const representable = completeRun({
    council_pace: "slow",
    time_budget_ms: representableTotalMs,
    deadline_at: new Date(startedMs + representableTotalMs).toISOString(),
    masters: Array.from({ length: 26 }, (_, index) => `master_${index + 1}`),
  });
  const reservation = (profile.master_ms * profile.master_waves)
    + profile.verifier_ms
    + (3 * profile.debate_ms)
    + profile.pm_ms
    + profile.finalize_reserve_ms;
  const applicable = budgetAheadDecision(representable, {
    checkpoint: "before_methods",
    remainingMasterWaves: profile.master_waves,
    verifierStageApplies: true,
    nowMs: startedMs + representableTotalMs - reservation + 1,
  });
  assert.equal(applicable.terminate, true);
  assert.equal(applicable.remaining_ms, reservation - 1);
  assert.equal(applicable.cap_at, representable.deadline_at);
  assert.equal(representable.budget_ahead.total_ms, representableTotalMs);
  assert.equal(representable.budget_ahead.applicability, "applicable");

  const reducedTotalMs = Math.floor(profile.total_ms / 2);
  const reduced = completeRun({
    council_pace: "slow",
    time_budget_ms: reducedTotalMs,
    deadline_at: new Date(startedMs + reducedTotalMs).toISOString(),
    masters: Array.from({ length: 26 }, (_, index) => `master_${index + 1}`),
  });
  const skipped = budgetAheadDecision(reduced, {
    checkpoint: "before_methods",
    remainingMasterWaves: profile.master_waves,
    verifierStageApplies: true,
    nowMs: startedMs,
  });
  assert.equal(skipped.terminate, false);
  assert.equal(skipped.reason, null);
  assert.equal(reduced.budget_ahead.applicability, "reduced_budget_reservation_not_representable");
  assert.equal(reduced.budget_ahead.total_ms, reducedTotalMs);
  assert.equal(reduced.budget_ahead.stage_total_ms, stageTotalMs);
  assert.equal(reduced.budget_ahead.cap_at, reduced.deadline_at);
  assert.equal(reduced.budget_ahead.termination, null);
  assert.equal(reduced.budget_ahead.checkpoints.length, 1);
  assert.deepEqual(statusSnapshot(reduced).budget_ahead, reduced.budget_ahead);
});

test("quick_v1 is complete after its one required round and its header never claims full-v2 depth", () => {
  const run = completeRun({
    council_mode: "quick",
    council_pace: null,
    debate_format: "single_round_parallel",
    time_budget_ms: LIMITS.QUICK_TOTAL_MS,
    deadline_at: new Date(Date.parse("2026-08-27T00:00:00.000Z") + LIMITS.QUICK_TOTAL_MS).toISOString(),
  });
  const state = applyTerminalContract(run, { manager: completeManager(1) });
  assert.equal(state.terminal, "complete");
  assert.equal(state.contract, "quick_v1");
  assert.equal(state.debate_rounds_required, 1);
  assert.equal(state.debate_rounds_completed, 1);
  assert.equal(state.full_council_equivalent, false);

  const header = terminalContractHeader(run);
  assert.match(header, /contract: `quick_v1`/u);
  assert.match(header, /full_council_equivalent=false/u);
  assert.doesNotMatch(header, /three rounds|三轮|full council/iu);

  const report = finalReportMarkdown(run, completeManager(1));
  assert.ok(report.startsWith("<!-- alphacouncil:terminal-contract:v1:begin -->"));
  assert.match(report, /contract: `quick_v1`/u);
  assert.doesNotMatch(report, /three rounds|三轮|full council/iu);
});

test("terminal projection and the system-owned report header are idempotent", () => {
  const run = completeRun();
  const manager = completeManager();
  applyTerminalContract(run, { manager });
  const firstState = JSON.stringify({
    terminal: run.terminal,
    contract: run.contract,
    missing: run.missing,
    notes: run.notes,
    stage_outcomes: run.stage_outcomes,
  });
  applyTerminalContract(run, { manager });
  assert.equal(JSON.stringify({
    terminal: run.terminal,
    contract: run.contract,
    missing: run.missing,
    notes: run.notes,
    stage_outcomes: run.stage_outcomes,
  }), firstState);

  const firstReport = finalReportMarkdown(run, manager);
  const projectedReport = finalReportMarkdown(run, manager);
  assert.equal(projectedReport, firstReport);
});

test("terminal diagnostics remain visible without satisfying their own scoped-source check", () => {
  const run = completeRun({
    report_quality: {
      status: "needs_revision",
      missing: ["missing scoped source IDs such as market_data:S1"],
    },
  });
  applyTerminalContract(run, { manager: completeManager() });
  const header = terminalContractHeader(run);
  assert.match(header, /market_data&#58;S1/u);
  assert.doesNotMatch(header, /[a-z_]+:s\d+/iu);
  assert.equal(run.missing.at(-1)?.reason, "missing scoped source IDs such as market_data:S1");
});

test("status snapshot persists the terminal contract, missing ledger and stage outcomes", () => {
  const run = completeRun();
  applyTerminalContract(run, { manager: completeManager() });
  const status = statusSnapshot(run);
  assert.equal(status.terminal, "complete");
  assert.equal(status.contract, "full_v2");
  assert.equal(status.debate_rounds_required, 3);
  assert.equal(status.debate_rounds_completed, 3);
  assert.deepEqual(status.missing, []);
  assert.equal(status.stage_outcomes.portfolio_manager.status, "completed");
  assert.equal(status.stage_outcomes.finalize.status, "completed");
});
