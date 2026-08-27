import { test } from "node:test";
import assert from "node:assert/strict";

import { COUNCIL_PACES, LIMITS } from "../../mcp/lib/constants.mjs";
import {
  parseRepairBudget,
  stageAttemptWindow,
  stageLifecycleRemainingMs,
  stagePrimaryAttemptBudget,
} from "../../mcp/lib/orchestrator.mjs";

const NOW = Date.parse("2026-08-03T08:00:00.000Z");

function fullRun(pace, { totalMs = COUNCIL_PACES[pace].total_ms, deadlineMs = totalMs } = {}) {
  return {
    council_mode: "full",
    council_pace: pace,
    time_budget_ms: totalMs,
    deadline_at: new Date(NOW + deadlineMs).toISOString(),
  };
}

test("parse repair budgets scale across every fast, normal and slow stage", () => {
  const expected = {
    // Derived from each stage cap, so this table moves with the tiers. It was last recomputed
    // when fast and normal were rebalanced onto their measured stage floors.
    fast: { evidence_ms: 160_000, master_ms: 63_333, debate_ms: 56_666, pm_ms: 60_000 },
    normal: { evidence_ms: 240_000, master_ms: 120_000, debate_ms: 120_000, pm_ms: 120_000 },
    slow: { evidence_ms: 240_000, master_ms: 170_000, debate_ms: 240_000, pm_ms: 240_000 },
  };
  for (const [pace, stages] of Object.entries(expected)) {
    const run = fullRun(pace);
    for (const [stage, budget] of Object.entries(stages)) {
      assert.equal(parseRepairBudget(run, {
        stageBudgetMs: COUNCIL_PACES[pace][stage],
        stageStartedAtMs: NOW,
        nowMs: NOW,
      }), budget, `${pace}.${stage}`);
    }
  }
});

test("quick repair budgets stay inside quick stage caps and the outer hard deadline", () => {
  const run = {
    council_mode: "quick",
    council_pace: null,
    time_budget_ms: LIMITS.QUICK_HARD_MAX_MS,
    deadline_at: new Date(NOW + LIMITS.QUICK_HARD_MAX_MS).toISOString(),
  };
  assert.equal(parseRepairBudget(run, {
    stageBudgetMs: LIMITS.QUICK_EVIDENCE_MS,
    stageStartedAtMs: NOW,
    nowMs: NOW,
  }), 140_000);
  for (const stageBudgetMs of [LIMITS.QUICK_MASTER_MS, LIMITS.QUICK_SYNTHESIS_MS]) {
    assert.equal(parseRepairBudget(run, { stageBudgetMs, stageStartedAtMs: NOW, nowMs: NOW }), 60_000);
  }

  assert.equal(parseRepairBudget(run, {
    stageBudgetMs: LIMITS.QUICK_EVIDENCE_MS,
    stageStartedAtMs: NOW + 500_000,
    nowMs: NOW + 500_000,
  }), 75_000, "20s finalize reserve and 5s kill grace remain outside the repair");
  assert.equal(parseRepairBudget(run, {
    stageBudgetMs: LIMITS.QUICK_EVIDENCE_MS,
    stageStartedAtMs: NOW + 575_000,
    nowMs: NOW + 575_000,
  }), 0, "repair cannot cross the quick outer deadline reserve");
});

test("stage elapsed time and a lowered total deadline both reduce the repair budget", () => {
  const normal = fullRun("normal");
  assert.equal(parseRepairBudget(normal, {
    stageBudgetMs: COUNCIL_PACES.normal.evidence_ms,
    stageStartedAtMs: NOW - 350_000,
    nowMs: NOW,
  }), 10_000, "repair cannot borrow beyond its evidence stage");

  const slowWithLoweredTotal = fullRun("slow", { totalMs: 100_000, deadlineMs: 100_000 });
  assert.equal(parseRepairBudget(slowWithLoweredTotal, {
    stageBudgetMs: COUNCIL_PACES.slow.evidence_ms,
    stageStartedAtMs: NOW,
    nowMs: NOW,
  }), 88_000, "10% finalize reserve plus scaled 2s kill grace remain outside the repair");
  assert.equal(parseRepairBudget(fullRun("normal", { deadlineMs: 49_999 }), {
    stageBudgetMs: COUNCIL_PACES.normal.evidence_ms,
    stageStartedAtMs: NOW,
    nowMs: NOW,
  }), 0);
});

