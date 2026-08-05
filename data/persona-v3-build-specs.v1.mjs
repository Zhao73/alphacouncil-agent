/**
 * Canonical, non-production build specifications for the PersonaPack v3 seats.
 *
 * Nothing in this file is evidence of a named person's method. Every method statement is a
 * planning hypothesis inherited from the current selector/prompt material. Source and case
 * targets are acquisition queues, not citations or completed corpus items. Importing this
 * module must never register a production pack or change a seat's maturity.
 */

import { overlayAuthoredSeat } from "./authored/index.mjs";

const PENDING = "pending_human_adjudication";

function source(personaId, number, sourceFamily, acquisitionTarget) {
  return {
    target_id: `${personaId}.source_${number}`,
    source_family: sourceFamily,
    acquisition_target: acquisitionTarget,
    acquisition_status: "not_started",
    human_adjudication_status: PENDING,
  };
}

function caseTargets({ decision, failure, counterfactual, golden }) {
  return [
    { case_family: "decision", acquisition_target: decision, minimum_count: 5, acquisition_status: "not_started", human_adjudication_status: PENDING },
    { case_family: "failure", acquisition_target: failure, minimum_count: 3, acquisition_status: "not_started", human_adjudication_status: PENDING },
    { case_family: "counterfactual", acquisition_target: counterfactual, minimum_count: 20, acquisition_status: "not_started", human_adjudication_status: PENDING },
    { case_family: "golden", acquisition_target: golden, minimum_count: 12, acquisition_status: "not_started", human_adjudication_status: PENDING },
  ];
}

function buildSpec({
  personaId,
  promptPath,
  legacyV2 = null,
  scope,
  domains,
  excludes,
  facts,
  decision,
  tools,
  vetoes,
  sources,
  cases,
  limits,
}) {
  return {
    persona_id: personaId,
    build_status: "spec_only",
    current_material: {
      prompt_path: promptPath,
      material_level: legacyV2 ? "v2_operator" : "v1_prompt",
      legacy_v2_manifest: legacyV2,
    },
    method_scope: {
      planning_hypothesis: scope,
      applicable_domains: domains,
      excluded_claims: excludes,
    },
    required_fact_types: facts,
    native_decision_contract: {
      schema_id: decision.schemaId,
      implementation_status: "planned_unverified",
      eligibility_facts: decision.eligibility,
      states: decision.states,
      required_outputs: decision.outputs,
      fail_closed_reasons: decision.failClosed,
    },
    planned_dedicated_tools: tools.map(([toolId, purpose, outputFactTypes]) => ({
      tool_id: toolId,
      purpose,
      output_fact_types: outputFactTypes,
      implementation_status: "planned_unverified",
    })),
    veto_families: vetoes.map(([vetoId, candidateRule]) => ({
      veto_id: vetoId,
      candidate_rule: candidateRule,
      human_adjudication_status: PENDING,
    })),
    primary_source_acquisition_targets: sources,
    case_acquisition_targets: caseTargets(cases),
    known_limits: limits,
    human_adjudication: {
      method_attribution: PENDING,
      source_grade: PENDING,
      case_outcomes: PENDING,
      veto_thresholds: PENDING,
      counterfactual_labels: PENDING,
      reviewer_approvals: "none",
      experiment_status: "not_started",
    },
  };
}

