import { test } from "node:test";
import assert from "node:assert/strict";

import { renderStructuredManagerReport } from "../../mcp/lib/manager-report.mjs";
import { assertRuntimeWorkerPayload, RUNTIME_WORKER_SCHEMA_IDS } from "../../mcp/lib/runtime-validation.mjs";
import { resolveSeatWeights, weightTableMarkdown } from "../../mcp/lib/weights.mjs";

function structuredDecision() {
  return {
    verdict: "Hold until the evidence-backed conditions improve.",
    rating: "Hold",
    winner: "balanced",
    summary: "The bounded evidence supports a conditional position only.",
    long_thesis: ["Operating progress could improve the payoff."],
    short_thesis: ["Execution and valuation remain material risks."],
    valuation_range: "Conditional on verified operating progress.",
    catalysts: ["The next primary filing."],
    risks: ["Execution could miss the recorded milestones."],
    position: "Keep any starter position bounded.",
    invalidation: ["Exit if the verified milestones fail."],
    source_ids: ["market_data:S1"],
    confidence: "medium",
    price_levels: [
      {
        label: "Do not touch",
        range: "Above the evidence-backed ceiling",
        lower_bound: 200,
        upper_bound: null,
        currency: "USD",
        meaning: "The payoff no longer covers the risk.",
        action: "Do not initiate.",
        basis: "Conditional valuation ceiling.",
        source_ids: ["market_data:S1"],
      },
      {
        label: "Worth starting",
        range: "Inside the evidence-backed range",
        lower_bound: 100,
        upper_bound: 200,
        currency: "USD",
        meaning: "A bounded starter may be justified.",
        action: "Start small only while the thesis holds.",
        basis: "Conditional valuation range.",
        source_ids: ["valuation_long_short:S1"],
      },
      {
        label: "Materially undervalued",
        range: "Below the evidence-backed floor",
        lower_bound: null,
        upper_bound: 100,
        currency: "USD",
        meaning: "The margin of safety is wider.",
        action: "Add only if every invalidation test still passes.",
        basis: "Downside case and operating evidence.",
        source_ids: ["earnings_deep_dive:S1"],
      },
    ],
    horizon_views: {
      short_term: "Wait for the next dated filing.",
      medium_term: "Require measurable operating progress.",
      long_term: "Require durable economics and financing discipline.",
    },
    data_gaps: ["No critical data gaps were found in the completed fixture packets."],
    verification_findings_ack: [],
  };
}

function reportRun() {
  return {
    symbol: "QQQ",
    language: "English",
    tasks: ["market_data", "earnings_deep_dive", "valuation_long_short"],
    task_status: {
      market_data: { status: "completed" },
      earnings_deep_dive: { status: "completed" },
      valuation_long_short: { status: "completed" },
    },
    packets: [
      ["market_data", "market_data:S1"],
      ["earnings_deep_dive", "earnings_deep_dive:S1"],
      ["valuation_long_short", "valuation_long_short:S1"],
    ].map(([task, id]) => ({
      task,
      summary: `${task} fixture summary with explicit limits.`,
      claims: [{ claim: `${task} fixture claim.`, evidence: "Bounded fixture evidence.", source_ids: [id] }],
      sources: [{ id, title: `${task} fixture source`, published_at: "2026-08-01", url: `https://example.com/${task}` }],
      open_questions: [],
    })),
    master_opinions: [{ master: "master_buffett", stance: "constructive" }],
    verifier_verdicts: [{ seat: "market_data", verdict: "contradicted", claim: "fixture claim" }],
    seat_weight_overrides: { master_buffett: 2 },
  };
}

test("dedicated headless PM schema accepts a complete structured decision", () => {
  const decision = structuredDecision();
  assert.equal(
    RUNTIME_WORKER_SCHEMA_IDS.headless_portfolio_manager_decision,
    "runtime-headless-portfolio-manager-decision-v1",
  );
  assert.equal(assertRuntimeWorkerPayload("headless_portfolio_manager_decision", decision), decision);
});

const invalidStructuredDecisions = [
  ["missing price_levels", (decision) => { delete decision.price_levels; }],
  ["fewer than three price levels", (decision) => { decision.price_levels.length = 2; }],
  ["hollow price basis", (decision) => { decision.price_levels[0].basis = "  "; }],
  ["price row without source IDs", (decision) => { decision.price_levels[0].source_ids = []; }],
  ["missing horizon_views", (decision) => { delete decision.horizon_views; }],
  ["hollow horizon string", (decision) => { decision.horizon_views.short_term = "\n\t"; }],
  ["missing data_gaps", (decision) => { delete decision.data_gaps; }],
  ["empty data_gaps", (decision) => { decision.data_gaps = []; }],
  ["hollow data gap", (decision) => { decision.data_gaps = ["  "]; }],
  ["missing verification_findings_ack", (decision) => { delete decision.verification_findings_ack; }],
  ["invalid verification disposition", (decision) => { decision.verification_findings_ack = [{ finding_id: "source_fidelity:market_data:C1", disposition: "ignored", note: "This fixture note is long enough." }]; }],
  ["worker-authored report", (decision) => { decision.report_markdown = "# Untrusted report"; }],
];

