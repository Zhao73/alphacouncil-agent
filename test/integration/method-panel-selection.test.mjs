import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";

const instrumentClassification = {
  asset_type: "equity",
  research_model: "operating_company",
  classification_source: "selection_contract_fixture",
};
const typedFactCoverage = [
  "market.price",
  "capital_allocation.share_count",
  "financial.owner_earnings",
  "financial.free_cash_flow_5y",
  "accounting.cash_conversion",
  "financial.leverage",
  "valuation.revenue_growth",
  "macro.credit_spread",
];

let dataDir;
let server;

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });
  await server.request("initialize", {});
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

async function open(symbol, councilMode = "full") {
  return structured(await server.callTool("begin_council_selection", {
    symbol,
    language: "en-US",
    host: "codex",
    council_mode: councilMode,
    instrument_classification: instrumentClassification,
    typed_fact_coverage: typedFactCoverage,
  }));
}

async function confirm(opened, choice, extra = {}) {
  return server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    recommendation_hash: opened.method_panel_recommendation.recommendation_hash,
    ...(opened.decision_context_hash ? { decision_context_hash: opened.decision_context_hash } : {}),
    display_ack: true,
    ...choice,
    ...(opened.council_mode === "quick" ? {} : { analyst_scope: "core" }),
    ...extra,
  });
}

test("the recommendation is a displayed prefill only and excluded methods remain selectable", async () => {
  const opened = await open("AAPL");
  const recommendation = opened.method_panel_recommendation;
  assert.equal(opened.status, "awaiting_user_selection");
  assert.equal(opened.masters.length, 26);
  assert.deepEqual(opened.preselected_master_ids, [], "a recommendation must not silently become consent");
  assert.equal(recommendation.status, "recommended");
  assert.equal(recommendation.decisions.length, 26);
  assert.ok(recommendation.included_master_ids.length > 0);
  assert.ok(recommendation.included_master_ids.length <= 8);
  assert.ok(recommendation.decisions
    .filter((decision) => decision.decision === "include")
    .every((decision) => decision.missing_facts.length === 0));

  const excluded = recommendation.decisions.find((decision) => decision.decision === "exclude")?.master_id;
  assert.ok(excluded);
  const confirmed = structured(await confirm(opened, { selected_master_ids: [excluded] }));
  assert.deepEqual(confirmed.selected_master_ids, [excluded]);
  assert.equal(confirmed.recommendation_hash, recommendation.recommendation_hash);
  assert.equal(confirmed.selection_hash_version, 4);
});

test("a stale recommendation hash is rejected and select_all still means the physical 26-seat catalog", async () => {
  const stale = await open("MSFT");
  const missing = await server.callTool("confirm_master_selection", {
    selection_id: stale.selection_id,
    catalog_hash: stale.catalog_hash,
    display_ack: true,
    selected_master_ids: [stale.masters[0].id],
    analyst_scope: "core",
  });
  assert.equal(missing.error?.data?.reason, "METHOD_PANEL_RECOMMENDATION_REQUIRED");

  const rejected = await confirm(stale, { selected_master_ids: [stale.masters[0].id] }, {
    recommendation_hash: `sha256:${"0".repeat(64)}`,
  });
  assert.equal(rejected.error?.data?.reason, "METHOD_PANEL_RECOMMENDATION_MISMATCH");

  const opened = await open("MSFT");
  const all = structured(await confirm(opened, { select_all: true }));
  assert.equal(all.selected_count, 26);
  assert.deepEqual(all.selected_master_ids, opened.masters.map((master) => master.id));
  assert.equal(all.recommendation_hash, opened.method_panel_recommendation.recommendation_hash);
});

test("quick keeps the full catalog and permits one through four explicit seats, including exclusions", async () => {
  const opened = await open("PANELQ", "quick");
  assert.equal(opened.masters.length, 26);
  assert.equal(opened.maximum, 4);
  assert.deepEqual(opened.preselected_master_ids, []);
  const excluded = opened.method_panel_recommendation.decisions
    .filter((decision) => decision.decision === "exclude")
    .slice(0, 4)
    .map((decision) => decision.master_id);
  assert.equal(excluded.length, 4);
  const confirmed = structured(await confirm(opened, { selected_master_ids: excluded }));
  assert.deepEqual(confirmed.selected_master_ids, opened.masters
    .map((master) => master.id).filter((masterId) => excluded.includes(masterId)));
  assert.equal(confirmed.selected_count, 4);
});

