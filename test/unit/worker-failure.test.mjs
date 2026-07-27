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
