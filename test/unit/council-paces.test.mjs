import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COUNCIL_PACES,
  COUNCIL_PACE_NAMES,
  COUNCIL_PACE_STAGE_TOTAL,
  DEFAULT_COUNCIL_PACE,
  LIMITS,
  councilPaceProfile,
} from "../../mcp/lib/constants.mjs";
import {
  councilAsOf,
  debateStageTimeout,
  evidenceStageTimeout,
  masterStageTimeout,
  portfolioManagerStageTimeout,
} from "../../mcp/lib/orchestrator.mjs";
import { tools as rpcTools } from "../../mcp/lib/rpc.mjs";

/**
 * A total budget alone does not change how deep an analysis goes. What bounds each worker is its
 * per-stage cap, so raising only the total leaves an hour-long run finishing in twenty minutes
 * with forty idle, and lowering only the total starves the later stages and terminates
 * `incomplete` with the debate missing. These tests pin the property that makes a pace coherent:
 * the stages fit inside the total, and every stage moves with the tier.
 */

const STAGE_KEYS = ["grounding_ms", "evidence_ms", "master_ms", "debate_ms", "pm_ms", "finalize_reserve_ms"];

test("the three paces are the requested 15, 30 and 60 minute tiers", () => {
  assert.deepEqual(COUNCIL_PACE_NAMES, ["fast", "normal", "slow"]);
  assert.equal(COUNCIL_PACES.fast.total_ms, 15 * 60 * 1000);
  assert.equal(COUNCIL_PACES.normal.total_ms, 30 * 60 * 1000);
  assert.equal(COUNCIL_PACES.slow.total_ms, 60 * 60 * 1000);
  assert.equal(DEFAULT_COUNCIL_PACE, "normal");
});

test("fast preserves the measured primary work while reallocating its bounded retry slices", () => {
  assert.deepEqual({
    grounding_ms: COUNCIL_PACES.fast.grounding_ms,
    evidence_ms: COUNCIL_PACES.fast.evidence_ms,
    evidence_repair_reserve_ms: COUNCIL_PACES.fast.evidence_repair_reserve_ms,
    master_ms: COUNCIL_PACES.fast.master_ms,
    master_repair_reserve_ms: COUNCIL_PACES.fast.master_repair_reserve_ms,
    debate_ms: COUNCIL_PACES.fast.debate_ms,
    debate_repair_reserve_ms: COUNCIL_PACES.fast.debate_repair_reserve_ms,
    pm_ms: COUNCIL_PACES.fast.pm_ms,
    pm_repair_reserve_ms: COUNCIL_PACES.fast.pm_repair_reserve_ms,
    finalize_reserve_ms: COUNCIL_PACES.fast.finalize_reserve_ms,
  }, {
    grounding_ms: 20_000,
    evidence_ms: 240_000,
    evidence_repair_reserve_ms: 20_000,
    master_ms: 95_000,
    master_repair_reserve_ms: 8_000,
    debate_ms: 85_000,
    debate_repair_reserve_ms: 15_000,
    pm_ms: 90_000,
    pm_repair_reserve_ms: 15_000,
    finalize_reserve_ms: 15_000,
  });
  assert.equal(COUNCIL_PACE_STAGE_TOTAL(COUNCIL_PACES.fast), 810_000);
});

test("every pace's stages fit inside its own budget", () => {
  // A pace whose stages overrun its total is a pace that always terminates incomplete. Serial
  // worst case: grounding, the evidence wave, the method wave, three debate rounds, the PM and
  // persistence. Bull and bear share a round, so three rounds cost 3x debate_ms rather than 6x.
  for (const name of COUNCIL_PACE_NAMES) {
    const profile = COUNCIL_PACES[name];
    const stages = COUNCIL_PACE_STAGE_TOTAL(profile);
    assert.ok(stages < profile.total_ms, `${name}: stages ${stages}ms do not fit in ${profile.total_ms}ms`);
    // Headroom for queueing, retries and the bounded parse repair, not a rounding accident.
    assert.ok(profile.total_ms - stages >= 90_000, `${name}: only ${profile.total_ms - stages}ms of headroom`);
  }
});

