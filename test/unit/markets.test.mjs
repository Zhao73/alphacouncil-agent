import { test } from "node:test";
import assert from "node:assert/strict";
import { marketFor, feedStatus, coverageFor, MARKETS } from "../../mcp/lib/markets.mjs";
import { table, mark, money, metricValue } from "../../mcp/lib/tables.mjs";

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
  assert.equal(mark(false), "**FAIL**");
});