for (const [name, mutate] of invalidStructuredDecisions) {
  test(`dedicated headless PM schema rejects ${name}`, () => {
    const decision = structuredDecision();
    mutate(decision);
    assert.throws(
      () => assertRuntimeWorkerPayload("headless_portfolio_manager_decision", decision),
      (error) => error?.data?.reason === "WORKER_OUTPUT_SCHEMA_MISMATCH"
        && error?.data?.schema_id === "runtime-headless-portfolio-manager-decision-v1",
    );
  });
}

test("deterministic report keeps every price-row source ID and the exact resolved weight audit", () => {
  const run = reportRun();
  const decision = structuredDecision();
  const report = renderStructuredManagerReport(run, decision);

  for (const row of decision.price_levels) {
    const renderedRow = report.split("\n").find((line) => line.includes(`| ${row.label} |`));
    assert.ok(renderedRow, `missing rendered price row ${row.label}`);
    assert.ok(renderedRow.includes(row.basis), `missing basis for ${row.label}`);
    assert.ok(
      renderedRow.includes(`(sources: \`${row.source_ids[0]}\`)`),
      `source IDs must be appended even when ${row.label} already has basis prose`,
    );
  }

  const resolved = resolveSeatWeights(run, run.seat_weight_overrides);
  const expectedTable = weightTableMarkdown(resolved, run.language);
  assert.ok(report.includes(`## Resolved Seat-Weight Audit\n${expectedTable}`));
  assert.match(expectedTable, /market_data.*contradicted/u);
  assert.match(expectedTable, /master_buffett.*2 \(override\)/u);
});

test("deterministic report exposes hard verifier findings and the PM disposition", () => {
  const run = reportRun();
  const packet = run.packets.find((item) => item.task === "valuation_long_short");
  packet.summary = "RAW HARD-FINDING SUMMARY MUST NOT SURVIVE.";
  packet.open_questions = ["RAW HARD-FINDING OPEN QUESTION MUST NOT SURVIVE."];
  packet.claims[0].evidence = "RAW HARD-FINDING EVIDENCE MUST NOT SURVIVE.";
  packet.claims.push({
    claim: "UNAFFECTED CLAIM MUST SURVIVE.",
    evidence: "Unaffected bounded evidence.",
    source_ids: ["valuation_long_short:S1"],
  });
  run.verifier_verdicts = [{
    verifier: "source_fidelity",
    claim_id: "valuation_long_short:C1",
    task: "valuation_long_short",
    verdict: "contradicted",
    claim: "valuation_long_short fixture claim.",
    note: "The cited page does not support the original value.",
  }];
  const decision = structuredDecision();
  decision.verification_findings_ack = [{
    finding_id: "source_fidelity:valuation_long_short:C1",
    verifier: "source_fidelity",
    claim_id: "valuation_long_short:C1",
    task: "valuation_long_short",
    verdict: "contradicted",
    claim: "valuation_long_short fixture claim.",
    note: "The cited page does not support the original value.",
    rederivation: "",
    disposition: "excluded",
    acknowledgement_note: "Removed the unsupported value from every final decision field.",
  }];
  const report = renderStructuredManagerReport(run, decision);
  assert.match(report, /## Triple-Verification Corrections/u);
  assert.match(report, /source_fidelity:valuation_long_short:C1/u);
  assert.match(report, /Removed the unsupported value/u);
  assert.match(report, /Triple-Verification Corrections: source_fidelity=contradicted/u);
  assert.match(report, /Original claim withdrawn after triple verification/u);
  assert.match(report, /remaining raw claims.*withheld from decision-facing sections/u);
  assert.doesNotMatch(report, /UNAFFECTED CLAIM MUST SURVIVE/u);
  assert.doesNotMatch(report, /RAW HARD-FINDING SUMMARY MUST NOT SURVIVE/u);
  assert.doesNotMatch(report, /RAW HARD-FINDING OPEN QUESTION MUST NOT SURVIVE/u);
  assert.doesNotMatch(report, /RAW HARD-FINDING EVIDENCE MUST NOT SURVIVE/u);
  assert.equal(
    (report.match(/valuation_long_short fixture claim\./gu) || []).length,
    1,
    "the withdrawn prose may appear only in the explicitly labelled correction ledger",
  );
});

test("global data gaps come only from the structured PM decision", () => {
  const run = reportRun();
  run.packets[0].open_questions = ["PACKET-LOCAL GAP MUST NOT ENTER THE GLOBAL DATA-GAPS SECTION."];
  const decision = structuredDecision();
  decision.data_gaps = ["PM-AUTHORITATIVE DATA GAP."];
  const report = renderStructuredManagerReport(run, decision);
  const gaps = report.match(/## Data Gaps \/ Unavailable Data\n([\s\S]*?)\n\n## Invalidation Conditions/u)?.[1] || "";

  assert.match(gaps, /PM-AUTHORITATIVE DATA GAP/u);
  assert.doesNotMatch(gaps, /PACKET-LOCAL GAP/u);
});
