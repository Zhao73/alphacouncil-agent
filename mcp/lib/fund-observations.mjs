/**
 * An append-only ledger of what each run saw about a fund's size.
 *
 * A flow is shares created minus shares redeemed, priced. Two dated share counts are the whole
 * input, and no issuer serves a history of them keylessly: iShares publishes today's count in
 * the holdings file and answers 404 for a dated one, Invesco and Vanguard publish none at all.
 *
 * So the history is built rather than fetched. Every run already retrieves the holdings file;
 * recording what it said costs nothing and makes the second run onward able to compute a flow
 * exactly, by the arithmetic `fundFlow` already implements.
 *
 * This bootstraps, it does not backfill, and that is the honest trade. A user who looks at SOXX
 * weekly has weekly flows from the second week. It is not a vendor flow series and the fact
 * built from it says so.
 *
 * What this deliberately does NOT do is derive a flow from a change in assets. Assets move with
 * the market and with creations, and reporting the sum as the second is how this number gets
 * faked — in the direction that makes a rally look like conviction.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { DATA_DIR } from "./constants.mjs";

const LEDGER_DIRNAME = "fund-observations";

/** Keep a bounded history per fund; a flow only ever reads the two most recent rows. */
export const MAX_OBSERVATIONS_PER_FUND = 400;

const SYMBOL = /^[A-Z0-9][A-Z0-9.\-^]{0,15}$/u;

export function observationsRoot(dataDir = DATA_DIR) {
  return join(dataDir, LEDGER_DIRNAME);
}

/**
 * The ledger file for one symbol.
 *
 * A symbol arrives from a caller and becomes a path, so it is validated against a shape rather
 * than escaped: anything with a separator or a traversal segment is refused outright.
 */
export function observationFile(symbol, dataDir = DATA_DIR) {
  const upper = String(symbol || "").trim().toUpperCase();
  if (!SYMBOL.test(upper)) throw new Error(`unsafe fund symbol for a ledger path: ${JSON.stringify(symbol)}`);
  const root = observationsRoot(dataDir);
  const file = resolve(root, `${upper.replace(/[^A-Z0-9]/gu, "_")}.json`);
  if (dirname(file) !== resolve(root)) throw new Error(`ledger path escaped its root: ${file}`);
  return file;
}

function readLedger(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.observations) ? parsed.observations : [];
  } catch {
    // A corrupt ledger is not a reason to fail a research run. It is a reason to start a new
    // one, and to lose the history rather than to report a flow computed from garbage.
    return [];
  }
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Record one dated observation and return the ledger.
 *
 * Idempotent per as-of date: the same trading day seen twice does not create two rows, because
 * a flow between two rows of the same date is zero and would read as a real zero.
 */
export function recordFundObservation({
  symbol,
  asOf,
  sharesOutstanding = null,
  sharesBasis = null,
  nav = null,
  netAssets = null,
  sourceUrl = null,
  dataDir = DATA_DIR,
} = {}) {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/u.test(String(asOf))) return { observations: [], recorded: false };
  if (!finite(sharesOutstanding) && !finite(netAssets)) return { observations: [], recorded: false };
  const file = observationFile(symbol, dataDir);
  const existing = readLedger(file);
  if (existing.some((row) => row.as_of === asOf)) return { observations: existing, recorded: false };
  const observations = [...existing, {
    as_of: asOf,
    shares_outstanding: finite(sharesOutstanding) ? sharesOutstanding : null,
    // How the count was obtained decides whether it may price a flow. See `flowInputs`.
    shares_basis: sharesBasis || null,
    nav: finite(nav) ? nav : null,
    net_assets: finite(netAssets) ? netAssets : null,
    source_url: sourceUrl || null,
  }]
    .sort((left, right) => left.as_of.localeCompare(right.as_of))
    .slice(-MAX_OBSERVATIONS_PER_FUND);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ schema_version: 1, symbol: String(symbol).toUpperCase(), observations }, null, 2)}\n`, "utf8");
  return { observations, recorded: true };
}

/**
 * Share counts an issuer actually published. Nothing else may price a flow.
 *
 * Where an issuer publishes no count this repository reconstructs one from disclosed assets
 * over price, which is fine for a market capitalisation -- the product is the size we already
 * had. It is NOT fine for a flow. A flow is a DIFFERENCE of two counts, so it subtracts away
 * the number and leaves the noise: assets carry the error of a 95%-priced position sum, price
 * carries the fund's premium or discount, and half a percent at each end of a $300bn fund
 * manufactures $1.5bn of flow that never happened. Worse, that error is not centred on zero
 * from a reader's point of view -- it appears as conviction exactly when the market moved.
 */
const FILED_SHARE_BASES = new Set([
  "issuer_disclosed_shares_outstanding",
  // Assets and net asset value published by the same issuer on the same date. Their ratio is
  // shares outstanding by definition, not an approximation of it, so differencing two of them
  // is differencing two share counts.
  "issuer_aum_over_nav",
]);

/**
 * The two most recent observations that can price a flow, and how far apart they are.
 *
 * The gap matters and is returned rather than hidden: a flow measured across forty days is not
 * a daily flow, and a reader who cannot see the gap will read it as one.
 */
export function flowInputs(observations) {
  const priced = (observations || []).filter((row) => (
    finite(row?.shares_outstanding) && FILED_SHARE_BASES.has(row?.shares_basis)
  ));
  if (priced.length < 2) return null;
  const prior = priced.at(-2);
  const latest = priced.at(-1);
  const nav = finite(latest.nav)
    ? latest.nav
    : (finite(latest.net_assets) && latest.shares_outstanding > 0
      ? latest.net_assets / latest.shares_outstanding
      : null);
  if (!finite(nav) || nav <= 0) return null;
  return {
    sharesNow: latest.shares_outstanding,
    sharesPrior: prior.shares_outstanding,
    nav,
    asOf: latest.as_of,
    priorAsOf: prior.as_of,
    gapDays: Math.round((Date.parse(latest.as_of) - Date.parse(prior.as_of)) / 86_400_000),
    netAssets: finite(latest.net_assets) ? latest.net_assets : latest.shares_outstanding * nav,
  };
}
