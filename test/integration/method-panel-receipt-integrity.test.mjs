import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";

const instrumentClassification = {
  asset_type: "equity",
  research_model: "operating_company",
  classification_source: "method_panel_integrity_fixture",
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
let sequence = 0;

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });
  await server.request("initialize", {});
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

async function openSelection() {
  sequence += 1;
  const prompt = `Verify the method-panel receipt integrity contract (${sequence}).`;
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol: "PANELI",
    language: "en-US",
    host: "codex",
    council_mode: "full",
    prompt,
    instrument_classification: instrumentClassification,
    typed_fact_coverage: typedFactCoverage,
  }));
  return { opened, prompt };
}

function selectionFile(selectionId) {
  return join(dataDir, "selections", `${selectionId}.json`);
}

function mutateFirstDecision(file) {
  const original = readFileSync(file, "utf8");
  const record = JSON.parse(original);
  record.method_panel_recommendation.decisions[0].reason = "tampered after display";
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return original;
}

async function confirm(opened) {
  return server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    recommendation_hash: opened.recommendation_hash,
    ...(opened.decision_context_hash ? { decision_context_hash: opened.decision_context_hash } : {}),
    display_ack: true,
    selected_master_ids: [opened.method_panel_recommendation.included_master_ids[0]],
    analyst_scope: "core",
    council_pace: "fast",
  });
}

test("confirmation recomputes all 26 advisory decisions instead of trusting the stored hash", async () => {
  const { opened } = await openSelection();
  const file = selectionFile(opened.selection_id);
  const original = mutateFirstDecision(file);

  const rejected = await confirm(opened);
  assert.equal(rejected.error?.data?.reason, "METHOD_PANEL_RECOMMENDATION_RECORD_MISMATCH");
  assert.deepEqual(rejected.error?.data?.mismatched_fields, ["method_panel_recommendation"]);

  writeFileSync(file, original);
  const accepted = structured(await confirm(opened));
  assert.equal(accepted.status, "confirmed");
  assert.equal(accepted.recommendation_hash, opened.recommendation_hash);
});

test("receipt consumption re-verifies the advisory decision vector before creating a run", async () => {
  const { opened, prompt } = await openSelection();
  const confirmed = structured(await confirm(opened));
  const file = selectionFile(opened.selection_id);
  const original = mutateFirstDecision(file);
  const rejectedRunId = `METHOD-PANEL-INTEGRITY-REJECT-${process.pid}-${sequence}`;

  const rejected = await server.callTool("plan_visible_run", {
    symbol: "PANELI",
    language: "en-US",
    prompt,
    council_mode: "full",
    run_id: rejectedRunId,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: confirmed.selection_receipt,
  });
  assert.equal(rejected.error?.data?.reason, "METHOD_PANEL_RECOMMENDATION_RECORD_MISMATCH");
  assert.equal(existsSync(join(dataDir, "runs", rejectedRunId)), false);

  writeFileSync(file, original);
  const accepted = await server.callTool("plan_visible_run", {
    symbol: "PANELI",
    language: "en-US",
    prompt,
    council_mode: "full",
    run_id: `METHOD-PANEL-INTEGRITY-VALID-${process.pid}-${sequence}`,
    tasks: ["market_data"],
    grounding: { facts_unavailable: true },
    selection_receipt: confirmed.selection_receipt,
  });
  assert.ok(accepted.result, "a failed integrity check must not consume the restored receipt");
});

test("v5 confirmation rejects a calibrated contribution-context mutation even when recommendation hash is null", async () => {
  const prompt = "看看 NBIS 值得买吗，一年持有";
  const opened = structured(await server.callTool("begin_council_selection", {
    symbol: "NBIS",
    language: "zh-CN",
    host: "codex",
    council_mode: "full",
    prompt,
  }));
  assert.equal(opened.selection_hash_version, 5);
  assert.equal(opened.recommendation_hash, null);
  const file = selectionFile(opened.selection_id);
  const original = readFileSync(file, "utf8");
  const record = JSON.parse(original);
  record.method_panel_context.decisions[0].rating_contribution = "primary";
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);

  const rejected = await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    decision_context_hash: opened.decision_context_hash,
    display_ack: true,
    selected_master_ids: [opened.masters[0].id],
    analyst_scope: "core",
  });
  assert.equal(rejected.error?.data?.reason, "METHOD_PANEL_RECOMMENDATION_RECORD_MISMATCH");
  assert.ok(rejected.error?.data?.mismatched_fields.includes("method_panel_context"));

  writeFileSync(file, original);
  const accepted = structured(await server.callTool("confirm_master_selection", {
    selection_id: opened.selection_id,
    catalog_hash: opened.catalog_hash,
    decision_context_hash: opened.decision_context_hash,
    display_ack: true,
    selected_master_ids: [opened.masters[0].id],
    analyst_scope: "core",
  }));
  assert.equal(accepted.selection_hash_version, 5);
});
