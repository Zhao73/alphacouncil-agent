import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMethodVoiceHeadlessOutputSchema,
  assertMethodVoiceReaderLanguage,
  methodVoiceReaderText,
  masterAttemptFailureDiagnostic,
  debateTransportAttemptDiagnostic,
  outputFailureKind,
  workerExecutionFailureKind,
} from "../../mcp/lib/orchestrator.mjs";
import { assertSourceIdsResolve } from "../../mcp/lib/packets.mjs";
import {
  assertRuntimeWorkerPayload,
  RUNTIME_WORKER_SCHEMA_IDS,
} from "../../mcp/lib/runtime-validation.mjs";

const methodVoicePacket = () => ({
  master: "master_druckenmiller",
  acknowledged_stance: "cautious",
  voice_mode: "first_person_public_method_simulation_v1",
  disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
  position_intent: "would_hold",
  voice: {
    what_i_see: "I see a bounded point-in-time record.",
    how_my_method_reads_it: "I read liquidity and price together.",
    would_i_act: "I would hold while the bounded evidence remains intact.",
    what_changes_my_mind: "I would change my mind if liquidity reversed.",
    where_i_disagree: "I disagree with adding facts outside this record.",
  },
  key_findings: ["Price confirms the bounded stance."],
  disagreements: ["The cycle still matters."],
  what_would_change_my_mind: ["A dated reversal would change my reading."],
  source_ids: ["market_data:S1"],
  confidence: "medium",
});

function captureMethodVoiceSchemaError(packet) {
  let failure;
  try {
    assertRuntimeWorkerPayload("method_voice", packet);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.data?.reason, "WORKER_OUTPUT_SCHEMA_MISMATCH");
  assert.equal(failure.data.schema_id, RUNTIME_WORKER_SCHEMA_IDS.method_voice);
  return failure;
}

test("run-specific method schema locks identity, decision, dossier and packet tasks", () => {
  const run = {
    language: "中文",
    packets: [
      { task: "market_data", sources: [{ id: "market_data:S1" }] },
      { task: "earnings_deep_dive", sources: [{ id: "earnings_deep_dive:S1" }] },
    ],
    grounding: { instrument: { asset_type: "operating_company" } },
    entry_tool: "run_council",
    company_dossier: { content_hash: `sha256:${"a".repeat(64)}` },
  };
  const frozen = {
    master: "master_fisher",
    stance: "cautious",
    source_ids: ["market_data:S1", "earnings_deep_dive:S1"],
    evidence_source_ids: ["market_data:S1", "earnings_deep_dive:S1"],
  };
  const schema = buildMethodVoiceHeadlessOutputSchema(run, frozen.master, frozen);
  assert.equal(schema.properties.master.const, "master_fisher");
  assert.equal(schema.properties.acknowledged_stance.const, "cautious");
  assert.deepEqual(schema.properties.position_intent.enum, ["would_hold", "would_watch"]);
  assert.equal(schema.properties.company_dossier_hash_ack.const, run.company_dossier.content_hash);
  assert.deepEqual(schema.properties.evidence_packet_acks.required, ["market_data", "earnings_deep_dive"]);
  assert.equal(schema.properties.evidence_packet_acks.additionalProperties, false);
  assert.deepEqual(
    schema.properties.evidence_packet_acks.properties.market_data.properties.source_ids.items.enum,
    ["market_data:S1"],
  );
  assert.equal(schema.properties.voice.properties.what_i_see.pattern, "我");
  assert.equal(Object.hasOwn(schema.properties.voice.properties.what_i_see, "maxLength"), false);
  assert.equal(Object.hasOwn(schema.properties.key_findings, "maxItems"), false);
});

test("non-company method schema agrees with the null-hash and empty-ack prompt contract", () => {
  const run = {
    language: "中文",
    packets: [{ task: "market_data", sources: [] }],
    grounding: { instrument: { asset_type: "etf", research_model: "fund_lookthrough" } },
    entry_tool: "run_council",
  };
  const frozen = { master: "master_bogle", stance: "out_of_scope", source_ids: [], evidence_source_ids: [] };
  const schema = buildMethodVoiceHeadlessOutputSchema(run, frozen.master, frozen);
  assert.deepEqual(schema.properties.company_dossier_hash_ack, { type: "null" });
  assert.equal(schema.properties.evidence_packet_acks.type, "array");
  assert.equal(schema.properties.evidence_packet_acks.maxItems, 0);
  assert.equal(schema.properties.source_ids.maxItems, 0);
});

