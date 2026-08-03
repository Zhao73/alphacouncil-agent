# PersonaPack v3 AI-assisted solo assurance

`ai_assisted_solo` is an isolated machine cross-review profile for a repository maintained
by one person. It improves local test auditability without impersonating a second human or
weakening the production release system.

The profile is deliberately **not** a runtime build profile. Runtime still accepts only
`production` or `solo_test`; setting `ALPHACOUNCIL_PERSONA_BUILD_PROFILE=ai_assisted_solo`
is rejected. The default remains `solo_test`.

## What the profile accepts

The status checker accepts a review only when all of the following are true:

- it is a physical regular JSON file, not a symlink;
- `reviewer_kind` is exactly `ai`;
- human-review and human-claim fields are explicitly false;
- production effect is exactly `none`;
- three distinct registered roles use three distinct prompt IDs and prompt hashes;
- role outputs bind their inputs and prior role outputs by canonical hashes;
- the top-level review hash is recomputed;
- in the source checkout, source pre-reviews re-open the physical acquisition record and
  archived bytes and recompute the record/content hashes;
- the source index or formula manifest binds every physical review artifact;
- duplicate source candidates or formula tools do not increase coverage.

The npm package deliberately excludes acquisitions and `source.bin`. Its installed-package
check therefore uses a separately labelled `packaged_capsule_only` mode: it recomputes every
artifact hash, every index hash, all 185 review-file bindings, and the extractor → skeptic →
adjudicator chain, but does not claim to reopen raw source bytes. A source checkout with the
private acquisition tree reports `raw_revalidated` instead. Both modes remain AI-only and
have no production or formal-GA effect.

The first 31 source artifacts prove archive integrity and machine triage only. A separate
three-process semantic chain then reopens all 31 byte archives: extractor, skeptic and a
no-context adjudicator each emit 32 hash-bound artifacts. The chain binds PDF pages or HTML
text offsets plus snippet hashes, while keeping `human_reviewed=false` and
`method_attribution_approved=false`. The 52 formula artifacts independently rederive and
adversarially check mechanical DSL behavior, while keeping named-investor semantic fidelity
explicitly unknown.

## Two different readiness conclusions

Run:

```bash
npm run persona:ai-assisted:status
npm run persona:ai-assisted:check
npm run persona:ai-assisted:gate
npm run persona:ai-simulations:check
```

- `status` reports every lane and fails only on malformed or tampered evidence.
- `check` additionally requires 26 physical solo packs, 31 source pre-reviews, all three
  31-artifact semantic-review rounds and 52 formula cross-reviews. This is the local
  AI-assisted testing boundary.
- `persona:ai-simulations:check` re-executes and byte-verifies eight no-network machine
  simulation variants: `A`, `B`, `C`, `D13`, `D26`, `E:D13`, `E:D26` and
  `H_ai_reference`.
- `gate` also requires all eight machine simulations, four passed live-host E2E artifacts,
  and either a publishable `N_eff` or an explicit hash-bound
  `insufficient_resolved_outcomes` disclosure. It remains blocked until the live-host facts
  physically exist.

Current verified status:

| Lane | Coverage | Meaning |
| --- | ---: | --- |
| Physical solo packs | 26/26 | locally testable provisional packs |
| AI source pre-reviews | 31/31 | hash-bound machine triage; not semantic/human approval |
| Semantic extractor | 31/31 | 28 locator-bound source propositions |
| Semantic skeptic | 31/31 | independent support/scope challenge |
| Semantic adjudicator | 31/31 | 18 supported, 10 partial; 6 candidates unverifiable |
| AI formula cross-reviews | 52/52 | mechanical cross-review; semantic fidelity unknown |
| Machine simulation variants | 8/8 | 105/105 deterministic seat executions; no network/model calls |
| Canonical experiments | 0/8 | synthetic simulation is never counted as formal experiment evidence |
| Live-host E2E | 0/4 | static parity is not counted as a live run |
| Error `N_eff` | `null` | completed disclosure: `insufficient_resolved_outcomes`; formal value remains null |

Therefore `local_test_status=ready`, while `release_status=blocked` only on live-host E2E.
No passed live-host artifact is included in the release package. Earlier bounded attempts were
diagnostic failures only, so no host is promoted from failure to success by the status checker.

The machine suite uses existing frozen NOK/options fixtures plus all 26 physical pack
manifests and generated contract-consistent typed facts. `D13` and `D26` execute the real
provisional deterministic runtime. `A`, `B`, and `C` are explicitly limited surrogates for
input/control plumbing; they do not simulate LLM analyst quality. `E` adds machine-only
hash, rederivation and missing-input fail-closed checks. `H_ai_reference` is an AI
deterministic digest, with `human_reference=false`, `formal_h_satisfied=false`, and no
relationship to the formal H arm.

## Immutable boundary

Every report hardcodes and schema-enforces:

```json
{
  "human_review_satisfied": false,
  "formal_ga_effect": "none",
  "production_eligible": false,
  "method_model_eligible": false
}
```

The formal human-review registry, production loader, release assembler and GA checker are
unchanged. AI artifacts cannot be submitted to those paths as human attestations.

Contracts and implementation:

- `data/persona-v3-ai-assisted-solo-profile.v1.json`
- `schemas/persona-v3-ai-assisted-solo-profile-v1.schema.json`
- `schemas/persona-v3-ai-assisted-solo-status-v1.schema.json`
- `scripts/check-persona-v3-ai-assisted-solo.mjs`
- `scripts/lib/persona-v3-ai-assisted-solo-status.mjs`
