import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFactPack } from "../../mcp/lib/personas-v3/typed-facts.mjs";
import { loadCompiledPersonaPacks } from "../../mcp/lib/personas-v3/registry.mjs";
import { technicalIdReadableMap } from "../../mcp/lib/personas-v3/runtime.mjs";
import { completedMasterOpinion, declinedMasterOpinion, needsMethodVoiceWorker, planMasterSeats } from "../../mcp/lib/personas/engine.mjs";
import { voiceFromDecision } from "../../mcp/lib/voice-from-decision.mjs";

/**
 * A condition id is hashed before the policy runs so the decision layer cannot recognise the
 * seat. Past the freeze the seat is named -- in the report and in the explanation worker's own
 * opening line -- so a surviving `anon_<hash>` only stops the seat from telling a reader which
 * condition decided it. On a real NOW run it did exactly that: two seats whose hard veto had
 * been hashed guessed in their recorded statements which condition had vetoed them, and both
 * blamed a stock-split artefact instead of the market-level reading that actually fired.
 */

const AS_OF = "2026-07-30";
const ANON = /anon_[0-9a-f]{17}/;

function ratio(factId, value) {
  return {
    schema_version: 1, fact_id: factId, value_kind: "ratio", value, unit: "decimal",
    ratio_denominator: "one", currency: null, scale: null, period_start: null, period_end: null,
    fiscal_year: null, as_of: AS_OF, public_at: AS_OF, source_ids: ["market_data:S1"],
    derivation: "reported", confidence: 1, restatement_policy: "snapshot",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  };
}

function scalar(factId, value) {
  return {
    schema_version: 1, fact_id: factId, value_kind: "scalar", value, unit: "ratio",
    currency: null, scale: null, period_start: null, period_end: null,
    fiscal_year: null, as_of: AS_OF, public_at: AS_OF, source_ids: ["market_data:S1"],
    derivation: "reported", confidence: 1, restatement_policy: "snapshot",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  };
}

function soloTestRegistry() {
  return loadCompiledPersonaPacks({ buildProfile: "solo_test" });
}

// Equity earning less than AAA corporate debt: the reading that vetoed the seat on NOW.
function vetoedMarksOpinion(language = "Chinese") {
  const registry = soloTestRegistry();
  const run = {
    symbol: "NOW",
    as_of: AS_OF,
    language,
    grounding: {
      typed_fact_pack: buildFactPack([
        scalar("index.aggregate_pe_ttm", 25.17),
        ratio("index.aggregate_earnings_yield", 0.04),
        ratio("macro.aaa_corporate_yield", 0.055),
        // A spread below its long-run average, so the seat's own gap output goes negative and
        // the hard veto -- not a score band -- decides the stance.
        ratio("macro.credit_spread", 0.012),
      ], { asOf: AS_OF }),
    },
  };
  const plan = planMasterSeats(run, ["master_marks"], { v3Registry: registry });
  assert.equal(plan.completed.length, 1, "the seat must reach a frozen decision");
  return { opinion: completedMasterOpinion(run, plan.completed[0]), item: plan.completed[0] };
}

test("the alias map resolves every declared condition id of a seat", () => {
  const pack = soloTestRegistry().get("master_marks");
  const map = technicalIdReadableMap(pack);
  const resolved = [...map.values()];
  assert.ok(resolved.includes("master_marks.euphoria"), "the hard veto must be resolvable");
  assert.ok(resolved.includes("marks_credit_spread_above_long_run_average"));
  assert.ok(resolved.includes("master_marks.market_valuation_observable"));
  for (const alias of map.keys()) assert.match(alias, /^anon_[0-9a-f]{17}$/);
});

test("a vetoed seat names its own hard veto instead of a hash", () => {
  const { opinion } = vetoedMarksOpinion();
  assert.equal(opinion.stance, "opposed");
  assert.equal(opinion.decision_reason, "veto");
  assert.deepEqual(opinion.disqualifiers_triggered, ["master_marks.euphoria"]);
  assert.match(opinion.voice.how_my_method_reads_it, /master_marks\.euphoria/);
});

