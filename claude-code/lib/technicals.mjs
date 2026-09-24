// Positional price facts computed from daily bars. No pattern forecasting.

const round = (x, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

function pctChange(from, to) {
  return Number.isFinite(from) && Number.isFinite(to) && from !== 0 ? ((to - from) / from) * 100 : null;
}

function sma(values, n) {
  if (values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i += 1) sum += values[i];
  return sum / n;
}

function rsi(values, n = 14) {
  if (values.length <= n) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i += 1) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  for (let i = n + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
    avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function realizedVol(values, n) {
  if (values.length <= n) return null;
  const rets = [];
  for (let i = values.length - n; i < values.length; i += 1) rets.push(Math.log(values[i] / values[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

function maxDrawdown(values) {
  let peak = -Infinity;
  let worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    worst = Math.min(worst, (v - peak) / peak);
  }
  return worst * 100;
}

/** Close `sessions` trading days before the last bar, or null when history is too short. */
function back(values, sessions) {
  return values.length > sessions ? values[values.length - 1 - sessions] : null;
}

/**
 * @param {{date:string, close:number, volume?:number}[]} bars ascending by date
 */
export function computeTechnicals(bars) {
  const clean = bars.filter((b) => Number.isFinite(b.close) && b.close > 0);
  if (clean.length < 2) return { available: false, reason: "fewer than two valid daily bars" };
  const closes = clean.map((b) => b.close);
  const volumes = clean.map((b) => b.volume).filter((v) => Number.isFinite(v));
  const last = closes[closes.length - 1];
  const year = closes.slice(-252);
  const hi = Math.max(...year);
  const lo = Math.min(...year);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const vol20 = volumes.length >= 20 ? sma(volumes, 20) : null;
  const vol63 = volumes.length >= 63 ? sma(volumes, 63) : null;
  return {
    available: true,
    as_of: clean[clean.length - 1].date,
    bars: clean.length,
    last_close: round(last),
    return_1w_pct: round(pctChange(back(closes, 5), last)),
    return_1m_pct: round(pctChange(back(closes, 21), last)),
    return_3m_pct: round(pctChange(back(closes, 63), last)),
    return_6m_pct: round(pctChange(back(closes, 126), last)),
    return_12m_pct: round(pctChange(back(closes, 252), last)),
    // 12-1 momentum: twelve-month return skipping the most recent month.
    momentum_12_1_pct: round(pctChange(back(closes, 252), back(closes, 21))),
    high_52w: round(hi),
    low_52w: round(lo),
    pct_from_52w_high: round(pctChange(hi, last)),
    pct_from_52w_low: round(pctChange(lo, last)),
    sma50: round(sma50),
    sma200: round(sma200),
    pct_vs_sma50: round(pctChange(sma50, last)),
    pct_vs_sma200: round(pctChange(sma200, last)),
    rsi14: round(rsi(closes, 14), 1),
    realized_vol_30d_pct: round(realizedVol(closes, 30), 1),
    realized_vol_90d_pct: round(realizedVol(closes, 90), 1),
    max_drawdown_1y_pct: round(maxDrawdown(year), 1),
    volume_20d_vs_3m: vol20 && vol63 ? round(vol20 / vol63) : null,
  };
}
