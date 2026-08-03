import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_WORKER_JSON_CHARS,
  balancedJsonCandidate,
  parseJsonTransport,
  stripJsonComments,
  stripTrailingCommas,
} from "../../mcp/lib/bounded-json.mjs";
import { assertRuntimeWorkerPayload } from "../../mcp/lib/runtime-validation.mjs";

const evidence = () => ({
  summary: "Sourced evidence packet with an explicit boundary.",
  claims: [{
    claim: "The filing reported a bounded fixture value.",
    evidence: "The primary-source fixture contains the value.",
    confidence: "medium",
    source_ids: ["S1"],
  }],
  metrics: { fixture: 1 },
  sources: [{
    id: "S1",
    title: "Fixture filing",
    url: "https://example.com/filing",
    published_at: "2026-08-01",
    retrieved_at: "2026-08-02",
  }],
  open_questions: [],
  confidence: "medium",
});

test("bounded JSON transport preserves exact JSON without a repair label", () => {
  const input = { nested: { closing: "} inside a string" }, values: [1, true, null] };
  const result = parseJsonTransport(JSON.stringify(input));
  assert.deepEqual(result, { value: input, strategy: "exact", repaired: false });
});

test("bounded JSON transport accepts fences, comments and trailing commas without guessing values", () => {
  const raw = `Worker note\n\`\`\`json\n{
    // source remains unchanged
    "url": "https://example.com/a//b",
    "nested": { "value": 1, },
    "items": [1, 2,],
  }\n\`\`\``;
  const result = parseJsonTransport(raw);
  assert.equal(result.strategy, "trailing_commas");
  assert.equal(result.repaired, true);
  assert.deepEqual(result.value, {
    url: "https://example.com/a//b",
    nested: { value: 1 },
    items: [1, 2],
  });
});

test("repair helpers do not treat string content as syntax", () => {
  const value = '{"text":"// keep /* all */ commas, } ]","nested":{"ok":true,},}';
  assert.equal(stripJsonComments(value), value);
  assert.deepEqual(JSON.parse(stripTrailingCommas(value)), {
    text: "// keep /* all */ commas, } ]",
    nested: { ok: true },
  });
  assert.equal(balancedJsonCandidate(`prefix ${value} suffix`), value);
});

test("bounded transport refuses semantic guesses and oversized output", () => {
  for (const unsafe of ["{'value': 1}", "{value: 1}", '{"value": 1']) {
    assert.throws(() => parseJsonTransport(unsafe), /bounded transport repair can safely recover/u);
  }
  assert.throws(
    () => parseJsonTransport('{"first":1}\n{"second":2}'),
    /multiple JSON payloads/u,
  );
  for (const truncatedSecondRoot of [
    '{"first":1}\n{"second":',
    '{"first":1}\n[{"second":',
  ]) {
    assert.throws(
      () => parseJsonTransport(truncatedSecondRoot),
      /multiple JSON payloads/u,
    );
  }
  assert.throws(
    () => parseJsonTransport(" ".repeat(MAX_WORKER_JSON_CHARS + 1)),
    /bounded transport-repair limit/u,
  );
});

test("bounded transport distinguishes a second JSON root from ordinary trailing prose", () => {
  for (const prose of [
    '{"first":1}\nWorker note [done]',
    '{"first":1}\nSee [documentation](https://example.com).',
    '{"first":1}\nWorker note "[1 is the first item]"',
    '{"first":1}\nWorker note {done}',
    '{"first":1}\n[done]',
    '{"first":1}\n[?]',
    '{"first":1}\n[✅]',
    '{"first":1}\n[trueish]',
    '{"first":1}\n[n/a]',
    '{"first":1}\n[1 of 2]',
    '{"first":1}\n{not valid}',
  ]) {
    assert.deepEqual(parseJsonTransport(prose).value, { first: 1 });
  }

  for (const secondRoot of [
    '{"first":1}\n[',
    '{"first":1}\n[-',
    '{"first":1}\n[1,',
    '{"first":1}\n[true,',
    '{"first":1}\n[tru   ',
    '{"first":1}\n[null,',
    '{"first":1}\n[\n  {"second":',
    '{"first":1}\n{ "second": 2 }',
    '{"first":1}\n{ }',
    '{"first":1}\n{   "second":',
    '{"first":1} correction: {"second":2}',
    '{"first":1}\n- {"second":2}',
    '{"first":1} correction: [false]',
  ]) {
    assert.throws(() => parseJsonTransport(secondRoot), /multiple JSON payloads/u);
  }
});

test("standalone runtime schemas accept complete packets and expose missing content", () => {
  const complete = evidence();
  assert.equal(assertRuntimeWorkerPayload("evidence", complete), complete);

  const incomplete = evidence();
  delete incomplete.sources;
  assert.throws(
    () => assertRuntimeWorkerPayload("evidence", incomplete),
    (error) => error?.data?.reason === "WORKER_OUTPUT_SCHEMA_MISMATCH"
      && error.data.errors.some((item) => item.missing_property === "sources"),
  );

  assert.throws(
    () => assertRuntimeWorkerPayload("evidence", {
      ...evidence(), claims: [], open_questions: [],
    }),
    (error) => error?.data?.reason === "WORKER_OUTPUT_SCHEMA_MISMATCH",
  );
});
