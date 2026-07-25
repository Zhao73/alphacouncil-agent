import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFinalReport } from "../../mcp/lib/gates.mjs";
import { parseHeadings, normalizeHeading, denseLength } from "../../mcp/lib/headings.mjs";
import { completeReport, scopedPacket } from "../helpers/fixtures.mjs";

const run = {
  run_id: "Q",
  symbol: "NOK",
  as_of: "2026-06-22",
  language: "English",
  dry_run: false,
  tasks: ["market_data"],
  packets: [scopedPacket()],
};

const failed = (report, extra = {}) => validateFinalReport(report, { ...run, ...extra }).missing;

test("parseHeadings captures level, title, line and body", () => {
  const headings = parseHeadings("# Top\nintro\n\n## A\nalpha\n### A1\nnested\n\n## B\nbeta");
  assert.deepEqual(headings.map((h) => [h.level, h.title]), [[1, "Top"], [2, "A"], [3, "A1"], [2, "B"]]);
  // A subsection stays inside its parent's body.
  assert.match(headings[1].body, /alpha/);
  assert.match(headings[1].body, /nested/);
  assert.equal(headings[3].body, "beta");
  assert.equal(headings[1].line, 4);
});

test("parseHeadings ignores hashes inside code fences", () => {
  const headings = parseHeadings("## Real\nbody\n\n```\n## Not A Heading\n```\n\n~~~\n## Also Not\n~~~\n");
  assert.deepEqual(headings.map((h) => h.title), ["Real"]);
});

test("normalizeHeading folds punctuation and digits but keeps CJK", () => {
  assert.equal(normalizeHeading("Short-Term 1-4 Week View"), "short term 1 4 week view");
  assert.equal(normalizeHeading("战略交易 / 银行事件"), "战略交易 银行事件");
});

test("denseLength counts non-whitespace characters", () => {
  assert.equal(denseLength("a b\n c"), 3);
});

test("the complete fixture passes", () => {
  const result = validateFinalReport(completeReport, run);
  assert.equal(result.status, "passed", result.missing.join("; "));
  assert.equal(result.schema_version, 2);
  assert.equal(result.sections.length, result.required_sections.length);
  assert.ok(result.sections.every((s) => s.status === "ok"));
});

// The defect this rewrite exists for: the old gate lowercased the whole document and
// asked `includes("risk")`, so deleting the Risks section changed nothing.
test("deleting the Risks section is now detected", () => {
  const without = completeReport.replace("## Major Risks\nRisk coverage is present.\n\n", "");
  assert.ok(without.length < completeReport.length, "fixture text must actually change");
  assert.ok(failed(without).some((m) => m.startsWith("missing section: risks")), failed(without).join("; "));
});

test("the fixture uses LF so text-manipulating tests are not silent no-ops", () => {
  assert.ok(!completeReport.includes("\r"), "fixture must be normalized to LF");
  assert.match(completeReport, /## Major Risks\nRisk coverage is present\./);
});

test("a heading that merely mentions a keyword does not satisfy another section", () => {
  // "Quant Factor / Technical Risk View" contains "risk"; longest-alias assignment must
  // still route it to quant and leave risks unsatisfied.
  const without = completeReport.replace("## Major Risks\nRisk coverage is present.\n\n", "");
  assert.ok(without.length < completeReport.length, "fixture text must actually change");
  const result = validateFinalReport(without, run);
  assert.equal(result.sections.find((s) => s.id === "quant")?.status, "ok");
  assert.equal(result.sections.find((s) => s.id === "risks")?.status, "missing");
});

test("Position Recommendation is not swallowed by the conclusion section", () => {
  const result = validateFinalReport(completeReport, run);
  assert.equal(result.sections.find((s) => s.id === "position")?.heading, "Position Recommendation");
  assert.equal(result.sections.find((s) => s.id === "conclusion")?.heading, "Conclusion");
});

test("a bold pseudo-heading does not count as a section", () => {
  const weakened = completeReport.replace("## Major Risks\n", "**Major Risks**\n");
  assert.notEqual(weakened, completeReport, "fixture text must actually change");
  assert.ok(failed(weakened).some((m) => m.startsWith("missing section: risks")));
});

test("a placeholder body is rejected even though the heading exists", () => {
  for (const filler of ["- None", "N/A", "TBD", "待补充"]) {
    const stubbed = completeReport.replace("## Major Risks\nRisk coverage is present.", `## Major Risks\n${filler}`);
    assert.notEqual(stubbed, completeReport, "fixture text must actually change");
    assert.ok(
      failed(stubbed).some((m) => m.startsWith("placeholder section: risks")),
      `"${filler}" should be rejected as a placeholder`,
    );
  }
});

// The old per-task check searched the whole document, so a task id appearing once in the
// source table proved nothing about the analyst work log.
test("a task id in the source table does not satisfy the analyst work log", () => {
  const moved = completeReport.replace(
    "### market_data\nThe market_data analyst produced a visible packet. This section names the planned analyst explicitly and records the evidence handoff.",
    "The work log names no analyst at all, which is exactly the failure this check exists for.",
  );
  assert.notEqual(moved, completeReport, "fixture text must actually change");
  assert.match(moved, /market_data:S1/, "the task id must still appear in the source table");
  assert.ok(
    failed(moved).includes("missing analyst work log entry: market_data"),
    failed(moved).join("; "),
  );
});

test("a report with every heading but no body fails on thinness, not on structure", () => {
  const headingsOnly = completeReport
    .split("\n")
    .filter((line) => line.startsWith("#"))
    .join("\n\n");
  const missing = failed(headingsOnly);
  assert.ok(missing.some((m) => m.startsWith("placeholder section:")), missing.join("; "));
  assert.ok(missing.some((m) => m.startsWith("report too short")));
});
