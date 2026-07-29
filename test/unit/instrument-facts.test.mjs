import { test } from "node:test";
import assert from "node:assert/strict";

import { lookThroughClaims } from "../../mcp/lib/instrument-facts.mjs";

/**
 * The arithmetic that lets a company method read a basket.
 *
 * A fund owning 1% of a company has a claim on 1% of its owner earnings. Summed across the
 * basket that is a dollar figure about the fund, and dividing it by the fund's own market
 * capitalisation -- which is its AUM -- gives the weighted look-through yield. That identity is
 * why ten seats can price a basket without a single change to their methods, so it is worth a
 * test that fails if the scaling drifts.
 */
test("a look-through claim is the fund's ownership share of the figure, in dollars", () => {
  const holdings = [
    { ticker: "AAA", weight: 0.6 },
    { ticker: "BBB", weight: 0.4 },
  ];
  const shareCounts = new Map([["AAA", 1_000], ["BBB", 500]]);
  const closes = { AAA: 100, BBB: 200 };          // caps: AAA 100k, BBB 100k
  const perHoldingFacts = new Map([
    ["AAA", { "financial.owner_earnings": 10_000 }],
    ["BBB", { "financial.owner_earnings": 5_000 }],
  ]);
  const netAssets = 50_000;
  const { facts } = lookThroughClaims({
    holdings, perHoldingFacts, shareCounts, closes, netAssets,
    holdingsMeta: { symbol: "TEST", source_url: "https://example.com/h", public_at: "2026-01-02", as_of: "2026-01-01" },
  });
  const claim = facts.find((fact) => fact.fact_id === "financial.owner_earnings");
  // 50k x (0.6/100k x 10k + 0.4/100k x 5k) = 50k x 0.08 = 4000
  assert.equal(claim.value, 4_000);
  assert.equal(claim.value_kind, "monetary");
  assert.equal(claim.currency, "USD");
  // The identity the seats depend on: claim / fund market cap == weighted look-through yield.
  assert.equal(Number((claim.value / netAssets).toFixed(6)), 0.08);
});

test("a claim refuses below the coverage floor rather than scaling up what it has", () => {
  const { facts, unavailable } = lookThroughClaims({
    holdings: [{ ticker: "AAA", weight: 0.2 }, { ticker: "BBB", weight: 0.8 }],
    perHoldingFacts: new Map([["AAA", { "financial.owner_earnings": 10_000 }]]),
    shareCounts: new Map([["AAA", 1_000], ["BBB", 500]]),
    closes: { AAA: 100, BBB: 200 },
    netAssets: 50_000,
    holdingsMeta: { symbol: "TEST" },
  });
  assert.equal(facts.find((fact) => fact.fact_id === "financial.owner_earnings"), undefined);
  assert.ok(unavailable.some((note) => /below the .* floor/u.test(note)));
});

test("no fund size means no claim, because a per-dollar share is not a dollar figure", () => {
  const { facts, unavailable } = lookThroughClaims({
    holdings: [{ ticker: "AAA", weight: 1 }],
    perHoldingFacts: new Map([["AAA", { "financial.owner_earnings": 10_000 }]]),
    shareCounts: new Map([["AAA", 1_000]]),
    closes: { AAA: 100 },
    netAssets: null,
    holdingsMeta: { symbol: "TEST" },
  });
  assert.deepEqual(facts, []);
  assert.ok(unavailable.some((note) => /fund's own size is unknown/u.test(note)));
});
