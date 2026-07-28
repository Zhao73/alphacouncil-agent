/**
 * ETF holdings, and look-through aggregation of the operating companies inside them.
 *
 * `instruments.mjs` already refuses to send an ETF through an operating-company screen: QQQ
 * has no revenue, no EPS and no Form 4. That correctly stops the wrong answer, but it leaves
 * a fund with nothing to say. This module supplies the right answer instead of the missing
 * one -- the fund's own facts, and the weighted fundamentals of what it actually owns.
 *
 * The justification for the second half is Buffett's 1990 letter: Berkshire's reported
 * earnings omitted the undistributed earnings of the companies it part-owned, so he reported
 * "look-through earnings" alongside them. An index fund is the same problem at 500x. The
 * portfolio-level number is a WEIGHTED AGGREGATE of constituent ratios, and it is only worth
 * anything if the coverage is stated with it.
 *
 * Two rules are enforced in code here rather than asked for in a prompt, because both have
 * already produced confidently wrong output elsewhere in this pipeline:
 *
 *   1. Absolute currency amounts can NOT be aggregated. "ETF revenue" and "ETF EPS" are
 *      category errors -- a fund does not earn its holdings' earnings, it owns a slice of
 *      them. `lookThroughAggregate` accepts a closed whitelist of ratio metrics, so summing
 *      revenue is not a discouraged call, it is an unrepresentable one.
 *   2. Below 50% coverage there is no aggregate, only a sample. The function returns null and
 *      a diagnostic rather than a number that reads as if it described the fund.
 *
 * Every issuer adapter validates the CONTENT it received rather than the status code, because
 * three of the four endpoints here return HTTP 200 while lying (see the trap notes below).
 */

import { Buffer } from "node:buffer";
import { inflateRawSync } from "node:zlib";

import { LIMITS } from "./constants.mjs";
import { linkedAbort } from "./abort.mjs";
import { fetchText } from "./quotes.mjs";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Ticker -> issuer + the identifier that issuer's holdings endpoint actually keys on.
 *
 * Each issuer keys on something different and the wrong key fails in a different way, so the
 * identifier is stored per issuer rather than guessed from the ticker:
 *   - iShares keys on a numeric productId. The slug in the URL path is decorative.
 *   - SSGA keys on a lowercase ticker slug.
 *   - Invesco keys on CUSIP. `idType=ticker` works for QQQ alone; QQQM returns HTTP 500.
 *   - Vanguard keys on the ticker.
 *
 * Every CUSIP and productId below was read back from the issuer's own response, not inferred.
 * An unknown ticker is an explicit unsupported result -- never a constructed URL.
 */
export const FUND_REGISTRY = Object.freeze({
  IVV: { issuer: "ishares", name: "iShares Core S&P 500 ETF", product_id: "239726", cusip: "464287200" },
  IWM: { issuer: "ishares", name: "iShares Russell 2000 ETF", product_id: "239710", cusip: "464287655" },
  EFA: { issuer: "ishares", name: "iShares MSCI EAFE ETF", product_id: "239623", cusip: "464287465" },
  AGG: { issuer: "ishares", name: "iShares Core U.S. Aggregate Bond ETF", product_id: "239458", cusip: "464287226" },
  TLT: { issuer: "ishares", name: "iShares 20+ Year Treasury Bond ETF", product_id: "239454", cusip: "464287432" },
  HYG: { issuer: "ishares", name: "iShares iBoxx $ High Yield Corporate Bond ETF", product_id: "239565", cusip: "464288513" },
  SPY: { issuer: "ssga", name: "SPDR S&P 500 ETF Trust", slug: "spy", cusip: "78462F103" },
  QQQ: { issuer: "invesco", name: "Invesco QQQ Trust Series 1", cusip: "46090E103" },
  QQQM: { issuer: "invesco", name: "Invesco NASDAQ 100 ETF", cusip: "46138G649" },
  VOO: { issuer: "vanguard", name: "Vanguard S&P 500 ETF", ticker: "VOO", cusip: "922908363" },
  VTI: { issuer: "vanguard", name: "Vanguard Total Stock Market ETF", ticker: "VTI" },
});

/**
 * Issuers that publish shares outstanding daily, which is the only honest input to a flow.
 *
 * Vanguard and Invesco publish neither shares outstanding nor AUM on any keyless endpoint
 * (Invesco's /nav and /profile both answer HTTP 501). A flow for those two is a gap. It is
 * NOT a modelling problem to be solved with an estimate -- see `fundFlow`.
 */
export const DAILY_SHARES_ISSUERS = Object.freeze(["ishares", "ssga"]);

/** Weights are published rounded, so the sum is never exactly 1. IVV lands at 1.0005. */
const WEIGHT_SUM_TOLERANCE = 0.02;

/** Below this, an aggregate describes a sample rather than the fund. Hard floor, not advice. */
export const MIN_LOOK_THROUGH_COVERAGE = 0.5;

