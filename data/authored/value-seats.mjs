/**
 * Authored method logic for the six remaining value seats, keyed by persona id.
 *
 * Same contract and same discipline as the other authored seat files,
 * which authored buffett, graham, bogle, marks, damodaran, dalio, druckenmiller, asness and
 * natenberg. This file finishes the value bench: munger, klarman, pabrai, li_lu, duan_yongping
 * and lynch.
 *
 * Everything here is AI-authored and unreviewed. It is barred from production admission by the
 * same gates that bar the mechanical proxies; what changes is only that the arithmetic is now
 * the method's own rather than a placeholder. Each seat names its published source in
 * `provenance`, and every veto and scoring rule says in `rationale` what the person actually
 * claimed. Where a published method gives a direction but no number, the rationale says so and
 * labels the cut-off as this project's reading rather than the author's. Where the method needs
 * something this pack carries no fact for -- Munger's incentive audit, Klarman's catalyst,
 * Pabrai's outcome tree, Li Lu's promise ledger, Duan's culture evidence, Lynch's category --
 * the provenance says so and names the substitute rather than inventing a threshold for it.
 *
 * ---------------------------------------------------------------------------------------
 * Contract notes for the pipeline that consumes this file
 * ---------------------------------------------------------------------------------------
 *
 * 1. `native_state` values are the RAW state names from each seat's
 *    `native_decision_contract.states` in `data/persona-v3-build-specs.v1.mjs`. They are mapped
 *    through `executableNativeState()`, which adds the `provisional_` prefix. Do not pre-prefix
 *    them here or they double-prefix and stop matching the declared state set. Note that
 *    `master_munger` legitimately declares a state literally named `out_of_scope`; it is a raw
 *    state name like any other and becomes `provisional_out_of_scope`.
 *
 * 2. `eligibility.all[]` entries carry the executor's own record shape
 *    (`condition_id` / `condition` / `on_false` / `on_uncomputable`) but omit `source_ids`,
 *    because the source id is minted at build time. The pipeline must inject `source_ids` the
 *    way it already does for hard vetoes and scoring rules, and must map both mapping states
 *    through `executableNativeState()`.
 *
 * 3. `purpose` on tools and `rationale` on vetoes and rules are authoring metadata. The
 *    executor rejects unknown fields, so neither may be copied into the physical policy or tool
 *    records. Nor may `max_score` be written here: `authoredDecisionPolicy` computes it as the
 *    sum of `points`, and the band `min_ratio` values are fractions of that sum.
 *
 * 4. Chained tools: a tool that consumes another tool's `output_id` must take the PRODUCER's
 *    `value_kind` and `unit` as its input contract, not its own. Klarman and Pabrai both divide
 *    a monetary balance-sheet floor by a monetary market capitalisation to produce a ratio, so a
 *    consumer-derived input contract fails `does not match producer ... output contract`.
 *
 * 5. Shared `output_id`s across seats are deliberate and denote the same number built the same
 *    way. `valuation.market_capitalisation` here is the same price-times-share-count product
 *    Buffett and Graham build, and Klarman, Pabrai and Lynch all take it as a denominator.
 *
 * 6. Period arithmetic that is easy to get wrong twice. `financial.free_cash_flow_5y` is the
 *    FIVE-YEAR CUMULATIVE figure, not an annual average, and `valuation.revenue_growth` is a
 *    five-year compound annual rate. Duan's seat compares five years of cash against five years
 *    of forgone interest, so both sides span the same window and no annualisation is needed.
 *    Lynch's seat needs an annual earnings figure, so the literal 20 in his second tool carries
 *    the division by five AND the conversion of a decimal growth rate into the percentage points
 *    his rule is written in (one fifth of the cumulative figure, times one hundred g).
 *
 * 7. Four seats declare two eligibility conditions rather than one. `min_coverage` is 1, so a
 *    single uncomputable scoring rule collapses a seat to out_of_scope with no explanation at
 *    all. Where a scoring fact is a genuine prerequisite of the method AND can be absent while
 *    the seat's tools still compute, the seat says so in eligibility instead, where the
 *    abstention has its own exit and its own reason: Munger's and Lynch's leverage, which the
 *    fundamentals layer returns as null rather than a number when book equity is not positive;
 *    Pabrai's implied volatility, which comes from an options chain a name may not have; and
 *    Duan's cash-flow record, without which his one definition of value has no input. Facts that
 *    travel with the rest of the filing bundle and are one axis of a verdict rather than a
 *    precondition for it -- Li Lu's five-year share count change -- are left in scoring, which is
 *    where the authored Buffett seat leaves the same fact.
 */
