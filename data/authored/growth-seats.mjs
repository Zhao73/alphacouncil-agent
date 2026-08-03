/**
 * Authored method logic for the six growth, activism and adversarial seats, keyed by persona id.
 *
 * Same contract and same discipline as the other authored seat files:
 * a seat listed here gets its real formulas and its real decision policy, a seat absent from it
 * keeps the mechanical identity proxy, and every threshold either traces to a named published
 * source or is labelled in `rationale` and `provenance` as this project's reading rather than
 * the author's.
 *
 * Everything here is AI-authored and unreviewed. It is barred from production admission by the
 * same gates that bar the proxies; what changes is only that the arithmetic is the method's own
 * rather than a placeholder.
 *
 * ---------------------------------------------------------------------------------------
 * Contract notes for the pipeline that consumes this file
 * ---------------------------------------------------------------------------------------
 *
 * 1. `native_state` values are the RAW state names from each seat's
 *    `native_decision_contract.states` in `data/persona-v3-build-specs.v1.mjs`. They are mapped
 *    through `executableNativeState()`, which adds the `provisional_` prefix. Do not pre-prefix
 *    them here or they double-prefix and stop matching the declared state set.
 *
 * 1. `eligibility.all[]` entries carry the executor's own record shape
 *    (`condition_id` / `condition` / `on_false` / `on_uncomputable`) but omit `source_ids`,
 *    because the source id is minted at build time. The pipeline must inject `source_ids` the
 *    way it already does for hard vetoes and scoring rules, and must map the two mapping states
 *    through `executableNativeState()`.
 *
 * 2. `purpose` on tools and `rationale` on vetoes and rules are authoring metadata. The executor
 *    rejects unknown fields, so neither may be copied into the physical policy or tool records.
 *
 * 3. Chained tools: a tool that consumes another tool's `output_id` must take the PRODUCER's
 *    `value_kind` and `unit` as its input contract, not its own. Three seats here divide a
 *    monetary numerator by a monetary market capitalisation to produce a ratio, exactly as
 *    Buffett and Graham do, so a consumer-derived input contract fails
 *    `does not match producer ... output contract`.
 *
 * 4. Shared `output_id`s are deliberate and denote the same number built the same way, both
 *    inside this file and across it and the nine-seat file:
 *      valuation.market_capitalisation    cathie_wood, ackman                  price x share count
 *                                         (= buffett, graham)
 *      valuation.owner_earnings_yield     ackman (= buffett)                   owner earnings / cap
 *      valuation.free_cash_flow_yield     cathie_wood                          5y avg FCF / cap
 *      accounting.cash_conversion_gap     forensic_short, jhunjhunwala         OCF/NI less one
 *
 * 5. Scoring points are one per rule throughout, so `max_score` is the rule count and the
 *    builder's `max_score === sum(points)` check holds without this file restating it.
 *
 * 6. `master_forensic_short` inverts the usual band ordering on purpose. Its affirmative output
 *    is a short, and a seat that has completed a short case is `opposed` to owning the security,
 *    not constructive on it. The stance rises with the strength of the case AGAINST the name.
 */
