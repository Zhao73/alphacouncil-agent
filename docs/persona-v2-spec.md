# Persona v2 — Method Models, Not Impressions

Specification for the 0.8.0 master rewrite. Background: `docs/roadmap.md`. Superseded
sections of the earlier plan are noted in `docs/plans/0.8.0-master-models.md`.

## Naming discipline

These are **method models**, never people. Every user-facing surface says so.

```
Buffett Method Model          not "Warren Buffett"
Duan Yongping Method Model    not "段永平"
Marks Method Model            Taleb Method Model
```

A model whose source corpus does not clear the admission bar below is not named after a
person at all. It is an **Operator Lens** — `Duan-inspired Operator Lens` — and the report
says which of the two it is. Claiming to hold a living investor's judgment because a model
can imitate the cadence is the specific dishonesty this document exists to prevent.

## Why the previous design failed

Twenty-one masters were twenty-one prompt voices over one base model and one evidence
brief. Their errors correlate, so agreement between them is not confirmation. The published
result is blunt: LLM errors run **>60% correlated**, majority voting inherits legitimacy
from a theorem requiring independence, and with identical inputs debate is a **martingale** —
expected correctness does not improve across rounds.

The 0.7.0 work produced empirical support that nobody predicted. Recording ten opinions
whose stances ranged from avoid to long, the run stored **`cautious` ten times**: the enum
check fell through to a default, and the default was a real stance carrying real weight. A
unanimity no master produced, manufactured by a normalizer.

That is the load-bearing lesson for this spec: **a structured decision layer is only as
honest as its rejection layer.** Silent coercion of an unrecognised value into a plausible
one is the same failure as an imitation passing for a judgment — a shape that looks like a
decision, holding no decision.

## Six modules per model

Capability is the first five. Voice is the sixth and touches nothing above it.

| Module | File | Decides |
|---|---|---|
| Doctrine | `doctrine.jsonl` | what the method asserts, with sources |
| Research policy | `research_policy.json` | what it goes and looks for, privately |
| Decision policy | `decision_policy.json` | what it computes, vetoes, and refuses |
| Tools | `tools.json` | which calculators it may call |
| Memory | `memory_policy.json` | what it remembers and when it may read it |
| Voice | `voice.<lang>.md` | how the finished verdict reads |

**Voice may not participate in fact extraction, computation, or signal generation.** A
system that lets style reach the decision will score "sounds like Omaha" as "judges like
Omaha", which is the confusion the whole exercise is meant to end.

## Doctrine entries are rules, not quotations

```jsonc
{
  "rule_id": "buffett.circle_of_competence.01",
  "claim": "Stop valuing a business whose model cannot be explained in a paragraph",
  "scope": ["public_equity", "operating_business"],
  "trigger": "business_model_explanation_failed",
  "action": "out_of_scope",
  "source_ids": ["buffett:S17", "buffett:S23"],
  "confidence": "high",
  "counterexamples": [],
  "version": 1
}
```

Every entry carries source, scope, trigger, action, counterexamples, confidence, version.
An entry without `source_ids` cannot be loaded.

### Source grades

| Grade | What it is | May define |
|---|---|---|
| A | Signed letters, articles, formal talks, company filings | core decision rules |
| B | Verifiable full interviews or meeting transcripts | core decision rules |
| C | Direct quotation in reliable press | supporting rules only |
| D | Third-party summary | staging area, never a rule |
| E | Unsourced internet aphorism | rejected |

Only **A/B** define a rule. The repository stores short summaries, method propositions,
source URLs, dates, minimal necessary excerpts, and the boundary of applicability — not
long copyrighted passages.

### Admission bar for a named model

- ≥25 sourced method propositions
- ≥5 independent primary (A/B) sources
- ≥5 real decision cases
- ≥3 documented failures, misses, or changes of mind
- ≥10 executable veto conditions
- ≥10 counterfactual tests

