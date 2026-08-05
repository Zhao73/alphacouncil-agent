import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_WORKER_JSON_CHARS,
  balancedJsonCandidate,
  parseJsonTransport,
  parseJsonTransportCandidates,
  stripJsonComments,
  stripTrailingCommas,
} from "../../mcp/lib/bounded-json.mjs";
import { extractRepairedWorkerJson, extractWorkerJson, normalizePacket } from "../../mcp/lib/packets.mjs";
import {
  assertRuntimeClientPayload,
  assertRuntimeWorkerPayload,
  normalizeMethodVoiceWorkerTransport,
} from "../../mcp/lib/runtime-validation.mjs";

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

const methodVoice = () => ({
  master: "master_druckenmiller",
  acknowledged_stance: "cautious",
  voice_mode: "first_person_public_method_simulation_v1",
  disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
  position_intent: "would_hold",
  voice: {
    would_i_act: "I would hold while the evidence remains bounded.",
    what_i_see: "I see a valid point-in-time record.",
    how_my_method_reads_it: "I read liquidity and price together.",
    where_i_disagree: "I disagree with ignoring the cycle.",
    what_changes_my_mind: "I would change my mind if price and liquidity reversed.",
  },
  key_findings: ["Price confirms the bounded stance."],
  disagreements: ["The cycle still matters."],
  what_would_change_my_mind: ["A dated reversal would change my reading."],
  source_ids: ["market_data:S1"],
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

test("parse-repair arbitration accepts only one distinct schema-valid complete root", () => {
  const packet = evidence();
  const valid = JSON.stringify(packet);
  const diagnostic = JSON.stringify({ repair_note: "transport only" });
  assert.throws(() => extractWorkerJson(`${valid}\n${diagnostic}`, "evidence"), /multiple JSON payloads/u);
  assert.deepEqual(
    extractRepairedWorkerJson(`${valid}\n${diagnostic}`, "evidence"),
    packet,
  );
  assert.deepEqual(
    extractRepairedWorkerJson(`${valid}\n${valid}`, "evidence"),
    packet,
  );

  const nullableCoverage = {
    ...packet,
    coverage_items: [{
      id: "market.quote_snapshot",
      status: "covered",
      source_ids: ["S1"],
      note: null,
      attempted: null,
      attempted_urls: null,
      gap: null,
    }],
  };
  assert.deepEqual(
    extractRepairedWorkerJson(`${diagnostic}\n${JSON.stringify(nullableCoverage)}`, "evidence")
      .coverage_items[0],
    {
      id: "market.quote_snapshot",
      status: "covered",
      source_ids: ["S1"],
      note: "",
      attempted: "",
      attempted_urls: [],
      gap: "",
    },
  );

  const competing = JSON.stringify({ ...packet, summary: "A different valid evidence packet." });
  assert.throws(
    () => extractRepairedWorkerJson(`${valid}\n${competing}`, "evidence"),
    /multiple JSON payloads/u,
  );
  assert.throws(
    () => extractRepairedWorkerJson(`${valid}\n{"summary":`, "evidence"),
    /multiple JSON payloads/u,
  );
  assert.throws(
    () => extractRepairedWorkerJson(`${valid}\n{"repair_note":}`, "evidence"),
    /multiple JSON payloads/u,
  );
  assert.throws(
    () => extractRepairedWorkerJson('{"note":1}\n{"other":2}', "evidence"),
    /multiple JSON payloads/u,
  );
});

test("evidence transport normalizes only nullable optional coverage fields", () => {
  const packet = evidence();
  packet.coverage_items = [{
    id: "market.quote_snapshot",
    status: "covered",
    source_ids: ["S1"],
    note: null,
    attempted: null,
    attempted_urls: null,
    gap: null,
  }];
  const parsed = extractWorkerJson(JSON.stringify(packet), "evidence");
  assert.deepEqual(parsed.coverage_items[0], {
    id: "market.quote_snapshot",
    status: "covered",
    source_ids: ["S1"],
    note: "",
    attempted: "",
    attempted_urls: [],
    gap: "",
  });
});

test("evidence transport losslessly maps acquisition coverage aliases in coverage_items", () => {
  const packet = evidence();
  packet.coverage_items = [{
    coverage_id: "valuation.current_multiples",
    outcome: "reported_actual",
    source_ids: ["S1"],
    note: null,
    attempted: [{
      stage: "regulator_filing",
      locator_type: "url",
      locator: "https://example.com/filing",
      note: "已检查监管申报原文。",
    }],
    attempted_urls: null,
    gap: null,
    reason: "该数值未单独披露。",
  }];
  const parsed = extractWorkerJson(JSON.stringify(packet), "evidence");
  assert.equal(parsed.coverage_items[0].id, "valuation.current_multiples");
  assert.equal(parsed.coverage_items[0].status, "covered");
  assert.deepEqual(parsed.coverage_items[0].source_ids, ["S1"]);
  assert.equal(parsed.coverage_items[0].attempted, "已检查监管申报原文。");
  assert.deepEqual(parsed.coverage_items[0].attempted_urls, ["https://example.com/filing"]);
  assert.equal(parsed.coverage_items[0].gap, "该数值未单独披露。");
});

test("evidence transport removes non-web acquisition locators from attempted URLs", () => {
  const packet = evidence();
  packet.coverage_items = [{
    id: "ownership.insider_transactions",
    status: "covered",
    source_ids: ["S1"],
    note: "Covered by the cited filing.",
    attempted: "Checked the filing and a deterministic local derivation.",
    attempted_urls: [
      "local:VRT:insider_transactions",
      "derive:insider_transactions",
      "https://www.sec.gov/Archives/example.htm",
      "https://www.sec.gov/Archives/example.htm",
    ],
    gap: "",
  }];
  const parsed = extractWorkerJson(JSON.stringify(packet), "evidence");
  assert.deepEqual(parsed.coverage_items[0].attempted_urls, [
    "https://www.sec.gov/Archives/example.htm",
  ]);
});

test("headless structured-output envelopes unwrap before stage validation", () => {
  const packet = evidence();
  const envelope = JSON.stringify({ packet_json: JSON.stringify(packet) });
  assert.deepEqual(extractWorkerJson(envelope, "evidence"), packet);
  assert.deepEqual(
    extractWorkerJson(JSON.stringify({ packet_json: `${JSON.stringify(packet)}\n${JSON.stringify(packet)}` }), "evidence"),
    packet,
  );
  const competing = { ...packet, summary: "A materially different valid packet." };
  assert.throws(
    () => extractWorkerJson(JSON.stringify({ packet_json: `${JSON.stringify(packet)}\n${JSON.stringify(competing)}` }), "evidence"),
    /multiple JSON payloads/u,
  );
});

test("segmented evidence envelopes reconstruct one runtime packet without a monolithic JSON root", () => {
  const packet = evidence();
  const envelope = {
    transport: "segmented_evidence_v1",
    summary: packet.summary,
    claims_json: JSON.stringify(packet.claims),
    metrics_json: JSON.stringify(packet.metrics),
    sources_json: JSON.stringify(packet.sources),
    open_questions_json: JSON.stringify(packet.open_questions),
    coverage_items_json: "null",
    acquisition_ledger_json: "null",
    official_source_coverage_json: "null",
    confidence: packet.confidence,
    information_richness: "unrated",
  };
  assert.deepEqual(extractWorkerJson(JSON.stringify(envelope), "evidence"), {
    ...packet,
    information_richness: "unrated",
  });
  envelope.claims_json = `${JSON.stringify(packet.claims)}${JSON.stringify(packet.claims)}`;
  assert.throws(
    () => extractWorkerJson(JSON.stringify(envelope), "evidence"),
    /multiple JSON payloads/u,
  );
});

test("supplemental analyst transport drops company-route fields it does not own", () => {
  const packet = evidence();
  packet.coverage_items = [{ id: "invented", status: "unknown", source_ids: [] }];
  packet.acquisition_ledger = { invented: true };
  const parsed = extractWorkerJson(JSON.stringify(packet), "evidence", { task: "macro_regime" });
  assert.equal(Object.hasOwn(parsed, "coverage_items"), false);
  assert.equal(Object.hasOwn(parsed, "acquisition_ledger"), false);
  assert.equal(parsed.claims.length, 1);
  assert.throws(() => extractWorkerJson(JSON.stringify(packet), "evidence", { task: "market_data" }));
});

test("an explicit unsourced gap is downgraded to an open question, never accepted as evidence", () => {
  const packet = evidence();
  packet.claims.push({
    claim: "截至日的 200 日均线不可得。",
    evidence: "已检索官方市场页和发行人网站，但未取得该数值。",
    confidence: "low",
    source_ids: [],
  });
  const parsed = extractWorkerJson(JSON.stringify(packet), "evidence");
  assert.equal(parsed.claims.length, 1);
  assert.ok(parsed.open_questions.some((question) => question.includes("200 日均线不可得")));

  const positive = evidence();
  positive.claims[0].source_ids = [];
  assert.throws(
    () => extractWorkerJson(JSON.stringify(positive), "evidence"),
    (error) => error?.data?.reason === "WORKER_OUTPUT_SCHEMA_MISMATCH",
  );
});

test("unavailable coverage gaps are mirrored exactly into open questions", () => {
  const packet = evidence();
  const gap = "The exact 200-day moving average was not obtainable from the checked surfaces.";
  packet.coverage_items = [{
    id: "market.technical_levels",
    status: "unavailable",
    source_ids: [],
    note: "",
    attempted: "Checked the exchange and issuer surfaces.",
    attempted_urls: ["https://example.com/checked"],
    gap,
  }];
  const parsed = extractWorkerJson(JSON.stringify(packet), "evidence");
  assert.ok(parsed.open_questions.includes(gap));
});

test("covered live root surfaces inherit their supplied retrieval time as an observation", () => {
  const packet = evidence();
  packet.sources.push({
    id: "S2",
    title: "Issuer official website",
    url: "https://issuer.example/",
    published_at: "unknown",
    retrieved_at: "2026-08-05T12:00:00Z",
  });
  packet.coverage_items = [{
    id: "market.identity_listing_currency",
    status: "covered",
    source_ids: ["S2"],
    note: "Observed on the current issuer surface.",
  }];
  const parsed = extractWorkerJson(JSON.stringify(packet), "evidence");
  assert.equal(parsed.sources[1].source_kind, "dynamic_snapshot");
  assert.equal(parsed.sources[1].observed_at, "2026-08-05T12:00:00Z");

  packet.sources[1].url = "https://issuer.example/articles/undated-story";
  const article = extractWorkerJson(JSON.stringify(packet), "evidence");
  assert.equal(article.sources[1].source_kind, undefined);
});

test("a same-day UTC observation corrects only a one-day local-calendar spill", () => {
  const packet = evidence();
  packet.sources[0] = {
    id: "S1",
    title: "Live issuer overview",
    url: "https://issuer.example/overview/",
    published_at: "unknown",
    retrieved_at: "2026-08-06",
    source_kind: "dynamic_snapshot",
    observed_at: "2026-08-06",
  };
  const corrected = normalizePacket(packet, "market_data", "ACME", "2026-08-05", "", {
    observationTime: "2026-08-05T17:55:42.548Z",
  });
  assert.equal(corrected.sources[0].observed_at, "2026-08-05T17:55:42.548Z");
  assert.equal(corrected.sources[0].retrieved_at, "2026-08-05T17:55:42.548Z");

  const historical = normalizePacket(packet, "market_data", "ACME", "2026-08-05", "", {
    observationTime: "2026-08-06T01:00:00Z",
  });
  assert.equal(historical.sources[0].observed_at, "2026-08-06");

  packet.sources[0].observed_at = "2099-01-01";
  const farFuture = normalizePacket(packet, "market_data", "ACME", "2026-08-05", "", {
    observationTime: "2026-08-05T17:55:42.548Z",
  });
  assert.equal(farFuture.sources[0].observed_at, "2099-01-01");
});

test("candidate enumeration preserves complete roots but never chooses one", () => {
  assert.deepEqual(
    parseJsonTransportCandidates('{"a":1}\ntransport note\n{"b":2,}'),
    [{ a: 1 }, { b: 2 }],
  );
  assert.throws(
    () => parseJsonTransportCandidates('{"a":1}\n{"b":'),
    (error) => error?.data?.reason === "WORKER_JSON_INCOMPLETE_ADDITIONAL_VALUE",
  );
  assert.throws(
    () => parseJsonTransportCandidates('{"a":1}\n{"b":}'),
    (error) => error?.data?.reason === "WORKER_JSON_MALFORMED_ADDITIONAL_VALUE",
  );
  assert.throws(
    () => parseJsonTransportCandidates(Array.from({ length: 33 }, () => "{}").join("\n")),
    (error) => error?.data?.reason === "WORKER_JSON_CANDIDATE_LIMIT",
  );
});

test("standalone runtime schemas accept complete packets and expose missing content", () => {
  const complete = evidence();
  assert.equal(assertRuntimeWorkerPayload("evidence", complete), complete);

  // Acquisition identity and semantic rows are bound to the frozen run after transport
  // parsing. A worker typo here must reach the server canonicalizer instead of forcing a
  // lossy rewrite of the entire otherwise-valid evidence packet.
  const workerBoundMetadata = evidence();
  workerBoundMetadata.acquisition_ledger = {
    policy_id: "worker_typo",
    task: "wrong_task",
    items: [{ coverage_id: "financials.business_model", outcome: "reported_actual" }],
  };
  assert.equal(assertRuntimeWorkerPayload("evidence", workerBoundMetadata), workerBoundMetadata);

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

test("runtime source IDs accept long SEC lineage but reject whitespace, controls, and overlong IDs", () => {
  const longestObservedSecFixture = "sec:companyfacts:0001234567:AssetsCurrent:0001234567-24-000001:2024-12-31";
  const valid = evidence();
  valid.claims[0].source_ids = [longestObservedSecFixture];
  valid.sources[0].id = longestObservedSecFixture;
  assert.equal(assertRuntimeWorkerPayload("evidence", valid), valid);

  for (const invalidSourceId of [
    "market_data:HAS SPACE",
    "market_data:HAS\nCONTROL",
    `sec:${"a".repeat(509)}`,
  ]) {
    const invalid = evidence();
    invalid.claims[0].source_ids = [invalidSourceId];
    invalid.sources[0].id = invalidSourceId;
    assert.throws(
      () => assertRuntimeWorkerPayload("evidence", invalid),
      (error) => error?.data?.reason === "WORKER_OUTPUT_SCHEMA_MISMATCH",
    );
  }
});

test("headless method voice preserves strings and canonically serializes structured prose only", () => {
  const valid = methodVoice();
  assert.equal(assertRuntimeWorkerPayload("method_voice", valid), valid);

  const structured = methodVoice();
  structured.key_findings = [
    "Original string remains unchanged.",
    { text: "Price confirms.", nested: { z: 2, a: 1 }, source_ids: ["market_data:S1"] },
  ];
  structured.disagreements = [{ text: "Cycle risk remains.", rank: 1 }];
  structured.what_would_change_my_mind = [{ threshold: 0.5, signal: "liquidity_reversal" }];
  const normalized = assertRuntimeWorkerPayload("method_voice", structured);
  assert.notEqual(normalized, structured);
  assert.deepEqual(normalized.key_findings, [
    "Original string remains unchanged.",
    '{"nested":{"a":1,"z":2},"source_ids":["market_data:S1"],"text":"Price confirms."}',
  ]);
  assert.deepEqual(normalized.disagreements, ['{"rank":1,"text":"Cycle risk remains."}']);
  assert.deepEqual(normalized.what_would_change_my_mind, [
    '{"signal":"liquidity_reversal","threshold":0.5}',
  ]);
  assert.deepEqual(structured.key_findings, [
    "Original string remains unchanged.",
    { text: "Price confirms.", nested: { z: 2, a: 1 }, source_ids: ["market_data:S1"] },
  ]);

  const reordered = methodVoice();
  reordered.key_findings = [{ source_ids: ["market_data:S1"], nested: { a: 1, z: 2 }, text: "Price confirms." }];
  assert.equal(
    assertRuntimeWorkerPayload("method_voice", reordered).key_findings[0],
    normalized.key_findings[1],
  );

  assert.throws(
    () => assertRuntimeClientPayload("method_voice", structured),
    (error) => error?.data?.reason === "VISIBLE_INPUT_SCHEMA_MISMATCH",
  );
});

test("method voice packet dispositions do not require workers to transcribe server-owned hashes", () => {
  const unbound = methodVoice();
  unbound.evidence_packet_acks = [{
    task: "market_data",
    status: "used",
    source_ids: ["market_data:S1"],
    note: "I used the market packet.",
  }];
  assert.equal(assertRuntimeWorkerPayload("method_voice", unbound), unbound);
});

test("native structured method voice transport unwraps without a nested packet_json string", () => {
  const native = {
    transport: "segmented_method_voice_v1",
    ...methodVoice(),
    company_dossier_hash_ack: null,
    evidence_packet_acks: {
      market_data: {
        status: "used",
        source_ids: ["market_data:S1"],
        note: "I used the market packet.",
      },
    },
  };
  const parsed = extractWorkerJson(JSON.stringify(native), "method_voice");
  assert.equal(Object.hasOwn(parsed, "transport"), false);
  assert.equal(Object.hasOwn(parsed, "company_dossier_hash_ack"), false);
  assert.deepEqual(parsed.evidence_packet_acks, [{
    task: "market_data",
    status: "used",
    source_ids: ["market_data:S1"],
    note: "I used the market packet.",
  }]);
  assert.ok(parsed.source_ids.includes("market_data:S1"));
  assert.equal(parsed.master, native.master);
  assert.deepEqual(parsed.voice, native.voice);
});

test("method voice transport does not coerce provenance or invalid prose primitives", () => {
  const badSource = methodVoice();
  badSource.source_ids = [{ id: "market_data:S1" }];
  assert.throws(
    () => assertRuntimeWorkerPayload("method_voice", badSource),
    (error) => error?.data?.reason === "WORKER_OUTPUT_SCHEMA_MISMATCH",
  );

  for (const invalidItem of [null, undefined, 42, true, ["nested array"]]) {
    const invalid = methodVoice();
    invalid.key_findings = [invalidItem];
    assert.throws(
      () => assertRuntimeWorkerPayload("method_voice", invalid),
      (error) => error?.data?.reason === "WORKER_OUTPUT_SCHEMA_MISMATCH",
    );
  }
});

test("method voice transport fails closed on non-canonical structured prose", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const invalid = methodVoice();
  invalid.disagreements = [cyclic];
  assert.throws(
    () => normalizeMethodVoiceWorkerTransport(invalid),
    (error) => error?.data?.reason === "WORKER_OUTPUT_TRANSPORT_MISMATCH"
      && error.data.path === "/disagreements/0",
  );

  const undefinedValue = methodVoice();
  undefinedValue.key_findings = [{ text: undefined }];
  assert.throws(
    () => normalizeMethodVoiceWorkerTransport(undefinedValue),
    (error) => error?.data?.reason === "WORKER_OUTPUT_TRANSPORT_MISMATCH",
  );

  const prototypeKey = methodVoice();
  prototypeKey.key_findings = [JSON.parse('{"__proto__":{"polluted":true},"text":"kept"}')];
  assert.equal(
    normalizeMethodVoiceWorkerTransport(prototypeKey).key_findings[0],
    '{"__proto__":{"polluted":true},"text":"kept"}',
  );
  assert.equal({}.polluted, undefined);
});
