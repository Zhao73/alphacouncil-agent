import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";

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
});

test("normalizeDebate defaults optional contract arrays to empty", () => {
  const debate = normalizeDebate({}, "bull_researcher", { symbol: "AAPL", as_of: "2026-06-22" }, "");
  assert.deepEqual(debate.debate_rounds, []);
  assert.deepEqual(debate.questions, []);
  assert.deepEqual(debate.questions_answered, []);
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
