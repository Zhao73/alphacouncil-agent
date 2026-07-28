/**
 * Read an .xlsx with Node built-ins and nothing else.
 *
 * An xlsx is a ZIP of XML parts, and `zlib.inflateRawSync` is enough to open one. Extracted
 * from the fund adapter because it has no fund-domain knowledge at all: any publisher that
 * ships a workbook -- issuer holdings, an academic dataset -- reads through the same three
 * steps. Adding a spreadsheet dependency to a zero-dependency package is not worth it for
 * what fits in a hundred lines.
 *
 * Everything unusual fails closed. This reads the ordinary single-workbook shape; it is not a
 * general ZIP implementation and must not quietly behave like one.
 */

import { inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP central-directory reader.
 *
 * An xlsx is a ZIP of XML parts, and `zlib.inflateRawSync` is enough to read one, so a workbook is
 * readable without adding a dependency. Entries are located through the CENTRAL directory
 * rather than the local headers on purpose: when the archive uses a data descriptor, the
 * local header's sizes are zeroed and only the central directory is truthful.
 *
 * Everything unusual fails closed. This reads the one archive shape SSGA publishes; it is not
 * a general ZIP implementation and must not silently behave like one.
 */
export function unzip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error("response is not a ZIP/xlsx container");
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
export const xmlText = (fragment) => {
  let out = "";
  for (const match of String(fragment).matchAll(/<t[^>]*>([\s\S]*?)<\/t>/gu)) out += match[1];
  return unescapeXml(out);
};

/** "AB12" -> 27. Cells are addressed, not ordered: empty cells are simply absent. */
export const columnIndex = (ref) => {
  const letters = /^([A-Z]+)/u.exec(String(ref || "").toUpperCase());
  if (!letters) return -1;
  return [...letters[1]].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
};

export function xlsxRows(sheetXml, sharedStrings) {
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
 * Open a workbook: every sheet's rows, plus the date system its serials are counted in.
 *
 * The date system is not optional detail. A workbook written by Mac Excel sets
 * `date1904="1"` and its serials sit 1,462 days from the default epoch -- read with the wrong
 * one, every date is silently four years and a day early, which looks entirely plausible and
 * is how a current dataset gets mistaken for a stale one.
 *
 * Callers locate their header row by content rather than by offset: publishers move the table
 * when the surrounding label and disclosure rows change length.
 */
export function readWorkbook(buffer) {
  const entries = unzip(buffer);
  const workbookPart = entries.get("xl/workbook.xml");
  const date1904 = workbookPart ? /date1904\s*=\s*"(?:1|true)"/iu.test(workbookPart()) : false;
  const sharedPart = entries.get("xl/sharedStrings.xml");
  const sharedStrings = sharedPart
    ? [...sharedPart().matchAll(/<si>([\s\S]*?)<\/si>/gu)].map((match) => xmlText(match[1]))
    : [];
  const sheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/[^/]+\.xml$/u.test(name))
    .sort()
    .map((name) => ({ name, rows: xlsxRows(entries.get(name)(), sharedStrings) }));
  if (!sheets.length) throw new Error("workbook contains no worksheet part");
  return { date1904, sheets };
}

/**
 * Excel serial date to ISO, honouring the workbook's date system.
 *
 * In the default 1900 system day 1 is 1900-01-01 and the format wrongly treats 1900 as a leap
 * year, so serials at or above 60 carry an extra day that has to come back out. The 1904
 * system has neither quirk.
 */
export function excelSerialToIso(serial, { date1904 = false } = {}) {
  const value = Number(serial);
  if (!Number.isFinite(value) || value < 0) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const days = date1904 ? value : (value >= 60 ? value - 1 : value);
  return new Date(epoch + (days * 86400000)).toISOString().slice(0, 10);
}

export function readWorkbookRows(buffer, { sheetPath = null } = {}) {
  const entries = unzip(buffer);
  const sharedPart = entries.get("xl/sharedStrings.xml");
  const sharedStrings = sharedPart
    ? [...sharedPart().matchAll(/<si>([\s\S]*?)<\/si>/gu)].map((match) => xmlText(match[1]))
    : [];
  const target = sheetPath
    || [...entries.keys()].find((name) => /^xl\/worksheets\/sheet1\.xml$/u.test(name))
    || [...entries.keys()].find((name) => /^xl\/worksheets\/.+\.xml$/u.test(name));
  if (!target) throw new Error("workbook contains no worksheet part");
  return xlsxRows(entries.get(target)(), sharedStrings);
}
