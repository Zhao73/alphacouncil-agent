import test from "node:test";
import assert from "node:assert/strict";

import { periodWindowMatches } from "../../mcp/lib/periods.mjs";

const day = (offset) => new Date(Date.UTC(2021, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);

test("the shared P5Y contract accepts a physical five-year share window", () => {
  assert.equal(periodWindowMatches({ period_start: "2021-01-31", period_end: "2026-01-25" }, "P5Y"), true);
  assert.equal(periodWindowMatches({ period_start: "2022-01-30", period_end: "2026-01-25" }, "P5Y"), false);
});

test("P5Y boundary handling is identical for producers and deterministic consumers", () => {
  assert.equal(periodWindowMatches({ period_start: day(0), period_end: day(1818) }, "P5Y"), true);
  assert.equal(periodWindowMatches({ period_start: day(0), period_end: day(1831) }, "P5Y"), true);
  assert.equal(periodWindowMatches({ period_start: day(0), period_end: day(1817) }, "P5Y"), false);
  assert.equal(periodWindowMatches({ period_start: day(0), period_end: day(1832) }, "P5Y"), false);
});
