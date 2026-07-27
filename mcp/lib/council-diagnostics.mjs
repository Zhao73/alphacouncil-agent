/**
 * Read-only diagnostics for saved council runs.
 *
 * Agreement is descriptive. It is never converted into independent-sample counts. A
 * behavioural-differentiation verdict requires repeated, hash-identical inputs across at
 * least three distinct cases; error N_eff remains delegated to the signed resolved-outcome
 * ledger in personas-v3/n-eff.mjs.
 */

import { canonicalValue, sha256 } from "./personas-v3/canonical.mjs";

const STANCES = new Set(["constructive", "cautious", "opposed", "out_of_scope"]);
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const RAW_SHA256 = /^[a-f0-9]{64}$/u;

function strings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.length))].sort();
}

function opinionsFor(run) {
  return (Array.isArray(run?.master_opinions) ? run.master_opinions : [])
    .filter((opinion) => typeof opinion?.master === "string" && STANCES.has(opinion?.stance))
    .sort((a, b) => a.master.localeCompare(b.master));
}

function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function exactInputIdentity(run, opinions) {
  const selected = strings(run?.masters);
  const factPackHash = run?.fact_pack_hash || run?.grounding?.typed_fact_pack?.fact_pack_hash || null;
  const catalogHash = run?.master_selection?.catalog_hash || null;
  const intentHash = run?.master_selection?.intent_hash || null;
  const policyBindings = opinions.map((opinion) => ({
    master: opinion.master,
    pack_hash: opinion.pack_hash || null,
    policy_hash: opinion.policy_hash || null,
  }));
  const completeBindings = selected.length > 0
    && policyBindings.length === selected.length
    && policyBindings.every((binding) => SHA256.test(binding.pack_hash || "")
      && SHA256.test(binding.policy_hash || ""));
  if (!run?.symbol || !run?.as_of || !RAW_SHA256.test(catalogHash || "")
    || !RAW_SHA256.test(intentHash || "")
    || !SHA256.test(factPackHash || "") || !completeBindings) return null;
  return sha256({
    symbol: run.symbol,
    as_of: run.as_of,
    catalog_hash: catalogHash,
    intent_hash: intentHash,
    fact_pack_hash: factPackHash,
    selected_masters: selected,
    policy_bindings: policyBindings,
  });
}

function judgment(opinion) {
  return JSON.stringify(canonicalValue({
    stance: opinion.stance,
    native_state: opinion.native_state || opinion.native_decision?.state || null,
    policy_hash: opinion.policy_hash || null,
    pack_hash: opinion.pack_hash || null,
  }));
}

function runAgreement(run, opinions) {
  let comparablePairs = 0;
  let agreeingPairs = 0;
  const pairs = [];
  for (let left = 0; left < opinions.length; left += 1) {
    for (let right = left + 1; right < opinions.length; right += 1) {
      comparablePairs += 1;
      const same = opinions[left].stance === opinions[right].stance;
      if (same) agreeingPairs += 1;
      pairs.push({ a: opinions[left].master, b: opinions[right].master, same_stance: same });
    }
  }
  return {
    run_id: run.run_id || null,
    selected_seats: strings(run?.masters).length,
    recorded_seats: opinions.length,
    comparable_pairs: comparablePairs,
    agreeing_pairs: agreeingPairs,
    mean_pairwise_agreement: comparablePairs ? agreeingPairs / comparablePairs : null,
    pairs,
  };
}

function uniqueContribution(run, opinions) {
  const sourceUsers = new Map();
  for (const opinion of opinions) {
    for (const id of strings(opinion.source_ids)) {
      if (!sourceUsers.has(id)) sourceUsers.set(id, new Set());
      sourceUsers.get(id).add(opinion.master);
    }
  }
  return {
    run_id: run.run_id || null,
    seats: opinions.map((opinion) => {
      const cited = strings(opinion.source_ids);
      const unique = cited.filter((id) => sourceUsers.get(id)?.size === 1);
      return {
        master: opinion.master,
        cited_source_count: cited.length,
        unique_source_count: unique.length,
        unique_source_ids: unique,
      };
    }),
  };
}

