import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseCouncilRuns } from "../../mcp/lib/council-diagnostics.mjs";

function run(caseNo, repeatNo, stances = ["constructive", "constructive"]) {
  const selected = ["master_a", "master_b"];
  return {
    run_id: `CASE-${caseNo}-R${repeatNo}`,
    symbol: `T${caseNo}`,
    as_of: `2026-07-${String(caseNo).padStart(2, "0")}`,
    masters: selected,
    fact_pack_hash: `sha256:${String(caseNo).padStart(64, "0")}`,
    master_selection: {
      catalog_hash: "a".repeat(64),
      intent_hash: String(caseNo + 30).padStart(64, "0"),
    },
    master_opinions: selected.map((master, index) => ({
      master,
      stance: stances[index],
      native_state: `${master}_state_${stances[index]}`,
      pack_hash: `sha256:${String(index + 11).padStart(64, "0")}`,
      policy_hash: `sha256:${String(index + 21).padStart(64, "0")}`,
      source_ids: index === 0 ? ["shared", `unique-${caseNo}`] : ["shared"],
    })),
  };
}

test("one run reports agreement but cannot claim differentiation or N_eff", () => {
  const result = diagnoseCouncilRuns([run(1, 1)]);
  assert.equal(result.descriptive_agreement[0].mean_pairwise_agreement, 1);
  assert.equal(result.behavioral_differentiation.verdict, null);
  assert.equal(result.independence.n_eff, null);
  assert.equal(result.independence.seat_count_is_independent_sample_count, false);
  assert.deepEqual(result.unique_source_contribution[0].seats[0].unique_source_ids, ["unique-1"]);
});

test("three repeated hash-identical cases measure behavioural differentiation", () => {
  const runs = [];
  for (let caseNo = 1; caseNo <= 3; caseNo += 1) {
    runs.push(run(caseNo, 1, ["constructive", "opposed"]));
    runs.push(run(caseNo, 2, ["constructive", "opposed"]));
  }
  const result = diagnoseCouncilRuns(runs);
  assert.equal(result.behavioral_differentiation.status, "measured_behavioral_differentiation");
  assert.equal(result.behavioral_differentiation.self_consistency, 1);
  assert.equal(result.behavioral_differentiation.mean_pairwise_agreement, 0);
  assert.equal(result.behavioral_differentiation.verdict, "effective");
  assert.equal(result.independence.n_eff, null);
});

test("missing hash bindings are excluded from repeated-input claims", () => {
  const incomplete = run(1, 1);
  delete incomplete.fact_pack_hash;
  const result = diagnoseCouncilRuns([incomplete, structuredClone(incomplete), structuredClone(incomplete)]);
  assert.equal(result.exact_input_eligible_run_count, 0);
  assert.equal(result.behavioral_differentiation.repeated_case_count, 0);
  assert.equal(result.behavioral_differentiation.verdict, null);
});

test("diagnostics are stable for identical inputs and reject weak sample policies", () => {
  const runs = [run(1, 1), run(1, 2)];
  assert.equal(diagnoseCouncilRuns(runs).diagnostics_hash, diagnoseCouncilRuns(runs).diagnostics_hash);
  assert.throws(() => diagnoseCouncilRuns(runs, { minimumCases: 2 }), /3 through 100/);
});
