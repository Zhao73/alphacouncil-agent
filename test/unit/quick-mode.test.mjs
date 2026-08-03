import { test } from "node:test";
import assert from "node:assert/strict";

import { LIMITS, QUICK_TASKS } from "../../mcp/lib/constants.mjs";
import { councilOptions } from "../../mcp/lib/council-options.mjs";
import { completenessStatus, validateFinalReport } from "../../mcp/lib/gates.mjs";
import { compactDebateContext, compactQuickEvidence, managerFallback } from "../../mcp/lib/packets.mjs";
import { debatePrompt, masterPrompt } from "../../mcp/lib/prompts.mjs";
import { finalReportMarkdown } from "../../mcp/lib/markdown.mjs";

function quickRun(over = {}) {
  return {
    run_id: "QUICK-UNIT",
    symbol: "RKLB",
    as_of: "2026-07-28",
    language: "English",
    council_mode: "quick",
    dry_run: false,
    tasks: [...QUICK_TASKS],
    task_status: Object.fromEntries(QUICK_TASKS.map((task) => [task, { task, status: "completed" }])),
    agent_status: {
      bull_researcher: { role: "bull_researcher", status: "completed" },
      bear_researcher: { role: "bear_researcher", status: "completed" },
      portfolio_manager: { role: "portfolio_manager", status: "completed" },
    },
    masters: ["master_buffett"],
    master_opinions: [{
      master: "master_buffett", stance: "out_of_scope", confidence: "low",
      verdict: "Recorded method could not judge the missing fact.",
      voice_statement: "This recorded method could not judge the missing typed fact and therefore withheld a directional view.",
      voice_status: "deterministic_fallback",
    }],
    packets: QUICK_TASKS.map((task) => ({
      task,
      summary: `${task} produced a bounded analyst view with facts and explicit limits.`,
      claims: [{ claim: `${task} claim`, evidence: "bounded evidence", confidence: "medium", source_ids: [`${task}:S1`] }],
      metrics: {},
      sources: [{ id: `${task}:S1`, title: `${task} source`, url: "https://example.com", published_at: "2026-07-27" }],
      open_questions: [],
      confidence: "medium",
      information_richness: "B",
      raw_text: "RAW_SHOULD_NOT_CROSS_SEATS",
    })),
    seat_weight_overrides: {},
    ...over,
  };
}

function quickReport() {
  const analystRows = QUICK_TASKS.map((task) => `- ${task}: recorded facts, confidence and data gaps for the quick read.`).join("\n");
  return `# RKLB Quick Council

## Conclusion
The quick council reached a conditional Hold conclusion; this is not equivalent to a full council decision.

## Analyst Work Log
${analystRows}

## Bull/Bear Debate Record
One parallel bull/bear statement was completed. The bull emphasized operating execution while the bear emphasized valuation and financing risk.

## Master Bench
master_buffett | out_of_scope | The recorded method lacked a required typed fact and did not invent one.

## Earnings Call Management Signals
The earnings analyst recorded management commitments and explicitly separated filed figures from interpretation.

## Recent Company and Industry News
The news analyst recorded dated company and industry items and kept undated or stale items out of the recent-news list.

## Valuation Range
The valuation remains conditional on revenue growth, margins and dilution; no unsupported point target is asserted.

## Price Levels
Above the evidence-supported range do not chase; inside the range wait for confirmation; below it reassess only if the thesis remains intact.

## Major Risks
Execution delays, financing needs, dilution and evidence gaps can invalidate the directional read.

## Position Recommendation
Keep sizing small until the missing facts and the next primary filing are available.

## Data Gaps / Unavailable Data
The quick path did not run adversarial verifiers or a three-round cross-examination, and those limits remain visible.

## Confidence
medium, conditional on the cited quick evidence.

## Source Table
- market_data:S1 — quote source — 2026-07-27 — https://example.com
`;
}

