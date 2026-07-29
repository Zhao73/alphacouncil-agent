/**
 * How a basket moves against other markets, and how its own sectors are moving apart.
 *
 * Every seat that reasons about crowding, reflexivity or position size needs to know what else
 * a holding is a bet on. Dalio's own authored policy limits size by correlation; Soros needs a
 * loop that runs between markets; Marks reads dispersion as where the cycle stands. None of
 * them could ask, because nothing here compared one market with another.
 *
 * The inputs are daily closes, from the same keyless endpoint the breadth pass already uses,
 * so a correlation costs one fetch per reference series and nothing per constituent.
 *
 * Two disciplines are enforced rather than assumed:
 *
 *   1. **Sessions are aligned by date, not by position.** Korea and the United States do not
 *      share a holiday calendar, and zipping two arrays by index silently compares a Tuesday
 *      with a Wednesday — which produces a correlation that is confidently wrong rather than
 *      obviously broken.
 *   2. **A short overlap produces nothing.** A correlation over twenty paired sessions is
 *      noise with a decimal point on it.
 */

import { LIMITS } from "./constants.mjs";
import { chartUrl, parseDatedCloses } from "./breadth.mjs";
import { fetchText } from "./quotes.mjs";

/** Windows the facts are published over. Both are stated on the fact, never implied. */
export const CORRELATION_WINDOW_DAYS = 60;

/** Below this many paired sessions a correlation is not reported at all. */
export const MIN_PAIRED_SESSIONS = 40;

/**
 * Reference markets a US basket is worth being correlated against.
 *
 * Korea is here because it is the clearest listed read on the semiconductor and export cycle
 * outside the United States: KOSPI's index weight is dominated by memory and display, so a
 * semiconductor basket that has decoupled from it has decoupled from its own end demand.
 */
export const REFERENCE_MARKETS = Object.freeze({
  "^GSPC": { label: "S&P 500", why: "the broad US market a US basket is measured against" },
  "^KS11": { label: "KOSPI", why: "Korea's main board, weighted toward memory and export manufacturing" },
  "^KQ11": { label: "KOSDAQ", why: "Korea's growth board, a read on domestic risk appetite rather than exporters" },
  "^SOX": { label: "PHLX Semiconductor", why: "the semiconductor cycle as a listed series" },
});

/** The eleven Select Sector SPDRs, which between them partition the S&P 500. */
export const SECTOR_SPDRS = Object.freeze(["XLK","XLF","XLE","XLV","XLI","XLY","XLP","XLU","XLB","XLRE","XLC"]);

const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** Pearson correlation of two equal-length return series. */
export function correlation(left, right) {
  if (!Array.isArray(left) || left.length !== right?.length || left.length < 2) return null;
  const n = left.length;
  const meanLeft = left.reduce((sum, value) => sum + value, 0) / n;
  const meanRight = right.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceLeft = 0;
  let varianceRight = 0;
  for (let index = 0; index < n; index += 1) {
    const dl = left[index] - meanLeft;
    const dr = right[index] - meanRight;
    covariance += dl * dr;
    varianceLeft += dl * dl;
    varianceRight += dr * dr;
  }
  if (varianceLeft <= 0 || varianceRight <= 0) return null;
  return covariance / Math.sqrt(varianceLeft * varianceRight);
}

/**
 * Daily returns for the sessions two series actually share.
 *
 * Aligning on the date is the whole point. Two markets with different holidays produce arrays
 * of different lengths whose positions do not correspond, and comparing them by position is
 * the standard way a cross-market correlation ends up measuring nothing.
 */
export function alignedReturns(left, right, windowDays = CORRELATION_WINDOW_DAYS) {
  const rightByDate = new Map((right || []).map((row) => [row.date, row.close]));
  const paired = [];
  for (const row of left || []) {
    const other = rightByDate.get(row.date);
    if (finite(row.close) && finite(other)) paired.push({ date: row.date, left: row.close, right: other });
  }
  const window = paired.slice(-(windowDays + 1));
  if (window.length < MIN_PAIRED_SESSIONS) return null;
  const returns = { left: [], right: [], sessions: window.length - 1, from: window[0].date, to: window.at(-1).date };
  for (let index = 1; index < window.length; index += 1) {
    returns.left.push(window[index].left / window[index - 1].left - 1);
    returns.right.push(window[index].right / window[index - 1].right - 1);
  }
  return returns;
}

