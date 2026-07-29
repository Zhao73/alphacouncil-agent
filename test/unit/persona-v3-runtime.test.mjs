import test from "node:test";
import assert from "node:assert/strict";

import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { buildFactPack } from "../../mcp/lib/personas-v3/typed-facts.mjs";
import {
  PersonaV3RuntimeError,
  assertFrozenDecisionIntegrity,
  attachLateVoiceExplanation,
  buildAnonymousPreDecision,
  buildLateVoiceExplanationRequest,
  freezeAnonymousDecision,
  runAnonymousDecisionLayer,
} from "../../mcp/lib/personas-v3/runtime.mjs";

const AS_OF = "2026-07-27";

function typedFact(factId, value = 1) {
  return {
    schema_version: 1,
    fact_id: factId,
    value_kind: "scalar",
    value,
    unit: "points",
    currency: null,
    scale: null,
    period_start: null,
    period_end: null,
    fiscal_year: null,
    as_of: AS_OF,
    public_at: "2026-07-26",
    source_ids: [`source:${factId}`],
    derivation: "reported",
    confidence: 1,
    restatement_policy: "latest public source by as_of wins",
    lineage: {
      input_fact_ids: [],
      tool_id: null,
      tool_version: null,
      calculation_hash: null,
    },
  };
}

function factPack(ids) {
  return buildFactPack(ids.map((id, index) => typedFact(id, index + 1)), { asOf: AS_OF });
}

function compiledPack({
  personaId = "master_buffett",
  publicLabel = "Warren Buffett Method",
  operatorLabel = "Business-owner Operator Lens",
  voiceEn = "Use a patient owner-oriented explanatory voice.",
  voiceZh = "用耐心的企业所有者口吻解释。",
  requiredFactTypes = ["quality.roic"],
  optionalFactTypes = [],
  doctrine = [{ rule_id: "quality.rule.01", claim: "Require durable incremental returns.", source_ids: ["source_1"] }],
  policySalt = "default",
} = {}) {
  const decisionPolicy = {
    schema_version: 1,
    dsl_version: "1.1",
    native_decision_schema: "quality_native_v1",
    abstention_policy: "fail_closed",
    fact_gate: {
      on_missing_critical: { native_state: "critical_facts_missing", common_stance: "out_of_scope" },
    },
    hard_vetoes: [{ veto_id: "veto_leverage", source_ids: ["source_1"] }],
  };
  return {
    schema_version: 3,
    pack_version: "0.9.0",
    persona_id: personaId,
    source_cutoff: AS_OF,
    admitted_label: { en: publicLabel, zh: "匿名方法候选" },
    corpus_hash: sha256({ doctrine, salt: "corpus" }),
    tool_graph_hash: sha256([{ id: "recompute_quality" }]),
    policy_hash: sha256({ decisionPolicy, policySalt }),
    pack_hash: sha256({ personaId, publicLabel, voiceEn, voiceZh, policySalt }),
    manifest: {
      identity: {
        persona_id: personaId,
        public_label: { en: publicLabel, zh: "沃伦巴菲特方法" },
        operator_label: { en: operatorLabel, zh: "企业所有者操作视角" },
      },
      capability: {
        required_fact_types: requiredFactTypes,
        optional_fact_types: optionalFactTypes,
        native_decision_schema: "quality_native_v1",
      },
      computation: { dsl_version: "1.1", pipeline: ["recompute_quality"] },
      decision: {
        eligibility: requiredFactTypes,
        hard_vetoes: ["veto_leverage"],
        native_output: "quality_native_v1",
        common_projection: "quality_projection_v1",
        abstention_policy: "fail_closed",
        confidence_calibrator: null,
      },
    },
    components: {
      doctrine,
      decision_policy: decisionPolicy,
      tools: [{ id: "recompute_quality", kind: "recomputation" }],
    },
    voice: { en: voiceEn, zh: voiceZh },
  };
}

test("anonymous pre-decision excludes identity and voice and is invariant to their swap", () => {
  const firstPack = compiledPack();
  const first = buildAnonymousPreDecision({
    compiledPack: firstPack,
    factPack: factPack(["quality.roic"]),
    privateEvidence: { counterevidence: ["incremental returns weakened"] },
  });
  const swapped = buildAnonymousPreDecision({
    compiledPack: compiledPack({
      personaId: "master_munger",
      publicLabel: "Charlie Munger Method",
      operatorLabel: "Quality Operator Lens",
      voiceEn: "Use a terse multi-disciplinary voice.",
      voiceZh: "使用简洁的多学科口吻。",
    }),
    factPack: factPack(["quality.roic"]),
    privateEvidence: { counterevidence: ["incremental returns weakened"] },
  });

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /master_buffett|Warren Buffett|沃伦巴菲特|owner-oriented/iu);
  assert.equal("pack_hash" in first, false);
  assert.equal(first.phase, "anonymous_pre_decision");
  assert.equal(first.anonymous, true);
  assert.equal(first.eligibility.status, "ready");
  assert.equal(first.execution_gate.anonymous_decision_allowed, true);
  assert.equal(first.execution_gate.narrative_layer_allowed, false);
  assert.match(first.evidence_snapshot_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.deterministic_core_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.deterministic_core_hash, swapped.deterministic_core_hash);
  assert.equal(first.anonymous_method_hash, swapped.anonymous_method_hash);
});

