/**
 * Authored method logic, keyed by persona id.
 *
 * A seat listed here gets its real formulas and its real decision policy. A seat absent from
 * this file keeps the mechanical identity proxy, which is executable and deliberately says
 * nothing -- so this file can be filled in one seat at a time without the build ever being in
 * a half-written state.
 *
 * Everything here is AI-authored and unreviewed. It is barred from production admission by
 * the same gates that bar the proxies; what changes is only that the arithmetic is now the
 * method's own rather than a placeholder. Each seat names its published source in
 * `provenance`, and every veto and scoring rule says in `rationale` what the person actually
 * claimed. Where a published method gives a direction but no number, the rationale says so and
 * labels the cut-off as this project's reading rather than the author's.
 *
 * ---------------------------------------------------------------------------------------
 * Contract notes for the pipeline that consumes this file
 * ---------------------------------------------------------------------------------------
 *
 * 1. `native_state` values are the RAW state names from each seat's
 *    `native_decision_contract.states`. They are mapped through `executableNativeState()`,
 *    which adds the `provisional_` prefix. Do not pre-prefix them here or they double-prefix
 *    and stop matching the declared state set.
 *
 * 2. `eligibility.all[]` entries carry the executor's own record shape
 *    (`condition_id` / `condition` / `on_false` / `on_uncomputable`) but omit `source_ids`,
 *    because the source id is minted at build time. The pipeline must inject `source_ids` the
 *    way it already does for hard vetoes and scoring rules, and must map the two mapping
 *    states through `executableNativeState()`.
 *
 * 3. `purpose` on tools and `rationale` on vetoes and rules are authoring metadata. The
 *    executor rejects unknown fields, so neither may be copied into the physical policy or
 *    tool records.
 *
 * 4. Chained tools: a tool that consumes another tool's `output_id` must take the PRODUCER's
 *    `value_kind` and `unit` as its input contract, not its own. Buffett and Graham both
 *    divide a monetary numerator by a monetary market capitalisation to produce a ratio, so a
 *    consumer-derived input contract fails `does not match producer ... output contract`.
 *
 * 5. Shared `output_id`s across seats are deliberate and denote the same number built the same
 *    way:
 *      valuation.market_capitalisation    Buffett, Graham          price x share count
 *      macro.policy_real_rate             Dalio, Druckenmiller     2y yield - 5y breakeven
 *      index.implied_equity_risk_premium  Damodaran, Asness        index E/P - 10y Treasury
 *
 * 6. `master_bogle` has no build-spec entry yet. Its proposed native decision contract is
 *    carried on the seat as `proposed_native_decision_contract` so it can be lifted verbatim.
 */