async function datedCloses(symbol, signal) {
  try {
    return parseDatedCloses(JSON.parse(await fetchText(chartUrl(symbol), LIMITS.QUOTE_FETCH_MS, signal)));
  } catch {
    return null;
  }
}

/**
 * Correlation and relative strength of one symbol against each reference market.
 *
 * Relative strength travels with the correlation on purpose. A correlation of 0.9 says two
 * markets move together and says nothing about which one is winning; a reader given only the
 * first will supply the second from imagination.
 */
export async function fetchCrossMarket(symbol, { signal, references = REFERENCE_MARKETS } = {}) {
  const facts = [];
  const unavailable = [];
  const subject = await datedCloses(symbol, signal);
  if (!subject?.length) {
    return { facts, unavailable: [`cross-market: no daily closes for ${symbol}`] };
  }
  for (const [reference, meta] of Object.entries(references)) {
    if (String(reference).toUpperCase() === String(symbol).toUpperCase()) continue;
    const other = await datedCloses(reference, signal);
    if (!other?.length) { unavailable.push(`cross-market ${reference}: no daily closes`); continue; }
    const returns = alignedReturns(subject, other);
    if (!returns) {
      unavailable.push(
        `cross-market ${reference}: fewer than ${MIN_PAIRED_SESSIONS} sessions shared with ${symbol};`
        + " the two calendars do not overlap enough to compare",
      );
      continue;
    }
    const rho = correlation(returns.left, returns.right);
    if (!finite(rho)) { unavailable.push(`cross-market ${reference}: a series did not move over the window`); continue; }
    const total = (series) => series.reduce((compound, value) => compound * (1 + value), 1) - 1;
    facts.push({
      reference,
      label: meta.label,
      why: meta.why,
      correlation: Number(rho.toFixed(4)),
      relative_return: Number((total(returns.left) - total(returns.right)).toFixed(6)),
      sessions: returns.sessions,
      from: returns.from,
      to: returns.to,
    });
  }
  return { facts, unavailable };
}

/**
 * How far apart a set of sector baskets has travelled over the window.
 *
 * One number, and it is a real one: the standard deviation of sector total returns. A market
 * whose sectors all return the same thing is being repriced by one factor; a market whose
 * sectors have separated is being repriced by many, and those are different regimes to own.
 */
export async function fetchSectorDispersion(symbols, { signal } = {}) {
  const returns = [];
  const unavailable = [];
  let window = null;
  for (const symbol of symbols || []) {
    const closes = await datedCloses(symbol, signal);
    const tail = (closes || []).slice(-(CORRELATION_WINDOW_DAYS + 1));
    if (tail.length < MIN_PAIRED_SESSIONS) { unavailable.push(`sector dispersion ${symbol}: too few sessions`); continue; }
    returns.push({ symbol, value: tail.at(-1).close / tail[0].close - 1 });
    window = { from: tail[0].date, to: tail.at(-1).date, sessions: tail.length - 1 };
  }
  if (returns.length < 3) {
    return { available: false, unavailable: [...unavailable, "sector dispersion: fewer than three sectors priced"] };
  }
  const mean = returns.reduce((sum, row) => sum + row.value, 0) / returns.length;
  const variance = returns.reduce((sum, row) => sum + (row.value - mean) ** 2, 0) / returns.length;
  const sorted = [...returns].sort((left, right) => right.value - left.value);
  return {
    available: true,
    dispersion: Number(Math.sqrt(variance).toFixed(6)),
    mean_return: Number(mean.toFixed(6)),
    leader: sorted[0],
    laggard: sorted.at(-1),
    measured: returns.length,
    ...window,
    unavailable,
  };
}
