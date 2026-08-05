import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DATA_DIR } from "./constants.mjs";
import { writeJson } from "./fsutil.mjs";

export const MAX_COMPANY_OBSERVATIONS = 5_000;
const SYMBOL = /^[A-Z][A-Z0-9.\-]{0,15}$/u;

export function companyObservationFile(symbol, dataDir = DATA_DIR) {
  const upper = String(symbol || "").trim().toUpperCase();
  if (!SYMBOL.test(upper)) throw new Error(`unsafe company symbol for observation ledger: ${JSON.stringify(symbol)}`);
  const root = join(dataDir, "company-observations");
  const file = resolve(root, `${upper.replace(/[^A-Z0-9]/gu, "_")}.json`);
  if (dirname(file) !== resolve(root)) throw new Error(`company observation path escaped its root: ${file}`);
  return file;
}

function readLedger(file) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.observations) ? parsed.observations : [];
  } catch {
    return [];
  }
}

function boundedData(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = typeof data.value === "number" || typeof data.value === "string" ? data.value : null;
  const range = data.range && [data.range.low, data.range.base, data.range.high].every(Number.isFinite)
    ? { low: data.range.low, base: data.range.base, high: data.range.high }
    : null;
  if (value === null && range === null) return null;
  return {
    metric: typeof data.metric === "string" ? data.metric.slice(0, 160) : null,
    value,
    range,
    unit: typeof data.unit === "string" ? data.unit.slice(0, 80) : null,
    period: typeof data.period === "string" ? data.period.slice(0, 120) : null,
    scope: typeof data.scope === "string" ? data.scope.slice(0, 180) : null,
    formula: typeof data.formula === "string" ? data.formula.slice(0, 600) : null,
  };
}

function boundedObservation(observation, parent = null) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return null;
  const value = typeof observation.value === "number" || typeof observation.value === "string" || typeof observation.value === "boolean"
    ? observation.value
    : null;
  if (value === null || (typeof value === "number" && !Number.isFinite(value))) return null;
  return {
    metric: typeof observation.metric === "string" ? observation.metric.slice(0, 160) : null,
    value,
    range: null,
    unit: typeof observation.unit === "string" ? observation.unit.slice(0, 80) : null,
    period: typeof observation.period === "string" ? observation.period.slice(0, 120) : null,
    scope: typeof observation.scope === "string" ? observation.scope.slice(0, 180) : null,
    formula: typeof observation.formula === "string"
      ? observation.formula.slice(0, 600)
      : typeof parent?.formula === "string" ? parent.formula.slice(0, 600) : null,
  };
}

export function recordCompanyAcquisitionObservations({
  symbol,
  observedAt = new Date().toISOString(),
  task,
  ledger,
  dataDir = DATA_DIR,
} = {}) {
  const instant = Date.parse(observedAt);
  if (!Number.isFinite(instant) || !ledger || !Array.isArray(ledger.items)) {
    return { status: "invalid_observation", recorded: 0, observation_count: 0 };
  }
  const date = new Date(instant).toISOString().slice(0, 10);
  const rows = ledger.items.flatMap((item) => {
    if (!["reported_actual", "recomputed_proxy", "modeled_estimate"].includes(item?.outcome)) return [];
    const values = ["reported_actual", "recomputed_proxy"].includes(item.outcome)
      && Array.isArray(item?.data?.observations)
      ? item.data.observations.map((observation) => boundedObservation(observation, item.data)).filter(Boolean)
      : [boundedData(item.data)].filter(Boolean);
    return values.map((data) => ({
      date,
      observed_at: new Date(instant).toISOString(),
      task: String(task || ledger.task || "").slice(0, 80),
      coverage_id: String(item.coverage_id || "").slice(0, 160),
      outcome: item.outcome,
      source_ids: Array.isArray(item.source_ids) ? item.source_ids.slice(0, 24) : [],
      ...data,
    }));
  });
  const file = companyObservationFile(symbol, dataDir);
  const prior = readLedger(file);
  const byKey = new Map(prior.map((row) => [
    `${row.date}|${row.task}|${row.coverage_id}|${row.outcome}|${row.metric || ""}|${row.period || ""}|${row.unit || ""}|${row.scope || ""}`,
    row,
  ]));
  for (const row of rows) {
    byKey.set(`${row.date}|${row.task}|${row.coverage_id}|${row.outcome}|${row.metric || ""}|${row.period || ""}|${row.unit || ""}|${row.scope || ""}`, row);
  }
  const observations = [...byKey.values()]
    .sort((left, right) => String(left.observed_at).localeCompare(String(right.observed_at)))
    .slice(-MAX_COMPANY_OBSERVATIONS);
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { schema_version: 1, symbol: String(symbol).toUpperCase(), observations }, { mode: 0o600 });
  return { status: "recorded", recorded: rows.length, observation_count: observations.length, file };
}

function numericValue(row) {
  if (Number.isFinite(row?.value)) return row.value;
  if (Number.isFinite(row?.range?.base)) return row.range.base;
  return null;
}

export function companyObservationHistory(symbol, {
  asOf = new Date().toISOString().slice(0, 10),
  dataDir = DATA_DIR,
  lookbackDays = 730,
} = {}) {
  const file = companyObservationFile(symbol, dataDir);
  const cutoff = Date.parse(`${asOf}T23:59:59.999Z`);
  const floor = cutoff - (lookbackDays * 86_400_000);
  const rows = readLedger(file).filter((row) => {
    const instant = Date.parse(row.observed_at || row.date);
    return Number.isFinite(instant) && instant <= cutoff && instant >= floor;
  });
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.coverage_id}|${row.metric || ""}|${row.period || ""}|${row.unit || ""}|${row.scope || ""}|${row.outcome}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const series = [...groups.values()].map((items) => {
    items.sort((left, right) => String(left.observed_at).localeCompare(String(right.observed_at)));
    const latest = items.at(-1);
    const latestAt = Date.parse(latest.observed_at || latest.date);
    const target = latestAt - (90 * 86_400_000);
    const prior = [...items].reverse().find((row) => Date.parse(row.observed_at || row.date) <= target) || null;
    const latestValue = numericValue(latest);
    const priorValue = numericValue(prior);
    return {
      coverage_id: latest.coverage_id,
      metric: latest.metric || null,
      outcome: latest.outcome,
      period: latest.period,
      unit: latest.unit,
      observation_count: items.length,
      window_start: items[0]?.date || null,
      window_end: latest.date,
      latest,
      prior_90d: prior,
      change_90d: Number.isFinite(latestValue) && Number.isFinite(priorValue)
        ? latestValue - priorValue
        : null,
      change_90d_status: Number.isFinite(latestValue) && Number.isFinite(priorValue)
        ? "available"
        : "building_history",
    };
  });
  return {
    status: rows.length ? "available" : "empty",
    observation_count: rows.length,
    series,
    file,
  };
}
