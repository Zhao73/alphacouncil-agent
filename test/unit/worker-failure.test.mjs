import { test } from "node:test";
import assert from "node:assert/strict";

import * as orchestrator from "../../mcp/lib/orchestrator.mjs";
import { debateFromCodex } from "../../mcp/lib/packets.mjs";

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

test("reader-language evidence failures keep an independent failure kind", () => {
  const mismatch = new Error("evidence worker reader language mismatch: requested=zh");
  mismatch.code = "READER_LANGUAGE_MISMATCH";
  const { packet, diagnostic } = orchestrator.workerFailureArtifacts({
    task: "market_data", symbol: "QQQ", asOfDate: "2026-07-28", language: "zh-CN", timeoutMs: 1_000,
    failureKind: "reader_language_mismatch", parseError: mismatch,
    result: {
      ok: true, timedOut: false, code: 0, stdout: "", stderr: "",
      text: JSON.stringify({ summary: "English reader prose that must not enter evidence." }),
    },
  });
  assert.equal(diagnostic.status, "reader_language_mismatch");
  assert.equal(diagnostic.reader_language_error, mismatch.message);
  assert.equal("parse_error" in diagnostic, false);
  assert.match(packet.summary, /错误语言/);
  assert.deepEqual(packet.claims, []);
  assert.equal(packet.raw_text, "");
});

for (const [language, script] of [
  ["English", /global deadline/],
  ["zh-CN", /全局截止时间/],
  ["ja-JP", /全体の期限/],
  ["ko-KR", /전체 마감 시간/],
]) {
  test(`${language} real debate failures use a localized failure packet instead of DRY_RUN`, () => {
    const packet = debateFromCodex({
      ok: false,
      deadline_exhausted: true,
      timedOut: true,
      code: 17,
      stderr: "internal transport details",
      stdout: "",
      text: "",
    }, "bull_researcher", { symbol: "QQQ", as_of: "2026-07-28", language }, "fallback");
    assert.equal(packet.failure_kind, "global_deadline", "global deadline must win over timeout and exit");
    assert.equal(packet.verdict, "FAILED");
    assert.equal(packet.decision_available, false);
    assert.equal(packet.rating, null);
    assert.notEqual(packet.verdict, "DRY_RUN");
    assert.match(packet.summary, script);
    assert.equal(packet.raw_text, "");
    assert.doesNotMatch(JSON.stringify(packet), /internal transport details/);
  });
}

test("debate failure kind orders timeout and exit ahead of parse", () => {
  const run = { symbol: "QQQ", as_of: "2026-07-28", language: "English" };
  const timeout = debateFromCodex({ ok: false, timedOut: true, code: 17, stderr: "timeout" }, "bear_researcher", run, "");
  assert.equal(timeout.failure_kind, "timeout");
  const exit = debateFromCodex({ ok: false, timedOut: false, code: 17, stderr: "exit" }, "bear_researcher", run, "");
  assert.equal(exit.failure_kind, "exit");
  const parse = debateFromCodex({ ok: true, timedOut: false, code: 0, text: "{}{}" }, "bear_researcher", run, "");
  assert.equal(parse.failure_kind, "parse_failed");
});

for (const [language, script, timeoutText, parseText] of [
  ["ja-JP", /[\p{Script=Hiragana}\p{Script=Katakana}]/u, /タイムアウト/, /JSON 契約/],
  ["ko-KR", /\p{Script=Hangul}/u, /시간 초과/, /JSON 계약/],
]) {
  test(`${language} worker failures keep reader-facing evidence in the run language`, () => {
    const timeout = orchestrator.workerFailureArtifacts({
      task: "market_data", symbol: "QQQ", asOfDate: "2026-07-28", language, timeoutMs: 1_000,
      result: { ok: false, timedOut: true, code: null, stdout: "internal", stderr: "", text: "internal" },
    });
    assert.match(timeout.packet.summary, script);
    assert.match(timeout.packet.summary, timeoutText);
    assert.match(timeout.packet.open_questions[0], script);

    const malformed = orchestrator.workerFailureArtifacts({
      task: "market_data", symbol: "QQQ", asOfDate: "2026-07-28", language, timeoutMs: 1_000,
      failureKind: "parse_failed", parseError: new SyntaxError("bad json"),
      result: { ok: true, timedOut: false, code: 0, stdout: "", stderr: "", text: "{}{}" },
    });
    assert.match(malformed.packet.summary, parseText);
    assert.doesNotMatch(JSON.stringify(malformed.packet), /internal|bad json/);
  });
}
