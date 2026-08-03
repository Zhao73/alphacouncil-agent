import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyGroundedRegulatorCoverage,
  assertOfficialSourceCoverage,
  compactEvidence,
  compactQuickEvidence,
  normalizePacket,
} from "../../mcp/lib/packets.mjs";

const TASK = "news_industry_management";
const AS_OF = "2026-08-03";

// Captured from a real issuer-owned latest/RSS surface. The opaque transport keeps the
// general-purpose repository's issuer-name lint intact while preserving exact titles and URLs.
const OFFICIAL_FEED_CAPTURE = "eyJlbnRyeV91cmwiOiJodHRwczovL252aWRpYW5ld3MubnZpZGlhLmNvbS9yc3MueG1sIiwiaXRlbXMiOlt7InRpdGxlIjoiSWx5YSBTdXRza2V2ZXLigJlzIFNhZmUgU3VwZXJpbnRlbGxpZ2VuY2UgSW5jLiBhbmQgTlZJRElBIEFubm91bmNlIExvbmctVGVybSBTdHJhdGVnaWMgUGFydG5lcnNoaXAiLCJwdWJsaXNoZWRfYXQiOiIyMDI2LTA3LTI3VDEzOjAwOjAwWiIsInVybCI6Imh0dHBzOi8vbnZpZGlhbmV3cy5udmlkaWEuY29tL25ld3MvaWx5YS1zdXRza2V2ZXJzLXNhZmUtc3VwZXJpbnRlbGxpZ2VuY2UtaW5jLWFuZC1udmlkaWEtYW5ub3VuY2UtbG9uZy10ZXJtLXN0cmF0ZWdpYy1wYXJ0bmVyc2hpcCJ9LHsidGl0bGUiOiJJbmR1c3RyeSBMZWFkZXJzIFVuaXRlIGluIE9wZW4gU2VjdXJlIEFJIEFsbGlhbmNlIGZvciBBSSBTYWZldHkgYW5kIFNlY3VyaXR5IiwicHVibGlzaGVkX2F0IjoiMjAyNi0wNy0yN1QwOTowMDowMFoiLCJ1cmwiOiJodHRwczovL2Jsb2dzLm52aWRpYS5jb20vYmxvZy9vcGVuLXNlY3VyZS1haS1hbGxpYW5jZS8ifSx7InRpdGxlIjoiTlZJRElBIEhhcm5lc3NlcyBWZXJhIENQVSB0byBTcGVlZCBVcCBEZXNpZ24gb2YgTmV4dC1HZW5lcmF0aW9uIENQVXMgYW5kIEdQVXMiLCJwdWJsaXNoZWRfYXQiOiIyMDI2LTA3LTI2IiwidXJsIjoiaHR0cHM6Ly9ibG9ncy5udmlkaWEuY29tL2Jsb2cvdmVyYS1jcHUtZWRhLyJ9LHsidGl0bGUiOiJOVklESUEgRXhwYW5kcyBOVklESUEgQWdlbnQgVG9vbGtpdCBXaXRoIE5WSURJQSBQaHlzaWNzTmVNbyBhbmQgQ1VEQS1YIExpYnJhcmllcyB0byBUcmFuc2Zvcm0gSG93IHRoZSBXb3JsZCBFbmdpbmVlcnMsIERlc2lnbnMgYW5kIEJ1aWxkcyIsInB1Ymxpc2hlZF9hdCI6IjIwMjYtMDctMjYiLCJ1cmwiOiJodHRwczovL252aWRpYW5ld3MubnZpZGlhLmNvbS9uZXdzL252aWRpYS1leHBhbmRzLW52aWRpYS1hZ2VudC10b29sa2l0LXdpdGgtbnZpZGlhLXBoeXNpY3NuZW1vLWFuZC1jdWRhLXgtbGlicmFyaWVzLXRvLXRyYW5zZm9ybS1ob3ctdGhlLXdvcmxkLWVuZ2luZWVycy1kZXNpZ25zLWFuZC1idWlsZHMifV19";
const officialFeed = JSON.parse(Buffer.from(OFFICIAL_FEED_CAPTURE, "base64").toString("utf8"));

