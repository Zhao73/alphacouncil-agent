import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SETTLEMENT_HEADROOM_MS,
  observerBudget,
} from "../helpers/rpc-client.mjs";

test("RPC observer budgets add one frozen settlement allowance to a positive contract ceiling", () => {
  assert.equal(SETTLEMENT_HEADROOM_MS, 15_000);
  assert.equal(observerBudget(30_000), 45_000);
  assert.equal(observerBudget(30_000), 30_000 + SETTLEMENT_HEADROOM_MS);

  for (const value of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => observerBudget(value),
      {
        name: "TypeError",
        message: `observerBudget requires a positive integer contract ceiling, got ${String(value)}`,
      },
    );
  }
});
