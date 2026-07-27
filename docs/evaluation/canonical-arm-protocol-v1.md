# Canonical A/B/C/D13/D26/E/H evaluation protocol v1

Status: **draft_unregistered**. There is no frozen dataset, case ledger, experiment result,
signature, passed comparison or release claim in this artifact.

The canonical draft is `data/council-evaluation-protocol.v1.json`; the intentionally
non-result schema is `schemas/council-evaluation-protocol-v1.schema.json`. Run:

```bash
npm run evaluation:protocol
node scripts/report-council-evaluation-protocol.mjs --check
node scripts/report-council-evaluation-protocol.mjs --markdown
node scripts/report-council-evaluation-protocol.mjs --json
```

The schema uses `const: null`, empty-array limits and `not_run` constants for registration,
results, signatures, thresholds and passed claims. Editing the draft into an apparent result
must fail validation. A future registered protocol needs a separate registration artifact and
schema; it must not weaken this draft schema in place.

## Canonical arms

| Arm | Exact configuration | Purpose |
|---|---|---|
| A | one strong model, no council seats | single-agent baseline |
| B | the live `DEFAULT_TASKS` eight analysts | evidence-team baseline without masters |
| C | B plus a frozen prompt-only snapshot of all canonical 26 masters | measure what prompt personas add |
| D13 | B plus the user's exact priority 13 physical v3 methods | first v3 method-pack treatment |
| D26 | B plus all 26 physical v3 methods | test whether the extra 13 add information or duplication |
| E | paired D13 and D26 variants plus `source_fidelity`, `rederivation`, `refuter` and at most two repair rounds | measure verifier/repair increment without hiding the base configuration |
| H | two or three independent human analysts plus one separately blinded adjudicator | human quality reference, not an automated vote |

The validator reads the live persona registry. It requires the protocol's analyst IDs to
equal `DEFAULT_TASKS`, verifier IDs to equal the live `verify` roster, D13 to equal the exact
priority list, and D26/C to equal all 26 enabled master IDs in registry order. Adding,
removing, renaming or reordering an arm or seat fails the check.

The priority 13 are Damodaran, Graham, Ackman, Cathie Wood, Munger, Burry, Pabrai, Taleb,
Lynch, Fisher, Jhunjhunwala, Druckenmiller and Buffett. The protocol stores stable persona
IDs, not display-name text.

## Case and point-in-time contract

The planned unit is `company × as_of × event`. Registration must freeze at least 48 shared
cases spanning at least 36 issuer/event/regime clusters. Every machine arm receives the same
frozen cases. H receives the same question, while its analysts work independently before
adjudication.

Required temporal rules are:

- facts: `public_at <= as_of AND known_at <= as_of`;
- filings: `filed_at <= as_of`;
- memory: `public_at <= as_of AND memory_created_at <= as_of`;
- restatements: only versions public by `as_of`;
- outcomes and adjudication: withheld until every arm prediction is frozen.

Case membership, arm order, survivorship universe, model/prompt/runner/host identities and
the adjudication rubric must be frozen before execution. Post-`as_of` search results and
cross-arm context sharing are forbidden. Known model-training contamination is recorded; a
model cannot self-certify that a case is clean. Forward shadow cases are required, but the
first 8–12 weeks remain an operational beta and cannot tune thresholds or promote maturity.

Returns may be recorded as lagging outcomes. They are never a standalone promotion gate.

## Metrics

All metric results are currently `null`.

1. `fact_accuracy`: correct adjudicated material fact clusters divided by all adjudicated
   material fact clusters.
2. `citation_validity`: material citations that entail the claim and respect `as_of`, divided
   by all material citations.
3. `calibration`: multiclass Brier score on the frozen common projection for cases with
   resolved labels.
4. `abstention_quality`: selective error at observed coverage plus a penalty for answering
   when preregistered critical facts are absent.
5. `unique_information_contribution`: independently verified material fact clusters absent
   from the paired base arm, per case.
6. `cost`: measured provider cost per completed case, including failed and retried work,
   with input/output tokens and tool calls.
