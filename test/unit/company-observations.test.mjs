import { test } from "node:test";
import assert from "node:assert/strict";

import {
  companyObservationFile,
  companyObservationHistory,
  recordCompanyAcquisitionObservations,
} from "../../mcp/lib/company-observations.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";

function ledger(value, period = "FY2027") {
  return {
    policy_id: "company_source_acquisition_v1",
    task: "forward_expectations",
    items: [{
      coverage_id: "expectations.consensus_revenue_eps",
      outcome: "reported_actual",
      source_ids: ["forward_expectations:S1"],
      attempts: [],
      data: { value, unit: "USD bn", period, scope: "public estimate sample" },
    }],
  };
}

test("the generic observation ledger builds like-for-like 90-day revisions", (t) => {
  const dataDir = makeDataDir();
  t.after(() => removeDataDir(dataDir));
  recordCompanyAcquisitionObservations({
    symbol: "GOOGL", observedAt: "2026-01-01T20:00:00Z", task: "forward_expectations",
    ledger: ledger(400), dataDir,
  });
  recordCompanyAcquisitionObservations({
    symbol: "GOOGL", observedAt: "2026-04-05T20:00:00Z", task: "forward_expectations",
    ledger: ledger(430), dataDir,
  });
  recordCompanyAcquisitionObservations({
    symbol: "GOOGL", observedAt: "2026-04-05T21:00:00Z", task: "forward_expectations",
    ledger: ledger(500, "FY2028"), dataDir,
  });
  const history = companyObservationHistory("GOOGL", { asOf: "2026-04-05", dataDir });
  const fy27 = history.series.find((row) => row.period === "FY2027");
  const fy28 = history.series.find((row) => row.period === "FY2028");
  assert.equal(fy27.change_90d_status, "available");
  assert.equal(fy27.change_90d, 30);
  assert.equal(fy28.change_90d_status, "building_history");
  assert.equal(history.observation_count, 3);
});

test("one reported coverage item records multiple normalized observations without collision", (t) => {
  const dataDir = makeDataDir();
  t.after(() => removeDataDir(dataDir));
  const result = recordCompanyAcquisitionObservations({
    symbol: "VSH",
    observedAt: "2026-08-05T20:00:00Z",
    task: "earnings_deep_dive",
    dataDir,
    ledger: {
      policy_id: "company_source_acquisition_v1",
      task: "earnings_deep_dive",
      items: [{
        coverage_id: "financials.customer_supplier_concentration",
        outcome: "reported_actual",
        source_ids: ["earnings_deep_dive:S1"],
        attempts: [],
        data: {
          observations: [
            { metric: "top_30_customer_revenue_share_pct", value: 74, unit: "%", period: "FY2025", scope: "customer concentration" },
            { metric: "largest_single_customer_share", value: "below 10%", unit: "%", period: "FY2025", scope: "customer concentration" },
          ],
        },
      }],
    },
  });
  assert.equal(result.recorded, 2);
  const history = companyObservationHistory("VSH", { asOf: "2026-08-05", dataDir });
  assert.equal(history.observation_count, 2);
  assert.deepEqual(history.series.map((row) => row.metric).sort(), [
    "largest_single_customer_share",
    "top_30_customer_revenue_share_pct",
  ]);
});

test("derived observation rows inherit the parent formula and remain separately queryable", (t) => {
  const dataDir = makeDataDir();
  t.after(() => removeDataDir(dataDir));
  const result = recordCompanyAcquisitionObservations({
    symbol: "VSH",
    observedAt: "2026-08-05T21:00:00Z",
    task: "quant_factor",
    dataDir,
    ledger: {
      policy_id: "company_source_acquisition_v1",
      task: "quant_factor",
      items: [{
        coverage_id: "quant.options_iv_skew_expected_move",
        outcome: "recomputed_proxy",
        source_ids: ["quant_factor:S1"],
        attempts: [],
        data: {
          formula: "recompute each metric from the dated option snapshot",
          inputs: [{ name: "option_snapshot", source_ids: ["quant_factor:S1"] }],
          observations: [
            { metric: "expected_move", value: 4.2, unit: "%", period: "2026-08-21 expiry", scope: "ATM straddle" },
            { metric: "put_call_skew", value: 1.1, unit: "ratio", period: "2026-08-21 expiry", scope: "25 delta" },
          ],
        },
      }],
    },
  });
  assert.equal(result.recorded, 2);
  const history = companyObservationHistory("VSH", { asOf: "2026-08-05", dataDir });
  assert.equal(history.observation_count, 2);
  assert.ok(history.series.every((row) => row.outcome === "recomputed_proxy"));
  assert.ok(history.series.every((row) => row.latest.formula === "recompute each metric from the dated option snapshot"));
});

test("company observation paths reject traversal-like symbols", () => {
  assert.throws(() => companyObservationFile("../GOOGL", "/tmp/company-observations"), /unsafe company symbol/u);
});
