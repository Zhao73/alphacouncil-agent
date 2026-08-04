import { test } from "node:test";
import assert from "node:assert/strict";

import { COUNCIL_PACES, LIMITS } from "../../mcp/lib/constants.mjs";
import { parseRepairBudget } from "../../mcp/lib/orchestrator.mjs";

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
    fast: { evidence_ms: 140_000, master_ms: 40_000, debate_ms: 60_000, pm_ms: 80_000 },
    normal: { evidence_ms: 240_000, master_ms: 80_000, debate_ms: 100_000, pm_ms: 120_000 },
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
