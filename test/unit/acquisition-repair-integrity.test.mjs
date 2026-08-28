import { test } from "node:test";
import assert from "node:assert/strict";

import { assertAcquisitionRepairAttemptSubset } from "../../mcp/lib/orchestrator.mjs";

function packet(attempts) {
  return {
    acquisition_ledger: {
      items: [{ coverage_id: "quant.short_interest_borrow", attempts }],
    },
  };
}

const observedAttempt = Object.freeze({
  stage: "market_official",
  locator_type: "url",
  locator: "https://example.com/observed",
  result: "not_disclosed",
  source_ids: ["S1"],
});

test("no-search acquisition repair may retain or reorder only primary attempts", () => {
  const otherObservedAttempt = {
    stage: "public_market_data",
    locator_type: "query",
    locator: "bounded observed query",
    result: "succeeded",
    source_ids: ["S2"],
  };
  assert.doesNotThrow(() => assertAcquisitionRepairAttemptSubset(
    packet([observedAttempt, otherObservedAttempt]),
    packet([otherObservedAttempt, observedAttempt]),
  ));
});

test("no-search acquisition repair rejects a new locator or terminal result", () => {
  assert.throws(
    () => assertAcquisitionRepairAttemptSubset(
      packet([observedAttempt]),
      packet([{ ...observedAttempt, result: "succeeded" }]),
    ),
    (error) => error?.data?.reason === "WORKER_SOURCE_ACQUISITION_REPAIR_ADDED_ATTEMPT",
  );
  assert.throws(
    () => assertAcquisitionRepairAttemptSubset(
      packet([observedAttempt]),
      packet([{ ...observedAttempt, locator: "https://example.com/unobserved" }]),
    ),
    (error) => error?.data?.reason === "WORKER_SOURCE_ACQUISITION_REPAIR_ADDED_ATTEMPT",
  );
});

test("no-search acquisition repair rejects attempts when the primary packet had none", () => {
  assert.throws(
    () => assertAcquisitionRepairAttemptSubset(undefined, packet([observedAttempt])),
    (error) => error?.data?.reason === "WORKER_SOURCE_ACQUISITION_REPAIR_ADDED_ATTEMPT",
  );
});
