# PersonaPack v3 formula authoring pipeline

The 26 staging seats contain 52 computation prototypes. Those prototypes describe an
operation family and editorial steps; they do **not** establish an exact formula. In the
current inventory all 52 therefore fail closed as `needs_formula_authorship`, with zero
executable candidates and zero dedicated production tools.

This pipeline does not infer thresholds or formulas from a tool name, prose purpose, named
persona, or operation family. In particular, `valuation_model`, `reconciliation`,
`risk_sizing`, and similar families are not DSL operations.

## Single-maintainer local-test bridge

When no independent human reviewers are available, the repository can build an explicitly
provisional execution surface without forging review identities, keys, signatures or approval
bundles:

```bash
# Validate the physical 52-file pending queue and derive in memory only.
node scripts/compile-persona-v3-formulas.mjs --compile-solo-test

# Write the isolated test tree.
node scripts/compile-persona-v3-formulas.mjs --compile-solo-test --write
```

The write target is
`knowledge/solo-test/persona-v3-solo-test-formulas`. It contains exactly 26 per-seat
`components/tools.json` files, 52 `provisional-derivations/*.json` evidence records and one
`compilation-manifest.json`. Every generated tool is labelled:

- `assurance_class: provisional_derived_proxy`;
- `review_status: not_human_reviewed`;
- `intended_use: local_test_only`;
- `production_eligible: false`.

The compiler records zero human reviewers, zero signatures and zero formula approvals. It
mechanically maps the first declared input to the first declared output with DSL `identity`.
That operation proves plumbing and deterministic execution only; it is not the named
investor's formula or method.

Known grounding-adapter fact IDs use their canonical value-kind/unit snapshot contracts,
including option IV, 25-delta skew, bid/ask, price and selected filing-screen metrics. Unknown
facts retain the synthetic `scalar/derived_proxy_scalar` contract and therefore fail closed
against ordinary real facts unless a local test adapter supplies that exact contract. The
identity proxy output always mirrors its selected input contract.

The deterministic executor accepts this disjoint provisional binding, while production
admission still requires `formula_spec_id`, the complete reviewed spec hashes and a real
approval bundle. Consequently the solo tree cannot become a dedicated production tool,
operational pack, release formula evidence or `method_model`. The formal dual-signature path
below remains unchanged.

## Commands

```bash
# Default: read and validate the 26 staging tools.json files; write nothing.
npm run persona:formulas:check

# Print all 52 queue entries.
node scripts/compile-persona-v3-formulas.mjs --markdown

# Explicitly materialize non-production authoring candidates under knowledge/staging.
npm run persona:formulas:write

# Verify all 52 human-edited specs and their dual-signed approval bundles; write nothing.
node scripts/compile-persona-v3-formulas.mjs \
  --compile-approved \
  --candidate-root knowledge/staging/persona-v3-formula-candidates \
  --trusted-formula-reviewer-keys /offline/path/formula-review-public-keys.json

# After the same checks, explicitly write isolated per-persona tools and evidence.
node scripts/compile-persona-v3-formulas.mjs \
  --compile-approved --write \
  --candidate-root knowledge/staging/persona-v3-formula-candidates \
  --trusted-formula-reviewer-keys /offline/path/formula-review-public-keys.json
```

`--check` and `--plan` are aliases and never write. `--write` is constrained to a directory
named `persona-v3-formula-candidates` below a `staging` directory. It writes only:

- `authoring-inventory.json`;
- one formula-spec candidate for each of the 52 source prototypes.

Human review adds exactly one matching bundle below `approvals/<persona>/` for every edited
spec below `specs/<persona>/`. `--compile-approved` rejects missing, duplicate, or extra IDs;
all 52 planned IDs must be present. Its explicit write mode emits only
`persona-v3-compiled-formulas/<persona>/components/tools.json`, the 52 matching
`formula-approvals/*.approval-bundle.json` files, and one compilation manifest.

It cannot write `knowledge/masters`, a PersonaPack manifest, release evidence, registry
state, package versions, or a production tool graph. The production loader does not read
the candidate root.

## Exact formula contract

The normative shape is `schemas/persona-v3-formula-spec-v1.schema.json`; the compiler also
performs semantic validation without depending on a JSON Schema library. An executable
candidate must declare all of the following:

1. one exact DSL 1.1 operation and a semantic version;
2. ordered input operands, each with `value_kind`, unit, period basis/window/alignment, and
   `on_missing` behavior;
3. one primary output ID, value kind, unit, and period contract;
4. formula provenance with source IDs, exact citation, author, authored time, and source
   `as_of` date;
