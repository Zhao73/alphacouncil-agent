# PersonaPack v3 build-spec inventory

Status: **non-production planning only**.

The canonical inventory is `data/persona-v3-build-specs.v1.mjs`; its contract is
`schemas/persona-v3-build-spec-v1.schema.json`. The inventory does not contain a production
PersonaPack, an admitted source, a verified quotation, a completed decision case, a reviewer
signature or an experiment result. Loading it has no effect on the production registry and
cannot promote a seat.

Run the independent check with:

```bash
node scripts/report-persona-v3-build-specs.mjs --check
node scripts/report-persona-v3-build-specs.mjs --markdown
node scripts/report-persona-v3-build-specs.mjs --json
```

## What the inventory establishes

The validator derives the seat IDs and order from `mcp/lib/personas/registry.mjs`, checks the
selector cards, reads each current v1 prompt, and discovers the physical v2 manifests rather
than trusting an inventory claim. At this checkpoint it proves only the following:

- 26 build specs correspond one-for-one and in order with the canonical master catalog;
- 22 seats currently have v1 prompt material and four have a legacy v2 operator pack;
- no entry in this inventory is a physical v3 pack or a method model;
- every seat has an explicit method-scope hypothesis, required typed facts, planned native
  decision contract, at least two planned tools, at least three candidate veto families,
  three or more source-acquisition targets, four case-acquisition queues and known limits;
- all 26 method attributions, source grades, case outcomes, thresholds and counterfactual
  labels remain pending human adjudication;
- reviewer approvals, experiment passes and production promotions are all zero.

The planned totals are 172 required fact types, 52 dedicated tools, 78 veto families and 78
source-acquisition targets. The acquisition floors are 130 decisions, 78 failures, 520
counterfactuals and 312 golden cases. These are workload commitments, **not corpus counts**.

## Per-seat differentiation plan

| Seat | Native decision contract | Planned dedicated computations | Load-bearing limit |
|---|---|---|---|
| Aschenbrenner | `ai_scaling_timeline_v1` | compute-power bridge; timeline reverse valuation | private or classified scaling inputs |
| Buffett | `ownership_candidate_v1` | owner-earnings rebuild; incremental returns | private Berkshire deliberations and joint attribution |
| Graham | `margin_of_safety_v1` | asset floor; normalized earnings | historical accounting and edition-level attribution |
| Simons | `out_of_sample_signal_v1` | leakage audit; out-of-sample cost test | Renaissance production system is proprietary |
| Soros | `reflexive_loop_v1` | reflexivity graph; reversal monitor | Quantum Fund positions and timing are incomplete |
| Cathie Wood | `innovation_adoption_scenario_v1` | cost-adoption curve; capture-valuation bridge | holdings do not disclose complete rationale |
| Druckenmiller | `macro_inflection_v1` | liquidity-revision map; inflection payoff | private positions, entry timing and risk limits |
| Fisher | `scuttlebutt_quality_v1` | public scuttlebutt graph; research productivity | original method depended on private conversations |
| Munger | `failure_path_verdict_v1` | incentive map; coupled failure graph | many decisions were jointly attributable |
| Thorp | `edge_sizing_v1` | edge recalculation; fractional Kelly | production signals and execution are proprietary |
| Asness | `factor_adjusted_alpha_v1` | factor decomposition; crowding-cost stress | AQR production definitions and models are private |
| Dalio | `regime_balance_v1` | regime classifier; debt-driver stress | Bridgewater production systems are proprietary |
| Duan Yongping | `user_value_owner_decision_v1` | user-value evidence; opportunity cost | conversational archives and holdings are incomplete |
| Jhunjhunwala | `india_growth_governance_v1` | promoter governance; penetration-liquidity | no current attribution after 2022; private promoter work |
| Lynch | `category_story_decision_v1` | category classifier; story-numbers check | Fidelity research and trades are incomplete |
| Forensic short | `forensic_shortability_v1` | accounting rebuild; borrow-catalyst map | synthetic specialist seat; borrow data is ephemeral |
| Li Lu | `ten_year_certainty_decision_v1` | promise-integrity ledger; ten-year return bridge | Himalaya analyses and entry prices are private |
| Marks | `cycle_risk_posture_v1` | cycle temperature; implied expectations | Oaktree underwriting and thresholds are private |
| Burry | `structural_mispricing_v1` | capital-structure reader; mispricing carry | Scion research and complete trade construction are private |
| Klarman | `capital_preservation_v1` | recovery waterfall; cash-catalyst comparison | authorized public case material may remain too sparse |
| Pabrai | `dhandho_payoff_v1` | downside floor; discrete payoff | public holdings cannot prove the Dhandho rationale |
| Ackman | `engagement_feasibility_v1` | power map; change-value bridge | public presentations are advocacy, not independent proof |
| Damodaran | `valuation_distribution_v1` | story DCF; reverse valuation | reproducibility does not validate assumptions |
| Taleb | `convexity_ruin_v1` | payoff-ruin stress; tail-friction comparison | private positions and numerical thresholds are unavailable |
| Natenberg | `options_relative_value_v1` | surface builder; Greeks-payoff engine | private market-making inventory and execution |
| Sinclair | `volatility_edge_v1` | realized-volatility forecast; net-edge sizing | production models and cost history are proprietary |

## Human-adjudication boundary

The planning hypothesis for a seat may come from the current selector and prompt, but it does
not become attributed doctrine through repetition. Each physical corpus item must follow this
sequence:

1. A locator records the candidate document family without assigning a grade.
2. An acquirer obtains the original artifact and records exact edition, date, section or page,
   content hash, publication time and access limits.
3. Two humans independently determine authorship, context, meaning, applicable scope and
   whether the item may define a rule. Disagreement remains unresolved; it is not averaged.
4. A case reviewer freezes the information set, security, action, horizon and observable
   outcome. Holdings alone do not prove a decision or motive.
5. A policy author may propose a veto or threshold, but source-derived language, empirical
   calibration and editorial choices remain separately labeled.
6. Tool and decision implementations consume typed facts with lineage and fail closed when
   critical inputs are absent.
7. Only the production experiment runner can create signed evaluation artifacts. A build-spec
   edit, source count or reviewer note cannot award `method_model` status.

The validator deliberately rejects URLs in acquisition targets and rejects fields named
`quote`, `excerpt`, `signature`, `reviewer`, `maturity`, `admission_level` or `pack_hash`.
Those belong in separately reviewed corpus or release artifacts, never in this planning file.

## Conversion into physical packs

This inventory is an input to the staging queue, not the staging pack itself. A seat may move
from `spec_only` to a physical v3 staging directory only after its source-acquisition record,
case ledger and tool contracts exist as separate artifacts. It remains outside the production
registry until loader, admission, runtime and signed experiment gates pass. The 26-pack GA
gate therefore continues to fail while this inventory is complete but the physical corpus is
not.
