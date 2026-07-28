/**
 * Keyless FRED series, with history.
 *
 * The macro block already gives point-in-time market prices, and a snapshot is enough for a
 * level but not for an impulse. A "liquidity impulse" or a "growth regime" computed from one
 * day of quotes is fabricated precision, so those readings need an actual series behind them.
 *
 * `api.stlouisfed.org` requires a key; the CSV graph endpoint does not, and it returns the
 * full observation history. That is the only reason this module exists as a separate feed:
 * everything here is a dated observation published by the source, so it can carry real
 * lineage into the typed-fact pack instead of being asserted at the run's `as_of`.
 *
 * Deliberately NOT here: any single number claiming to be "the regime". The series are
 * inputs. The composites below are named for exactly what they compute and carry their own
 * window, so a reader can disagree with the window rather than with an opaque score.
 */

import { LIMITS } from "./constants.mjs";
import { fetchText } from "./quotes.mjs";

const FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=";

/**
 * Units are not uniform across FRED and mixing them silently is the obvious way to produce a
 * confident wrong number: WALCL is millions of dollars while RRPONTSYD is billions. Every
 * series therefore declares its scale, and the composites below convert explicitly.
 */
export const FRED_SERIES = Object.freeze({
  DGS10: { fact: "macro.long_bond_yield", unit: "percent", label: "10-year Treasury constant maturity" },
  DGS2: { fact: "macro.short_bond_yield", unit: "percent", label: "2-year Treasury constant maturity" },
  DGS3MO: { fact: null, unit: "percent", label: "3-month Treasury constant maturity" },
  T10Y3M: { fact: "macro.term_structure_slope", unit: "percent", label: "10-year minus 3-month Treasury" },
  DFII10: { fact: "macro.real_rate", unit: "percent", label: "10-year TIPS real yield" },
  T5YIE: { fact: "macro.breakeven_inflation", unit: "percent", label: "5-year breakeven inflation" },
  AAA: { fact: "macro.aaa_corporate_yield", unit: "percent", label: "Moody's seasoned Aaa corporate bond yield" },
  BAMLH0A0HYM2: { fact: "macro.credit_spread", unit: "percent", label: "ICE BofA US high yield option-adjusted spread" },
  WALCL: { fact: null, unit: "usd_millions", label: "Federal Reserve total assets" },
  RRPONTSYD: { fact: null, unit: "usd_billions", label: "Overnight reverse repurchase agreements" },
  WTREGEN: { fact: null, unit: "usd_millions", label: "Treasury General Account balance" },
});

export function seriesUrl(id) {
  return `${FRED_CSV}${encodeURIComponent(id)}`;
}

/**
 * FRED writes `.` for a missing observation on a holiday or a not-yet-published date. Those
 * rows are dropped rather than carried forward: a stale value silently reused as today's
 * reading is the failure mode this whole pipeline is built to avoid.
 */
export function parseFredCsv(csv, id) {
  const lines = String(csv || "").trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error(`empty FRED series ${id}`);
  const header = lines[0].split(",");
  if (header.length < 2) throw new Error(`unexpected FRED header for ${id}: ${lines[0]}`);
  const observations = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(date || "").trim())) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    observations.push({ date: date.trim(), value });
  }
  if (!observations.length) throw new Error(`no numeric observations in FRED series ${id}`);
  return observations;
}

export async function fetchFredSeries(id, { signal, asOf = null } = {}) {
  if (!Object.prototype.hasOwnProperty.call(FRED_SERIES, id)) {
    throw new Error(`unknown FRED series: ${id}`);
  }
  const url = seriesUrl(id);
  const observations = parseFredCsv(await fetchText(url, LIMITS.QUOTE_FETCH_MS * 2, signal), id);
  // A historical cutoff must not see observations published after it.
  const visible = asOf ? observations.filter((row) => row.date <= String(asOf).slice(0, 10)) : observations;
  if (!visible.length) throw new Error(`FRED series ${id} has no observation at or before ${asOf}`);
  const last = visible.at(-1);
  return Object.freeze({
    id,
    ...FRED_SERIES[id],
    observations: visible,
    latest: last.value,
    // The observation date IS the publication anchor for this feed, so it never has to be
    // stamped with the run time.
    public_at: `${last.date}T00:00:00.000Z`,
    observation_date: last.date,
    source_url: url,
  });
}