const seats = [
  buildSpec({
    personaId: "master_buffett",
    promptPath: "personas/masters/masters-value/buffett.md",
    legacyV2: "knowledge/masters/master_buffett/manifest.json",
    scope: "Evaluate understandable operating businesses through owner earnings, durable competitive advantage, capital allocation and price versus conservative business value.",
    domains: ["operating_businesses", "business_quality", "capital_allocation", "intrinsic_value"],
    excludes: ["businesses outside demonstrable competence", "an imitation of current Berkshire portfolio choices", "unsourced numeric quality thresholds"],
    facts: ["business.model.explainability", "financial.owner_earnings", "financial.incremental_return_on_capital", "financial.leverage", "capital_allocation.share_count", "valuation.expected_owner_return"],
    decision: {
      schemaId: "ownership_candidate_v1",
      eligibility: ["explainable business model", "cycle-normalized owner-earnings inputs", "capital-allocation history"],
      states: ["too_hard", "reject", "watch", "own_at_price"],
      outputs: ["competence boundary", "owner-earnings range", "quality and moat evidence", "maximum ownership price"],
      failClosed: ["business not explainable", "maintenance investment not estimable", "material leverage lineage missing"],
    },
    tools: [
      ["master_buffett.owner_earnings_rebuilder", "Recompute owner earnings with explicit maintenance-investment assumptions.", ["financial.owner_earnings", "financial.maintenance_investment"]],
      ["master_buffett.incremental_returns", "Measure incremental returns and reinvestment economics over complete cycles.", ["financial.incremental_return_on_capital", "financial.reinvestment_rate"]],
    ],
    vetoes: [
      ["master_buffett.outside_competence", "Decline when the business economics cannot be stated and tested."],
      ["master_buffett.leverage_dependency", "Reject quality claims that depend on leverage rather than operating economics."],
      ["master_buffett.owner_earnings_unreliable", "Reject valuation when owner earnings cannot be reconstructed from sourced inputs."],
    ],
    sources: [
      source("master_buffett", 1, "author_signed", "Acquire Berkshire shareholder letters with exact year and paragraph anchors."),
      source("master_buffett", 2, "institutional_primary", "Acquire complete Berkshire annual-meeting records and official interview transcripts where available."),
      source("master_buffett", 3, "public_record", "Acquire contemporaneous filings and transaction records for attributed investment decisions."),
    ],
    cases: {
      decision: "Acquire dated purchases, exits and explicit passes with the public information set frozen at decision time.",
      failure: "Acquire decisions later described as mistakes and separate author admission from external interpretation.",
      counterfactual: "Change leverage, maintenance investment, reinvestment return and purchase price independently.",
      golden: "Construct blinded owner-earnings and capital-allocation cases with human-reviewed expected abstentions." ,
    },
    limits: ["Private negotiations, unpublished valuation work and current portfolio deliberations are not recoverable.", "Berkshire decisions involve Munger, managers and institutional constraints, so attribution to one individual may be indeterminate."],
  }),

  buildSpec({
    personaId: "master_graham",
    promptPath: "personas/masters/masters-value-classic/graham.md",
    scope: "Establish an asset or normalized-earnings floor and require a human-adjudicated margin of safety before taking equity risk.",
    domains: ["deep_value", "asset_backed_securities", "normalized_earnings", "distressed_equity"],
    excludes: ["mechanical use of historical formulas without context", "claims about modern securities absent source support", "a fixed margin-of-safety percentage by editorial choice"],
    facts: ["financial.net_current_asset_value", "financial.tangible_book_value", "financial.normalized_earnings", "financial.balance_sheet_claims", "valuation.liquidation_range", "market.price_to_floor"],
    decision: {
      schemaId: "margin_of_safety_v1",
      eligibility: ["reconstructable asset claims", "normalized earnings or liquidation inputs", "security seniority"],
      states: ["insufficient_floor", "reject", "watch", "margin_of_safety"],
      outputs: ["asset floor", "earnings floor", "margin-of-safety range", "impairment conditions"],
      failClosed: ["off-balance-sheet claims unresolved", "normalization period unsupported", "security rank unknown"],
    },
    tools: [
      ["master_graham.asset_floor", "Rebuild net-current-asset and liquidation floors after senior claims.", ["financial.net_current_asset_value", "valuation.liquidation_range"]],
      ["master_graham.normalized_earnings", "Normalize earnings across a documented cycle without forward leakage.", ["financial.normalized_earnings", "valuation.earnings_floor"]],
    ],
    vetoes: [
      ["master_graham.no_asset_floor", "Decline when assets and senior claims cannot be independently reconstructed."],
      ["master_graham.margin_absent", "Reject when price lacks a reviewed discount to the conservative floor."],
      ["master_graham.deteriorating_floor", "Reject a static bargain whose realizable floor is demonstrably shrinking."],
    ],
    sources: [
      source("master_graham", 1, "published_work", "Acquire author-written editions and revisions of foundational security-analysis works with page anchors."),
      source("master_graham", 2, "author_signed", "Acquire authenticated lectures, articles and testimony attributable to the author."),
      source("master_graham", 3, "public_record", "Acquire contemporaneous filings and market records for documented investment examples."),
    ],
    cases: {
      decision: "Acquire dated security selections and explicit exclusions with reconstructable contemporary statements.",
      failure: "Acquire value traps and formula failures discussed in primary or authenticated records.",
      counterfactual: "Vary recoveries, senior claims, earnings normalization and purchase discount independently.",
      golden: "Construct blinded balance-sheet and normalized-earnings cases spanning industrial and financial issuers.",
    },
    limits: ["Historical accounting standards and disclosure quality differ materially from modern reporting.", "Some commonly repeated Graham rules are later simplifications and require edition-level human attribution."],
  }),

  buildSpec({
    personaId: "master_simons",
    promptPath: "personas/masters/masters-quant/simons.md",
    scope: "Admit only statistically testable signals that survive leakage controls, multiple testing, out-of-sample evaluation, turnover and trading costs.",
    domains: ["systematic_signals", "statistical_arbitrage", "portfolio_research", "execution_costs"],
    excludes: ["Renaissance proprietary signals", "reverse engineering secret production systems", "narrative stock selection attributed to the named investor"],
    facts: ["quant.sample_definition", "quant.signal_values", "quant.out_of_sample_returns", "quant.multiple_test_count", "execution.turnover", "execution.total_cost", "risk.drawdown"],
    decision: {
      schemaId: "out_of_sample_signal_v1",
      eligibility: ["frozen dataset and feature timestamps", "declared hypothesis family", "out-of-sample partition", "cost model"],
      states: ["invalid_test", "no_signal", "research_candidate", "deployable_signal"],
      outputs: ["leakage audit", "multiple-test adjustment", "out-of-sample effect", "net-of-cost stability"],
      failClosed: ["timestamp leakage", "unreported search space", "no independent holdout", "cost model missing"],
    },
    tools: [
      ["master_simons.leakage_audit", "Audit feature, label and split timestamps for look-ahead and survivorship leakage.", ["quant.leakage_flags", "quant.sample_definition"]],
      ["master_simons.oos_cost_test", "Recompute out-of-sample signal performance after multiple tests and costs.", ["quant.out_of_sample_returns", "quant.adjusted_significance", "execution.net_return"]],
    ],
    vetoes: [
      ["master_simons.lookahead", "Reject any result with unresolved future information in features or membership."],
      ["master_simons.no_holdout", "Reject a signal without a genuinely untouched evaluation partition."],
      ["master_simons.cost_erasure", "Reject a signal whose estimated edge does not survive conservative execution costs."],
    ],
    sources: [
      source("master_simons", 1, "author_signed", "Acquire authenticated public lectures, interviews and authored mathematical work relevant to research discipline."),
      source("master_simons", 2, "institutional_primary", "Acquire official institutional descriptions and regulatory disclosures without inferring secret signals."),
      source("master_simons", 3, "public_record", "Acquire public statistical and market datasets suitable for independently reproducible method tests."),
    ],
    cases: {
      decision: "Acquire only public, attributable research decisions with frozen hypotheses and datasets.",
      failure: "Acquire documented overfit, leakage and cost-erasure examples without attributing them to proprietary funds." ,
      counterfactual: "Vary split dates, feature availability, test multiplicity, turnover and costs independently.",
      golden: "Construct synthetic and public-data signal cases with known leakage and overfit traps." ,
    },
    limits: ["Renaissance production data, features, models and execution are proprietary and cannot be reconstructed honestly.", "Public comments support research principles more readily than company-level decision rules."],
  }),

  buildSpec({
    personaId: "master_soros",
    promptPath: "personas/masters/masters-adversarial/soros.md",
    scope: "Map reflexive feedback among price, financing, fundamentals, policy and participant beliefs, then identify the observable break condition.",
    domains: ["global_macro", "reflexivity", "boom_bust", "crowded_trades"],
    excludes: ["private Quantum Fund positioning", "current political or market opinions not in public sources", "point forecasts presented as method doctrine"],
    facts: ["macro.policy_path", "market.price_trend", "credit.financing_conditions", "fundamental.response_to_price", "positioning.crowding", "reflexivity.loop_state"],
    decision: {
      schemaId: "reflexive_loop_v1",
      eligibility: ["identified feedback variables", "dated financing and positioning facts", "observable loop-break condition"],
      states: ["no_loop", "reinforcing", "testing_reversal", "broken"],
      outputs: ["feedback-loop graph", "bias and fundamentals interaction", "reversal trigger", "position invalidation"],
      failClosed: ["feedback direction not observable", "positioning unavailable", "no falsifiable reversal trigger"],
    },
    tools: [
      ["master_soros.reflexivity_graph", "Build a dated causal graph linking prices, credit, behavior and fundamentals.", ["reflexivity.loop_state", "reflexivity.feedback_strength"]],
      ["master_soros.reversal_monitor", "Score observable breaks in the reinforcing loop without inventing probabilities.", ["reflexivity.break_signals", "positioning.crowding"]],
    ],
    vetoes: [
      ["master_soros.no_reflexive_link", "Reject a reflexivity thesis that cannot show feedback from price to fundamentals."],
      ["master_soros.unfinanceable_timing", "Reject a position that cannot survive before the loop is expected to break."],
      ["master_soros.no_reversal_signal", "Reject a trade thesis with no observable condition for admitting the loop changed."],
    ],
    sources: [
      source("master_soros", 1, "published_work", "Acquire author-written books and essays with edition and page-level anchors."),
      source("master_soros", 2, "author_signed", "Acquire authenticated speeches, lectures and interviews with full context."),
      source("master_soros", 3, "public_record", "Acquire contemporaneous policy, market and financing records for documented episodes."),
    ],
    cases: {
      decision: "Acquire dated public descriptions of macro theses with information sets frozen before resolution.",
      failure: "Acquire primary admissions of errors, timing failures or changed theses and separate them from biographies." ,
      counterfactual: "Reverse price-fundamental feedback, financing availability, policy response and crowding independently.",
      golden: "Construct blinded boom-bust cases where feedback exists, is absent or has already broken." ,
    },
    limits: ["Historic trade details and risk management were often private, incomplete or jointly determined by a fund team.", "Reflexivity can become an unfalsifiable narrative unless variables and break signals are specified before outcomes."],
  }),

  buildSpec({
    personaId: "master_cathie_wood",
    promptPath: "personas/masters/masters-modern/cathie_wood.md",
    scope: "Connect technology cost curves and adoption to addressable market, company capture, unit economics and an explicit five-year valuation distribution.",
    domains: ["disruptive_innovation", "technology_adoption", "platform_convergence", "growth_valuation"],
    excludes: ["current ARK trades not established by dated public records", "unbounded total-addressable-market narratives", "single-path five-year price targets"],
    facts: ["technology.cost_curve", "technology.adoption_rate", "market.addressable_units", "company.capture_rate", "economics.unit_margin", "valuation.scenario_distribution"],
    decision: {
      schemaId: "innovation_adoption_scenario_v1",
      eligibility: ["dated cost and adoption series", "company capture bridge", "unit economics", "current enterprise value"],
      states: ["unsupported_theme", "overpriced_adoption", "watch", "asymmetric_innovation"],
      outputs: ["cost-curve fit", "adoption scenarios", "company capture bridge", "five-year return distribution"],
      failClosed: ["theme not linked to company economics", "adoption data absent", "dilution or capital needs unresolved"],
    },
    tools: [
      ["master_cathie_wood.cost_adoption_curve", "Fit versioned cost and adoption curves with uncertainty bands.", ["technology.cost_curve", "technology.adoption_rate"]],
      ["master_cathie_wood.capture_valuation_bridge", "Translate sector adoption into company revenue, cash needs and valuation scenarios.", ["company.capture_rate", "economics.unit_margin", "valuation.scenario_distribution"]],
    ],
    vetoes: [
      ["master_cathie_wood.theme_company_gap", "Reject when sector growth has no evidenced bridge to company cash flows."],
      ["master_cathie_wood.capital_need_gap", "Reject when required funding and dilution cannot be bounded."],
      ["master_cathie_wood.adoption_already_priced", "Reject constructive output when price requires adoption beyond the reviewed scenario range."],
    ],
    sources: [
      source("master_cathie_wood", 1, "institutional_primary", "Acquire signed ARK research with model versions, assumptions and revision history."),
      source("master_cathie_wood", 2, "author_signed", "Acquire complete public presentations and interviews attributable to the named investor."),
      source("master_cathie_wood", 3, "public_record", "Acquire dated fund disclosures, issuer filings and industry adoption datasets for attributed cases."),
    ],
    cases: {
      decision: "Acquire dated public theses and position changes without inferring undisclosed reasons." ,
      failure: "Acquire resolved adoption, competition and funding misses with contemporaneous model assumptions." ,
      counterfactual: "Vary learning rates, adoption, company capture, margins, dilution and terminal assumptions independently." ,
      golden: "Construct blinded innovation cases that separate theme success from company economics and price." ,
    },
    limits: ["Fund holdings disclose positions but not the complete decision process or intra-period trading rationale.", "Published thematic models may change; version and as-of discipline is required to prevent hindsight substitution."],
  }),

  buildSpec({
    personaId: "master_druckenmiller",
    promptPath: "personas/masters/masters-adversarial/druckenmiller.md",
    scope: "Identify liquid macro and company inflections through liquidity, earnings revisions, price confirmation and asymmetric risk over a forward horizon.",
    domains: ["global_macro", "liquidity", "earnings_inflections", "concentrated_positioning"],
    excludes: ["private current positions", "copying anecdotal trade sizes", "market-direction calls without a falsifiable driver map"],
    facts: ["macro.liquidity_impulse", "earnings.revision_breadth", "market.price_confirmation", "macro.forward_inflection", "risk.downside_path", "portfolio.correlation"],
    decision: {
      schemaId: "macro_inflection_v1",
      eligibility: ["dated liquidity regime", "revision series", "price confirmation", "defined downside"],
      states: ["no_inflection", "watch", "probing", "asymmetric_setup"],
      outputs: ["driver hierarchy", "forward inflection thesis", "price confirmation", "sizing constraint"],
      failClosed: ["no dominant driver", "price contradicts thesis without explanation", "downside unbounded"],
    },
    tools: [
      ["master_druckenmiller.liquidity_revision_map", "Combine liquidity impulse and earnings revisions on a point-in-time basis.", ["macro.liquidity_impulse", "earnings.revision_breadth"]],
      ["master_druckenmiller.inflection_payoff", "Map confirmation, downside and time-to-inflection into an asymmetric payoff record.", ["macro.forward_inflection", "risk.payoff_asymmetry"]],
    ],
    vetoes: [
      ["master_druckenmiller.driver_ambiguity", "Decline when no dominant forward driver can be identified and monitored."],
      ["master_druckenmiller.price_nonconfirmation", "Reject concentration when price action persistently contradicts the stated inflection."],
      ["master_druckenmiller.asymmetry_absent", "Reject when plausible downside is not bounded relative to the forward payoff."],
    ],
    sources: [
      source("master_druckenmiller", 1, "author_signed", "Acquire full public speeches, interviews and conference discussions with dates and context."),
      source("master_druckenmiller", 2, "institutional_primary", "Acquire official macro, liquidity and earnings-revision datasets needed to test stated principles."),
      source("master_druckenmiller", 3, "public_record", "Acquire contemporaneous market records for publicly documented episodes without inferring undisclosed trades."),
    ],
    cases: {
      decision: "Acquire dated public macro calls where drivers, horizon and later observable outcomes can be frozen." ,
      failure: "Acquire attributable admissions of timing or thesis errors rather than retrospective third-party stories." ,
      counterfactual: "Vary liquidity, revisions, price confirmation, horizon and downside asymmetry independently." ,
      golden: "Construct blinded inflection cases across policy, earnings and commodity regimes." ,
    },
    limits: ["Duquesne position books, entry timing and risk limits are private and cannot be reconstructed from interviews.", "Public comments may be selective and retrospective, creating survivorship and narrative bias."],
  }),

  buildSpec({
    personaId: "master_fisher",
    promptPath: "personas/masters/masters-value-classic/fisher.md",
    scope: "Assess long-duration growth quality through multi-party scuttlebutt, research productivity, sales capability, management depth and reinvestment runway.",
    domains: ["growth_quality", "scuttlebutt", "research_productivity", "management_depth"],
    excludes: ["private channel checks", "unsourced supplier or customer claims", "treating reputation as evidence of growth quality"],
    facts: ["research.productivity", "sales.organization_quality", "customer.retention", "supplier.relationships", "management.depth", "financial.reinvestment_runway"],
    decision: {
      schemaId: "scuttlebutt_quality_v1",
      eligibility: ["multiple independent public stakeholder sources", "research and sales evidence", "management-depth history"],
      states: ["insufficient_scuttlebutt", "reject", "watch", "long_duration_quality"],
      outputs: ["stakeholder triangulation", "research productivity", "management depth", "growth-quality failure conditions"],
      failClosed: ["single-source stakeholder evidence", "private or unattributable channel claim", "no management-depth evidence"],
    },
    tools: [
      ["master_fisher.scuttlebutt_graph", "Triangulate dated public customer, supplier, competitor and employee evidence.", ["scuttlebutt.source_independence", "customer.retention", "supplier.relationships"]],
      ["master_fisher.research_productivity", "Relate research investment and product cadence to economic returns.", ["research.productivity", "financial.reinvestment_runway"]],
    ],
    vetoes: [
      ["master_fisher.single_source_story", "Decline when stakeholder claims do not have independent public corroboration."],
      ["master_fisher.management_depth_gap", "Reject long-duration quality when management depth cannot be evidenced."],
      ["master_fisher.research_without_return", "Reject growth quality when research spending lacks observable product or economic output."],
    ],
    sources: [
      source("master_fisher", 1, "published_work", "Acquire author-written works with edition and page-level method anchors."),
      source("master_fisher", 2, "author_signed", "Acquire authenticated articles, talks and interviews attributable to the author."),
      source("master_fisher", 3, "public_record", "Acquire issuer, customer, supplier and competitor records for documented investment cases."),
    ],
    cases: {
      decision: "Acquire attributable company decisions with contemporaneous public stakeholder evidence." ,
      failure: "Acquire growth-quality failures involving research, management depth or stakeholder evidence." ,
      counterfactual: "Remove one stakeholder class, reverse research output or shorten the runway while holding price fixed." ,
      golden: "Construct blinded public-only scuttlebutt cases with controlled source independence." ,
    },
    limits: ["The original scuttlebutt method relied on private conversations that this product cannot reproduce.", "Public stakeholder statements may share issuer messaging and must not be counted as independent without lineage review."],
  }),

  buildSpec({
    personaId: "master_munger",
    promptPath: "personas/masters/masters-value/munger.md",
    scope: "Invert the thesis, map permanent-loss paths, audit incentives and test coupled risks using cross-disciplinary causal models.",
    domains: ["business_quality", "incentives", "failure_analysis", "capital_allocation"],
    excludes: ["personality imitation", "invented multidisciplinary analogies presented as doctrine", "a directional rating when only a veto analysis is supported"],
    facts: ["governance.incentive_structure", "risk.failure_paths", "risk.permanent_loss", "business.complexity", "capital_allocation.history", "decision.coupled_assumptions"],
    decision: {
      schemaId: "failure_path_verdict_v1",
      eligibility: ["documented incentives", "testable failure paths", "capital-allocation history"],
      states: ["out_of_scope", "fatal_path", "monitor", "no_fatal_path_found"],
      outputs: ["failure-path table", "incentive audit", "coupled-risk map", "fatal versus monitorable classification"],
      failClosed: ["incentives unavailable", "permanent-loss severity cannot be bounded", "failure paths lack observable triggers"],
    },
    tools: [
      ["master_munger.incentive_map", "Map compensation and control rights to potentially destructive operating choices.", ["governance.incentive_structure", "governance.incentive_conflicts"]],
      ["master_munger.failure_path_graph", "Model interacting failure paths and permanent-loss severity.", ["risk.failure_paths", "decision.coupled_assumptions", "risk.permanent_loss"]],
    ],
    vetoes: [
      ["master_munger.fatal_incentive", "Reject when incentives reward a documented path to permanent business damage."],
      ["master_munger.coupled_failure", "Reject when several required assumptions fail through one shared cause."],
      ["master_munger.unbounded_permanent_loss", "Reject when a plausible failure path creates unbounded permanent loss."],
    ],
    sources: [
      source("master_munger", 1, "author_signed", "Acquire authenticated speeches, essays and official meeting records with exact anchors."),
      source("master_munger", 2, "institutional_primary", "Acquire Berkshire and Wesco shareholder communications attributable to the named investor."),
      source("master_munger", 3, "public_record", "Acquire filings and transaction records for documented business and capital-allocation cases."),
    ],
    cases: {
      decision: "Acquire attributable acquisitions, passes and capital-allocation decisions with dated source anchors." ,
      failure: "Acquire decisions explicitly described as mistakes and adjudicate individual versus joint attribution." ,
      counterfactual: "Reverse incentives, uncouple failure paths, change complexity and alter downside recoverability." ,
      golden: "Construct blinded incentive and failure-path cases where abstention is a valid expected state." ,
    },
    limits: ["Many decisions were jointly made with Buffett or operating managers, so individual attribution may remain unresolved.", "Cross-disciplinary examples are abundant in talks but do not automatically define executable investment thresholds."],
  }),

  buildSpec({
    personaId: "master_thorp",
    promptPath: "personas/masters/masters-quant/thorp.md",
    scope: "Independently estimate edge and odds, then constrain Kelly-style sizing by estimation error, dependence, liquidity and risk of ruin.",
    domains: ["probabilistic_edge", "position_sizing", "arbitrage", "risk_of_ruin"],
    excludes: ["proprietary historical trading rules", "full-Kelly prescriptions without uncertainty", "odds invented from narrative confidence"],
    facts: ["probability.outcome_distribution", "trade.payoff_distribution", "trade.edge", "portfolio.dependence", "execution.liquidity", "risk.ruin_probability", "position.fraction"],
    decision: {
      schemaId: "edge_sizing_v1",
      eligibility: ["recomputable payoff distribution", "probability basis", "liquidity and dependence inputs"],
      states: ["no_measurable_edge", "positive_edge_no_size", "fractional_position", "out_of_scope"],
      outputs: ["edge estimate", "uncertainty interval", "fractional sizing cap", "risk-of-ruin stress"],
      failClosed: ["outcome probabilities not supportable", "dependence unknown", "liquidity insufficient", "ruin constraint breached"],
    },
    tools: [
      ["master_thorp.edge_recalculator", "Recompute expected payoff from explicit outcomes and probability ranges.", ["trade.edge", "probability.outcome_distribution"]],
      ["master_thorp.fractional_kelly", "Calculate a conservative sizing range after uncertainty, dependence and ruin limits.", ["position.fraction", "risk.ruin_probability"]],
    ],
    vetoes: [
      ["master_thorp.no_measurable_edge", "Reject when edge cannot be independently recomputed from explicit outcomes."],
      ["master_thorp.ruin_constraint", "Reject sizing that permits an absorbing loss under plausible dependence."],
      ["master_thorp.liquidity_constraint", "Reject a theoretical size that cannot be entered and exited at modeled costs."],
    ],
    sources: [
      source("master_thorp", 1, "published_work", "Acquire author-written books and papers with exact edition and equation anchors."),
      source("master_thorp", 2, "author_signed", "Acquire authenticated lectures and interviews discussing edge and sizing discipline."),
      source("master_thorp", 3, "public_record", "Acquire reproducible market and event datasets for non-proprietary sizing cases."),
    ],
    cases: {
      decision: "Acquire public, attributable edge or sizing examples with enough inputs for independent recomputation." ,
      failure: "Acquire documented estimation, correlation or implementation failures without imputing proprietary fund results." ,
      counterfactual: "Vary odds, payoff, estimation error, dependence, liquidity and fractional-Kelly caps." ,
      golden: "Construct blinded games, arbitrage and event cases with known probability and ruin properties." ,
    },
    limits: ["Historical hedge-fund signals, portfolio interactions and execution details are proprietary.", "Published examples often simplify estimation error and market impact relative to production trading."],
  }),

  buildSpec({
    personaId: "master_asness",
    promptPath: "personas/masters/masters-quant/asness.md",
    scope: "Decompose returns into value, momentum, quality, beta, sector and crowding exposures before treating residual performance as alpha.",
    domains: ["factor_investing", "portfolio_attribution", "style_cycles", "crowding"],
    excludes: ["AQR proprietary live models", "factor definitions without versioned formulas", "calling residual noise manager skill"],
    facts: ["factor.value_exposure", "factor.momentum_exposure", "factor.quality_exposure", "factor.beta_exposure", "factor.sector_exposure", "factor.crowding", "return.factor_adjusted"],
    decision: {
      schemaId: "factor_adjusted_alpha_v1",
      eligibility: ["versioned factor definitions", "point-in-time constituents", "cost and rebalance assumptions"],
      states: ["unidentified_exposure", "factor_replication", "mixed", "residual_candidate"],
      outputs: ["factor decomposition", "crowding and regime stress", "factor-adjusted return", "implementation cost"],
      failClosed: ["factor definition missing", "constituent leakage", "costs omitted", "residual unstable"],
    },
    tools: [
      ["master_asness.factor_decomposer", "Estimate versioned factor, beta and sector exposures from point-in-time data.", ["factor.value_exposure", "factor.momentum_exposure", "factor.quality_exposure", "factor.beta_exposure", "factor.sector_exposure"]],
      ["master_asness.crowding_cost_stress", "Stress factor returns for crowding, turnover and trading costs.", ["factor.crowding", "return.factor_adjusted", "execution.total_cost"]],
    ],
    vetoes: [
      ["master_asness.undefined_factor", "Reject attribution when factor construction is not versioned and reproducible."],
      ["master_asness.factor_replication", "Reject an alpha claim fully explained by cheap systematic exposures."],
      ["master_asness.crowding_cost", "Reject an implementable-edge claim erased by crowding and costs."],
    ],
    sources: [
      source("master_asness", 1, "author_signed", "Acquire signed research notes and public commentary with version and date anchors."),
      source("master_asness", 2, "published_work", "Acquire authored academic and practitioner papers with formula-level anchors."),
      source("master_asness", 3, "institutional_primary", "Acquire official factor datasets and methodology documents suitable for replication."),
    ],
    cases: {
      decision: "Acquire dated public factor views and allocation examples with definitions frozen before outcomes." ,
      failure: "Acquire attributable factor drawdown and crowding analyses, including stated model limitations." ,
      counterfactual: "Change factor definitions, neutralization, costs, crowding and rebalance intervals independently." ,
      golden: "Construct blinded portfolios with known factor replicas, residuals and leakage traps." ,
    },
    limits: ["AQR production signals, risk models and trade implementation are proprietary.", "Factor labels are definition-sensitive; incompatible vendor constructions cannot be pooled without adjudication."],
  }),

  buildSpec({
    personaId: "master_dalio",
    promptPath: "personas/masters/masters-adversarial/dalio.md",
    scope: "Classify growth, inflation, debt-cycle and policy regimes, then evaluate refinancing exposure and concentration across common macro drivers.",
    domains: ["macro_regimes", "debt_cycles", "cross_asset_risk", "portfolio_balance"],
    excludes: ["Bridgewater proprietary signals", "fixed historical-cycle analogies", "current fund positioning inferred from public commentary"],
    facts: ["macro.growth_regime", "macro.inflation_regime", "macro.policy_stance", "credit.debt_service", "credit.maturity_schedule", "portfolio.driver_exposure", "macro.analogue_distance"],
    decision: {
      schemaId: "regime_balance_v1",
      eligibility: ["dated growth, inflation and policy facts", "debt maturity and repricing data", "portfolio driver map"],
      states: ["regime_unknown", "fragile", "unbalanced", "regime_resilient"],
      outputs: ["regime classification", "debt-service stress", "driver concentration", "historical analogue differences"],
      failClosed: ["regime facts conflict", "refinancing schedule missing", "portfolio drivers unknown"],
    },
    tools: [
      ["master_dalio.regime_classifier", "Classify point-in-time growth, inflation and policy states with uncertainty.", ["macro.growth_regime", "macro.inflation_regime", "macro.policy_stance"]],
      ["master_dalio.debt_driver_stress", "Stress debt service and portfolio concentration across macro quadrants.", ["credit.debt_service", "portfolio.driver_exposure", "macro.analogue_distance"]],
    ],
    vetoes: [
      ["master_dalio.refinancing_break", "Reject resilience when refinancing at current conditions breaches documented capacity."],
      ["master_dalio.hidden_driver_concentration", "Reject diversification claims when holdings share one material macro driver."],
      ["master_dalio.false_analogue", "Reject a historical analogy that omits material structural differences."],
    ],
    sources: [
      source("master_dalio", 1, "published_work", "Acquire author-written books and papers with version and section anchors."),
      source("master_dalio", 2, "institutional_primary", "Acquire signed Bridgewater research released publicly with complete context."),
      source("master_dalio", 3, "public_record", "Acquire central-bank, fiscal, debt and cross-asset datasets for reproducible regime cases."),
    ],
    cases: {
      decision: "Acquire public regime and debt-cycle calls with frozen inputs and defined horizons." ,
      failure: "Acquire attributable analogue, policy-response and risk-balance misses rather than third-party narratives." ,
      counterfactual: "Move growth, inflation, policy, debt repricing and cross-asset correlations independently." ,
      golden: "Construct blinded macro quadrants and refinancing cases with explicit structural breaks." ,
    },
    limits: ["Bridgewater production models, portfolio weights and believability systems are proprietary.", "Long-cycle dating is inherently uncertain and cannot be converted into precise deterministic thresholds by citation alone."],
  }),

  buildSpec({
    personaId: "master_duan_yongping",
    promptPath: "personas/masters/masters-value/duan_yongping.md",
    legacyV2: "knowledge/masters/master_duan_yongping/manifest.json",
    scope: "Evaluate a simple business model through user value, corporate culture, management integrity, long-run economics and opportunity cost.",
    domains: ["consumer_businesses", "product_value", "corporate_culture", "opportunity_cost"],
    excludes: ["private views or holdings", "culture scores invented by the model", "translation of informal posts into hard thresholds without adjudication"],
    facts: ["business.model.explainability", "product.user_value", "culture.integrity_events", "management.promise_record", "financial.long_run_economics", "portfolio.opportunity_cost"],
    decision: {
      schemaId: "user_value_owner_decision_v1",
      eligibility: ["one-sentence business model", "public user-value evidence", "management action record", "comparison asset"],
      states: ["do_not_understand", "reject", "wait", "act_at_price"],
      outputs: ["business-model statement", "user-value evidence", "culture and integrity record", "opportunity-cost comparison"],
      failClosed: ["business model not explainable", "culture evidence absent", "comparison opportunity undefined"],
    },
    tools: [
      ["master_duan_yongping.user_value_evidence", "Triangulate public product, retention, complaint and channel evidence without private data.", ["product.user_value", "product.user_value_conflicts"]],
      ["master_duan_yongping.opportunity_cost", "Compare expected owner return with a frozen incumbent or cash alternative.", ["portfolio.opportunity_cost", "valuation.expected_owner_return"]],
    ],
    vetoes: [
      ["master_duan_yongping.not_understood", "Decline when the long-run money-making mechanism cannot be explained."],
      ["master_duan_yongping.integrity_breach", "Reject on a human-adjudicated material integrity breach."],
      ["master_duan_yongping.user_value_absent", "Reject when revenue growth lacks public evidence of durable user value."],
    ],
    sources: [
      source("master_duan_yongping", 1, "author_signed", "Acquire authenticated signed posts with archived timestamps and complete conversation context."),
      source("master_duan_yongping", 2, "author_signed", "Acquire official university talks and interviews with complete recordings or transcripts."),
      source("master_duan_yongping", 3, "public_record", "Acquire issuer filings and disclosed holdings only as case leads, not proof of motive."),
    ],
    cases: {
      decision: "Acquire dated public investment explanations and explicit passes with authorship and timestamp adjudicated." ,
      failure: "Acquire attributable discussions of mistakes, changed views and cultural failures." ,
      counterfactual: "Change user value, integrity evidence, business-model clarity, price and comparison opportunity independently." ,
      golden: "Construct bilingual blinded cases that test abstention, culture evidence and opportunity cost." ,
    },
    limits: ["Signed social posts are conversational, editable and unevenly archived; authorship and context require manual review.", "Public holdings do not reveal purchase price, full rationale, portfolio constraints or current intent."],
  }),

  buildSpec({
    personaId: "master_jhunjhunwala",
    promptPath: "personas/masters/masters-modern/jhunjhunwala.md",
    scope: "Evaluate Indian structural growth through promoter governance, cash quality, addressable penetration, scaling economics, valuation and liquidity.",
    domains: ["india_equities", "structural_penetration", "promoter_governance", "concentrated_growth"],
    excludes: ["private promoter conversations", "current views after the investor's death", "holding disclosures treated as complete investment rationales"],
    facts: ["india.industry_penetration", "governance.promoter_ownership", "governance.related_party_transactions", "financial.cash_conversion", "business.scaling_economics", "market.liquidity", "valuation.expected_return"],
    decision: {
      schemaId: "india_growth_governance_v1",
      eligibility: ["Indian regulatory filings", "promoter and related-party record", "cash conversion and liquidity series"],
      states: ["insufficient_governance", "reject", "watch", "concentrated_growth_candidate"],
      outputs: ["penetration runway", "promoter-governance audit", "cash-quality bridge", "liquidity-constrained position range"],
      failClosed: ["promoter control unresolved", "related-party records incomplete", "market liquidity insufficient"],
    },
    tools: [
      ["master_jhunjhunwala.promoter_governance", "Rebuild promoter ownership, pledges and related-party activity from dated filings.", ["governance.promoter_ownership", "governance.related_party_transactions", "governance.promoter_pledges"]],
      ["master_jhunjhunwala.penetration_liquidity", "Model structural penetration and a liquidity-constrained position range.", ["india.industry_penetration", "business.scaling_economics", "market.liquidity"]],
    ],
    vetoes: [
      ["master_jhunjhunwala.promoter_integrity", "Reject on a reviewed material promoter-governance breach."],
      ["master_jhunjhunwala.cash_conversion", "Reject scaling claims not supported by cycle-aware cash conversion."],
      ["master_jhunjhunwala.liquidity_limit", "Reject concentration that cannot be exited under stressed Indian-market liquidity."],
    ],
    sources: [
      source("master_jhunjhunwala", 1, "author_signed", "Acquire authenticated public speeches and interviews dated during the investor's lifetime."),
      source("master_jhunjhunwala", 2, "public_record", "Acquire Indian exchange shareholding, pledge, bulk-deal and corporate-action records."),
      source("master_jhunjhunwala", 3, "institutional_primary", "Acquire issuer annual reports, governance disclosures and investor materials for case reconstruction."),
    ],
    cases: {
      decision: "Acquire dated disclosed holdings and attributable explanations without inferring undisclosed motives." ,
      failure: "Acquire governance, liquidity and growth failures discussed in attributable public records." ,
      counterfactual: "Vary penetration, promoter governance, cash conversion, scaling and liquidity independently." ,
      golden: "Construct blinded Indian-market cases with promoter, related-party and liquidity traps." ,
    },
    limits: ["The investor died in 2022, so no current or future view can be attributed to him.", "Promoter conversations and much of the original decision process were private; public holdings are incomplete proxies."],
  }),

  buildSpec({
    personaId: "master_lynch",
    promptPath: "personas/masters/masters-value-classic/lynch.md",
    scope: "Classify the company type first, test a concise evidence-backed story, then apply category-appropriate growth, balance-sheet and valuation checks.",
    domains: ["consumer_observation", "growth_categories", "cyclicals", "turnarounds", "asset_plays"],
    excludes: ["using PEG identically across all company categories", "anecdotal product popularity without company economics", "Fidelity's private research process"],
    facts: ["company.category", "business.two_minute_story", "financial.growth_rate", "valuation.peg_contextual", "financial.inventory", "business.unit_expansion", "cycle.position"],
    decision: {
      schemaId: "category_story_decision_v1",
      eligibility: ["reviewed company category", "testable two-minute story", "category-specific financial series"],
      states: ["story_invalid", "category_mismatch", "watch", "category_opportunity"],
      outputs: ["category", "two-minute story", "category-specific checklist", "story breakpoints"],
      failClosed: ["category unresolved", "story lacks falsifiable facts", "category-specific data missing"],
    },
    tools: [
      ["master_lynch.category_classifier", "Classify company type from point-in-time operating and financial evidence.", ["company.category", "company.category_confidence"]],
      ["master_lynch.story_numbers_check", "Test the concise story against category-specific growth, inventory, units and valuation.", ["business.two_minute_story", "valuation.peg_contextual", "business.unit_expansion"]],
    ],
    vetoes: [
      ["master_lynch.category_error", "Decline when the company cannot be placed in a reviewed category."],
      ["master_lynch.story_numbers_conflict", "Reject when the operating facts contradict the concise investment story."],
      ["master_lynch.inventory_or_balance_sheet", "Reject category opportunities with an adjudicated balance-sheet or inventory break."],
    ],
    sources: [
      source("master_lynch", 1, "published_work", "Acquire author-written books and articles with edition and page anchors."),
      source("master_lynch", 2, "author_signed", "Acquire authenticated Fidelity-era interviews, speeches and shareholder communications."),
      source("master_lynch", 3, "public_record", "Acquire contemporaneous filings and fund disclosures for documented company examples."),
    ],
    cases: {
      decision: "Acquire dated company examples and passes with category and contemporary facts reconstructed." ,
      failure: "Acquire documented category mistakes, story breaks and balance-sheet failures." ,
      counterfactual: "Change category, unit expansion, inventory, growth, valuation and story evidence independently." ,
      golden: "Construct blinded slow-grower, stalwart, fast-grower, cyclical, turnaround and asset-play cases." ,
    },
    limits: ["Historic Fidelity research, trade timing and portfolio constraints are not fully public.", "Familiar consumer products can create anecdotal bias; public observation is a research lead, not evidence by itself."],
  }),

  buildSpec({
    personaId: "master_forensic_short",
    promptPath: "personas/masters/masters-adversarial/forensic_short.md",
    scope: "A non-celebrity specialist method that combines accounting reconstruction, governance evidence, borrow economics and a verifiable catalyst path.",
    domains: ["forensic_accounting", "governance_red_flags", "shortability", "catalyst_analysis"],
    excludes: ["defamation by insinuation", "anonymous allegations treated as facts", "a claim to represent one famous short seller"],
    facts: ["accounting.cash_conversion", "accounting.accruals", "governance.related_parties", "accounting.audit_changes", "short.borrow_cost", "short.borrow_availability", "catalyst.verifiability"],
    decision: {
      schemaId: "forensic_shortability_v1",
      eligibility: ["primary filings and notes", "rederived accounting signals", "live borrow facts", "observable catalyst"],
      states: ["unsupported_allegation", "red_flags_no_trade", "watch", "forensic_short_candidate"],
      outputs: ["red-flag ledger", "benign-alternative tests", "borrow and carry", "catalyst and squeeze conditions"],
      failClosed: ["primary documents absent", "benign alternatives untested", "borrow unavailable", "no falsifiable catalyst"],
    },
    tools: [
      ["master_forensic_short.accounting_rebuilder", "Recompute cash conversion, accrual and related-party indicators from primary filings.", ["accounting.cash_conversion", "accounting.accruals", "governance.related_parties"]],
      ["master_forensic_short.borrow_catalyst", "Combine dated borrow availability, cost, crowding and catalyst timing.", ["short.borrow_cost", "short.borrow_availability", "short.squeeze_risk", "catalyst.verifiability"]],
    ],
    vetoes: [
      ["master_forensic_short.no_primary_evidence", "Reject any allegation not anchored in an opened primary document."],
      ["master_forensic_short.borrow_unavailable", "Reject a short recommendation that cannot be borrowed on modeled terms."],
      ["master_forensic_short.no_catalyst", "Reject a costly structural short without an observable resolution path."],
    ],
    sources: [
      source("master_forensic_short", 1, "institutional_primary", "Acquire issuer filings, audit reports and regulator enforcement records."),
      source("master_forensic_short", 2, "author_signed", "Acquire signed public short reports as hypotheses whose claims are independently rederived."),
      source("master_forensic_short", 3, "public_record", "Acquire dated borrow, corporate-action, court and exchange records for tradeability and resolution."),
    ],
    cases: {
      decision: "Acquire public forensic theses with claims, borrow conditions and catalysts frozen before resolution." ,
      failure: "Acquire false positives, squeezes, borrow recalls and benign accounting explanations." ,
      counterfactual: "Reverse accruals, related parties, audit changes, borrow cost, crowding and catalyst timing." ,
      golden: "Construct blinded forensic cases containing both actual red flags and plausible benign alternatives." ,
    },
    limits: ["Borrow availability and cost are broker- and time-specific and may lack durable public history.", "This is a synthetic professional method seat, not a model of any one person, and source traditions may conflict."],
  }),

  buildSpec({
    personaId: "master_li_lu",
    promptPath: "personas/masters/masters-value/li_lu.md",
    scope: "Judge ten-year business certainty, management integrity, structural social value, permanent-loss risk and price-implied long-run return.",
    domains: ["long_duration_quality", "management_integrity", "structural_growth", "capital_preservation"],
    excludes: ["Himalaya private portfolio reasoning", "holdings treated as proof of motive", "binary integrity labels without reviewed evidence"],
    facts: ["business.ten_year_durability", "industry.structural_direction", "management.promise_record", "governance.integrity_events", "capital_allocation.history", "valuation.long_run_return"],
    decision: {
      schemaId: "ten_year_certainty_decision_v1",
      eligibility: ["ten-year industry evidence", "management promise-versus-action history", "capital-allocation record"],
      states: ["do_not_understand", "integrity_reject", "watch", "long_duration_owner"],
      outputs: ["ten-year durability case", "integrity ledger", "permanent-loss paths", "price-implied long-run return"],
      failClosed: ["structural direction unknowable", "management history missing", "material integrity claim unresolved"],
    },
    tools: [
      ["master_li_lu.promise_integrity_ledger", "Compare dated management commitments with later public outcomes.", ["management.promise_record", "governance.integrity_events"]],
      ["master_li_lu.ten_year_return_bridge", "Translate durable economics and price into a conditional long-run return range.", ["business.ten_year_durability", "valuation.long_run_return"]],
    ],
    vetoes: [
      ["master_li_lu.integrity_breach", "Reject only after human adjudication of a material management integrity breach."],
      ["master_li_lu.structural_decline", "Reject a low price when the reviewed industry path is structural decline rather than a cycle."],
      ["master_li_lu.ten_year_unknowable", "Decline when the business depends on a technology or policy path the pack cannot assess."],
    ],
    sources: [
      source("master_li_lu", 1, "author_signed", "Acquire authenticated speeches, essays and public interviews with complete context."),
      source("master_li_lu", 2, "institutional_primary", "Acquire official educational or institutional publications attributable to the author."),
      source("master_li_lu", 3, "public_record", "Acquire regulatory holdings and issuer records only as case leads and outcome evidence."),
    ],
    cases: {
      decision: "Acquire dated public investment explanations and explicit long-horizon principles tied to cases." ,
      failure: "Acquire attributable errors, exits or changed theses without relying on rumor." ,
      counterfactual: "Change industry direction, management integrity, capital allocation, durability and price independently." ,
      golden: "Construct blinded ten-year cases separating cyclical weakness from structural decline." ,
    },
    limits: ["Himalaya's investment letters, analyses, entry prices and portfolio deliberations are largely private.", "Public holding reports cannot establish the named investor's complete thesis, time horizon or exit conditions."],
  }),

  buildSpec({
    personaId: "master_marks",
    promptPath: "personas/masters/masters-value-classic/marks.md",
    legacyV2: "knowledge/masters/master_marks/manifest.json",
    scope: "Calibrate aggressiveness to cycle temperature, consensus, price-implied expectations, credit conditions and permanent-loss risk rather than point forecasting.",
    domains: ["credit_cycles", "distressed_value", "market_psychology", "risk_posture"],
    excludes: ["Oaktree private positions", "precise cycle timing", "generic volatility treated as permanent-loss risk"],
    facts: ["cycle.valuation_percentile", "cycle.credit_conditions", "cycle.investor_behavior", "expectations.consensus", "valuation.implied_expectations", "risk.permanent_loss"],
    decision: {
      schemaId: "cycle_risk_posture_v1",
      eligibility: ["dated valuation and credit distributions", "consensus evidence", "permanent-loss range"],
      states: ["cycle_unknown", "defensive", "balanced", "aggressive"],
      outputs: ["cycle-temperature dashboard", "consensus gap", "permanent-loss range", "risk posture"],
      failClosed: ["cycle distributions unavailable", "consensus not measurable", "permanent-loss path unresolved"],
    },
    tools: [
      ["master_marks.cycle_temperature", "Combine valuation, credit and behavior into a transparent cycle-temperature record.", ["cycle.valuation_percentile", "cycle.credit_conditions", "cycle.investor_behavior"]],
      ["master_marks.implied_expectations", "Recompute what price and spreads imply before forming a second-level view.", ["valuation.implied_expectations", "expectations.consensus"]],
    ],
    vetoes: [
      ["master_marks.euphoria", "Block aggressive posture when reviewed credit and behavior evidence indicate euphoria."],
      ["master_marks.consensus_only", "Reject a thesis that does not differ from what price already implies."],
      ["master_marks.unbounded_impairment", "Reject when a plausible path produces unbounded permanent capital loss."],
    ],
    sources: [
      source("master_marks", 1, "author_signed", "Acquire signed Oaktree memos with publication dates and paragraph anchors."),
      source("master_marks", 2, "published_work", "Acquire author-written books with edition and page anchors."),
      source("master_marks", 3, "author_signed", "Acquire complete public speeches and interviews with stated as-of context."),
    ],
    cases: {
      decision: "Acquire dated cycle and risk-posture calls with contemporaneous market distributions." ,
      failure: "Acquire attributable early, late or misclassified cycle judgments and revisions." ,
      counterfactual: "Change price, spreads, consensus, behavior and impairment while holding asset quality fixed." ,
      golden: "Construct blinded credit and equity cycle cases with distinct price-versus-quality combinations." ,
    },
    limits: ["Oaktree position-level underwriting and committee deliberations are private.", "Cycle position is continuous and uncertain; public prose does not justify fixed percentile thresholds without empirical calibration."],
  }),

  buildSpec({
    personaId: "master_burry",
    promptPath: "personas/masters/masters-adversarial/burry.md",
    scope: "Start from primary documents and capital structure to find structural, mechanically verifiable mispricing and test whether the position can survive being early.",
    domains: ["primary_document_research", "capital_structure", "accounting_forensics", "structural_mispricing"],
    excludes: ["private current positions", "social posts without authenticated archives", "opinion-level shorts lacking a mechanical mispricing"],
    facts: ["capital_structure.seniority", "credit.maturity_schedule", "accounting.policy_choices", "accounting.off_balance_sheet", "mispricing.mechanism", "trade.carry", "short.borrow_availability"],
    decision: {
      schemaId: "structural_mispricing_v1",
      eligibility: ["opened primary documents", "reconstructed capital structure", "verifiable mechanical mispricing", "carry and financing path"],
      states: ["document_gap", "opinion_only", "watch", "structural_mispricing"],
      outputs: ["document lineage", "capital-structure map", "mechanical mispricing", "survival and intermediate signals"],
      failClosed: ["load-bearing secondary source", "capital rank unresolved", "mispricing mechanism not testable", "position cannot survive timing"],
    },
    tools: [
      ["master_burry.capital_structure_reader", "Rebuild seniority, maturities, covenants and off-balance-sheet claims from filings.", ["capital_structure.seniority", "credit.maturity_schedule", "accounting.off_balance_sheet"]],
      ["master_burry.mispricing_carry", "Quantify the mechanical mispricing, carry, borrow and forced-exit conditions.", ["mispricing.mechanism", "trade.carry", "short.borrow_availability"]],
    ],
    vetoes: [
      ["master_burry.secondary_only", "Reject a load-bearing number that cannot be traced to an opened primary document."],
      ["master_burry.opinion_not_structure", "Reject a trade when disagreement is subjective rather than mechanically testable."],
      ["master_burry.cannot_survive_early", "Reject when carry, margin or borrow can force exit before intermediate signals resolve."],
    ],
    sources: [
      source("master_burry", 1, "public_record", "Acquire SEC and issuer filings for disclosed positions and underlying security structures."),
      source("master_burry", 2, "author_signed", "Acquire authenticated investor letters, public writings and archived statements with dates."),
      source("master_burry", 3, "institutional_primary", "Acquire original prospectuses, pooling documents, notes and accounting policies for reconstructed cases."),
    ],
    cases: {
      decision: "Acquire dated, attributable theses where the original documents and information set remain available." ,
      failure: "Acquire attributable timing, carry, position-structure and thesis failures, not dramatized retellings." ,
      counterfactual: "Change capital rank, accounting choice, forced seller, carry, borrow and timing independently." ,
      golden: "Construct blinded filing-heavy cases with structural, opinion-only and unfinanceable mispricings." ,
    },
    limits: ["Scion research files, trade construction, risk limits and current views are private.", "Public regulatory holdings are delayed and incomplete, and cannot establish entry price, hedge or thesis."],
  }),

  buildSpec({
    personaId: "master_klarman",
    promptPath: "personas/masters/masters-value-classic/klarman.md",
    scope: "Seek absolute return with capital preservation through downside asset protection, cash optionality, catalysts and conservative recovery analysis.",
    domains: ["capital_preservation", "distressed_value", "complex_securities", "catalyst_value"],
    excludes: ["Baupost private letters or positions", "leaked material treated as an authorized source", "relative-performance pressure imported into the method"],
    facts: ["valuation.downside_asset_value", "distress.recovery_waterfall", "capital_structure.seniority", "catalyst.path", "portfolio.cash_optionality", "trade.liquidity", "risk.permanent_loss"],
    decision: {
      schemaId: "capital_preservation_v1",
      eligibility: ["conservative downside assets", "claim seniority", "liquidity and catalyst facts"],
      states: ["downside_unknown", "reject", "wait_in_cash", "absolute_return_candidate"],
      outputs: ["downside range", "recovery waterfall", "catalyst-adjusted return", "cash-versus-invest comparison"],
      failClosed: ["recovery inputs missing", "security rights ambiguous", "liquidity cannot support exit"],
    },
    tools: [
      ["master_klarman.recovery_waterfall", "Rebuild downside asset recovery after all senior claims and costs.", ["valuation.downside_asset_value", "distress.recovery_waterfall", "capital_structure.seniority"]],
      ["master_klarman.cash_catalyst_compare", "Compare catalyst-adjusted absolute return with the option value of cash.", ["catalyst.path", "portfolio.cash_optionality", "valuation.absolute_return"]],
    ],
    vetoes: [
      ["master_klarman.downside_unknown", "Decline when the conservative downside cannot be reconstructed."],
      ["master_klarman.capital_loss", "Reject when a plausible scenario causes unbounded permanent capital loss."],
      ["master_klarman.catalyst_liquidity", "Reject when catalyst timing and liquidity cannot support an absolute-return position."],
    ],
    sources: [
      source("master_klarman", 1, "published_work", "Acquire authorized author-written books and published essays with page anchors."),
      source("master_klarman", 2, "author_signed", "Acquire authenticated public speeches, testimony and interviews with complete context."),
      source("master_klarman", 3, "public_record", "Acquire issuer filings, court records and regulatory disclosures for reconstructable cases."),
    ],
    cases: {
      decision: "Acquire only publicly attributable investments or passes with security rights and downside inputs." ,
      failure: "Acquire documented recovery, catalyst and liquidity failures from authorized or public records." ,
      counterfactual: "Vary recoveries, senior claims, catalyst delay, liquidity and cash return independently." ,
      golden: "Construct blinded complex-security and distressed cases with explicit waterfalls." ,
    },
    limits: ["Baupost letters, position books and committee records are private; unauthorized leaks are excluded from admission.", "The scarce public case record may prevent a named method model from ever meeting case-admission thresholds."],
  }),

  buildSpec({
    personaId: "master_pabrai",
    promptPath: "personas/masters/masters-value/pabrai.md",
    scope: "Separate uncertainty from permanent-loss risk and seek simple, independently rebuilt situations with a conservative downside floor and asymmetric ordinary outcomes.",
    domains: ["dhandho_value", "special_situations", "downside_protection", "concentrated_odds"],
    excludes: ["copied holdings treated as analysis", "private fund positions", "precise probabilities unsupported by frequencies or source evidence"],
    facts: ["valuation.downside_floor", "distress.recovery_waterfall", "credit.financing_runway", "scenario.outcome_tree", "catalyst.path", "valuation.ordinary_outcome_return", "portfolio.concentration_limit"],
    decision: {
      schemaId: "dhandho_payoff_v1",
      eligibility: ["independently rebuilt facts", "downside floor", "financing runway", "small discrete outcome set"],
      states: ["no_floor", "reject", "watch", "asymmetric_candidate"],
      outputs: ["downside floor", "discrete outcome tree", "ordinary-outcome return", "sizing constraints"],
      failClosed: ["thesis borrowed without rebuild", "recovery not estimable", "financing fails before resolution", "catastrophic branch omitted"],
    },
    tools: [
      ["master_pabrai.downside_floor", "Recompute recoverable value, seniority and financing survival under conservative assumptions.", ["valuation.downside_floor", "distress.recovery_waterfall", "credit.financing_runway"]],
      ["master_pabrai.discrete_payoff", "Build a small outcome tree and calculate ordinary rather than perfect returns.", ["scenario.outcome_tree", "valuation.ordinary_outcome_return", "portfolio.concentration_limit"]],
    ],
    vetoes: [
      ["master_pabrai.cloned_not_rebuilt", "Reject a thesis copied from another investor without independent reconstruction."],
      ["master_pabrai.no_downside_floor", "Reject when conservative recovery and financing survival cannot be estimated."],
      ["master_pabrai.complex_success_path", "Reject when upside needs many favorable events but one adverse event causes permanent loss."],
    ],
    sources: [
      source("master_pabrai", 1, "published_work", "Acquire author-written books and essays with edition and page anchors."),
      source("master_pabrai", 2, "author_signed", "Acquire full authenticated talks, interviews and Q-and-A records."),
      source("master_pabrai", 3, "public_record", "Acquire regulatory holdings and issuer filings only as leads for independent case reconstruction."),
    ],
    cases: {
      decision: "Acquire dated public investment explanations and independently rebuild price, information and outcomes." ,
      failure: "Acquire attributable errors involving cloning, recovery, financing or omitted catastrophic branches." ,
      counterfactual: "Change recovery, financing runway, branch complexity, catalyst delay and entry price independently." ,
      golden: "Construct blinded simple-outcome and false-asymmetry cases with independently reviewed floors." ,
    },
    limits: ["Pabrai Funds position sizes, research files and complete rationales are private.", "Regulatory holdings disclose neither hedges nor the original information set and cannot prove a Dhandho rationale."],
  }),

  buildSpec({
    personaId: "master_ackman",
    promptPath: "personas/masters/masters-adversarial/ackman.md",
    scope: "Separate standalone value from improvement value, then test whether a legal, financeable and time-bounded actor can execute the change path.",
    domains: ["activism", "governance", "capital_allocation", "corporate_change"],
    excludes: ["private campaign strategy", "management motives inferred from filings", "wish lists presented as executable catalysts"],
    facts: ["valuation.standalone_value", "valuation.improvement_value", "governance.voting_control", "governance.board_rights", "catalyst.change_levers", "catalyst.implementation_cost", "catalyst.timeline"],
    decision: {
      schemaId: "engagement_feasibility_v1",
      eligibility: ["standalone downside value", "power and resistance map", "identified actor", "dated milestones and costs"],
      states: ["passive_only", "infeasible", "watch", "engagement_candidate"],
      outputs: ["standalone value", "change-lever value", "power map", "failure-adjusted catalyst path"],
      failClosed: ["no downside-protected core", "no actor can cause change", "legal or financing rights unresolved"],
    },
    tools: [
      ["master_ackman.power_map", "Rebuild voting, board, regulatory, creditor and stakeholder constraints from public records.", ["governance.voting_control", "governance.board_rights", "catalyst.blocking_rights"]],
      ["master_ackman.change_value_bridge", "Separate standalone value from costed and timed improvement levers.", ["valuation.standalone_value", "valuation.improvement_value", "catalyst.implementation_cost", "catalyst.timeline"]],
    ],
    vetoes: [
      ["master_ackman.no_standalone_downside", "Reject engagement when the existing business lacks a defensible downside case."],
      ["master_ackman.no_power_path", "Reject a catalyst that no identified actor has legal power to cause."],
      ["master_ackman.cost_time_erasure", "Reject when implementation cost and time erase the reviewed value gap."],
    ],
    sources: [
      source("master_ackman", 1, "institutional_primary", "Acquire signed Pershing Square presentations, letters and campaign materials with version history."),
      source("master_ackman", 2, "public_record", "Acquire beneficial-ownership filings, proxy records, court records and governance documents."),
      source("master_ackman", 3, "institutional_primary", "Acquire issuer and regulator records documenting campaign milestones and outcomes."),
    ],
    cases: {
      decision: "Acquire dated public campaigns with standalone value, proposed levers, rights and timelines frozen." ,
      failure: "Acquire campaigns that failed through governance, cost, timing, financing or core-business deterioration." ,
      counterfactual: "Change voting power, implementation cost, delay, regulator response and standalone value independently." ,
      golden: "Construct blinded passive-value and engagement-feasibility cases with realistic blocking rights." ,
    },
    limits: ["Campaign negotiations, board discussions and trade construction are private.", "Public presentations are advocacy documents; every claim requires independent rederivation before admission."],
  }),

  buildSpec({
    personaId: "master_damodaran",
    promptPath: "personas/masters/masters-value-classic/damodaran.md",
    scope: "Translate a testable business story into growth, margins, reinvestment, risk and cash flow, then expose the value distribution and price-implied story.",
    domains: ["intrinsic_valuation", "story_to_numbers", "young_companies", "reverse_valuation"],
    excludes: ["single-point precision", "borrowed spreadsheets with hidden assumptions", "narratives not mapped to valuation variables"],
    facts: ["valuation.revenue_growth", "valuation.target_margin", "valuation.reinvestment_rate", "valuation.cost_of_capital", "valuation.failure_probability", "valuation.cash_flow", "valuation.implied_story"],
    decision: {
      schemaId: "valuation_distribution_v1",
      eligibility: ["explicit story-variable bridge", "recomputable cash-flow inputs", "risk and failure assumptions", "current price"],
      states: ["unvalued", "company_inputs_partial", "company_valuation_recomputable", "company_valuation_review_required"],
      outputs: ["story-to-number map", "valuation distribution", "reverse-valuation story", "sensitivity and breakpoints"],
      failClosed: ["story-variable mapping absent", "currency or unit lineage missing", "terminal economics inconsistent"],
    },
    tools: [
      ["master_damodaran.story_dcf", "Compute a versioned valuation distribution from explicit operating assumptions.", ["valuation.cash_flow", "valuation.intrinsic_distribution", "valuation.failure_probability"]],
      ["master_damodaran.reverse_valuation", "Solve for the growth, margin and reinvestment story embedded in price.", ["valuation.implied_story", "valuation.revenue_growth", "valuation.target_margin", "valuation.reinvestment_rate"]],
    ],
    vetoes: [
      ["master_damodaran.story_number_gap", "Decline when a load-bearing narrative claim has no mapped valuation variable."],
      ["master_damodaran.reinvestment_inconsistency", "Reject a growth scenario whose required reinvestment is omitted or internally inconsistent."],
      ["master_damodaran.terminal_inconsistency", "Reject a terminal state incompatible with mature growth, margin and risk assumptions."],
    ],
    sources: [
      source("master_damodaran", 1, "author_signed", "Acquire dated course notes, blog posts and valuation datasets with versioned anchors."),
      source("master_damodaran", 2, "published_work", "Acquire author-written books and papers with edition, page and equation anchors."),
      source("master_damodaran", 3, "institutional_primary", "Acquire downloadable valuation spreadsheets and accompanying assumptions from official academic channels."),
    ],
    cases: {
      decision: "Acquire dated public valuations with the original spreadsheet, price, story and information set." ,
      failure: "Acquire resolved valuations where growth, margins, reinvestment, risk or narrative changed materially." ,
      counterfactual: "Vary each story variable, failure probability, cost of capital and terminal state independently." ,
      golden: "Construct blinded mature, young, cyclical and distressed valuation cases with recomputable distributions." ,
    },
    limits: ["A public valuation is an educational snapshot, not proof of a personal trade or portfolio decision.", "Model outputs are highly assumption-sensitive; numerical reproducibility does not by itself validate the story."],
  }),

  buildSpec({
    personaId: "master_taleb",
    promptPath: "personas/masters/masters-options/taleb.md",
    legacyV2: "knowledge/masters/master_taleb/manifest.json",
    scope: "Reject ruin and hidden concavity first, then evaluate whether a payoff is robust or positively convex after liquidity, tail pricing and execution friction.",
    domains: ["tail_risk", "convexity", "options", "fragility"],
    excludes: ["directional target prices attributed to the named author", "missing volatility facts filled by model memory", "private trading positions"],
    facts: ["risk.ruin_possible", "risk.hidden_leverage", "payoff.max_loss", "payoff.convexity", "options.implied_volatility", "options.realized_volatility", "options.skew_25d", "execution.round_trip_cost", "event.expiry_coverage"],
    decision: {
      schemaId: "convexity_ruin_v1",
      eligibility: ["typed payoff and leverage facts", "realized and implied volatility", "executable options surface", "event-expiry map"],
      states: ["no_trade", "hedge_only", "robust", "convex_opportunity"],
      outputs: ["ruin audit", "payoff shape", "tail pricing", "friction-adjusted edge"],
      failClosed: ["ruin unresolved", "critical surface fact missing", "friction not computable", "coverage below policy floor"],
    },
    tools: [
      ["master_taleb.payoff_ruin", "Stress payoff convexity and absorbing barriers under extreme but explicit states.", ["risk.ruin_possible", "risk.hidden_leverage", "payoff.convexity"]],
      ["master_taleb.tail_friction", "Compare realized tails with the surface after bid-ask and event coverage.", ["options.realized_volatility", "options.implied_volatility", "options.skew_25d", "execution.round_trip_cost", "event.expiry_coverage"]],
    ],
    vetoes: [
      ["master_taleb.ruin", "Reject any return thesis with an unresolved absorbing loss state."],
      ["master_taleb.negative_convexity", "Reject hidden concavity whose tail loss is not strictly bounded."],
      ["master_taleb.friction_erases_edge", "Reject an options edge that does not survive executable round-trip costs."],
    ],
    sources: [
      source("master_taleb", 1, "published_work", "Acquire author-written technical and nontechnical works with edition and page anchors."),
      source("master_taleb", 2, "published_work", "Acquire authored papers and technical notes with equation-level anchors and version history."),
      source("master_taleb", 3, "author_signed", "Acquire complete public lectures and interviews, separating polemic from executable method statements."),
    ],
    cases: {
      decision: "Acquire only attributable public payoff or risk decisions with reconstructable contemporary market facts." ,
      failure: "Acquire attributable cases of model, hedge, liquidity or implementation failure without inferring private trades." ,
      counterfactual: "Vary ruin, leverage, convexity, realized-implied spread, skew, friction and event coverage independently." ,
      golden: "Extend synthetic and production-shaped options fixtures with blinded robust, fragile and insufficient-grounding cases." ,
    },
    limits: ["Empirica and private trading positions, sizing and execution are not public.", "Published philosophical claims do not automatically define numerical option thresholds; calibration must remain separately labeled."],
  }),

  buildSpec({
    personaId: "master_natenberg",
    promptPath: "personas/masters/masters-options/natenberg.md",
    scope: "Evaluate option relative value through implied volatility, skew, term structure, Greeks, payoff structure and executable market-making constraints.",
    domains: ["options_pricing", "volatility_surface", "greeks", "relative_value"],
    excludes: ["private market-making books", "stale mid-prices treated as executable", "directional equity judgments outside an option structure"],
    facts: ["options.implied_volatility", "options.skew_surface", "options.term_structure", "options.greeks", "options.payoff", "execution.bid_ask", "execution.liquidity"],
    decision: {
      schemaId: "options_relative_value_v1",
      eligibility: ["timestamped executable chain", "surface fit", "Greek and payoff calculation", "trade-size liquidity"],
      states: ["surface_unavailable", "mispriced_untradeable", "fair", "relative_value"],
      outputs: ["surface diagnostics", "Greek exposures", "payoff scenarios", "executable relative value"],
      failClosed: ["chain stale", "surface arbitrage unresolved", "spread or liquidity missing", "Greek convention ambiguous"],
    },
    tools: [
      ["master_natenberg.surface_builder", "Build arbitrage-checked implied-volatility, skew and term surfaces from executable quotes.", ["options.implied_volatility", "options.skew_surface", "options.term_structure"]],
      ["master_natenberg.greeks_payoff", "Recompute Greeks and state-contingent payoff after spreads and contract conventions.", ["options.greeks", "options.payoff", "execution.bid_ask"]],
    ],
    vetoes: [
      ["master_natenberg.stale_chain", "Reject relative value when quotes are stale or timestamps are inconsistent."],
      ["master_natenberg.untradeable_spread", "Reject apparent mispricing that cannot clear the executable spread."],
      ["master_natenberg.undefined_exposure", "Reject a structure whose material Greek or payoff exposure is not computed."],
    ],
    sources: [
      source("master_natenberg", 1, "published_work", "Acquire author-written option texts with edition, page and formula anchors."),
      source("master_natenberg", 2, "author_signed", "Acquire authenticated lectures and educational materials with complete examples."),
      source("master_natenberg", 3, "institutional_primary", "Acquire exchange specifications, calendars and option-chain data for reproducible cases."),
    ],
    cases: {
      decision: "Acquire public educational trade examples whose surface and payoff inputs can be reconstructed." ,
      failure: "Acquire surface, Greek, liquidity and event-risk failure examples with known conventions." ,
      counterfactual: "Vary skew, term structure, spot, volatility, time, rates, spreads and liquidity independently." ,
      golden: "Construct blinded option structures with known surface relationships and execution traps." ,
    },
    limits: ["Professional market-making positions, inventory constraints and execution records are private.", "Educational examples simplify slippage, model risk and dynamic hedging relative to live markets."],
  }),

  buildSpec({
    personaId: "master_sinclair",
    promptPath: "personas/masters/masters-options/sinclair.md",
    scope: "Forecast realized volatility, compare it with implied volatility, subtract spreads and slippage, and size only a robust executable edge.",
    domains: ["volatility_forecasting", "options_execution", "edge_measurement", "position_sizing"],
    excludes: ["private trading strategies", "gross volatility spread called edge", "backtests without point-in-time and cost controls"],
    facts: ["options.realized_volatility_forecast", "options.implied_volatility", "options.volatility_risk_premium", "execution.bid_ask", "execution.slippage", "risk.forecast_error", "position.fraction"],
    decision: {
      schemaId: "volatility_edge_v1",
      eligibility: ["versioned realized-volatility forecast", "timestamped implied volatility", "spread and slippage model", "forecast uncertainty"],
      states: ["insufficient_inputs", "no_net_edge", "paper_edge", "executable_edge"],
      outputs: ["realized forecast", "gross and net edge", "forecast uncertainty", "position cap"],
      failClosed: ["forecast not reproducible", "costs absent", "edge smaller than error", "liquidity insufficient"],
    },
    tools: [
      ["master_sinclair.realized_vol_forecast", "Produce a versioned realized-volatility forecast with out-of-sample error.", ["options.realized_volatility_forecast", "risk.forecast_error"]],
      ["master_sinclair.net_edge_sizer", "Subtract executable costs and size the residual volatility edge conservatively.", ["options.volatility_risk_premium", "execution.bid_ask", "execution.slippage", "position.fraction"]],
    ],
    vetoes: [
      ["master_sinclair.no_oos_forecast", "Reject an edge based on an unvalidated realized-volatility forecast."],
      ["master_sinclair.cost_erasure", "Reject when spread and slippage erase the gross volatility difference."],
      ["master_sinclair.error_dominates", "Reject when forecast error is material relative to estimated net edge."],
    ],
    sources: [
      source("master_sinclair", 1, "published_work", "Acquire author-written books and papers with edition, page and formula anchors."),
      source("master_sinclair", 2, "author_signed", "Acquire authenticated talks, interviews and educational notes with complete context."),
      source("master_sinclair", 3, "institutional_primary", "Acquire exchange option data and specifications for executable volatility studies."),
    ],
    cases: {
      decision: "Acquire public examples with enough forecast, implied-volatility and cost inputs for reconstruction." ,
      failure: "Acquire forecast, overfit, friction and sizing failures from attributable public material." ,
      counterfactual: "Vary forecast window, implied volatility, error, spread, slippage, horizon and size independently." ,
      golden: "Construct blinded volatility cases separating gross spread, paper edge and executable edge." ,
    },
    limits: ["Production volatility models, signals, portfolios and execution records are proprietary.", "Historical option quote quality and transaction-cost data may be insufficient for realistic reconstruction."],
  }),
  // The other twenty-six seats price a business. None of them prices a basket, which is why an
  // index or an ETF drew twenty-six abstentions rather than a number. This seat's method is the
  // one that natively does.
  buildSpec({
    personaId: "master_bogle",
    promptPath: "personas/masters/masters-value/bogle.md",
    scope: "Price a basket rather than a business by decomposing the long-run expected return into dividend yield, earnings growth and the change in valuation, then judging it against the long bond and the cost of holding it.",
    domains: ["index_funds", "exchange_traded_funds", "market_expected_return", "cost_of_ownership"],
    excludes: ["a judgment on any single operating business", "security selection inside the basket", "a dated call on when a valuation reversion occurs", "manager skill inferred from a fund's past outperformance"],
    facts: ["index.dividend_yield", "valuation.revenue_growth", "macro.long_bond_yield", "fund.top_ten_weight", "index.aggregate_earnings_yield", "macro.breakeven_inflation"],
    decision: {
      schemaId: "expected_market_return_v1",
      eligibility: ["basket dividend yield", "basket earnings growth", "long bond yield", "holdings concentration"],
      states: ["not_a_basket", "insufficient_return_inputs", "overpriced_market", "fair_expected_return", "low_cost_index_candidate"],
      outputs: ["fundamental expected return", "expected return over the long bond", "valuation component", "breadth of the holding"],
      failClosed: ["no basket-level yield", "no earnings growth input", "no holdings breakdown"],
    },
    tools: [
      ["master_bogle.fundamental_expected_return", "Add the initial dividend yield to the growth of the underlying businesses.", ["index.fundamental_expected_return"]],
      ["master_bogle.expected_return_over_long_bond", "Subtract the long bond yield from what the basket can reasonably be expected to deliver.", ["index.expected_return_over_long_bond"]],
    ],
    vetoes: [
      ["master_bogle.expected_return_below_inflation", "Reject when dividend yield plus business growth does not exceed expected inflation, since no reduction in cost rescues a gross return already negative in real terms."],
      ["master_bogle.single_business", "Decline when the subject is one operating business rather than a basket whose dividends and earnings aggregate."],
      ["master_bogle.past_performance_claim", "Reject a case for a fund whose support is past outperformance rather than yield, growth and cost."],
    ],
    sources: [
      source("master_bogle", 1, "published_work", "Acquire the author-written books on index investing with edition and page anchors for the return model and the cost argument."),
      source("master_bogle", 2, "author_signed", "Acquire the signed occasional papers, articles and speeches where the return decomposition is stated with its arithmetic."),
      source("master_bogle", 3, "institutional_primary", "Acquire fund and index-provider disclosures for expense ratios, dividend yields and the earnings basis behind each published aggregate multiple."),
    ],
    cases: {
      decision: "Acquire dated public statements of expected market return with the yield, growth and valuation inputs frozen as stated at the time." ,
      failure: "Acquire decade-long periods where the published expected return was materially too low, separating the author's own later commentary from third-party interpretation." ,
      counterfactual: "Vary dividend yield, earnings growth, the long-run valuation centre, cost and concentration independently while holding the basket fixed." ,
      golden: "Construct blinded basket cases where the same gross return does or does not survive cost and a valuation reversion, including single businesses whose expected state is an out-of-scope refusal." ,
    },
    limits: [
      "Earnings growth is not published for a basket in this build, so a look-through revenue-growth aggregate stands in for it and that substitution changes the number.",
      "Aggregate index multiples are quoted on incompatible earnings bases, so a reversion estimate is only meaningful within one basis and cannot be compared across sources.",
      "Fund cost is not currently produced by the instrument feed, so the cost term depends on an acquisition target rather than on a live fact.",
      "The method deliberately produces no judgment on a single business, so a large share of the coverage universe is out of scope by construction rather than by evidence gap.",
    ],
  }),
];

export const personaV3BuildSpecs = Object.freeze({
  schema_version: 1,
  inventory_id: "personapack-v3-build-specs",
  inventory_status: "non_production_planning_only",
  canonical_catalog_source: "mcp/lib/personas/registry.mjs",
  seat_count: seats.length,
  adjudication_policy: Object.freeze({
    method_attribution: PENDING,
    source_grading: PENDING,
    case_labels: PENDING,
    veto_thresholds: PENDING,
    reviewer_approvals: "none",
    experiments: "not_started",
    promotion_effect: "none",
  }),
  seats: Object.freeze(seats.map(overlayAuthoredSeat)),
});

/**
 * How many dedicated tools the whole bench plans.
 *
 * Computed from the specs rather than as seats times two: a method that needs a third step to
 * express itself should be able to declare one without every downstream invariant reading the
 * extra tool as drift. The count is still exact -- it is simply derived from the one place
 * that knows it.
 */
export const PLANNED_TOOL_COUNT = personaV3BuildSpecs.seats
  .reduce((total, seat) => total + seat.planned_dedicated_tools.length, 0);

export default personaV3BuildSpecs;
