import { test } from "node:test";
import assert from "node:assert/strict";

import { dominantIndustry, industryMix } from "../../mcp/lib/basket-news.mjs";

/**
 * The industry is derived from holdings rather than from a maintained table, so that it cannot
 * drift the first time an index rebalances. What it must not do is answer by headcount.
 */
test("the industry is the weight leader, not the member-count leader", () => {
  const holdings = [
    { ticker: "CHIP1", weight: 0.30 },
    { ticker: "CHIP2", weight: 0.25 },
    { ticker: "BIO1", weight: 0.05 },
    { ticker: "BIO2", weight: 0.05 },
    { ticker: "BIO3", weight: 0.05 },
  ];
  const sic = new Map([
    ["CHIP1", "3674"], ["CHIP2", "3674"],
    ["BIO1", "2836"], ["BIO2", "2836"], ["BIO3", "2836"],
  ]);
  const industry = dominantIndustry(sic, holdings);
  // Three biotech names outnumber two semiconductor names; 55% of the weight is semiconductors.
  assert.equal(industry.id, "semiconductors");
  assert.equal(industry.members, 2);
  assert.equal(industry.is_concentrated, true);
});

test("a basket with no dominant industry says so rather than picking one", () => {
  const holdings = [{ ticker: "A", weight: 0.2 }, { ticker: "B", weight: 0.2 }];
  const industry = dominantIndustry(new Map([["A", "3674"], ["B", "2836"]]), holdings);
  // Both groups are real; neither clears half, and the share is reported so the caller judges.
  assert.equal(industry.is_concentrated, false);
  assert.ok(industry.weight <= 0.5);
});

test("holdings with no resolvable registrant contribute nothing rather than a default", () => {
  assert.equal(dominantIndustry(new Map(), [{ ticker: "X", weight: 1 }]), null);
  assert.equal(dominantIndustry(new Map([["X", "3674"]]), [{ ticker: "X", weight: null }]), null);
  assert.equal(dominantIndustry(null, null), null);
});

test("a basket with no dominant industry is queried as the several industries it is", () => {
  // A broad industrial fund whose largest group is 11% is not an electronics fund. Naming it
  // one would query the wrong news and state it with more confidence than the holdings carry.
  const holdings = [
    { ticker: "E1", weight: 0.11 }, { ticker: "A1", weight: 0.08 },
    { ticker: "M1", weight: 0.07 }, { ticker: "T1", weight: 0.06 },
  ];
  const sic = new Map([["E1", "3600"], ["A1", "3721"], ["M1", "3500"], ["T1", "4200"]]);
  const mix = industryMix(sic, holdings);
  assert.deepEqual(mix.map((group) => group.id), ["electronics", "aerospace_defense", "machinery"]);
  assert.ok(mix.every((group) => group.is_concentrated === false));
  assert.equal(dominantIndustry(sic, holdings).id, "electronics", "the leader is still the leader");
});

test("a concentrated basket is queried as one industry, not padded out to three", () => {
  const holdings = [{ ticker: "C1", weight: 0.55 }, { ticker: "S1", weight: 0.10 }];
  const mix = industryMix(new Map([["C1", "3674"], ["S1", "7372"]]), holdings);
  assert.equal(mix.length, 1, "one group already covers the basket");
  assert.equal(mix[0].is_concentrated, true);
});

test("every SIC a US registrant can file resolves to a group", async () => {
  const { sicGroupFor } = await import("../../mcp/lib/industry.mjs");
  // 1800-1999, 2680-2699 and 6800-6999 are unassigned in the SIC scheme itself.
  const unassigned = (sic) => (sic >= 1800 && sic <= 1999) || (sic >= 2680 && sic <= 2699) || (sic >= 6800 && sic <= 6999);
  const missing = [];
  for (let sic = 100; sic <= 8999; sic += 1) {
    if (unassigned(sic)) continue;
    if (!sicGroupFor(String(sic).padStart(4, "0"))) missing.push(sic);
  }
  assert.deepEqual(missing, [], "an unresolvable SIC means a basket holding it gets no industry news");
});
