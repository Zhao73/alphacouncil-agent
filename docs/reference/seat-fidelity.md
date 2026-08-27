# Seat Fidelity Harness v1

The 26 packaged seats are **provisional operator lenses**, not the named people and not
approved method models. This harness makes that boundary machine-checkable. It does not show
that a seat is historically faithful, predicts returns, improves investment performance, or
helps anyone make a profit.

Run the gate from a source checkout:

```bash
npm run seats:fidelity:check
```

The command currently verifies one strict template for every physical seat and reports:

- 26/26 physical `solo_test` operator lenses; production still rejects all 26;
- 216/216 policy records labelled `unsourced_ai_proposal`, plus an unsourced structural-policy
  label; `source_ids` beginning with `proxy:` remain internal identifiers, not source proof;
- 52/52 provisional derivation-spec and derivation-evidence hashes bound to the physical tools;
- 118/118 required-or-eligibility single-fact ablations returning `out_of_scope`, plus one
  all-target ablation per seat;
- 34/37 hard vetoes reached through a constructed real executor run; three root comparisons
  between two live operands remain explicitly pending:
  `master_bogle.expected_return_below_inflation`,
  `master_sinclair.edge_dies_in_the_spread`, and
  `master_thorp.edge_inside_the_friction`;
- zero impersonation-lint hits across the packaged voices, doctrine, deterministic dry-run
  voices and rendered disclosure; and
- `cases: 0 (golden 0, pairwise 0, calibration 0); unlabeled: 0`.

The zero-case result is not described as evaluation success. Future golden, pairwise and
calibration rows must carry `case_as_of`; every nested `as_of`, `public_at`, `known_at`,
`published_at` and `memory_created_at` value must be no later than that cutoff. Case authoring
and human labels belong to the later per-seat evaluation package. A labeled row must also carry
`label_as_of` later than `case_as_of`, so the expected answer cannot leak into its evidence window.

The AI machine-simulation fixtures were regenerated only because the added provenance changes
the exact policy identity hashes. A frozen parent snapshot verifies all 11 artifacts are
semantically unchanged after removing only `hash`, `digest`, and `byte_length` identity fields;
the `n-eff-disclosure.json` file remains byte-identical.

## Provenance and rendering

Every current eligibility condition, hard veto, scoring rule and score band carries:

```json
{ "provenance": { "status": "unsourced_ai_proposal" } }
```

The policy itself carries the same status for structural parameters such as `max_score`,
`min_coverage`, the fact gate and abstention behavior. The schema reserves a separate
`sourced` shape, but this package forbids using it until a later signed-source workflow exists.
The executor validates these labels and then ignores them during calculation.

Reader-facing method-seat output includes two fixed lines:

```text
AI simulation of the <method> method — not the person
thresholds: N AI-proposed, unsourced (eligibility/vetoes/scoring_rules/score_bands); structural parameters: unsourced
```

`N` is the number of labelled records, not the number of numeric literals. A proxy source ID
does not reduce the unsourced count.

## What the gate does not establish

Passing this harness is structural and negative safety evidence. It does not replace human
source review, point-in-time labeled cases, calibration, live-host end-to-end runs, formal
experiments, or a release. Until those independent gates exist, accurate public wording is
limited to helping users organize, inspect and review stock research.
