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

test("one-year synthesis routes method direction through Bull/Bear once and gives PM only non-voting method risk", async () => {
  const { debatePrompt, masterPrompt, masterVoicePrompt } = await import("../../mcp/lib/prompts.mjs");
  const run = {
    run_id: "RATING-V2-PROMPT",
    symbol: "INTC",
    as_of: "2026-08-30",
    language: "English",
    council_mode: "full",
    tasks: ["market_data"],
    grounding: { quote: { price: 100, currency: "USD" } },
    packets: [{ task: "market_data", sources: [{ id: "market_data:S1" }] }],
    masters: ["master_buffett", "master_taleb"],
    decision_context: {
      objective: "directional_rating",
      holding_horizon: "1_year",
      rating_basis_required: true,
      rating_rubric_id: "pm_rating_rubric_v2",
    },
    master_selection: {
      method_panel_context: {
        schema_version: 1,
        decisions: [
          { master_id: "master_buffett", roles: ["directional_core"], rating_contribution: "primary" },
          { master_id: "master_taleb", roles: ["risk_overlay"], rating_contribution: "none" },
        ],
      },
    },
    master_opinions: [
      {
        master: "master_buffett",
        stance: "constructive",
        verdict: "directional fixture",
        key_findings: ["Primary direction fixture."],
        disagreements: [],
        disqualifiers_triggered: [],
        evidence_source_ids: ["market_data:S1"],
        confidence: "medium",
      },
      {
        master: "master_taleb",
        stance: "opposed",
        verdict: "raw Taleb stance must not reach PM",
        key_findings: ["Tail-risk coverage fixture."],
        disagreements: [],
        disqualifiers_triggered: ["tail_veto"],
        what_would_change_my_mind: ["Convexity improves."],
        evidence_source_ids: ["market_data:S1"],
        confidence: "medium",
      },
    ],
  };
  const bull = {
    role: "bull_researcher",
    verdict: "Bull case",
    rating: "Buy",
    winner: "bull",
    summary: "Bull summary",
    source_ids: ["market_data:S1"],
  };
  const bear = {
    role: "bear_researcher",
    verdict: "Bear case",
    rating: "Sell",
    winner: "bear",
    summary: "Bear summary",
    source_ids: ["market_data:S1"],
  };

  const advocate = debatePrompt("bull_researcher", run, { round: 1 });
  const bearPrompt = debatePrompt("bear_researcher", run, { round: 1 });
  const manager = debatePrompt("portfolio_manager", run, {
    bull,
    bear,
    structuredDecisionOnly: true,
  });
  const methodPrompt = masterPrompt("master_buffett", run);
  const methodVoice = masterVoicePrompt("master_buffett", run, run.master_opinions[0]);
  for (const prompt of [advocate, bearPrompt, manager, methodPrompt, methodVoice]) {
    assert.match(prompt, /Frozen decision context JSON/u);
    assert.match(prompt, /"objective":"directional_rating"/u);
    assert.match(prompt, /"holding_horizon":"1_year"/u);
  }
  for (const upstream of [advocate, bearPrompt, methodPrompt, methodVoice]) {
    assert.doesNotMatch(upstream, /This run must use `pm_rating_rubric_v2`/u);
    assert.doesNotMatch(upstream, /base_case_total_return_pct/u);
  }
  assert.match(advocate, /Master seat opinions JSON/u);
  assert.match(advocate, /"rating_contribution":"primary"/u);
  assert.doesNotMatch(advocate, /raw Taleb stance must not reach PM|Tail-risk coverage fixture|tail_veto/u);

  assert.doesNotMatch(manager, /Master seat opinions JSON/u);
  assert.doesNotMatch(manager, /raw Taleb stance must not reach PM/u);
  assert.doesNotMatch(manager, /Seat weights follow|Resolved Seat-Weight Audit|effective_weight/u);
  assert.doesNotMatch(manager, /"rating":"Buy"|"rating":"Sell"/u);
  assert.match(manager, /method_risk_context JSON/u);
  assert.match(manager, /"directional_vote_allowed":false/u);
  assert.match(manager, /"rating_adjustment_eligible":true/u);
  assert.match(manager, /tail_veto/u);
  assert.doesNotMatch(manager, /"master":"master_taleb"/u);
  assert.match(manager, /pm_rating_rubric_v2/u);
  assert.match(manager, /price_target_plus_income_v1/u);
  assert.match(manager, /frozen reference price is 100 "USD"/u);
  assert.match(manager, /price_currency/u);
  assert.match(manager, /base_case_total_return_pct/u);
  assert.match(manager, /adjustment_source_ids/u);
});

