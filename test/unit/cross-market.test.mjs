import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_PAIRED_SESSIONS, alignedReturns, correlation } from "../../mcp/lib/cross-market.mjs";
import { parseDatedCloses } from "../../mcp/lib/breadth.mjs";

const series = (start, count, step, skip = new Set()) => {
  const rows = [];
  const day = new Date(`${start}T00:00:00.000Z`).getTime();
  for (let index = 0; rows.length < count; index += 1) {
    const date = new Date(day + index * 86_400_000).toISOString().slice(0, 10);
    if (skip.has(date)) continue;
    rows.push({ date, close: 100 * (1 + step) ** rows.length });
  }
  return rows;
};

test("correlation is 1 for a series against itself and -1 against its mirror", () => {
  const up = [0.01, -0.02, 0.03, 0.005, -0.01];
  assert.equal(Number(correlation(up, up).toFixed(6)), 1);
  assert.equal(Number(correlation(up, up.map((v) => -v)).toFixed(6)), -1);
  assert.equal(correlation(up, [0, 0, 0, 0, 0]), null, "a flat series has no correlation, not zero");
  assert.equal(correlation(up, up.slice(1)), null, "unequal lengths never silently truncate");
});

/**
 * The defect this guards is invisible rather than loud. Korea and the United States keep
 * different holidays, so the two close arrays have different lengths and their positions do not
 * correspond. Zipping them by index compares a Tuesday with a Wednesday and returns a number
 * that looks exactly like a correlation.
 */
test("sessions pair by date, so a market holiday cannot shift one series against the other", () => {
  const us = series("2026-01-01", 60, 0.001);
  // Korea trades the same run of dates minus a national holiday in the middle.
  const holiday = us[30].date;
  const kr = us.filter((row) => row.date !== holiday).map((row) => ({ ...row }));
  const aligned = alignedReturns(us, kr);
  assert.equal(aligned.sessions, kr.length - 1, "only shared dates are compared");
  assert.ok(!aligned.left.some((value, index) => !Number.isFinite(value) || !Number.isFinite(aligned.right[index])));
  // Both series are the same geometric path on the dates they share, so pairing by date is
  // perfect and pairing by position would not be.
  assert.equal(Number(correlation(aligned.left, aligned.right).toFixed(6)), 1);
});

test("too little overlap produces nothing rather than a confident small-sample number", () => {
  const us = series("2026-01-01", 60, 0.001);
  const other = series("2027-06-01", 60, 0.001);
  assert.equal(alignedReturns(us, other), null, "disjoint calendars share no sessions");
  const barely = us.slice(0, MIN_PAIRED_SESSIONS - 5);
  assert.equal(alignedReturns(barely, barely), null);
});

test("dated closes keep the session, and a chart without timestamps is refused", () => {
  const rows = parseDatedCloses({
    chart: { result: [{ timestamp: [1767225600, 1767312000], indicators: { quote: [{ close: [10, 11] }] } }] },
  });
  assert.equal(rows.length, 2);
  assert.match(rows[0].date, /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(parseDatedCloses({ chart: { result: [{ indicators: { quote: [{ close: [10, 11] }] } }] } }), null);
  // A close with no timestamp is dropped rather than paired with the wrong day.
  const partial = parseDatedCloses({
    chart: { result: [{ timestamp: [1767225600, null], indicators: { quote: [{ close: [10, 11] }] } }] },
  });
  assert.equal(partial.length, 1);
});
