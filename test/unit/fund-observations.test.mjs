import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { flowInputs, observationFile, recordFundObservation } from "../../mcp/lib/fund-observations.mjs";

const workspace = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "acouncil-flow-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test("two dated share counts price a flow exactly, and the gap is reported", (t) => {
  const dataDir = workspace(t);
  recordFundObservation({ symbol: "SOXX", asOf: "2026-07-20", sharesOutstanding: 80_000_000, sharesBasis: "issuer_disclosed_shares_outstanding", netAssets: 24_000_000_000, dataDir });
  const { observations } = recordFundObservation({
    symbol: "SOXX", asOf: "2026-07-27", sharesOutstanding: 82_650_000, sharesBasis: "issuer_disclosed_shares_outstanding", netAssets: 25_600_000_000, dataDir,
  });
  const inputs = flowInputs(observations);
  assert.equal(inputs.sharesNow - inputs.sharesPrior, 2_650_000);
  // A flow measured across seven days is not a daily flow, and the reader has to be able to see that.
  assert.equal(inputs.gapDays, 7);
  assert.equal(Number(inputs.nav.toFixed(2)), 309.74);
});

test("one observation is not a flow, however much a reader wants one", (t) => {
  const dataDir = workspace(t);
  const { observations } = recordFundObservation({
    symbol: "SOXX", asOf: "2026-07-27", sharesOutstanding: 82_650_000, sharesBasis: "issuer_disclosed_shares_outstanding", dataDir,
  });
  assert.equal(observations.length, 1);
  assert.equal(flowInputs(observations), null);
});

test("the same trading day seen twice does not become a zero flow", (t) => {
  const dataDir = workspace(t);
  recordFundObservation({ symbol: "SOXX", asOf: "2026-07-27", sharesOutstanding: 82_650_000, sharesBasis: "issuer_disclosed_shares_outstanding", dataDir });
  const second = recordFundObservation({ symbol: "SOXX", asOf: "2026-07-27", sharesOutstanding: 82_650_000, sharesBasis: "issuer_disclosed_shares_outstanding", dataDir });
  assert.equal(second.recorded, false);
  assert.equal(second.observations.length, 1);
});

test("assets alone never produce a flow, because assets move with the market", (t) => {
  const dataDir = workspace(t);
  recordFundObservation({ symbol: "QQQ", asOf: "2026-07-20", netAssets: 300_000_000_000, dataDir });
  const { observations } = recordFundObservation({ symbol: "QQQ", asOf: "2026-07-27", netAssets: 330_000_000_000, dataDir });
  assert.equal(observations.length, 2, "the observations are still recorded");
  // A 10% rise in assets with no share count is a rally, a creation, or both. Refusing is the
  // only answer that cannot be wrong in the direction that flatters a momentum story.
  assert.equal(flowInputs(observations), null);
});

test("a symbol never becomes a path outside the ledger", () => {
  for (const unsafe of ["../etc/passwd", "a/b", "", null, "TOOLONGSYMBOLNAMEHERE"]) {
    assert.throws(() => observationFile(unsafe), /unsafe fund symbol|escaped its root/u, String(unsafe));
  }
  assert.match(observationFile("SOXX", "/tmp/x"), /\/tmp\/x\/fund-observations\/SOXX\.json$/u);
});

test("a corrupt ledger loses history rather than reporting a flow from garbage", (t) => {
  const dataDir = workspace(t);
  const file = observationFile("SOXX", dataDir);
  recordFundObservation({ symbol: "SOXX", asOf: "2026-07-20", sharesOutstanding: 80_000_000, sharesBasis: "issuer_disclosed_shares_outstanding", dataDir });
  writeFileSync(file, "{ not json", "utf8");
  const { observations } = recordFundObservation({ symbol: "SOXX", asOf: "2026-07-27", sharesOutstanding: 82_650_000, sharesBasis: "issuer_disclosed_shares_outstanding", dataDir });
  assert.equal(observations.length, 1);
  assert.equal(flowInputs(observations), null);
});

test("a reconstructed share count sizes a fund but must never be differenced into a flow", (t) => {
  const dataDir = workspace(t);
  const basis = "assets_from_disclosed_positions_over_market_price";
  recordFundObservation({ symbol: "QQQ", asOf: "2026-07-20", sharesOutstanding: 400_000_000, sharesBasis: basis, netAssets: 300_000_000_000, dataDir });
  const { observations } = recordFundObservation({
    symbol: "QQQ", asOf: "2026-07-27", sharesOutstanding: 402_000_000, sharesBasis: basis, netAssets: 310_000_000_000, dataDir,
  });
  assert.equal(observations.length, 2, "the observations are still recorded and still size the fund");
  // Differencing them would report $1.5bn of creations that are indistinguishable from the
  // error in a 95%-priced position sum and a premium-to-NAV. Refusing is the only safe answer.
  assert.equal(flowInputs(observations), null);
});

test("issuer assets over issuer NAV is a share count, not an estimate of one", (t) => {
  // Both figures come from the same issuer on the same date, so their ratio IS shares
  // outstanding. Sector SPDRs publish no share count in their holdings file and would
  // otherwise have no flow at all -- which is the case people ask about most.
  const dataDir = workspace(t);
  const basis = "issuer_aum_over_nav";
  recordFundObservation({ symbol: "XLK", asOf: "2026-07-20", sharesOutstanding: 650_000_000, sharesBasis: basis, netAssets: 112_000_000_000, nav: 172.3, dataDir });
  const { observations } = recordFundObservation({
    symbol: "XLK", asOf: "2026-07-27", sharesOutstanding: 654_800_000, sharesBasis: basis, netAssets: 114_134_810_000, nav: 174.3, dataDir,
  });
  const inputs = flowInputs(observations);
  assert.ok(inputs, "an issuer-derived count may price a flow");
  assert.equal(inputs.sharesNow - inputs.sharesPrior, 4_800_000);
  assert.equal(inputs.nav, 174.3, "the official NAV prices it, not a market price");
});

test("a filed count and a reconstructed one are not a pair", (t) => {
  const dataDir = workspace(t);
  recordFundObservation({ symbol: "IWM", asOf: "2026-07-20", sharesOutstanding: 100_000_000, sharesBasis: "assets_from_disclosed_positions_over_market_price", netAssets: 20_000_000_000, dataDir });
  const { observations } = recordFundObservation({
    symbol: "IWM", asOf: "2026-07-27", sharesOutstanding: 101_000_000, sharesBasis: "issuer_disclosed_shares_outstanding", netAssets: 20_400_000_000, dataDir,
  });
  assert.equal(flowInputs(observations), null, "one filed observation is still only one");
});
