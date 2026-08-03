import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";
import { debateQnaGate, firstFailedDebateResult, managerFallback } from "../../mcp/lib/packets.mjs";

import { scopedPacket } from "../helpers/fixtures.mjs";

const { normalizeDebate, sourceManifest, mergeDebateRounds } = __test__;

test("source IDs are task-scoped after normalization", () => {
  const packet = scopedPacket();
  assert.equal(packet.sources[0].id, "market_data:S1");
  assert.equal(packet.claims[0].source_ids[0], "market_data:S1");
});

test("source manifest preserves scoped sources", () => {
  const manifest = sourceManifest({
    run_id: "TEST",
    symbol: "AAPL",
    as_of: "2026-06-22",
    packets: [scopedPacket()],
  });
  assert.equal(manifest.source_count, 1);
  assert.deepEqual(manifest.missing_claim_source_ids, []);
});

test("source manifest includes exact typed-grounding sources", () => {
  const source = {
    source_id: "quote:yahoo:AAPL:2026-06-22T12:00:00.000Z",
    source_kind: "market_snapshot",
    title: "Yahoo quote for AAPL",
    url: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d",
    public_at: "2026-06-22T12:00:00.000Z",
    retrieved_at: "2026-06-22T12:01:00.000Z",
    locator: { symbol: "AAPL", observation_time: "2026-06-22T12:00:00.000Z" },
  };
  const manifest = sourceManifest({
    run_id: "TEST",
    symbol: "AAPL",
    as_of: "2026-06-22",
    grounding: { typed_fact_sources: [source] },
    packets: [],
  });
  assert.equal(manifest.source_count, 1);
  assert.equal(manifest.sources[0].task, "grounding");
  assert.equal(manifest.sources[0].id, source.source_id);
  assert.equal(manifest.sources[0].url, source.url);
  assert.equal(manifest.sources[0].provenance_domain, "evidence");
});

test("source manifest preserves method provenance in a non-evidence domain", () => {
  const manifest = sourceManifest({
    run_id: "TEST",
    symbol: "AAPL",
    as_of: "2026-06-22",
    grounding: { typed_fact_sources: [] },
    packets: [scopedPacket()],
    master_runtime_provenance: {
      master_marks: {
        method_sources: [{
          source_id: "proxy:marks-fixture",
          source_kind: "derived_proxy",
          grade: "E",
          adjudication: { status: "pending", reviewer_ids: [] },
          content_hash: "sha256:fixture",
          title: "Project-derived Marks method fixture",
          url: "https://example.com/method-build-spec",
        }],
      },
    },
  });
  assert.equal(manifest.evidence_source_count, 1);
  assert.equal(manifest.method_provenance_source_count, 1);
  const proxy = manifest.sources.find((source) => source.id === "proxy:marks-fixture");
  assert.equal(proxy.task, "method_provenance:master_marks");
  assert.equal(proxy.provenance_domain, "method_provenance");
  assert.equal(proxy.method_id, "master_marks");
  assert.equal(proxy.url, "https://example.com/method-build-spec");
});

test("packet and typed-fact ingress cannot promote reserved method sources into evidence", () => {
  const spoofedIds = [
    "proxy:packet-spoof",
    "market_data:METHOD-DEFINITION-SPOOF",
    "grounding:DERIVED-PROXY-SPOOF",
    "grounding:EDITORIAL-SPOOF",
    "market_data:METHOD-ID-ALIAS-SPOOF",
  ];
  const manifest = sourceManifest({
    run_id: "TEST",
    symbol: "AAPL",
    as_of: "2026-06-22",
    grounding: {
      typed_fact_sources: [{
        source_id: "grounding:DERIVED-PROXY-SPOOF",
        source_kind: "derived_proxy",
      }, {
        source_id: "grounding:EDITORIAL-SPOOF",
        source_kind: "editorial_choice",
      }],
    },
    packets: [{
      task: "market_data",
      sources: [{
        id: "proxy:packet-spoof",
        source_kind: "market_snapshot",
      }, {
        id: "market_data:METHOD-DEFINITION-SPOOF",
        source_kind: "method_definition",
      }, {
        id: "market_data:METHOD-ID-ALIAS-SPOOF",
        source_kind: "market_snapshot",
      }],
      claims: spoofedIds.map((sourceId) => ({ source_ids: [sourceId] })),
    }],
    master_runtime_provenance: {
      master_marks: {
        method_sources: [{
          source_id: "proxy:packet-spoof",
          source_kind: "derived_proxy",
        }, {
          source_id: "market_data:METHOD-ID-ALIAS-SPOOF",
          source_kind: "primary_text",
        }],
      },
    },
  });

  assert.equal(manifest.evidence_source_count, 0);
  assert.equal(manifest.method_provenance_source_count, 2);
  assert.equal(manifest.sources[0].provenance_domain, "method_provenance");
  assert.deepEqual(
    manifest.missing_claim_source_ids.map((item) => item.source_id),
    spoofedIds,
  );
});

test("normalizeDebate defaults optional contract arrays to empty", () => {
  const debate = normalizeDebate({}, "bull_researcher", { symbol: "AAPL", as_of: "2026-06-22" }, "");
  assert.deepEqual(debate.debate_rounds, []);
  assert.deepEqual(debate.questions, []);
  assert.deepEqual(debate.questions_answered, []);
});

