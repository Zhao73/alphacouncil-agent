import { test } from "node:test";
import assert from "node:assert/strict";

import { parseOwnershipDocument } from "../../mcp/lib/insider-ownership.mjs";

/** A Form 4 with two non-derivative transactions and one derivative holding. */
function form4({ ownerCik = "0001780525", derivativeShares = "9000000" } = {}) {
  return `<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <periodOfReport>2026-06-15</periodOfReport>
  <issuer><issuerCik>0000320193</issuerCik><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>${ownerCik}</rptOwnerCik><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>120000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>95500</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>${derivativeShares}</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>`;
}

test("the holding kept is the one after the last non-derivative transaction", () => {
  const parsed = parseOwnershipDocument(form4());
  assert.equal(parsed.shares_owned, 95500);
  assert.equal(parsed.owner_cik, "0001780525");
  assert.equal(parsed.owner_name, "DOE JANE");
  assert.equal(parsed.is_officer, true);
  assert.equal(parsed.is_director, false);
  assert.equal(parsed.is_ten_percent_owner, false);
});

test("an unexercised option is not stock and never reaches the register", () => {
  // The derivative block is deliberately far larger than the real holding: if it leaked in,
  // the sum would be off by two orders of magnitude rather than by a rounding error.
  const parsed = parseOwnershipDocument(form4({ derivativeShares: "9000000" }));
  assert.equal(parsed.shares_owned, 95500);
  assert.notEqual(parsed.shares_owned, 9_000_000);
});

test("the rendered HTML view is refused rather than half-parsed", () => {
  const rendered = "<!DOCTYPE html><html><head><title>SEC FORM 4</title></head><body>95,500</body></html>";
  assert.equal(parseOwnershipDocument(rendered), null);
});

test("a document with an owner but no reported holding produces nothing", () => {
  const noHolding = form4().replace(/<nonDerivativeTable>[\s\S]*?<\/nonDerivativeTable>/u, "");
  assert.equal(parseOwnershipDocument(noHolding), null);
});

test("non-string and empty input never throw", () => {
  for (const input of [null, undefined, 42, "", "<ownershipDocument>"]) {
    assert.equal(parseOwnershipDocument(input), null);
  }
});
