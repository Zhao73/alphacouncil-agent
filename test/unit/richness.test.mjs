import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";
import { richnessSummary } from "../../mcp/lib/run-store.mjs";

const { normalizePacket } = __test__;
const packet = (richness) => normalizePacket(
  { summary: "s", claims: [], sources: [], confidence: "medium", information_richness: richness },
  "market_data", "AAPL", "2026-06-22", "{}",
);

test("a valid grade is kept and anything else becomes unrated", () => {
  for (const grade of ["A", "B", "C"]) assert.equal(packet(grade).information_richness, grade);
  for (const bad of ["D", "a", 1, null, undefined, ""]) {
    assert.equal(packet(bad).information_richness, "unrated", `${JSON.stringify(bad)} must not pass through`);
  }
});

test("richness is independent of confidence", () => {
  // A rich but contradictory task is legitimately A/low; a sparse but decisive one C/high.
  const rich = normalizePacket(
    { confidence: "low", information_richness: "A", claims: [], sources: [] },
    "market_data", "AAPL", "2026-06-22", "{}",
  );
  assert.equal(rich.confidence, "low");
  assert.equal(rich.information_richness, "A");
});

test("richnessSummary counts every grade including unrated", () => {
  const summary = richnessSummary({ packets: [packet("A"), packet("A"), packet("C"), packet("nonsense")] });
  assert.deepEqual(summary, { A: 2, B: 0, C: 1, unrated: 1 });
});

test("a run with no packets summarizes to all zeros rather than throwing", () => {
  assert.deepEqual(richnessSummary({}), { A: 0, B: 0, C: 0, unrated: 0 });
});
