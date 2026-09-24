import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fakeBackend, fakeSnapshot, isolateHome } from "./helpers.mjs";

const home = isolateHome();
process.env.VERDICT_OFFLINE = "1";
const { research, htmlPath } = await import("../src/engine/pipeline.mjs");
const { compare } = await import("../src/engine/compare.mjs");
const { addWatch, removeWatch, watchlist, watchStatus, trackRecord, zoneFor } = await import("../src/engine/watch.mjs");
const { classifyQuestion } = await import("../src/engine/intent.mjs");
const { partialString } = await import("../src/engine/partial.mjs");
const { parseRange, priceChart } = await import("../src/render/html.mjs");

test("question intent steers the desks", () => {
  assert.equal(classifyQuestion("财报前要不要拿着？").kind, "earnings");
  assert.equal(classifyQuestion("Is it undervalued?").kind, "valuation");
  assert.equal(classifyQuestion("good for a swing trade next week?").kind, "trade");
  assert.equal(classifyQuestion("长期拿住可以吗").kind, "long_term");
  assert.equal(classifyQuestion("should I sell?").kind, "risk");
  assert.equal(classifyQuestion("").kind, "general");
});

test("partial JSON string extraction for streaming", () => {
  assert.equal(partialString('{"rating":"Buy","conclusion":"Strong \\"moat\\" and', "conclusion").value, 'Strong "moat" and');
  assert.equal(partialString('{"rating":"Bu', "rating").done, false);
  assert.deepEqual(partialString('{"rating":"Buy",', "rating"), { value: "Buy", done: true });
  assert.equal(partialString('{"rat', "conclusion"), null);
  assert.equal(partialString('{"conclusion":"\\u4e2d\\u6587', "conclusion").value, "中文");
});

test("research streams the conclusion, tags intent and writes an HTML report", async () => {
  const snap = await fakeSnapshot();
  snap.series = Array.from({ length: 60 }, (_, i) => [`2026-0${1 + Math.floor(i / 20)}-${String(1 + (i % 20)).padStart(2, "0")}`, 90 + i / 3]);
  const drafts = [];
  const run = await research({ symbol: "TEST", question: "is it undervalued?", backend: fakeBackend(), snapshot: snap, onEvent: (e) => e.type === "draft" && drafts.push(e) });
  assert.equal(run.intent.kind, "valuation");
  assert.ok(drafts.length > 1);
  assert.match(drafts.at(-1).text, /^Overweight: durable margins/);
  assert.equal(drafts.at(-1).rating, "Overweight");
  const html = readFileSync(htmlPath(run.run_id), "utf8");
  assert.match(html, /<svg viewBox/);
  assert.match(html, /class="band bear"/);
  assert.match(html, /Overweight/);
  assert.doesNotMatch(html, /<script/);
  assert.ok(priceChart(run).includes("base 115"));
});

test("price ranges parse for zones and chart bands", () => {
  assert.deepEqual(parseRange("> 280"), [280, null]);
  assert.deepEqual(parseRange("205-235"), [205, 235]);
  assert.deepEqual(parseRange("< 1,980"), [null, 1980]);
  assert.deepEqual(parseRange("180 – 210 USD"), [180, 210]);
  assert.equal(parseRange("n/a"), null);
  const levels = [{ range: "> 130", action: "avoid" }, { range: "95-115", action: "start" }, { range: "< 85", action: "add" }];
  assert.equal(zoneFor(levels, 100).action, "start");
  assert.equal(zoneFor(levels, 80).action, "add");
  assert.equal(zoneFor(levels, 120), null);
});

test("compare researches every ticker and ranks the verdicts", async () => {
  const events = [];
  const r = await compare({ symbols: ["aaa", "BBB", "AAA"], backend: fakeBackend(), onEvent: (e) => events.push(e), concurrency: 2 });
  assert.deepEqual(r.symbols, ["AAA", "BBB"]);
  assert.equal(r.runs.length, 2);
  assert.equal(r.ranking.ranking[0].symbol, "AAA");
  assert.ok(events.some((e) => e.symbol === "BBB" && e.type === "task"));
  assert.ok(existsSync(join(home, "compare", r.id, "compare.md")));
  assert.match(readFileSync(join(home, "compare", r.id, "compare.md"), "utf8"), /\| 1 \| \*\*AAA\*\*/);
  await assert.rejects(compare({ symbols: ["AAA"], backend: fakeBackend() }), /at least two/);
});

test("watchlist alerts on zone changes and new filings; track record scores verdicts", async () => {
  const run = await research({ symbol: "WAT", backend: fakeBackend(), snapshot: await fakeSnapshot("WAT") });
  assert.deepEqual(addWatch("wat", "NEW"), ["WAT", "NEW"]);
  const rows = await watchStatus({
    quote: async (s) => ({ price: s === "WAT" ? 80 : 10, currency: "USD", change_pct: 1 }),
    filings: async () => ({ filings: [{ form: "8-K", filed: "2999-01-01" }] }),
  });
  const wat = rows.find((r) => r.symbol === "WAT");
  assert.equal(wat.rating, "Overweight");
  assert.equal(wat.zone, "add (< 85)");
  assert.ok(wat.alerts.some((a) => /entered the "add" zone/.test(a)));
  assert.ok(wat.alerts.some((a) => /new filing/.test(a)));
  assert.deepEqual(rows.find((r) => r.symbol === "NEW").alerts, ["no verdict yet"]);
  assert.deepEqual(removeWatch("NEW"), ["WAT"]);
  assert.deepEqual(watchlist(), ["WAT"]);

  const t = await trackRecord({ quote: async () => ({ price: 120 }), minAgeDays: 0, now: Date.now() + 1000 });
  const row = t.rows.find((x) => x.run_id === run.run_id);
  assert.equal(row.return_pct, 20);
  assert.equal(row.hit, true);
  assert.ok(t.hit_rate > 0);
});