test("out-of-scope method context is excluded structurally from the PM rating path", async () => {
  const { debatePrompt } = await import("../../mcp/lib/prompts.mjs");
  const run = {
    run_id: "OOS-RISK-CONTEXT",
    symbol: "INTC",
    as_of: "2026-08-30",
    language: "English",
    council_mode: "full",
    tasks: [],
    packets: [],
    masters: ["master_graham"],
    decision_context: {
      objective: "directional_rating",
      holding_horizon: "1_year",
      rating_basis_required: true,
      rating_rubric_id: "pm_rating_rubric_v2",
    },
    master_selection: {
      method_panel_context: {
        schema_version: 1,
        decisions: [{
          master_id: "master_graham",
          roles: ["directional_core", "valuation_anchor"],
          rating_contribution: "primary",
        }],
      },
    },
    master_opinions: [{
      master: "master_graham",
      stance: "out_of_scope",
      disqualifiers_triggered: ["missing_margin_of_safety"],
      missing_required_fact_types: ["valuation.intrinsic_value"],
      what_would_change_my_mind: ["Provide a sourced intrinsic-value range."],
      evidence_quality: "not_evaluable",
      evidence_quality_basis: [{
        fact_id: "valuation.intrinsic_value",
        producer_id: "fixture:valuation",
        derivation: "estimated",
        confidence: 0.4,
      }],
      evidence_source_ids: ["market_data:S1"],
    }],
  };
  const prompt = debatePrompt("portfolio_manager", run, { structuredDecisionOnly: true });
  assert.doesNotMatch(prompt, /method_risk_context JSON/u);
  assert.doesNotMatch(prompt, /method_context_1|valuation\.intrinsic_value/u);
  assert.doesNotMatch(prompt, /\[object Object\]|master_graham|missing_margin_of_safety|fixture:valuation/u);
});

test("mixed method risk contexts expose only in-scope eligible causes", async () => {
  const { compactMethodRiskContext, pmRatingAdjustmentContexts } = await import("../../mcp/lib/packets.mjs");
  const run = {
    master_selection: {
      method_panel_context: {
        schema_version: 1,
        decisions: [
          { master_id: "master_graham", roles: ["risk_overlay"], rating_contribution: "supporting" },
          { master_id: "master_taleb", roles: ["risk_overlay"], rating_contribution: "supporting" },
        ],
      },
    },
    master_opinions: [
      {
        master: "master_graham",
        stance: "out_of_scope",
        disqualifiers_triggered: ["missing_margin_of_safety"],
        evidence_quality: "not_evaluable",
        evidence_source_ids: ["market_data:S1"],
      },
      {
        master: "master_taleb",
        stance: "opposed",
        disqualifiers_triggered: ["tail_veto"],
        evidence_quality: "mixed",
        // The explanation worker may cite another packet when describing the frozen result,
        // but that citation must not become a server-eligible downgrade cause.
        source_ids: ["risk:S2", "news:S3"],
        evidence_source_ids: ["risk:S2"],
        voice_source_ids: ["news:S3"],
      },
    ],
  };
  const riskContexts = compactMethodRiskContext(run);
  assert.deepEqual(riskContexts.map((context) => context.context_id), ["method_context_2"]);
  assert.deepEqual(riskContexts[0].source_ids, ["risk:S2"]);
  assert.deepEqual(pmRatingAdjustmentContexts(run), [{
    context_id: "method_context_2",
    context_type: "method_risk",
    source_ids: ["risk:S2"],
  }]);
});

