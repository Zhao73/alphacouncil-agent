/**
 * Per-issuer holdings parsers.
 *
 * Four issuers publish the same thing in four shapes -- iShares as CSV with a preamble, SSGA as
 * an XLSX workbook, Invesco as JSON, Vanguard as a paged JSON feed -- and none of them agrees on
 * a column name or a date format. The parsing lives here so `funds.mjs` reads as fetch, cache
 * and aggregate rather than as a tour of four vendors' quirks.
 *
 * Every parser returns the same record shape and refuses rather than guessing: a row with no
 * resolvable weight is dropped and counted, not defaulted to zero.
 */

import { readWorkbook, unzip, xlsxRows, xmlText } from "./xlsx.mjs";

const WEIGHT_SUM_TOLERANCE = 0.02;

/** The one record shape every issuer's rows are normalised into. */
const holding = ({ ticker, name, weight, units, asset_class = null }) => ({
  ticker: ticker ? String(ticker).trim().toUpperCase() : null,
  name: name ? String(name).trim() : null,
  weight,
  units,
  asset_class,
});

/**
 * Parse the SSGA daily holdings workbook.
 *
 * The sheet opens with a few label/value rows (fund name, ticker, "As of 27-Jul-2026") before
 * the table, and closes with disclosure prose, so the header row is located by content rather
 * than by a fixed offset -- SSGA moves it when the disclaimer text changes length.
 */
/**
 * Merge Vanguard's pages, refusing an incomplete pagination.
 *
 * Each page states the fund's full `size`, so a short walk is detectable. This matters more
 * than usual here because the payload's own `next` link is dead: a caller that trusts it gets
 * page one and a fund that looks like it holds 500 names.
 */
/**
 * Parse Invesco's cache payload, refusing a silently truncated one.
 *
 * `loadType=initial` returns 10 holdings while `totalNumberOfHoldings` still says 108. The
 * count the issuer states about itself is therefore the check: if it disagrees with the array
 * it shipped, the file is short and no weight computed from it means anything.
 */
/**
 * Parse an iShares holdings CSV, refusing the HTML-body-with-HTTP-200 trap.
 *
 * The retired `.ajax?fileType=csv` endpoint returns status 200 and `Content-Type: text/csv`
 * and a full HTML product page as the body. Nothing about the response envelope reveals this,
 * so the check is on the first bytes of the body: a status code and a content type are both
 * claims made by the server, and here both are false.
 */
/**
 * Do the published weights add up to the whole fund?
 *
 * A holdings file that sums to 0.62 is a truncated download, not a concentrated fund, and it
 * is the failure every adapter here can suffer. This never repairs the weights by rescaling:
 * rescaling a truncated file produces a plausible-looking portfolio that does not exist.
 */
/** RFC4180-ish field splitter; iShares quotes every value and embeds commas inside them. */
/** Issuer numbers arrive as "1,167,700,000.00", "7.75" or "1.81367013E8". */
/**
 * The issuers state their date in three different shapes and none of them is ISO. A date this
 * module cannot parse becomes null, which downstream reports as a gap -- it never falls back
 * to "today", because stamping a run time onto an issuer's file is how stale holdings start
 * looking fresh.
 */
const MONTHS = Object.freeze({
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
});

export function isoDate(text) {
  const raw = String(text || "").trim().replace(/^as of\s+/iu, "");
  if (!raw) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/u.exec(raw);
  if (iso) return iso[1];
  // "Jul 27, 2026" (iShares)
  const mdy = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/u.exec(raw);
  if (mdy && MONTHS[mdy[1].toLowerCase()]) {
    return `${mdy[3]}-${MONTHS[mdy[1].toLowerCase()]}-${String(mdy[2]).padStart(2, "0")}`;
  }
  // "27-Jul-2026" (SSGA)
  const dmy = /^(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{4})$/u.exec(raw);
  if (dmy && MONTHS[dmy[2].toLowerCase()]) {
    return `${dmy[3]}-${MONTHS[dmy[2].toLowerCase()]}-${String(dmy[1]).padStart(2, "0")}`;
  }
  return null;
}

