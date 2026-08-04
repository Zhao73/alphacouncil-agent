import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_IV_PERCENTILE_OBSERVATIONS,
  optionObservationFile,
  recordOptionObservation,
} from "../../mcp/lib/option-observations.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";

test("the local CBOE ledger bootstraps an IV percentile without an API key", (t) => {
  const dataDir = makeDataDir();
  t.after(() => removeDataDir(dataDir));
  let result;
  for (let index = 0; index < MIN_IV_PERCENTILE_OBSERVATIONS; index += 1) {
    result = recordOptionObservation({
      symbol: "ACME",
      observedAt: new Date(Date.UTC(2026, 0, index + 1, 20)).toISOString(),
      atmIv: 0.2 + (index * 0.001),
      expiry: "2026-12-18",
      dte: 180,
      sourceUrl: "https://cdn.cboe.com/example.json",
      dataDir,
    });
  }
  assert.equal(result.status, "available");
  assert.equal(result.observation_count, MIN_IV_PERCENTILE_OBSERVATIONS);
  assert.ok(result.percentile > 99);
  assert.equal(result.observations_needed, 0);

  const replay = recordOptionObservation({
    symbol: "ACME",
    observedAt: new Date(Date.UTC(2026, 0, MIN_IV_PERCENTILE_OBSERVATIONS, 21)).toISOString(),
    atmIv: 0.1,
    expiry: "2026-12-18",
    dte: 179,
    sourceUrl: "https://cdn.cboe.com/example.json",
    dataDir,
  });
  assert.equal(replay.observation_count, MIN_IV_PERCENTILE_OBSERVATIONS, "same-day refresh replaces rather than duplicates");
  assert.ok(replay.percentile < 2);
});

test("option observation paths reject traversal-like symbols", () => {
  assert.throws(() => optionObservationFile("../ACME", "/tmp/alphacouncil-option-test"), /unsafe option symbol/u);
});