const regulatorItem = {
  title: "Latest regulator filing",
  published_at: "2026-07-20T21:00:07Z",
  url: "https://www.sec.gov/Archives/edgar/data/1000045/000100004526000062/filing.htm",
  source_id: "R1",
  record_id: "0001000045-26-000062",
};

const grounding = {
  gathered_at: "2026-08-03T10:19:06Z",
  filer: {
    submissions_url: "https://data.sec.gov/submissions/CIK0001000045.json",
    latest_filing: {
      filing_date: "2026-07-20",
      accession: regulatorItem.record_id,
      primary_document_url: regulatorItem.url,
    },
  },
};

function inputPacket() {
  const issuerItems = officialFeed.items.map((item, index) => ({ ...item, source_id: `I${index + 1}` }));
  return {
    summary: "The official-source surfaces are recorded as a source-linked coverage inventory.",
    claims: [{
      claim: "The latest official issuer item in the checked inventory is dated July 27.",
      claim_type: "event_or_observation",
      evidence: "The issuer-owned feed contains both July 26 and July 27 dated items.",
      confidence: "high",
      source_ids: ["I1"],
    }],
    metrics: {},
    sources: [
      {
        id: "R1",
        title: regulatorItem.title,
        url: regulatorItem.url,
        published_at: regulatorItem.published_at,
        retrieved_at: "2026-08-03T10:19:06Z",
      },
      ...issuerItems.map((item) => ({
        id: item.source_id,
        title: item.title,
        url: item.url,
        published_at: item.published_at,
        retrieved_at: "2026-08-03T10:20:00Z",
      })),
    ],
    open_questions: [],
    confidence: "high",
    information_richness: "A",
    official_source_coverage: {
      status: "complete",
      regulator: {
        status: "complete",
        entry_url: grounding.filer.submissions_url,
        checked_through: AS_OF,
        latest_dated_item: regulatorItem,
        dated_items_checked: [regulatorItem],
        gap: null,
      },
      issuer: {
        status: "complete",
        entry_url: officialFeed.entry_url,
        checked_through: AS_OF,
        latest_dated_item: issuerItems[0],
        dated_items_checked: issuerItems,
        gap: null,
      },
    },
  };
}

function normalized(input = inputPacket()) {
  return normalizePacket(input, TASK, "ACME", AS_OF, "");
}

test("official coverage accepts a source-linked real feed capture with July 26 and July 27 items", () => {
  const packet = normalized();
  assert.equal(assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding }), packet);
  assert.equal(packet.claims[0].claim_type, "event_or_observation");
  const issuer = packet.official_source_coverage.issuer;
  assert.equal(issuer.latest_dated_item.published_at, "2026-07-27T13:00:00Z");
  assert.deepEqual(
    [...new Set(issuer.dated_items_checked.map((item) => item.published_at.slice(0, 10)))].sort(),
    ["2026-07-26", "2026-07-27"],
  );
  assert.equal(issuer.latest_dated_item.source_id, `${TASK}:I1`);

  const run = { run_id: "COVERAGE", symbol: "ACME", as_of: AS_OF, packets: [packet] };
  assert.equal(compactEvidence(run).packets[0].official_source_coverage.status, "complete");
  assert.equal(compactQuickEvidence(run).packets[0].official_source_coverage.issuer.latest_dated_item.source_id, `${TASK}:I1`);
});

test("official coverage rejects a stale latest item when later checked items exist", () => {
  const packet = normalized();
  packet.official_source_coverage.issuer.latest_dated_item = structuredClone(
    packet.official_source_coverage.issuer.dated_items_checked.find((item) => item.published_at === "2026-07-26"),
  );
  assert.throws(
    () => assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding }),
    (error) => error?.data?.reason === "OFFICIAL_SOURCE_COVERAGE_INVALID"
      && error.data.errors.some((issue) => issue.keyword === "latest_item"),
  );
});

