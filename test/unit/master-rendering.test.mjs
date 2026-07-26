import { test } from "node:test";
import assert from "node:assert/strict";

import { masterCorrelationNote, renderMasterMarkdown } from "../../mcp/lib/markdown.mjs";

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