test("method voice language gate includes rendered per-packet acknowledgement notes", () => {
  const voice = {
    statement: "我会谨慎观察。我只使用已核实的事实。".repeat(80),
    key_findings: ["我看到需求仍然增长。".repeat(20)],
    disagreements: [],
    what_would_change_my_mind: ["我会等待下一季数据。"],
    evidence_packet_acks: [{ note: "This English acknowledgement must not reach a Chinese report." }],
  };
  assert.throws(
    () => assertMethodVoiceReaderLanguage(voice, "中文", "method voice fixture"),
    (error) => error?.code === "READER_LANGUAGE_MISMATCH",
  );
});

test("oversized source enums fall back to the same fail-closed runtime source validation", () => {
  const sources = Array.from({ length: 500 }, (_, index) => ({ id: `market_data:S${index + 1}` }));
  const run = {
    language: "中文",
    packets: [{ task: "market_data", sources }],
    grounding: { instrument: { research_model: "operating_company" } },
    entry_tool: "run_council",
    company_dossier: { content_hash: `sha256:${"b".repeat(64)}` },
  };
  const frozen = {
    master: "master_fisher",
    stance: "cautious",
    source_ids: [sources[0].id],
    evidence_source_ids: [sources[0].id],
  };
  const schema = buildMethodVoiceHeadlessOutputSchema(run, frozen.master, frozen);
  assert.equal(Object.hasOwn(schema.properties.source_ids.items, "enum"), false);
  assert.equal(schema.properties.source_ids.items.maxLength, 512);
  assert.equal(Object.hasOwn(
    schema.properties.evidence_packet_acks.properties.market_data.properties.source_ids.items,
    "enum",
  ), false);
  assert.ok(JSON.stringify(schema).length < 100_000);
  assert.throws(
    () => assertSourceIdsResolve(run, ["market_data:FORGED"], "large-schema fixture"),
    (error) => error?.data?.reason === "SOURCE_PROVENANCE_MISMATCH",
  );
});

test("one large enum over the native 15k character sub-limit also falls back", () => {
  const sources = Array.from({ length: 260 }, (_, index) => ({
    id: `market_data:SEC-LIKE-${String(index + 1).padStart(3, "0")}-${"x".repeat(58)}`,
  }));
  const run = {
    language: "中文",
    packets: [{ task: "market_data", sources }],
    grounding: { instrument: { research_model: "operating_company" } },
    entry_tool: "run_council",
    company_dossier: { content_hash: `sha256:${"c".repeat(64)}` },
  };
  const frozen = {
    master: "master_fisher",
    stance: "cautious",
    source_ids: [sources[0].id],
    evidence_source_ids: [sources[0].id],
  };
  const schema = buildMethodVoiceHeadlessOutputSchema(run, frozen.master, frozen);
  assert.equal(Object.hasOwn(schema.properties.source_ids.items, "enum"), false);
  assert.ok(JSON.stringify(schema).length < 100_000);
});

test("worker execution diagnostics classify schema rejection without persisting stderr", () => {
  const stderr = "SENSITIVE prompt text Invalid schema for response_format: invalid_json_schema";
  const result = { ok: false, code: 1, stderr, text: "" };
  assert.equal(workerExecutionFailureKind(result), "output_schema_rejected");
  const diagnostic = masterAttemptFailureDiagnostic({
    master: "master_fisher",
    attempt: 1,
    failureKind: workerExecutionFailureKind(result),
    error: new Error("output schema rejected"),
    result,
    stage: "worker_execution",
  });
  assert.equal(diagnostic.stderr_chars, stderr.length);
  assert.match(diagnostic.stderr_sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(diagnostic), /SENSITIVE|Invalid schema/u);
});

