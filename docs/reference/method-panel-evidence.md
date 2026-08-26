# Method-panel recommendation and seat evidence

AlphaCouncil keeps all 26 physical method packs available. It can derive an eight-family
advisory panel from the installed packs' `capability.domains` and `required_fact_types`, but it
does not silently select or run that panel. The user still sees the full catalog and explicitly
confirms any 1–26 methods (`quick`: 1–4), including methods the advisory panel excluded.

The recommendation is a deterministic function of three inputs:

1. the displayed `catalog_hash`;
2. a non-unknown `instrument_classification` (`asset_type` and `research_model`);
3. sorted, deduplicated `typed_fact_coverage` IDs.

It returns an include/exclude decision, reason, missing facts and manifest capability basis for
all 26 packs. Its `recommendation_hash` covers the canonical classification, fact coverage and
all 26 decisions—not only the selected eight. A selection with a recommendation uses the
additive v4 receipt and must acknowledge that hash. Calls without an evaluable classification
remain on the v3 receipt contract and receive no guessed default panel.

## Eight method families

| Family | Manifest signals | Conditional admission |
|---|---|---|
| Quality compounding | operating/business quality, management integrity, capital allocation | none |
| Deep value / safety margin | deep or distressed value, downside protection, intrinsic valuation | none |
| Macro regime | macro/debt/credit cycles, liquidity, reflexivity, cross-asset risk | none |
| Quantitative / systematic | systematic signals, factors, probabilistic edge, execution costs | fund/index specialists additionally require a fund/index classification |
| Short / forensic | accounting forensics, primary documents, capital structure, shortability | a shortability specialist requires borrow/short facts |
| Growth / innovation | adoption, disruptive innovation, growth quality or structural penetration | none |
| Tail risk | convexity, fragility, options/volatility, risk posture, failure analysis | options/volatility specialists require derivative classification and option/execution/payoff facts |
| Event / special situations | activism, catalysts, arbitrage, turnarounds, complex securities | activism specialists require event/corporate-action facts |

Within each family, declared domain overlap is scored first, then available/missing required facts;
stable master ID is the final tie-breaker. One pack cannot fill two slots. This is a method match,
not a ranking of people, an independent-model count, or a claim of investment performance.

## Vocabulary review boundary

`data/method-vocabulary-contract.v1.draft.json` is an AI-drafted preregistration aid. It records at
least eight positive markers per seat and at least four neighbor-conflict markers for each declared
confusable pair. The contract validator deliberately returns `not_evaluable` until an actual human
reviewer signs the exact content with an owner-controlled Ed25519 key authorized for
`method_vocabulary_review`. Test keys are generated only inside tests and are never trusted in
production.

After approval, a statement is merely classified as method-characteristic when it hits at least
three positive markers and neighbor-conflict hits do not exceed positive hits. This diagnostic is
not evidence that the named person wrote, approved or currently holds the statement.

## Repeated-case boundary

Seat status has only three possible values: `active`, `conditional`, or `observe`. There is no
`merged` or `deleted` state in this evidence stage. A portfolio becomes eligible for seat review
only after at least:

- three hash-identical repeats per case;
- six distinct cases; and
- three instrument types,

all under one vocabulary version and hash. A dirty v1.3 AAPL bundle with 0/26 current seat
contracts is retained only as `observation_hypothesis`; it cannot enter a seat decision. A single
case never justifies removing a pack.

This work does not substantiate a 15-minute completion claim. Historical timing shows method-seat
wall time was a small part of the old run; evidence acquisition, bounded concurrency, output size
and terminal persistence remain the meaningful timing levers. See
[Timing evidence and offline replay](timing-evidence.md).
