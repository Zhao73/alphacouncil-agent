import { LIMITS } from "./constants.mjs";
import { fetchText } from "./quotes.mjs";

const TRADING_DAYS = 252;
const RETURN_WINDOWS = Object.freeze([5, 21, 63, 126, 252]);
const VOL_WINDOWS = Object.freeze([20, 63]);
const VOLUME_WINDOWS = Object.freeze([20, 63]);

const BROAD_BENCHMARK = "SPY";
const SIC_SECTOR_BENCHMARKS = Object.freeze([
  Object.freeze({ sics: new Set([3571, 3572, 3575, 3576, 3577, 3674]), symbol: "SMH", label: "semiconductors_and_computing_hardware" }),
  Object.freeze({ sics: new Set([7370, 7371, 7372, 7373, 7374]), symbol: "IGV", label: "software" }),
  Object.freeze({ sics: new Set([2833, 2834, 2835, 2836]), symbol: "XBI", label: "biotechnology_and_pharmaceuticals" }),
  Object.freeze({ sics: new Set([4812, 4813, 4822, 4899]), symbol: "IYZ", label: "telecommunications" }),
]);

export function benchmarkSymbolsForSic(sic) {
  const code = Number(sic);
  const sector = SIC_SECTOR_BENCHMARKS.find((entry) => entry.sics.has(code));
  return {
    broad: BROAD_BENCHMARK,
    sector: sector?.symbol || null,
    sector_basis: sector ? `sec_sic:${code}:${sector.label}` : null,
    symbols: [...new Set([sector?.symbol, BROAD_BENCHMARK].filter(Boolean))],
  };
}