/** Unknown ticker -> an explicit unsupported result. Never a guessed identifier. */
export function resolveFund(symbol) {
  const key = String(symbol || "").trim().toUpperCase();
  if (!key) return { supported: false, symbol: key, reason: "empty symbol" };
  if (!Object.prototype.hasOwnProperty.call(FUND_REGISTRY, key)) {
    return {
      supported: false,
      symbol: key,
      reason: `${key} is not in the fund registry; holdings would have to be guessed`,
      supported_symbols: Object.keys(FUND_REGISTRY),
    };
  }
  return { supported: true, symbol: key, ...FUND_REGISTRY[key] };
}

// ---------------------------------------------------------------------------
// URL builders -- the query string is part of the correctness contract
// ---------------------------------------------------------------------------

/**
 * The NEW iShares holdings path. Only the numeric productId matters; the slug segment is
 * arbitrary and is written as `x` so nobody maintains a table of marketing slugs.
 *
 * The old `.../<id>.ajax?fileType=csv` path is deliberately not built anywhere in this file.
 * It still answers HTTP 200 with `Content-Type: text/csv` and a 2.2MB HTML product page as
 * the body, for every User-Agent tried. See `parseIsharesHoldingsCsv`.
 */
export function isharesHoldingsUrl(productId) {
  return `https://www.ishares.com/us/products/${encodeURIComponent(productId)}/x/latest-holdings.csv`;
}

export function ssgaHoldingsUrl(slug) {
  return `https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${encodeURIComponent(slug)}.xlsx`;
}

/**
 * Invesco's cache API. Both query parameters are load-bearing and both fail SILENTLY:
 *   - without `interval=daily` the response can serve a stale cached effectiveDate;
 *   - with `loadType=initial` it returns the first 10 holdings while `totalNumberOfHoldings`
 *     still reports the true count, so the truncation is invisible unless you compare them.
 * `assertInvescoQuery` re-checks both so a later edit to this string cannot quietly regress.
 *
 * Host choice is also deliberate. `www.invesco.com` answers HTTP 406 with a zero-byte body to
 * any Mozilla-prefixed User-Agent -- which is exactly what `fetchText` sends -- while
 * `dng-api.invesco.com` accepts every User-Agent tested, including a full Chrome one.
 *
 * `dng-api` does rate-limit by IP, and it signals that with the SAME zero-byte 406. Measured:
 * roughly eight requests in quick succession locked it out for about two minutes, for every
 * User-Agent at once, then it recovered on its own. That collision matters because a 406 here
 * reads like a UA problem and is not one -- see `invescoFetchHint`. Changing the UA in
 * response to it accomplishes nothing except hiding the need to back off.
 */
export function invescoHoldingsUrl(cusip) {
  return "https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/"
    + `${encodeURIComponent(cusip)}/holdings/fund?idType=cusip&interval=daily&productType=ETF`;
}

/**
 * Turn Invesco's ambiguous 406 into the diagnosis that is actually true, so the next reader
 * backs off instead of cycling User-Agents.
 */
export function invescoFetchHint(error) {
  const message = String(error?.message || error);
  if (!/HTTP 406/u.test(message)) return message;
  return `${message} -- dng-api.invesco.com returns a zero-byte 406 when rate limiting by IP, not because of the User-Agent (it accepts every UA tested). Back off ~2 minutes and retry.`;
}

export function assertInvescoQuery(url) {
  const text = String(url || "");
  if (!/[?&]interval=daily(&|$)/u.test(text)) {
    throw new Error("invesco holdings URL must carry interval=daily or it may serve a stale cached date");
  }
  if (/[?&]loadType=/u.test(text)) {
    throw new Error("invesco holdings URL must not carry loadType; it silently truncates to 10 holdings");
  }
  if (!/[?&]idType=cusip(&|$)/u.test(text)) {
    throw new Error("invesco holdings URL must key on CUSIP; idType=ticker resolves QQQ only");
  }
  return text;
}

const VANGUARD_PAGE_SIZE = 500;
const VANGUARD_MAX_PAGES = 40; // ~20k holdings; a runaway pager is a bug, not a big fund

/**
 * Vanguard month-end holdings, paged 500 at a time.
 *
 * The payload's own `next` link points at `api.vanguard.com`, which is dead, so following it
 * yields nothing and looks like a short fund. Pagination is done here against the live host.
 */
