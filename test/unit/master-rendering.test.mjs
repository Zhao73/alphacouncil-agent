import { test } from "node:test";
import assert from "node:assert/strict";

import { masterCorrelationNote, renderMasterMarkdown } from "../../mcp/lib/markdown.mjs";
import { validateFinalReport } from "../../mcp/lib/gates.mjs";
import { REPORT_SECTIONS } from "../../mcp/lib/constants.mjs";
import { recordAck } from "../../mcp/lib/rpc.mjs";

const opinion = (over = {}) => ({
  master: "master_buffett",
  symbol: "NOK",
  as_of: "2026-07-26",
  stance: "avoid",
  verdict: "outside the circle of competence",
  summary: "Ten-year quality metrics are uncomputable for this filer.",
  key_findings: ["0/7 mechanical rules computable", "GAAP net income near zero"],
  disagreements: ["sell-side treats backlog as revenue"],
  disqualifiers_triggered: ["no durable advantage identifiable ten years out"],
  what_would_change_my_mind: ["four quarters of GAAP and comparable converging"],
  source_ids: ["earnings_deep_dive:S1"],
  confidence: "medium",
  ...over,
});

test("a master's own words reach the markdown, not just the JSON", () => {
  const md = renderMasterMarkdown(opinion(), "en");
  // The defect this guards: opinions were recorded, gated and weighted, then rendered
  // nowhere, so a reader could not see what any lens actually said.
  assert.match(md, /Ten-year quality metrics are uncomputable/);
  assert.match(md, /0\/7 mechanical rules computable/);
  assert.match(md, /sell-side treats backlog as revenue/);
  assert.match(md, /no durable advantage identifiable/);
  assert.match(md, /four quarters of GAAP and comparable converging/);
  assert.match(md, /earnings_deep_dive:S1/);
});

test("the registry title is used so a reader sees a name, not only an id", () => {
  const md = renderMasterMarkdown(opinion(), "en");
  assert.match(md, /master_buffett/);
  assert.match(md, /Buffett/i);
});

test("an out_of_scope seat is rendered rather than dropped", () => {
  // A method declining to judge is a conclusion. Hiding it is how a bench looks unanimous.
  const md = renderMasterMarkdown(opinion({
    stance: "out_of_scope",
    verdict: "this method cannot evaluate a filer without structured financials",
  }), "en");
  assert.match(md, /out_of_scope/);
  assert.match(md, /cannot evaluate a filer without structured financials/);
});

test("rendering an absent opinion yields nothing rather than throwing", () => {
  assert.equal(renderMasterMarkdown(null, "en"), "");
  assert.equal(renderMasterMarkdown(undefined, "zh-CN"), "");
});

test("the correlation note refuses to present the bench as a vote count", () => {
  const run = {
    language: "en",
    master_opinions: [opinion(), opinion({ master: "master_munger" }), opinion({ master: "master_taleb", stance: "long" })],
  };
  const note = masterCorrelationNote(run);
  assert.match(note, /not independent samples/i);
  assert.match(note, /is not a vote count/i);
  // The spread is shown so the reader can see it, and immediately told not to add it up.
  assert.match(note, /avoid=2/);
  assert.match(note, /long=1/);
});

test("the correlation note follows the report language", () => {
  const run = { language: "zh-CN", master_opinions: [opinion()] };
  const note = masterCorrelationNote(run);
  assert.match(note, /不是独立样本/);
  assert.match(note, /不能当作票数来计算/);
});

test("no bench means no note", () => {
  assert.equal(masterCorrelationNote({ language: "en", master_opinions: [] }), "");
  assert.equal(masterCorrelationNote({}), "");
});

/** A report body that satisfies every section except the one under test. */
function reportWithout(skipId) {
  const filler = "x".repeat(120);
  return REPORT_SECTIONS
    .filter((s) => s.id !== skipId)
    .map((s) => `## ${s.id}\n\n${filler}\n`)
    .join("\n");
}

test("a run that spent ten master seats cannot publish a report that omits them", () => {
  const run = { masters: ["master_buffett"], master_opinions: [opinion()], tasks: [] };
  const quality = validateFinalReport(reportWithout("master_bench"), run);
  assert.equal(quality.status, "needs_revision");
  assert.ok(quality.missing.some((m) => m.includes("master_bench")), quality.missing.join("; "));
});

test("a run with no bench is not failed for omitting a bench section", () => {
  // screen/quick modes select no masters; requiring the section there would be a false alarm.
  const run = { masters: [], master_opinions: [], tasks: [] };
  const quality = validateFinalReport(reportWithout("master_bench"), run);
  assert.ok(!quality.missing.some((m) => m.includes("master_bench")), quality.missing.join("; "));
  assert.ok(!quality.required_sections.includes("master_bench"));
});

test("a record ack reports progress without echoing the whole run", () => {
  // The regression: these handlers echoed the entire run on every call, so the payload grew
  // with each recording and a late call in a 21-seat run passed 240k characters.
  const run = {
    run_id: "NOK-1", symbol: "NOK", status: "running", phase: "visible_evidence",
    tasks: ["market_data", "quant_factor"],
    packets: [{ task: "market_data", raw_text: "y".repeat(50_000), claims: [], sources: [] }],
    masters: ["master_buffett", "master_munger"],
    master_opinions: [opinion()],
    grounding: { blob: "z".repeat(50_000) },
  };
  const ack = recordAck(run);
  const size = JSON.stringify(ack).length;
  assert.ok(size < 2000, `ack should stay small, was ${size} chars`);
  assert.ok(!JSON.stringify(ack).includes("y".repeat(100)), "packet bodies must not ride along");
  assert.ok(!JSON.stringify(ack).includes("z".repeat(100)), "grounding must not ride along");
  // It must still say what landed and what is outstanding.
  assert.deepEqual(ack.recorded_tasks, ["market_data"]);
  assert.deepEqual(ack.pending_tasks, ["quant_factor"]);
  assert.deepEqual(ack.recorded_masters, ["master_buffett"]);
  assert.deepEqual(ack.pending_masters, ["master_munger"]);
  assert.match(ack.status_json, /status\.json$/);
});