test("a slower pace raises every stage cap, never just the total", () => {
  // This is the whole point of the tier. If a stage did not move, the extra budget would buy
  // idle time instead of depth.
  for (const key of STAGE_KEYS) {
    assert.ok(COUNCIL_PACES.fast[key] <= COUNCIL_PACES.normal[key], `${key} fast>normal`);
    assert.ok(COUNCIL_PACES.normal[key] <= COUNCIL_PACES.slow[key], `${key} normal>slow`);
  }
  // The two stages that carry the reasoning must actually widen, not merely not-shrink.
  assert.ok(COUNCIL_PACES.slow.debate_ms >= 2 * COUNCIL_PACES.normal.debate_ms);
  assert.ok(COUNCIL_PACES.slow.evidence_ms >= 2 * COUNCIL_PACES.normal.evidence_ms);
  assert.ok(COUNCIL_PACES.fast.debate_ms < COUNCIL_PACES.normal.debate_ms);
  assert.ok(COUNCIL_PACES.fast.evidence_ms < COUNCIL_PACES.normal.evidence_ms);
});

test("the schema ceiling is the slowest pace, and quick stays below all of them", () => {
  assert.equal(LIMITS.FULL_HARD_MAX_MS, COUNCIL_PACES.slow.total_ms);
  assert.ok(LIMITS.QUICK_HARD_MAX_MS < COUNCIL_PACES.fast.total_ms,
    "quick must stay strictly cheaper than the fast full council");
});

test("an unknown or absent pace resolves to the default rather than throwing", () => {
  // A pace arrives from a host argument. An unrecognised one must degrade to the documented
  // default, because failing a whole council over a spelling is worse than running it at 30.
  for (const value of [undefined, null, "", "glacial", 7, {}]) {
    assert.equal(councilPaceProfile(value).pace, DEFAULT_COUNCIL_PACE);
  }
  assert.equal(councilPaceProfile("SLOW").pace, "slow", "the name is case-insensitive");
  assert.equal(councilPaceProfile("fast").pace, "fast");
});

test("an operator override only ever lowers a pace, and is absent by default", () => {
  // This constant used to double as the default budget with a hard 30-minute clamp, which
  // silently held the 60-minute pace to 30.
  assert.equal(LIMITS.FULL_TOTAL_OVERRIDE_MS, null,
    "no ALPHACOUNCIL_FULL_TOTAL_MS is set in this environment, so there is no cap");
  for (const name of COUNCIL_PACE_NAMES) {
    const profile = COUNCIL_PACES[name];
    const effective = Math.min(profile.total_ms, LIMITS.FULL_TOTAL_OVERRIDE_MS ?? profile.total_ms);
    assert.equal(effective, profile.total_ms, `${name} must default to its own total`);
  }
});

test("omitting legacy worker timeouts preserves every slow stage cap", () => {
  const run = { council_mode: "full", council_pace: "slow" };
  assert.equal(evidenceStageTimeout({}, run), COUNCIL_PACES.slow.evidence_ms);
  assert.equal(masterStageTimeout({}, run), COUNCIL_PACES.slow.master_ms);
  assert.equal(debateStageTimeout({}, run), COUNCIL_PACES.slow.debate_ms);
  assert.equal(portfolioManagerStageTimeout({}, run), COUNCIL_PACES.slow.pm_ms);

  // The legacy fields remain a caller-controlled LOWER ceiling; they can never enlarge a pace.
  assert.equal(evidenceStageTimeout({ timeout_ms: 600_000 }, run), 600_000);
  assert.equal(evidenceStageTimeout({ timeout_ms: 900_000 }, run), COUNCIL_PACES.slow.evidence_ms);
  assert.equal(masterStageTimeout({ timeout_ms: 30_000 }, run), 30_000);
  assert.equal(debateStageTimeout({ synthesis_timeout_ms: 45_000 }, run), 45_000);
  assert.equal(portfolioManagerStageTimeout({ synthesis_timeout_ms: 45_000 }, run), 45_000);
});

test("the MCP schema no longer injects a ten-minute legacy default into a pace", () => {
  for (const name of ["collect_evidence", "analyze_symbol"]) {
    const tool = rpcTools().find((entry) => entry.name === name);
    assert.ok(tool, `${name} must be shipped`);
    assert.equal(Object.hasOwn(tool.inputSchema.properties.timeout_ms, "default"), false, name);
    assert.equal(Object.hasOwn(tool.inputSchema.properties.synthesis_timeout_ms, "default"), false, name);
    assert.equal(Object.hasOwn(tool.inputSchema.properties.council_pace, "default"), false, name,
      "execution omission must inherit the pace bound into the one-run receipt");
  }
});

test("a council rejects a future information cutoff before launching workers", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");
  assert.equal(councilAsOf("2026-08-03", { now }), "2026-08-03");
  assert.equal(councilAsOf("2026-08-02", { now }), "2026-08-02");
  assert.throws(
    () => councilAsOf("2026-08-04", { now }),
    (error) => error.code === -32602 && error.data.reason === "FUTURE_AS_OF",
  );
  assert.throws(() => councilAsOf("2026-02-30", { now }), /valid YYYY-MM-DD/u);
});
