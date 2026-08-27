# Typed-fact producer catalog

The 26 physical solo-test packs refer to facts in six different roles: required, optional,
eligibility, veto, scoring and tool input. A fact name in a pack is not proof that the runtime can
produce it. `data/typed-fact-producers.v1.json` records that distinction from observed offline
executions of the real `adaptGroundingToTypedFacts` adapter.

The generated v1 catalog currently records:

- 172 distinct fact identifiers referenced across 26 packs and 270 pack/fact pairs;
- 82 section-bound producer records for 68 distinct runtime facts;
- 40 fully produced, 83 conditional and 147 no-producer pack/fact routes;
- 72 matching tool-input contracts and no observed contract mismatches; and
- 2 of 26 method packs with every critical fact fully produced; and
- 12 critical no-producer facts, confined to the Taleb and Damodaran method lenses.

These numbers describe this exact hash-bound artifact. They are not a claim that live data will
always be available, that all 26 seats can always vote, or that the resulting research predicts
returns or improves investment performance.

## How it is built

Run:

```sh
npm run facts:catalog:write
npm run facts:catalog:check
```

The builder executes one maximal fixture, ten isolated section fixtures and six conditional
fixtures through the production grounding adapter. A producer ID binds the adapter, section and
exact fact ID; lineage is evidence attached to the observation and is never used as identity.
The committed bytes are canonical JSON plus one trailing newline. `catalog_hash` covers every
catalog field except itself, and the release preview rejects byte drift.

The five declaration inventories are hash-bound separately: `FRED_SERIES`,
`FUNDAMENTAL_FACT_IDS`, `LOOK_THROUGH_FACT_IDS`, `SCREEN_FACTS` and `CROSS_MARKET_FACTS`.
A declared literal that the fixtures do not observe fails the build. This is an implementation
inventory, not a substitute for live-source tests.

## Status semantics

- `produced`: at least one producer appears in every supported class/source-difference fixture.
  This is adapter-path coverage, not a promise that a live upstream request will succeed.
- `conditional`: one or more runtime producers exist, but all require a named instrument class or
  source path such as equity-only SEC data, an options chain, cross-market references or
  fund/index look-through inputs.
- `no_producer`: the pack refers to the fact but the grounding adapter has no observed path for it.

`critical` is role-derived. Required facts, eligibility inputs, veto inputs and tool inputs are
critical; an optional declaration becomes critical when it is also used in one of those roles.
Scoring alone does not make a fact critical. Missing critical facts must lead to abstention, never
model-memory substitution.

## Explicit critical gaps

`data/typed-fact-no-producer-acknowledged.v1.json` is an exact, fail-closed acknowledgement list.
It names six Taleb inputs (`payoff.max_loss`, `payoff.convexity`, `risk.ruin_possible`,
`risk.hidden_leverage`, `execution.round_trip_cost`, `event.expiry_coverage`) and six Damodaran
inputs (`valuation.cash_flow`, `valuation.implied_story`, `valuation.target_margin`,
`valuation.reinvestment_rate`, `valuation.cost_of_capital`, `valuation.failure_probability`).

The acknowledgement does not waive the gap. It prevents the gap from being hidden: deleting an
entry fails as unacknowledged, while leaving an entry after a producer is added fails as stale.
Until those model-specific inputs have reviewed producers, the affected lenses must remain
explicitly unable to issue a scored vote when the facts are needed.

## Estimated deterministic facts

`governance.insider_ownership` is emitted as `estimated`, with adapter lineage and confidence
`0.7`. It remains a deterministic producer because the runtime computes it from bounded Section
16 and share-count inputs. The catalog does not relabel qualitative model output as an observed
fact, and it does not let presentation voice change the fact or the frozen decision.
