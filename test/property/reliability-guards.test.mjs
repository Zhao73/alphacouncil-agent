import { test } from "node:test";
import assert from "node:assert/strict";

import fc from "fast-check";
import { jsonrepair } from "jsonrepair";

import { parseJsonTransport } from "../../mcp/lib/bounded-json.mjs";
import { parseMasterSelection } from "../../mcp/lib/council-selection.mjs";
import { userResponseMarkdown } from "../../mcp/lib/markdown.mjs";
import { normalizeMasterVoice } from "../../mcp/lib/packets.mjs";

const RUNS = 160;

test("property: exact JSON values are never changed", () => {
  fc.assert(fc.property(fc.jsonValue(), (payload) => {
    const envelope = { payload };
    const serialized = JSON.stringify(envelope);
    const parsed = parseJsonTransport(serialized);
    assert.equal(parsed.strategy, "exact");
    assert.deepEqual(parsed.value, JSON.parse(serialized));
  }), { numRuns: RUNS });
});

test("property: the local safe subset agrees with jsonrepair on root trailing commas", () => {
  const referenceSafePayload = fc.oneof(
    fc.boolean(),
    fc.integer(),
    fc.string({ maxLength: 80 }).filter((value) => !/[{}\[\]"\\]/u.test(value)),
    fc.array(fc.integer(), { maxLength: 12 }),
  );
  fc.assert(fc.property(referenceSafePayload, (payload) => {
    const malformed = `// transport-only comment\n{"payload":${JSON.stringify(payload)},}`;
    const local = parseJsonTransport(malformed).value;
    const reference = JSON.parse(jsonrepair(malformed));
    assert.deepEqual(local, reference);
  }), { numRuns: RUNS });
});

test("property: compact selection text returns a unique catalog-ordered subset", () => {
  // Non-canonical pressure fixture: intentionally one larger than the current roster.
  const masters = Array.from({ length: 27 }, (_, index) => ({
    id: `master_property_${index + 1}`,
    title: `Property ${index + 1} Lens`,
    identity: `Property ${index + 1}`,
  }));
  const indexes = fc.uniqueArray(fc.integer({ min: 1, max: masters.length }), {
    minLength: 1,
    maxLength: masters.length,
  });
  fc.assert(fc.property(indexes, fc.constantFrom(",", "，", " ", ";"), (picked, separator) => {
    const result = parseMasterSelection(picked.join(separator), masters);
    const expectedSet = new Set(picked);
    assert.deepEqual(
      result.ids,
      masters.filter((_, index) => expectedSet.has(index + 1)).map((master) => master.id),
    );
    assert.equal(new Set(result.ids).size, result.ids.length);
  }), { numRuns: RUNS });
});

test("property: every selected method statement remains in the final handoff tail", () => {
  const statements = fc.array(
    fc.string({ minLength: 1, maxLength: 180 }).filter((value) => /\S/u.test(value)),
    { minLength: 1, maxLength: 8 },
  );
  fc.assert(fc.property(statements, (values) => {
    const ids = values.map((_, index) => `master_property_${index + 1}`);
    const run = {
      run_id: "PROPERTY-TAIL",
      symbol: "TEST",
      as_of: "2026-08-03",
      language: "English",
      council_mode: "full",
      status: "complete",
      tasks: [],
      packets: [{
        task: "property_fixture",
        summary: "A bounded property-test source anchors every generated method statement.",
        claims: [{
          claim: "The property fixture supplies the frozen evidence used by every generated seat.",
          evidence: "The source manifest contains property_fixture:S1.",
          confidence: "low",
          source_ids: ["property_fixture:S1"],
        }],
        metrics: {},
        sources: [{
          id: "property_fixture:S1",
          title: "Property fixture source",
          url: "https://example.com/property-fixture",
          published_at: "2026-08-03",
          retrieved_at: "2026-08-03",
        }],
        open_questions: [],
        confidence: "low",
      }],
      masters: ids,
      master_status: Object.fromEntries(ids.map((id) => [id, { master: id, status: "completed" }])),
      master_opinions: ids.map((id, index) => {
        const voice = normalizeMasterVoice({
          master: id,
          acknowledged_stance: "cautious",
          voice_mode: "first_person_public_method_simulation_v1",
          disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
          position_intent: "would_hold",
          voice: {
            would_i_act: `I would hold while I inspect ${values[index]}`,
            what_i_see: `I see ${values[index]}`,
            how_my_method_reads_it: `I apply my standard to ${values[index]}`,
            where_i_disagree: `I disagree with unsupported changes to ${values[index]}`,
            what_changes_my_mind: `I would change my mind if the frozen evidence changes from ${values[index]}`,
          },
          key_findings: [],
          disagreements: [],
          what_would_change_my_mind: [],
          source_ids: ["property_fixture:S1"],
          confidence: "low",
        }, id, {
          symbol: "TEST",
          as_of: "2026-08-03",
          language: "English",
          packets: [{ task: "property_fixture", sources: [{ id: "property_fixture:S1" }] }],
        }, {
          stance: "cautious", confidence: "low",
        });
        return {
          master: id,
          stance: "cautious",
          confidence: "low",
          voice_statement: voice.statement,
          dedicated_worker: { status: "completed" },
        };
      }),
    };
    const markdown = userResponseMarkdown(run, {
      decision_available: true,
      rating: "Hold",
      winner: "balanced",
      confidence: "low",
      verdict: "Property fixture verdict.",
      valuation_range: "Unavailable in property fixture.",
      position: "Watch only.",
      invalidation: [],
    });
    assert.ok(markdown.trimEnd().endsWith("<!-- alphacouncil:handoff-method-seat-tail:v1:end -->"));
    const tail = markdown.slice(markdown.indexOf("alphacouncil:handoff-method-seat-tail:v1:begin"));
    for (const id of ids) assert.equal(tail.split(`(\`${id}\`)`).length - 1, 1);
    for (const opinion of run.master_opinions) assert.ok(tail.includes(opinion.voice_statement));
  }), { numRuns: 80 });
});
