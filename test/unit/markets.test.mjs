import { test } from "node:test";
import assert from "node:assert/strict";
import { marketFor, feedStatus, coverageFor, MARKETS } from "../../mcp/lib/markets.mjs";
import { table, mark, money, metricValue, label, threshold, skippedMark } from "../../mcp/lib/tables.mjs";

test("symbols route to the right market by suffix", () => {
  assert.equal(marketFor("MU").id, "US");
  assert.equal(marketFor("2408.TW").id, "TW");
  assert.equal(marketFor("000660.KS").id, "KR");
  assert.equal(marketFor("285A.T").id, "JP");
  assert.equal(marketFor("0700.HK").id, "HK");
  assert.equal(marketFor("600519.SS").id, "CN");
  assert.equal(marketFor(""), null);
});

test("a keyless feed is available and a keyed one is honest about why it is not", () => {
  assert.equal(feedStatus(MARKETS.US).available, true);
  assert.equal(feedStatus(MARKETS.TW).available, true);

  const previous = process.env.ALPHACOUNCIL_DART_KEY;
  delete process.env.ALPHACOUNCIL_DART_KEY;
  const kr = feedStatus(MARKETS.KR);
  assert.equal(kr.available, false);
  assert.equal(kr.env, "ALPHACOUNCIL_DART_KEY");
  assert.match(kr.reason, /opendart/, "the reason must name the source so it can be fixed");

  process.env.ALPHACOUNCIL_DART_KEY = "test";
  assert.equal(feedStatus(MARKETS.KR).available, true);
  if (previous === undefined) delete process.env.ALPHACOUNCIL_DART_KEY;
  else process.env.ALPHACOUNCIL_DART_KEY = previous;
});

// The point of the whole module: a US-only answer must not be able to pass as global.
test("coverage states what is missing rather than omitting it", () => {
  const previous = process.env.ALPHACOUNCIL_DART_KEY;
  delete process.env.ALPHACOUNCIL_DART_KEY;
  const coverage = coverageFor(["MU", "2408.TW", "000660.KS", "0700.HK"]);
  assert.equal(coverage.rows.length, 4);
  assert.equal(coverage.rows.find((r) => r.symbol === "MU").structured_financials, "yes");
  assert.equal(coverage.rows.find((r) => r.symbol === "2408.TW").structured_financials, "summary only");
  assert.equal(coverage.rows.find((r) => r.symbol === "000660.KS").needs_env, "ALPHACOUNCIL_DART_KEY");
  assert.equal(coverage.summary.none, 2);
  assert.match(coverage.note, /labelled as such/, "un-fed names stay researchable but must be labelled");
  if (previous !== undefined) process.env.ALPHACOUNCIL_DART_KEY = previous;
});

test("every market declares a regulator and what it can actually deliver", () => {
  for (const market of Object.values(MARKETS)) {
    assert.ok(market.regulator, `${market.id} needs a regulator`);
    assert.ok(["keyless", "free_key", "none"].includes(market.tier), `${market.id} tier`);
    assert.ok(market.note.length > 20, `${market.id} needs a usable note`);
  }
});

// ---- tables ---------------------------------------------------------------

test("a table renders a markdown header and separator", () => {
  const out = table(["A", "B"], [[1, 2]], { title: "T" });
  assert.match(out, /\*\*T\*\*/);
  assert.match(out, /\| A \| B \|/);
  assert.match(out, /\|---\|---\|/);
  assert.match(out, /\| 1 \| 2 \|/);
});

test("a pipe in a cell cannot break the table", () => {
  assert.match(table(["A"], [["x|y"]]), /x\\\|y/);
});

test("an empty table says so instead of rendering a broken one", () => {
  assert.equal(table(["A"], []), "_(no rows)_");
  assert.match(table(["A"], [], { empty: "nothing" }), /nothing/);
});

test("money and metric formatting stay readable at every scale", () => {
  assert.equal(money(-33572000000), "-33.57bn USD");
  assert.equal(money(1500000), "1.5m USD");
  assert.equal(money(null), "n/a");
  assert.equal(metricValue(27.17, "%"), "27.17%");
  assert.equal(metricValue(2.5, "x"), "2.5 x");
  assert.equal(metricValue(null, "%"), "n/a");
  // A glyph to scan plus a word that survives a terminal rendering the glyph badly.
  assert.match(mark(false), /\*\*FAIL\*\*/);
  assert.match(mark(true), /pass/);
  assert.notEqual(mark(true), mark(false));
});

// ---- Korea and Japan adapters ---------------------------------------------

import { fetchDartFinancials, fetchEdinetFilings } from "../../mcp/lib/markets-kr-jp.mjs";