Errors and reversals matter more than aphorisms: they are what define the boundary of a
method. Below the bar, the model is an Operator Lens and is labelled as one.

## Evidence: shared facts, private research

1. **Frozen fact pack** — price, filed figures, filing dates, share count, option chain.
   Identical for every model and **not overridable**. Four models must not discover four
   market caps in the name of independence.
2. **Private research** — each model then runs its own query plan. Buffett-method looks for
   moat, capital allocation and owner earnings; Duan-method for user value, operating
   culture and opportunity cost; Marks-method for consensus, cycle position and risk
   premium; Taleb-method for fragility, leverage, liquidity and convexity.
   **Private material is invisible to the other seats until after first submission.**
3. **Independent recomputation** — each model recomputes at least two load-bearing figures
   from the frozen pack. It may disagree with a derived number; it may not silently
   overwrite a filed one.

This is the only lever that produces disagreement from something other than tone.

## Anonymous first round

First-round output carries no name and no style: evidence selected, computation performed,
decision, confidence, abandonment condition, and where it is most likely wrong. Identity
and voice are attached afterwards, before debate.

## Structured decision, with a rejection layer

```jsonc
{
  "stance": "constructive",
  "action": "watch",
  "confidence": 0.68,
  "method_fit": 0.91,
  "circle_of_competence": "inside",
  "required_evidence_complete": false,
  "vetoes_triggered": [],
  "price_conditions": [],
  "position_cap": 0,
  "belief_updates": [],
  "memory_ids_used": [],
  "source_ids": []
}
```

**Position size is never chosen by the model.** Deterministic code sets it from historical
calibration, evidence quality, verification results, error correlation with other seats,
portfolio limits, and triggered vetoes.

Every enumerated field is validated on the way in. An unrecognised value is **rejected or
recorded as a zero-weight abstention with a warning — never coerced into a neighbouring
valid value.** This rule exists because its absence already produced a fake consensus once.

## Memory, with a time boundary

| Layer | Written when | Mutable by a run |
|---|---|---|
| Doctrine | source review + version release | no |
| Episodic | every judgment | append only |
| Belief | on belief change, pointing at episodes and sources | yes |
| Postmortem | only after the prediction horizon expires | append only |
| Working | during a run, archived after | no |

**The leak rule.** In a run at `as_of = T`, a model may read only memories where
`public_at <= T` **and** `memory_created_at <= T`. Without the second clause a model reads
the future through its own diary, and every backtest built on it is fiction.

## Proving it is not a performance

Diagnostics that can return "this bench is decorative".

| Experiment | Change | Expected if real |
|---|---|---|
| **Name swap** | names only | **no material change** |
| **Policy swap** | load Taleb policy under the Buffett name | follows the policy, not the name |
| **Evidence swap** | private packs only | explicable parts move, vetoes hold |
| **Memory ablation** | drop episodic / postmortem / reflection / private retrieval | isolates which layer adds value |
| **Voice removal** | neutral JSON, blind raters | method still identifiable |
| **Model cross-over** | each persona on several models | separates persona from model |
| **Counterfactual** | −40% price, 2× debt, margin drop, integrity event, convex→concave payoff | each model moves by its own rules |

Name swap and policy swap are the cheapest and the most decisive. If a name change moves
the verdict, the system is acting.

`variance = company + persona + model + persona×model`. **If the model effect exceeds the
persona effect, no personality has been built.**

### N_eff is deferred, deliberately

`N_eff ≈ (Σw)² / (wᵀ C w)` needs an error-correlation matrix `C`, which needs resolved
ground truth on many cases. It is therefore **not a v1 deliverable** and must not be printed
before the postmortem corpus exists. Until then the report discloses correlation
qualitatively and refuses to publish a tally.

## Pilot: four models, chosen to be hard