5. an approval reference, reviewer IDs, review time, and an immutable subject hash over the
   full formula/provenance/review record.

Input-level `on_missing` must equal the formula-level policy. Period contracts are explicit:
instant values have no duration window; duration and forecast-horizon values require one;
`not_applicable` periods require `not_applicable` alignment. A DSL tool can expose one
output, so a multi-output prototype must select one primary output or be split into an
ordered set of separately reviewed formula specs.

## Review subject hash and mandatory signatures

An author changes a candidate from `needs_formula_authorship` to `executable_candidate`
only after filling `formula` and `provenance`. The review record then carries a
`review_subject_hash` computed with `formulaReviewSubjectHash(spec)`. This hash binds:

- formula identity and source prototype identity;
- the complete authorship request;
- exact formula, units, periods, and missing-data behavior;
- provenance;
- reviewer IDs, review time, and approval reference.

Any later change invalidates the subject hash, but that self-computed hash is not authority.
Compilation additionally requires an exact `persona_v3_formula_approval_bundle` containing
the complete spec and at least two Ed25519 `formula_review` attestations from distinct trusted
principals and distinct keys. Every signature binds the complete formula-spec hash, review
subject, prototype content hash, source IDs, author ID/time, reviewer ID/time, and explicit
`approve` or `reject` decision. Unsigned, untrusted, revoked, wrong-purpose, rejected,
same-principal, tampered, or replayed bundles fail closed.

The signing-request and signing library accepts reviewer identity, signer key ID, decision,
review time, and private key only as explicit caller inputs. It never creates identities,
keys, timestamps, or decisions. Private keys remain offline.

`compileApprovedFormulaSpec` rejects pending, unbound, malformed, or content-drifted specs.
Successful compilation emits the exact DSL 1.1 tool fields plus `formula_spec_id`,
`formula_spec_hash`, `formula_review_subject_hash`, and `approval_bundle_hash`. Those
bindings and `source_ids` participate in both deterministic input/output schema hashes;
reviewer identities remain in separately verified release evidence rather than entering the
anonymous execution contract.

The compiled tool retains each input's value kind, unit, period, and missing-data contract in
`input_contracts`, plus `output_period`. Those contracts participate in schema hashes. The
deterministic executor checks typed facts against them before arithmetic and rejects mismatched
units, value kinds, windows, as-of alignment, and downstream output contracts.

Compilation is still a staging operation. A compiled candidate is not a dedicated tool,
not a physical v3 pack, and not production-enabled. The separate source, case, experiment,
release, and production-admission gates remain unchanged.

Production-candidate inspection re-verifies each physical bundle and requires the exact 52
planned tool IDs: no duplicate, missing, or extra tool is accepted. Immutable release
assembly then writes `formula-review-evidence.json`, which binds and re-verifies all 52
tool/spec/bundle/prototype/source/principal relationships before atomic assembly and again
during release verification.

The public keys embedded in that evidence are an audit snapshot, never a trust root.
Verification, cutover, rollback, current-release resolution, runtime loading and GA require
an external registry whose matching entries are byte-for-byte identical to the embedded
descriptors. The embedded registry may be a subset of the external registry; it cannot add,
replace, un-revoke or grant a new purpose to a key. Missing, empty, revoked, wrong-purpose or
substituted external trust therefore fails closed.

Pass the registry explicitly with `--trusted-formula-reviewer-keys` to release assembly,
`promote-persona-v3-release.mjs` and `check-persona-v3-ga.mjs`. Production runtime may read
the same JSON registry from `ALPHACOUNCIL_TRUSTED_FORMULA_REVIEW_KEYS`. This environment
variable contains public descriptors only; private keys remain offline. It is one of three
mandatory and non-interchangeable runtime registries: release approval
(`ALPHACOUNCIL_TRUSTED_RELEASE_KEYS`), source review
(`ALPHACOUNCIL_TRUSTED_SOURCE_REVIEW_KEYS`), and formula review
(`ALPHACOUNCIL_TRUSTED_FORMULA_REVIEW_KEYS`). GA evidence verification additionally uses
separate experiment-adjudication and release-evidence registries.

## Current formal-review 52/52 result

All current prototypes lack at least:

- selection of one exact DSL operation;
- ordered operands and literal parameters;
- input/output units;
- period basis, window, and alignment;
- authored formula-level missing-data behavior;
- reviewed formula provenance and a matching immutable review-subject hash.

Many also declare several output fact types even though one DSL tool emits one output.
Consequently mechanical encoding would invent method content. The correct current result is
52 `needs_formula_authorship`, 0 `executable_candidate`, and 0 dedicated production tools.