test("no required facts returns out_of_scope and never dispatches the decision layer", async () => {
  const preDecision = buildAnonymousPreDecision({
    compiledPack: compiledPack({ requiredFactTypes: ["quality.roic", "quality.fcf"] }),
    factPack: factPack(["unrelated.price"]),
    privateEvidence: [],
  });
  let calls = 0;
  const result = await runAnonymousDecisionLayer(preDecision, () => {
    calls += 1;
    return { outcome: "own" };
  });
  assert.equal(calls, 0);
  assert.equal(result.decision_layer_called, false);
  assert.equal(preDecision.eligibility.status, "out_of_scope");
  assert.equal(preDecision.execution_gate.anonymous_decision_allowed, false);
  assert.equal(result.frozen_decision.structured_decision.status, "out_of_scope");
  assert.equal(result.frozen_decision.structured_decision.result.outcome, "out_of_scope");
  assert.throws(
    () => freezeAnonymousDecision(preDecision, { outcome: "own" }),
    /ineligible pre-decision cannot accept/,
  );
});

test("partial required facts return insufficient_grounding with an exact coverage vector", async () => {
  const required = ["options.skew", "options.realized_vol", "options.friction", "options.event_expiry"];
  const preDecision = buildAnonymousPreDecision({
    compiledPack: compiledPack({ requiredFactTypes: required }),
    factPack: factPack(["options.skew"]),
    privateEvidence: { chain: "partial" },
  });
  let called = false;
  const result = await runAnonymousDecisionLayer(preDecision, () => { called = true; });
  // Partial grounding now DISPATCHES. A method states what an absent input means through its
  // own vetoes and `on_missing` rules, and refusing to execute reported this gate in place of
  // the method's answer. The coverage vector below is what still has to be exact -- a seat
  // that runs on a quarter of its facts must say so.
  assert.equal(called, true);
  assert.equal(preDecision.eligibility.status, "insufficient_grounding");
  assert.deepEqual(preDecision.eligibility.coverage, { present: 1, required: 4, ratio: 0.25 });
  assert.deepEqual(preDecision.eligibility.missing_required_fact_types, required.slice(1));
  assert.equal(result.frozen_decision.structured_decision.result.eligibility.coverage.ratio, 0.25);
});

test("no required fact at all is still a hard stop that never dispatches", async () => {
  const required = ["options.skew", "options.realized_vol"];
  const preDecision = buildAnonymousPreDecision({
    compiledPack: compiledPack({ requiredFactTypes: required }),
    factPack: factPack([]),
    privateEvidence: { chain: "none" },
  });
  let called = false;
  const result = await runAnonymousDecisionLayer(preDecision, () => { called = true; });
  assert.equal(called, false, "there is no method left to run");
  assert.equal(preDecision.eligibility.status, "out_of_scope");
  assert.equal(result.frozen_decision.structured_decision.result.native_decision.state, "critical_facts_missing");
});

test("evidence and deterministic hashes are canonical and change on evidence changes", () => {
  const pack = compiledPack();
  const facts = factPack(["quality.roic"]);
  const first = buildAnonymousPreDecision({ compiledPack: pack, factPack: facts, privateEvidence: { b: 2, a: 1 } });
  const reordered = buildAnonymousPreDecision({ compiledPack: pack, factPack: facts, privateEvidence: { a: 1, b: 2 } });
  const changed = buildAnonymousPreDecision({ compiledPack: pack, factPack: facts, privateEvidence: { a: 1, b: 3 } });
  assert.equal(first.evidence_snapshot_hash, reordered.evidence_snapshot_hash);
  assert.equal(first.deterministic_core_hash, reordered.deterministic_core_hash);
  assert.notEqual(first.evidence_snapshot_hash, changed.evidence_snapshot_hash);
  assert.notEqual(first.deterministic_core_hash, changed.deterministic_core_hash);
});

test("a mutated typed fact pack fails its physical hash before decision", () => {
  const original = factPack(["quality.roic"]);
  const tampered = JSON.parse(JSON.stringify(original));
  tampered.facts[0].value = 999;
  assert.throws(
    () => buildAnonymousPreDecision({ compiledPack: compiledPack(), factPack: tampered }),
    (error) => error instanceof PersonaV3RuntimeError && /does not match its physical facts/.test(error.message),
  );
});

