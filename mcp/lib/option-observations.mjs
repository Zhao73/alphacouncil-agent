import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR } from "./constants.mjs";
import { writeJson } from "./fsutil.mjs";

export const MIN_IV_PERCENTILE_OBSERVATIONS = 60;
export const MAX_OPTION_OBSERVATIONS = 500;

const SYMBOL = /^[A-Z][A-Z0-9.\-]{0,15}$/u;

export function optionObservationFile(symbol, dataDir = DATA_DIR) {
  const upper = String(symbol || "").trim().toUpperCase();
  if (!SYMBOL.test(upper)) throw new Error(`unsafe option symbol for observation ledger: ${JSON.stringify(symbol)}`);
  const root = join(dataDir, "option-observations");
  const file = resolve(root, `${upper.replace(/[^A-Z0-9]/gu, "_")}.json`);
  if (dirname(file) !== resolve(root)) throw new Error(`option observation path escaped its root: ${file}`);
  return file;
}

function readObservations(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.observations) ? parsed.observations : [];
  } catch {
    return [];
  }
}

function percentile(values, current) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length || !Number.isFinite(current)) return null;
  const less = sorted.filter((value) => value < current).length;
  const equal = sorted.filter((value) => value === current).length;
  return ((less + (0.5 * equal)) / sorted.length) * 100;
}

export function recordOptionObservation({
  symbol,
  observedAt,
  atmIv,
  expiry,
  dte,
  sourceUrl,
  dataDir = DATA_DIR,
} = {}) {
  if (!Number.isFinite(atmIv) || atmIv <= 0 || atmIv > 10) {
    return { status: "invalid_observation", observation_count: 0, percentile: null };
  }
  const date = typeof observedAt === "string" && Number.isFinite(Date.parse(observedAt))
    ? new Date(observedAt).toISOString().slice(0, 10)
    : null;
  if (!date) return { status: "invalid_observation", observation_count: 0, percentile: null };
  const file = optionObservationFile(symbol, dataDir);
  const prior = readObservations(file);
  const row = {
    date,
    observed_at: new Date(observedAt).toISOString(),
    atm_iv: atmIv,
    expiry: expiry || null,
    dte: Number.isFinite(dte) ? dte : null,
    source_url: sourceUrl || null,
  };
  const byDate = new Map(prior.map((entry) => [entry.date, entry]));
  // Same-day refresh replaces the earlier delayed snapshot instead of manufacturing two
  // independent observations from one trading session.
  byDate.set(date, row);
  const observations = [...byDate.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-MAX_OPTION_OBSERVATIONS);
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, {
    schema_version: 1,
    symbol: String(symbol).toUpperCase(),
    observations,
  }, { mode: 0o600 });
  const rank = observations.length >= MIN_IV_PERCENTILE_OBSERVATIONS
    ? percentile(observations.map((entry) => entry.atm_iv), atmIv)
    : null;
  return {
    status: rank === null ? "building_history" : "available",
    observation_count: observations.length,
    minimum_observations: MIN_IV_PERCENTILE_OBSERVATIONS,
    observations_needed: Math.max(0, MIN_IV_PERCENTILE_OBSERVATIONS - observations.length),
    percentile: rank === null ? null : Number(rank.toFixed(2)),
    window_start: observations[0]?.date || null,
    window_end: observations.at(-1)?.date || null,
    method: "empirical_midrank_of_one_reference_atm_iv_snapshot_per_trading_date",
    source: "local append-only CBOE snapshot ledger",
    file,
  };
}
