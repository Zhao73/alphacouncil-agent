import { test } from "node:test";
import assert from "node:assert/strict";

import {
  benchmarkSymbolsForSic,
  parseEquityHistory,
  relativePerformance,
  summarizeEquityHistory,
} from "../../mcp/lib/equity-history.mjs";

function historyPayload(count = 253) {
  const start = Date.parse("2025-01-01T21:00:00Z") / 1000;
  const timestamp = Array.from({ length: count }, (_, index) => start + (index * 86400));
  const close = Array.from({ length: count }, (_, index) => 100 * (1.001 ** index));
  const volume = Array.from({ length: count }, (_, index) => 1_000_000 + (index * 1_000));
  return {
    chart: {
      result: [{
        timestamp,
        indicators: {
          quote: [{ close, volume }],
          adjclose: [{ adjclose: close }],
        },
      }],
    },
  };
}

function liveSessionPayload() {
  const first = Date.parse("2026-08-04T13:30:00Z") / 1000;
  const current = Date.parse("2026-08-05T13:30:00Z") / 1000;
  return {
    chart: {
      result: [{
        meta: {
          currentTradingPeriod: {
            regular: {
              start: current,
              end: Date.parse("2026-08-05T20:00:00Z") / 1000,
            },
          },
        },
        timestamp: [first, current],
        indicators: {
          quote: [{ close: [275, 280.04], volume: [1_000_000, 650_000] }],
          adjclose: [{ adjclose: [275, 280.04] }],
        },
      }],
    },
  };
}

test("SEC semiconductor SIC selects SMH plus the broad SPY benchmark without ticker-specific logic", () => {
  const mapped = benchmarkSymbolsForSic(3674);
  assert.equal(mapped.sector, "SMH");
  assert.equal(mapped.broad, "SPY");
  assert.deepEqual(mapped.symbols, ["SMH", "SPY"]);

  const unknown = benchmarkSymbolsForSic(9999);
  assert.equal(unknown.sector, null);
  assert.deepEqual(unknown.symbols, ["SPY"]);
});

test("daily history produces volume ratios, 20/63-session realised volatility and returns", () => {
  const rows = parseEquityHistory(historyPayload());
  const summary = summarizeEquityHistory(rows);
  assert.equal(summary.session_count, 253);
  assert.ok(summary.returns["252d"] > 0);
  assert.ok(Number.isFinite(summary.realized_volatility["20d_annualized"]));
  assert.ok(Number.isFinite(summary.realized_volatility["63d_annualized"]));
  assert.equal(summary.volume.latest, 1_252_000);
  assert.ok(summary.volume.ratios.latest_to_63d > 1);
  assert.ok(Number.isFinite(summary.technical_levels.moving_averages["50d"]));
  assert.ok(Number.isFinite(summary.technical_levels.moving_averages["200d"]));
  assert.ok(Number.isFinite(summary.technical_levels.ranges["252d"].low));
  assert.ok(Number.isFinite(summary.technical_levels.ranges["252d"].high));
  assert.ok(summary.technical_levels.latest_vs_252d_low > 0);
});

test("relative performance aligns by session date rather than array position", () => {
  const subject = parseEquityHistory(historyPayload(100));
  const benchmark = subject
    .filter((_, index) => index % 7 !== 0)
    .map((row, index) => ({ ...row, close: 100 * (1.0004 ** index) }));
  const result = relativePerformance(subject, benchmark);
  assert.equal(result.aligned_session_count, benchmark.length);
  assert.ok(result.windows["21d"].excess_return > 0);
  assert.equal(result.latest_aligned_date, benchmark.at(-1).date);
});

test("an unfinished same-day Yahoo bar is excluded instead of being called a daily close", () => {
  const rows = parseEquityHistory(liveSessionPayload(), {
    asOf: "2026-08-05",
    observedAt: "2026-08-05T18:56:38Z",
  });
  assert.deepEqual(rows.map((row) => row.date), ["2026-08-04"]);
  assert.equal(summarizeEquityHistory(rows).latest_adjusted_close, 275);
});

test("a same-day Yahoo bar is retained after the provider session end", () => {
  const rows = parseEquityHistory(liveSessionPayload(), {
    asOf: "2026-08-05",
    observedAt: "2026-08-05T20:05:00Z",
  });
  assert.deepEqual(rows.map((row) => row.date), ["2026-08-04", "2026-08-05"]);
  assert.equal(summarizeEquityHistory(rows).latest_adjusted_close, 280.04);
});

test("a historical cutoff retains its completed cutoff-date bar", () => {
  const rows = parseEquityHistory(liveSessionPayload(), {
    asOf: "2026-08-04",
    observedAt: "2026-08-05T18:56:38Z",
  });
  assert.deepEqual(rows.map((row) => row.date), ["2026-08-04"]);
});
