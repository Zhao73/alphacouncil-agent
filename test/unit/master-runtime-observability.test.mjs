import { test } from "node:test";
import assert from "node:assert/strict";

import {
  masterAttemptFailureDiagnostic,
  outputFailureKind,
} from "../../mcp/lib/orchestrator.mjs";

test("source provenance failures are not classified as parse failures", () => {
  assert.equal(outputFailureKind({
    data: { reason: "SOURCE_PROVENANCE_MISMATCH" },
  }), "source_provenance_mismatch");
  assert.equal(outputFailureKind({
    data: { reason: "SOURCE_PROVENANCE_REQUIRED" },
  }), "source_provenance_required");
  assert.equal(outputFailureKind({ code: "READER_LANGUAGE_MISMATCH" }), "reader_language_mismatch");
  assert.equal(outputFailureKind(new SyntaxError("bad JSON")), "parse_failed");
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
