import { test } from "node:test";
import assert from "node:assert/strict";
import { industryBrief, listIndustries, resolveIndustry } from "../../mcp/lib/industry.mjs";

test("an industry resolves from an id, an alias, and either language", () => {
  for (const query of ["memory", "存储", "HBM", "dram", "存储芯片"]) {
    assert.ok(resolveIndustry(query), `${query} should resolve`);
  }
  assert.equal(resolveIndustry("underwater basket weaving"), null);
});

// The reason this is data rather than a model call: a model listing memory companies
// returns the ones it saw most often, which drops the makers that do not file with SEC.
test("the map keeps the non-US participants a SEC-only pipeline would lose", () => {
  const brief = industryBrief("memory");
  const symbols = brief.participants.map((p) => p.symbol);
  for (const required of ["000660.KS", "005930.KS", "285A.T"]) {
    assert.ok(symbols.includes(required), `${required} must be in the memory map`);
  }
  assert.ok(brief.coverage.needs_local_regulator_feed.length >= 3);
  assert.ok(brief.coverage.unlisted.length >= 1, "unlisted capacity still moves supply");
});

test("coverage separates what can be screened from what cannot", () => {
  const brief = industryBrief("memory");
  const screenable = new Set(brief.coverage.sec_screenable);
  const foreign = new Set(brief.coverage.needs_local_regulator_feed.map((p) => p.symbol));
  for (const symbol of screenable) assert.ok(!foreign.has(symbol), `${symbol} cannot be in both buckets`);
  assert.ok(screenable.has("MU"));
  assert.ok(foreign.has("000660.KS"));
  assert.match(brief.coverage.note, /partial/, "the note must warn that a US-only read is partial");
});

test("the brief carries demand drivers and the questions a run must answer", () => {
  const brief = industryBrief("memory");
  assert.ok(brief.demand_drivers.length >= 2);
  assert.ok(brief.key_questions.length >= 4);
  // Cyclicality is stated because reading a cyclical's low P/E as cheap is the most
  // expensive available mistake in this industry.
  assert.match(brief.cyclicality.en, /cyclical/i);
  assert.match(brief.cyclicality.zh, /周期/);
});

test("the brief gives a frame and never a verdict", () => {
  const brief = industryBrief("memory");
  const text = JSON.stringify(brief).toLowerCase();
  for (const word of ["overweight", "target price", "we recommend"]) {
    assert.ok(!text.includes(word), `an industry brief must not contain "${word}"`);
  }
  assert.match(brief.how_to_use, /frame, not an answer/);
});

test("an unmapped industry fails with the list of mapped ones", () => {
  assert.throws(() => industryBrief("tulips"), /no industry map for "tulips"/);
  assert.throws(() => industryBrief("tulips"), /industry-map\.json/);
});

test("listIndustries reports what is actually mapped", () => {
  const industries = listIndustries();
  assert.ok(industries.length >= 1);
  for (const industry of industries) {
    assert.ok(industry.aliases.length >= 2);
    assert.ok(industry.participant_count >= 5);
  }
});