function repeatedCaseMetrics(views, { minimumCases }) {
  const grouped = new Map();
  for (const view of views) {
    if (!view.exact_input_hash) continue;
    if (!grouped.has(view.exact_input_hash)) grouped.set(view.exact_input_hash, []);
    grouped.get(view.exact_input_hash).push(view);
  }
  const repeated = [...grouped.entries()].filter(([, group]) => group.length >= 2);
  let selfSame = 0;
  let selfTotal = 0;
  const caseRepresentatives = [];
  for (const [exactInputHash, group] of repeated) {
    const seats = strings(group[0].opinions.map((opinion) => opinion.master));
    for (const seat of seats) {
      const values = group.map((view) => view.opinions.find((opinion) => opinion.master === seat))
        .filter(Boolean).map(judgment);
      if (values.length !== group.length) continue;
      for (let index = 1; index < values.length; index += 1) {
        selfTotal += 1;
        if (values[index] === values[0]) selfSame += 1;
      }
    }
    caseRepresentatives.push({ exact_input_hash: exactInputHash, opinions: group[0].opinions });
  }

  const pairStats = new Map();
  for (const representative of caseRepresentatives) {
    const opinions = representative.opinions;
    for (let left = 0; left < opinions.length; left += 1) {
      for (let right = left + 1; right < opinions.length; right += 1) {
        const key = pairKey(opinions[left].master, opinions[right].master);
        if (!pairStats.has(key)) pairStats.set(key, { same: 0, total: 0 });
        const stat = pairStats.get(key);
        stat.total += 1;
        if (opinions[left].stance === opinions[right].stance) stat.same += 1;
      }
    }
  }
  const pairs = [...pairStats.entries()].map(([key, stat]) => {
    const [a, b] = key.split("|");
    return { a, b, cases: stat.total, agreement: stat.total ? stat.same / stat.total : null };
  });
  const comparable = pairs.filter((pair) => pair.cases === caseRepresentatives.length && pair.agreement !== null);
  const selfConsistency = selfTotal ? selfSame / selfTotal : null;
  const pairwiseAgreement = comparable.length
    ? comparable.reduce((sum, pair) => sum + pair.agreement, 0) / comparable.length : null;
  const scorable = repeated.length >= minimumCases
    && selfConsistency !== null && pairwiseAgreement !== null;
  if (!scorable) {
    return {
      status: "insufficient_repeated_hash_identical_cases",
      minimum_cases: minimumCases,
      repeated_case_count: repeated.length,
      self_consistency: selfConsistency,
      mean_pairwise_agreement: pairwiseAgreement,
      gap: null,
      verdict: null,
      pairs,
    };
  }
  const gap = selfConsistency - pairwiseAgreement;
  return {
    status: "measured_behavioral_differentiation",
    minimum_cases: minimumCases,
    repeated_case_count: repeated.length,
    self_consistency: selfConsistency,
    mean_pairwise_agreement: pairwiseAgreement,
    gap,
    verdict: gap >= 0.30 ? "effective" : gap >= 0.15 ? "weak" : "none",
    pairs,
  };
}

export function diagnoseCouncilRuns(runs, { minimumCases = 3 } = {}) {
  if (!Array.isArray(runs) || !runs.length) throw new Error("diagnostics requires at least one saved run");
  if (!Number.isInteger(minimumCases) || minimumCases < 3 || minimumCases > 100) {
    throw new Error("minimumCases must be an integer from 3 through 100");
  }
  const views = runs.map((run) => {
    const opinions = opinionsFor(run);
    return { run, opinions, exact_input_hash: exactInputIdentity(run, opinions) };
  });
  const exactEligible = views.filter((view) => view.exact_input_hash).length;
  const behavioural = repeatedCaseMetrics(views, { minimumCases });
  const stable = canonicalValue({
    schema_version: 1,
    run_count: runs.length,
    exact_input_eligible_run_count: exactEligible,
    descriptive_agreement: views.map((view) => runAgreement(view.run, view.opinions)),
    unique_source_contribution: views.map((view) => uniqueContribution(view.run, view.opinions)),
    behavioral_differentiation: behavioural,
    independence: {
      seat_count_is_independent_sample_count: false,
      n_eff: null,
      reason: "requires_preregistered_signed_resolved_outcome_ledger",
    },
  });
  return Object.freeze({ ...stable, diagnostics_hash: sha256(stable) });
}