test("no anonymised condition id survives anywhere in a reader-facing opinion", () => {
  for (const language of ["en", "Chinese", "日本語", "한국어"]) {
    const { opinion } = vetoedMarksOpinion(language);
    const leaked = JSON.stringify(opinion).match(new RegExp(ANON.source, "g"));
    assert.equal(leaked, null, `${language} still leaks ${leaked}`);
  }
});

test("scoring conditions resolve by declared id, not by position in the executor's split", () => {
  // The positional fallback maps "index within hits+misses+uncomputable" onto "index within
  // the declared rules". Those coincide only when the split happens to preserve declaration
  // order, so a seat with one hit and one miss could publish the two names swapped. Feed the
  // frozen result an inverted split and require the exact map to win.
  const pack = soloTestRegistry().get("master_marks");
  const map = technicalIdReadableMap(pack);
  const [firstAlias, secondAlias] = [...map.entries()]
    .filter(([, id]) => id.startsWith("marks_"))
    .map(([alias]) => alias);
  const voice = voiceFromDecision({
    result: {
      common_projection: { stance: "cautious", score_ratio: 0.5 },
      score: { hits: [{ rule_id: secondAlias }], misses: [{ rule_id: firstAlias }], uncomputable: [] },
      computations: { trace: [] },
      vetoes_triggered: [],
    },
    policy: pack.components?.decision_policy,
    readableIds: map,
    language: "en",
  });
  assert.match(voice.how_my_method_reads_it, /marks_equity_paid_over_corporate_debt/);
  assert.match(voice.how_my_method_reads_it, /marks_credit_spread_above_long_run_average/);
  const hitsThenMisses = voice.how_my_method_reads_it;
  const hitAt = hitsThenMisses.indexOf(map.get(secondAlias));
  const missAt = hitsThenMisses.indexOf(map.get(firstAlias));
  assert.ok(hitAt < missAt, "the hit must be reported as the hit, not swapped with the miss");
});

test("every frozen seat, including an abstention, gets a method-specific voice worker", () => {
  // The seat has all it needs to score, so the gate opens and the seat votes: it must keep its
  // worker, because a stance has a reading only a worker can put into the method's own words.
  const { opinion: voted } = vetoedMarksOpinion();
  assert.equal(needsMethodVoiceWorker(voted), true);

  // With the market yardstick absent the eligibility gate closes. The deterministic record
  // remains readable, but the strong first-person contract still requires the isolated worker.
  const registry = soloTestRegistry();
  const run = {
    symbol: "NOW",
    as_of: AS_OF,
    language: "Chinese",
    grounding: {
      typed_fact_pack: buildFactPack([
        ratio("index.aggregate_earnings_yield", 0.04),
        ratio("macro.aaa_corporate_yield", 0.055),
        ratio("macro.credit_spread", 0.012),
      ], { asOf: AS_OF }),
    },
  };
  const plan = planMasterSeats(run, ["master_marks"], { v3Registry: registry });
  const seat = plan.completed[0] || plan.declined[0];
  assert.ok(seat, "the seat must reach a frozen record rather than break");
  const opinion = seat.declined
    ? declinedMasterOpinion(run, seat)
    : completedMasterOpinion(run, seat);

  assert.equal(opinion.stance, "out_of_scope");
  assert.equal(needsMethodVoiceWorker(opinion), true);
  assert.match(opinion.voice_statement, /这不是看空，也不是一张反对票/);
  assert.match(opinion.summary, /没有让语言模型选择立场|v3 typed-fact 闸门/);
  assert.ok(!/anon_[0-9a-f]{17}/.test(JSON.stringify(opinion)));

  // Legacy environment toggles cannot weaken the global reader contract.
  assert.equal(needsMethodVoiceWorker(opinion, { env: { ALPHACOUNCIL_VOICE_ABSTAINING_SEATS: "1" } }), true);
  const basket = { grounding: { instrument: { asset_type: "index", index_like: true } } };
  assert.equal(needsMethodVoiceWorker(opinion, { env: {}, run: basket }), true);
  assert.equal(needsMethodVoiceWorker(opinion, { env: { ALPHACOUNCIL_VOICE_ABSTAINING_SEATS: "0" }, run: basket }), true);
});