test("without a key the adapters name the variable and where to get it", async () => {
  const kr = await fetchDartFinancials({ corpCode: "00126380", year: 2024, key: "" });
  assert.equal(kr.available, false);
  assert.match(kr.reason, /ALPHACOUNCIL_DART_KEY/);
  assert.match(kr.reason, /opendart\.fss\.or\.kr/);

  const jp = await fetchEdinetFilings({ secCode: "285A", key: "" });
  assert.equal(jp.available, false);
  assert.match(jp.reason, /ALPHACOUNCIL_EDINET_KEY/);
});

// A misconfigured key must not look like "this company filed nothing". The mapping is
// asserted against DART's documented status codes rather than by calling DART: a unit
// test that reaches the network fails for reasons that have nothing to do with the code,
// which is exactly what happened on the Node 18 runner.
test("DART status codes distinguish a key problem from an absence of data", async () => {
  const { DART_KEY_ERRORS } = await import("../../mcp/lib/markets-kr-jp.mjs");
  for (const code of ["010", "011", "012", "020", "021"]) {
    assert.ok(DART_KEY_ERRORS[code], `${code} must be recognised as a key problem`);
  }
  // 013 is "no data", a legitimate answer about the company rather than about the key.
  assert.equal(DART_KEY_ERRORS["013"], undefined, "no-data must not be reported as a key problem");
  assert.match(DART_KEY_ERRORS["010"], /not registered/);
});

// ---- the dashboard --------------------------------------------------------

import { groundingDashboard } from "../../mcp/lib/tables.mjs";

const dashboardInput = {
  quote: { symbol: "MU", price: 920.95, currency: "USD", change_pct: -6.99, source: "yahoo" },
  filer: { name: "MICRON TECHNOLOGY INC", sic: 3674, sic_description: "Semiconductors" },
  screen: {
    verdict: "survives", rules_computed: 6, rules_total: 7,
    metrics: [{ label: "long-run gross margin below 15%", value: 27.17, unit: "%", threshold: 15, passed: true }],
    skipped: ["dilution"],
  },
  macro: { derived: [{ label: "10Y minus 3M", value: 0.874 }] },
  coverage: { rows: [{ symbol: "000660.KS", market: "KR", structured_financials: "no", needs_env: "ALPHACOUNCIL_DART_KEY" }] },
  industry: { participants: [{ name: "SK hynix", symbol: "000660.KS", market: "KR", layer: { zh: "存储原厂", en: "Memory makers" } }] },
  unavailable: ["structured financials for 285A.T"],
};

test("the dashboard puts every section in one document", () => {
  const out = groundingDashboard(dashboardInput, "English");
  for (const section of ["Established facts", "Mechanical screen", "Macro", "Data coverage", "Value chain"]) {
    assert.match(out, new RegExp(section), `missing section: ${section}`);
  }
  assert.match(out, /27\.17%/);
  assert.match(out, /SK hynix/);
  assert.match(out, /ALPHACOUNCIL_DART_KEY/);
});

test("a skipped rule appears in the dashboard as skipped, not as a pass", () => {
  const out = groundingDashboard(dashboardInput, "English");
  assert.match(out, /dilution \| not computable/);
  assert.ok(!/dilution \| .* \| pass/.test(out));
});

// Gaps must survive into the human-facing view, or the dashboard becomes a way to lose them.
test("data gaps are shown with the instruction not to fill them", () => {
  assert.match(groundingDashboard(dashboardInput, "English"), /Data gaps — do not fill these from memory/);
  assert.match(groundingDashboard(dashboardInput, "中文"), /数据缺口 — 禁止用记忆填补/);
});

test("the dashboard follows the requested language", () => {
  const zh = groundingDashboard(dashboardInput, "中文");
  assert.match(zh, /研究总览/);
  assert.match(zh, /硬指标筛选/);
  assert.match(zh, /存储原厂/);
  assert.match(zh, /未上市|000660\.KS/);
});

test("an empty grounding still produces a heading rather than throwing", () => {
  assert.match(groundingDashboard({ unavailable: [] }, "English"), /Research dashboard/);
});


// ---- bilingual rendering ---------------------------------------------------

test("a label renders in the requested language and tolerates a plain string", () => {
  assert.equal(label({ en: "10-year average ROE", zh: "10年平均ROE" }, false), "10-year average ROE");
  assert.equal(label({ en: "10-year average ROE", zh: "10年平均ROE" }, true), "10年平均ROE");
  assert.equal(label("plain", true), "plain", "an older plain-string label must still render");
  assert.equal(label(undefined, true), "");
});

// "27.17% vs 15" can be read either way; the arrow removes the ambiguity.
test("a threshold shows which direction passes", () => {
  assert.equal(threshold(8, "min", "%"), "≥ 8%");
  assert.equal(threshold(20, "max", "%"), "≤ 20%");
  assert.equal(threshold(0, undefined, "USD"), "0 USD", "no direction means no arrow, not a wrong one");
});

test("a skipped marker is visually distinct from both pass and fail", () => {
  const values = new Set([mark(true), mark(false), skippedMark(false)]);
  assert.equal(values.size, 3);
  assert.match(skippedMark(true), /跳过/);
});