test("an eligible anonymous decision layer runs once and freezes a structured result", async () => {
  const preDecision = buildAnonymousPreDecision({
    compiledPack: compiledPack(),
    factPack: factPack(["quality.roic"]),
    privateEvidence: [{ source_id: "filing:1", finding: "ROIC persists" }],
  });
  let calls = 0;
  const execution = await runAnonymousDecisionLayer(preDecision, (payload) => {
    calls += 1;
    assert.equal(payload.anonymous, true);
    assert.equal("persona_id" in payload, false);
    return { outcome: "watch", score: 0.72, reason_codes: ["price_required"] };
  });
  assert.equal(calls, 1);
  assert.equal(execution.decision_layer_called, true);
  assert.equal(execution.frozen_decision.structured_decision.status, "decided");
  assert.equal(execution.frozen_decision.structured_decision.result.outcome, "watch");
  assert.equal(assertFrozenDecisionIntegrity(execution.frozen_decision), true);
  assert.match(execution.frozen_decision.structured_decision_hash, /^sha256:[a-f0-9]{64}$/);
  assert.match(execution.frozen_decision.frozen_decision_hash, /^sha256:[a-f0-9]{64}$/);
  assert.throws(() => {
    execution.frozen_decision.structured_decision.result.outcome = "own";
  }, TypeError);
});

test("late voice can attach text only after freeze without changing decision or hashes", async () => {
  const pack = compiledPack();
  const preDecision = buildAnonymousPreDecision({
    compiledPack: pack,
    factPack: factPack(["quality.roic"]),
    privateEvidence: [],
  });
  const { frozen_decision: frozen } = await runAnonymousDecisionLayer(preDecision, () => ({
    outcome: "reject",
    score: 0.2,
    reason_codes: ["returns_below_hurdle"],
  }));
  const request = buildLateVoiceExplanationRequest({ compiledPack: pack, frozenDecision: frozen, language: "zh" });
  assert.equal(request.phase, "late_voice_explanation");
  assert.equal(request.voice, pack.voice.zh);
  assert.deepEqual(request.structured_decision, frozen.structured_decision);
  assert.equal(request.structured_decision_hash, frozen.structured_decision_hash);

  const explained = attachLateVoiceExplanation({
    frozenDecision: frozen,
    voiceRequest: request,
    explanation: "由于增量回报低于门槛，冻结结论为拒绝。",
  });
  assert.equal(explained.phase, "decision_explained");
  assert.deepEqual(explained.structured_decision, frozen.structured_decision);
  assert.equal(explained.structured_decision_hash, frozen.structured_decision_hash);
  assert.equal(explained.frozen_decision_hash, frozen.frozen_decision_hash);
  assert.equal(explained.deterministic_core_hash, frozen.deterministic_core_hash);
  assert.throws(() => {
    explained.structured_decision.result.outcome = "own";
  }, TypeError);
  assert.throws(
    () => attachLateVoiceExplanation({ frozenDecision: frozen, voiceRequest: request, explanation: { outcome: "own" } }),
    /explanation must be a non-empty string/,
  );
});

test("late voice refuses a different method pack and a tampered frozen decision", async () => {
  const pack = compiledPack();
  const preDecision = buildAnonymousPreDecision({ compiledPack: pack, factPack: factPack(["quality.roic"]) });
  const { frozen_decision: frozen } = await runAnonymousDecisionLayer(preDecision, () => ({ outcome: "watch" }));
  assert.throws(
    () => buildLateVoiceExplanationRequest({
      compiledPack: compiledPack({ policySalt: "different" }),
      frozenDecision: frozen,
    }),
    /does not match the frozen decision's method artifacts/,
  );
  const tampered = JSON.parse(JSON.stringify(frozen));
  tampered.structured_decision.result.outcome = "own";
  assert.throws(() => assertFrozenDecisionIntegrity(tampered), /structured_decision_hash is invalid/);
});

test("identity leakage in method corpus or private evidence fails closed", () => {
  assert.throws(
    () => buildAnonymousPreDecision({
      compiledPack: compiledPack({ doctrine: [{ rule_id: "leak", claim: "Buffett says to buy it.", source_ids: ["source_1"] }] }),
      factPack: factPack(["quality.roic"]),
    }),
    /contains a persona identity/,
  );
  assert.throws(
    () => buildAnonymousPreDecision({
      compiledPack: compiledPack(),
      factPack: factPack(["quality.roic"]),
      privateEvidence: { voice: "pretend this is late voice" },
    }),
    /forbidden pre-freeze identity\/voice field/,
  );
});

test("structured decision rejects prose and voice fields before freeze", () => {
  const preDecision = buildAnonymousPreDecision({ compiledPack: compiledPack(), factPack: factPack(["quality.roic"]) });
  assert.throws(
    () => freezeAnonymousDecision(preDecision, { outcome: "watch", explanation: "styled prose" }),
    /forbidden identity\/voice\/prose field/,
  );
});