test("fast primary, retry and repair share one immutable stage lifecycle", () => {
  const run = fullRun("fast");
  const expectedPrimary = {
    evidence: 220_000,
    methods: 87_000,
    debate_round_1: 70_000,
    portfolio_manager: 75_000,
  };
  const stageCaps = {
    evidence: COUNCIL_PACES.fast.evidence_ms,
    methods: COUNCIL_PACES.fast.master_ms,
    debate_round_1: COUNCIL_PACES.fast.debate_ms,
    portfolio_manager: COUNCIL_PACES.fast.pm_ms,
  };

  for (const [stage, primaryMs] of Object.entries(expectedPrimary)) {
    const stageCapMs = stageCaps[stage];
    assert.equal(stagePrimaryAttemptBudget(run, stage, stageCapMs), primaryMs, stage);
    const retryMs = stageLifecycleRemainingMs(stageCapMs, NOW, NOW + primaryMs);
    assert.equal(primaryMs + retryMs, stageCapMs, `${stage} retry cannot double its lifecycle`);
    assert.equal(stageLifecycleRemainingMs(stageCapMs, NOW, NOW + stageCapMs + 1), 0);
  }
});

test("non-fast and explicitly non-retrying callers retain their existing primary cap", () => {
  const normal = fullRun("normal");
  assert.equal(
    stagePrimaryAttemptBudget(normal, "evidence", COUNCIL_PACES.normal.evidence_ms),
    COUNCIL_PACES.normal.evidence_ms,
  );
  const fast = fullRun("fast");
  assert.equal(
    stagePrimaryAttemptBudget(fast, "methods", COUNCIL_PACES.fast.master_ms, { reserveRepair: false }),
    COUNCIL_PACES.fast.master_ms,
  );
  assert.equal(stagePrimaryAttemptBudget(fast, "methods", 8_500), 8_500, "tiny caller cap is not erased");
});

test("attempt timers reserve settlement grace against one absolute lifecycle deadline", () => {
  const run = fullRun("fast");
  const primary = stageAttemptWindow(run, {
    stageBudgetMs: COUNCIL_PACES.fast.evidence_ms,
    stageStartedAtMs: NOW,
    requestedMs: 220_000,
    nowMs: NOW,
  });
  assert.deepEqual(primary, {
    absolute_deadline_ms: NOW + 220_000,
    lifecycle_remaining_ms: 240_000,
    settlement_grace_ms: 5_000,
    timeout_ms: 215_000,
  });

  const retry = stageAttemptWindow(run, {
    stageBudgetMs: COUNCIL_PACES.fast.evidence_ms,
    stageStartedAtMs: NOW,
    requestedMs: 20_000,
    nowMs: NOW + 220_000,
  });
  assert.equal(retry.absolute_deadline_ms, NOW + COUNCIL_PACES.fast.evidence_ms);
  assert.equal(retry.timeout_ms + retry.settlement_grace_ms, 20_000);
  assert.equal(retry.absolute_deadline_ms - NOW, COUNCIL_PACES.fast.evidence_ms);

  const callerLowered = stageAttemptWindow(run, {
    stageBudgetMs: 5_000,
    stageStartedAtMs: NOW,
    requestedMs: 5_000,
    nowMs: NOW,
  });
  assert.deepEqual(callerLowered, {
    absolute_deadline_ms: NOW + 5_000,
    lifecycle_remaining_ms: 5_000,
    settlement_grace_ms: 1_000,
    timeout_ms: 4_000,
  });
});