export function vanguardHoldingsUrl(ticker, start = 1, count = VANGUARD_PAGE_SIZE) {
  const base = `https://investor.vanguard.com/investment-products/etfs/profile/api/${encodeURIComponent(ticker)}/portfolio-holding/stock`;
  return start > 1 ? `${base}?start=${start}&count=${count}` : base;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const MONTHS = Object.freeze({
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
});

/**
 * The issuers state their date in three different shapes and none of them is ISO. A date this
 * module cannot parse becomes null, which downstream reports as a gap -- it never falls back
 * to "today", because stamping a run time onto an issuer's file is how stale holdings start
 * looking fresh.
 */
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

/** Issuer numbers arrive as "1,167,700,000.00", "7.75" or "1.81367013E8". */
function numeric(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/[",\s%]/gu, "");
  if (!cleaned || cleaned === "-") return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** RFC4180-ish field splitter; iShares quotes every value and embeds commas inside them. */
function csvFields(line) {
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

/**
 * Do the published weights add up to the whole fund?
 *
 * A holdings file that sums to 0.62 is a truncated download, not a concentrated fund, and it
 * is the failure every adapter here can suffer. This never repairs the weights by rescaling:
 * rescaling a truncated file produces a plausible-looking portfolio that does not exist.
 */
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

const holding = ({ ticker, name, weight, units, asset_class = null }) => ({
  ticker: ticker ? String(ticker).trim().toUpperCase() : null,
  name: name ? String(name).trim() : null,
  weight,
  units,
  asset_class,
});

// ---------------------------------------------------------------------------
// iShares
// ---------------------------------------------------------------------------

/**
 * Parse an iShares holdings CSV, refusing the HTML-body-with-HTTP-200 trap.
 *
 * The retired `.ajax?fileType=csv` endpoint returns status 200 and `Content-Type: text/csv`
 * and a full HTML product page as the body. Nothing about the response envelope reveals this,
 * so the check is on the first bytes of the body: a status code and a content type are both
 * claims made by the server, and here both are false.
 */
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

// ---------------------------------------------------------------------------
// Invesco
// ---------------------------------------------------------------------------

/**
 * Parse Invesco's cache payload, refusing a silently truncated one.
 *
 * `loadType=initial` returns 10 holdings while `totalNumberOfHoldings` still says 108. The
 * count the issuer states about itself is therefore the check: if it disagrees with the array
 * it shipped, the file is short and no weight computed from it means anything.
 */
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

// ---------------------------------------------------------------------------
// Vanguard
// ---------------------------------------------------------------------------

/**
 * Merge Vanguard's pages, refusing an incomplete pagination.
 *
 * Each page states the fund's full `size`, so a short walk is detectable. This matters more
 * than usual here because the payload's own `next` link is dead: a caller that trusts it gets
 * page one and a fund that looks like it holds 500 names.
 */
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

// ---------------------------------------------------------------------------
// SSGA -- xlsx, read with node builtins only
// ---------------------------------------------------------------------------

/**
 * Minimal ZIP central-directory reader.
 *
 * An xlsx is a ZIP of XML parts, and `zlib.inflateRawSync` is enough to read one, so SSGA is
 * supported without adding a dependency. Entries are located through the CENTRAL directory
 * rather than the local headers on purpose: when the archive uses a data descriptor, the
 * local header's sizes are zeroed and only the central directory is truthful.
 *
 * Everything unusual fails closed. This reads the one archive shape SSGA publishes; it is not
 * a general ZIP implementation and must not silently behave like one.
 */
function unzip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("SSGA response is not a ZIP/xlsx container");
  }
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("xlsx container has no end-of-central-directory record");
  if (buf.readUInt16LE(eocd + 10) === 0xffff) throw new Error("ZIP64 xlsx containers are not supported");

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("xlsx central directory is malformed");
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    if (flags & 0x0001) throw new Error(`xlsx entry ${name} is encrypted`);
    if (method !== 0 && method !== 8) throw new Error(`xlsx entry ${name} uses unsupported compression method ${method}`);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(start, start + compressedSize);
    entries.set(name, () => (method === 0 ? raw : inflateRawSync(raw)).toString("utf8"));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const XML_ENTITIES = Object.freeze({ "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&amp;": "&" });
const unescapeXml = (text) => String(text).replace(/&(?:lt|gt|quot|apos|amp);/gu, (m) => XML_ENTITIES[m]);

/** Concatenate every <t> inside an element: a shared string may be split into rich-text runs. */
const xmlText = (fragment) => {
  let out = "";
  for (const match of String(fragment).matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gu)) out += match[1];
  return unescapeXml(out);
};

/** "AB12" -> 27. Cells are addressed, not ordered: empty cells are simply absent. */
const columnIndex = (ref) => {
  const letters = /^([A-Z]+)/u.exec(String(ref || "").toUpperCase());
  if (!letters) return -1;
  return [...letters[1]].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
};

function xlsxRows(sheetXml, sharedStrings) {
  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/gu)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\s+r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/gu)) {
      const index = columnIndex(cellMatch[1]);
      if (index < 0) continue;
      const type = /t="([^"]+)"/u.exec(cellMatch[2])?.[1] || "n";
      const body = cellMatch[3];
      const value = /<v>([\s\S]*?)<\/v>/u.exec(body)?.[1];
      if (type === "s") cells[index] = sharedStrings[Number(value)] ?? null;
      else if (type === "inlineStr") cells[index] = xmlText(/<is>([\s\S]*?)<\/is>/u.exec(body)?.[1] || "");
      else cells[index] = value === undefined ? null : unescapeXml(value);
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Parse the SSGA daily holdings workbook.
 *
 * The sheet opens with a few label/value rows (fund name, ticker, "As of 27-Jul-2026") before
 * the table, and closes with disclosure prose, so the header row is located by content rather
 * than by a fixed offset -- SSGA moves it when the disclaimer text changes length.
 */
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

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/**
 * `fetchText` decodes the body as UTF-8, which is irreversibly lossy for a ZIP container --
 * measured on SPY's workbook, 54,450 bytes of xlsx come back as 96,860 bytes of replacement
 * characters. The xlsx issuer therefore needs bytes, not text. Same abort discipline.
 */