test("quick is a first-class fixed news-inclusive preset", () => {
  const quick = councilOptions({ language: "English" }).presets.find((preset) => preset.id === "quick");
  assert.deepEqual(quick.analysts, QUICK_TASKS);
  assert.ok(quick.analysts.includes("news_industry_management"));
  assert.equal(quick.master_selection_maximum, 4);
  assert.equal(quick.debate_rounds, 1);
  assert.equal(quick.report_contract, "quick_v1");
  assert.equal(quick.hard_time_budget_ms, LIMITS.QUICK_TOTAL_MS);
  assert.equal(quick.full_council_equivalent, false);
});

test("quick_v1 has an explicit smaller report contract without weakening full_v2", () => {
  const run = quickRun();
  const assembled = finalReportMarkdown(run, { report_markdown: quickReport() });
  const quick = validateFinalReport(assembled, run);
  assert.equal(quick.status, "passed", quick.missing.join("; "));
  assert.equal(quick.contract_id, "quick_v1");
  assert.equal(quick.scope, "quick");
  assert.equal(quick.full_council_equivalent, false);
  assert.equal(quick.debate_rounds_expected, 1);
  assert.equal(quick.adversarial_verification, "not_run");
  assert.deepEqual(quick.required_tasks, QUICK_TASKS);
  assert.equal((assembled.match(/alphacouncil:quick-scope:v1:begin/g) || []).length, 1);
  assert.match(assembled, /full_council_equivalent=false/);

  const unassembled = validateFinalReport(quickReport(), run);
  assert.equal(unassembled.status, "needs_revision");
  assert.ok(unassembled.missing.includes("missing system-owned quick_v1 scope marker"));

  const full = validateFinalReport(quickReport(), { ...run, council_mode: "full" });
  assert.equal(full.status, "needs_revision");
  assert.equal(full.contract_id, "full_v2");
  assert.ok(full.missing.some((item) => item.includes("market_expectations")));
});

test("quick evidence and cross-round debate contexts exclude artifact-only raw payloads", () => {
  const run = quickRun({
    packets: quickRun().packets.map((packet) => ({
      ...packet,
      raw_text: "RAW_SENTINEL".repeat(20_000),
      metrics: { huge: "M".repeat(100_000) },
    })),
  });
  const compact = JSON.stringify(compactQuickEvidence(run));
  assert.ok(compact.length < 40_000, `quick evidence context was ${compact.length} chars`);
  assert.doesNotMatch(compact, /RAW_SENTINEL/);
  assert.match(compact, /news_industry_management:S1/);

  const prior = {
    role: "bull_researcher", verdict: "case", summary: "summary",
    long_thesis: ["thesis"], source_ids: ["market_data:S1"], confidence: "medium",
    raw_text: "RAW_DEBATE_SENTINEL", report_markdown: "REPORT_SENTINEL",
  };
  assert.doesNotMatch(JSON.stringify(compactDebateContext(prior)), /RAW_DEBATE_SENTINEL|REPORT_SENTINEL/);
  const prompt = debatePrompt("portfolio_manager", run, { bull: prior, bear: prior, outputMode: "chat" });
  assert.doesNotMatch(prompt, /RAW_DEBATE_SENTINEL|REPORT_SENTINEL/);
  assert.match(prompt, /quick_v1/);
  assert.ok(prompt.length < 80_000, `quick PM prompt was ${prompt.length} chars`);

  const master = masterPrompt("master_buffett", run);
  assert.doesNotMatch(master, /RAW_SENTINEL/);
  assert.ok(master.length < 80_000, `quick master prompt was ${master.length} chars`);
});

test("quick evidence compaction preserves claim-to-source referential integrity", () => {
  const run = quickRun();
  const packet = run.packets[0];
  packet.claims = [
    { claim: "high-value claim", evidence: "e", confidence: "high", source_ids: [`${packet.task}:S7`] },
  ];
  packet.sources = Array.from({ length: 8 }, (_, index) => ({
    id: `${packet.task}:S${index + 1}`,
    title: `source ${index + 1}`,
    url: `https://example.com/${index + 1}`,
  }));
  const compact = compactQuickEvidence(run).packets[0];
  assert.deepEqual(compact.claims[0].source_ids, [`${packet.task}:S7`]);
  assert.ok(compact.sources.some((source) => source.id === `${packet.task}:S7`));
  assert.equal(compact.omitted_source_count, 2);
});