test("source provenance failures are not classified as parse failures", () => {
  assert.equal(outputFailureKind({
    data: { reason: "SOURCE_PROVENANCE_MISMATCH" },
  }), "source_provenance_mismatch");
  assert.equal(outputFailureKind({
    data: { reason: "SOURCE_PROVENANCE_REQUIRED" },
  }), "source_provenance_required");
  assert.equal(outputFailureKind({ code: "READER_LANGUAGE_MISMATCH" }), "reader_language_mismatch");
  assert.equal(outputFailureKind({
    data: { reason: "COMPANY_DOSSIER_PACKET_ACK_MISMATCH" },
  }), "company_dossier_packet_ack_mismatch");
  assert.equal(outputFailureKind({
    data: { reason: "METHOD_VOICE_FIRST_PERSON_MISMATCH" },
  }), "method_voice_first_person_mismatch");
  assert.equal(outputFailureKind({
    data: { reason: "METHOD_VOICE_DIRECTIONAL_ABSTENTION" },
  }), "voice_contract_failure");
  assert.equal(outputFailureKind({
    data: { reason: "WORKER_OUTPUT_SCHEMA_MISMATCH" },
  }), "schema_mismatch");
  assert.equal(outputFailureKind({
    data: { reason: "WORKER_JSON_UNRECOVERABLE" },
  }), "json_unrecoverable");
  assert.equal(outputFailureKind(new SyntaxError("bad JSON")), "parse_failed");
});

test("Codex membership exhaustion is classified and persisted without provider prose", () => {
  const stderr = "ERROR: You've hit your usage limit. Visit settings to purchase more credits or try again at Aug 10th, 2026 1:56 PM. PRIVATE_SENTINEL";
  const result = { ok: false, timedOut: false, code: 1, stderr };
  assert.equal(workerExecutionFailureKind(result), "usage_limit_exhausted");
  const diagnostic = debateTransportAttemptDiagnostic({
    role: "bull_researcher",
    round: 2,
    attempt: 1,
    result,
  });
  assert.equal(diagnostic.failure_kind, "usage_limit_exhausted");
  assert.equal(diagnostic.provider_retry_hint, "Aug 10th, 2026 1:56 PM");
  assert.match(diagnostic.stderr_sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_SENTINEL|purchase more credits/u);
});

