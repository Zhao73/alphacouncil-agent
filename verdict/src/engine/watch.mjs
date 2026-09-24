// Watchlist and track record. The watchlist shows each ticker against its latest verdict and
// raises alerts; the track record checks past verdicts against what the price did since.

import { join } from "node:path";
import * as data from "./data.mjs";
import { loadRun } from "./pipeline.mjs";
import { homeDir, listRuns, readJson, writeJson } from "./store.mjs";
import { parseRange } from "../render/html.mjs";

const file = () => join(homeDir(), "watchlist.json");

export function watchlist() {
  return readJson(file(), { symbols: [] }).symbols;
}

export function addWatch(...symbols) {
  const list = watchlist();
  for (const s of symbols) {
    const sym = data.normalizeSymbol(s);
    if (!list.includes(sym)) list.push(sym);
  }
  writeJson(file(), { symbols: list });
  return list;
}

export function removeWatch(...symbols) {
  const drop = new Set(symbols.map(data.normalizeSymbol));
  const list = watchlist().filter((s) => !drop.has(s));
  writeJson(file(), { symbols: list });
  return list;
}

/** Latest run with a decision for a symbol. */
export function lastVerdict(symbol) {
  const hit = listRuns().find((r) => r.symbol === symbol && r.rating);
  return hit ? loadRun(hit.run_id) : null;
}

/** Which price level (from the verdict) contains `price`. */
export function zoneFor(levels = [], price) {
  if (!Number.isFinite(price)) return null;
  for (const l of levels) {
    const r = parseRange(l.range);
    if (!r) continue;
    if ((r[0] === null || price >= r[0]) && (r[1] === null || price <= r[1])) return l;
  }
  return null;
}

export async function watchStatus({ symbols = watchlist(), quote = data.getQuote, filings = data.getFilings, now = Date.now() } = {}) {
  return Promise.all(symbols.map(async (symbol) => {
    const row = { symbol, price: null, currency: "", change_pct: null, rating: null, base: null, upside: null, zone: null, age_days: null, run_id: null, alerts: [], error: null };
    const run = lastVerdict(symbol);
    try {
      const q = await quote(symbol);
      Object.assign(row, { price: q.price, currency: q.currency, change_pct: q.change_pct });
    } catch (error) {
      row.error = error.message;
    }
    if (!run) {
      row.alerts.push("no verdict yet");
      return row;
    }
    const d = run.decision;
    row.run_id = run.run_id;
    row.name = run.name;
    row.rating = d.rating;
    row.base = d.valuation.base;
    row.age_days = Math.floor((now - Date.parse(run.created_at)) / 864e5);
    if (row.price) row.upside = ((d.valuation.base - row.price) / row.price) * 100;
    const zoneNow = zoneFor(d.price_levels, row.price);
    const zoneThen = zoneFor(d.price_levels, run.snapshot?.quote?.price);
    row.zone = zoneNow ? `${zoneNow.action} (${zoneNow.range})` : null;
    if (zoneNow && zoneNow !== zoneThen) row.alerts.push(`price entered the "${zoneNow.action}" zone ${zoneNow.range}`);
    if (row.age_days > 30) row.alerts.push(`verdict is ${row.age_days} days old`);
    try {
      const f = await filings(symbol, { forms: ["10-K", "10-Q", "8-K", "6-K", "20-F"], limit: 5 });
      const fresh = (f.filings || []).filter((x) => x.filed > run.as_of);
      if (fresh.length) row.alerts.push(`new filing since the verdict: ${fresh.map((x) => `${x.form} ${x.filed}`).join(", ")}`);
    } catch {
      // filings are optional (non-US names, outages)
    }
    return row;
  }));
}

const DIRECTION = { Buy: 1, Overweight: 1, Hold: 0, Underweight: -1, Sell: -1 };

export async function trackRecord({ quote = data.getQuote, minAgeDays = 1, now = Date.now() } = {}) {
  const runs = listRuns().filter((r) => r.rating && now - Date.parse(r.created_at) >= minAgeDays * 864e5);
  const prices = new Map();
  const rows = [];
  for (const r of runs) {
    const run = loadRun(r.run_id);
    const then = run.snapshot?.quote?.price;
    if (!Number.isFinite(then)) continue;
    if (!prices.has(r.symbol)) prices.set(r.symbol, await quote(r.symbol).then((q) => q.price).catch(() => null));
    const nowPx = prices.get(r.symbol);
    if (!Number.isFinite(nowPx)) continue;
    const ret = ((nowPx - then) / then) * 100;
    const dir = DIRECTION[r.rating] ?? 0;
    const hit = dir > 0 ? ret > 0 : dir < 0 ? ret < 0 : Math.abs(ret) < 5;
    rows.push({ run_id: r.run_id, symbol: r.symbol, date: r.created_at.slice(0, 10), rating: r.rating, then, now: nowPx, return_pct: Math.round(ret * 10) / 10, hit });
  }
  const hits = rows.filter((x) => x.hit).length;
  const bulls = rows.filter((x) => (DIRECTION[x.rating] ?? 0) > 0);
  return {
    rows,
    count: rows.length,
    hit_rate: rows.length ? Math.round((hits / rows.length) * 100) : null,
    avg_return_bullish: bulls.length ? Math.round((bulls.reduce((a, x) => a + x.return_pct, 0) / bulls.length) * 10) / 10 : null,
  };
}
