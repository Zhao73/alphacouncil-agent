/**
 * Damodaran's monthly implied equity risk premium, with its history.
 *
 * The premium the market is actually pricing is the input a valuation method compares against,
 * and it is the one number here that no other free source publishes. It also carries the
 * history that makes a percentile meaningful: "the ERP is 4.2%" says nothing without "which is
 * the Nth percentile since 2008".
 *
 * Published as an .xlsx, which is why this is readable at all -- see `xlsx.mjs`. Before that
 * reader existed the whole series was an explicit gap with a URL attached.
 */

import { LIMITS } from "./constants.mjs";
import { excelSerialToIso, readWorkbook } from "./xlsx.mjs";

export const ERP_MONTHLY_URL = "https://pages.stern.nyu.edu/~adamodar/pc/implprem/ERPbymonth.xlsx";

/** Column headers, matched by text: the sheet gains columns between vintages. */
const COLUMNS = Object.freeze({
  month: "Start of month",
  index_level: "S&P 500",
  bond_rate: "T.Bond Rate",
  // The trailing-twelve-month premium is the headline series; the others are variants of it.
  erp: "ERP (T12m)",
});

const numeric = (cell) => {
  const value = Number(cell);
  return Number.isFinite(value) ? value : null;
};

export function parseErpWorkbook(buffer) {
  // Two sheets carry the series: a long history that lags, and a rolling last-twelve-months
  // sheet that is current. Reading only the first makes an up-to-date dataset look years
  // stale, so both are merged and the later observation wins on a shared month.
  const { sheets, date1904 } = readWorkbook(buffer);
  // Each sheet carries its own header; columns are resolved per sheet rather than once.
  const byDate = new Map();
  for (const sheet of sheets) {
    const headerRow = sheet.rows.findIndex((row) => row?.[0] === COLUMNS.month || row?.[0] === "Date");
    if (headerRow < 0) continue;
    const header = sheet.rows[headerRow];
    const columnOf = (...labels) => header.findIndex((cell) => labels.includes(String(cell || "").trim()));
    const at = {
      month: 0,
      indexLevel: columnOf(COLUMNS.index_level),
      bondRate: columnOf(COLUMNS.bond_rate, "10-year US Treasury"),
      erp: columnOf(COLUMNS.erp, "ERP"),
    };
    if (at.erp < 0) continue;
    for (const row of sheet.rows.slice(headerRow + 1)) {
      const date = excelSerialToIso(row?.[at.month], { date1904 });
      const erp = numeric(row?.[at.erp]);
      // A month with no premium is dropped rather than interpolated: this is a published
      // series, and a value nobody published is not an observation.
      if (!date || erp === null) continue;
      byDate.set(date, {
        date,
        erp,
        bond_rate: at.bondRate >= 0 ? numeric(row?.[at.bondRate]) : null,
        index_level: at.indexLevel >= 0 ? numeric(row?.[at.indexLevel]) : null,
      });
    }
  }
  const observations = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (!observations.length) throw new Error("ERP workbook produced no dated observations");
  return observations;
}

/**
 * Where the latest premium sits in its own published history.
 *
 * Reported with the sample it ranked against, matching the contract the other feeds use: a
 * percentile without its window is not a fact a method can act on.
 */
export function erpPercentile(observations, { sinceDays = 365 * 20 } = {}) {
  if (!Array.isArray(observations) || observations.length < 24) return null;
  const latest = observations.at(-1);
  const cutoff = new Date(`${latest.date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - sinceDays);
  const start = cutoff.toISOString().slice(0, 10);
  const sample = observations.filter((row) => row.date >= start);
  if (sample.length < 24) return null;
  const below = sample.filter((row) => row.erp < latest.erp).length;
  return {
    percentile: Number((below / sample.length).toFixed(4)),
    sample_size: sample.length,
    sample_start: sample[0].date,
    sample_end: latest.date,
  };
}

export async function fetchImpliedErp({ signal, asOf = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.QUOTE_FETCH_MS * 3);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  try {
    const response = await fetch(ERP_MONTHLY_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const all = parseErpWorkbook(Buffer.from(await response.arrayBuffer()));
    const visible = asOf ? all.filter((row) => row.date <= String(asOf).slice(0, 10)) : all;
    if (!visible.length) throw new Error(`no ERP observation at or before ${asOf}`);
    const latest = visible.at(-1);
    return Object.freeze({
      source: "damodaran_implied_erp_monthly",
      source_url: ERP_MONTHLY_URL,
      observations: visible,
      latest: latest.erp,
      bond_rate: latest.bond_rate,
      observation_date: latest.date,
      // The publication anchor is the month the observation belongs to, not the fetch time.
      public_at: `${latest.date}T00:00:00.000Z`,
      percentile: erpPercentile(visible),
      basis: "damodaran_trailing_twelve_month_implied_erp",
    });
  } finally {
    clearTimeout(timer);
  }
}
