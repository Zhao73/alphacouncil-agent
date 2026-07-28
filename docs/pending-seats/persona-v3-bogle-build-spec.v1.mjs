/**
 * Canonical, non-production build specification for the index-method seat.
 *
 * The other twenty-six seats price a business. None of them prices a basket, which is why an
 * index or an ETF produced twenty-six abstentions rather than a number. This seat's method is
 * the one that natively does: expected return decomposes into dividend yield, earnings growth
 * and the change in valuation, and net return is that total minus cost.
 *
 * Nothing here is evidence of the named person's method. Every method statement is a planning
 * hypothesis inherited from the seat's prompt material. Source and case entries are acquisition
 * queues, not citations or completed corpus items. This module registers no production pack and
 * changes no seat's maturity; it exists to be merged into `data/persona-v3-build-specs.v1.mjs`
 * in the same shape the twenty-six existing seats already use.
 */

const PENDING = "pending_human_adjudication";

export const bogleBuildSpec = {
  persona_id: "master_bogle",
  build_status: "spec_only",
  current_material: {
    prompt_path: "personas/masters/masters-value/bogle.md",
    material_level: "v1_prompt",
    legacy_v2_manifest: null,
  },
  method_scope: {
    planning_hypothesis: "Price a basket rather than a business by decomposing the ten-year expected return into dividend yield, earnings growth and the change in valuation, then subtracting the cost of holding it.",
    applicable_domains: ["index_funds", "exchange_traded_funds", "market_expected_return", "cost_of_ownership"],
    excluded_claims: [
      "a judgment on any single operating business",
      "security selection inside the basket",
      "a dated call on when a valuation reversion occurs",
      "manager skill inferred from a fund's past outperformance",
    ],
  },
  required_fact_types: [
    "index.dividend_yield",
    "index.aggregate_pe_ttm",
    "valuation.revenue_growth",
    "fund.top_ten_weight",
    "macro.long_bond_yield",
  ],
  native_decision_contract: {
    schema_id: "index_expected_return_v1",
    implementation_status: "planned_unverified",
    eligibility_facts: [
      "basket instrument rather than a single operating business",
      "published dividend yield with a named basis and date",
      "aggregate earnings multiple quoted on one declared basis",
    ],
    states: ["not_a_basket", "overpriced_basket", "thin_after_cost", "buy_and_hold_candidate"],
    required_outputs: [
      "investment return decomposed into dividend yield and earnings growth",
      "speculative return under unchanged, reverting and expanding valuation",
      "expected return after disclosed cost",
      "concentration statement with the weight it was measured over",
    ],
    fail_closed_reasons: [
      "subject is a single business this method does not price",
      "dividend yield or aggregate earnings basis unavailable",
      "aggregate multiple quoted on an unnamed or mixed basis",
      "no long-run valuation centre with a stated source",
    ],
  },
  planned_dedicated_tools: [
    {
      tool_id: "master_bogle.return_decomposition",
      purpose: "Decompose a basket's ten-year expected return into dividend yield, earnings growth and the annualised change in valuation.",
      output_fact_types: ["valuation.long_run_return", "index.dividend_yield", "valuation.revenue_growth"],
      implementation_status: "planned_unverified",
    },
    {
      tool_id: "master_bogle.cost_and_reversion_drag",
      purpose: "Recompute what disclosed cost and a reversion of the aggregate multiple to a stated long-run centre remove from the gross return.",
      output_fact_types: ["valuation.speculative_return", "fund.expense_ratio", "valuation.net_of_cost_return"],
      implementation_status: "planned_unverified",
    },
  ],
  veto_families: [
    {
      veto_id: "master_bogle.single_business",
      candidate_rule: "Decline when the subject is one operating business rather than a basket whose dividends and earnings aggregate.",
      human_adjudication_status: PENDING,
    },
    {
      veto_id: "master_bogle.cost_omitted",
      candidate_rule: "Reject a net-return claim that does not subtract the disclosed cost of holding the basket.",
      human_adjudication_status: PENDING,
    },
    {
      veto_id: "master_bogle.past_performance_claim",
      candidate_rule: "Reject a case for a fund whose support is past outperformance rather than yield, growth and cost.",
      human_adjudication_status: PENDING,
    },
  ],
  primary_source_acquisition_targets: [
    {
      target_id: "master_bogle.source_1",
      source_family: "published_work",
      acquisition_target: "Acquire the author-written books on index investing with edition and page anchors for the two-component return model and the cost argument.",
      acquisition_status: "not_started",
      human_adjudication_status: PENDING,
    },
    {
      target_id: "master_bogle.source_2",
      source_family: "author_signed",
      acquisition_target: "Acquire the signed research-centre occasional papers, articles and speeches where the return decomposition is stated with its arithmetic.",
      acquisition_status: "not_started",
      human_adjudication_status: PENDING,
    },
    {
      target_id: "master_bogle.source_3",
      source_family: "institutional_primary",
      acquisition_target: "Acquire fund and index-provider disclosures for expense ratios, dividend yields and the earnings basis behind each published aggregate multiple.",
      acquisition_status: "not_started",
      human_adjudication_status: PENDING,
    },
  ],
  case_acquisition_targets: [
    {
      case_family: "decision",
      acquisition_target: "Acquire dated public statements of expected market return with the yield, growth and valuation inputs frozen as stated at the time.",
      minimum_count: 5,
      acquisition_status: "not_started",
      human_adjudication_status: PENDING,
    },
    {
      case_family: "failure",
      acquisition_target: "Acquire decade-long periods where the published expected return was materially too low, with the author's own later commentary separated from third-party interpretation.",
      minimum_count: 3,
      acquisition_status: "not_started",
      human_adjudication_status: PENDING,
    },
    {
      case_family: "counterfactual",
      acquisition_target: "Vary dividend yield, earnings growth, the long-run valuation centre, cost and concentration independently while holding the basket fixed.",
      minimum_count: 20,
      acquisition_status: "not_started",
      human_adjudication_status: PENDING,
    },
    {
      case_family: "golden",
      acquisition_target: "Construct blinded basket cases where the same gross return does or does not survive cost and a valuation reversion, including single businesses whose expected state is an out-of-scope refusal.",
      minimum_count: 12,
      acquisition_status: "not_started",
      human_adjudication_status: PENDING,
    },
  ],
  known_limits: [
    "Earnings growth is not published for a basket in this build, so a look-through revenue-growth aggregate stands in for it and that substitution changes the number.",
    "Aggregate index multiples are quoted on incompatible earnings bases, so a reversion estimate is only meaningful within one basis and cannot be compared across sources.",
    "Fund cost is not currently produced by the instrument feed, so the cost term depends on an acquisition target rather than on a live fact.",
    "The method deliberately produces no judgment on a single business, so a large share of the coverage universe is out of scope by construction rather than by evidence gap.",
  ],
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

export default bogleBuildSpec;