export const coreSeats = Object.freeze({
  master_buffett: {
    provenance:
      "Warren Buffett, \"Mr. Buffett on the Stock Market\", Fortune, 22 November 1999, which argues equity value against the long bond yield; the owner-earnings definition in the appendix to the 1986 annual report; the 1987 chairman's letter endorsing Fortune's 1988 Investor's Guide study, in which only 25 of the 1,000 largest companies averaged over 20% return on equity across 1977-1986 with no single year below 15%; and the 1984 letter on repurchases. The leverage cut-off is this project's conservative reading of his stated refusal to depend on borrowed money, not a ratio he published.",
    tools: [
      {
        tool_id: "master_buffett.market_capitalisation",
        operation: "multiply",
        inputs: [{ fact_id: "market.price" }, { fact_id: "capital_allocation.share_count" }],
        output_id: "valuation.market_capitalisation",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "Owner earnings are an absolute currency amount and mean nothing until they are set against what the whole business costs. Price times share count is that denominator.",
      },
      {
        tool_id: "master_buffett.owner_earnings_yield",
        operation: "divide",
        inputs: [{ fact_id: "financial.owner_earnings" }, { output_id: "valuation.market_capitalisation" }],
        output_id: "valuation.owner_earnings_yield",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The rate an owner earns on the purchase price, which is the only figure the 1999 Fortune argument can set against a bond.",
      },
    ],
    eligibility: {
      all: [
        // Buffett's competence boundary. If you cannot say what incremental capital earns inside
        // the business you cannot state its economics, and it belongs in the "too hard" pile.
        {
          condition_id: "master_buffett.incremental_returns_measurable",
          condition: { op: "exists", value: { fact_id: "financial.incremental_return_on_capital" } },
          on_false: { native_state: "too_hard", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "too_hard", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_buffett.leverage_dependency",
        rationale:
          "Buffett rejects returns that rest on borrowed money rather than operating economics. The 1987 letter notes that the economic superstars it describes carried little debt, and the 2010 letter states Berkshire will never be dependent on the kindness of strangers. Debt above three times equity is this project's conservative reading of that refusal; Buffett published no ratio.",
        condition: { op: "gt", left: { fact_id: "financial.leverage" }, right: { literal: 3 } },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
      {
        veto_id: "master_buffett.owner_earnings_unreliable",
        rationale:
          "The 1986 owner-earnings appendix defines the figure as reported earnings plus non-cash charges less the maintenance investment the business actually requires. A business that does not throw off positive owner earnings has nothing an owner can take out, so no purchase price is defensible.",
        condition: { op: "lte", left: { fact_id: "financial.owner_earnings" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
    ],
    scoring: [
      {
        rule_id: "buffett_owner_yield_beats_long_bond",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The whole argument of the 1999 Fortune article: what an equity is worth is governed by interest rates, so the rate an owner earns on the purchase price must beat what the long government bond pays for no business risk at all.",
        condition: { op: "gt", left: { output_id: "valuation.owner_earnings_yield" }, right: { fact_id: "macro.long_bond_yield" } },
      },
      {
        rule_id: "buffett_decade_return_on_equity",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The 1987 letter endorsed Fortune's test of economic excellence: an average return on equity above 20% across the decade 1977-1986. Only 25 of 1,000 companies passed, which is the point - the bar is meant to exclude almost everything.",
        condition: { op: "gt", left: { fact_id: "financial.return_on_equity_10y" }, right: { literal: 0.2 } },
      },
      {
        rule_id: "buffett_share_count_not_diluted",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The 1984 letter on repurchases and the 2011 letter both argue that management serves continuing shareholders by shrinking the share count below intrinsic value and injures them by issuing shares cheaply. A share count that has not grown over five years is the observable form of that test.",
        condition: { op: "lte", left: { fact_id: "capital_allocation.share_count_change_5y" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "reject" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "own_at_price" },
    ],
  },

  master_graham: {
    provenance:
      "Benjamin Graham, The Intelligent Investor, revised edition 1973: chapter 14's defensive criterion that price should not exceed fifteen times average earnings; chapter 11's minimum fixed-charge coverage of five times before income taxes for industrial issues; chapter 15 and Security Analysis on buying below two-thirds of net current asset value; and the simplified criterion he repeated in his later writing and interviews that the earnings yield should be at least twice the high-grade corporate bond yield. A five-year average free cash flow stands in for Graham's multi-year average earnings, because this pack carries no averaged reported-earnings fact.",
    tools: [
      {
  tool_id: "master_graham.defensive_hurdle_base",
        operation: "multiply",
        // Market capitalisation times the five years the cash-flow series covers, times the
        // two that his criterion demands. Both multipliers are folded in here because the
        // condition layer cannot do arithmetic, and because financial.free_cash_flow_5y is a
        // five-year CUMULATIVE total (screen.mjs) -- dividing it by a single year's market
        // capitalisation would overstate the yield fivefold.
        inputs: [
          { fact_id: "market.price" },
          { fact_id: "capital_allocation.share_count" },
          { literal: 10 },
        ],
        output_id: "valuation.graham_hurdle_base",
        value_kind: "monetary",
        unit: "currency_units",
        purpose: "Five years of market capitalisation at twice the defensive hurdle.",
      },
      {
        tool_id: "master_graham.half_normalised_earnings_yield",
        operation: "divide",
        // Half the annualised earnings yield, so that comparing it against the Aaa yield IS
        // his "earnings yield at least twice the high-grade bond yield" -- exactly, with no
        // arithmetic left for a condition that cannot perform it.
        inputs: [
          { fact_id: "financial.free_cash_flow_5y" },
          { output_id: "valuation.graham_hurdle_base" },
        ],
        output_id: "valuation.graham_half_earnings_yield",
        value_kind: "ratio",
        unit: "decimal",
        purpose: "Half the annualised normalised earnings yield.",
      },
    ],
    eligibility: {
      all: [
        // Graham ranks the common stock behind every prior claim. Without a leverage figure the
        // equity's position in the capital structure is unknown, so there is no floor to measure.
        {
          condition_id: "master_graham.balance_sheet_claims_resolvable",
          condition: { op: "exists", value: { fact_id: "financial.leverage" } },
          on_false: { native_state: "insufficient_floor", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "insufficient_floor", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_graham.no_asset_floor",
        rationale:
          "Graham's floor is what the owners would have left once the current liabilities are paid. When net current assets are zero or negative there is no asset floor at all, and the defensive method has nothing to say about the security at any price (The Intelligent Investor ch. 15; Security Analysis on net current asset value). An absent floor is not an absent opinion. Graham's whole construction is a price below a computed floor, and where no floor can be computed there is no margin of safety -- which is his own definition of speculation rather than investment. He passes. Reporting that as out-of-scope hid a decision behind a word that reads as a broken system.",
        condition: { op: "lte", left: { fact_id: "financial.net_current_asset_value" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "insufficient_floor" },
      },
      {
        veto_id: "master_graham.fixed_charge_coverage_failure",
        rationale:
          "The Intelligent Investor ch. 11 sets the minimum acceptable fixed-charge coverage for an industrial issue at five times before income taxes on a seven-year average. The common stock stands behind those same fixed charges, so an equity that fails the bondholder's financial-strength test cannot carry a margin of safety.",
        condition: { op: "lt", left: { fact_id: "financial.interest_coverage" }, right: { literal: 5 } },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
    ],
    scoring: [
      {
        rule_id: "graham_earnings_yield_twice_aaa",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Graham's simplified criterion: an equity is only worth owning when its earnings yield is at least twice the yield on high-grade corporate bonds, because that gap is what pays for taking equity risk instead of lending.",
        condition: { op: "gte", left: { output_id: "valuation.graham_half_earnings_yield" }, right: { fact_id: "macro.aaa_corporate_yield" } },
      },
      {
        rule_id: "graham_defensive_price_to_earnings",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The Intelligent Investor ch. 14 defensive criterion: current price should not be more than fifteen times average earnings. Fifteen times is an earnings yield of one fifteenth; measured on the half-yield the tool emits, that is 0.03335.",
        condition: { op: "gte", left: { output_id: "valuation.graham_half_earnings_yield" }, right: { literal: 0.03335 } },
      },
      {
        rule_id: "graham_working_capital_floor",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The separate asset floor Graham describes in ch. 15 and in Security Analysis. Compressed to its precondition -- working capital exceeding all liabilities at all -- because the two-tool budget is spent on the earnings criterion, and the two-thirds-of-NCAV price test needs a third tool to divide by market capitalisation. This project's reading; the published test is stricter.",
        condition: { op: "gt", left: { fact_id: "financial.net_current_asset_value" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "reject" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "margin_of_safety" },
    ],
  },

  master_bogle: {
    provenance:
      "John C. Bogle, \"The Occam's Razor Approach to Estimating Stock Market Returns\" (Journal of Portfolio Management, 1991) and Common Sense on Mutual Funds (1999) ch. 2: the expected stock return is the initial dividend yield plus subsequent earnings growth plus or minus the change in the price-earnings multiple, with a long-run mean multiple of about fifteen times. The Little Book of Common Sense Investing (2007) supplies the cost-matters hypothesis and the insistence on owning the entire market rather than a narrow slice of it. The top-ten-weight line is this project's reading of that instruction, not a number Bogle published. This seat has no build-spec entry yet; the proposed contract below follows the naming pattern of the other twenty-six seats and is intended to be lifted verbatim.",
    proposed_native_decision_contract: {
      schema_id: "expected_market_return_v1",
      eligibility_facts: ["basket dividend yield", "basket earnings growth", "long bond yield", "holdings concentration"],
      states: ["insufficient_return_inputs", "overpriced_market", "fair_expected_return", "low_cost_index_candidate"],
      required_outputs: ["fundamental expected return", "expected return over the long bond", "valuation component", "breadth of the holding"],
      fail_closed_reasons: ["no basket-level yield", "no earnings growth input", "no holdings breakdown"],
    },
    tools: [
      {
        tool_id: "master_bogle.fundamental_expected_return",
        operation: "add",
        inputs: [{ fact_id: "index.dividend_yield" }, { fact_id: "valuation.revenue_growth" }],
        output_id: "index.fundamental_expected_return",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "Bogle's investment return: the initial dividend yield plus the growth of the underlying businesses. Revenue growth stands in for earnings growth on his own argument that earnings cannot outrun sales for long.",
      },
      {
        tool_id: "master_bogle.expected_return_over_long_bond",
        operation: "subtract",
        inputs: [{ output_id: "index.fundamental_expected_return" }, { fact_id: "macro.long_bond_yield" }],
        output_id: "index.expected_return_over_long_bond",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The stock-versus-bond comparison Bogle used to set an allocation: what the market can reasonably be expected to deliver, less what the long bond pays outright.",
      },
    ],
    eligibility: {
      all: [
        // The method is about owning the whole market. Without a holdings breakdown you cannot
        // tell whether the fund is the market or a concentrated bet dressed as an index.
        {
          condition_id: "master_bogle.holdings_breadth_visible",
          condition: { op: "exists", value: { fact_id: "fund.top_ten_weight" } },
          on_false: { native_state: "insufficient_return_inputs", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "insufficient_return_inputs", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_bogle.expected_return_below_inflation",
        rationale:
          "Bogle stated reasonable expectations in real terms (Common Sense on Mutual Funds ch. 2). When the dividend yield plus business growth does not exceed expected inflation, the index cannot preserve purchasing power, and no reduction in cost rescues a gross return that is already negative in real terms.",
        condition: { op: "lte", left: { output_id: "index.fundamental_expected_return" }, right: { fact_id: "macro.breakeven_inflation" } },
        on_trigger: { common_stance: "opposed", native_state: "overpriced_market" },
      },
    ],
    scoring: [
      {
        rule_id: "bogle_fundamental_return_beats_long_bond",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The Occam's razor model exists to answer one question: is the market's reasonable expected return better than the yield already on offer from bonds. When it is not, Bogle's own arithmetic says hold the bonds.",
        condition: { op: "gt", left: { output_id: "index.expected_return_over_long_bond" }, right: { literal: 0 } },
      },
      {
        rule_id: "bogle_multiple_at_or_below_long_run_norm",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The third term of Bogle's model is the speculative return, the change in the price-earnings multiple, and he took the long-run mean multiple to be about fifteen times. Above that, reversion subtracts from return rather than adding to it. An aggregate earnings yield of 0.0667 is that fifteen-times mean written as a yield.",
        condition: { op: "gte", left: { fact_id: "index.aggregate_earnings_yield" }, right: { literal: 0.0667 } },
      },
      {
        rule_id: "bogle_owns_the_whole_market",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The Little Book of Common Sense Investing objects that many funds calling themselves index funds are narrow bets, and insists on owning the entire market. A top-ten weight of half the fund or more means the holding is a bet on a handful of names; the one-half line is this project's reading of that instruction.",
        condition: { op: "lte", left: { fact_id: "fund.top_ten_weight" }, right: { literal: 0.5 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "overpriced_market" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "fair_expected_return" },
      { min_ratio: 1, common_stance: "constructive", native_state: "low_cost_index_candidate" },
    ],
  },

  master_marks: {
    provenance:
      "Howard Marks, Mastering the Market Cycle (2018), especially the chapters on taking the market's temperature and calibrating aggressiveness, and the Oaktree memos \"Yet Again?\" (September 2017) and \"There They Go Again - Again\" (July 2018), which read the high-yield spread against its roughly five-hundred-basis-point long-run average as the cycle thermometer. `macro.credit_spread` is the ICE BofA US High Yield option-adjusted spread, so five hundred basis points is 0.05 in decimal form.",
    tools: [
      {
        tool_id: "master_marks.credit_cycle_position",
        operation: "subtract",
        inputs: [{ fact_id: "macro.credit_spread" }, { literal: 0.05 }],
        output_id: "macro.credit_spread_gap",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "Where the high-yield spread sits relative to its long-run average. Marks's claim is not that spreads predict anything, but that they tell you whether investors are currently being paid to bear risk.",
      },
      {
        tool_id: "master_marks.equity_over_corporate_debt",
        operation: "subtract",
        inputs: [{ fact_id: "index.aggregate_earnings_yield" }, { fact_id: "macro.aaa_corporate_yield" }],
        output_id: "index.equity_over_corporate_debt_premium",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "What the equity market pays over the safest corporate debt. The second thermometer: equities yielding less than investment-grade bonds means the cycle has run a long way toward the risk-tolerant end.",
      },
    ],
    eligibility: {
      all: [
        // "Where do we stand" needs the market's own valuation. Without an aggregate multiple the
        // seat can describe credit conditions but cannot place the cycle.
        {
          condition_id: "master_marks.market_valuation_observable",
          condition: { op: "exists", value: { fact_id: "index.aggregate_pe_ttm" } },
          on_false: { native_state: "cycle_unknown", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "cycle_unknown", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_marks.euphoria",
        rationale:
          "Marks's description of the risk-tolerant end of the cycle: investors accept less than the historical average compensation for credit risk at the same moment as equities yield less than investment-grade corporate debt. When risk is not being priced at all, calibration says defence regardless of how any individual security looks.",
        condition: {
          op: "all",
          conditions: [
            { op: "lt", left: { output_id: "macro.credit_spread_gap" }, right: { literal: 0 } },
            { op: "lt", left: { fact_id: "index.aggregate_earnings_yield" }, right: { fact_id: "macro.aaa_corporate_yield" } },
          ],
        },
        on_trigger: { common_stance: "opposed", native_state: "defensive" },
      },
    ],
    scoring: [
      {
        rule_id: "marks_credit_spread_above_long_run_average",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The cycle thermometer. A high-yield spread wider than its long-run average means lenders are demanding more than usual for risk, which is the condition in which Marks argues an investor should be leaning in rather than out.",
        condition: { op: "gt", left: { output_id: "macro.credit_spread_gap" }, right: { literal: 0 } },
      },
      {
        rule_id: "marks_equity_paid_over_corporate_debt",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The second-level question Marks insists on: not whether the asset is good, but whether the price pays you for the risk relative to the alternatives. Equities yielding more than the safest corporate debt is the minimum form of that compensation.",
        condition: { op: "gt", left: { output_id: "index.equity_over_corporate_debt_premium" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "defensive" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "balanced" },
      { min_ratio: 1, common_stance: "constructive", native_state: "aggressive" },
    ],
  },

  master_damodaran: {
    provenance:
      "Aswath Damodaran's monthly implied equity risk premium updates on damodaran.com and the annual paper \"Equity Risk Premiums: Determinants, Estimation and Implications\": the implied premium is the expected return embedded in current index prices less the risk-free rate, and the US implied premium has averaged roughly 4.2% since 1960, which is the historical anchor he judges the current reading against. This seat uses the index earnings yield less the ten-year Treasury as a tractable stand-in for his full cash-flow-implied expected return; it is a simplification of his method, not his method.",
    tools: [
      {
        tool_id: "master_damodaran.implied_equity_risk_premium",
        operation: "subtract",
        inputs: [{ fact_id: "index.aggregate_earnings_yield" }, { fact_id: "macro.long_bond_yield" }],
        output_id: "index.implied_equity_risk_premium",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "What the market is currently paying for equity risk over the risk-free rate. Damodaran's argument is that this number, not a historical average, is what a valuation should discount at.",
      },
      {
        tool_id: "master_damodaran.premium_versus_long_run_average",
        operation: "subtract",
        inputs: [{ output_id: "index.implied_equity_risk_premium" }, { literal: 0.042 }],
        output_id: "index.implied_premium_gap",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The current implied premium against its own long-run average of about 4.2%, which is how he judges whether the market as a whole is cheap or rich.",
      },
    ],
    eligibility: {
      all: [
        // His valuation is a forecast, not an accounting summary. Without a forward earnings view
        // there is nothing to discount and the seat has not valued anything.
        {
          condition_id: "master_damodaran.forward_earnings_available",
          condition: { op: "exists", value: { fact_id: "index.aggregate_pe_forward" } },
          on_false: { native_state: "unvalued", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "unvalued", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_damodaran.no_premium_over_riskfree",
        rationale:
          "The implied premium is by construction the extra return investors demand for holding equities instead of the risk-free asset. A premium of zero or below means the market is asking investors to take equity risk for no compensation, which no growth story or terminal assumption repairs.",
        condition: { op: "lte", left: { output_id: "index.implied_equity_risk_premium" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "overvalued" },
      },
    ],
    scoring: [
      {
        rule_id: "damodaran_premium_above_long_run_average",
        points: 1,
        coverage_weight: 1,
        rationale:
          "His own test for whether the market is cheap: an implied premium above the roughly 4.2% it has averaged since 1960 means investors are being paid more than usual for equity risk.",
        condition: { op: "gt", left: { output_id: "index.implied_premium_gap" }, right: { literal: 0 } },
      },
      {
        rule_id: "damodaran_equity_out_yields_corporate_debt",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The cross-check that the cost of equity must exceed the cost of debt for the same claim. An index earnings yield below the seasoned Aaa corporate yield inverts that ordering and makes the junior claim the worse deal.",
        condition: { op: "gt", left: { fact_id: "index.aggregate_earnings_yield" }, right: { fact_id: "macro.aaa_corporate_yield" } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "overvalued" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "fair_range" },
      { min_ratio: 1, common_stance: "constructive", native_state: "undervalued" },
    ],
  },

  master_dalio: {
    provenance:
      "Ray Dalio, \"How the Economic Machine Works\" (2013) and Bridgewater's published All Weather material (\"The All Weather Story\"; \"Engineering Targeted Returns and Risks\", 2009), in which asset returns are driven by growth and inflation coming in above or below what was already discounted, giving four environments; and Principles for Navigating Big Debt Crises (2018), whose template for the top of a short-term debt cycle is a central bank tightening real rates at the front end until the curve inverts and debt service outruns incomes. `macro.growth_regime` is the four-state text fact built from the direction of the ten-year-minus-three-month slope and the five-year breakeven, so it can only be compared with `eq`.",
    tools: [
      {
        tool_id: "master_dalio.policy_real_rate",
        operation: "subtract",
        inputs: [{ fact_id: "macro.short_bond_yield" }, { fact_id: "macro.breakeven_inflation" }],
        output_id: "macro.policy_real_rate",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The real rate at the front end, which is the measure of whether money is tight or easy. A nominal policy rate says nothing until inflation expectations are taken out of it.",
      },
      {
        tool_id: "master_dalio.real_curve_slope",
        operation: "subtract",
        inputs: [{ fact_id: "macro.real_rate" }, { output_id: "macro.policy_real_rate" }],
        output_id: "macro.real_curve_slope",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The long real rate less the policy real rate. Positive means the front end is easier than the market's long-run real rate; negative is the tightening configuration the debt-crisis template describes.",
      },
    ],
    eligibility: {
      all: [
        // The four boxes are the whole method. Without the growth and inflation state the seat
        // cannot place the environment at all, and should say so rather than score anything.
        {
          condition_id: "master_dalio.growth_inflation_state_known",
          condition: { op: "exists", value: { fact_id: "macro.growth_regime" } },
          on_false: { native_state: "regime_unknown", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "regime_unknown", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_dalio.short_term_debt_cycle_top",
        rationale:
          "The top template in Principles for Navigating Big Debt Crises: the central bank pushes the short real rate above the long real rate and the nominal curve inverts. The claim is that this configuration precedes the break, because debt service then rises faster than the incomes servicing it, so no allocation is resilient while both hold.",
        condition: {
          op: "all",
          conditions: [
            { op: "lt", left: { fact_id: "macro.term_structure_slope" }, right: { literal: 0 } },
            { op: "lt", left: { output_id: "macro.real_curve_slope" }, right: { literal: 0 } },
          ],
        },
        on_trigger: { common_stance: "opposed", native_state: "fragile" },
      },
    ],
    scoring: [
      {
        rule_id: "dalio_growth_axis_rising",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The first axis of the four boxes. Growth surprising upward is the environment in which growth-sensitive assets carry the portfolio; the All Weather argument is that you must know which box you are in before you can say anything about balance.",
        condition: {
          op: "any",
          conditions: [
            { op: "eq", left: { fact_id: "macro.growth_regime" }, right: { literal: "rising_growth_rising_inflation" } },
            { op: "eq", left: { fact_id: "macro.growth_regime" }, right: { literal: "rising_growth_falling_inflation" } },
          ],
        },
      },
      {
        rule_id: "dalio_inflation_axis_falling",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The second axis. Falling inflation is the half of the grid in which nominal bonds and equities can rise together, so a portfolio built on the usual stock-bond relationship is not being asked to survive the environment that breaks it.",
        condition: {
          op: "any",
          conditions: [
            { op: "eq", left: { fact_id: "macro.growth_regime" }, right: { literal: "rising_growth_falling_inflation" } },
            { op: "eq", left: { fact_id: "macro.growth_regime" }, right: { literal: "falling_growth_falling_inflation" } },
          ],
        },
      },
      {
        rule_id: "dalio_policy_not_restrictive",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The policy lever, stated in real terms as the machine model insists. A policy real rate below the market's long-run real rate means the central bank is not yet squeezing the debt cycle, which is the condition under which the machine keeps running.",
        condition: { op: "gt", left: { output_id: "macro.real_curve_slope" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "fragile" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "unbalanced" },
      { min_ratio: 1, common_stance: "constructive", native_state: "regime_resilient" },
    ],
  },

  master_druckenmiller: {
    provenance:
      "Stanley Druckenmiller's public remarks, principally the Lost Tree Club speech of January 2015 and his repeated statement that earnings do not move the overall market - central banks and the movement of liquidity do - together with his insistence that he will not fight the tape and needs price to confirm a macro thesis before sizing up. `macro.liquidity_impulse` is the ninety-one-day change in Federal Reserve net liquidity (total assets less the overnight reverse repo facility less the Treasury General Account) and `macro.term_structure_slope` is the ten-year minus three-month Treasury spread. `market.change_pct` is a single session's move, which is a thin proxy for price confirmation and is treated as such.",
    tools: [
      {
        tool_id: "master_druckenmiller.liquidity_curve_impulse",
        operation: "mean",
        inputs: [{ fact_id: "macro.liquidity_impulse" }, { fact_id: "macro.term_structure_slope" }],
        output_id: "macro.liquidity_curve_impulse",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The pair he says he watches, averaged into one reading: is liquidity being added, and is the curve telling the same story. Either one alone is half a signal.",
      },
      {
        tool_id: "master_druckenmiller.policy_real_rate",
        operation: "subtract",
        inputs: [{ fact_id: "macro.short_bond_yield" }, { fact_id: "macro.breakeven_inflation" }],
        output_id: "macro.policy_real_rate",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The real cost of money at the front end, which decides whether the central bank is adding to or draining the liquidity he trades off.",
      },
    ],
    eligibility: {
      all: [
        // He does not act on a macro view the tape contradicts. With no price action there is
        // nothing to confirm against, so there is no inflection to trade.
        {
          condition_id: "master_druckenmiller.price_action_available",
          condition: { op: "exists", value: { fact_id: "market.change_pct" } },
          on_false: { native_state: "no_inflection", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "no_inflection", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_druckenmiller.liquidity_draining_into_inversion",
        rationale:
          "Liquidity contracting while the curve is inverted is the configuration in which he says there is nothing to do on the long side. The method exists to find an asymmetric setup, and when both primary drivers point the same way against risk there is no inflection to probe. No inflection is a reason not to have a position, which is itself his most repeated instruction: he sizes hard when he sees the turn and stays out otherwise. Standing aside is the output, not the absence of one.",
        condition: {
          op: "all",
          conditions: [
            { op: "lt", left: { fact_id: "macro.liquidity_impulse" }, right: { literal: 0 } },
            { op: "lt", left: { fact_id: "macro.term_structure_slope" }, right: { literal: 0 } },
          ],
        },
        on_trigger: { common_stance: "out_of_scope", native_state: "no_inflection" },
      },
    ],
    scoring: [
      {
        rule_id: "druckenmiller_liquidity_and_curve_impulse_positive",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The Lost Tree Club claim in testable form: liquidity, not earnings, moves the market. Net liquidity expanding while the curve is not inverted is the condition under which he says the tide is coming in.",
        condition: { op: "gt", left: { output_id: "macro.liquidity_curve_impulse" }, right: { literal: 0 } },
      },
      {
        rule_id: "druckenmiller_policy_real_rate_not_restrictive",
        points: 1,
        coverage_weight: 1,
        rationale:
          "His stated focus on the central bank rather than the economy. A negative real policy rate is unambiguously stimulative and needs no threshold to be chosen; zero is the boundary between paying and being paid to hold cash.",
        condition: { op: "lt", left: { output_id: "macro.policy_real_rate" }, right: { literal: 0 } },
      },
      {
        rule_id: "druckenmiller_price_confirms",
        points: 1,
        coverage_weight: 1,
        rationale:
          "He will not put the position on while the tape disagrees with the thesis. Price rising is the weakest possible form of that confirmation, and it is the only price-action fact this pack carries.",
        condition: { op: "gt", left: { fact_id: "market.change_pct" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "probing" },
      { min_ratio: 1, common_stance: "constructive", native_state: "asymmetric_setup" },
    ],
  },

  master_asness: {
    provenance:
      "Clifford Asness, \"Fight the Fed Model\" (Journal of Portfolio Management, Fall 2003), which argues that setting a real earnings yield against a nominal bond yield is money illusion and that the comparison belongs against the real yield; Asness, Moskowitz and Pedersen, \"Value and Momentum Everywhere\" (Journal of Finance, 2013), whose result is that value and momentum together dominate either alone; and AQR's published capital market assumptions, which compare expected equity premia against credit premia rather than treating equities in isolation. `macro.real_rate` is the ten-year TIPS yield.",
    tools: [
      {
        tool_id: "master_asness.real_earnings_yield_gap",
        operation: "subtract",
        inputs: [{ fact_id: "index.aggregate_earnings_yield" }, { fact_id: "macro.real_rate" }],
        output_id: "index.real_earnings_yield_gap",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The comparison \"Fight the Fed Model\" says is the correct one: an earnings yield is a real quantity, so it belongs against the real bond yield.",
      },
      {
        tool_id: "master_asness.nominal_earnings_yield_gap",
        operation: "subtract",
        inputs: [{ fact_id: "index.aggregate_earnings_yield" }, { fact_id: "macro.long_bond_yield" }],
        output_id: "index.implied_equity_risk_premium",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The Fed model's own comparison, computed only so the seat can detect when it disagrees with the real one. Same construction as the Damodaran seat, deliberately sharing the output id.",
      },
    ],
    eligibility: {
      all: [
        // Value without momentum is the half of the published result that does not stand alone.
        // Without a price trend the seat cannot say which exposure it is actually looking at.
        {
          condition_id: "master_asness.price_trend_observable",
          condition: { op: "exists", value: { fact_id: "market.change_pct" } },
          on_false: { native_state: "unidentified_exposure", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "unidentified_exposure", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_asness.fed_model_illusion",
        rationale:
          "The exact error named in \"Fight the Fed Model\". When the nominal comparison says equities are cheap and the real comparison says they are not, the apparent premium is inflation being counted twice rather than an identified exposure, and the seat should decline instead of scoring the illusion.",
        condition: {
          op: "all",
          conditions: [
            { op: "gt", left: { output_id: "index.implied_equity_risk_premium" }, right: { literal: 0 } },
            { op: "lte", left: { output_id: "index.real_earnings_yield_gap" }, right: { literal: 0 } },
          ],
        },
        on_trigger: { common_stance: "out_of_scope", native_state: "unidentified_exposure" },
      },
    ],
    scoring: [
      {
        rule_id: "asness_real_yield_gap_positive",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The value leg, stated the way \"Fight the Fed Model\" insists it must be: the index earnings yield above the real bond yield, so the comparison is real against real.",
        condition: { op: "gt", left: { output_id: "index.real_earnings_yield_gap" }, right: { literal: 0 } },
      },
      {
        rule_id: "asness_momentum_confirms_value",
        points: 1,
        coverage_weight: 1,
        rationale:
          "\"Value and Momentum Everywhere\" reports that the two signals are negatively correlated and that combining them beats either alone. A cheap market that is still falling is exactly the case the paper says value handles badly on its own.",
        condition: { op: "gt", left: { fact_id: "market.change_pct" }, right: { literal: 0 } },
      },
      {
        rule_id: "asness_equity_premium_beats_credit_premium",
        points: 1,
        coverage_weight: 1,
        rationale:
          "AQR's practice of setting expected equity premia against credit premia. An equity premium smaller than the compensation available for high-yield credit risk means the equity exposure is not the efficient way to buy that risk.",
        condition: { op: "gt", left: { output_id: "index.real_earnings_yield_gap" }, right: { fact_id: "macro.credit_spread" } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "cautious", native_state: "factor_replication" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "mixed" },
      { min_ratio: 1, common_stance: "constructive", native_state: "residual_candidate" },
    ],
  },

  master_natenberg: {
    provenance:
      "Sheldon Natenberg, Option Volatility and Pricing, 2nd edition (2015): the chapters on volatility spreads and the volatility surface, in which skew is judged relative to the level of implied volatility rather than in absolute volatility points and equity options normally price out-of-the-money puts above calls; and the practical-considerations material, in which a theoretical edge only exists after the width of the market has been paid twice, once to get in and once to get out. The ten-per-cent round-trip cut-off and the five-per-cent skew materiality line are this project's readings; the book gives the tests but not the numbers.",
    tools: [
      {
        tool_id: "master_natenberg.normalised_skew",
        operation: "divide",
        inputs: [{ fact_id: "options.skew_25d" }, { fact_id: "options.implied_volatility" }],
        output_id: "options.normalised_skew",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The twenty-five-delta put-minus-call skew as a fraction of the at-the-money volatility level. Four volatility points of skew mean something very different on a twelve-volatility name than on an eighty-volatility one.",
      },
      {
        tool_id: "master_natenberg.round_trip_cost",
        operation: "multiply",
        inputs: [{ fact_id: "execution.bid_ask" }, { literal: 2 }],
        output_id: "execution.round_trip_cost",
        value_kind: "ratio",
        unit: "decimal_of_mid",
        purpose:
          "The quoted width is paid on the way in and again on the way out, so the cost any theoretical edge has to clear is twice the spread, not once.",
      },
    ],
    eligibility: {
      all: [
        // A relative-value volatility trade is a trade between points on a surface. One
        // expiration is a price, not a surface, and there is nothing relative left to value.
        {
          condition_id: "master_natenberg.term_structure_available",
          condition: { op: "exists", value: { fact_id: "options.term_structure" } },
          on_false: { native_state: "surface_unavailable", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "surface_unavailable", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_natenberg.untradeable_spread",
        rationale:
          "The practical constraint the book keeps returning to: an edge smaller than the cost of crossing the market twice is not an edge, it is a fee. A round trip costing a tenth of the option's mid price or more consumes any realistic volatility edge, which is this project's reading of a bound Natenberg states qualitatively.",
        condition: { op: "gte", left: { output_id: "execution.round_trip_cost" }, right: { literal: 0.1 } },
        on_trigger: { common_stance: "opposed", native_state: "mispriced_untradeable" },
      },
    ],
    scoring: [
      {
        rule_id: "natenberg_volatility_exceeds_round_trip_friction",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The sanity check before any volatility spread: the volatility being traded has to be larger than what it costs to get into and out of the position. The two quantities are not dimensionally identical - one is an annualised volatility, the other a fraction of the option's mid price - so this is a friction screen, not an edge calculation.",
        condition: { op: "gt", left: { fact_id: "options.implied_volatility" }, right: { output_id: "execution.round_trip_cost" } },
      },
      {
        rule_id: "natenberg_skew_material_versus_level",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Equity options normally price out-of-the-money puts above calls, and a surface with essentially no skew relative to its own volatility level offers nothing to spread against. Five per cent of the at-the-money level is this project's reading of what counts as a shape rather than noise.",
        condition: { op: "gt", left: { output_id: "options.normalised_skew" }, right: { literal: 0.05 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "mispriced_untradeable" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "fair" },
      { min_ratio: 1, common_stance: "constructive", native_state: "relative_value" },
    ],
  },
});

export default coreSeats;
