# Error `N_eff` preregistration v1

`N_eff` is unpublished until `assessErrorNeff()` returns `publishable`. A configured seat
count, output agreement, deterministic repeatability or name-swap result is never a substitute
for an error-correlation matrix built from resolved outcomes.

Each estimate covers exactly one preregistered error metric. Fact error, citation error,
veto error, abstention error and common-projection error require separate matrices. Native
decisions that do not share a scoring object are not flattened into a market-direction label
for convenience.

The benchmark artifact must record:

- the fixed `ledger-error-correlation-v1` estimator version, preregistration timestamp and
  later evaluation timestamp;
- the case unit, outcome horizon and resolved-outcome flag;
- at least 36 preregistered jointly scoreable cases, the exact seat IDs and weights;
- issuer, event and regime cluster keys plus the frozen bootstrap cluster key;
- a common signed-residual scoring rule and `joint_complete_only` abstention policy;
- every point-in-time prediction, its `as_of`/capture time and pack/model/prompt/runner/case
  hashes, plus every resolved outcome, public time and source hash;
- content hashes for both ledgers, identity shrinkage, a fixed bootstrap seed, at least 200
  requested cluster-bootstrap replicates and a maximum confidence-interval width;
- a keyed attestation from a signer trusted by the evaluator process. Naming a signer inside
  the artifact does not place it on that allowlist.

The caller does **not** submit the correlation matrix or bootstrap estimates. The evaluator
checks `preregistered_at < prediction_at < outcome_public_at <= evaluated_at`, derives the
joint sample, recomputes residual correlation, applies the frozen identity shrinkage and
performs the seeded cluster bootstrap. Injected matrices, post-attestation ledger edits,
future-dated preregistrations and untrusted signatures all return `n_eff: null`.

If any condition fails, the product stores `n_eff: null` and the reasons. The UI may still
show source clusters, unique verified contributions and native-decision differences, but it
must label those as behavioural-diversity diagnostics rather than effective independent
samples.

Historical holdouts can test point-in-time facts, source fidelity, policy adherence, vetoes
and abstention. They cannot be certified as parametrically clean by asking a model whether it
remembers the outcome. Forward shadow cases are the cleanest outcome evidence; the first
8–12 weeks are an operational beta, not validation of 3–12 month investment claims.
