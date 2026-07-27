import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import {
  canDefineMethodRule,
  inclusiveCutoffTime,
  sourceVisibleAt,
  validateSourceAnchor,
} from "../../mcp/lib/personas-v3/source-anchor.mjs";
import { buildFactPack, validateTypedFact } from "../../mcp/lib/personas-v3/typed-facts.mjs";

const ZERO_HASH = `sha256:${"0".repeat(64)}`;

function source(overrides = {}) {
  return {
    schema_version: 1,
    source_id: "buffett:letter:1996",
    source_kind: "primary_text",
    grade: "A",
    author: "Warren E. Buffett",
    title: "1996 shareholder letter",
    url: "https://example.test/letter",
    published_at: "1997-03-01",
    public_at: "1997-03-01",
    known_at: "1997-03-01",
    retrieved_at: "2026-07-27",
    locator: { section: "Owner-related business principles" },
    summary: "A method proposition anchored to an exact section.",
    content_hash: ZERO_HASH,
    adjudication: { status: "approved", reviewer_ids: ["reviewer-a", "reviewer-b"], reviewed_at: "2026-07-27" },
    ...overrides,
  };
}

function fact(overrides = {}) {
  return {
    schema_version: 1,
    fact_id: "issuer.revenue.fy2025",
    value_kind: "monetary",
    value: 125,
    unit: "millions",
    currency: "USD",
    scale: 1_000_000,
    period_start: "2025-01-01",
    period_end: "2025-12-31",
    fiscal_year: 2025,
    as_of: "2026-07-27",
    public_at: "2026-02-15",
    source_ids: ["filing:S1"],
    derivation: "reported",
    confidence: 1,
    restatement_policy: "latest filing public by as_of wins",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
    ...overrides,
  };
}

test("canonical JSON is key-order stable and rejects non-finite numbers", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(sha256({ b: 2, a: 1 }), sha256({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
});

test("a method rule needs exact primary material and independent human review", () => {
  assert.deepEqual(validateSourceAnchor(source()), []);
  assert.equal(canDefineMethodRule(source()), true);
  assert.equal(canDefineMethodRule(source({ source_kind: "editorial_choice" })), false);
  assert.equal(canDefineMethodRule(source({ adjudication: { status: "approved", reviewer_ids: ["only-one"], reviewed_at: "2026-07-27" } })), false);
});

test("reviewer ids must be non-empty strings and are deduplicated after normalization", () => {
  const nonStrings = source({
    adjudication: { status: "approved", reviewer_ids: [null, {}], reviewed_at: "2026-07-27" },
  });
  assert.ok(validateSourceAnchor(nonStrings).some((error) => /must be a non-empty string/.test(error)));
  assert.equal(canDefineMethodRule(nonStrings), false);

  const normalizedDuplicate = source({
    adjudication: {
      status: "approved",
      reviewer_ids: ["reviewer-a", " reviewer-a "],
      reviewed_at: "2026-07-27",
    },
  });
  assert.ok(validateSourceAnchor(normalizedDuplicate)
    .some((error) => /duplicates after normalization/.test(error)));
  assert.equal(canDefineMethodRule(normalizedDuplicate), false);

  const unicodeDuplicate = source({
    adjudication: {
      status: "approved",
      reviewer_ids: ["reviewer-R", "reviewer-Ｒ"],
      reviewed_at: "2026-07-27",
    },
  });
  assert.ok(validateSourceAnchor(unicodeDuplicate)
    .some((error) => /duplicates after normalization/.test(error)));
  assert.equal(canDefineMethodRule(unicodeDuplicate), false);
});

test("source visibility applies public and knowledge cutoffs", () => {
  assert.equal(sourceVisibleAt(source(), { asOf: "1997-03-02", knowledgeAsOf: "1997-03-02" }), true);
  assert.equal(sourceVisibleAt(source(), { asOf: "1997-02-28", knowledgeAsOf: "1997-03-02" }), false);
  assert.equal(sourceVisibleAt(source({
    public_at: "1997-03-02T23:59:59.999Z",
    known_at: "1997-03-02T23:59:59.999Z",
  }), { asOf: "1997-03-02", knowledgeAsOf: "1997-03-02" }), true);
});

test("date-only cutoffs include the full UTC day while zoned timestamps remain exact", () => {
  assert.equal(inclusiveCutoffTime("2026-07-27"), Date.parse("2026-07-28T00:00:00.000Z") - 1);
  assert.equal(inclusiveCutoffTime("2026-07-27T12:30:00.000Z"), Date.parse("2026-07-27T12:30:00.000Z"));
  assert.equal(Number.isNaN(inclusiveCutoffTime("2026-07-27T12:30:00")), true);
  assert.equal(Number.isNaN(inclusiveCutoffTime("2026-02-30")), true);
});

test("future public facts are rejected rather than silently admitted", () => {
  const errors = validateTypedFact(fact({ public_at: "2026-08-01" }));
  assert.ok(errors.some((error) => /public_at must be <= as_of/.test(error)));
});

test("a date-only fact cutoff includes observations published later that UTC day", () => {
  const sameDay = fact({ public_at: "2026-07-27T23:59:59.999Z" });
  assert.deepEqual(validateTypedFact(sameDay), []);
  assert.doesNotThrow(() => buildFactPack([sameDay], {
    asOf: "2026-07-27",
    knowledgeAsOf: "2026-07-27",
  }));
  assert.ok(validateTypedFact(fact({
    as_of: "2026-07-27T12:00:00.000Z",
    public_at: "2026-07-27T12:00:00.001Z",
  })).some((error) => /public_at must be <= as_of/.test(error)));
});

test("monetary facts require currency and scale", () => {
  const errors = validateTypedFact(fact({ currency: null, scale: null }));
  assert.ok(errors.some((error) => /currency/.test(error)));
  assert.ok(errors.some((error) => /scale/.test(error)));
});

test("fact-pack hash is independent of input ordering and duplicate ids fail closed", () => {
  const first = fact();
  const second = fact({ fact_id: "issuer.cash.fy2025", value: 30 });
  const a = buildFactPack([first, second], { asOf: "2026-07-27" });
  const b = buildFactPack([second, first], { asOf: "2026-07-27" });
  assert.equal(a.fact_pack_hash, b.fact_pack_hash);
  assert.throws(() => buildFactPack([first, first], { asOf: "2026-07-27" }), /duplicate fact_id/);
});

test("fact packs detach and recursively freeze caller-owned facts before hashing", () => {
  const original = fact();
  const pack = buildFactPack([original], { asOf: "2026-07-27" });
  const hash = pack.fact_pack_hash;

  original.value = 999;
  original.lineage.input_fact_ids.push("mutated.after.hash");
  assert.equal(pack.facts[0].value, 125);
  assert.deepEqual(pack.facts[0].lineage.input_fact_ids, []);
  assert.equal(pack.fact_pack_hash, hash);
  assert.equal(Object.isFrozen(pack.facts), true);
  assert.equal(Object.isFrozen(pack.facts[0]), true);
  assert.equal(Object.isFrozen(pack.facts[0].lineage), true);
  assert.throws(() => { pack.facts[0].value = 999; }, TypeError);
  assert.throws(() => { pack.facts[0].lineage.input_fact_ids.push("mutate.returned.pack"); }, TypeError);
});
