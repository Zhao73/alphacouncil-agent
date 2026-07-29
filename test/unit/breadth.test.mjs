import { test } from "node:test";
import assert from "node:assert/strict";

import { isAboveAverage, movingAverage, parseDailyCloses } from "../../mcp/lib/breadth.mjs";

const series = (length, fn) => Array.from({ length }, (_, index) => fn(index));

test("a halted session is dropped, never carried forward", () => {
  // Yahoo writes null for an untraded session. Repeating the prior close would invent a print
  // and drag the average toward a price that was never struck.
  const closes = parseDailyCloses({ chart: { result: [{ indicators: { quote: [{ close: [10, null, 12, 0, -1] }] } }] } });
  assert.deepEqual(closes, [10, 12]);
  assert.equal(parseDailyCloses({}), null);
  assert.equal(parseDailyCloses({ chart: { result: [{ indicators: { quote: [{ close: [null] }] } }] } }), null);
});

test("too little history yields no average rather than a short one", () => {
  // A 150-day mean labelled as a 200-day average is the failure this guards.
  assert.equal(movingAverage(series(199, () => 100)), null);
  assert.equal(movingAverage(series(200, () => 100)), 100);
  assert.equal(isAboveAverage(series(199, () => 100)), null);
});

test("the average uses the last window, not the whole series", () => {
  // A name that doubled six months ago must not read as below its average forever.
  const closes = [...series(200, () => 10), ...series(200, () => 20)];
  assert.equal(movingAverage(closes), 20);
  assert.equal(isAboveAverage(closes), false);
  assert.equal(isAboveAverage([...series(200, () => 10), ...series(200, (i) => 10 + i)]), true);
});