export const valueSeats = Object.freeze({
  master_munger: {
    provenance:
      "Charlie Munger, \"A Lesson on Elementary, Worldly Wisdom as it Relates to Investment Management and Business\" (USC Marshall School of Business, 1994) and \"The Psychology of Human Misjudgment\" (Harvard Law School, June 1995), both collected in Poor Charlie's Almanack (2005): the method is inversion -- \"invert, always invert\", and \"all I want to know is where I'm going to die so I'll never go there\" -- together with the three-basket rule that sends anything he cannot explain to the too-hard pile, his repeated line that liquor, ladies and leverage are what ruin people, and his standing objection to accounting that flatters, of which EBITDA is his own named example. Of his stated failure paths this pack can measure three: borrowed money, the interest bill against operating earnings, and whether reported profit arrives as cash. It cannot measure the fourth and, on his own account, the most important -- the incentive structure -- because no governance fact exists here; the seat is therefore a partial inversion and says so. Every cut-off below is this project's reading. Munger published a direction on each of these and a number on none of them.",
    tools: [
      {
        tool_id: "master_munger.reported_earnings_cash_gap",
        operation: "subtract",
        inputs: [{ fact_id: "accounting.cash_conversion" }, { literal: 1 }],
        output_id: "accounting.reported_earnings_cash_gap",
        value_kind: "ratio",
        unit: "multiple",
        purpose:
          "The accounting failure path, measured as a distance rather than a level. Operating cash flow equal to reported net income is a gap of zero; everything below that is the part of the earnings that exists only on the income statement.",
      },
      {
        tool_id: "master_munger.debt_service_cushion",
        operation: "subtract",
        inputs: [{ fact_id: "financial.interest_coverage" }, { literal: 1 }],
        output_id: "risk.debt_service_cushion",
        value_kind: "ratio",
        unit: "multiple",
        purpose:
          "The debt failure path, measured the same way. One times coverage is not a safety threshold, it is the point of failure itself -- the interest bill consuming the operating earnings whole -- so the useful number is the distance from it.",
      },
    ],
    eligibility: {
      all: [
        // The too-hard pile. If you cannot say what a marginal dollar earns inside the business,
        // you cannot describe the machine, and describing the machine is the price of an opinion.
        {
          condition_id: "master_munger.economics_can_be_stated",
          condition: { op: "exists", value: { fact_id: "financial.incremental_return_on_capital" } },
          on_false: { native_state: "out_of_scope", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "out_of_scope", common_stance: "out_of_scope" },
        },
        // Inversion needs the fastest route to zero to be visible. Debt over book equity is that
        // route, and it is absent precisely when book equity is not positive -- which is a fact
        // about the company, not a gap, and deserves to be said rather than scored around.
        {
          condition_id: "master_munger.capital_structure_readable",
          condition: { op: "exists", value: { fact_id: "financial.leverage" } },
          on_false: { native_state: "out_of_scope", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "out_of_scope", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_munger.coupled_debt_failure",
        rationale:
          "The coupled-failure family in his own words: several required assumptions failing through one shared cause. Debt above book equity is survivable and thin interest cover is survivable, but together they are one condition, not two, because the same borrowing produces both. Debt above one turn of equity with coverage below three times operating earnings is this project's reading of where the two stop being independent; Munger named the mechanism and no ratio.",
        condition: {
          op: "all",
          conditions: [
            { op: "gt", left: { fact_id: "financial.leverage" }, right: { literal: 1 } },
            { op: "lt", left: { output_id: "risk.debt_service_cushion" }, right: { literal: 2 } },
          ],
        },
        on_trigger: { common_stance: "opposed", native_state: "fatal_path" },
      },
      {
        veto_id: "master_munger.reported_earnings_are_not_cash",
        rationale:
          "Munger's standing objection to accounting that flatters, of which his EBITDA remark is the best known instance. When barely half of reported net income arrives as operating cash, the income statement is describing a different company from the one the cash flow statement describes, and there is nothing left to value. Half is this project's reading of where a gap becomes a fabrication rather than a timing difference.",
        condition: { op: "lt", left: { output_id: "accounting.reported_earnings_cash_gap" }, right: { literal: -0.5 } },
        on_trigger: { common_stance: "opposed", native_state: "fatal_path" },
      },
    ],
    scoring: [
      {
        rule_id: "munger_earnings_arrive_as_cash",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Inversion applied to the income statement: not \"are the earnings good\" but \"is there a path by which the earnings are not real\". Operating cash flow at or above net income closes that path. The line needs no invented threshold because parity is the definition of the fact.",
        condition: { op: "gte", left: { output_id: "accounting.reported_earnings_cash_gap" }, right: { literal: 0 } },
      },
      {
        rule_id: "munger_debt_service_has_a_cushion",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The interest bill is the failure path that runs on a schedule and does not wait for the business to recover. A cushion of four turns above the break-even -- operating earnings five times the interest -- is the fixed-charge discipline of the Graham tradition Munger and Buffett came out of, applied here as this project's reading; Munger himself published no coverage ratio.",
        condition: { op: "gte", left: { output_id: "risk.debt_service_cushion" }, right: { literal: 4 } },
      },
      {
        rule_id: "munger_no_leverage_dependency",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The third L. Munger ran Wesco and the Daily Journal with almost no borrowing and repeated that leverage is one of the things that ruins people who would otherwise have been fine. Debt no larger than book equity is this project's reading of \"almost none\"; the claim is his, the number is not.",
        condition: { op: "lte", left: { fact_id: "financial.leverage" }, right: { literal: 1 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "fatal_path" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "monitor" },
      { min_ratio: 1, common_stance: "constructive", native_state: "no_fatal_path_found" },
    ],
  },

  master_klarman: {
    provenance:
      "Seth Klarman, Margin of Safety: Risk-Averse Value Investing Strategies for the Thoughtful Investor (HarperBusiness, 1991), whose central instruction is that the margin of safety is measured against a conservatively reconstructed value -- and preferably against what the assets are actually worth -- rather than against a forecast of what the business might earn; together with his preface to the sixth edition of Security Analysis (2008) and his repeated statement that Baupost would rather hold cash than own something at an inadequate margin, which is why absolute return and not relative performance is the yardstick. `valuation.downside_asset_value` is this pack's Klarman-style floor and is built as tangible book plus cash less total debt, so it is a balance-sheet reconstruction with no forecast in it, which is exactly the quantity his method wants. The two things his method needs that this pack cannot supply are the catalyst and the security's own position in the capital structure; interest coverage stands in for the second, and the first is simply absent -- a catalyst-free reading of Klarman is an incomplete one and the seat does not pretend otherwise. The half-coverage line in the second scoring rule is this project's reading; the one-times line and the two-thirds lineage are not.",
    tools: [
      {
        tool_id: "master_klarman.market_capitalisation",
        operation: "multiply",
        inputs: [{ fact_id: "market.price" }, { fact_id: "capital_allocation.share_count" }],
        output_id: "valuation.market_capitalisation",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "The downside asset value is an absolute currency amount and says nothing until it is set against what the whole company costs. Price times share count is that denominator, built the same way Buffett's and Graham's seats build it.",
      },
      {
        tool_id: "master_klarman.downside_asset_coverage",
        operation: "divide",
        inputs: [{ fact_id: "valuation.downside_asset_value" }, { output_id: "valuation.market_capitalisation" }],
        output_id: "valuation.downside_asset_coverage",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "How much conservatively assessed asset value each unit of purchase price is already backed by. Coverage of one means the price is fully covered by tangible assets net of debt, and the buyer is paying nothing for the forecast.",
      },
    ],
    eligibility: {
      all: [
        // The recovery waterfall is the method. Without a leverage figure the claims standing
        // ahead of the common are unknown, and an asset value the equity cannot reach is not a
        // floor -- so the downside is genuinely unknown rather than merely unattractive.
        {
          condition_id: "master_klarman.senior_claims_resolvable",
          condition: { op: "exists", value: { fact_id: "financial.leverage" } },
          on_false: { native_state: "downside_unknown", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "downside_unknown", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_klarman.no_reconstructable_downside",
        rationale:
          "Margin of Safety begins from what an asset is worth on conservative assumptions, and the whole method is the distance between that figure and the price. When tangible book plus cash less debt is zero or negative there is no conservatively assessed value to be safe below, and the correct answer is that the downside cannot be reconstructed -- not that the security is expensive.",
        condition: { op: "lte", left: { fact_id: "valuation.downside_asset_value" }, right: { literal: 0 } },
        on_trigger: { common_stance: "out_of_scope", native_state: "downside_unknown" },
      },
      {
        veto_id: "master_klarman.senior_claims_consume_the_assets",
        rationale:
          "The recovery waterfall inverts at exactly one times. When operating earnings do not cover the interest, the lenders are being paid out of the assets rather than out of the business, and the asset value the common is nominally behind is already being consumed by the claim in front of it. One times is not a chosen threshold; it is the arithmetic point where the waterfall stops reaching the equity.",
        condition: { op: "lt", left: { fact_id: "financial.interest_coverage" }, right: { literal: 1 } },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
    ],
    scoring: [
      {
        rule_id: "klarman_price_at_or_below_downside_assets",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The strong form of the margin of safety and the thing the book is named for: the price is covered in full by a value that assumes nothing about the future. At coverage of one the buyer is paying for the assets and receiving the business for nothing.",
        condition: { op: "gte", left: { output_id: "valuation.downside_asset_coverage" }, right: { literal: 1 } },
      },
      {
        rule_id: "klarman_downside_covers_half_the_price",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The weaker form, and the one that separates a merely cheap security from a rich one. When conservatively assessed assets cover half the price, the forecast is being asked to carry the other half rather than all of it. One half is this project's reading of where a margin of safety begins; Klarman insists the margin be substantial and declines to name a fraction, saying it depends on the asset.",
        condition: { op: "gte", left: { output_id: "valuation.downside_asset_coverage" }, right: { literal: 0.5 } },
      },
      {
        rule_id: "klarman_debt_leaves_the_common_a_claim",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Capital preservation before return. The asset floor belongs to the holders of the senior claims first, and the more borrowing sits ahead of the common the less of that floor is actually the common's. Debt no larger than book equity is this project's reading of a structure in which the equity still owns its own downside.",
        condition: { op: "lte", left: { fact_id: "financial.leverage" }, right: { literal: 1 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "reject" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "wait_in_cash" },
      { min_ratio: 1, common_stance: "constructive", native_state: "absolute_return_candidate" },
    ],
  },

  master_pabrai: {
    provenance:
      "Mohnish Pabrai, The Dhandho Investor: The Low-Risk Value Method to High Returns (Wiley, 2007): the nine Dhandho principles, the framing sentence \"heads, I win; tails, I don't lose much\", the chapter that takes Graham's margin of safety over unchanged, and the distinction he returns to in talks and in the book between risk and uncertainty -- the method looks for low risk paired with high uncertainty, because the market discounts the two as though they were the same thing. `valuation.downside_floor` is this pack's Pabrai-style floor and is built as the lower of net current asset value and tangible book, reporting which term bound it, so it is deliberately the more conservative of two conservative numbers. Uncertainty has no direct fact here; the twenty-five-delta implied volatility of the listed options is the only place in this pack where the market states how uncertain it thinks the outcome is, and it is used as the substitute. Pabrai does not trade options and never mentions them, so both the substitution and the forty-per-cent line are this project's reading. The outcome tree and the concentration limit that complete his method have no facts here at all and are absent rather than approximated.",
    tools: [
      {
        tool_id: "master_pabrai.market_capitalisation",
        operation: "multiply",
        inputs: [{ fact_id: "market.price" }, { fact_id: "capital_allocation.share_count" }],
        output_id: "valuation.market_capitalisation",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "What the whole business costs today, so that an absolute floor can be compared with an absolute price. Same construction as the other seats that need a denominator.",
      },
      {
        tool_id: "master_pabrai.downside_floor_coverage",
        operation: "divide",
        inputs: [{ fact_id: "valuation.downside_floor" }, { output_id: "valuation.market_capitalisation" }],
        output_id: "valuation.downside_floor_coverage",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The tails half of the sentence, as a number: how much of what you paid is already covered by the more conservative of net current assets and tangible book. This is the quantity that decides whether the downside is small, and it is computed before anything is said about the upside.",
      },
    ],
    eligibility: {
      all: [
        // The floor is only worth anything if the business survives long enough to realise it,
        // which is the financing-runway half of his own eligibility list. Interest cover is the
        // nearest thing this pack carries to a runway.
        {
          condition_id: "master_pabrai.financing_runway_readable",
          condition: { op: "exists", value: { fact_id: "financial.interest_coverage" } },
          on_false: { native_state: "no_floor", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "no_floor", common_stance: "out_of_scope" },
        },
        // The whole method turns on separating uncertainty from risk. With no reading of what
        // the market thinks the uncertainty is, there is no Dhandho judgement to make, and the
        // seat should say that here rather than collapse silently on an uncomputable score.
        {
          condition_id: "master_pabrai.uncertainty_is_observable",
          condition: { op: "exists", value: { fact_id: "options.implied_volatility" } },
          on_false: { native_state: "no_floor", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "no_floor", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_pabrai.no_downside_floor",
        rationale:
          "The first Dhandho question is what the downside is, and the method has no second question until that one is answered. A floor of zero or below means neither net current assets nor tangible book leaves anything recoverable, so \"tails, I don't lose much\" is not a claim the facts support at any price.",
        condition: { op: "lte", left: { fact_id: "valuation.downside_floor" }, right: { literal: 0 } },
        on_trigger: { common_stance: "out_of_scope", native_state: "no_floor" },
      },
      {
        veto_id: "master_pabrai.financing_fails_before_resolution",
        rationale:
          "His own fail-closed reason, that the financing must survive to the resolution. Operating earnings below the interest bill mean the lenders decide the timetable, and a floor that is only reachable after a restructuring is not a floor the buyer of the common owns. One times is the arithmetic break-even, not a chosen line.",
        condition: { op: "lt", left: { fact_id: "financial.interest_coverage" }, right: { literal: 1 } },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
    ],
    scoring: [
      {
        rule_id: "pabrai_floor_covers_the_price",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Tails, I don't lose much -- in its strongest available form. Coverage of one means the conservative floor already accounts for the entire purchase price, so the outcome tree only has to decide how much is won, not whether capital is lost.",
        condition: { op: "gte", left: { output_id: "valuation.downside_floor_coverage" }, right: { literal: 1 } },
      },
      {
        rule_id: "pabrai_uncertainty_is_high_where_risk_is_not",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The distinction the whole method rests on. Pabrai's claim is that the market prices high uncertainty as though it were high risk, so a wide range of outcomes sitting on top of a floor is where the mispricing lives -- a quiet, certain, fully priced business offers him nothing. Forty per cent annualised implied volatility is this project's reading of \"high uncertainty\", and the use of an options quote to measure it is this project's substitution, not his.",
        condition: { op: "gte", left: { fact_id: "options.implied_volatility" }, right: { literal: 0.4 } },
      },
      {
        rule_id: "pabrai_financing_survives_to_resolution",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Few bets and big bets are only survivable if the individual bet cannot be forced to close early. Operating earnings at three times the interest bill leave the timetable with the owner rather than the lender; three is this project's reading of a runway, and the number is not one Pabrai published.",
        condition: { op: "gte", left: { fact_id: "financial.interest_coverage" }, right: { literal: 3 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "reject" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "asymmetric_candidate" },
    ],
  },

  master_li_lu: {
    provenance:
      "Li Lu's 2015 lecture at the Guanghua School of Management, Peking University, on the prospects for value investing in China; his 2006 talk at Columbia Business School; and his foreword to the Chinese edition of Poor Charlie's Almanack. The recurring claims are that the horizon is ten years and not one, that over that horizon the market weighs rather than votes, that only a small minority of businesses compound at all, that the buyer of a share is an owner of a business and should behave as one, and that intellectual honesty about what one does and does not know is the discipline the rest depends on. He states all of this as a standard and none of it as a ratio. The two facts here that span a full cycle are the ten-year return on equity and the five-year revenue path; the honesty check is whether the reported return survives being restated in cash, which is the closest public substitute for the promise-versus-action ledger his method actually calls for. Management's dated commitments, the ledger's real content, are not in this pack at all -- the five-year change in share count stands in for it as the one management action toward existing owners that is always observable. The contract gives this seat exactly one opposed state, `integrity_reject`, so both the accounting veto and the zero-score band land there.",
    tools: [
      {
        tool_id: "master_li_lu.decade_return_over_long_bond",
        operation: "subtract",
        inputs: [{ fact_id: "financial.return_on_equity_10y" }, { fact_id: "macro.long_bond_yield" }],
        output_id: "valuation.decade_return_over_long_bond",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The ten-year return bridge in its simplest form. Over a holding period that long the owner's return converges on what the business earns on its own capital, so the comparison that matters is against what a government bond paid for taking no business risk at all.",
      },
      {
        tool_id: "master_li_lu.cash_backed_decade_return",
        operation: "multiply",
        inputs: [{ fact_id: "financial.return_on_equity_10y" }, { fact_id: "accounting.cash_conversion" }],
        output_id: "valuation.cash_backed_decade_return",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The decade's return on equity restated in cash. A return on equity that the cash flow statement does not support is a return the owner never receives, and ten years is long enough that the difference compounds into the whole answer.",
      },
    ],
    eligibility: {
      all: [
        // A ten-year judgement is a judgement about durability, and durability is a multi-year
        // observation. Without a five-year margin history there is no evidence the business held
        // anything, and the honest answer is that the seat does not understand it yet.
        {
          condition_id: "master_li_lu.durability_evidence_available",
          condition: { op: "exists", value: { fact_id: "financial.gross_margin_5y" } },
          on_false: { native_state: "do_not_understand", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "do_not_understand", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_li_lu.reported_return_is_not_cash",
        rationale:
          "The integrity ledger, in the one form that is public for every company. What management reports and what the business actually collected are two statements about the same year, and a persistent gap between them is a statement about management, not about accounting policy. Operating cash flow below half of reported net income is this project's reading of where the gap becomes an integrity question rather than a timing one; Li Lu describes the standard and publishes no ratio.",
        condition: { op: "lt", left: { fact_id: "accounting.cash_conversion" }, right: { literal: 0.5 } },
        on_trigger: { common_stance: "opposed", native_state: "integrity_reject" },
      },
      {
        veto_id: "master_li_lu.decline_not_a_cycle",
        rationale:
          "His own warning that a low price on a structurally declining business is not a bargain, and that the work is to separate decline from a cycle. Five years is long enough to span most cycles, so a five-year compound revenue rate of minus five per cent or worse is a business shrinking rather than a business between peaks. This pack carries nothing that can make the separation he asks for, so the seat declines rather than pricing a decline it cannot classify; both the five-year window and the five-per-cent line are this project's reading.",
        condition: { op: "lt", left: { fact_id: "valuation.revenue_growth" }, right: { literal: -0.05 } },
        on_trigger: { common_stance: "out_of_scope", native_state: "do_not_understand" },
      },
    ],
    scoring: [
      {
        rule_id: "li_lu_decade_return_beats_the_long_bond",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The weighing-machine claim made testable. A decade of return on equity below what the long government bond paid is a decade in which the owner was not compensated for owning a business instead of lending to a state, and no entry price repairs a decade. Zero needs no invented threshold.",
        condition: { op: "gt", left: { output_id: "valuation.decade_return_over_long_bond" }, right: { literal: 0 } },
      },
      {
        rule_id: "li_lu_decade_return_survives_restatement_in_cash",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Intellectual honesty applied to the seat's own headline number. Comparing the cash-backed decade return with the reported one asks whether the business collected more than it booked; the comparison is between two computed quantities, so it holds whatever the level of the return happens to be and imports no threshold.",
        condition: {
          op: "gt",
          left: { output_id: "valuation.cash_backed_decade_return" },
          right: { fact_id: "financial.return_on_equity_10y" },
        },
      },
      {
        rule_id: "li_lu_owner_slice_not_diluted",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Owner mentality read from the register rather than from what management says about itself. A share count that has not grown over five years means the existing owners' slice of the ten-year compounding is still theirs. This is a substitute for the promise-versus-action ledger the method wants and this pack cannot supply.",
        condition: { op: "lte", left: { fact_id: "capital_allocation.share_count_change_5y" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "integrity_reject" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "long_duration_owner" },
    ],
  },

  master_duan_yongping: {
    provenance:
      "Duan Yongping's signed posts on Xueqiu and Sina Weibo under the handle 大道无形我有型, and his university talks and interviews: the yardstick is opportunity cost -- what else the same money could have been doing -- and he applies it by comparing any candidate against the best thing he already owns rather than against a benchmark; value is the discounted future cash the business produces and nothing else; buying a share is buying the company; and the culture test is 本分, which he glosses as doing the right things and then doing them right, with the stop-doing list as its operational half. Two substitutions are unavoidable here and neither is his. First, the alternative: he compares against a specific holding, and this pack carries no such asset, so the seat uses the seasoned high-grade corporate yield as the nearest liquid alternative an owner could actually have chosen instead. Second, user value: he judges it from the product and its users, and no such fact exists here, so the five-year gross margin stands in as the only public trace of customers paying a premium for something differentiated. Both margin lines and the growth line in the second veto are this project's reading. `financial.free_cash_flow_5y` is a five-year cumulative figure, which is why the first tool multiplies the alternative's annual yield by five: both sides of the comparison then span the same five years.",
    tools: [
      {
        tool_id: "master_duan_yongping.five_year_opportunity_cost",
        operation: "multiply",
        inputs: [
          { fact_id: "market.price" },
          { fact_id: "capital_allocation.share_count" },
          { fact_id: "macro.aaa_corporate_yield" },
          { literal: 5 },
        ],
        output_id: "valuation.five_year_opportunity_cost",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "Opportunity cost expressed as an amount of money rather than a rate: the interest the whole purchase price would have earned in high-grade corporate bonds over the same five years the cash-flow fact covers. Stating it in currency lets the comparison be made against the cash the business actually produced, with no annualisation on either side.",
      },
      {
        tool_id: "master_duan_yongping.margin_retention",
        operation: "divide",
        inputs: [{ fact_id: "financial.net_margin_5y" }, { fact_id: "financial.gross_margin_5y" }],
        output_id: "business.margin_retention",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The share of the gross margin that survives everything the company does with it. Gross margin is evidence that the right thing was made; how much of it reaches the owner is evidence about whether it was then done well.",
      },
    ],
    eligibility: {
      all: [
        // 不懂不做. His first question is how the business makes money over the long run. Without
        // even a revenue trajectory there is no long-run mechanism to state, and the seat should
        // say it does not understand the business rather than price something it cannot describe.
        {
          condition_id: "master_duan_yongping.business_trajectory_stateable",
          condition: { op: "exists", value: { fact_id: "valuation.revenue_growth" } },
          on_false: { native_state: "do_not_understand", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "do_not_understand", common_stance: "out_of_scope" },
        },
        // His one definition of value is the discounted future cash. With no cash-flow record
        // there is no value to compare against any alternative, so the opportunity-cost question
        // cannot be asked at all -- which is an abstention, not a low score.
        {
          condition_id: "master_duan_yongping.cash_record_exists",
          condition: { op: "exists", value: { fact_id: "financial.free_cash_flow_5y" } },
          on_false: { native_state: "do_not_understand", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "do_not_understand", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_duan_yongping.nothing_to_discount",
        rationale:
          "His only definition of value is the discounted future cash the business will produce. Five years of cumulative free cash flow at or below zero means the business has produced none over the period the pack can observe, so there is nothing to discount and no price is the right price. This is a statement about the definition, not a threshold.",
        condition: { op: "lte", left: { fact_id: "financial.free_cash_flow_5y" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
      {
        veto_id: "master_duan_yongping.growth_without_user_value",
        rationale:
          "The case he is most consistently scathing about: revenue bought with price rather than earned with product, which he treats as the opposite of 本分 because it wins the quarter and destroys the business. Revenue compounding above twenty per cent while the gross margin sits below twenty is growth being purchased, and the seat rejects it however good the growth looks. Both numbers are this project's reading of a pattern he describes without quantifying.",
        condition: {
          op: "all",
          conditions: [
            { op: "gt", left: { fact_id: "valuation.revenue_growth" }, right: { literal: 0.2 } },
            { op: "lt", left: { fact_id: "financial.gross_margin_5y" }, right: { literal: 0.2 } },
          ],
        },
        on_trigger: { common_stance: "opposed", native_state: "reject" },
      },
    ],
    scoring: [
      {
        rule_id: "duan_five_year_cash_beats_the_alternative",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Opportunity cost as the yardstick, and the only rule here with no invented number in it: the cash the business actually produced over five years, against the interest the same purchase price would have collected from high-grade corporate bonds over the same five years. He would run this against the best business he already owns; the bond is this pack's nearest available stand-in for that.",
        condition: {
          op: "gt",
          left: { fact_id: "financial.free_cash_flow_5y" },
          right: { output_id: "valuation.five_year_opportunity_cost" },
        },
      },
      {
        rule_id: "duan_product_carries_a_premium",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Doing the right thing, in the only form the filings show it. Duan reads a durable gross margin as customers voluntarily paying more for something they prefer, which is what he means by user value; a business that must match the cheapest competitor has no such evidence. Forty per cent is this project's reading, and the substitution of margin for users is this project's, not his.",
        condition: { op: "gte", left: { fact_id: "financial.gross_margin_5y" }, right: { literal: 0.4 } },
      },
      {
        rule_id: "duan_margin_reaches_the_owner",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Then doing it right. A premium product spent entirely on the cost of selling it leaves the owner with nothing, which is the failure the stop-doing list exists to prevent. A quarter of the gross margin surviving to net income is this project's reading of an organisation that converts its advantage rather than consuming it.",
        condition: { op: "gte", left: { output_id: "business.margin_retention" }, right: { literal: 0.25 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "reject" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "wait" },
      { min_ratio: 1, common_stance: "constructive", native_state: "act_at_price" },
    ],
  },

  master_lynch: {
    provenance:
      "Peter Lynch, One Up on Wall Street (1989): the six company categories in chapter 5, which fix the order of operations -- classify first, value second, because the same multiple means different things to a slow grower and a fast grower; the two-minute drill in chapter 9; and chapter 13, \"Some Famous Numbers\", which supplies both published thresholds used here. The first is his statement that the price-earnings ratio of a fairly priced company will equal its growth rate, with a ratio below the growth rate marking a possible bargain. The second is his description of a normal corporate balance sheet as seventy-five per cent equity and twenty-five per cent debt, which is a debt-to-equity ratio of one third and is exactly what `financial.leverage` measures. The category itself is the one thing this pack cannot supply -- there is no category fact and no two-minute story -- so the seat substitutes the five-year compound revenue rate, which places a company on the growth axis only and cannot distinguish a cyclical from a turnaround from an asset play. The rate is a revenue rate rather than the earnings rate Lynch's rule is written against, which is a further substitution. `financial.free_cash_flow_5y` is a five-year cumulative figure, so the literal 20 in the second tool is one fifth of it -- a year's cash -- times the hundred that turns a decimal growth rate into the percentage points the rule compares a multiple against. The leverage line in the second veto is this project's reading; the two scoring thresholds are Lynch's own.",
    tools: [
      {
        tool_id: "master_lynch.market_capitalisation",
        operation: "multiply",
        inputs: [{ fact_id: "market.price" }, { fact_id: "capital_allocation.share_count" }],
        output_id: "valuation.market_capitalisation",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "What the market is asking for the whole company, which is the left-hand side of Lynch's comparison once the multiple is restated as an amount of money rather than a ratio.",
      },
      {
        tool_id: "master_lynch.growth_justified_capitalisation",
        operation: "multiply",
        inputs: [
          { fact_id: "financial.free_cash_flow_5y" },
          { fact_id: "valuation.revenue_growth" },
          { literal: 20 },
        ],
        output_id: "valuation.lynch_growth_justified_capitalisation",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "Lynch's fair price, computed as an amount rather than a ratio so that no arithmetic has to happen inside a condition. A year's cash flow -- one fifth of the cumulative five-year fact -- multiplied by the growth rate in percentage points is the capitalisation at which the multiple exactly equals the growth rate. Twenty carries both conversions: the division by five and the hundred that turns a decimal into percentage points.",
      },
    ],
    eligibility: {
      all: [
        // Classify before valuing. The pack has no category fact, so the weakest usable proxy for
        // a category-specific financial series is a multi-year profitability record: with no such
        // series there is nothing to test a story against and no category to place the company in.
        {
          condition_id: "master_lynch.category_series_available",
          condition: { op: "exists", value: { fact_id: "financial.net_margin_5y" } },
          on_false: { native_state: "category_mismatch", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "category_mismatch", common_stance: "out_of_scope" },
        },
        // The balance-sheet half of the two-minute drill runs before the valuation half. Debt to
        // book equity is what chapter 13 measures, and the fundamentals layer returns it as null
        // rather than a number when book equity is not positive -- a case Lynch would call a
        // turnaround and this pack cannot classify.
        {
          condition_id: "master_lynch.balance_sheet_readable",
          condition: { op: "exists", value: { fact_id: "financial.leverage" } },
          on_false: { native_state: "category_mismatch", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "category_mismatch", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_lynch.story_without_earnings",
        rationale:
          "His standing warning about the company whose story has outrun its earnings, and the reason he insists on knowing what the company earns before hearing why it is exciting. Five years of cumulative free cash flow at or below zero also makes the growth-justified capitalisation zero or negative, so the chapter 13 rule has nothing to compare and the story is all there is.",
        condition: { op: "lte", left: { fact_id: "financial.free_cash_flow_5y" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "story_invalid" },
      },
      {
        veto_id: "master_lynch.balance_sheet_break",
        rationale:
          "The balance-sheet check that comes before the valuation in his own order of operations, on the argument that companies without debt cannot go bankrupt and companies with a great deal of it are a different investment from the one the story describes. Debt at twice book equity is six times the seventy-five-twenty-five structure he calls normal; the multiple of his own normal is this project's reading, since he names the normal and no rejection line.",
        condition: { op: "gt", left: { fact_id: "financial.leverage" }, right: { literal: 2 } },
        on_trigger: { common_stance: "opposed", native_state: "story_invalid" },
      },
    ],
    scoring: [
      {
        rule_id: "lynch_multiple_at_or_below_growth_rate",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Chapter 13 stated as a comparison between two amounts of money: the company costs no more than the capitalisation at which its multiple would equal its growth rate. Lynch's own gloss is that a fairly priced company trades at a multiple equal to its growth rate and that anything below it may be a bargain. Revenue growth stands in for the earnings growth his rule is written against.",
        condition: {
          op: "lte",
          left: { output_id: "valuation.market_capitalisation" },
          right: { output_id: "valuation.lynch_growth_justified_capitalisation" },
        },
      },
      {
        rule_id: "lynch_normal_balance_sheet",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The other published number in chapter 13: a normal corporate balance sheet is seventy-five per cent equity and twenty-five per cent debt. That is a debt-to-equity ratio of one third, which is what this fact measures directly, so the threshold is his rather than this project's.",
        condition: { op: "lte", left: { fact_id: "financial.leverage" }, right: { literal: 0.33 } },
      },
      {
        rule_id: "lynch_fast_grower_growth_rate",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The classification step, reduced to the only axis this pack can observe. Lynch puts fast growers at twenty to twenty-five per cent a year and says that is where the large winners are found; below it a company is a stalwart or a slow grower and the same multiple should be paid differently. This places the company on the growth axis and does not attempt the cyclical, turnaround or asset-play distinctions, which need facts that are absent.",
        condition: { op: "gte", left: { fact_id: "valuation.revenue_growth" }, right: { literal: 0.2 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "story_invalid" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "category_opportunity" },
    ],
  },
});

export default valueSeats;
