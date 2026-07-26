import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContract, summarizeChain } from "../../mcp/lib/options.mjs";

const row = (option, over = {}) => ({
  option, iv: 0.3, delta: 0.5, gamma: 0, theta: 0, vega: 0,
  open_interest: 100, volume: 10, bid: 1, ask: 1.1, ...over,
});

// Spot 100, one near expiry and one far, plus the two rows that must not be trusted.
const CHAIN = {
  data: {
    close: 100,
    options: [
      // 2 days out: a real expiry, but an ATM implied vol here prices pin risk and
      // discreteness rather than volatility, so it must not drive the headline.
      row("XYZ260728C00100000", { iv: 0.20, delta: 0.50 }),
      row("XYZ260728P00100000", { iv: 0.20, delta: -0.50 }),
      // 20 days out: the first expiry at least a week away, so the reference.
      row("XYZ260815C00100000", { iv: 0.40, delta: 0.50 }),
      row("XYZ260815P00100000", { iv: 0.50, delta: -0.50 }),
      row("XYZ260815P00090000", { iv: 0.60, delta: -0.25, open_interest: 5000 }),
      row("XYZ260815C00110000", { iv: 0.35, delta: 0.25, open_interest: 4000 }),
      row("XYZ260901C00100000", { iv: 0.30, delta: 0.50 }),
      row("XYZ260901P00100000", { iv: 0.30, delta: -0.50 }),
      // Deep in the money: CBOE reports iv 0. This is a missing value, not calm.
      row("XYZ260815C00050000", { iv: 0, delta: 1 }),
      // Already expired relative to as_of.
      row("XYZ260701C00100000", { iv: 0.99, delta: 0.5 }),
    ],
  },
};

test("parseContract decodes root, expiry, right and strike", () => {
  assert.deepEqual(parseContract("XYZ260801C00100000"),
    { root: "XYZ", expiry: "2026-08-01", right: "call", strike: 100 });
  assert.deepEqual(parseContract("BRKB261218P00432500")?.strike, 432.5);
  assert.equal(parseContract("not-a-contract"), null);
});

test("a zero implied vol is dropped, not read as low volatility", () => {
  const s = summarizeChain(CHAIN, { asOf: "2026-07-26" });
  assert.equal(s.contracts_total, 10);
  assert.equal(s.contracts_with_iv, 8, "the iv=0 row and the expired row are both excluded");
  // The failure this guards: 0 entering the mean would drag ATM IV down and read as a calm name.
  const ref = s.term_structure.find((t) => t.expiry === "2026-08-15");
  assert.equal(ref.atm_iv, 0.45, "mean of the 0.40 call and 0.50 put, with no zero pulling it down");
  assert.ok(!s.term_structure.some((t) => t.expiry === "2026-07-01"), "an expired series must not appear");
});

// A live MU chain printed a 1-DTE ATM of 69.6% between neighbours at 98.7% and 105.2%.
// Quoting that as the headline hands the reader the least reliable number on the board.
test("the headline reads from the first expiry a week out, not the nearest one", () => {
  const s = summarizeChain(CHAIN, { asOf: "2026-07-26" });
  assert.equal(s.term_structure[0].expiry, "2026-07-28", "the short expiry stays in the term structure");
  assert.equal(s.term_structure[0].dte, 2);
  assert.equal(s.reference_expiry.expiry, "2026-08-15", "but the headline skips it");
  assert.equal(s.reference_expiry.dte, 20);
  assert.equal(s.reference_expiry.atm_iv, 0.45);
  assert.match(s.reference_expiry.note, /skipped for the headline/);
});

test("when every expiry is a week out the nearest one is used and says so", () => {
  const far = { data: { close: 100, options: [
    row("XYZ260815C00100000", { iv: 0.4, delta: 0.5 }),
    row("XYZ260815P00100000", { iv: 0.4, delta: -0.5 }),
  ] } };
  const s = summarizeChain(far, { asOf: "2026-07-26" });
  assert.equal(s.reference_expiry.expiry, "2026-08-15");
  assert.match(s.reference_expiry.note, /at least a week out and is used directly/);
});

test("skew is put minus call at 25 delta on the reference expiry", () => {
  const s = summarizeChain(CHAIN, { asOf: "2026-07-26" });
  assert.equal(s.skew_25delta.expiry, "2026-08-15", "skew follows the reference, not the nearest expiry");
  assert.equal(s.skew_25delta.put_iv, 0.6);
  assert.equal(s.skew_25delta.call_iv, 0.35);
  assert.equal(s.skew_25delta.put_minus_call, 0.25);
  assert.match(s.skew_25delta.reading, /downside protection bid/);
});

test("term structure carries days to expiry from the supplied as_of, not the clock", () => {
  const s = summarizeChain(CHAIN, { asOf: "2026-07-26" });
  assert.deepEqual(s.term_structure.map((t) => t.dte), [2, 20, 37]);
});

test("the digest states what it cannot compute instead of leaving it open", () => {
  const s = summarizeChain(CHAIN, { asOf: "2026-07-26" });
  assert.ok(s.unavailable.some((u) => /percentile/i.test(u)), "IV percentile must be declared uncomputable");
  assert.ok(s.unavailable.some((u) => /realised volatility/i.test(u)));
  assert.equal(s.delayed, true);
});

test("open interest ratios and concentration come from the full chain", () => {
  const s = summarizeChain(CHAIN, { asOf: "2026-07-26" });
  // Open interest is counted across the whole chain, including the iv=0 and expired rows:
  // those carry no usable volatility but the contracts and their open interest are real.
  // Puts: three at 100 plus the 5000 wing. Calls: five at 100 plus the 4000 wing.
  assert.equal(s.open_interest.puts, 5300);
  assert.equal(s.open_interest.calls, 4500);
  assert.equal(s.largest_open_interest_strikes[0].strike, 90);
  assert.equal(s.largest_open_interest_strikes[0].vs_spot_pct, -10);
});

test("a payload with no option rows yields null rather than an empty-looking digest", () => {
  assert.equal(summarizeChain({ data: {} }), null);
  assert.equal(summarizeChain(null), null);
});