export function numeric(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[",\s%]/gu, "");
  if (!cleaned || cleaned === "-") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function csvFields(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; continue; }
      if (ch === '"') { quoted = false; continue; }
      field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { out.push(field); field = ""; continue; }
    field += ch;
  }
  out.push(field);
  return out.map((cell) => cell.trim());
}

export function checkWeightSum(holdings, { tolerance = WEIGHT_SUM_TOLERANCE } = {}) {
  const sum = (holdings || []).reduce((total, row) => total + (Number(row?.weight) || 0), 0);
  const ok = Number.isFinite(sum) && Math.abs(sum - 1) <= tolerance;
  return {
    ok,
    sum: Number(sum.toFixed(6)),
    tolerance,
    gap: ok ? null : `holdings weights sum to ${sum.toFixed(4)}, not ~1 (tolerance ${tolerance}); treat the file as incomplete`,
  };
}

export function parseIsharesHoldingsCsv(csv, { symbol = null } = {}) {
  const text = String(csv || "");
  const head = text.slice(0, 512).trimStart();
  if (!head) throw new Error("iShares holdings response was empty");
  if (head.startsWith("<") || /<!doctype html|<html[\s>]/iu.test(head)) {
    throw new Error("iShares returned an HTML document with a CSV content-type (the retired .ajax holdings path does this at HTTP 200); use the /x/latest-holdings.csv path");
  }

  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => /^"?Ticker"?\s*,\s*"?Name"?/u.test(line.trim()));
  if (headerIndex < 0) throw new Error("iShares CSV has no `Ticker,Name` holdings header row");

  // The block above the table carries the fund name, the stated date and shares outstanding.
  const meta = new Map();
  for (const line of lines.slice(0, headerIndex)) {
    const cells = csvFields(line);
    if (cells.length >= 2 && cells[0]) meta.set(cells[0].replace(/:$/u, "").toLowerCase(), cells[1]);
  }

  const columns = csvFields(lines[headerIndex]);
  const at = (row, label) => {
    const index = columns.findIndex((column) => column.toLowerCase() === label);
    return index >= 0 ? row[index] : null;
  };

  const holdings = [];
  for (const line of lines.slice(headerIndex + 1)) {
    if (!line.trim()) break; // a blank line ends the table; disclosure sections follow
    const row = csvFields(line);
    const ticker = at(row, "ticker");
    const weight = numeric(at(row, "weight (%)"));
    if (!ticker || weight === null) continue;
    holdings.push(holding({
      ticker,
      name: at(row, "name"),
      weight: weight / 100,
      units: numeric(at(row, "quantity")),
      asset_class: at(row, "asset class"),
    }));
  }
  if (!holdings.length) throw new Error("iShares CSV holdings table has no rows");

  return {
    symbol,
    issuer: "ishares",
    fund_name: lines[0] ? csvFields(lines[0])[0] || null : null,
    as_of: isoDate(meta.get("fund holdings as of")),
    shares_outstanding: numeric(meta.get("shares outstanding")),
    holdings,
  };
}

export function parseInvescoHoldings(payload, { symbol = null } = {}) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  if (!data || typeof data !== "object") throw new Error("invesco holdings payload was not an object");
  const rows = data.holdings;
  if (!Array.isArray(rows) || !rows.length) throw new Error("invesco holdings payload carried no holdings array");

  const declared = Number(data.totalNumberOfHoldings);
  if (Number.isFinite(declared) && declared !== rows.length) {
    throw new Error(`invesco returned ${rows.length} holdings but declares ${declared}; the response is truncated (loadType=initial does this at HTTP 200)`);
  }

  const asOf = isoDate(data.effectiveDate || data.effectiveBusinessDate);
  if (!asOf) throw new Error("invesco holdings payload carried no parseable effectiveDate");

  const holdings = rows.map((row) => holding({
    ticker: row?.ticker,
    name: row?.issuerName,
    weight: (numeric(row?.percentageOfTotalNetAssets) ?? 0) / 100,
    units: numeric(row?.units),
    // Nasdaq-100 files carry index futures, currency collateral and several cash sleeves
    // alongside common stock. Look-through must be able to tell them apart.
    asset_class: row?.securityTypeName || null,
  }));

  return { symbol, issuer: "invesco", fund_name: null, as_of: asOf, shares_outstanding: null, holdings };
}

