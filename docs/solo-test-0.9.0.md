# AlphaCouncil 0.9.0 solo-test status

Verified in the repository worktree on 2026-07-27.

## What this channel contains

`0.9.0-solo-test.1` is the declared package/plugin version and `solo_test` is the build channel. The
isolated tree at `knowledge/solo-test/masters` contains:

- 26/26 physical PersonaPack v3 packs;
- 26/26 packs accepted by the explicit solo-test loader and compiler;
- 52/52 executable tools with assurance class `provisional_derived_proxy`;
- 26/26 provisional `operator_lens` seats;
- 0 operational seats and 0 `method_model` seats;
- 0 human source approvals, 0 human formula approvals and 0 human approval signatures;
- 26/26 packs rejected by the production loader.

The proxy sources and formulas are project-derived test material. They do not establish
named-investor attribution, independent human review, production eligibility or a formal GA
pass.

An isolated AI-assisted cross-review lane mechanically rechecks all 52 provisional tools
with `deriver`, `adversarial_checker` and `adjudicator` machine roles. It binds exact schema,
tool, evidence, formula, prompt, role and file hashes and recomputes 208 test vectors plus
416 invariants. Semantic fidelity remains explicitly unknown, human approval counts remain
zero, and the lane has no production effect. See `docs/persona-v3-ai-formula-review.md`.

## Exact verification commands

Run from the repository root:

```bash
npm run persona:solo-test:check
npm run persona:solo-test:formulas:ai-review:check
node --test test/unit/persona-v3-solo-test-packs.test.mjs \
  test/unit/persona-v3-ai-formula-review.test.mjs \
  test/integration/persona-v3-solo-formula-execution.test.mjs \
  test/contract/version.test.mjs
git diff --check
```

Observed status on 2026-07-27:

- `npm run persona:solo-test:check`: **PASS** — physical 26/26, loaded 26/26,
  compiled 26/26, provisional `operator_lens` 26/26, production rejected 26/26, tools
  52/52, operational/method_model 0/0, ready for solo testing `true`.
- Focused Node test command: **PASS — 10/10 tests**.
- `git diff --check`: **PASS**.

## Production boundary

Formal production GA remains fail-closed. It still requires independently trusted human
source and formula approvals, signed experiment adjudication, immutable production release
assembly, external-host/package evidence, signed cutover/rollback/re-cutover operation
evidence and a final passing unified GA report. No solo-test artifact can substitute for any
of those gates.