export function equityHistoryUrl(symbol) {
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d&events=history`;
}

export function parseEquityHistory(json, { asOf = null } = {}) {
  const result = json?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(timestamps) || !Array.isArray(quote?.close)) return [];
  const rows = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const stamp = timestamps[index];
    const rawClose = quote.close[index];
    const adjustedClose = Array.isArray(adjusted) ? adjusted[index] : null;
    const close = Number.isFinite(adjustedClose) && adjustedClose > 0 ? adjustedClose : rawClose;
    if (!Number.isFinite(stamp) || !Number.isFinite(close) || close <= 0) continue;
    const date = new Date(stamp * 1000).toISOString().slice(0, 10);
    if (asOf && date > asOf) continue;
    const volume = Number.isFinite(quote.volume?.[index]) && quote.volume[index] >= 0
      ? quote.volume[index]
      : null;
    rows.push({ date, close, raw_close: Number.isFinite(rawClose) ? rawClose : null, volume });
  }
  return rows;
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function trailingReturn(rows, sessions) {
  if (!Array.isArray(rows) || rows.length <= sessions) return null;
  const latest = rows.at(-1)?.close;
  const base = rows.at(-(sessions + 1))?.close;
  return Number.isFinite(latest) && Number.isFinite(base) && base > 0 ? (latest / base) - 1 : null;
}

function realizedVolatility(rows, sessions) {
  if (!Array.isArray(rows) || rows.length <= sessions) return null;
  const tail = rows.slice(-(sessions + 1));
  const returns = [];
  for (let index = 1; index < tail.length; index += 1) {
    const previous = tail[index - 1].close;
    const current = tail[index].close;
    if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (returns.length - 1);
  return Math.sqrt(variance * TRADING_DAYS);
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

export function summarizeEquityHistory(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const latest = rows.at(-1);
  const returns = Object.fromEntries(RETURN_WINDOWS.map((sessions) => [
    `${sessions}d`,
    round(trailingReturn(rows, sessions)),
  ]));
  const realizedVol = Object.fromEntries(VOL_WINDOWS.map((sessions) => [
    `${sessions}d_annualized`,
    round(realizedVolatility(rows, sessions)),
  ]));
  const volume = {
    latest: Number.isFinite(latest.volume) ? latest.volume : null,
    averages: Object.fromEntries(VOLUME_WINDOWS.map((sessions) => [
      `${sessions}d`,
      round(average(rows.slice(-sessions).map((row) => row.volume)), 2),
    ])),
  };
  volume.ratios = Object.fromEntries(VOLUME_WINDOWS.map((sessions) => {
    const mean = volume.averages[`${sessions}d`];
    return [`latest_to_${sessions}d`, Number.isFinite(volume.latest) && mean > 0 ? round(volume.latest / mean, 4) : null];
  }));
  return {
    first_date: rows[0].date,
    latest_date: latest.date,
    session_count: rows.length,
    latest_adjusted_close: round(latest.close, 6),
    returns,
    realized_volatility: realizedVol,
    volume,
  };
}

function alignedRows(left, right) {
  const rightByDate = new Map(right.map((row) => [row.date, row]));
  return left.filter((row) => rightByDate.has(row.date)).map((row) => ({
    date: row.date,
    subject_close: row.close,
    benchmark_close: rightByDate.get(row.date).close,
  }));
}

function alignedReturn(rows, key, sessions) {
  if (rows.length <= sessions) return null;
  const latest = rows.at(-1)?.[key];
  const base = rows.at(-(sessions + 1))?.[key];
  return Number.isFinite(latest) && Number.isFinite(base) && base > 0 ? (latest / base) - 1 : null;
}

export function relativePerformance(subjectRows, benchmarkRows) {
  const aligned = alignedRows(subjectRows, benchmarkRows);
  const windows = Object.fromEntries(RETURN_WINDOWS.map((sessions) => {
    const subject = alignedReturn(aligned, "subject_close", sessions);
    const benchmark = alignedReturn(aligned, "benchmark_close", sessions);
    return [`${sessions}d`, {
      subject_return: round(subject),
      benchmark_return: round(benchmark),
      excess_return: Number.isFinite(subject) && Number.isFinite(benchmark) ? round(subject - benchmark) : null,
    }];
  }));
  return {
    aligned_session_count: aligned.length,
    first_aligned_date: aligned[0]?.date || null,
    latest_aligned_date: aligned.at(-1)?.date || null,
    windows,
  };
}

async function fetchOne(symbol, { asOf, signal } = {}) {
  const sourceUrl = equityHistoryUrl(symbol);
  const text = await fetchText(sourceUrl, LIMITS.QUOTE_FETCH_MS * 2, signal);
  const rows = parseEquityHistory(JSON.parse(text), { asOf });
  if (!rows.length) throw new Error(`${symbol}: no dated daily history`);
  return { symbol, source_url: sourceUrl, rows, summary: summarizeEquityHistory(rows) };
}

export async function fetchEquityMarketHistory(symbol, {
  asOf = null,
  sic = null,
  benchmarks = null,
  signal,
} = {}) {
  const retrievedAt = new Date().toISOString();
  const benchmarkPlan = Array.isArray(benchmarks)
    ? { broad: null, sector: null, sector_basis: "caller_supplied", symbols: [...new Set(benchmarks)] }
    : benchmarkSymbolsForSic(sic);
  const symbols = [...new Set([symbol, ...benchmarkPlan.symbols].filter(Boolean))];
  const settled = await Promise.allSettled(symbols.map((entry) => fetchOne(entry, { asOf, signal })));
  const bySymbol = new Map();
  const unavailable = [];
  settled.forEach((result, index) => {
    const entry = symbols[index];
    if (result.status === "fulfilled") bySymbol.set(entry, result.value);
    else unavailable.push(`${entry}: ${String(result.reason?.message || result.reason)}`);
  });
  const subject = bySymbol.get(symbol);
  if (!subject) {
    return {
      available: false,
      symbol,
      as_of: asOf,
      benchmark_plan: benchmarkPlan,
      unavailable,
    };
  }
  const relative = Object.fromEntries(benchmarkPlan.symbols
    .filter((benchmark) => bySymbol.has(benchmark))
    .map((benchmark) => [benchmark, relativePerformance(subject.rows, bySymbol.get(benchmark).rows)]));
  return {
    available: true,
    symbol,
    as_of: asOf,
    source: "Yahoo Finance chart endpoint, keyless delayed daily history",
    subject: subject.summary,
    benchmark_plan: benchmarkPlan,
    benchmarks: Object.fromEntries(benchmarkPlan.symbols
      .filter((benchmark) => bySymbol.has(benchmark))
      .map((benchmark) => [benchmark, bySymbol.get(benchmark).summary])),
    relative_performance: relative,
    source_records: [subject, ...benchmarkPlan.symbols.map((benchmark) => bySymbol.get(benchmark)).filter(Boolean)]
      .map((entry) => ({
        id: `market_history:${entry.symbol}:${entry.summary.latest_date}`,
        title: `${entry.symbol} one-year daily price and volume history`,
        url: entry.source_url,
        published_at: "unknown",
        retrieved_at: retrievedAt,
        observed_at: retrievedAt,
        source_kind: "dynamic_snapshot",
      })),
    unavailable,
    limitations: [
      "Daily adjusted closes are sufficient for historical returns and realised volatility, not intraday execution analysis.",
      "Yahoo is keyless and delayed; it is not a certified exchange feed.",
      benchmarkPlan.sector ? "The sector benchmark is selected deterministically from the issuer SEC SIC." : "No SIC-mapped sector benchmark was available; only the broad benchmark is used.",
    ],
  };
}