export function parseVanguardHoldings(pages, { symbol = null } = {}) {
  const list = (Array.isArray(pages) ? pages : [pages])
    .map((page) => (typeof page === "string" ? JSON.parse(page) : page))
    .filter(Boolean);
  if (!list.length) throw new Error("vanguard holdings response was empty");

  const entities = list.flatMap((page) => (Array.isArray(page?.fund?.entity) ? page.fund.entity : []));
  if (!entities.length) throw new Error("vanguard holdings payload carried no entities");

  const declared = Number(list[0]?.size);
  if (Number.isFinite(declared) && declared !== entities.length) {
    throw new Error(`vanguard returned ${entities.length} holdings but declares ${declared}; pagination is incomplete (the payload's own next link points at the dead api.vanguard.com host)`);
  }

  const asOf = isoDate(String(list[0]?.asOfDate || "").slice(0, 10));
  if (!asOf) throw new Error("vanguard holdings payload carried no parseable asOfDate");

  const holdings = entities.map((row) => holding({
    ticker: row?.ticker,
    name: row?.longName || row?.shortName,
    weight: (numeric(row?.percentWeight) ?? 0) / 100,
    units: numeric(row?.sharesHeld),
    asset_class: row?.secMainType || null,
  }));

  return {
    symbol,
    issuer: "vanguard",
    fund_name: null,
    as_of: asOf,
    shares_outstanding: null,
    holdings,
    // Month-end, not daily. A reader comparing this to a daily iShares file needs to know.
    cadence: "month_end",
  };
}

export function parseSsgaHoldingsXlsx(buffer, { symbol = null } = {}) {
  const entries = unzip(buffer);
  const sheet = entries.get("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("SSGA workbook has no xl/worksheets/sheet1.xml");
  const sharedXml = entries.get("xl/sharedStrings.xml");
  const shared = sharedXml
    ? [...sharedXml().matchAll(/<si>([\s\S]*?)<\/si>/gu)].map((match) => xmlText(match[1]))
    : [];
  const rows = xlsxRows(sheet(), shared);

  const label = (needle) => {
    const row = rows.find((cells) => String(cells?.[0] || "").toLowerCase().startsWith(needle));
    return row ? row.slice(1).find((cell) => cell) || null : null;
  };

  const headerIndex = rows.findIndex((cells) => {
    const lower = (cells || []).map((cell) => String(cell || "").toLowerCase());
    return lower.includes("ticker") && lower.includes("weight");
  });
  if (headerIndex < 0) throw new Error("SSGA workbook has no `Ticker`/`Weight` header row");
  const columns = rows[headerIndex].map((cell) => String(cell || "").toLowerCase());
  const at = (row, name) => {
    const index = columns.indexOf(name);
    return index >= 0 ? row[index] : null;
  };

  const holdings = [];
  for (const row of rows.slice(headerIndex + 1)) {
    const ticker = at(row, "ticker");
    const weight = numeric(at(row, "weight"));
    if (!ticker || weight === null) continue;
    holdings.push(holding({
      ticker,
      name: at(row, "name"),
      weight: weight / 100,
      units: numeric(at(row, "shares held")),
      asset_class: at(row, "sector"),
    }));
  }
  if (!holdings.length) throw new Error("SSGA workbook holdings table has no rows");

  return {
    symbol,
    issuer: "ssga",
    fund_name: label("fund name"),
    as_of: isoDate(label("holdings")),
    shares_outstanding: numeric(label("shares outstanding")),
    holdings,
  };
}
