/**
 * Market breadth, computed from the basket rather than bought from a screener.
 *
 * "What fraction of the index is above its 200-day average" is the classic breadth reading,
 * and every free source for it is either a screener whose robots.txt forbids the query or a
 * vendor feed. But the question only ever concerns one basket at a time, and the holdings of
 * that basket are already fetched -- so the honest way to get it is to compute it: one year of
 * daily closes per constituent, one moving average each, count how many are above.
 *
 * That is a real cost, one request per name, which is why it is bounded and why the result
 * always reports how much of the basket it actually measured. Breadth over 40% of the weights
 * is a different claim from breadth over 95%, and a reader cannot tell them apart from the
 * number alone.
 */

import { LIMITS } from "./constants.mjs";
import { fetchText } from "./quotes.mjs";

/** A 200-day average needs 200 closes; a year of trading gives about 252. */
export const BREADTH_WINDOW_DAYS = 200;
export const BREADTH_MIN_CLOSES = 200;
export const BREADTH_MAX_SYMBOLS = 120;
export const BREADTH_MIN_COVERAGE = 0.5;

export const chartUrl = (symbol) => (
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`
);

/**
 * Closing prices from a Yahoo chart payload, nulls removed.
 *
 * A halted or untraded session is written as null, not as the previous close. Dropping it is
 * correct for an average; carrying it forward would invent a print.
 */
export function parseDailyCloses(json) {
  const result = json?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes)) return null;
  const clean = closes.filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
  return clean.length ? clean : null;
}

/**
 * Closes paired with the session they belong to.
 *
 * `parseDailyCloses` drops the timestamps, which is fine for a moving average over one series
 * and wrong the moment two series are compared: Korea and the United States keep different
 * holidays, so aligning by array position compares a Tuesday with a Wednesday and produces a
 * correlation that is confidently wrong rather than visibly broken.
 */
export function parseDatedCloses(json) {
  const result = json?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  const stamps = result?.timestamp;
  if (!Array.isArray(closes) || !Array.isArray(stamps) || closes.length !== stamps.length) return null;
  const rows = [];
  for (let index = 0; index < closes.length; index += 1) {
    const close = closes[index];
    const stamp = stamps[index];
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) continue;
    if (typeof stamp !== "number" || !Number.isFinite(stamp)) continue;
    rows.push({ date: new Date(stamp * 1000).toISOString().slice(0, 10), close });
  }
  return rows.length ? rows : null;
}

/** Simple moving average of the last `window` closes, or null when there is not enough history. */
export function movingAverage(closes, window = BREADTH_WINDOW_DAYS) {
  if (!Array.isArray(closes) || closes.length < window) return null;
  const tail = closes.slice(-window);
  return tail.reduce((sum, value) => sum + value, 0) / tail.length;
}

export function isAboveAverage(closes, window = BREADTH_WINDOW_DAYS) {
  const average = movingAverage(closes, window);
  if (average === null) return null;
  return closes.at(-1) > average;
}

/**
 * Weighted share of a basket trading above its own 200-day average.
 *
 * Weighted, not counted: a breadth reading that treats the largest and smallest holding alike
 * describes a portfolio nobody owns. The unweighted count is returned alongside it, because
 * the gap between the two IS the concentration story -- a cap-weighted basket can be above its
 * average on weight while most of its members are below.
 */
export async function fetchBasketBreadth(holdings, { signal, concurrency = 8 } = {}) {
  const unavailable = [];
  const ranked = [...(holdings || [])]
    .filter((row) => row?.ticker && Number.isFinite(row.weight) && row.weight > 0)
    .sort((left, right) => right.weight - left.weight)
    .slice(0, BREADTH_MAX_SYMBOLS);
  if (!ranked.length) {
    return { available: false, unavailable: ["breadth: the basket published no weighted holdings"] };
  }

  const measured = [];
  const queue = [...ranked];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        const closes = parseDailyCloses(JSON.parse(await fetchText(chartUrl(next.ticker), LIMITS.QUOTE_FETCH_MS, signal)));
        if (!closes || closes.length < BREADTH_MIN_CLOSES) {
          unavailable.push(`breadth ${next.ticker}: fewer than ${BREADTH_MIN_CLOSES} daily closes in the last year`);
          continue;
        }
        const above = isAboveAverage(closes);
        if (above === null) continue;
        measured.push({ ticker: next.ticker, weight: next.weight, above, close: closes.at(-1), units: next.units });
      } catch (error) {
        unavailable.push(`breadth ${next.ticker}: ${String(error?.message || error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ranked.length) }, worker));

  const coverage = measured.reduce((sum, row) => sum + row.weight, 0);
  if (!measured.length || coverage < BREADTH_MIN_COVERAGE) {
    unavailable.push(
      `breadth: measured ${(coverage * 100).toFixed(1)}% of basket weight, below the ${BREADTH_MIN_COVERAGE * 100}% floor`,
    );
    return { available: false, coverage_weight: Number(coverage.toFixed(6)), measured: measured.length, unavailable };
  }
  const aboveWeight = measured.filter((row) => row.above).reduce((sum, row) => sum + row.weight, 0);
  const aboveCount = measured.filter((row) => row.above).length;
  // The same closes price the basket. An issuer that publishes unit counts but no assets
  // under management -- which is the common case outside the two largest -- gets its size
  // from the positions it disclosed, rather than staying an unexplained blank.
  const priced = measured.filter((row) => Number.isFinite(row.units) && row.units > 0);
  const pricedWeight = priced.reduce((sum, row) => sum + row.weight, 0);
  const netAssets = priced.reduce((sum, row) => sum + (row.units * row.close), 0);
  return Object.freeze({
    available: true,
    // The last close per constituent, already fetched to compute breadth. A market
    // capitalisation is a share count times a price, and this is the price -- re-fetching it
    // would be forty quotes for numbers that are in hand.
    closes: Object.freeze(Object.fromEntries(measured.map((row) => [row.ticker, row.close]))),
    // Only meaningful when nearly the whole basket was priced; a partial sum is not the fund.
    net_assets: pricedWeight >= 0.95 && netAssets > 0 ? Number(netAssets.toFixed(2)) : null,
    net_assets_coverage: Number(pricedWeight.toFixed(6)),
    weighted_above: Number((aboveWeight / coverage).toFixed(6)),
    counted_above: Number((aboveCount / measured.length).toFixed(6)),
    coverage_weight: Number(coverage.toFixed(6)),
    measured: measured.length,
    window_days: BREADTH_WINDOW_DAYS,
    method: "share_of_constituents_trading_above_their_own_200_day_simple_average",
    unavailable,
  });
}