test("without a classification the gate remains open but produces no guessed recommendation", async () => {
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol: "UNKNOWN",
    language: "en-US",
    host: "codex",
    typed_fact_coverage: typedFactCoverage,
  }));
  assert.equal(opened.status, "awaiting_user_selection");
  assert.equal(opened.method_panel_recommendation.status, "not_evaluable");
  assert.deepEqual(opened.method_panel_recommendation.included_master_ids, []);
  assert.equal(opened.method_panel_recommendation.recommendation_hash, null);
  assert.equal(opened.method_panel_recommendation.decisions.length, 26);

  const confirmed = structured(await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    display_ack: true,
    selected_master_ids: [opened.masters[0].id],
    analyst_scope: "core",
  }));
  assert.equal(confirmed.status, "confirmed");
  assert.equal(confirmed.selection_hash_version, 3);
  assert.equal(confirmed.recommendation_hash, null);
});

test("an empty advisory panel names every unfilled family and never renders a blank panel sentence", async () => {
  const response = await server.callTool("begin_council_selection", {
    symbol: "SPARSE",
    language: "en-US",
    host: "codex",
    council_mode: "full",
    instrument_classification: instrumentClassification,
    typed_fact_coverage: ["market.price"],
  });
  const opened = structured(response);
  const text = response.result?.content?.map((item) => item.text || "").join("\n") || "";

  assert.deepEqual(opened.method_panel_recommendation.included_master_ids, []);
  assert.equal(opened.method_panel_recommendation.family_assignments.length, 8);
  assert.equal(opened.method_panel_recommendation.unfilled_families.length, 8);
  assert.match(text, /Unfilled method families:/u);
  for (const family of opened.method_panel_recommendation.unfilled_families) assert.match(text, new RegExp(family, "u"));
  assert.doesNotMatch(text, /Advisory method-simulation panel:\s*\./u);

  const confirmedResponse = await confirm(opened, {
    selected_master_ids: [opened.masters[0].id],
  });
  const confirmed = structured(confirmedResponse);
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual(confirmed.selected_master_ids, [opened.masters[0].id]);
  assert.equal(confirmed.recommendation_hash, opened.method_panel_recommendation.recommendation_hash);
});

test("an unambiguous one-year buy request binds calibrated roles and the PM rubric through consumption", async () => {
  const prompt = "Is MSFT worth buying for a one-year holding period?";
  const response = await server.callTool("begin_council_selection", {
    symbol: "MSFT",
    prompt,
    language: "en-US",
    host: "codex",
    instrument_classification: instrumentClassification,
    typed_fact_coverage: typedFactCoverage,
  });
  const opened = structured(response);
  const text = response.result?.content?.map((item) => item.text || "").join("\n") || "";

  assert.equal(opened.selection_hash_version, 5);
  assert.equal(opened.method_panel_recommendation.schema_version, 3);
  assert.deepEqual(opened.decision_context, {
    schema_version: 1,
    objective: "directional_rating",
    holding_horizon: "1_year",
    source: "prompt_inference",
    rating_basis_required: true,
    rating_rubric_id: "pm_rating_rubric_v2",
    rating_horizon_months: 12,
  });
  assert.match(opened.decision_context_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(text, /Risk\/context methods are not directional votes/u);
  const textOnlyContextMatch = text.match(/ALPHACOUNCIL_SELECTION_CONTEXT (\{[^\n]+\})/u);
  assert.ok(textOnlyContextMatch, "text-only hosts must receive the calibrated context before confirmation");
  const textOnlyContext = JSON.parse(textOnlyContextMatch[1]);
  assert.equal(textOnlyContext.method_panel_decisions.length, 26);
  assert.deepEqual(textOnlyContext.method_panel_decisions, opened.method_panel_recommendation.decisions.map((decision) => ({
    master_id: decision.master_id,
    decision: decision.decision,
    roles: decision.roles,
    objective_fit: decision.objective_fit,
    horizon_fit: decision.horizon_fit,
    rating_contribution: decision.rating_contribution,
  })));
  const firstDecision = textOnlyContext.method_panel_decisions.find((decision) => (
    decision.master_id === opened.masters[0].id
  ));
  assert.match(text, new RegExp(`Calibrated contribution: ${firstDecision.rating_contribution}; roles=`, "u"));

  const missingContextAck = await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    recommendation_hash: opened.recommendation_hash,
    display_ack: true,
    selected_master_ids: [opened.masters[0].id],
    analyst_scope: "core",
  });
  assert.equal(missingContextAck.error?.data?.reason, "METHOD_PANEL_DECISION_CONTEXT_REQUIRED");

  const confirmedResponse = await confirm(opened, {
    selected_master_ids: [opened.masters[0].id],
  });
  const confirmed = structured(confirmedResponse);
  assert.equal(confirmed.selection_hash_version, 5);
  assert.equal(confirmed.method_panel_context.decisions.length, 1);
  assert.deepEqual(confirmed.method_panel_context.directional_rating_master_ids, []);
  assert.deepEqual(confirmed.method_panel_context.risk_coverage_master_ids, []);
  assert.deepEqual(confirmed.method_panel_context.context_only_master_ids, [opened.masters[0].id]);
  assert.equal(confirmed.method_panel_context.directional_rating_evaluable, false);
  const confirmedText = confirmedResponse.result?.content?.map((item) => item.text || "").join("\n") || "";
  const confirmationContextMatch = confirmedText.match(/ALPHACOUNCIL_CONFIRMATION_CONTEXT (\{[^\n]+\})/u);
  assert.ok(confirmationContextMatch, "text-only confirmation must echo the selected contribution context");
  assert.deepEqual(JSON.parse(confirmationContextMatch[1]).method_panel_context, confirmed.method_panel_context);

  const analysis = structured(await server.callTool("analyze_symbol", {
    symbol: "MSFT",
    prompt,
    language: "en-US",
    council_mode: "full",
    dry_run: true,
    tasks: ["market_data"],
    selection_receipt: confirmed.selection_receipt,
  }));
  assert.equal(analysis.run.decision_context.rating_basis_required, true);
  assert.equal(analysis.run.master_selection.method_panel_context.decisions.length, 1);
  assert.equal(
    analysis.run.master_selection.decision_context_hash,
    opened.decision_context_hash,
  );
});

