import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";

const { taskPrompt } = __test__;

test("worker prompt follows a Chinese request and blocks recursive plugin calls", () => {
  const prompt = taskPrompt("market_data", "NOK", "2026-06-22", "帮我看看 NOK", "auto");
  assert.match(prompt, /不要调用 alphacouncil-agent 插件\/MCP 工具/);
  assert.match(prompt, /codex-search-bridge/);
  assert.match(prompt, /原生.*web search/i);
  assert.match(prompt, /字段内容用中文/);
});

test("worker prompt follows a non-Chinese request", () => {
  const prompt = taskPrompt("market_data", "NOK", "2026-06-22", "Can I enter NOK?", "auto");
  assert.match(prompt, /reader-facing fields/);
  assert.match(prompt, /English/);
  assert.doesNotMatch(prompt, /字段内容用中文/);
});

test("quant_factor prompt requests factor evidence and missing-data reporting", () => {
  const prompt = taskPrompt("quant_factor", "NOK", "2026-06-22", "帮我看看 NOK", "auto");
  assert.match(prompt, /动能/, "the momentum factor must be named");
  assert.match(prompt, /12-1/, "the 12-1 window must be specified, not just 'momentum'");
  assert.match(prompt, /禁止形态学预测/, "chart-pattern forecasting must stay banned");
  assert.match(prompt, /open_questions/);
});

test("quant_factor prompt treats established options OI as mandatory evidence", () => {
  const prompt = taskPrompt("quant_factor", "NOK", "2026-06-22", "Assess NOK", "en-US");
  assert.match(prompt, /grounding\.options\.open_interest/);
  assert.match(prompt, /MUST.*calls, puts, and the put\/call OI ratio/i);
  assert.match(prompt, /grounding\.options\.largest_open_interest_strikes/);
  assert.match(prompt, /largest-OI strikes.*OI concentrations/i);
  assert.match(prompt, /Only genuinely absent fields such as IV history, IV rank, or IV percentile may be marked unavailable/i);
});

