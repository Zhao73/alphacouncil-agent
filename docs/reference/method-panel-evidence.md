# Method-panel recommendation and seat evidence

AlphaCouncil keeps all 26 physical method packs available. It can derive an eight-family
advisory panel from the installed packs' `capability.domains` and `required_fact_types`, but it
does not silently select or run that panel. The user still sees the full catalog and explicitly
confirms any 1–26 methods (`quick`: 1–4), including methods the advisory panel excluded.

The legacy recommendation remains a deterministic function of three inputs:

1. the displayed `catalog_hash`;
2. a non-unknown `instrument_classification` (`asset_type` and `research_model`);
3. sorted, deduplicated `typed_fact_coverage` IDs.

For the v1.6 public council runtime, the supported calibrated pair is
`objective=directional_rating` plus `holding_horizon=1_year`. Calibration v2 adds those two inputs
and returns schema v3. Objective fit ranks before horizon fit, existing manifest
capability score and stable ID. It also classifies every method into one of three disjoint
contribution paths:

- `directional_rating_master_ids`: primary, non-`out_of_scope` method judgments that Bull and
  Bear must debate once;
- `risk_coverage_master_ids`: non-voting risk, veto and evidence-quality coverage that reaches
  the PM once, without exposing a method stance or rating;
- `context_only_master_ids`: scope, missing-input and reopen-condition context with zero
  directional contribution.

This is routing, not a vote count. The PM never averages method stances, and risk/context methods
cannot become extra negative votes. `out_of_scope` always contributes zero direction, remains
visible in the separately rendered method bench, and is not sent into the PM rating path.

The result contains an include/exclude decision, reason, missing facts and manifest capability
basis for all 26 packs. Its `recommendation_hash` covers the canonical classification, fact
coverage and all 26 decisions—not only the selected eight. Calibrated selections use the additive
v5 receipt: `decision_context_hash` binds the objective, horizon, PM-rubric requirement and all
26 contribution classifications even when classification is missing and `recommendation_hash`
is null. The text fallback mirrors the same context so a text-only MCP host can confirm it.

For `objective=directional_rating` plus `holding_horizon=1_year`, the PM uses
`pm_rating_rubric_v2`: Buy at base-case total return of at least +20%, Overweight at +10% to
under +20%, Hold between -10% and +10%, Underweight above -20% through -10%, and Sell at -20%
or below. The server binds the frozen price and currency, recomputes total return from the
same-currency target plus income return, then recomputes the raw band. It permits only one
source-backed downside notch;
the downgrade must also cite a server-owned eligible cause context whose frozen sources include
every adjustment source. `out_of_scope` creates no such context. The server never upgrades or
applies a multi-notch penalty, and missing evidence is not converted into Hold.
Other objective/horizon labels remain reserved calibration taxonomy and are rejected by the
public run-selection RPC until they have a defined PM output contract; they do not silently
inherit this 12-month return-band rubric.

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
stable master ID is the final tie-breaker. Only a pack with no missing required facts can fill a
family slot. If no admitted pack is fully covered, the family is recorded as unfilled rather than
throwing or recommending a known abstention. One pack cannot fill two slots. This is a method
match, not a ranking of people, an independent-model count, or a claim of investment performance.

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