export const growthSeats = Object.freeze({
  master_fisher: {
    provenance:
      "Philip A. Fisher, Common Stocks and Uncommon Profits (1958): ch. 2 on scuttlebutt, and the fifteen points of ch. 3 -- point 2 (management's determination to keep developing products that raise total sales once the current lines' growth is exploited), point 3 (research and development effectiveness relative to the company's size), point 5 (does the company have a worthwhile profit margin) and point 6 (what is being done to maintain or improve it); together with Conservative Investors Sleep Well (1975) on superiority in production, marketing, research and financial skill. The scuttlebutt work itself -- the dated public customer, supplier, competitor and former-employee evidence the build spec plans as this seat's first tool -- is NOT a fact in this pack and is not modelled here. What survives measurement is the residue Fisher said that work should show up in: a sustained margin and reinvestment that earns. Fisher published no numeric cut-off anywhere in the fifteen points, so both numbers this seat uses are labelled: the seasoned Aaa corporate yield as the hurdle incremental capital must beat, and one quarter of the gross margin reaching the bottom line, are this project's readings.",
    tools: [
      {
        tool_id: "master_fisher.margin_retention",
        operation: "divide",
        inputs: [{ fact_id: "financial.net_margin_5y" }, { fact_id: "financial.gross_margin_5y" }],
        output_id: "financial.margin_retention",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "How much of the gross spread survives everything Fisher spends points 3 and 4 on -- the research organisation and the sales organisation. Point 5 asks for a worthwhile margin and point 6 asks what is being done to hold it; the fraction of gross margin that reaches the bottom line is the observable form of both, and it is scale-free in a way an absolute margin is not.",
      },
      {
        tool_id: "master_fisher.reinvestment_spread",
        operation: "subtract",
        inputs: [{ fact_id: "financial.incremental_return_on_capital" }, { fact_id: "macro.aaa_corporate_yield" }],
        output_id: "financial.reinvestment_spread",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "What the last increment of capital earned, less what lending it to a high-grade borrower would have paid. Point 2 is a claim about reinvestment continuing to work; the spread is the only place in these facts where that claim leaves a mark.",
      },
    ],
    eligibility: {
      all: [
        // Fisher's subject is long-duration growth quality, judged over many years. Without a
        // decade of returns there is no operating record for the public stakeholder evidence to
        // corroborate, and this seat is already working without the scuttlebutt itself.
        {
          condition_id: "master_fisher.decade_of_operating_record",
          condition: { op: "exists", value: { fact_id: "financial.return_on_equity_10y" } },
          on_false: { native_state: "insufficient_scuttlebutt", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "insufficient_scuttlebutt", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_fisher.no_worthwhile_margin",
        rationale:
          "Point 5 asks whether the company has a worthwhile profit margin at all, and Fisher warned in the same chapter that the apparent percentage gains of the marginal company in an industry are illusory. A business averaging no profit over five years has no margin to maintain and no growth quality to assess; zero is Fisher's own boundary, not a chosen level.",
        condition: { op: "lte", left: { fact_id: "financial.net_margin_5y" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
      {
        veto_id: "master_fisher.research_without_return",
        rationale:
          "Point 3 measures research effectiveness by economic output, not by spending. Capital going into the business at a negative incremental return is research and expansion that destroys what the earlier product cycles built, which is the failure mode the build spec names as this seat's third veto family.",
        condition: { op: "lte", left: { fact_id: "financial.incremental_return_on_capital" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
    ],
    scoring: [
      {
        rule_id: "fisher_new_capital_earns_more_than_the_installed_base",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Point 2 in its testable form. A company whose next dollar earns more than the average dollar already inside it is still finding the new products Fisher says management must keep developing; one whose next dollar earns less is growing by dilution of its own economics. The comparison needs no threshold because the business supplies both sides of it.",
        condition: { op: "gt", left: { fact_id: "financial.incremental_return_on_capital" }, right: { fact_id: "financial.return_on_equity_10y" } },
      },
      {
        rule_id: "fisher_reinvestment_beats_lending_the_money_out",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The reinvestment runway is only an asset while reinvesting beats the alternative. Zero on the spread is the boundary at which the research and expansion programme stops being better than handing the money to a high-grade corporate borrower. Fisher named the test in points 2 and 3 and named no rate; the seasoned Aaa corporate yield as the alternative is this project's choice.",
        condition: { op: "gt", left: { output_id: "financial.reinvestment_spread" }, right: { literal: 0 } },
      },
      {
        rule_id: "fisher_margin_survives_the_research_and_sales_organisation",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Point 6 asks what the company is doing to maintain or improve margins. A quarter of the gross margin reaching the bottom line means the research and selling organisations are being paid for out of the spread rather than consuming it. One quarter is this project's reading; Fisher gave the test and no number.",
        condition: { op: "gt", left: { output_id: "financial.margin_retention" }, right: { literal: 0.25 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "reject" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "long_duration_quality" },
    ],
  },

  master_cathie_wood: {
    provenance:
      "ARK Invest's published research: the annual Big Ideas reports and the Wright's Law white papers, in which the cost of a technology falls by a fixed percentage per cumulative doubling of units produced and the falling cost is what drives adoption; and ARK's disclosed valuation-model convention of a minimum 15% compound annual return hurdle over a five-year investment horizon, which is the one numeric bar in the method that is actually published. A technology cost curve is NOT among this pack's facts -- there is no cost-per-unit series, no cumulative-production series and no adoption-rate series, so the learning rate that is the whole engine of the method cannot be fitted here. What is measurable is the far end of the same argument: the growth the business is actually delivering, set against the expectation already embedded in what the price earns. The comparison of a revenue growth rate with a free-cash-flow yield is a compressed stand-in for ARK's five-year adoption-to-cash-flow bridge, not the bridge itself, and this project says so rather than implying a model it did not run.",
    tools: [
      {
        tool_id: "master_cathie_wood.market_capitalisation",
        operation: "multiply",
        inputs: [{ fact_id: "market.price" }, { fact_id: "capital_allocation.share_count" }],
        output_id: "valuation.market_capitalisation",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "The denominator every price-implied expectation needs. Built the same way as the Buffett and Graham seats build it, and sharing their output id on purpose.",
      },
      {
        tool_id: "master_cathie_wood.current_cash_yield",
        operation: "divide",
        inputs: [{ fact_id: "financial.free_cash_flow_5y" }, { output_id: "valuation.market_capitalisation" }],
        output_id: "valuation.free_cash_flow_yield",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "How much of the price today's cash already pays for. Everything above this yield is adoption the market has bought in advance, which is the only form of a price-implied expectation these facts can produce.",
      },
    ],
    eligibility: {
      all: [
        // The method is about the rate at which a falling cost curve converts into revenue. With
        // no revenue growth series there is no adoption to measure, and with no cost curve in the
        // pack there is nothing left to fall back on.
        {
          condition_id: "master_cathie_wood.adoption_rate_observable",
          condition: { op: "exists", value: { fact_id: "valuation.revenue_growth" } },
          on_false: { native_state: "unsupported_theme", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "unsupported_theme", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_cathie_wood.adoption_already_priced",
        rationale:
          "The build spec's third veto family: reject a constructive output when the price requires adoption beyond the reviewed scenario range. Both halves have to hold. The company is growing below ARK's own published 15% five-year hurdle, and the price is not being paid for by current cash either, since the free-cash-flow yield is below what a long government bond pays for no business risk. That combination is a price that can only be defended by adoption the growth rate is not delivering.",
        condition: {
          op: "all",
          conditions: [
            { op: "lt", left: { fact_id: "valuation.revenue_growth" }, right: { literal: 0.15 } },
            { op: "lt", left: { output_id: "valuation.free_cash_flow_yield" }, right: { fact_id: "macro.long_bond_yield" } },
          ],
        },
        on_trigger: { common_stance: "opposed", native_state: "overpriced_adoption" },
      },
    ],
    scoring: [
      {
        rule_id: "wood_growth_clears_the_published_hurdle",
        points: 1,
        coverage_weight: 1,
        rationale:
          "ARK's disclosed minimum hurdle: a 15% compound annual return over a five-year horizon, below which a name does not earn a place in the portfolio. It is stated as a return rather than a revenue rate, so applying it to revenue growth is this project's translation of a published bar rather than a bar ARK set on this quantity.",
        condition: { op: "gte", left: { fact_id: "valuation.revenue_growth" }, right: { literal: 0.15 } },
      },
      {
        rule_id: "wood_growth_exceeds_what_the_price_already_earns",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The disruption case says the market systematically underestimates how fast the cost curve converts into revenue. If the business grows more slowly than the cash yield the price already earns, then nothing about that price requires an adoption story at all, and whatever is being bought is not the theme. Zero threshold: the two quantities supply the comparison themselves.",
        condition: { op: "gt", left: { fact_id: "valuation.revenue_growth" }, right: { output_id: "valuation.free_cash_flow_yield" } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "overpriced_adoption" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "asymmetric_innovation" },
    ],
  },

  master_ackman: {
    provenance:
      "Pershing Square Capital Management's published investment criteria, repeated across its investor presentations and the Pershing Square Holdings annual reports and letters: simple, predictable, free-cash-flow-generative businesses with formidable barriers to entry, a strong balance sheet and limited need for external capital, a large gap between price and intrinsic value, and an ability to influence the outcome. Two of those four are facts here and two are not. The value gap is measurable as the owner-earnings yield against the long government bond, using the owner-earnings definition from the appendix to Berkshire's 1986 annual report, which is where this pack's `financial.owner_earnings` comes from. The balance sheet is measurable as leverage. Voting control, board rights, blocking rights, the identified actor who can legally cause the change, the implementation cost and the campaign timeline are NOT facts in this pack -- the entire power map that the build spec plans as this seat's first tool is absent, and with it any claim that a catalyst is executable. What remains is a value gap plus the capital-allocation lever, and this seat says only that. Both leverage lines are this project's readings: debt no greater than equity as the balance sheet that could finance a change, and three times equity as the point past which it plainly could not. Pershing published neither ratio.",
    tools: [
      {
        tool_id: "master_ackman.market_capitalisation",
        operation: "multiply",
        inputs: [{ fact_id: "market.price" }, { fact_id: "capital_allocation.share_count" }],
        output_id: "valuation.market_capitalisation",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "The price of the whole company, which is what a value gap is measured against. Same construction and same output id as the Buffett, Graham and Cathie Wood seats.",
      },
      {
        tool_id: "master_ackman.owner_earnings_yield",
        operation: "divide",
        inputs: [{ fact_id: "financial.owner_earnings" }, { output_id: "valuation.market_capitalisation" }],
        output_id: "valuation.owner_earnings_yield",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "What an owner earns on the purchase price of the business as it stands today, before any change. This is the standalone half of the standalone-versus-improvement split the method is built on; the improvement half has no facts and is not computed.",
      },
    ],
    eligibility: {
      all: [
        // Engagement is a financed act. Without the capital structure the seat cannot say whether
        // a change could be paid for, and it certainly cannot say who has the power to cause one,
        // so the honest output is that the position could only ever be passive.
        {
          condition_id: "master_ackman.capital_structure_resolvable",
          condition: { op: "exists", value: { fact_id: "financial.leverage" } },
          on_false: { native_state: "passive_only", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "passive_only", common_stance: "out_of_scope" },
        },
        // The power map is absent, so the capital-allocation record is the only observable lever
        // this seat has left. Without it there is nothing an engaged holder could point at, and
        // the answer is passive ownership rather than a scoring rule that quietly fails to compute.
        {
          condition_id: "master_ackman.capital_allocation_history_available",
          condition: { op: "exists", value: { fact_id: "capital_allocation.share_count_change_5y" } },
          on_false: { native_state: "passive_only", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "passive_only", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_ackman.no_standalone_downside",
        rationale:
          "The build spec's first veto family, and Pershing's own free-cash-flow-generative criterion. A business that does not throw off positive owner earnings has no defensible standalone value, so there is no floor under the engagement and no gap for a lever to close -- the campaign would be the entire thesis.",
        condition: { op: "lte", left: { fact_id: "financial.owner_earnings" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "infeasible" },
      },
      {
        veto_id: "master_ackman.balance_sheet_cannot_finance_change",
        rationale:
          "Pershing's stated criterion of a strong balance sheet and limited need for external capital. A company carrying more than three times its equity in debt has its creditors, not its shareholders, deciding what happens next, and no improvement path is financeable from that position. Three times is this project's reading of a qualitative criterion.",
        condition: { op: "gt", left: { fact_id: "financial.leverage" }, right: { literal: 3 } },
        on_trigger: { common_stance: "opposed", native_state: "infeasible" },
      },
    ],
    scoring: [
      {
        rule_id: "ackman_value_gap_over_the_long_bond",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The large gap between price and value, in the only form these facts support: the rate an owner earns on the purchase price must beat what the long government bond pays for no business risk. Below that line there is nothing for a campaign to unlock that the bond market is not already offering.",
        condition: { op: "gt", left: { output_id: "valuation.owner_earnings_yield" }, right: { fact_id: "macro.long_bond_yield" } },
      },
      {
        rule_id: "ackman_balance_sheet_can_carry_the_change",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The strong-balance-sheet criterion. Debt no greater than equity leaves the financing capacity that any recapitalisation, separation or buyback would consume. The one-times line is this project's reading; Pershing states the criterion qualitatively.",
        condition: { op: "lt", left: { fact_id: "financial.leverage" }, right: { literal: 1 } },
      },
      {
        rule_id: "ackman_capital_allocation_lever_exists",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The lever, stated as something observable rather than as a wish. A share count that has grown over five years is capital being handed away, and capital allocation is the lever an engaged holder can actually pull without needing operational control. This is a deliberate inversion of the usual reading of dilution: for this method a company already doing the right thing has less to fix, not more to offer. The direction is this project's reading, not a test Ackman published.",
        condition: { op: "gt", left: { fact_id: "capital_allocation.share_count_change_5y" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "infeasible" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "engagement_candidate" },
    ],
  },

  master_forensic_short: {
    provenance:
      "A synthetic professional method seat, not a model of one person, so its sources are the published literature and practice rather than an author. Richard G. Sloan, \"Do Stock Prices Fully Reflect Information in Accruals and Cash Flows About Future Earnings?\", The Accounting Review 71(3), 1996, which establishes that the accrual component of earnings is the part that does not persist; Howard M. Schilit, Jeremy Perler and Yoni Engelhart, Financial Shenanigans, 4th ed. (2018), whose first cash-flow test is operating cash flow running persistently below reported net income; and Messod D. Beneish, \"The Detection of Earnings Manipulation\", Financial Analysts Journal, 1999, for direction only -- the M-score's eight inputs are not in this pack and no score is computed here. The fixed-charge bar is borrowed openly from Benjamin Graham, The Intelligent Investor ch. 11, which sets five times before income taxes as the minimum acceptable coverage for an industrial issue; a forensic short reads the same number from the other side, as the point at which an accounting problem acquires a financing deadline. `accounting.cash_conversion` is operating cash flow over net income, so one-for-one is the neutral line and the sign of the gap is the signal. What is missing is the trade: borrow cost, borrow availability, crowding and squeeze risk have no free public source, so the financing leg of the short is unmeasured and this seat can identify a case it cannot cost. The catalyst is missing too. Both absences are the build spec's own stated limits, and neither is papered over here. The one-unit-of-cash-conversion-per-unit-of-leverage line is this project's construction and this project's reading; no published source sets it.",
    tools: [
      {
        tool_id: "master_forensic_short.cash_conversion_gap",
        operation: "subtract",
        inputs: [{ fact_id: "accounting.cash_conversion" }, { literal: 1 }],
        output_id: "accounting.cash_conversion_gap",
        value_kind: "ratio",
        unit: "multiple",
        purpose:
          "How far operating cash flow falls short of the earnings that were reported. One-for-one conversion is the neutral point of the ratio, so subtracting it turns a level into a signed signal and removes the need to compare a multiple against a chosen number.",
      },
      {
        tool_id: "master_forensic_short.cash_cover_of_leverage",
        operation: "divide",
        inputs: [{ fact_id: "accounting.cash_conversion" }, { fact_id: "financial.leverage" }],
        output_id: "accounting.cash_conversion_per_unit_leverage",
        value_kind: "ratio",
        unit: "multiple",
        purpose:
          "The same shortfall measured against the balance sheet that has to survive it. Converting little of your earnings into cash while carrying no debt is a bookkeeping question; doing it while carrying a lot of debt is the configuration in which the accounting becomes a solvency event. The construction is this project's, and it is undefined in sign when cash conversion itself is negative -- which is why the negative case is caught by the scoring rule on the gap, not by this ratio.",
      },
    ],
    eligibility: {
      all: [
        // The short is a trade against a deadline, and the deadline is set by fixed charges. With
        // no coverage figure there is nothing that forces the accounting to resolve, and an
        // allegation with no resolution path is the thing this seat is built to refuse to make.
        {
          condition_id: "master_forensic_short.fixed_charge_record_available",
          condition: { op: "exists", value: { fact_id: "financial.interest_coverage" } },
          on_false: { native_state: "unsupported_allegation", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "unsupported_allegation", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_forensic_short.no_allegation_to_make",
        rationale:
          "The build spec's first veto family, applied to the two things this seat can actually measure. Operating cash flow running ahead of reported earnings is the opposite of the accrual signal, and debt below equity removes the financing pressure that would force any remaining question to resolve. When both point away from a case, the honest output is that there is no allegation, not a weaker version of one assembled from what is left. The debt-below-equity line is this project's reading.",
        condition: {
          op: "all",
          conditions: [
            { op: "gt", left: { output_id: "accounting.cash_conversion_gap" }, right: { literal: 0 } },
            { op: "lt", left: { fact_id: "financial.leverage" }, right: { literal: 1 } },
          ],
        },
        on_trigger: { common_stance: "out_of_scope", native_state: "unsupported_allegation" },
      },
    ],
    scoring: [
      {
        rule_id: "forensic_short_earnings_do_not_become_cash",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Sloan's result and Schilit's first cash-flow test, in the one fact this pack carries for either. Reported profit that operating cash flow does not follow is the accrual component, and the accrual component is the part that does not persist. Zero on the gap is one-for-one conversion, an arithmetic boundary rather than a chosen level.",
        condition: { op: "lt", left: { output_id: "accounting.cash_conversion_gap" }, right: { literal: 0 } },
      },
      {
        rule_id: "forensic_short_shortfall_sits_on_a_levered_balance_sheet",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The pairing that turns an accounting observation into a trade the method would take: less than one unit of cash-converted earnings for each unit of balance-sheet leverage. This is where the short's timing pressure comes from, since the leverage is what refuses to wait. Both the ratio and the one-times line are this project's construction and reading; no source publishes either.",
        condition: { op: "lt", left: { output_id: "accounting.cash_conversion_per_unit_leverage" }, right: { literal: 1 } },
      },
      {
        rule_id: "forensic_short_fixed_charges_thinly_covered",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Graham's five-times fixed-charge coverage for an industrial issue (The Intelligent Investor ch. 11), read from the short side. Below it, the fixed charges are not comfortably covered and the accounting question has a date attached to it. The number is Graham's and published; borrowing it for a short seat is this project's choice, and it is named rather than presented as this method's own.",
        condition: { op: "lt", left: { fact_id: "financial.interest_coverage" }, right: { literal: 5 } },
      },
    ],
    bands: [
      // Inverted on purpose: the affirmative output of this seat is a short. See note 7 above.
      { min_ratio: 0, common_stance: "cautious", native_state: "red_flags_no_trade" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "opposed", native_state: "forensic_short_candidate" },
    ],
  },

  master_jhunjhunwala: {
    provenance:
      "Rakesh Jhunjhunwala's public interviews and conference appearances -- CNBC-TV18, ET Now and the Economic Times markets summits -- in which he said repeatedly that he was buying India's structural growth story and that the integrity of the promoter was the first filter, before any number; and the Indian record that method reads, namely the quarterly shareholding-pattern, promoter-pledge and bulk-deal disclosures that SEBI requires of BSE- and NSE-listed issuers. He died on 14 August 2022, so no current view is attributable to him. There is no Indian industry-penetration series here, and the promoter category does not exist as a US filing concept. What does exist is Section 16: officers, directors and holders of more than ten percent must file Forms 3, 4 and 5 stating what they hold afterwards, and `governance.insider_ownership` sums the newest such filing per reporting owner over shares outstanding. Treating that as the promoter shareholding record is this project's reading, not his: Section 16 covers a narrower set of people, reports trust and family holdings inconsistently, and carries a person who has not transacted since their Form 3 at that number. It is used the way he used the promoter record -- as the first filter, before the growth arithmetic -- and the seat says so rather than presenting it as the Indian disclosure. The real-growth and cash-conversion tests are this project's readings of statements he made without numbers.",
    tools: [
      {
        tool_id: "master_jhunjhunwala.real_structural_growth",
        operation: "subtract",
        inputs: [{ fact_id: "valuation.revenue_growth" }, { fact_id: "macro.breakeven_inflation" }],
        output_id: "valuation.real_revenue_growth",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "Structural penetration is a claim about volume, not about price. Nominal growth that only matches expected inflation is the same business selling the same quantity at a higher number, which is what he meant by distinguishing the India growth story from the India inflation rate.",
      },
      {
        tool_id: "master_jhunjhunwala.cash_quality_gap",
        operation: "subtract",
        inputs: [{ fact_id: "accounting.cash_conversion" }, { literal: 1 }],
        output_id: "accounting.cash_conversion_gap",
        value_kind: "ratio",
        unit: "multiple",
        purpose:
          "The build spec's second veto family in computable form: scaling claims that cash conversion does not support. Same construction and same output id as the forensic-short seat, because it is the same number -- operating cash flow against reported earnings, with one-for-one as the neutral line.",
      },
    ],
    eligibility: {
      all: [
        // The method's first filter is who owns the company, and it stays first: without an
        // ownership record there is no governance read, and the growth arithmetic on its own is
        // a momentum screen with his name on it. The US analogue is the Section 16 register.
        {
          condition_id: "master_jhunjhunwala.ownership_record_available",
          condition: { op: "exists", value: { fact_id: "governance.insider_ownership" } },
          on_false: { native_state: "insufficient_governance", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "insufficient_governance", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_jhunjhunwala.cash_conversion",
        rationale:
          "The build spec's second veto family, and his own repeated public insistence that a growth story has to end up as cash. Operating cash flow that is outright negative while the business reports profits and claims to be scaling is the case he said he would not hold at any price. Zero is the boundary, not a chosen level.",
        condition: { op: "lt", left: { fact_id: "accounting.cash_conversion" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
    ],
    scoring: [
      {
        rule_id: "jhunjhunwala_growth_is_real_rather_than_nominal",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Penetration means more customers, not higher prices. Revenue growth above expected inflation is the minimum form of that distinction, and it is the closest this pack gets to the industry-penetration series the method actually reads. Zero on the real rate is a boundary; the substitution of a US breakeven for an Indian one is this project's compromise and is not his.",
        condition: { op: "gt", left: { output_id: "valuation.real_revenue_growth" }, right: { literal: 0 } },
      },
      {
        rule_id: "jhunjhunwala_scaling_converts_to_cash",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Cycle-aware cash conversion is the second thing the build spec says this method requires of a scaling claim. Operating cash flow at least matching reported earnings is one-for-one conversion, an arithmetic boundary rather than a level anyone chose.",
        condition: { op: "gte", left: { output_id: "accounting.cash_conversion_gap" }, right: { literal: 0 } },
      },
      {
        rule_id: "jhunjhunwala_owners_hold_the_company_they_run",
        points: 1,
        coverage_weight: 1,
        rationale:
          "He would not take a growth story from people with nothing at stake in it, and the promoter shareholding was where he looked. One percent of the register held by Section 16 insiders is this project's line, not his: it is where a US register stops being a pure agency structure and the people running the business hold a position that a bad decision costs them. The narrower coverage of Section 16 against an Indian promoter disclosure is recorded on the seat rather than adjusted for here.",
        condition: { op: "gte", left: { fact_id: "governance.insider_ownership" }, right: { literal: 0.01 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "reject" },
      { min_ratio: 0.34, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "concentrated_growth_candidate" },
    ],
  },
});

export default growthSeats;