/** Value `windowDays` calendar days before the latest observation, or null when unavailable. */
export function valueBefore(series, windowDays) {
  const rows = series?.observations;
  if (!Array.isArray(rows) || !rows.length) return null;
  const cutoff = new Date(`${rows.at(-1).date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - windowDays);
  const target = cutoff.toISOString().slice(0, 10);
  const prior = rows.filter((row) => row.date <= target);
  return prior.length ? prior.at(-1) : null;
}

/**
 * Where the latest observation sits in its own history, as a 0-1 rank.
 *
 * Reported with the sample it was computed against, because "the 92nd percentile" means
 * nothing without saying percentile of what and since when.
 */
export function percentileRank(series, { sinceDays = 365 * 10 } = {}) {
  const rows = series?.observations;
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const start = valueBefore(series, sinceDays);
  const sample = start ? rows.filter((row) => row.date >= start.date) : rows;
  if (sample.length < 30) return null;
  const latest = rows.at(-1).value;
  const below = sample.filter((row) => row.value < latest).length;
  return {
    percentile: Number((below / sample.length).toFixed(4)),
    sample_size: sample.length,
    sample_start: sample[0].date,
    sample_end: rows.at(-1).date,
  };
}

/**
 * Fed balance sheet less the two largest sterilising liabilities, in millions of dollars.
 *
 * This is the common "net liquidity" construction, not an official series. It is labelled as
 * derived and its inputs are returned so the arithmetic can be checked, including the
 * billions-to-millions conversion on the reverse repo leg.
 */
export function netLiquidity({ walcl, rrp, tga }) {
  if (!walcl?.observations?.length) return null;
  const byDate = (series) => new Map((series?.observations || []).map((row) => [row.date, row.value]));
  const rrpByDate = byDate(rrp);
  const tgaByDate = byDate(tga);
  const nearest = (map, date) => {
    if (!map.size) return null;
    const keys = [...map.keys()].filter((key) => key <= date);
    return keys.length ? map.get(keys.at(-1)) : null;
  };
  const observations = [];
  for (const row of walcl.observations) {
    const rrpValue = nearest(rrpByDate, row.date);
    const tgaValue = nearest(tgaByDate, row.date);
    if (rrpValue === null || tgaValue === null) continue;
    // RRPONTSYD is billions; WALCL and WTREGEN are millions.
    observations.push({ date: row.date, value: row.value - (rrpValue * 1000) - tgaValue });
  }
  if (!observations.length) return null;
  return Object.freeze({
    id: "NET_LIQUIDITY",
    unit: "usd_millions",
    label: "Fed total assets less reverse repo and Treasury General Account",
    derived_from: ["WALCL", "RRPONTSYD", "WTREGEN"],
    observations,
    latest: observations.at(-1).value,
    observation_date: observations.at(-1).date,
    public_at: `${observations.at(-1).date}T00:00:00.000Z`,
    source_url: [walcl.source_url, rrp?.source_url, tga?.source_url].filter(Boolean),
  });
}

/**
 * Change in net liquidity over a window, as a fraction of the level at the start of it.
 *
 * A level tells you nothing about direction, and direction is the whole content of this
 * reading, so the window is part of the value and travels with it.
 */
export function liquidityImpulse(series, { windowDays = 91 } = {}) {
  const start = valueBefore(series, windowDays);
  if (!start || !series?.observations?.length || !start.value) return null;
  const latest = series.observations.at(-1);
  return {
    value: Number(((latest.value - start.value) / Math.abs(start.value)).toFixed(6)),
    window_days: windowDays,
    from_date: start.date,
    to_date: latest.date,
    from_value: start.value,
    to_value: latest.value,
  };
}

const REGIME_STATES = Object.freeze([
  "rising_growth_rising_inflation",
  "rising_growth_falling_inflation",
  "falling_growth_rising_inflation",
  "falling_growth_falling_inflation",
]);

/**
 * The growth/inflation quadrant, from the direction of two market-priced series.
 *
 * Growth uses the curve slope (steepening prices growth and term premium, inversion prices
 * the opposite) and inflation uses the breakeven. Returns null rather than a quadrant when
 * either axis lacks the history to have a direction at all -- an unknown regime is a gap, and
 * a seat that needs one should decline rather than receive a coin flip.
 */
export function growthInflationRegime({ slope, breakeven, windowDays = 91 }) {
  const direction = (series) => {
    const start = valueBefore(series, windowDays);
    if (!start || !series?.observations?.length) return null;
    return series.observations.at(-1).value - start.value;
  };
  const growth = direction(slope);
  const inflation = direction(breakeven);
  if (growth === null || inflation === null) return null;
  const state = `${growth >= 0 ? "rising" : "falling"}_growth_${inflation >= 0 ? "rising" : "falling"}_inflation`;
  if (!REGIME_STATES.includes(state)) return null;
  return {
    state,
    window_days: windowDays,
    growth_axis: { series: slope.id, change: Number(growth.toFixed(4)) },
    inflation_axis: { series: breakeven.id, change: Number(inflation.toFixed(4)) },
  };
}

export const MACRO_FRED_SERIES = Object.freeze([
  "DGS10", "DGS2", "T10Y3M", "DFII10", "T5YIE", "AAA", "BAMLH0A0HYM2",
  "WALCL", "RRPONTSYD", "WTREGEN",
]);

/**
 * Fetch the macro series set concurrently. A failed series is a named gap, never a zero.
 */
export async function fetchMacroSeries({ ids = MACRO_FRED_SERIES, signal, asOf = null } = {}) {
  const results = await Promise.all(ids.map((id) => fetchFredSeries(id, { signal, asOf })
    .then((series) => ({ ok: true, id, series }))
    .catch((error) => ({ ok: false, id, error: String(error?.message || error) }))));
  const series = {};
  const unavailable = [];
  for (const result of results) {
    if (result.ok) series[result.id] = result.series;
    else unavailable.push(`FRED ${result.id}: ${result.error}`);
  }
  const liquidity = netLiquidity({ walcl: series.WALCL, rrp: series.RRPONTSYD, tga: series.WTREGEN });
  return {
    series,
    net_liquidity: liquidity,
    liquidity_impulse: liquidity ? liquidityImpulse(liquidity) : null,
    regime: series.T10Y3M && series.T5YIE
      ? growthInflationRegime({ slope: series.T10Y3M, breakeven: series.T5YIE })
      : null,
    credit_spread_percentile: series.BAMLH0A0HYM2 ? percentileRank(series.BAMLH0A0HYM2) : null,
    unavailable,
  };
}