test("master attempt diagnostics expose bounded method contract reasons without prose", () => {
  const error = Object.assign(new Error("sensitive worker prose"), {
    data: {
      reason: "COMPANY_DOSSIER_PACKET_ACK_MISMATCH",
      expected_packet_count: 11,
      supplied_packet_count: 10,
      problems: [
        { task: "social_pulse", reason: "missing_ack", note: "sensitive note" },
      ],
    },
  });
  const diagnostic = masterAttemptFailureDiagnostic({
    master: "master_fisher",
    attempt: 1,
    failureKind: outputFailureKind(error),
    error,
    result: { text: "sensitive worker output" },
  });
  assert.deepEqual(diagnostic.contract, {
    reason: "COMPANY_DOSSIER_PACKET_ACK_MISMATCH",
    expected_packet_count: 11,
    supplied_packet_count: 10,
    problems: [{ task: "social_pulse", reason: "missing_ack" }],
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /sensitive/u);
});

test("master attempt diagnostics retain bounded paths and provenance hashes without output bodies", () => {
  const sensitiveSourceId = "market_data:SENSITIVE-FORGED-SOURCE-ID-MUST-NOT-BE-PERSISTED";
  const sensitiveOutput = JSON.stringify({
    voice: "SENSITIVE-WORKER-BODY-MUST-NOT-BE-PERSISTED",
    source_ids: [sensitiveSourceId],
  });
  const error = Object.assign(new Error(`SENSITIVE-ERROR-MESSAGE ${sensitiveSourceId}`), {
    data: {
      reason: "SOURCE_PROVENANCE_MISMATCH",
      owner: "SENSITIVE-OWNER-MUST-NOT-BE-PERSISTED",
      unknown_source_ids: [
        sensitiveSourceId,
        ...Array.from({ length: 11 }, (_, index) => `market_data:FORGED-${index}`),
      ],
      schema_id: "runtime-method-voice-v1",
      kind: "method_voice",
      errors: Array.from({ length: 12 }, (_, index) => ({
        path: `/voice/field-${index}`,
        keyword: "required",
        message: `missing field ${index}`,
      })),
    },
  });
  const diagnostic = masterAttemptFailureDiagnostic({
    master: "master_buffett",
    attempt: 1,
    failureKind: "source_provenance_mismatch",
    error,
    result: { text: sensitiveOutput },
  });

  assert.equal(diagnostic.schema_errors.length, 8);
  assert.equal(diagnostic.schema_errors[0].path, "/voice/field-0");
  assert.equal(diagnostic.provenance.unknown_source_ids.length, 8);
  assert.equal(diagnostic.provenance.unknown_source_id_count, 12);
  assert.equal(diagnostic.provenance.owner, "master_buffett");
  assert.equal(diagnostic.provenance.unknown_source_ids_hashed, true);
  assert.ok(diagnostic.provenance.unknown_source_ids.every((id) => /^sha256:[0-9a-f]{64}$/u.test(id)));
  assert.equal(diagnostic.diagnostic, "source_provenance_mismatch during worker_output");
  assert.equal(diagnostic.output_chars, sensitiveOutput.length);
  assert.equal(diagnostic.output_bytes, Buffer.byteLength(sensitiveOutput, "utf8"));
  assert.match(diagnostic.output_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    /SENSITIVE-(?:WORKER-BODY|FORGED-SOURCE-ID|ERROR-MESSAGE|OWNER)-MUST-NOT-BE-PERSISTED/u,
  );
  assert.doesNotMatch(JSON.stringify(diagnostic), /SENSITIVE-ERROR-MESSAGE/u);
});

test("method schema diagnostics retain real required, enum and unexpected-property rules", () => {
  const packet = methodVoicePacket();
  delete packet.voice;
  packet.confidence = "very_high";
  packet.evidence_packet_acks = [{
    task: "market_data",
    status: "used",
    source_ids: ["market_data:S1"],
    note: "I used the bounded evidence packet.",
    extra_prose: "over-structured worker field",
  }];
  const error = captureMethodVoiceSchemaError(packet);
  const diagnostic = masterAttemptFailureDiagnostic({
    master: "master_druckenmiller",
    attempt: 1,
    failureKind: outputFailureKind(error),
    error,
    result: { text: JSON.stringify(packet) },
  });

  assert.ok(diagnostic.schema_errors.some((issue) => (
    issue.path === "/" && issue.keyword === "required" && issue.missing_property === "voice"
  )));
  assert.ok(diagnostic.schema_errors.some((issue) => (
    issue.path === "/confidence" && issue.keyword === "enum"
  )));
  assert.ok(diagnostic.schema_errors.some((issue) => (
    issue.path === "/evidence_packet_acks/0"
      && issue.keyword === "additionalProperties"
      && issue.unexpected_property === "extra_prose"
  )));
  assert.equal(diagnostic.schema_error_count, 3);
  assert.equal(diagnostic.schema_errors_truncated, false);
});

test("method schema diagnostics count before the twelve-error and eight-error bounds", () => {
  const packet = methodVoicePacket();
  delete packet.voice;
  packet.master = 42;
  packet.acknowledged_stance = "unknown";
  packet.voice_mode = "unknown";
  packet.disclosure_ack = "unknown";
  packet.position_intent = "unknown";
  packet.key_findings = Array.from({ length: 8 }, () => 42);
  packet.confidence = "unknown";
  const error = captureMethodVoiceSchemaError(packet);
  const diagnostic = masterAttemptFailureDiagnostic({
    master: "master_druckenmiller",
    attempt: 1,
    failureKind: outputFailureKind(error),
    error,
    result: { text: JSON.stringify(packet) },
  });

  assert.ok(error.data.error_total > 12);
  assert.equal(diagnostic.schema_error_count, error.data.error_total);
  assert.equal(diagnostic.schema_errors.length, 8);
  assert.equal(diagnostic.schema_errors_truncated, true);
});

test("method schema diagnostics never persist rejected packet prose", () => {
  const packet = methodVoicePacket();
  delete packet.voice;
  packet.key_findings = ["PRIVATE_PROSE_SENTINEL"];
  const error = captureMethodVoiceSchemaError(packet);
  const diagnostic = masterAttemptFailureDiagnostic({
    master: "master_druckenmiller",
    attempt: 1,
    failureKind: outputFailureKind(error),
    error,
    result: { text: JSON.stringify(packet) },
  });

  assert.equal(diagnostic.schema_errors[0].missing_property, "voice");
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE_PROSE_SENTINEL/u);
});
