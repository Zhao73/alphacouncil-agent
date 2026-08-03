import { test } from "node:test";
import assert from "node:assert/strict";

import { finalReportMarkdown, masterCorrelationNote, renderMasterMarkdown } from "../../mcp/lib/markdown.mjs";
import { validateFinalReport } from "../../mcp/lib/gates.mjs";
import { REPORT_SECTIONS } from "../../mcp/lib/constants.mjs";
import { normalizeHeading, parseHeadings } from "../../mcp/lib/headings.mjs";
import { recordAck } from "../../mcp/lib/rpc.mjs";

const opinion = (over = {}) => ({
  master: "master_buffett",
  symbol: "NOK",
  as_of: "2026-07-26",
  stance: "avoid",
  verdict: "outside the circle of competence",
  summary: "Ten-year quality metrics are uncomputable for this filer.",
  voice_statement: "Ten-year quality metrics are uncomputable for this filer, so this method withholds a directional view.",
  voice_status: "deterministic_fallback",
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

test("final report assembly restores a missing master bench from recorded opinions", () => {
  const run = {
    language: "zh-CN",
    masters: ["master_buffett"],
    master_opinions: [opinion({ stance: "out_of_scope" })],
    tasks: [],
    packets: [],
  };
  const markdown = finalReportMarkdown(run, { report_markdown: reportWithout("master_bench") });
  const quality = validateFinalReport(markdown, run);
  assert.equal(quality.sections.find((section) => section.id === "master_bench")?.status, "ok");
  assert.equal(quality.method_statement_coverage.status, "passed", quality.missing.join("; "));
  assert.match(markdown, /## 大师席位/);
  assert.match(markdown, /out_of_scope/);
});

test("report quality fails when a selected method has no readable final statement", () => {
  const run = {
    language: "English",
    masters: ["master_buffett"],
    master_opinions: [opinion({ voice_statement: "" })],
    tasks: [],
    packets: [],
  };
  const markdown = finalReportMarkdown(run, { report_markdown: reportWithout("master_bench") });
  const quality = validateFinalReport(markdown, run);
  assert.equal(quality.method_statement_coverage.status, "failed");
  assert.ok(quality.missing.includes("missing readable method-seat statement: master_buffett"));
});

test("report quality requires every selected stable ID inside the published Master Bench", () => {
  const run = {
    language: "English",
    masters: ["master_buffett"],
    master_opinions: [opinion()],
    tasks: [],
    packets: [],
  };
  const quality = validateFinalReport(reportWithout(null), run);
  assert.equal(quality.method_statement_coverage.status, "failed");
  assert.ok(quality.missing.includes("method-seat statement not rendered in Master Bench: master_buffett"));
});

test("ETF final-report assembly owns an idempotent structure and look-through section", () => {
  const run = {
    language: "English",
    grounding: {
      instrument: {
        asset_type: "etf",
        research_model: "fund_lookthrough",
        classification_source: "yahoo_chart_metadata",
        raw_instrument_type: "ETF",
        fund_like: true,
        index_like: false,
      },
      not_applicable: ["operating-company SEC Company Facts screen: not applicable to etf"],
    },
    masters: [],
    master_opinions: [],
    tasks: [],
    packets: [],
  };
  const once = finalReportMarkdown(run, { report_markdown: reportWithout("instrument_structure") });
  const twice = finalReportMarkdown(run, { report_markdown: once });
  assert.equal((twice.match(/alphacouncil:recorded-instrument-structure:v1:/g) || []).length, 1);
  assert.match(twice, /## Fund and Index Structure/);
  assert.match(twice, /Asset type: etf/);
  assert.match(twice, /never add a few constituents into fund or index revenue, EPS, or cash flow/);
  const quality = validateFinalReport(twice, run);
  assert.equal(quality.sections.find((section) => section.id === "instrument_structure")?.status, "ok");
  assert.equal(quality.status, "passed", quality.missing.join("; "));
});

function benchHeadings(markdown) {
  return parseHeadings(markdown).filter(({ title }) => {
    const normalized = normalizeHeading(title);
    return normalized.includes("master bench") || normalized.includes("master lens") || normalized.includes("大师席");
  });
}

test("final report assembly replaces generic PM bench prose with the recorded opinions", () => {
  const run = {
    language: "English",
    masters: ["master_buffett"],
    master_opinions: [opinion({ verdict: "RECORDED VERDICT MUST APPEAR" })],
    tasks: [],
    packets: [],
  };
  const body = reportWithout(null);
  const markdown = finalReportMarkdown(run, { report_markdown: body });
  assert.equal(benchHeadings(markdown).length, 1);
  assert.match(markdown, /master_buffett/);
  assert.match(markdown, /avoid/);
  assert.match(markdown, /RECORDED VERDICT MUST APPEAR/);
  assert.match(markdown, /alphacouncil:recorded-master-bench:v1:sha256:[0-9a-f]{64}/);
});

test("final report assembly collapses stale duplicate bench aliases into one system-owned bench", () => {
  const run = {
    language: "English",
    masters: ["master_buffett", "master_taleb"],
    master_opinions: [
      opinion({ verdict: "Buffett recorded verdict" }),
      opinion({ master: "master_taleb", stance: "out_of_scope", verdict: "Taleb recorded verdict" }),
    ],
    tasks: [],
    packets: [],
  };
  const stale = `${reportWithout("master_bench")}\n## Master Bench\n\nStale generic verdict.\n\n## Master Lens Notes\n\nAnother stale generic verdict.\n`;
  const markdown = finalReportMarkdown(run, { report_markdown: stale });
  assert.equal(benchHeadings(markdown).length, 1);
  assert.match(markdown, /master_buffett/);
  assert.match(markdown, /master_taleb/);
  assert.match(markdown, /Buffett recorded verdict/);
  assert.match(markdown, /Taleb recorded verdict/);
});

test("system-owned Master Bench assembly is idempotent", () => {
  const run = {
    language: "English",
    masters: ["master_buffett"],
    master_opinions: [opinion()],
    tasks: [],
    packets: [],
  };
  const once = finalReportMarkdown(run, { report_markdown: reportWithout(null) });
  const twice = finalReportMarkdown(run, { report_markdown: once });
  assert.equal(benchHeadings(twice).length, 1);
  assert.equal((twice.match(/alphacouncil:recorded-master-bench:v1:/g) || []).length, 1);
  assert.equal((twice.match(/outside the circle of competence/g) || []).length, 1);
});

test("localized method-seat subheadings do not break Japanese bench idempotency", () => {
  const run = {
    language: "ja-JP",
    masters: ["master_buffett"],
    master_opinions: [opinion({ voice_statement: "日本語の専用方法席センチネル", voice_status: "completed" })],
    tasks: [],
    packets: [],
  };
  const once = finalReportMarkdown(run, { report_markdown: reportWithout(null) });
  const twice = finalReportMarkdown(run, { report_markdown: once });
  assert.equal((twice.match(/alphacouncil:recorded-master-bench:v1:/g) || []).length, 1);
  assert.equal((twice.match(/日本語の専用方法席センチネル/g) || []).length, 2, "full statement appears once in the bench and once in the terminal tail");
  assert.equal((twice.match(/alphacouncil:handoff-method-seat-tail:v1:begin/g) || []).length, 1);
  assert.match(twice, /## マスター・ベンチ/);
});

test("Master Bench assembly never invents a missing selected opinion", () => {
  const run = {
    language: "English",
    masters: ["master_buffett", "master_taleb"],
    master_opinions: [opinion()],
    tasks: [],
    packets: [],
  };
  const markdown = finalReportMarkdown(run, { report_markdown: reportWithout("master_bench") });
  const bench = benchHeadings(markdown)[0];
  assert.match(bench.body, /master_buffett/);
  assert.doesNotMatch(bench.body, /master_taleb/);
  assert.match(markdown, /Method seats that gave no opinion:[\s\S]*master_taleb/);
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

import { renderBenchSummary, renderDecisionTable } from "../../mcp/lib/markdown.mjs";

test("the minority is printed before the concurring seats", () => {
  const run = {
    language: "en",
    master_opinions: [
      opinion({ master: "master_buffett", stance: "opposed" }),
      opinion({ master: "master_munger", stance: "opposed" }),
      opinion({ master: "master_taleb", stance: "constructive", verdict: "convexity is underpriced" }),
    ],
  };
  const md = renderBenchSummary(run);
  const minorityAt = md.indexOf("Minority report");
  const concurringAt = md.indexOf("Concurring seats");
  assert.ok(minorityAt > -1 && concurringAt > -1);
  // Printing the concurring block first reproduces the tally in prose even after the
  // numbers are gone, so the order is part of the fix.
  assert.ok(minorityAt < concurringAt, "dissent must be read first");
  assert.match(md, /convexity is underpriced/);
});

test("unanimity is reported as the absence of dissent, not as confirmation", () => {
  const run = { language: "en", master_opinions: [opinion({ stance: "opposed" }), opinion({ master: "m2", stance: "opposed" })] };
  const md = renderBenchSummary(run);
  assert.match(md, /Minority report: none/);
  assert.match(md, /agreement is the expected outcome rather than confirmation/);
});

test("the decision table shows coverage and marks the seats that cost nothing", () => {
  const md = renderDecisionTable([
    { persona_id: "master_buffett", stance: "out_of_scope", reason: "eligibility", score: null },
    { persona_id: "master_taleb", stance: "constructive", reason: "score", score: { score: 8, max_possible: 10, declared_max: 10, coverage: 1 } },
  ], "en");
  assert.match(md, /master_buffett \| no /);
  assert.match(md, /8\/10/);
  assert.match(md, /100%/);
  assert.match(md, /cost no model call/);
});
