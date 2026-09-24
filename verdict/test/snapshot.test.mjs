import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isolateHome } from "./helpers.mjs";

isolateHome();
const { setFetch } = await import("../src/engine/http.mjs");
const { buildSnapshot, snapshotBrief } = await import("../src/engine/snapshot.mjs");
const { resetSecTickerCache } = await import("../src/engine/data.mjs");

const DAY = 86400;
function chart() {
  const now = Math.floor(Date.now() / 1000);
  const ts = Array.from({ length: 300 }, (_, i) => now - (300 - i) * DAY);
  const close = ts.map((_, i) => 100 + i * 0.2);
  return { chart: { result: [{ meta: { regularMarketPrice: 160, currency: "USD", chartPreviousClose: 158, regularMarketTime: now, fullExchangeName: "NasdaqGS", fiftyTwoWeekHigh: 165, fiftyTwoWeekLow: 110 }, timestamp: ts, indicators: { quote: [{ close, volume: ts.map(() => 1e6) }] } }] } };
}

test("snapshot: fetches in parallel, cites every source, computes lenses, records gaps", async () => {
  const seen = [];
  const restore = setFetch(async (url) => {
    const u = String(url);
    seen.push(new URL(u).host);
    const json = (o) => new Response(JSON.stringify(o));
    if (u.includes("/v1/finance/search")) return json({ quotes: [{ symbol: "ACME", quoteType: "EQUITY", longname: "Acme Corp", exchDisp: "NASDAQ" }] });
    if (u.includes("/v8/finance/chart")) return json(chart());
    if (u.includes("company_tickers")) return json({ 0: { ticker: "ACME", cik_str: 42, title: "Acme Corp" } });
    if (u.includes("companyfacts")) return json({ entityName: "Acme", facts: { "us-gaap": { Revenues: { units: { USD: [{ start: "2024-01-01", end: "2024-12-31", val: 900, form: "10-K", filed: "2025-02-01" }, { start: "2025-01-01", end: "2025-12-31", val: 1000, form: "10-K", filed: "2026-02-01" }] } } } } });
    if (u.includes("submissions")) return json({ name: "Acme", filings: { recent: { form: ["10-Q", "8-K"], filingDate: ["2026-08-01", "2026-07-15"], accessionNumber: ["0001-26-000001", "0001-26-000002"], primaryDocument: ["q.htm", "e.htm"], reportDate: ["2026-06-30", ""], primaryDocDescription: ["10-Q", "8-K"] } } });
    if (u.includes("news.google.com")) {
      const d = new Date(Date.now() - 2 * DAY * 1000).toUTCString();
      return new Response(`<rss><channel><item><title>Acme wins contract</title><link>https://x.test/1</link><pubDate>${d}</pubDate><source>Wire</source></item></channel></rss>`);
    }
    return new Response("nope", { status: 403 });
  });
  resetSecTickerCache();
  try {
    const s = await buildSnapshot("acme");
    assert.equal(s.instrument.name, "Acme Corp");
    assert.equal(s.quote.price, 160);
    assert.equal(s.fundamentals.metrics.revenue.value, 1000);
    assert.equal(s.filings.filings.length, 2);
    assert.equal(s.options, null);
    assert.ok(s.gaps.some((g) => /options/.test(g)));
    assert.deepEqual(Object.keys(s.sources).sort(), ["data:filings", "data:fundamentals", "data:quote", "data:technicals", "news:N1"]);
    assert.equal(s.lenses.length, 8);
    const brief = snapshotBrief(s);
    for (const id of ["[data:quote]", "[data:fundamentals]", "[news:N1]", "[lens:garp]"]) assert.ok(brief.includes(id), id);
    assert.ok(seen.includes("cdn.cboe.com"));
  } finally {
    restore();
  }
});

test("snapshot survives a total outage with named gaps", async () => {
  const restore = setFetch(async () => new Response("down", { status: 503 }));
  resetSecTickerCache();
  try {
    const s = await buildSnapshot("ZZZ");
    assert.equal(s.quote, null);
    assert.ok(s.gaps.length >= 3);
    assert.ok(s.lenses.every((l) => l.stance === "out_of_scope"));
  } finally {
    restore();
  }
});
