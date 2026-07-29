import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FRED_SERIES,
  growthInflationRegime,
  liquidityImpulse,
  netLiquidity,
  parseFredCsv,
  percentileRank,
  seriesUrl,
  valueBefore,
} from "../../mcp/lib/fred.mjs";

const daily = (start, values) => {
  const rows = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  for (const value of values) {
    rows.push(`${cursor.toISOString().slice(0, 10)},${value}`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return `observation_date,SERIES\n${rows.join("\n")}\n`;
};

const series = (id, start, values, extra = {}) => ({
  id,
  observations: parseFredCsv(daily(start, values), id),
  ...extra,
});

test("a missing observation is dropped, never carried forward", () => {
  // FRED writes "." on a holiday or a not-yet-published date. Reusing the prior value as
  // today's reading would silently invent an observation.
  const rows = parseFredCsv("observation_date,DGS10\n2026-07-22,4.55\n2026-07-23,.\n2026-07-24,4.69\n", "DGS10");
  assert.deepEqual(rows, [
    { date: "2026-07-22", value: 4.55 },
    { date: "2026-07-24", value: 4.69 },
  ]);
});

test("an empty or non-numeric series fails closed", () => {
  assert.throws(() => parseFredCsv("", "DGS10"), /empty FRED series/);
  assert.throws(() => parseFredCsv("observation_date,DGS10\n2026-07-24,.\n", "DGS10"), /no numeric observations/);
});

test("every mapped series declares its unit, because they are not uniform", () => {
  // WALCL is millions and RRPONTSYD is billions; mixing them silently is how a confident
  // wrong number gets produced.
  assert.equal(FRED_SERIES.WALCL.unit, "usd_millions");
  assert.equal(FRED_SERIES.RRPONTSYD.unit, "usd_billions");
  assert.equal(FRED_SERIES.WTREGEN.unit, "usd_millions");
  for (const [id, meta] of Object.entries(FRED_SERIES)) {
    assert.ok(meta.unit, `${id} must declare a unit`);
    assert.ok(meta.label, `${id} must declare a label`);
  }
  assert.match(seriesUrl("DGS10"), /^https:\/\/fred\.stlouisfed\.org\/graph\/fredgraph\.csv\?id=DGS10$/);
});

test("net liquidity converts the billions leg before subtracting it", () => {
  const liquidity = netLiquidity({
    walcl: series("WALCL", "2026-07-20", [6747378, 6747378, 6747378]),
    rrp: series("RRPONTSYD", "2026-07-20", [1.38, 1.38, 1.38]),
    tga: series("WTREGEN", "2026-07-20", [829623, 829623, 829623]),
  });
  // 6747378 - (1.38 * 1000) - 829623
  assert.equal(liquidity.latest, 6747378 - 1380 - 829623);
  assert.equal(liquidity.unit, "usd_millions");
  assert.deepEqual(liquidity.derived_from, ["WALCL", "RRPONTSYD", "WTREGEN"]);
});

test("net liquidity skips a date it cannot fully cover", () => {
  // Better to publish fewer dated points than to pair a balance sheet with a stale liability.
  const liquidity = netLiquidity({
    walcl: series("WALCL", "2026-07-20", [100, 200]),
    rrp: series("RRPONTSYD", "2026-07-21", [1]),
    tga: series("WTREGEN", "2026-07-21", [10]),
  });
  assert.equal(liquidity.observations.length, 1);
  assert.equal(liquidity.observations[0].date, "2026-07-21");
});

test("an impulse reports the window it was measured over", () => {
  const values = Array.from({ length: 200 }, (_, index) => 1000 + index);
  const impulse = liquidityImpulse(series("NET", "2026-01-01", values), { windowDays: 30 });
  assert.equal(impulse.window_days, 30);
  assert.equal(impulse.to_value - impulse.from_value, 30);
  assert.ok(impulse.from_date < impulse.to_date);
  assert.equal(impulse.value, Number((30 / impulse.from_value).toFixed(6)));
});

test("an impulse with no history is null rather than zero", () => {
  assert.equal(liquidityImpulse(series("NET", "2026-07-20", [100, 101])), null);
  assert.equal(valueBefore(series("NET", "2026-07-20", [100]), 91), null);
});

test("a percentile reports the sample it ranked against", () => {
  const values = Array.from({ length: 400 }, (_, index) => index);
  const rank = percentileRank(series("X", "2025-01-01", values), { sinceDays: 365 * 10 });
  assert.equal(rank.percentile, Number(((values.length - 1) / values.length).toFixed(4)));
  assert.equal(rank.sample_size, values.length);
  assert.ok(rank.sample_start < rank.sample_end);
  // "the 92nd percentile" means nothing without saying percentile of what and since when.
  assert.equal(percentileRank(series("X", "2026-07-01", [1, 2, 3])), null);
});

test("the regime quadrant follows the direction of both axes", () => {
  const rising = Array.from({ length: 200 }, (_, index) => index / 100);
  const falling = Array.from({ length: 200 }, (_, index) => 5 - (index / 100));
  const up = growthInflationRegime({
    slope: series("T10Y3M", "2026-01-01", rising),
    breakeven: series("T5YIE", "2026-01-01", rising),
    windowDays: 30,
  });
  assert.equal(up.state, "rising_growth_rising_inflation");
  const mixed = growthInflationRegime({
    slope: series("T10Y3M", "2026-01-01", rising),
    breakeven: series("T5YIE", "2026-01-01", falling),
    windowDays: 30,
  });
  assert.equal(mixed.state, "rising_growth_falling_inflation");
  assert.equal(mixed.window_days, 30);
});

test("an axis without enough history yields no regime at all", () => {
  // A seat that needs a regime must decline rather than receive a coin flip.
  assert.equal(growthInflationRegime({
    slope: series("T10Y3M", "2026-07-20", [0.5, 0.6]),
    breakeven: series("T5YIE", "2026-07-20", [2.1, 2.2]),
  }), null);
});