7. `latency`: critical-path wall time, reported as p50, p95, maximum and timeout rate.

Fact, citation, calibration, abstention and unique-contribution comparisons use paired cases
and issuer/event/regime cluster uncertainty. Cost and latency are published beside quality,
not hidden. Matched-cost secondary comparisons are required for C–D13, C–D26 and D13–D26.

Native decisions are adjudicated before a common projection. This prevents a role-specific
convexity, valuation, factor or governance decision from being flattened into a directional
vote merely to manufacture comparability.

## What this protocol cannot currently claim

- It cannot say D13, D26 or E beats A, B or C.
- It cannot say 26 is better than 13.
- It cannot say verifier repair improves accuracy.
- It cannot publish a p-value, confidence interval, threshold pass or promotion.
- It cannot call 26 seats 26 independent samples.
- It cannot publish error `N_eff`; that requires the separate preregistered resolved-outcome
  ledger protocol, otherwise the value remains `null`.

Registration still needs dataset, case-ledger, model matrix, prompt bundle, runner, host
matrix, randomization and adjudication-rubric hashes; explicit promotion thresholds; a
multiplicity policy; timestamp; trusted signer ID; and a valid signature. Those are
deliberately absent here.

## Physical execution artifacts

The execution layer is implemented separately from this draft protocol:

```bash
npm run evaluation:artifacts
node scripts/council-experiment-artifacts.mjs --build-case-freeze \
  --manifest /absolute/path/to/case-freeze-build-manifest.json
node scripts/council-experiment-artifacts.mjs --build-case-freeze \
  --manifest /absolute/path/to/case-freeze-build-manifest.json \
  --write --output /absolute/evidence-directory/case-freeze.json
node scripts/council-experiment-artifacts.mjs --check --file /absolute/path/to/artifact.json
node scripts/council-experiment-artifacts.mjs --check --file /absolute/path/to/manifest.json \
  --artifact-directory /absolute/path/to/result-files
node scripts/council-experiment-artifacts.mjs --import-result \
  --file /absolute/path/to/physical-arm-result.json \
  --output /absolute/path/to/immutable-import-directory
```

The default command is plan-only and performs no experiment or model call. The schemas are
`council-case-freeze-v1`, `council-arm-run-result-v1` and
`council-experiment-result-manifest-v1`. They bind every run to the same case freeze and
frozen-input hash, record source/cost/latency and failed/retried work, and represent E as the
two explicit `E:D13` and `E:D26` variants.

H requires two or three independently working human analysts plus a separate human
adjudicator. Its adjudication packet uses a blind label that may not reveal H. An automated
reviewer is not a substitute for the named-human boundary.

Artifacts are signable but non-self-certifying: their content hash is recomputed, while
`attestations` and `passed_claims` must remain empty. `--signing-payload` exposes the stable
external signing domain, but this repository neither creates reviewer identities nor turns a
valid JSON file into a passed comparison. Only explicit `--import-result` accepts a physical,
non-symlink arm result, validates it, and copies it without overwriting an existing import.

Each completed arm declares one physical `artifact_directory`. Its raw result, fact clusters,
native decisions and common projection are separate safe relative path/raw-SHA-256 bindings
under that directory. A failed or `not_run` arm keeps the directory and all four path/hash
pairs null. File-level validation opens and recomputes the four files; result-manifest
validation recursively performs the same check for all eight canonical runs. Therefore a
syntactically valid run JSON containing plausible nested hashes cannot become experiment or
adjudication evidence when any physical result file is absent, linked or modified.

The case-freeze build manifest contains only case metadata, safe relative `input_path` values,
and precomputed question/fact-pack hashes. The builder opens the manifest and all 48 or more
inputs without following symlinks, hashes their exact bytes, preserves manifest order, requires
at least 36 issuer/event/regime clusters, and fixes `outcomes_withheld: true`. It never creates
case content or outcomes. Preview is the default; saving requires explicit `--write --output`,
uses exclusive mode `0600`, refuses overwrite, and cannot target the production `knowledge/`
tree.