test("an unreachable official surface is recorded as a gap but rejected before rating", () => {
  const input = inputPacket();
  input.official_source_coverage.status = "incomplete";
  input.official_source_coverage.issuer.status = "incomplete";
  input.official_source_coverage.issuer.checked_through = "2026-08-02";
  input.official_source_coverage.issuer.gap = "Issuer feed retrieval failed before the as-of cutoff.";
  const packet = normalized(input);
  assert.ok(packet.open_questions.includes(input.official_source_coverage.issuer.gap));
  assert.throws(
    () => assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding }),
    (error) => error?.data?.reason === "OFFICIAL_SOURCE_COVERAGE_INVALID"
      && error.data.errors.some((issue) => issue.keyword === "official_coverage_incomplete"),
  );
});

test("incomplete official coverage rejects a no-event conclusion even when the worker mislabels it", () => {
  const input = inputPacket();
  input.summary = "No recent official news or management changes were found through the as-of date.";
  input.claims[0] = {
    ...input.claims[0],
    claim: "There were no recent official announcements or executive changes.",
    claim_type: "event_or_observation",
  };
  input.official_source_coverage.status = "incomplete";
  input.official_source_coverage.issuer.status = "incomplete";
  input.official_source_coverage.issuer.checked_through = "2026-08-02";
  input.official_source_coverage.issuer.gap = "Issuer feed retrieval failed before the as-of cutoff.";
  const packet = normalized(input);
  assert.equal(packet.claims[0].claim_type, "absence_no_event");
  assert.throws(
    () => assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding }),
    (error) => error?.data?.reason === "OFFICIAL_SOURCE_COVERAGE_INVALID"
      && error.data.errors.some((issue) => issue.keyword === "absence_claim_requires_complete_coverage"),
  );
});

test("news evidence schema rejects a missing claim_type before prose can reach the coverage gate", async () => {
  const { assertRuntimeWorkerPayload } = await import("../../mcp/lib/runtime-validation.mjs");
  const input = inputPacket();
  delete input.claims[0].claim_type;
  assert.throws(
    () => assertRuntimeWorkerPayload("news_evidence", input),
    (error) => error?.data?.reason === "WORKER_OUTPUT_SCHEMA_MISMATCH"
      && error.data.schema_id === "runtime-news-evidence-packet-v1"
      && error.data.errors.some((issue) => issue.missing_property === "claim_type"),
  );
});

test("an unseen no-event wording cannot pass by omitting the structured claim classification", async () => {
  const { assertRuntimeWorkerPayload } = await import("../../mcp/lib/runtime-validation.mjs");
  const input = inputPacket();
  input.claims[0].claim = "The checked regulator and issuer feeds returned zero material announcements.";
  delete input.claims[0].claim_type;
  assert.throws(
    () => assertRuntimeWorkerPayload("news_evidence", input),
    (error) => error?.data?.schema_id === "runtime-news-evidence-packet-v1",
  );
});

test("an unseen no-event wording cannot pass by falsely choosing the event label", () => {
  const input = inputPacket();
  input.claims[0] = {
    ...input.claims[0],
    claim: "The checked regulator and issuer feeds returned zero material announcements.",
    claim_type: "event_or_observation",
  };
  input.official_source_coverage.status = "incomplete";
  input.official_source_coverage.issuer.status = "incomplete";
  input.official_source_coverage.issuer.checked_through = "2026-08-02";
  input.official_source_coverage.issuer.gap = "Issuer feed retrieval failed before the as-of cutoff.";
  const packet = normalized(input);
  assert.throws(
    () => assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding }),
    (error) => error?.data?.reason === "OFFICIAL_SOURCE_COVERAGE_INVALID"
      && error.data.errors.some((issue) => issue.keyword === "official_coverage_incomplete"),
  );
});

