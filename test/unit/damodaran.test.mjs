import { test } from "node:test";
import assert from "node:assert/strict";

import { erpPercentile } from "../../mcp/lib/damodaran.mjs";

const months = (count, start = "2016-01-01") => {
  const out = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    out.push({ date: cursor.toISOString().slice(0, 10), erp: 0.03 + (i / 1000), bond_rate: 0.04, index_level: 1000 + i });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
};

test("a percentile always reports the sample it ranked against", () => {
  // "the ERP is 4.2%" says nothing without "which is the Nth percentile since when".
  const rank = erpPercentile(months(126));
  assert.equal(rank.sample_size, 126);
  assert.equal(rank.percentile, Number((125 / 126).toFixed(4)));
  assert.ok(rank.sample_start < rank.sample_end);
});

test("too little history yields no percentile rather than a confident one", () => {
  assert.equal(erpPercentile(months(12)), null);
  assert.equal(erpPercentile([]), null);
  assert.equal(erpPercentile(null), null);
});

test("a falling premium ranks low, which is the reading that matters", () => {
  // A thin premium is the signal a cycle method acts on, so the direction must not invert.
  const rising = months(60);
  const falling = rising.map((row, index) => ({ ...row, erp: 0.09 - (index / 1000) }));
  assert.ok(erpPercentile(rising).percentile > 0.9);
  assert.ok(erpPercentile(falling).percentile < 0.1);
});