async function fetchBinary(url, timeoutMs = LIMITS.QUOTE_FETCH_MS * 2, upstreamSignal) {
  const abort = linkedAbort(timeoutMs, upstreamSignal);
  try {
    const res = await fetch(url, {
      signal: abort.signal,
      redirect: "follow", // SSGA answers 301 before serving the workbook
      headers: { "User-Agent": "Mozilla/5.0 (AlphaCouncil)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    abort.cleanup();
  }
}

async function fetchVanguardPages(ticker, signal) {
  const pages = [];
  const urls = [];
  let start = 1;
  for (let i = 0; i < VANGUARD_MAX_PAGES; i += 1) {
    const url = vanguardHoldingsUrl(ticker, start);
    urls.push(url);
    const page = JSON.parse(await fetchText(url, LIMITS.QUOTE_FETCH_MS * 2, signal));
    pages.push(page);
    const collected = pages.reduce((total, one) => total + (one?.fund?.entity?.length || 0), 0);
    const declared = Number(page?.size);
    if (!Number.isFinite(declared) || collected >= declared) break;
    start += VANGUARD_PAGE_SIZE;
  }
  return { pages, urls };
}

/**
 * Fund holdings from the issuer, with the issuer's own stated date.
 *
 * `as_of` and `public_at` are the issuer's date, never the run time: a fund file is a dated
 * publication, and stamping it with "now" is exactly how a month-end Vanguard file starts
 * passing for today's portfolio.
 */
export async function fetchFundHoldings(symbol, { signal } = {}) {
  const fund = resolveFund(symbol);
  if (!fund.supported) {
    return Object.freeze({
      symbol: fund.symbol,
      issuer: null,
      as_of: null,
      holdings: [],
      source_url: null,
      public_at: null,
      unavailable: [`holdings unsupported: ${fund.reason}`],
    });
  }

  const unavailable = [];
  let parsed = null;
  let sourceUrl = null;
  try {
    if (fund.issuer === "ishares") {
      sourceUrl = isharesHoldingsUrl(fund.product_id);
      parsed = parseIsharesHoldingsCsv(await fetchText(sourceUrl, LIMITS.QUOTE_FETCH_MS * 2, signal), { symbol: fund.symbol });
    } else if (fund.issuer === "invesco") {
      sourceUrl = assertInvescoQuery(invescoHoldingsUrl(fund.cusip));
      parsed = parseInvescoHoldings(await fetchText(sourceUrl, LIMITS.QUOTE_FETCH_MS * 2, signal), { symbol: fund.symbol });
    } else if (fund.issuer === "ssga") {
      sourceUrl = ssgaHoldingsUrl(fund.slug);
      parsed = parseSsgaHoldingsXlsx(await fetchBinary(sourceUrl, LIMITS.QUOTE_FETCH_MS * 2, signal), { symbol: fund.symbol });
    } else if (fund.issuer === "vanguard") {
      const walk = await fetchVanguardPages(fund.ticker, signal);
      sourceUrl = walk.urls;
      parsed = parseVanguardHoldings(walk.pages, { symbol: fund.symbol });
    } else {
      throw new Error(`no holdings adapter for issuer ${fund.issuer}`);
    }
  } catch (error) {
    const detail = fund.issuer === "invesco" ? invescoFetchHint(error) : String(error?.message || error);
    return Object.freeze({
      symbol: fund.symbol,
      issuer: fund.issuer,
      as_of: null,
      holdings: [],
      source_url: sourceUrl,
      public_at: null,
      unavailable: [`${fund.issuer} holdings: ${detail}`],
    });
  }

  const sumCheck = checkWeightSum(parsed.holdings);
  if (!sumCheck.ok) unavailable.push(`${fund.issuer} ${fund.symbol}: ${sumCheck.gap}`);
  if (!parsed.as_of) unavailable.push(`${fund.issuer} ${fund.symbol}: issuer stated no holdings date`);
  if (parsed.shares_outstanding === null && DAILY_SHARES_ISSUERS.includes(fund.issuer)) {
    unavailable.push(`${fund.issuer} ${fund.symbol}: shares outstanding absent from the holdings file, so no flow can be computed`);
  }
  if (!DAILY_SHARES_ISSUERS.includes(fund.issuer)) {
    unavailable.push(`${fund.issuer} publishes no keyless shares-outstanding or AUM endpoint; fund flow is a gap for ${fund.symbol}`);
  }
  if (parsed.cadence === "month_end") {
    unavailable.push(`${fund.issuer} ${fund.symbol}: holdings are month-end only, not daily (stated date ${parsed.as_of})`);
  }

  return Object.freeze({
    symbol: fund.symbol,
    issuer: fund.issuer,
    fund_name: parsed.fund_name || fund.name,
    as_of: parsed.as_of,
    cadence: parsed.cadence || "daily",
    holdings: Object.freeze(parsed.holdings.map((row) => Object.freeze(row))),
    holdings_count: parsed.holdings.length,
    weight_sum: sumCheck.sum,
    shares_outstanding: parsed.shares_outstanding,
    source_url: sourceUrl,
    // The issuer's stated date IS the publication anchor, exactly as with a FRED observation.
    public_at: parsed.as_of ? `${parsed.as_of}T00:00:00.000Z` : null,
    observation_date: parsed.as_of,
    unavailable: Object.freeze(unavailable),
  });
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

/**
 * Creation/redemption flow: the change in shares outstanding priced at NAV.
 *
 * Only iShares and SSGA publish shares outstanding daily. For Vanguard and Invesco this must
 * return null. There is a tempting substitute -- infer flow from AUM change -- and it is
 * wrong, because AUM moves with the market as well as with creations, so it reports a flow on
 * a day with none. The gap is named instead.
 */
export function fundFlow({ sharesNow, sharesPrior, nav, issuer = null } = {}) {
  const construction = {
    formula: "(shares_outstanding_now - shares_outstanding_prior) * nav",
    unit: "usd",
    inputs: { shares_now: sharesNow ?? null, shares_prior: sharesPrior ?? null, nav: nav ?? null },
    issuer,
  };

  if (issuer && !DAILY_SHARES_ISSUERS.includes(issuer)) {
    return {
      value: null,
      construction,
      unavailable: [`${issuer} publishes no daily shares outstanding; fund flow is unavailable and must not be estimated from AUM change`],
    };
  }

  const now = numeric(sharesNow);
  const prior = numeric(sharesPrior);
  const price = numeric(nav);
  const missing = [];
  if (now === null) missing.push("shares_outstanding_now");
  if (prior === null) missing.push("shares_outstanding_prior");
  if (price === null) missing.push("nav");
  if (missing.length) {
    return { value: null, construction, unavailable: [`fund flow needs ${missing.join(", ")}; no estimate is substituted`] };
  }

  return {
    value: Number(((now - prior) * price).toFixed(2)),
    construction: { ...construction, share_change: now - prior },
    unavailable: [],
  };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * The shortest run of largest holdings that reaches `minWeight` of the fund.
 *
 * Returns what it actually reached, not what was asked for. A fund whose whole book is 0.4 of
 * itself -- a truncated file, or a top-ten sample -- returns `reached: false` and 0.4, so the
 * caller can decline rather than describe 40% of a portfolio as the portfolio.
 */
export function topHoldingsCoverage(holdings, { minWeight = 0.6 } = {}) {
  const ranked = [...(holdings || [])]
    .filter((row) => Number.isFinite(Number(row?.weight)))
    .sort((a, b) => Number(b.weight) - Number(a.weight));

  const prefix = [];
  let coverage = 0;
  for (const row of ranked) {
    prefix.push(row);
    coverage += Number(row.weight);
    if (coverage >= minWeight) break;
  }

  const reached = coverage >= minWeight;
  return {
    holdings: prefix,
    count: prefix.length,
    coverage_weight: Number(coverage.toFixed(6)),
    min_weight: minWeight,
    reached,
    unavailable: reached
      ? []
      : [`top holdings reach only ${coverage.toFixed(4)} of the fund, short of the requested ${minWeight}`],
  };
}

// ---------------------------------------------------------------------------
// Look-through aggregation
// ---------------------------------------------------------------------------

/**
 * The closed set of metrics that may be look-through aggregated.
 *
 * Membership is the whole enforcement mechanism for "no absolute currency amounts": revenue,
 * EPS, net income and market cap are not listed, so `lookThroughAggregate` cannot express
 * them. There is no flag to turn that off.
 *
 * `aggregation` is not cosmetic. A price-per-unit-of-fundamental ratio (P/E, P/B, P/S) must be
 * aggregated HARMONICALLY, because the portfolio ratio is total price over total earnings:
 *
 *     portfolio P/E = sum(w_i * P_i) / sum(w_i * E_i) = 1 / sum(w_i / PE_i)
 *
 * which is the weighted harmonic mean of the constituent P/Es, equivalently the reciprocal of
 * the weighted arithmetic mean of their earnings yields. Taking the arithmetic mean of P/Es
 * instead is the classic error that produces an index P/E in the hundreds: a near-zero-
 * earnings constituent contributes an enormous P/E to an arithmetic average, when in the real
 * aggregate it contributes almost no earnings and a normal amount of price.
 *
 * Metrics that are ALREADY a rate -- a yield, a margin, a growth rate -- aggregate
 * arithmetically, because their denominators are the weights themselves.
 */
export const LOOK_THROUGH_METRICS = Object.freeze({
  "valuation.pe_ratio": { kind: "price_multiple", aggregation: "weighted_harmonic_mean", reciprocal_of: "valuation.earnings_yield" },
  "valuation.pb_ratio": { kind: "price_multiple", aggregation: "weighted_harmonic_mean", reciprocal_of: "valuation.book_yield" },
  "valuation.ps_ratio": { kind: "price_multiple", aggregation: "weighted_harmonic_mean", reciprocal_of: "valuation.sales_yield" },
  "valuation.ev_ebitda": { kind: "price_multiple", aggregation: "weighted_harmonic_mean", reciprocal_of: null },
  "valuation.earnings_yield": { kind: "rate", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "valuation.dividend_yield": { kind: "rate", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "valuation.free_cash_flow_yield": { kind: "rate", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "profitability.net_margin": { kind: "rate", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "profitability.gross_margin": { kind: "rate", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "profitability.operating_margin": { kind: "rate", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "profitability.return_on_equity": { kind: "rate", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "growth.revenue_growth": { kind: "rate", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "growth.earnings_growth": { kind: "rate", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "leverage.debt_to_equity": { kind: "ratio", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
  "leverage.net_debt_to_ebitda": { kind: "ratio", aggregation: "weighted_arithmetic_mean", reciprocal_of: null },
});

/**
 * Named only so the refusal explains itself. These are the aggregations people actually try,
 * and each one produces a number that reads like a fact about the fund and is not one.
 */
const ABSOLUTE_FACT_HINTS = Object.freeze([
  "revenue", "sales", "eps", "earnings_per_share", "net_income", "profit", "ebitda",
  "free_cash_flow", "fcf", "market_cap", "assets", "equity", "debt", "capex", "book_value",
]);

const looksAbsolute = (factId) => {
  const id = String(factId || "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LOOK_THROUGH_METRICS, factId)) return false;
  return ABSOLUTE_FACT_HINTS.some((hint) => id.includes(hint));
};

const refusal = (reason, extra = {}) => ({
  value: null,
  coverage_weight: null,
  method: null,
  constituent_count: 0,
  inputs: [],
  unavailable: [reason],
  ...extra,
});

/**
 * Weight-aggregate one ratio metric across a fund's holdings into a portfolio-level value.
 *
 * This is the Buffett look-through step: the fund has no fundamentals, the companies inside it
 * do, and the portfolio number is their weighted aggregate. Four rules hold:
 *
 *   (a) below `MIN_LOOK_THROUGH_COVERAGE` of achieved weight there is no value, only a
 *       diagnostic -- the caller gets null and the reason;
 *   (b) only whitelisted ratio metrics exist; an absolute currency amount is unrepresentable;
 *   (c) `inputs` carries every constituent that contributed, so the arithmetic is checkable
 *       by hand rather than trusted;
 *   (d) `method` states which mean was taken, because harmonic and arithmetic disagree
 *       violently on exactly the multiples people care about.
 *
 * Achieved coverage is computed from the constituents that actually supplied a usable fact --
 * not from the length of the holdings list, and not from the caller's `coverageWeight`, which
 * is recorded and cross-checked but never trusted as the answer.
 */
export function lookThroughAggregate({ holdings, perHoldingFacts, factId, coverageWeight = null } = {}) {
  const metric = Object.prototype.hasOwnProperty.call(LOOK_THROUGH_METRICS, factId)
    ? LOOK_THROUGH_METRICS[factId]
    : null;

  if (!metric) {
    const reason = looksAbsolute(factId)
      ? `refused: ${factId} is an absolute amount, not a ratio. A fund does not earn its holdings' earnings, so it cannot be weight-aggregated into a fund-level figure. Aggregate a ratio instead.`
      : `refused: ${factId} is not an aggregatable ratio metric`;
    return refusal(reason, { allowed_metrics: Object.keys(LOOK_THROUGH_METRICS) });
  }

  const facts = perHoldingFacts instanceof Map
    ? perHoldingFacts
    : new Map(Object.entries(perHoldingFacts || {}));

  const inputs = [];
  const skipped = [];
  let achieved = 0;
  for (const row of holdings || []) {
    const ticker = row?.ticker ? String(row.ticker).toUpperCase() : null;
    const weight = Number(row?.weight);
    if (!ticker || !Number.isFinite(weight) || weight <= 0) continue;
    const value = numeric(facts.get(ticker));
    if (value === null) continue;
    // A zero price multiple has no reciprocal, so it cannot enter a harmonic mean at all.
    // Negative multiples DO enter it: a loss-making constituent should subtract earnings from
    // the aggregate, which is precisely what the reciprocal does.
    if (metric.aggregation === "weighted_harmonic_mean" && value === 0) {
      skipped.push(`${ticker}: ${factId} is 0 and has no reciprocal`);
      continue;
    }
    inputs.push({ ticker, weight: Number(weight.toFixed(6)), value });
    achieved += weight;
  }

  achieved = Number(achieved.toFixed(6));
  const declared = Number.isFinite(Number(coverageWeight)) ? Number(coverageWeight) : null;

  if (!inputs.length) {
    return refusal(`no constituent supplied ${factId}; nothing to aggregate`, { coverage_weight: 0 });
  }

  if (achieved < MIN_LOOK_THROUGH_COVERAGE) {
    return refusal(
      `look-through coverage ${achieved.toFixed(4)} is below the ${MIN_LOOK_THROUGH_COVERAGE} floor; ${inputs.length} constituents describe a sample, not the fund`,
      { coverage_weight: achieved, constituent_count: inputs.length, declared_coverage_weight: declared },
    );
  }

  const unavailable = skipped.slice();
  if (declared !== null && achieved > declared + 1e-6) {
    unavailable.push(`declared coverage ${declared} is below the achieved ${achieved}; the caller's coverage figure is stale`);
  }

  // Both means are weighted by the constituent weights and normalised by the weight actually
  // present, so a partial-coverage aggregate is the average over what was covered rather than
  // a value diluted toward zero by the constituents that were missing.
  const totalWeight = inputs.reduce((sum, row) => sum + row.weight, 0);
  const value = metric.aggregation === "weighted_harmonic_mean"
    ? totalWeight / inputs.reduce((sum, row) => sum + (row.weight / row.value), 0)
    : inputs.reduce((sum, row) => sum + (row.weight * row.value), 0) / totalWeight;

  if (!Number.isFinite(value)) {
    return refusal(`aggregating ${factId} produced a non-finite value; the constituent set is degenerate`, {
      coverage_weight: achieved,
      constituent_count: inputs.length,
    });
  }

  return {
    value: Number(value.toFixed(6)),
    coverage_weight: achieved,
    declared_coverage_weight: declared,
    method: metric.aggregation,
    metric_kind: metric.kind,
    fact_id: factId,
    constituent_count: inputs.length,
    inputs,
    unavailable,
  };
}

/**
 * The reciprocal view of a price multiple, e.g. P/E -> earnings yield.
 *
 * Kept separate from `lookThroughAggregate` so the ordering is explicit: the harmonic mean is
 * taken over the MULTIPLES first and inverted after. Inverting each constituent and then
 * averaging arithmetically gives the same number, but doing it in the other order -- average
 * the multiples arithmetically, then invert -- does not, and that is the mistake this
 * separation exists to make visible.
 */
export function asYield(aggregate) {
  if (!aggregate || aggregate.value === null || !aggregate.value) return null;
  const metric = LOOK_THROUGH_METRICS[aggregate.fact_id];
  if (!metric || metric.aggregation !== "weighted_harmonic_mean") return null;
  return {
    value: Number((1 / aggregate.value).toFixed(6)),
    fact_id: metric.reciprocal_of,
    method: `reciprocal_of_${aggregate.method}`,
    coverage_weight: aggregate.coverage_weight,
    constituent_count: aggregate.constituent_count,
  };
}

// ---------------------------------------------------------------------------
// Metadata (fees / NAV / AUM)
// ---------------------------------------------------------------------------

export const ISHARES_SCREENER_URL = "https://www.ishares.com/us/product-screener/product-screener-v3.1.jsn"
  + "?dcrPath=/templatedata/config/product-screener-v3/data/en/us-ishares/ishares-product-screener-backend-config"
  + "&siteEntryPassthrough=true";

export const SSGA_FUNDFINDER_URL = "https://www.ssga.com/bin/v1/ssmp/fund/fundfinder"
  + "?country=us&language=en&role=intermediary&product=etfs&ui=fund-finder";

/**
 * The two metadata feeds wrap every value, in two different shapes, and neither is a number:
 * iShares sends `{d: "0.03", r: 0.03}` and SSGA sends `["0.0945%", 0.0945]`. Both carry a
 * formatted display string beside the raw value; the raw member is the one to read, because
 * the display string is localised and suffixed.
 */
const screenerNumber = (cell) => {
  if (Array.isArray(cell)) return numeric(cell[1]);
  if (cell && typeof cell === "object") return numeric(cell.r ?? cell.d);
  return numeric(cell);
};

/** The raw member, uncoerced -- SSGA's dates live there already in ISO form. */
const screenerRaw = (cell) => {
  if (Array.isArray(cell)) return cell[1] ?? cell[0] ?? null;
  if (cell && typeof cell === "object") return cell.d ?? cell.r ?? null;
  return cell ?? null;
};

/**
 * AUM units are NOT the same across the two issuers and mixing them is a factor-of-a-million
 * error: iShares reports total net assets in absolute dollars (IVV: 8.67e11) while SSGA
 * reports millions (SPY: 785173.06, displayed "$785,173.06 M" -- all 180 SSGA funds use that
 * suffix). Both are converted to absolute USD here and the unit is declared on the way out,
 * for the same reason FRED's millions/billions mismatch is converted explicitly rather than
 * assumed away.
 */
const SSGA_AUM_SCALE = 1e6;

export function parseIsharesScreener(payload, symbol) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  const wanted = String(symbol || "").toUpperCase();
  for (const [productId, row] of Object.entries(data || {})) {
    if (String(row?.localExchangeTicker || "").toUpperCase() !== wanted) continue;
    return {
      issuer: "ishares",
      product_id: productId,
      fund_name: row.fundName || null,
      cusip: row.cusip || null,
      expense_ratio: screenerNumber(row.fees ?? row.ter),
      expense_ratio_unit: "percent",
      nav: screenerNumber(row.navAmount),
      aum: screenerNumber(row.totalNetAssets),
      aum_unit: "usd",
      // iShares sends {d: "Jul 27, 2026", r: 20260727}; the display member is the parseable one.
      as_of: isoDate(screenerRaw(row.navAmountAsOf)),
    };
  }
  return null;
}

export function parseSsgaFundFinder(payload, symbol) {
  const data = typeof payload === "string" ? JSON.parse(payload) : payload;
  const rows = data?.data?.funds?.etfs?.datas;
  if (!Array.isArray(rows)) return null;
  const wanted = String(symbol || "").toUpperCase();
  const row = rows.find((entry) => String(entry?.fundTicker || "").toUpperCase() === wanted);
  if (!row) return null;
  const aumMillions = screenerNumber(row.aum);
  return {
    issuer: "ssga",
    fund_name: row.fundName || null,
    expense_ratio: screenerNumber(row.ter),
    expense_ratio_unit: "percent",
    nav: screenerNumber(row.nav),
    aum: aumMillions === null ? null : aumMillions * SSGA_AUM_SCALE,
    aum_unit: "usd",
    // SSGA's asOfDate arrives as ["Jul 27 2026", "2026-07-27"]: the raw member is already ISO.
    as_of: isoDate(screenerRaw(row.asOfDate)),
  };
}

/**
 * Fees, NAV and AUM where the issuer publishes them keylessly.
 *
 * Vanguard and Invesco do not: Invesco's /nav and /profile both answer HTTP 501, and neither
 * issuer exposes shares outstanding. Those two return a named gap rather than a figure sourced
 * from somewhere the number cannot be traced back to.
 */
export async function fetchFundMetadata(symbol, { signal } = {}) {
  const fund = resolveFund(symbol);
  if (!fund.supported) {
    return Object.freeze({ symbol: fund.symbol, issuer: null, unavailable: [`metadata unsupported: ${fund.reason}`] });
  }

  const gap = (reason) => Object.freeze({
    symbol: fund.symbol,
    issuer: fund.issuer,
    expense_ratio: null,
    nav: null,
    aum: null,
    source_url: null,
    public_at: null,
    unavailable: [reason],
  });

  if (fund.issuer === "vanguard" || fund.issuer === "invesco") {
    return gap(`${fund.issuer} publishes no keyless AUM or shares-outstanding endpoint for ${fund.symbol}`
      + (fund.issuer === "invesco" ? " (its /nav and /profile both answer HTTP 501)" : ""));
  }

  const url = fund.issuer === "ishares" ? ISHARES_SCREENER_URL : SSGA_FUNDFINDER_URL;
  try {
    const body = await fetchText(url, LIMITS.QUOTE_FETCH_MS * 3, signal);
    const parsed = fund.issuer === "ishares"
      ? parseIsharesScreener(body, fund.symbol)
      : parseSsgaFundFinder(body, fund.symbol);
    if (!parsed) return gap(`${fund.issuer} metadata feed did not list ${fund.symbol}`);
    return Object.freeze({
      symbol: fund.symbol,
      ...parsed,
      source_url: url,
      public_at: parsed.as_of ? `${parsed.as_of}T00:00:00.000Z` : null,
      observation_date: parsed.as_of,
      unavailable: parsed.as_of ? [] : [`${fund.issuer} ${fund.symbol}: metadata carried no stated date`],
    });
  } catch (error) {
    return gap(`${fund.issuer} metadata: ${String(error?.message || error)}`);
  }
}