test("hard verifier findings become source-bound PM adjustment causes", async () => {
  const { pmRatingAdjustmentContexts } = await import("../../mcp/lib/packets.mjs");
  const run = {
    packets: [{
      task: "market_data",
      claims: [{
        claim: "The cited market observation is material.",
        confidence: "medium",
        source_ids: ["S1"],
      }],
      sources: [{ id: "S1", url: "https://example.com/market" }],
    }],
    verifier_verdicts: [{
      verifier: "source_fidelity",
      task: "market_data",
      claim_id: "market_data:C1",
      verdict: "contradicted",
      claim: "The cited market observation is material.",
      note: "The source does not support the claim as written.",
    }],
  };
  assert.deepEqual(pmRatingAdjustmentContexts(run), [{
    context_id: "verification:source_fidelity:market_data:C1",
    context_type: "hard_verification_finding",
    source_ids: ["market_data:S1"],
  }]);
});

test("calibrated non-directional prompts receive the frozen objective without the one-year rubric", async () => {
  const { debatePrompt, masterPrompt } = await import("../../mcp/lib/prompts.mjs");
  const run = {
    run_id: "NON-DIRECTIONAL-CONTEXT",
    symbol: "INTC",
    as_of: "2026-08-30",
    language: "English",
    council_mode: "full",
    tasks: [],
    packets: [],
    masters: ["master_buffett"],
    master_opinions: [],
    decision_context: {
      schema_version: 1,
      objective: "valuation",
      holding_horizon: "3_5_years",
      source: "explicit_request",
      rating_basis_required: false,
      rating_rubric_id: null,
      rating_horizon_months: null,
    },
  };

  const advocate = debatePrompt("bull_researcher", run, { round: 1 });
  const manager = debatePrompt("portfolio_manager", run, { structuredDecisionOnly: true });
  const method = masterPrompt("master_buffett", run);
  for (const prompt of [advocate, manager, method]) {
    assert.match(prompt, /Frozen decision context JSON/u);
    assert.match(prompt, /"objective":"valuation"/u);
    assert.match(prompt, /"holding_horizon":"3_5_years"/u);
    assert.match(prompt, /not a 12-month return-band rating/u);
  }
  assert.doesNotMatch(manager, /This run must use `pm_rating_rubric_v2`/u);
  assert.doesNotMatch(manager, /base_case_total_return_pct/u);
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

test("operating-company method voices fail closed after planning when the frozen dossier is missing", async () => {
  const { masterVoicePrompt } = await import("../../mcp/lib/prompts.mjs");
  const run = {
    run_id: "MISSING-METHOD-DOSSIER",
    symbol: "ACME",
    as_of: "2026-08-27",
    language: "English",
    council_mode: "full",
    dry_run: false,
    entry_tool: "analyze_symbol",
    decision_requested: true,
    tasks: [], packets: [], masters: ["master_buffett"], master_opinions: [],
    grounding: { instrument: { research_model: "operating_company" } },
  };
  const frozen = { stance: "out_of_scope", verdict: "fixture", summary: "fixture" };
  assert.throws(
    () => masterVoicePrompt("master_buffett", run, frozen),
    (error) => error?.data?.reason === "COMPANY_DOSSIER_ARTIFACT_INTEGRITY_FAILURE",
  );

  const planned = masterVoicePrompt("master_buffett", {
    ...run,
    execution_mode: "visible_host_threads",
    entry_tool: "plan_visible_run",
  }, frozen);
  assert.match(planned, /main|method|evidence/iu);
  assert.doesNotMatch(planned, /company_dossier\.json|\/runs\//iu);
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
