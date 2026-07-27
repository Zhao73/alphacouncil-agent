import { test } from "node:test";
import assert from "node:assert/strict";

import * as orchestrator from "../../mcp/lib/orchestrator.mjs";

test("a timed-out worker keeps internal traces out of the evidence packet", () => {
  assert.equal(typeof orchestrator.workerFailureArtifacts, "function");
  const internalTrace = "codex-search-bridge/research_web internal tool transcript";
  const { packet, diagnostic } = orchestrator.workerFailureArtifacts({
    task: "forward_expectations",
    symbol: "RKLB",
    asOfDate: "2026-07-28",
    language: "zh-CN",
    timeoutMs: 1_200_000,
    result: {
      ok: false,
      timedOut: true,
      code: null,
      stdout: internalTrace,
      stderr: "",
      text: internalTrace,
    },
  });

  assert.deepEqual(packet.claims, [], "an execution failure is not investment evidence");
  assert.equal(packet.raw_text, "", "internal worker transcripts must not pollute evidence.json");
  assert.doesNotMatch(JSON.stringify(packet), /codex-search-bridge|research_web/);
  assert.equal(packet.confidence, "low");
  assert.match(packet.summary, /超时/);
  assert.equal(diagnostic.status, "timed_out");
  assert.equal(diagnostic.timeout_ms, 1_200_000);
  assert.match(diagnostic.diagnostic_excerpt, /codex-search-bridge/);
});

test("a code-zero JSON parse failure is diagnostic material, not investment evidence", () => {
  const malformed = '{"summary":"first-object"}{"summary":"second-object"}';
  const parseError = new SyntaxError("Unexpected non-whitespace character after JSON at position 26");
  const { packet, diagnostic } = orchestrator.workerFailureArtifacts({
    task: "forward_expectations",
    symbol: "RKLB",
    asOfDate: "2026-07-28",
    language: "zh-CN",
    timeoutMs: 1_200_000,
    failureKind: "parse_failed",
    parseError,
    result: {
      ok: true,
      timedOut: false,
      code: 0,
      stdout: "",
      stderr: "",
      text: malformed,
    },
  });

  assert.deepEqual(packet.claims, []);
  assert.deepEqual(packet.sources, []);
  assert.equal(packet.raw_text, "");
  assert.doesNotMatch(JSON.stringify(packet), /first-object|second-object|Unexpected non-whitespace/);
  assert.equal(diagnostic.status, "parse_failed");
  assert.equal(diagnostic.exit_code, 0);
  assert.equal(diagnostic.parse_error, parseError.message);
  assert.equal(diagnostic.output_chars, malformed.length);
  assert.match(diagnostic.output_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.match(diagnostic.parse_context, /}\{/);
});
