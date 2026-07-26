import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed, applyRecencyGate, tickerNewsFeed, queryNewsFeed, filingsFeed } from "../../mcp/lib/feeds.mjs";
import { classify, THEMES } from "../../mcp/lib/narrative.mjs";

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>Feed title that must not become an item</title>
  <item>
    <title><![CDATA[Micron guides higher on HBM & DRAM]]></title>
    <link>https://example.com/a</link>
    <pubDate>Fri, 24 Jul 2026 14:30:00 GMT</pubDate>
  </item>
  <item>
    <title>An old story</title>
    <link>https://example.com/b</link>
    <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Undated wire copy</title>
    <link>https://example.com/c</link>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>8-K  - Current report</title>
    <link rel="alternate" href="https://www.sec.gov/Archives/x.htm"/>
    <updated>2026-07-23T16:02:01-04:00</updated>
  </entry>
</feed>`;

test("parseFeed reads RSS items and leaves the channel title alone", () => {
  const items = parseFeed(RSS, { source: "test" });
  assert.equal(items.length, 3, "three <item> elements, not the channel title");
  assert.equal(items[0].title, "Micron guides higher on HBM & DRAM", "CDATA and &amp; are decoded");
  assert.equal(items[0].link, "https://example.com/a");
  assert.equal(items[0].published_at, "2026-07-24T14:30:00.000Z");
  assert.equal(items[2].published_at, null, "an undated item gets null, never a guessed date");
});

test("parseFeed reads Atom entries, taking the link from its href attribute", () => {
  const [entry] = parseFeed(ATOM, { source: "sec" });
  assert.equal(entry.link, "https://www.sec.gov/Archives/x.htm");
  assert.equal(entry.published_at, "2026-07-23T20:02:01.000Z");
  assert.equal(entry.source, "sec");
});

// The whole point of this layer. Without it a "latest news" section fills with old
// articles that look exactly like today's, and no reader can tell them apart.
test("the recency gate excludes stale and undated items rather than including them", () => {
  const { included, excluded } = applyRecencyGate(parseFeed(RSS), { days: 14, asOf: "2026-07-26" });
  assert.deepEqual(included.map((i) => i.title), ["Micron guides higher on HBM & DRAM"]);
  assert.deepEqual(excluded.map((i) => i.excluded_because).sort(),
    ["no parsable timestamp", "older than 14d"]);
});

test("a future timestamp is excluded, not treated as the freshest item", () => {
  const items = parseFeed(RSS.replace("Fri, 24 Jul 2026", "Fri, 24 Jul 2030"));
  const { included, excluded } = applyRecencyGate(items, { days: 14, asOf: "2026-07-26" });
  assert.equal(included.length, 0);
  assert.ok(excluded.some((e) => e.excluded_because === "timestamp in the future"));
});

test("included items are ordered newest first", () => {
  const xml = `<rss><channel>
    <item><title>older</title><pubDate>Tue, 21 Jul 2026 00:00:00 GMT</pubDate></item>
    <item><title>newer</title><pubDate>Fri, 24 Jul 2026 00:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const { included } = applyRecencyGate(parseFeed(xml), { days: 14, asOf: "2026-07-26" });
  assert.deepEqual(included.map((i) => i.title), ["newer", "older"]);
});

test("feed URLs escape their inputs", () => {
  assert.match(queryNewsFeed("HBM supply & Samsung").url, /HBM%20supply%20%26%20Samsung/);
  assert.match(tickerNewsFeed("BRK.B").url, /s=BRK\.B/);
  assert.match(filingsFeed("723125").url, /CIK=0000723125/, "CIK is zero-padded to ten digits");
  assert.match(filingsFeed("723125", "10-Q").url, /type=10-Q/);
});

// ---- theme classification -------------------------------------------------

test("a headline can carry several themes at once", () => {
  const ids = classify("Fed holds rates as Treasury yields climb on Iran strike fears").map((h) => h.id);
  assert.deepEqual(ids.sort(), ["geopolitics", "rates_policy", "treasury_yields"]);
});

// A prefix rule on a two-letter term fires on "aid" and "aircraft", which would inflate a
// theme's coverage share while the number still looks authoritative.
test("short terms match whole words so 'ai' does not fire on 'aid'", () => {
  assert.deepEqual(classify("Red Cross sends aid to the region"), []);
  assert.deepEqual(classify("Aircraft orders rise"), []);
  assert.ok(classify("New AI data center announced").some((h) => h.id === "ai_capex"));
});

test("long terms match as a prefix so plurals and inflections still count", () => {
  assert.ok(classify("New tariffs on imports").some((h) => h.id === "trade_tariffs"));
  assert.ok(classify("Recessionary signals build").some((h) => h.id === "growth_recession"));
});

test("a mortgage refinancing rate story is not credit stress", () => {
  // "refinanc" as a bare prefix used to pull routine mortgage-rate copy into credit stress.
  assert.ok(!classify("Mortgage and refinance interest rates today").some((h) => h.id === "credit_stress"));
  assert.ok(classify("Refinancing wall looms for high yield issuers").some((h) => h.id === "credit_stress"));
});

test("every theme names series that macro.mjs can actually supply", async () => {
  const { getMacroSnapshot } = await import("../../mcp/lib/macro.mjs");
  const { MACRO_BLOCKS } = await import("../../mcp/lib/macro.mjs");
  const labels = new Set(MACRO_BLOCKS.flatMap((b) => b.members.map((m) => m.label)));
  assert.ok(typeof getMacroSnapshot === "function");
  for (const theme of THEMES) {
    for (const label of theme.check.series) {
      assert.ok(labels.has(label), `theme ${theme.id} checks "${label}", which no macro block provides`);
    }
  }
});
