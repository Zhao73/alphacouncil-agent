import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

import { columnIndex, excelSerialToIso, readWorkbook, unzip, xlsxRows } from "../../mcp/lib/xlsx.mjs";

/** Build a minimal xlsx in memory so the reader is tested without a network fixture. */
function workbook({ date1904 = false, sheetXml, shared = [] } = {}) {
  const parts = [
    ["xl/workbook.xml", `<workbook><workbookPr${date1904 ? ' date1904="1"' : ""}/></workbook>`],
    ["xl/worksheets/sheet1.xml", sheetXml],
    ...(shared.length
      ? [["xl/sharedStrings.xml", `<sst>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}</sst>`]]
      : []),
  ];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of parts) {
    const raw = Buffer.from(body, "utf8");
    const deflated = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, deflated);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const SHEET = '<sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>7499</v></c></row></sheetData>';

test("the date system is read from the workbook, not assumed", () => {
  // A Mac-authored workbook sets date1904 and its serials sit 1,462 days from the default
  // epoch. Read with the wrong one, a current dataset silently looks four years stale.
  assert.equal(excelSerialToIso(44742, { date1904: false }), "2022-06-30");
  assert.equal(excelSerialToIso(44742, { date1904: true }), "2026-07-01");
  assert.equal(readWorkbook(workbook({ sheetXml: SHEET, shared: ["Date"] })).date1904, false);
  assert.equal(readWorkbook(workbook({ date1904: true, sheetXml: SHEET, shared: ["Date"] })).date1904, true);
});

test("the 1900 system's phantom leap day is removed and 1904's is not", () => {
  assert.equal(excelSerialToIso(59, { date1904: false }), "1900-02-28");
  assert.equal(excelSerialToIso(61, { date1904: false }), "1900-03-01");
  assert.equal(excelSerialToIso(0, { date1904: true }), "1904-01-01");
  assert.equal(excelSerialToIso("not a number"), null);
  assert.equal(excelSerialToIso(-1), null);
});

test("shared strings resolve and absent cells stay absent", () => {
  // Cells are addressed, not ordered: an empty cell is simply not written.
  const { sheets } = readWorkbook(workbook({ sheetXml: SHEET, shared: ["Start of month"] }));
  assert.equal(sheets[0].rows[0][0], "Start of month");
  assert.equal(sheets[0].rows[0][1], undefined);
  assert.equal(sheets[0].rows[0][2], "7499");
  assert.equal(columnIndex("A"), 0);
  assert.equal(columnIndex("AB12"), 27);
  assert.equal(columnIndex(""), -1);
});

test("anything that is not the ordinary archive shape fails closed", () => {
  assert.throws(() => unzip(Buffer.from("not a zip at all")), /not a ZIP\/xlsx container/);
  assert.throws(() => readWorkbook(Buffer.alloc(0)), /not a ZIP\/xlsx container/);
});

test("a rich-text shared string is concatenated rather than truncated", () => {
  const rows = xlsxRows('<row><c r="A1" t="inlineStr"><is><t>Start </t><t>of month</t></is></c></row>', []);
  assert.equal(rows[0][0], "Start of month");
});
