# PersonaPack v3 AI-assisted formula cross-review

This lane gives every one of the 52 `provisional_derived_proxy` tools a reproducible
three-role machine review. It improves local-test integrity; it is not a substitute for a
human formula approval and has no production or GA effect.

## Roles and claims

Every review uses exactly three machine principals:

1. `deriver` reconstructs expected behavior from the bound DSL and generates test vectors;
2. `adversarial_checker` independently recomputes hashes, vectors and invariants;
3. `adjudicator` compares both records and reports mechanical agreement, disagreement or
   unknown.

All three records have `reviewer_kind: "ai"` and `human_principal: false`. The top-level
artifact has `human_reviewed: false`, `human_claims: false`, `production_effect: "none"`,
`production_eligible: false` and `method_model_eligible: false`. It contains no trusted
human principal, approval bundle or signature.

Mechanical consistency and method fidelity are deliberately separate. A passing record
means the temporary formula is hash-consistent and behaves as declared on the generated
vectors. It does **not** mean that an identity proxy is faithful to Buffett, Taleb or any
other named investor. Every record therefore keeps
`semantic_equivalence_to_named_investor_method` explicitly `unknown`.

## Physical artifacts

The review tree is isolated below the AI-assisted solo evidence root:

```text
knowledge/ai-assisted-solo/reviews/persona-v3-ai-formula-reviews/
├── review-manifest.json
└── <persona_id>/reviews/<tool-leaf>.ai-review.json
```

There are 52 tool review files plus one manifest. This machine-only tree is included in the
npm package so installed-package checks can recompute its artifact and manifest bindings.
It is not a production pack root. An `ai_assisted_solo` checker may consume these records
only while preserving the non-production labels and keeping formal loaders fail-closed.

## Review coverage

Each tool receives four replayable vectors (negative, zero-boundary, positive and missing
input) and eight invariants:

- exact input-schema hash;
- exact output-schema hash;
- exact derivation-evidence hash;
- exact derivation-spec hash;
- exact formula-to-executable contract;
- independent vector recomputation;
- fail-closed missing-input behavior;
- intact provisional/non-production boundary.

The deriver and checker use separate operation evaluators. Disagreement is a first-class
status, not an exception hidden by the adjudicator. Unsupported behavior becomes
`machine_unknown`.

## Hash domains

All hashes use canonical JSON and the repository `sha256:` format:

- schema hash: parsed `schemas/persona-v3-ai-formula-cross-review-v1.schema.json`;
- subject: `alphacouncil.persona-v3.ai-formula-review-subject.v1`;
- prompt: `alphacouncil.persona-v3.ai-formula-review-prompt.v1`;
- review artifact: `alphacouncil.persona-v3.ai-formula-cross-review-artifact.v1`;
- manifest: `alphacouncil.persona-v3.ai-formula-cross-review-manifest.v1`.

The manifest additionally binds the SHA-256 of each complete review file. A changed tool,
evidence record, formula, schema, prompt, role result or review file invalidates at least one
recomputable binding.

## Commands

```bash
# Recompute in memory; do not read or write the review tree.
node scripts/review-persona-v3-solo-formulas.mjs --plan

# Create or refresh the isolated 53-file tree.
npm run persona:solo-test:formulas:ai-review:write

# Require exact file membership and byte-stable recomputation.
npm run persona:solo-test:formulas:ai-review:check

# Focused tests.
node --test test/unit/persona-v3-ai-formula-review.test.mjs
```

`npm run check` includes the physical-tree verification. The approved formula compiler,
production loader, release assembler and GA gate do not consume this review tree.
