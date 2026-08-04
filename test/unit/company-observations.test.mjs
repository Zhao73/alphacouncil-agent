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

test("company observation paths reject traversal-like symbols", () => {
  assert.throws(() => companyObservationFile("../GOOGL", "/tmp/company-observations"), /unsafe company symbol/u);
});