test("full PM context keeps bounded three-round Q&A while removing raw artifacts", () => {
  const run = { ...quickRun(), council_mode: "full" };
  const prior = {
    role: "bull_researcher",
    summary: "final summary",
    debate_rounds: [{
      round: 2,
      summary: "ROUND_TWO_SENTINEL",
      questions: ["EXACT_QUESTION_SENTINEL"],
      questions_answered: [{ question: "q", answer: "EXACT_ANSWER_SENTINEL" }],
      raw_text: "RAW_ROUND_SENTINEL",
    }],
    raw_text: "RAW_TOP_SENTINEL",
    report_markdown: "REPORT_SENTINEL",
  };
  const prompt = debatePrompt("portfolio_manager", run, { bull: prior, bear: prior });
  assert.match(prompt, /ROUND_TWO_SENTINEL/);
  assert.match(prompt, /EXACT_QUESTION_SENTINEL/);
  assert.match(prompt, /EXACT_ANSWER_SENTINEL/);
  assert.doesNotMatch(prompt, /RAW_ROUND_SENTINEL|RAW_TOP_SENTINEL|REPORT_SENTINEL/);
});

test("quick degraded evidence remains a separate axis from structural report quality", () => {
  const run = quickRun();
  run.task_status.market_data.status = "degraded";
  run.task_status.market_data.error = "timeout";
  const status = completenessStatus(run);
  assert.equal(status.completeness, "complete");
  assert.equal(status.evidence_coverage, "degraded");
  assert.deepEqual(status.degraded_evidence, ["market_data"]);

  run.task_status.earnings_deep_dive.status = "degraded";
  run.task_status.valuation_long_short.status = "degraded";
  const insufficient = completenessStatus(run);
  assert.equal(insufficient.completeness, "incomplete");
  assert.equal(insufficient.evidence_coverage, "incomplete");
  assert.ok(insufficient.missing_evidence.length >= 3);
});

test("degraded quick reports receive one idempotent system ledger and quality records the degraded axis", () => {
  const run = quickRun();
  run.task_status.market_data.status = "degraded";
  run.task_status.market_data.error = "timeout";
  const manager = { report_markdown: quickReport() };
  const once = finalReportMarkdown(run, manager);
  const twice = finalReportMarkdown(run, { report_markdown: once });
  assert.equal((twice.match(/alphacouncil:degraded-ledger:v1:begin/g) || []).length, 1);
  assert.match(twice, /DEGRADED QUICK RUN/);
  assert.match(twice, /market_data: degraded; timeout/);
  const quality = validateFinalReport(twice, run);
  assert.equal(quality.status, "passed", quality.missing.join("; "));
  assert.equal(quality.evidence_coverage, "degraded");
  assert.deepEqual(quality.degraded_evidence, ["market_data"]);

  const unassembled = validateFinalReport(quickReport(), run);
  assert.equal(unassembled.status, "needs_revision");
  assert.ok(unassembled.missing.includes("missing system-owned degraded execution ledger"));
});

test("manager fallback is an unavailable decision, never a synthetic Hold rating", () => {
  const fallback = managerFallback(quickRun(), "fixture failure");
  assert.equal(fallback.decision_available, false);
  assert.equal(fallback.rating, null);
  assert.equal(fallback.verdict, "NEEDS_MANAGER_REVIEW");
});

for (const [language, title, sentence] of [
  ["ja-JP", /投資委員会ドラフト/, /正式な投資判断はありません/],
  ["ko-KR", /투자위원회 초안/, /공식 투자 판단을 제공할 수 없습니다/],
]) {
  test(`${language} manager fallback keeps system-owned failure copy in the run language`, () => {
    const fallback = managerFallback({ ...quickRun(), language }, "fixture failure");
    assert.equal(fallback.decision_available, false);
    assert.match(fallback.report_markdown, title);
    assert.match(fallback.report_markdown, sentence);
    assert.doesNotMatch(fallback.report_markdown, /Investment Committee Draft|The manager synthesis subagent did not complete/);
  });
}
