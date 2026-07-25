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

// ---- SIC coverage: the half that reaches every industry ---------------------

import { sicGroupFor, industryCoverage, SIC_GROUPS } from "../../mcp/lib/industry.mjs";

test("SIC groups cover the major sectors without overlapping ambiguously", () => {
  assert.ok(SIC_GROUPS.length >= 20, "coverage must be broad enough to be useful");
  for (const group of SIC_GROUPS) {
    assert.ok(group.range[0] <= group.range[1], `${group.id} has an inverted range`);
    assert.ok(group.title.zh && group.title.en, `${group.id} needs both languages`);
  }
});

test("the narrowest matching SIC range wins", () => {
  // 3674 falls inside electronics as well; semiconductors is the specific answer.
  assert.equal(sicGroupFor(3674).id, "semiconductors");
  assert.equal(sicGroupFor(7372).id, "software");
  assert.equal(sicGroupFor(6022).id, "banks");
  assert.equal(sicGroupFor(2836).id, "pharma_biotech");
  assert.equal(sicGroupFor(99999), null);
  assert.equal(sicGroupFor("not a code"), null);
});

test("coverage tells the caller which half of the story exists", () => {
  const curated = industryCoverage("存储");
  assert.equal(curated.curated.id, "memory");
  assert.match(curated.guidance, /curated map exists/);

  // The point of the SIC layer: an industry nobody wrote a map for is still reachable.
  const sicOnly = industryCoverage("banks");
  assert.equal(sicOnly.curated, null);
  assert.equal(sicOnly.sic_group.id, "banks");
  assert.match(sicOnly.guidance, /not curated/);

  const neither = industryCoverage("tulips");
  assert.equal(neither.curated, null);
  assert.equal(neither.sic_group, null);
  assert.match(neither.guidance, /not authoritative/);
});

test("coverage never claims completeness it does not have", () => {
  for (const query of ["banks", "software", "tulips"]) {
    const coverage = industryCoverage(query);
    if (!coverage.curated) {
      assert.ok(
        /not curated|not authoritative/.test(coverage.guidance),
        `${query}: guidance must warn the participant list is not curated`,
      );
    }
  }
});
