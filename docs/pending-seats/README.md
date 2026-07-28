# Pending seats

Work that is finished as content and blocked as wiring. Nothing here is loaded by the runtime.

## Why these are parked

Two artifacts in this repository are **generated from private authoring inputs that the
repository does not carry**: the solo-test formula tree
(`knowledge/solo-test/persona-v3-solo-test-formulas/`) and the pack tree
(`knowledge/solo-test/masters/`). Both are rebuilt by
`npm run persona:solo-test:formulas:build && npm run persona:solo-test:build`, and that chain
reads `knowledge/staging/persona-v3-formula-candidates/`, which is derived in turn from
per-seat `tools.json` files under `knowledge/staging/personas-v3/`.

`npm run persona:stage:init` scaffolds the seat directories but not those `tools.json` files.
They are maintainer-authored and absent here, so the trees cannot be regenerated in this
checkout — only verified against what is committed. `npm run check` says as much on every run:
`private/raw staging absent; verifying the packaged review capsule and solo-test tree instead`.

Everything below therefore needs one thing: a checkout where that staging exists.

## `persona-v3-authored-methods.v1.mjs` — nine authored methods

Real formulas and real decision policies for buffett, graham, bogle, marks, damodaran, dalio,
druckenmiller, asness and natenberg. Each threshold traces to a named published source, and
the three that do not are labelled in-file as this project's reading.

Copy this over `data/persona-v3-authored-methods.v1.mjs`, then fix four known integration gaps
before regenerating:

1. **Eligibility needs `source_ids` injected and its states mapped.** The entries use the
   executor's own record shape (`condition_id` / `condition` / `on_false` / `on_uncomputable`)
   and deliberately omit `source_ids`, which is minted at build time. `authoredDecisionPolicy`
   currently passes eligibility through verbatim; it must inject the source id and run both
   states through `executableNativeState`, as it already does for vetoes and bands.
2. **Hard vetoes need `on_uncomputable`.** The validator requires it; the builder does not emit
   one.
3. **`contractFor` must use the producer's contract for an `output_id` operand**, not the
   consuming tool's. The executor compares against the producing tool's output contract, so
   any tool dividing a monetary numerator by `valuation.market_capitalisation` to make a ratio
   currently fails the three-part `value_kind`/`unit`/`period` equality check.
4. **Build specs must declare the facts the conditions use.** `buildDocuments` rejects a tool
   input outside `required_fact_types`, and the policy validator checks condition facts against
   required ∪ optional. Facts used only in conditions have to be added as optional.

Also note the queue shape: `assertSoloFormulaTree` requires exactly two tools per seat, and
graham is authored with four.

## `bogle.md` + `persona-v3-bogle-build-spec.v1.mjs` — a twenty-seventh seat

None of the twenty-six seats is designed for a basket, which is why an ETF run has no seat that
natively belongs to it. Bogle's method is: expected return = dividend yield + earnings growth ±
valuation change, minus cost. All five facts it needs already exist.

The build spec validates with zero seat-level errors against the merged inventory. Wiring it in
means moving `bogle.md` back under `personas/masters/masters-value/`, the spec back under
`data/`, adding it to `CANONICAL_MASTER_IDS`, adding a selector card in `master-catalog.mjs` and
two entries in `master-selector-method-locales.v1.mjs`, then regenerating both trees. The seat
count invariants themselves are already dynamic — they read `CANONICAL_MASTER_COUNT` rather than
a literal, which was the change that made the count safe to move.
