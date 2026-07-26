import { LIMITS } from "./constants.mjs";
import { fetchText } from "./quotes.mjs";

/**
 * Keyless delayed options chains from CBOE.
 *
 * The options bench (Taleb / Natenberg / Sinclair) was written to refuse to name an IV
 * because the pipeline had no chain feed, and a model asked for one anyway will supply a
 * number from training data that reads exactly like a live one. CBOE's delayed-quotes
 * endpoint removes that gap: no key, full Greeks, open interest, ~3.5k contracts a name.
 *
 * What it still cannot give is IV *history*, so "IV is in the 80th percentile" remains
 * uncomputable here and must stay an open question rather than becoming a guess.
 */

const CBOE = (symbol) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`;

/** OSI-style contract symbol: root, YYMMDD, C|P, strike in thousandths. */
const CONTRACT = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export function parseContract(option) {
  const m = CONTRACT.exec(String(option || ""));
  if (!m) return null;
  const [, root, yy, mm, dd, right, strike] = m;
  return {
    root,
    expiry: `20${yy}-${mm}-${dd}`,
    right: right === "C" ? "call" : "put",
    strike: Number(strike) / 1000,
  };
}

const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);

/**
 * Is this row usable as a volatility observation?
 *
 * CBOE returns iv 0 for expired and deep-in-the-money contracts. Passing those through
 * would put a hard zero into an IV term structure, which is not a low volatility reading
 * -- it is a missing one, and it looks identical to a real number downstream.
 */
const usable = (row) => row.iv > 0 && Number.isFinite(row.iv) && row.dte > 0;

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const round = (n, places = 4) =>
  Number.isFinite(n) ? Number(n.toFixed(places)) : null;

/** The contract closest to a target delta on one side of one expiry. */
function nearestDelta(rows, expiry, right, targetAbsDelta) {
  const side = rows.filter((r) => r.expiry === expiry && r.right === right && Number.isFinite(r.delta));
  if (!side.length) return null;
  return side.reduce((best, r) =>
    Math.abs(Math.abs(r.delta) - targetAbsDelta) < Math.abs(Math.abs(best.delta) - targetAbsDelta) ? r : best);
}

/** Rows for one expiry ordered by distance from spot, nearest first. */
const byMoneyness = (rows, expiry, right, spot) =>
  rows.filter((r) => r.expiry === expiry && r.right === right)
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));

export function summarizeChain(payload, { asOf, maxExpiries = 8 } = {}) {
  const data = payload?.data;
  if (!data || !Array.isArray(data.options)) return null;
  const spot = Number(data.close) || Number(data.last_trade_price) || null;
  const today = asOf || new Date().toISOString().slice(0, 10);

  const all = data.options.map((o) => {
    const c = parseContract(o.option);
    if (!c) return null;
    return {
      ...c,
      dte: daysBetween(today, c.expiry),
      iv: Number(o.iv),
      delta: Number(o.delta),
      gamma: Number(o.gamma),
      theta: Number(o.theta),
      vega: Number(o.vega),
      oi: Number(o.open_interest) || 0,
      volume: Number(o.volume) || 0,
      bid: Number(o.bid) || 0,
      ask: Number(o.ask) || 0,
    };
  }).filter(Boolean);

  const live = all.filter(usable);
  const expiries = [...new Set(live.map((r) => r.expiry))].sort().slice(0, maxExpiries);

  // ATM implied vol per expiry -- the term structure, which is the one thing the options
  // bench needs before it can say whether a structure is cheap or expensive.
  const term = expiries.map((expiry) => {
    const call = byMoneyness(live, expiry, "call", spot)[0];
    const put = byMoneyness(live, expiry, "put", spot)[0];
    const ivs = [call?.iv, put?.iv].filter((v) => v > 0);
    return {
      expiry,
      dte: daysBetween(today, expiry),
      atm_strike: call?.strike ?? put?.strike ?? null,
      atm_iv: ivs.length ? round(ivs.reduce((a, b) => a + b, 0) / ivs.length) : null,
    };
  }).filter((t) => t.atm_iv !== null);

  // Skew and the headline IV are read from the first expiry at least a week out, not from
  // the nearest one. A one-day contract prices pin risk and discreteness rather than
  // volatility: on a live MU chain the 1-DTE ATM printed 69.6% between neighbours at 98.7%
  // and 105.2%. Quoting that as "front ATM IV" hands the reader the least reliable number
  // on the board as the summary of the whole surface.
  const MIN_REFERENCE_DTE = 7;
  const reference = term.find((t) => t.dte >= MIN_REFERENCE_DTE) || term[term.length - 1] || null;
  const front = reference?.expiry;
  const put25 = front ? nearestDelta(live, front, "put", 0.25) : null;
  const call25 = front ? nearestDelta(live, front, "call", 0.25) : null;
  const skew = put25 && call25 ? round(put25.iv - call25.iv) : null;

  const callOi = all.filter((r) => r.right === "call").reduce((a, r) => a + r.oi, 0);
  const putOi = all.filter((r) => r.right === "put").reduce((a, r) => a + r.oi, 0);
  const callVol = all.filter((r) => r.right === "call").reduce((a, r) => a + r.volume, 0);
  const putVol = all.filter((r) => r.right === "put").reduce((a, r) => a + r.volume, 0);

  // Where the open interest actually sits. Large concentrations act as reference points and
  // are far more informative than any single contract's price.
  const byStrike = new Map();
  for (const r of all) byStrike.set(r.strike, (byStrike.get(r.strike) || 0) + r.oi);
  const oiStrikes = [...byStrike.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([strike, oi]) => ({ strike, open_interest: oi, vs_spot_pct: spot ? round(((strike - spot) / spot) * 100, 1) : null }));

  // Sinclair's point: a theoretical edge dies in the spread. Quote it before anyone proposes
  // a structure, measured where it matters -- near the money on the front expiry.
  const atmRows = front ? byMoneyness(live, front, "call", spot).slice(0, 6).concat(byMoneyness(live, front, "put", spot).slice(0, 6)) : [];
  const spreads = atmRows
    .filter((r) => r.ask > 0 && r.bid >= 0 && (r.bid + r.ask) > 0)
    .map((r) => ((r.ask - r.bid) / ((r.ask + r.bid) / 2)) * 100);

  return {
    source: "CBOE delayed quotes (cdn.cboe.com), keyless",
    as_of: today,
    delayed: true,
    spot,
    contracts_total: all.length,
    contracts_with_iv: live.length,
    expiries_available: [...new Set(all.map((r) => r.expiry))].length,
    term_structure: term,
    // Which expiry the headline numbers below were read from, and why it may not be the
    // nearest one. Without this the reader cannot tell that a short expiry was skipped.
    reference_expiry: reference ? {
      expiry: reference.expiry,
      dte: reference.dte,
      atm_iv: reference.atm_iv,
      note: term[0] && term[0].dte < MIN_REFERENCE_DTE
        ? `Nearest expiry is ${term[0].expiry} at ${term[0].dte}d and was skipped for the headline: `
          + "under a week, an ATM implied vol reflects pin risk and discrete pricing more than volatility. "
          + "It remains in term_structure."
        : "Nearest expiry is at least a week out and is used directly.",
    } : null,
    skew_25delta: skew === null ? null : {
      expiry: front,
      put_iv: round(put25.iv),
      call_iv: round(call25.iv),
      put_minus_call: skew,
      reading: skew > 0 ? "downside protection bid (normal for equity)" : "upside bid (unusual; check for a takeover or squeeze narrative)",
    },
    open_interest: {
      calls: callOi,
      puts: putOi,
      put_call_ratio: callOi ? round(putOi / callOi, 3) : null,
    },
    volume: {
      calls: callVol,
      puts: putVol,
      put_call_ratio: callVol ? round(putVol / callVol, 3) : null,
    },
    largest_open_interest_strikes: oiStrikes,
    atm_spread_pct_of_mid: median(spreads) === null ? null : round(median(spreads), 1),
    // Named explicitly so the bench treats it as a gap rather than filling it in.
    unavailable: [
      "IV percentile or rank: this endpoint returns a snapshot, not history, so no statement "
      + "about IV being high or low versus its own past can be made from this data alone.",
      "realised volatility: not in this feed; compute it from price history if the view needs it.",
    ],
    caveat: "Delayed quotes, not live. Contracts reporting iv = 0 (expired or deep in the money) "
      + "are excluded from the term structure rather than read as zero volatility.",
  };
}

export async function fetchOptionsChain(symbol, { asOf } = {}) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) {
    return { symbol, available: false, reason: `"${symbol}" is not a symbol this feed accepts` };
  }
  let text;
  try {
    text = await fetchText(CBOE(sym), LIMITS.QUOTE_FETCH_MS * 3);
  } catch (error) {
    return {
      symbol: sym, available: false,
      reason: `CBOE delayed quotes unreachable: ${String(error?.message || error)}`,
    };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    // A 404 from the CDN is HTML, which is the normal answer for a name with no listed options.
    return { symbol: sym, available: false, reason: `no listed options found for ${sym} on CBOE (non-US listings are generally absent)` };
  }
  const summary = summarizeChain(payload, { asOf });
  if (!summary) return { symbol: sym, available: false, reason: `CBOE returned no option rows for ${sym}` };
  return { symbol: sym, available: true, ...summary };
}