test("calibrated missing-classification context remains bound even with no recommendation hash", async () => {
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol: "NBIS",
    prompt: "看看 NBIS 值得买吗，一年持有",
    language: "zh-CN",
    host: "codex",
  }));
  assert.equal(opened.selection_hash_version, 5);
  assert.equal(opened.method_panel_recommendation.schema_version, 3);
  assert.equal(opened.method_panel_recommendation.status, "not_evaluable");
  assert.equal(opened.recommendation_hash, null);
  assert.equal(opened.decision_context.rating_basis_required, true);

  const confirmed = structured(await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    decision_context_hash: opened.decision_context_hash,
    display_ack: true,
    selected_master_ids: [opened.masters[0].id],
    analyst_scope: "core",
  }));
  assert.equal(confirmed.selection_hash_version, 5);
  assert.equal(confirmed.recommendation_hash, null);
  assert.equal(confirmed.decision_context_hash, opened.decision_context_hash);
});

test("one-year directional prompt inference is multilingual and rejects rating-history negation", async () => {
  const positive = [
    "看看 QCOM 值得买吗？我准备持有一年以内。",
    "Is QCOM worth buying for a one-year holding period?",
    "QCOM は買う価値がありますか。1年間保有します。",
    "QCOM을 1년 보유할 때 매수할 가치가 있나요?",
  ];
  for (const [index, prompt] of positive.entries()) {
    const opened = structured(await server.callTool("begin_council_selection", {
      symbol: "QCOM",
      prompt,
      language: "auto",
      host: `inference-positive-${index}`,
    }));
    assert.equal(opened.decision_context?.objective, "directional_rating", prompt);
    assert.equal(opened.decision_context?.holding_horizon, "1_year", prompt);
    assert.equal(opened.decision_context?.source, "prompt_inference", prompt);
  }

  const negative = [
    "总结 RKLB 一年期信用评级变化，不要给买卖建议。",
    "Summarize one-year credit-rating changes; do not give a buy or sell recommendation.",
    "1年間の信用格付け変化を要約し、売買判断はしないでください。",
    "RKLB의 1년 신용등급 변화를 요약하고 매수 의견은 제외해 주세요.",
  ];
  for (const [index, prompt] of negative.entries()) {
    const opened = structured(await server.callTool("begin_council_selection", {
      symbol: "RKLB",
      prompt,
      language: "auto",
      host: `inference-negative-${index}`,
    }));
    assert.equal(opened.decision_context, null, prompt);
    assert.equal(opened.decision_context_hash, null, prompt);
  }
});

test("selection rejects calibrated objective-horizon pairs without a defined PM output contract", async () => {
  const response = await server.callTool("begin_council_selection", {
    symbol: "ORCL",
    prompt: "Value ORCL over three to five years.",
    language: "en-US",
    host: "unsupported-context",
    objective: "valuation",
    holding_horizon: "3_5_years",
  });
  assert.equal(response.error?.data?.reason, "METHOD_PANEL_DECISION_CONTEXT_UNSUPPORTED");
  assert.deepEqual(response.error?.data?.supported_pairs, [{
    objective: "directional_rating",
    holding_horizon: "1_year",
  }]);
});
