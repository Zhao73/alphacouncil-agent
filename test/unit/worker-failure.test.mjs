import { test } from "node:test";
import assert from "node:assert/strict";

import * as orchestrator from "../../mcp/lib/orchestrator.mjs";
import { debateFromCodex } from "../../mcp/lib/packets.mjs";

const sourcedRun = {
  symbol: "QQQ",
  as_of: "2026-07-28",
  language: "English",
  packets: [{ task: "market_data", sources: [{ id: "market_data:S1" }] }],
};

const validDebatePacket = (over = {}) => ({
  verdict: "The bounded fixture supports a conditional conclusion.",
  rating: "Hold",
  winner: "balanced",
  summary: "The bounded fixture preserves sourced reasoning and explicit uncertainty.",
  long_thesis: ["The cited fixture supports the conditional long case."],
  short_thesis: ["The cited fixture also records a material downside condition."],
  valuation_range: "Only a conditional range is supportable from this fixture.",
  catalysts: ["A dated primary-source update would test the case."],
  risks: ["Contradictory primary evidence is the principal risk."],
  position: "Keep exposure bounded.",
  invalidation: ["A contradictory primary filing invalidates the case."],
  source_ids: ["market_data:S1"],
  confidence: "medium",
  ...over,
});

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

test("company coverage failures expose bounded repair paths instead of a generic parse message", () => {
  const coverageError = new Error("market_data did not satisfy operating_company_dossier_v1");
  coverageError.data = {
    reason: "COMPANY_DOSSIER_COVERAGE_MISMATCH",
    contract_id: "operating_company_dossier_v1",
    coverage: {
      missing: ["market.quote_snapshot"],
      duplicates: [],
      unexpected: [],
      invalid: [{
        id: "market.price_history_range",
        reason: "covered_source_without_publication_or_observation_time",
        source_id: "market_data:S2",
      }],
    },
  };
  const { diagnostic } = orchestrator.workerFailureArtifacts({
    task: "market_data",
    symbol: "ACME",
    asOfDate: "2026-08-03",
    language: "English",
    timeoutMs: 1_000,
    failureKind: "parse_failed",
    parseError: coverageError,
    result: { ok: true, timedOut: false, code: 0, text: "{}", stdout: "", stderr: "" },
  });
  assert.ok(diagnostic.schema_errors.some((issue) => (
    issue.path === "/coverage_items/market.quote_snapshot" && issue.keyword === "required"
  )));
  assert.ok(diagnostic.schema_errors.some((issue) => (
    issue.path === "/coverage_items/market.price_history_range"
      && issue.keyword === "covered_source_without_publication_or_observation_time"
      && issue.message.includes("market_data:S2")
  )));
});

test("oversized worker diagnostics preserve only bounded prefix/tail metadata outside evidence", () => {
  const prefix = "P".repeat(8 * 1024);
  const tail = "T".repeat(8 * 1024);
  const { packet, diagnostic } = orchestrator.workerFailureArtifacts({
    task: "market_data",
    symbol: "QQQ",
    asOfDate: "2026-07-28",
    language: "English",
    timeoutMs: 1_000,
    failureKind: "parse_failed",
    parseError: new Error("worker output exceeded bounded transport"),
    result: {
      ok: false,
      code: 0,
      timedOut: false,
      text: "",
      stderr: "worker output exceeded bounded transport",
      output_too_large: true,
      output_bytes: 50 * 1024 * 1024,
      max_output_bytes: 512 * 1024,
      output_fingerprint_sha256: "a".repeat(64),
      output_hash_scope: "byte_count_plus_prefix_tail",
      output_prefix: prefix,
      output_tail: tail,
    },
  });
  assert.equal(diagnostic.output_too_large, true);
  assert.equal(diagnostic.output_bytes, 50 * 1024 * 1024);
  assert.equal(diagnostic.max_output_bytes, 512 * 1024);
  assert.equal(diagnostic.output_fingerprint_sha256, "a".repeat(64));
  assert.equal(diagnostic.output_hash_scope, "byte_count_plus_prefix_tail");
  assert.equal(diagnostic.output_prefix.length, 4 * 1024);
  assert.equal(diagnostic.output_tail.length, 4 * 1024);
  assert.doesNotMatch(JSON.stringify(packet), /P{100}|T{100}|output_fingerprint/u);
  assert.equal(packet.raw_text, "");
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

test("headless PM requires report_markdown while bull/bear do not", () => {
  const withoutReport = validDebatePacket();
  const bull = debateFromCodex({ ok: true, timedOut: false, code: 0, text: JSON.stringify(withoutReport) }, "bull_researcher", sourcedRun, "");
  assert.equal(bull.failure_kind, undefined);

  const manager = debateFromCodex({ ok: true, timedOut: false, code: 0, text: JSON.stringify(withoutReport) }, "portfolio_manager", sourcedRun, "");
  assert.equal(manager.failure_kind, "parse_failed");
  assert.equal(manager.decision_available, false);
  assert.equal(manager.rating, null);
});

test("full headless structured PM accepts a compact decision while the visible/default PM contract still requires a report", () => {
  const withoutReport = validDebatePacket({
    price_levels: [
      { label: "high", range: "above range", meaning: "poor odds", action: "avoid", basis: "valuation", source_ids: ["market_data:S1"] },
      { label: "start", range: "inside range", meaning: "bounded odds", action: "small", basis: "valuation", source_ids: ["market_data:S1"] },
      { label: "low", range: "below range", meaning: "margin", action: "conditional add", basis: "valuation", source_ids: ["market_data:S1"] },
    ],
    horizon_views: { short_term: "wait", medium_term: "verify", long_term: "compound" },
    data_gaps: ["No critical data gaps were found in the completed fixture packets."],
  });
  const result = debateFromCodex({
    ok: true, timedOut: false, code: 0, text: JSON.stringify(withoutReport),
  }, "portfolio_manager", sourcedRun, "", { managerDecisionOnly: true });
  assert.equal(result.failure_kind, undefined);
  assert.equal(result.rating, "Hold");
  assert.equal(result.report_markdown, "");
  assert.equal(result.price_levels.length, 3);
});

test("PM attempt diagnostics are bounded hashes and never retain rejected model prose", () => {
  const raw = 'PM_PRIVATE_RAW_SENTINEL_{"rating":"Buy","report_markdown":"truncated';
  const diagnostic = orchestrator.portfolioManagerAttemptDiagnostic({
    attempt: 2,
    failureKind: "parse_failed",
    packet: {
      failure_kind: "parse_failed",
      output_contract_diagnostic: { reason: "WORKER_JSON_UNRECOVERABLE" },
    },
    result: { ok: true, timedOut: false, code: 0, text: raw },
  });
  const persisted = JSON.stringify(diagnostic);
  assert.equal(diagnostic.attempt, 2);
  assert.equal(diagnostic.reason, "WORKER_JSON_UNRECOVERABLE");
  assert.equal(diagnostic.output_chars, raw.length);
  assert.match(diagnostic.output_sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(persisted.length < 2_048);
  assert.doesNotMatch(persisted, /PM_PRIVATE_RAW_SENTINEL|report_markdown|rating.*Buy/u);
});

test("headless debate rejects source IDs absent from the source manifest", () => {
  const packet = validDebatePacket({ source_ids: ["market_data:FORGED"] });
  const result = debateFromCodex({ ok: true, timedOut: false, code: 0, text: JSON.stringify(packet) }, "bull_researcher", sourcedRun, "");
  assert.equal(result.failure_kind, "parse_failed");
  assert.equal(result.decision_available, false);
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
