import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { summarizeChain } from "../../mcp/lib/options.mjs";
import { factsFromRun } from "../../mcp/lib/personas-v2/bridge.mjs";
import { loadPacks } from "../../mcp/lib/personas-v2/loader.mjs";
import { decide } from "../../mcp/lib/personas-v2/policy.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const taleb = loadPacks().get("master_taleb");

test("the synthetic chain calculator and the method bridge share one field contract", () => {
  const payload = fixture("options-chain-synthetic.json");
  const summary = summarizeChain(payload, { asOf: "2026-07-26" });
  const facts = factsFromRun({
    symbol: "XYZ",
    as_of: "2026-07-26",
    grounding: { options: { symbol: "XYZ", available: true, ...summary } },
  });

  assert.equal(facts.options.chain_available, true);
  assert.equal(facts.options.atm_iv, 0.45);
  assert.equal(facts.options.skew_25d_points, 25, "decimal IV difference becomes volatility points once");
  assert.equal(facts.options.realized_minus_implied_vol_points, undefined);
  assert.equal(facts.options.net_edge_vol_points, undefined);
  assert.equal(facts.options.expiry_covers_next_event, undefined);

  const decision = decide(taleb, facts);
  assert.equal(decision.eligibility.eligible, true);
  assert.equal(decision.reason, "insufficient_coverage");
  assert.equal(decision.narratable, false);
  assert.deepEqual(decision.score.uncomputable.map((entry) => entry.id).sort(), [
    "edge_survives_friction",
    "event_covered",
    "implied_below_realized",
  ]);
});

test("the frozen production-shaped NOK grounding maps real fields and declines explainably", () => {
  const grounding = fixture("nok-grounding-production-shape.json");
  const facts = factsFromRun({ symbol: "NOK", as_of: grounding.as_of, grounding });

  assert.equal(facts.options.chain_available, true);
  assert.equal(facts.options.atm_iv, 0.6878);
  assert.equal(facts.options.skew_25d_points, 0.33);
  assert.equal(facts.options.realized_minus_implied_vol_points, undefined);
  assert.equal(facts.options.net_edge_vol_points, undefined);
  assert.equal(facts.options.expiry_covers_next_event, undefined);

  const decision = decide(taleb, facts);
  assert.equal(decision.eligibility.eligible, true);
  assert.equal(decision.reason, "insufficient_coverage");
  assert.equal(decision.narratable, false);
  assert.equal(decision.score.coverage, 0.2, "only the observed skew rule is computable");
});

test("derived option facts pass through only when an explicit upstream calculator supplies them", () => {
  const grounding = fixture("nok-grounding-production-shape.json");
  grounding.options = {
    ...grounding.options,
    realized_minus_implied_vol_points: 8,
    net_edge_vol_points: 2,
    expiry_covers_next_event: false,
  };
  const facts = factsFromRun({ symbol: "NOK", as_of: grounding.as_of, grounding });

  assert.equal(facts.options.realized_minus_implied_vol_points, 8);
  assert.equal(facts.options.net_edge_vol_points, 2);
  assert.equal(facts.options.expiry_covers_next_event, false);
  const decision = decide(taleb, facts);
  assert.equal(decision.score.coverage, 1);
  assert.equal(decision.narratable, true);
});