| Model | Must independently develop | Private inputs |
|---|---|---|
| Buffett | circle of competence, moat, owner earnings, capital allocation | 10y financials, capex split, buyback/M&A record, pricing-power evidence |
| Duan Yongping | business model, 本分 culture, user value, stop-list, opportunity cost, default inaction | product/user evidence, management behaviour timeline, culture events, candidate comparator |
| Marks | cycle position, consensus, price-implied expectations, permanent loss | credit spreads, liquidity, valuation percentile, sentiment and positioning |
| Taleb | fragility, tail risk, convexity, ruin, barbell | option chain, liability structure, liquidity stress, extreme scenarios, payoff shape |

Buffett and Duan Yongping are chosen **because they are similar**. If the system can only
separate those two by tone, Persona v2 has failed and expansion stops.

## Acceptance gates for the pilot

Recalibrate after the first ten cases.

| Metric | Bar |
|---|---|
| Method propositions with sources | 100% |
| Unsupported direct quotations | 0 |
| Look-ahead leaks | 0 |
| Structured-policy adherence | ≥95% |
| Citations that actually support the claim | ≥95% |
| Counterfactual direction correct | ≥85% |
| Decision stability on repeated identical input | ≥80% |
| Blind method identification after name+voice removal | >70% (chance = 25%) |
| Error-correlation reduction vs. the 21 prompt masters | ≥15% |
| Final report pass rate | ≥95% |
| Runs still failing after auto-repair | <5% |

If groups D/E do not beat B/C on factual accuracy, citation support, calibration, or unique
information contribution, **stop and do not build the remaining seventeen.**

### Control groups

A: single strong model · B: current 8 analysts · C: 8 analysts + 21 prompt masters ·
D: 8 analysts + 4 Persona v2 · E: D + verifiers · **F: human reference — optional.**

F requires two independent raters plus an adjudicator and is likely unobtainable for a
single-maintainer project. It is explicitly not allowed to block conclusions from A–E.

## Returns are not a validation metric

Investment return is a **lagging, low-power, confounded** indicator and cannot substitute
for source accuracy, look-ahead control, method adherence, or risk calibration.

- 36 historical plus 12 shadow cases cannot separate skill from luck, and correlated seats
  reduce the effective sample further.
- "Right for the wrong reason" is indistinguishable from skill by return alone.
- Return is the metric look-ahead leakage inflates most and hides in best.
- The product claim is *this is what the method would say*, not *this makes money*. A
  method model that declines while the stock triples is not thereby wrong; a filter has a
  known opportunity cost.

Returns are recorded in the ledger as a long-run outcome. They are never a gate.

## Phases

| Phase | Output | Days |
|---|---|---|
| 0 | this spec, `schemas/persona-v2.schema.json`, case spec, source policy | 3–5 |
| 1 | four source corpora | 5–7 |
| 2 | `personas-v2/`, `policies/`, `master-tools/`, private research, anonymous round 1 | 7–10 |
| 3 | `memory/` with time filtering and postmortem gating | 5–7 |
| 4 | 36 frozen cases, 12 shadow cases, groups A–E, all swap experiments | 7–10 |
| 5 | shadow running, no live trading | 8–12 wks |
| 6 | expand only by missing method, not by fame | — |

Benchmarks are frozen in Phase 0 so success criteria cannot be invented afterwards to
flatter the result.

## No fine-tuning in phase one

Order is: sourced doctrine → independent retrieval → tools → decision policy → memory →
evaluation → *then* consider tuning. Fine-tuning learns cadence fastest and judgment
slowest, and twenty-one LoRAs over one base model still share their errors. If it ever
happens, the method adapter and the voice adapter are separate artifacts and the method
adapter faces the same ablations.

## Unresolved

- No open-source project has demonstrated faithful reproduction of a real investor's full
  judgment. This spec does not claim to be first; it claims to be falsifiable.
- The swap-experiment battery is this project's construction from standard ablation
  practice, not an industry standard.
- Letta has marked its older server generation legacy; pin a current version before
  depending on its memory model.
- `N_eff` and group F are both deferred, for different reasons, and neither may gate v1.