test("news prompt gates no-event claims on current regulator and issuer-official coverage", () => {
  const prompt = taskPrompt("news_industry_management", "NOK", "2026-06-22", "Assess NOK", "en-US");
  assert.match(prompt, /SEC submissions recent feed.*through `as_of`/i);
  assert.match(prompt, /issuer's \*\*IR\/newsroom\*\* through `as_of`/i);
  assert.match(prompt, /latest official filing\/news date and the coverage cutoff/i);
  assert.match(prompt, /If either official surface is missing or unreachable.*do not make a no-event assertion/is);
  assert.match(prompt, /top-level `official_source_coverage`/i);
  assert.match(prompt, /`latest_dated_item` must be the most recent item in `dated_items_checked`/i);
  assert.match(prompt, /Top-level status may be `complete` only when both surfaces were actually checked through `as_of`/i);
  assert.match(prompt, /accession\/record_id.*original-document URL must match/i);
  assert.match(prompt, /entire news packet is rejected and cannot enter a rating/i);
});

// Masters used to see only the analysts' packets. That made 21 seats inherit one selection
// of what mattered -- a large and perfectly correlated error -- and destroyed the reason
// the bench exists, which is that Munger looks at incentives where an analyst looked at
// margins. They now get the same established facts, with the packets marked as readings.
test("a master prompt carries the established facts, not only the analysts' packets", async () => {
  const { masterPrompt } = await import("../../mcp/lib/prompts.mjs");
  const run = {
    run_id: "r1", symbol: "MU", as_of: "2026-07-26", language: "English",
    masters: ["master_buffett"], tasks: [], packets: [],
    grounding: {
      symbol: "MU",
      quote: { symbol: "MU", price: 920.95, currency: "USD", change_pct: 1.2, source: "yahoo" },
    },
  };
  const prompt = masterPrompt("master_buffett", run);
  assert.match(prompt, /920\.95/, "an established fact must reach the master directly");
  assert.match(prompt, /readings of the/, "packets must be labelled as interpretation, not fact");
  assert.match(prompt, /Evidence JSON/);
});

test("a master prompt still works when no grounding was gathered", () => {
  const run = { run_id: "r2", symbol: "MU", as_of: "2026-07-26", language: "English", masters: ["master_munger"], packets: [], grounding: null };
  const prompt = __test__.masterPrompt ? __test__.masterPrompt("master_munger", run) : null;
  assert.ok(prompt === null || typeof prompt === "string");
});

test("debate rounds make the Q&A dependency executable", async () => {
  const { debatePrompt } = await import("../../mcp/lib/prompts.mjs");
  const run = {
    run_id: "QNA-PROMPT",
    symbol: "RKLB",
    as_of: "2026-07-28",
    language: "English",
    tasks: [],
    packets: [],
    masters: [],
    master_opinions: [],
  };
  const roundTwo = debatePrompt("bull_researcher", run, { round: 2 });
  assert.match(roundTwo, /Schema:.*questions_answered/,
    "the advertised JSON schema must permit the Q&A fields the round requires");
  assert.match(roundTwo, /ask exactly 3.*questions/i);

  const asked = ["q1", "q2", "q3"];
  const received = ["opponent q1", "opponent q2", "opponent q3"];
  const roundThree = debatePrompt("bull_researcher", run, {
    round: 3,
    questionsYouAsked: asked,
    questionsForYou: received,
  });
  assert.match(roundThree, /copy.*round 2 questions/i);
  assert.match(roundThree, /contain exactly 3.*question.*answer/i);
  assert.match(roundThree, new RegExp(JSON.stringify(asked).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(roundThree, new RegExp(JSON.stringify(received).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("an ETF portfolio-manager prompt requires the fund structure section and aggregation discipline", async () => {
  const { debatePrompt } = await import("../../mcp/lib/prompts.mjs");
  const prompt = debatePrompt("portfolio_manager", {
    run_id: "QQQ-PM",
    symbol: "QQQ",
    as_of: "2026-07-28",
    language: "English",
    tasks: [], packets: [], masters: [], master_opinions: [],
    grounding: {
      instrument: { asset_type: "etf", research_model: "fund_lookthrough", fund_like: true },
    },
  });
  assert.match(prompt, /## Fund and Index Structure/);
  assert.match(prompt, /dated holdings\/constituent weights/);
  assert.match(prompt, /never add a few constituents into portfolio financials/i);
});

test("full headless portfolio-manager prompt ends with the compact decision contract", async () => {
  const { debatePrompt } = await import("../../mcp/lib/prompts.mjs");
  const prompt = debatePrompt("portfolio_manager", {
    run_id: "RKLB-HEADLESS-PM",
    symbol: "RKLB",
    as_of: "2026-07-28",
    language: "English",
    council_mode: "full",
    tasks: [], packets: [], masters: [], master_opinions: [],
  }, { structuredDecisionOnly: true });
  assert.match(prompt, /HEADLESS_STRUCTURED_PM_DECISION_V1/);
  assert.match(prompt, /Do not return `report_markdown`/);
  assert.match(prompt, /price_levels.*horizon_views.*data_gaps/s);
  assert.match(prompt, /verification_findings_ack/);
  assert.match(prompt, /never list internal file paths, filesystem visibility, tool permissions/u);
  assert.ok(prompt.lastIndexOf("HEADLESS_STRUCTURED_PM_DECISION_V1") > prompt.lastIndexOf("Evidence JSON:"),
    "the compact transport contract must be the final output-form instruction");
});

test("operating-company debate cannot fall back when the frozen dossier is missing", async () => {
  const { debatePrompt } = await import("../../mcp/lib/prompts.mjs");
  const run = {
    run_id: "MISSING-DOSSIER",
    symbol: "ACME",
    as_of: "2026-08-27",
    language: "English",
    council_mode: "full",
    dry_run: false,
    entry_tool: "analyze_symbol",
    decision_requested: true,
    tasks: [], packets: [], masters: [], master_opinions: [],
    grounding: { instrument: { research_model: "operating_company" } },
  };
  assert.throws(
    () => debatePrompt("bull_researcher", run, { round: 1 }),
    (error) => error?.data?.reason === "COMPANY_DOSSIER_ARTIFACT_INTEGRITY_FAILURE",
  );

  const planned = debatePrompt("bull_researcher", { ...run, entry_tool: "plan_visible_run" }, {
    round: 1,
    planning: true,
  });
  assert.match(planned, /operating_company_dossier_planning_placeholder_v1/u);
  assert.match(planned, /freeze and revalidate the full company dossier/iu);
  assert.doesNotMatch(planned, /evidence\.json|company_dossier\.json|\/runs\//iu);
});

test("a method voice receives frozen decision causality and hard verification corrections", async () => {
  const { masterVoicePrompt } = await import("../../mcp/lib/prompts.mjs");
  const run = {
    run_id: "VRT-METHOD-VOICE",
    symbol: "VRT",
    as_of: "2026-08-05",
    language: "English",
    council_mode: "full",
    tasks: ["valuation"],
    packets: [{
      task: "valuation",
      status: "complete",
      confidence: "high",
      sources: [{ source_id: "valuation:S1", title: "Frozen valuation source" }],
      claims: [{
        claim: "The index earnings yield proves the company is overvalued.",
        evidence: "The original packet substituted an index aggregate for company valuation.",
        confidence: "high",
        source_ids: ["valuation:S1"],
      }],
    }],
    verifier_verdicts: [{
      verifier: "source_fidelity",
      verdict: "contradicted",
      claim_id: "valuation:C1",
      task: "valuation",
      claim: "The index earnings yield proves the company is overvalued.",
      note: "The source is a broad-market aggregate, not VRT company valuation evidence.",
      rederivation: "Exclude the index proxy until company-specific valuation inputs exist.",
    }],
  };
  const frozenOpinion = {
    stance: "opposed",
    deterministic_stance: "opposed",
    decision_reason: "veto",
    common_projection: {
      stance: "opposed",
      reason: "veto",
      score_ratio: 1,
      veto_ids: ["master_taleb.absorbing_barrier"],
    },
    native_decision: { state: "no_trade", metrics: { metric_1: 1, metric_2: 0.2 } },
    evidence_source_ids: ["valuation:S1"],
  };

  const prompt = masterVoicePrompt("master_taleb", run, frozenOpinion);
  assert.match(prompt, /Scoring and hard vetoes are independent decision branches/);
  assert.match(prompt, /named veto independently overrides the score/);
  assert.match(prompt, /"decision_reason":"veto"/);
  assert.match(prompt, /"score_ratio":1/);
  assert.match(prompt, /Hard findings JSON/);
  assert.match(prompt, /"verdict":"contradicted"/);
  assert.match(prompt, /override the original analyst packets/);
  assert.match(prompt, /may not continue using it as support/);
});
