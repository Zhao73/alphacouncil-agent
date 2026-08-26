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
  assert.equal(recommendation.included_master_ids.length, 8);

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