test("an unavailable decision can never retain high decision confidence", () => {
  const debate = normalizeDebate({
    decision_available: false,
    rating: "Buy",
    confidence: "high",
  }, "portfolio_manager", { symbol: "AAPL", as_of: "2026-06-22" }, "");
  assert.equal(debate.decision_available, false);
  assert.equal(debate.rating, null);
  assert.equal(debate.confidence, "low");
});

test("mergeDebateRounds takes top-level fields from the last round and keeps all rounds", () => {
  const round = (rating, summary) =>
    normalizeDebate({ rating, summary }, "bull_researcher", { symbol: "AAPL", as_of: "2026-06-22" }, summary);
  const merged = mergeDebateRounds([round("Hold", "r1"), round("Overweight", "r2"), round("Buy", "r3")]);
  assert.equal(merged.rating, "Buy");
  assert.equal(merged.summary, "r3");
  assert.equal(merged.debate_rounds.length, 3);
  assert.deepEqual(merged.debate_rounds.map((r) => r.round), [1, 2, 3]);
});

test("the debate Q&A gate requires three cross-fed questions and three answers per side", () => {
  const questions = ["q1", "q2", "q3"];
  const answers = questions.map((question, index) => ({ question, answer: `a${index + 1}` }));
  assert.deepEqual(debateQnaGate({
    bullR2: { questions },
    bearR2: { questions },
    bullR3: { questions, questions_answered: answers },
    bearR3: { questions, questions_answered: answers },
  }), { status: "passed", errors: [] });

  const failed = debateQnaGate({
    bullR2: { questions },
    bearR2: { questions },
    bullR3: { questions, questions_answered: [] },
    bearR3: { questions, questions_answered: [] },
  });
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.errors, [
    "bull_researcher round 3 must answer exactly 3 opponent questions with exact question bindings",
    "bear_researcher round 3 must answer exactly 3 opponent questions with exact question bindings",
  ]);

  const unrelated = debateQnaGate({
    bullR2: { questions },
    bearR2: { questions },
    bullR3: {
      questions,
      questions_answered: answers.map((item) => ({ ...item, question: `unrelated ${item.question}` })),
    },
    bearR3: { questions, questions_answered: answers },
  });
  assert.equal(unrelated.status, "failed");
  assert.match(unrelated.errors[0], /exact question bindings/);
});

test("debate transport diagnostics retain an early-round failure after a later success", () => {
  const early = { ok: false, timedOut: true, code: null };
  const later = { ok: true, timedOut: false, code: 0 };
  assert.equal(firstFailedDebateResult([
    { result: early },
    { result: later },
  ]), early);
  assert.equal(firstFailedDebateResult([{ result: later }]), null);
});

test("manager fallback routes the current analyst tasks into revision and earnings-call sections", () => {
  const packet = (task, summary) => ({
    task,
    summary,
    confidence: "high",
    claims: [],
    open_questions: [],
    sources: [],
  });
  const report = managerFallback({
    run_id: "FALLBACK-MAPPING",
    symbol: "TEST",
    as_of: "2026-08-03",
    language: "English",
    dry_run: false,
    master_opinions: [],
    packets: [
      packet("forward_expectations", "FORWARD_EXPECTATIONS_SENTINEL"),
      packet("earnings_deep_dive", "EARNINGS_DEEP_DIVE_SENTINEL"),
    ],
  }).report_markdown;
  const section = (heading) => report.split(`## ${heading}\n`)[1].split("\n## ")[0];

  assert.match(section("Analyst Rating and Target-Price Revisions"), /FORWARD_EXPECTATIONS_SENTINEL/);
  assert.doesNotMatch(section("Analyst Rating and Target-Price Revisions"), /No sell-side revision evidence/);
  assert.match(section("Earnings Call Management Signals"), /EARNINGS_DEEP_DIVE_SENTINEL/);
  assert.doesNotMatch(section("Earnings Call Management Signals"), /No earnings-call evidence/);
});

test("manager fallback records two PM parse failures without promoting evidence confidence", () => {
  const packet = {
    task: "market_data",
    summary: "High-confidence evidence remains distinct from decision confidence.",
    confidence: "high",
    claims: [],
    open_questions: [],
    sources: [],
  };
  const fallback = managerFallback({
    run_id: "PM-PARSE-FALLBACK",
    symbol: "RKLB",
    as_of: "2026-08-03",
    language: "zh-CN",
    dry_run: false,
    master_opinions: [],
    packets: [packet],
    agent_status: {
      portfolio_manager: { role: "portfolio_manager", status: "waiting", attempts: 2 },
    },
  }, "fixture failure", { failure_kind: "parse_failed" });

  assert.equal(fallback.decision_available, false);
  assert.equal(fallback.confidence, "low");
  assert.match(fallback.summary, /已执行 2 次.*两次输出均违反 JSON\/报告契约.*未产出可用决策/u);
  assert.match(fallback.report_markdown, /已执行 2 次.*未产出可用决策/u);
  assert.match(fallback.report_markdown, /## 置信度\nlow/u);
  assert.doesNotMatch(fallback.report_markdown, /未运行经理综合子代理/u);
});