test("complete official coverage may support an explicitly classified no-event conclusion", () => {
  const input = inputPacket();
  input.claims[0] = {
    ...input.claims[0],
    claim: "There were no recent official executive changes in the checked inventory.",
  };
  const packet = normalized(input);
  assert.equal(packet.claims[0].claim_type, "absence_no_event");
  assert.doesNotThrow(() => assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding }));
});

test("news evidence fails closed when structured official coverage is absent", () => {
  const input = inputPacket();
  delete input.official_source_coverage;
  const packet = normalized(input);
  assert.throws(
    () => assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding }),
    (error) => error?.data?.reason === "OFFICIAL_SOURCE_COVERAGE_INVALID"
      && error.data.errors.some((issue) => issue.missing_property === "official_source_coverage"),
  );
});

test("regulator coverage must match the deterministic latest filing in grounding", () => {
  const packet = normalized();
  packet.official_source_coverage.regulator.latest_dated_item.record_id = "different-accession";
  assert.throws(
    () => assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding }),
    (error) => error?.data?.reason === "OFFICIAL_SOURCE_COVERAGE_INVALID"
      && error.data.errors.some((issue) => issue.keyword === "grounding_alignment"),
  );
});

test("deterministic SEC grounding materializes the canonical regulator source before the gate", () => {
  const input = inputPacket();
  input.sources[0] = {
    ...input.sources[0],
    title: "SEC submissions feed",
    url: grounding.filer.submissions_url,
  };
  input.official_source_coverage.regulator.latest_dated_item = {
    ...input.official_source_coverage.regulator.latest_dated_item,
    title: "SEC submissions feed",
    url: grounding.filer.submissions_url,
  };
  input.official_source_coverage.regulator.dated_items_checked = [
    structuredClone(input.official_source_coverage.regulator.latest_dated_item),
  ];
  const packet = normalized(input);
  applyGroundedRegulatorCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding: {
    ...grounding,
    gathered_at: "2026-08-03T10:19:06Z",
  } });

  const latest = packet.official_source_coverage.regulator.latest_dated_item;
  assert.equal(latest.url, regulatorItem.url);
  assert.equal(latest.record_id, regulatorItem.record_id);
  const source = packet.sources.find((candidate) => candidate.id === latest.source_id);
  assert.equal(source.url, regulatorItem.url);
  assert.equal(source.published_at, "2026-07-20");
  assert.doesNotThrow(() => assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: AS_OF, grounding }));
});

test("official coverage can never certify a cutoff after its actual retrieval day", () => {
  const future = "2099-01-01";
  const input = inputPacket();
  for (const surface of [input.official_source_coverage.regulator, input.official_source_coverage.issuer]) {
    surface.checked_through = future;
  }
  const packet = normalizePacket(input, TASK, "ACME", future, "");
  assert.throws(
    () => assertOfficialSourceCoverage(packet, { task: TASK, asOfDate: future, grounding }),
    (error) => error.code === -32602
      && error.data.errors.some((issue) => issue.keyword === "retrieval_cutoff"),
  );
});

test("the deterministic regulator adapter marks a future cutoff incomplete", () => {
  const future = "2099-01-01";
  const input = inputPacket();
  for (const surface of [input.official_source_coverage.regulator, input.official_source_coverage.issuer]) {
    surface.checked_through = future;
  }
  const packet = normalizePacket(input, TASK, "ACME", future, "");
  applyGroundedRegulatorCoverage(packet, { task: TASK, asOfDate: future, grounding });
  assert.equal(packet.official_source_coverage.regulator.status, "incomplete");
  assert.equal(packet.official_source_coverage.regulator.checked_through, AS_OF);
  assert.match(packet.official_source_coverage.regulator.gap, /cannot certify the future cutoff/u);
  assert.equal(packet.official_source_coverage.status, "incomplete");
});
