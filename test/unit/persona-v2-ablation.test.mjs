import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPacks } from "../../mcp/lib/personas-v2/loader.mjs";
import { decide } from "../../mcp/lib/personas-v2/policy.mjs";
import { differentiation, judgmentOf, nameSwap, pairwiseAgreement, policySwap, runNameSwap, runPolicySwap, selfConsistency } from "../../mcp/lib/personas-v2/ablation.mjs";

const reg = loadPacks();
const buffett = reg.get("master_buffett");
const duan = reg.get("master_duan_yongping");
const taleb = reg.get("master_taleb");
const marks = reg.get("master_marks");
const packs = [buffett, duan, taleb, marks];

/** NOK exactly as the council actually received it. */
const NOK = {
  filer: { structured_financials: false },
  screen: { rules_computed: 0, metrics: {} },
  business_model: { explainable: true, simplicity_score: 0.35 },
  culture: { evidence_available: true, benfen_score: 0.5, integrity_flag: false },
  product: { user_value_score: 0.4 },
  portfolio: { beats_best_incumbent: false },
  options: {
    chain_available: true,
    atm_iv: 0.688,
    realized_minus_implied_vol_points: 8,
    skew_25d_points: 0.33,
    net_edge_vol_points: 2,
    expiry_covers_next_event: false,
  },
  risk: { ruin_possible: false },
  cycle: {},
};

const CASES = [
  NOK,
  {
    filer: { structured_financials: true },
    screen: { rules_computed: 7, metrics: { roe_10y: 0.24, debt_to_equity: 0.2, gross_margin: 0.6, ocf_over_ni: 1.3, dilution_5y: 0.0, net_cash_positive: true } },
    business_model: { explainable: true, simplicity_score: 0.9 },
    culture: { evidence_available: true, benfen_score: 0.85, integrity_flag: false },
    product: { user_value_score: 0.9 },
    portfolio: { beats_best_incumbent: true },
    options: { chain_available: true, atm_iv: 0.3, realized_minus_implied_vol_points: 1, skew_25d_points: 4, net_edge_vol_points: -1, expiry_covers_next_event: true },
    risk: { ruin_possible: false, permanent_loss_bounded: true },
    cycle: { valuation_percentile: 0.2, credit_spread_percentile: 0.6, consensus_gap_score: 0.7 },
  },
  {
    filer: { structured_financials: true },
    screen: { rules_computed: 7, metrics: { roe_10y: 0.35, debt_to_equity: 3.2, gross_margin: 0.3, ocf_over_ni: 0.4, dilution_5y: 0.2, net_cash_positive: false } },
    business_model: { explainable: false, simplicity_score: 0.2 },
    culture: { evidence_available: true, benfen_score: 0.2, integrity_flag: true },
    product: { user_value_score: 0.2 },
    portfolio: { beats_best_incumbent: false },
    options: { chain_available: true, atm_iv: 0.9, realized_minus_implied_vol_points: 9, skew_25d_points: 0.2, net_edge_vol_points: 5, expiry_covers_next_event: true },
    risk: { ruin_possible: true, permanent_loss_bounded: false },
    cycle: { valuation_percentile: 0.95, credit_spread_percentile: 0.1, consensus_gap_score: 0.2 },
  },
];

test("all four pilot packs load and none is allowed to claim a person's name", () => {
  for (const pack of packs) {
    assert.ok(pack, "pack should load");
    assert.equal(pack.kind, "operator_lens", `${pack.persona_id} corpus is below the admission bar`);
    assert.match(pack.display_name.en, /Model|Lens/);
  }
});

// The claim this whole release rests on: different methods see different securities.
test("on the real NOK facts, Buffett cannot look and Taleb can", () => {
  const b = decide(buffett, NOK);
  const t = decide(taleb, NOK);
  assert.equal(b.stance, "out_of_scope");
  assert.equal(b.narratable, false, "no financial series, so no judgment and no model call");
  assert.equal(t.narratable, true, "an option chain exists, so this method can act");
  assert.notEqual(b.stance, t.stance);
});

test("Buffett and Duan diverge on method, not on tone", () => {
  // They are the deliberately hard pair: if these two can only be told apart by voice,
  // Persona v2 has failed and expansion stops.
  const differing = CASES.filter((facts) => decide(buffett, facts).stance !== decide(duan, facts).stance);
  assert.ok(differing.length >= 1, "the two closest methods must disagree somewhere");
});

test("name swap: changing only the label does not move any verdict", () => {
  for (const pack of packs) {
    for (const facts of CASES) {
      const result = runNameSwap(pack, facts);
      assert.equal(result.stable, true, `${pack.persona_id} changed its verdict when only renamed`);
    }
  }
});

test("name swap changes the identity it was supposed to change", () => {
  const swapped = nameSwap(buffett);
  assert.notEqual(swapped.persona_id, buffett.persona_id);
  assert.equal(judgmentOf(decide(swapped, CASES[1])), judgmentOf(decide(buffett, CASES[1])));
});

test("policy swap: the verdict follows the policy, never the name", () => {
  const facts = CASES[1];
  const result = runPolicySwap(buffett, taleb, facts);
  assert.equal(result.follows_policy, true, "Taleb policy under the Buffett name must judge as Taleb");
  assert.equal(result.follows_name, false);
  // And the two are genuinely different on this case, so the test is not vacuous.
  assert.notEqual(result.host_stance, result.donor_stance);
});

test("policy swap holds in both directions", () => {
  const facts = CASES[1];
  assert.equal(runPolicySwap(taleb, buffett, facts).follows_policy, true);
  assert.equal(runPolicySwap(duan, marks, facts).follows_policy, true);
});

test("policy swap carries the donor label so a trace cannot be misread", () => {
  assert.equal(policySwap(buffett, taleb)._policy_from, "master_taleb");
});

test("the deterministic layer is perfectly self-consistent", () => {
  for (const pack of packs) assert.equal(selfConsistency(pack, CASES), 1);
});

test("the four pilots are differentiated, and the diagnostic could have said otherwise", () => {
  const result = differentiation(packs, CASES);
  assert.equal(result.self_consistency, 1);
  assert.ok(result.mean_pairwise_agreement < 1, "four methods agreeing on everything would be a chorus");
  assert.equal(result.verdict, "effective", JSON.stringify(result, null, 2));
});

test("four copies of one method are correctly reported as undifferentiated", () => {
  // The diagnostic has to be able to fail, or it is decoration. Same policy, four names.
  const clones = ["a", "b", "c", "d"].map((s) => nameSwap(buffett, `master_${s}`, `${s} Method Model`));
  const result = differentiation(clones, CASES);
  assert.equal(result.mean_pairwise_agreement, 1);
  assert.equal(result.verdict, "none");
});

test("pairwise agreement names the pairs so a reader can see which two are twins", () => {
  const { pairs } = pairwiseAgreement([buffett, duan], CASES);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].a, "master_buffett");
  assert.equal(pairs[0].b, "master_duan_yongping");
  assert.ok(pairs[0].agreement <= 1 && pairs[0].agreement >= 0);
});
