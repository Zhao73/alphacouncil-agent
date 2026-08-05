/**
 * Authored method logic for the six quant, options and adversarial seats, keyed by persona id.
 *
 * Same contract and same discipline as the other authored files: taleb, thorp, simons, soros,
 * sinclair and burry get their real formulas and their real decision policies, and a seat
 * absent from this set keeps the mechanical identity proxy.
 *
 * Everything here is AI-authored and unreviewed. It is barred from production admission by the
 * same gates that bar the mechanical proxies; what changes is only that the arithmetic is now
 * the method's own rather than a placeholder. Each seat names its published source in
 * `provenance`, and every veto and scoring rule says in `rationale` what the person actually
 * claimed. Where a published method gives a direction but no number, the rationale says so and
 * labels the cut-off as this project's reading rather than the author's.
 *
 * These six are the batch where the gap between the method and the facts is widest, so each
 * `provenance` opens by naming what is missing rather than burying it: there is no realised
 * volatility and no volatility forecast (Sinclair's gross edge), no sample definition at all -
 * no dataset, no feature timestamps, no holdout, no count of hypotheses tried (Simons's entire
 * test), no variance fact for the Kelly denominator (Thorp's actual formula), no dated
 * loop-break condition (Soros's own requirement), and no seniority, covenant, borrow or carry
 * detail, which is to say no mispricing mechanism (Burry's whole subject). Each seat uses the
 * nearest defensible substitute and says which one it is; none of them invents a threshold to
 * stand where a missing fact should be.
 *
 * ---------------------------------------------------------------------------------------
 * Contract notes for the pipeline that consumes this file
 * ---------------------------------------------------------------------------------------
 *
 * 1. `native_state` values are the RAW state names from each seat's
 *    `native_decision_contract.states` in `data/persona-v3-build-specs.v1.mjs`. They are mapped
 *    through `executableNativeState()`, which adds the `provisional_` prefix. Do not pre-prefix
 *    them here or they double-prefix and stop matching the declared state set. Note that
 *    `master_thorp` legitimately declares a state literally named `out_of_scope`; it is a raw
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
 * 4. Chained tools: a tool consuming another tool's `output_id` must take the PRODUCER's
 *    `value_kind` and `unit` as its input contract. Every chain in this file is deliberately
 *    same-kind and same-unit - ratio/decimal into ratio/decimal for thorp and simons,
 *    monetary/currency_units into monetary/currency_units for burry - so it validates whether
 *    the consumer's or the producer's contract is used. That is why burry sets net current
 *    assets against the price by subtracting in one currency rather than by dividing a monetary
 *    numerator into a ratio the way buffett and graham do.
 *
 * 5. Shared `output_id`s are deliberate and denote the same number built the same way, across
 *    this file and the others:
 *      risk.debt_service_cushion      taleb (= munger)        interest cover less one
 *      options.normalised_skew        taleb (= natenberg)     25-delta skew / at-the-money vol
 *      execution.round_trip_cost      sinclair (= natenberg)  quoted width paid twice
 *      macro.credit_spread_gap        soros (= marks)         high-yield OAS less 500bp
 *    In each case the two seats read the same number in opposite or unrelated directions, which
 *    is stated in the consuming seat's provenance rather than left to be noticed.
 *
 * 6. Scoring points are one per rule throughout, so `max_score` is the rule count.
 *
 * 7. Every "can this method speak at all" test is in `eligibility`, never in `scoring`.
 *    `min_coverage` is 1, so a single uncomputable scoring rule collapses a seat to
 *    out_of_scope, which is what made twenty-five seats abstain on every symbol. Each
 *    eligibility check here therefore gates on the facts its own rules and vetoes read that are
 *    NOT tool inputs; tool inputs are already covered by the pre-decision fact gate, so gating
 *    on one of those would be dead code that never runs.
 */
export const quantSeats = Object.freeze({
  master_taleb: {
    provenance:
      "Nassim Nicholas Taleb's published method puts a specified payoff, maximum loss, hidden leverage and absorbing ruin state ahead of expected return. A negative NCAV or tangible-book floor means an equity lacks asset-backed recovery; it does not make an unlevered long stock's loss unbounded, because that payoff is still capped at the capital paid. This seat therefore refuses to infer ruin from `valuation.downside_floor` and declines until the actual payoff/max-loss, leverage, volatility, friction and event-expiry facts are frozen.",
    tools: [
      {
        tool_id: "master_taleb.maximum_loss",
        operation: "identity",
        inputs: [{ fact_id: "payoff.max_loss" }],
        output_id: "payoff.maximum_loss",
        value_kind: "ratio",
        unit: "decimal_of_invested_capital",
        purpose:
          "The specified exposure's finite maximum loss as a fraction of invested capital; this is the payoff bound, not an accounting liquidation floor.",
      },
      {
        tool_id: "master_taleb.payoff_convexity",
        operation: "identity",
        inputs: [{ fact_id: "payoff.convexity" }],
        output_id: "payoff.convexity_score",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The explicitly modelled payoff convexity; an options skew snapshot is market context and cannot substitute for the position's payoff diagram.",
      },
    ],
    eligibility: {
      all: [
        // Tool inputs already require payoff.max_loss and payoff.convexity. The remaining facts
        // make the payoff executable and distinguish a bounded loss from an absorbing ruin state.
        {
          condition_id: "master_taleb.payoff_and_execution_are_bound",
          condition: {
            op: "all",
            conditions: [
              { op: "exists", value: { fact_id: "risk.ruin_possible" } },
              { op: "exists", value: { fact_id: "risk.hidden_leverage" } },
              { op: "exists", value: { fact_id: "options.implied_volatility" } },
              { op: "exists", value: { fact_id: "options.realized_volatility" } },
              { op: "exists", value: { fact_id: "options.skew_25d" } },
              { op: "exists", value: { fact_id: "execution.round_trip_cost" } },
              { op: "eq", left: { fact_id: "event.expiry_coverage" }, right: { literal: true } },
            ],
          },
          on_false: { native_state: "no_trade", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "no_trade", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_taleb.absorbing_barrier",
        rationale:
          "The supplied payoff analysis identifies an absorbing ruin state. This veto is independent of scoring and overrides any otherwise favourable payoff-shape score.",
        condition: { op: "eq", left: { fact_id: "risk.ruin_possible" }, right: { literal: true } },
        on_trigger: { common_stance: "opposed", native_state: "no_trade" },
      },
      {
        veto_id: "master_taleb.leverage_is_the_fragility",
        rationale:
          "Hidden position leverage can turn a bounded market move into forced liquidation or loss beyond posted capital; that payoff fact, not a negative NCAV, is the relevant fragility test.",
        condition: { op: "gt", left: { fact_id: "risk.hidden_leverage" }, right: { literal: 0 } },
        on_trigger: { common_stance: "opposed", native_state: "no_trade" },
      },
    ],
    scoring: [
      {
        rule_id: "taleb_maximum_loss_is_bounded_to_capital",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The specified payoff cannot lose more than the capital deliberately allocated to it. This is a bounded-payoff statement, not an asset-value claim.",
        condition: { op: "lte", left: { output_id: "payoff.maximum_loss" }, right: { literal: 1 } },
      },
      {
        rule_id: "taleb_payoff_is_positively_convex",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The supplied payoff map is positively convex; market skew and friction still constrain implementation but cannot manufacture convexity when the payoff itself is absent.",
        condition: { op: "gt", left: { output_id: "payoff.convexity_score" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "no_trade" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "hedge_only" },
      { min_ratio: 0.75, common_stance: "cautious", native_state: "robust" },
      { min_ratio: 1, common_stance: "cautious", native_state: "convex_opportunity" },
    ],
  },

  master_thorp: {
    provenance:
      "Edward O. Thorp: Beat the Dealer (1962) and Beat the Market (1967, with Sheen Kassouf) on computing an edge before betting it; \"The Kelly Criterion in Blackjack, Sports Betting, and the Stock Market\" (1997, revised 2006), which gives the continuous-outcome optimum as the edge divided by the VARIANCE, shows the criterion maximises asymptotic growth and never risks ruin so long as a loss cannot exceed the stake, and argues for betting a fraction of that optimum because the inputs are estimates; and A Man for All Markets (2017), where edge, sizing and cost are one problem rather than three. Two substitutions are forced and neither is his. There is no variance fact in this pack, so `trade.edge_per_unit_of_volatility` divides by an annualised implied volatility instead: it is a Sharpe-shaped quantity that ranks edges and it is emphatically not a position size, so nothing here should be read as a Kelly fraction. And `market.change_pct` is one session's return while `execution.bid_ask` is the at-the-money option width as a fraction of the option's own mid price, so subtracting the second from the first is a friction screen in the sense the Natenberg seat states, not a like-for-like net return. The 0.063 line is arithmetic rather than judgement: an annualised volatility divided by the square root of 252 sessions is a one-day standard deviation, so 1/sqrt(252) is exactly the ratio at which the surviving edge equals one session's sigma. The leverage line at one is this project's reading of his stated premise that a loss cannot exceed the stake.",
    tools: [
      {
        tool_id: "master_thorp.net_edge",
        operation: "subtract",
        inputs: [{ fact_id: "market.change_pct" }, { fact_id: "execution.bid_ask" }],
        output_id: "trade.net_edge",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The observable move with one crossing of the market taken out of it. His objection to a gross edge is that it is never the number anyone actually receives, so the cost of transacting belongs inside the estimate rather than in a footnote to it.",
      },
      {
        tool_id: "master_thorp.edge_per_unit_of_volatility",
        operation: "divide",
        inputs: [{ output_id: "trade.net_edge" }, { fact_id: "options.implied_volatility" }],
        output_id: "trade.edge_per_unit_of_volatility",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The Kelly intuition in the only form these facts support: an edge means nothing until it is set against the dispersion of the thing being bet on. The criterion itself divides by the variance; this divides by an annualised volatility, so it ranks edges rather than sizing them.",
      },
    ],
    eligibility: {
      all: [
        // The Kelly result holds only where a loss cannot exceed the stake, and borrowed money
        // is the standard way that premise fails. With no leverage figure the ruin constraint
        // cannot be evaluated, so the sizing question cannot honestly be asked at all.
        {
          condition_id: "master_thorp.ruin_constraint_evaluable",
          condition: { op: "exists", value: { fact_id: "financial.leverage" } },
          on_false: { native_state: "out_of_scope", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "out_of_scope", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_thorp.edge_inside_the_friction",
        rationale:
          "His refusal, and the reason Beat the Market spends as long on execution as on the model: an edge that does not survive being entered and exited is not an edge but a fee. The net edge already has one crossing removed, so requiring what is left to still exceed the width is requiring the round trip to be paid in full. Below that there is nothing to size, and no threshold has to be chosen for the seat to say so.",
        condition: { op: "lte", left: { output_id: "trade.net_edge" }, right: { fact_id: "execution.bid_ask" } },
        on_trigger: { common_stance: "opposed", native_state: "no_measurable_edge" },
      },
    ],
    scoring: [
      {
        rule_id: "thorp_edge_beyond_one_session_sigma",
        points: 1,
        coverage_weight: 1,
        rationale:
          "An edge has to be large relative to the noise it was measured in, which is the entire content of dividing by dispersion. An annualised implied volatility is one session's standard deviation multiplied by the square root of 252, so a ratio of 1/sqrt(252), or 0.063, is precisely the point at which the surviving edge equals a one-day sigma. The square-root-of-time convention supplies the number; nothing here is a chosen cut-off.",
        condition: { op: "gte", left: { output_id: "trade.edge_per_unit_of_volatility" }, right: { literal: 0.063 } },
      },
      {
        rule_id: "thorp_loss_cannot_exceed_the_stake",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The premise the Kelly result rests on, and the one he returns to whenever he warns against full-Kelly sizing: the criterion avoids ruin only where a loss cannot exceed what was staked. Borrowed money is how that premise fails. Debt no larger than the equity beneath it is this project's reading of the condition and not a ratio Thorp published; without it the seat may see an edge but has no basis for putting size behind it, which is exactly what its middle state is named for.",
        condition: { op: "lte", left: { fact_id: "financial.leverage" }, right: { literal: 1 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "no_measurable_edge" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "positive_edge_no_size" },
      { min_ratio: 1, common_stance: "constructive", native_state: "fractional_position" },
    ],
  },

  master_simons: {
    provenance:
      "James Simons on research discipline rather than on any Renaissance signal: the MIT lecture \"Mathematics, Common Sense, and Good Luck: My Life and Careers\" (2010), the TED conversation (2015) and his Institute for Advanced Study talks, where the recurring claims are that a signal is tested against data rather than argued for, that a single observation is not evidence of anything, and that the edge on any one trade is tiny and exists only in aggregate across many weakly related bets. The honest headline is what this seat cannot do. His own veto families - look-ahead leakage, no untouched holdout, cost erasure - are exactly the tests the fact pack cannot support: there is no sample definition of any kind here, no dataset, no feature or label timestamps, no out-of-sample partition, no count of hypotheses tried, no turnover and no cost model. Nothing in this seat is a signal test and it must not be reported as one. What the facts do support is one statistically framed comparison: a realised session move measured against the distribution the option market is itself quoting. Because implied volatility is annualised, one session's standard deviation is that volatility divided by the square root of 252, so the ratio lines 0.063 and 0.126 are one and two implied sigmas - arithmetic, not chosen cut-offs. The band names are the build spec's. Reaching the top band means only that one session moved further than two of the option market's own sigmas; it is not a finding that a deployable signal exists, and the seat has no way to establish that it does.",
    tools: [
      {
        tool_id: "master_simons.absolute_session_move",
        operation: "abs",
        inputs: [{ fact_id: "market.change_pct" }],
        output_id: "market.absolute_session_move",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "Magnitude before direction. Whether something happened is a two-sided question, and the sign of a single session is a story rather than a hypothesis.",
      },
      {
        tool_id: "master_simons.session_move_over_implied",
        operation: "divide",
        inputs: [{ output_id: "market.absolute_session_move" }, { fact_id: "options.implied_volatility" }],
        output_id: "market.session_move_over_implied",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The realised move expressed in the units of the distribution the option market is quoting. A move only means something against a stated expectation, and the implied volatility is the only stated expectation this pack carries.",
      },
    ],
    eligibility: {
      all: [
        // A defined sample is what the method requires and what the facts cannot supply. The
        // weakest available stand-in for "is a distribution being quoted at all" is a two-sided
        // surface: with no skew there is one number and no shape, so a realised move has nothing
        // to be tested against. That is an invalid test, not a negative result.
        {
          condition_id: "master_simons.quoted_distribution_available",
          condition: { op: "exists", value: { fact_id: "options.skew_25d" } },
          on_false: { native_state: "invalid_test", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "invalid_test", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_simons.no_observation_to_test",
        rationale:
          "A session that did not move is not an observation of anything, and scoring it would be manufacturing a result out of an empty sample. This is the only refusal the available facts can express, which is itself the finding: his real vetoes are leakage, an absent holdout and cost erasure, and not one of the three has a fact in this pack to be tested against. A signal that cannot be tested does not get traded. That is a decision his method reaches, not a subject it fails to recognise, and the honest rendering is standing aside rather than silence.",
        condition: { op: "lte", left: { output_id: "market.session_move_over_implied" }, right: { literal: 0 } },
        on_trigger: { common_stance: "out_of_scope", native_state: "invalid_test" },
      },
    ],
    scoring: [
      {
        rule_id: "simons_move_beyond_one_implied_sigma",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The first rung of the only statistically framed comparison available. An annualised implied volatility divided by the square root of 252 sessions is a one-day standard deviation, so a ratio above 1/sqrt(252) = 0.063 is a session that moved further than the option market's own one-sigma expectation. The square-root-of-time convention supplies the number, not this project.",
        condition: { op: "gt", left: { output_id: "market.session_move_over_implied" }, right: { literal: 0.063 } },
      },
      {
        rule_id: "simons_move_beyond_two_implied_sigma",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The second rung, at 2/sqrt(252) = 0.126. Grading the same quantity at one and two sigmas is the only way these facts can express the distinction he cares about - between a move inside the quoted distribution and one the quoted distribution did not allow for - and it remains a single observation, which is still not a sample.",
        condition: { op: "gt", left: { output_id: "market.session_move_over_implied" }, right: { literal: 0.126 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "no_signal" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "research_candidate" },
      { min_ratio: 1, common_stance: "constructive", native_state: "deployable_signal" },
    ],
  },

  master_soros: {
    provenance:
      "George Soros, The Alchemy of Finance (1987), especially the theory of reflexivity and the real-time experiment, in which price and the fundamentals supposed to justify it feed each other through financing; \"Fallibility, Reflexivity, and the Human Uncertainty Principle\" (Journal of Economic Methodology, 2013), his own formal restatement; and The New Paradigm for Financial Markets (2008), where the credit leg is explicit and the boom is described as running on the availability of financing rather than on the fundamentals. What this seat cannot carry is his own central requirement - a dated, observable break condition specified before the outcome is known - so it reads the two legs as they currently stand and claims no reversal trigger. The observable loop these facts support has exactly two legs, price action and the price of credit. `macro.credit_spread` is the ICE BofA US High Yield option-adjusted spread and `macro.credit_spread_gap` is that spread less its roughly five-hundred-basis-point long-run average: the same number the Marks seat builds and deliberately the same output id, read differently - Marks reads it as the temperature of the cycle, this seat as whether the loop is still being financed. `reflexivity.financing_burden` is leverage multiplied by that spread, which is the risk premium the credit market charges this borrower's capital structure expressed per unit of equity; it measures how hard the credit leg can push on the fundamentals, and it is zero where there is no debt for credit conditions to act on. His tell is the divergence between the two legs, which is why the middle band is the one that names it, and `market.change_pct` is a single session - a thin proxy for the price leg, treated as such.",
    tools: [
      {
        tool_id: "master_soros.credit_cycle_position",
        operation: "subtract",
        inputs: [{ fact_id: "macro.credit_spread" }, { literal: 0.05 }],
        output_id: "macro.credit_spread_gap",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "The financing leg, measured against its own long-run average rather than in the abstract. What matters to a reflexive process is not the level of the spread but whether credit is currently easier or harder than usual, because that is what changes what borrowers are able to do.",
      },
      {
        tool_id: "master_soros.financing_burden",
        operation: "multiply",
        inputs: [{ fact_id: "financial.leverage" }, { fact_id: "macro.credit_spread" }],
        output_id: "reflexivity.financing_burden",
        value_kind: "ratio",
        unit: "decimal",
        purpose:
          "How hard the credit leg can push on this particular borrower: debt per unit of equity multiplied by the risk premium charged on it. An unlevered business is insulated from the financing channel, and reflexivity with no channel is a story about price rather than a loop.",
      },
    ],
    eligibility: {
      all: [
        // Reflexivity is a claim about price feeding back into fundamentals. With no price
        // action there is no price leg, so there is no loop to describe and nothing for the
        // credit leg to interact with.
        {
          condition_id: "master_soros.price_leg_observable",
          condition: { op: "exists", value: { fact_id: "market.change_pct" } },
          on_false: { native_state: "no_loop", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "no_loop", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_soros.no_reflexive_link",
        rationale:
          "The build spec's first veto family and Alchemy's own standard: a reflexivity thesis has to show feedback that reaches the fundamentals, not merely a price that moved. Where leverage is zero the financing burden is zero, credit conditions cannot touch this borrower's economics, and there is no loop to be right or wrong about - a question outside the method rather than a verdict on the security. No feedback loop means there is nothing here for reflexivity to act on, so he is not in it. That is a stated position on the security rather than a failure to have one.",
        condition: { op: "lte", left: { output_id: "reflexivity.financing_burden" }, right: { literal: 0 } },
        on_trigger: { common_stance: "out_of_scope", native_state: "no_loop" },
      },
      {
        veto_id: "master_soros.price_outruns_its_financing",
        rationale:
          "The configuration The New Paradigm for Financial Markets describes at the end of a boom: price still rising while lenders demand more than their long-run average for risk. The leg that financed the advance has turned against it, so what is left is a price held up by belief rather than by credit - the state in which he is on the other side of it rather than a buyer.",
        condition: {
          op: "all",
          conditions: [
            { op: "gt", left: { fact_id: "market.change_pct" }, right: { literal: 0 } },
            { op: "gt", left: { output_id: "macro.credit_spread_gap" }, right: { literal: 0 } },
          ],
        },
        on_trigger: { common_stance: "opposed", native_state: "broken" },
      },
    ],
    scoring: [
      {
        rule_id: "soros_price_leg_rising",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The first leg as Alchemy sets it out: the prevailing bias has to be showing up in the price before there is anything for the fundamentals to respond to. Zero is the natural line and no threshold needs choosing. One session is a thin proxy for a trend and the seat claims nothing beyond the direction it carries.",
        condition: { op: "gt", left: { fact_id: "market.change_pct" }, right: { literal: 0 } },
      },
      {
        rule_id: "soros_financing_leg_permissive",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The second leg. A high-yield spread inside its long-run average means credit is cheaper than usual, which is the condition under which rising prices actually change what borrowers can finance - the feedback he says turns a belief into a fundamental. When the two legs disagree the seat scores one and lands in the state that names the disagreement, which is his tell rather than an inconclusive result.",
        condition: { op: "lt", left: { output_id: "macro.credit_spread_gap" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "broken" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "testing_reversal" },
      { min_ratio: 1, common_stance: "constructive", native_state: "reinforcing" },
    ],
  },

  master_sinclair: {
    provenance:
      "Euan Sinclair, Volatility Trading (2nd edition, 2013) and Positional Option Trading (2020): the edge in an option position is the difference between a forecast of realised volatility and the implied volatility being traded, and it counts only after the bid-ask has been paid on the way in and again on the way out, which is why he treats most claimed volatility edges as artefacts of ignoring the width. This pack carries no realised volatility and no forecast, so the gross half of his test cannot be computed at all and this seat does not pretend otherwise; what remains is the executability half, which is the half he says kills most trades. `execution.round_trip_cost` is the quoted width paid twice, the same number and the same output id as the Natenberg seat. `options.volatility_per_unit_of_width` is how many times that width fits inside the volatility being traded, so twenty means the round trip consumes a tenth of the volatility and four means it consumes half. The two quantities are not dimensionally identical - one is an annualised volatility, the other a fraction of the option's mid price - so this is a friction screen in the sense the Natenberg seat states, not an edge calculation. The differentiation from that seat is deliberate: Natenberg scores the shape of the priced skew and treats friction as a screen, while this seat refuses on friction and then asks only where the premium sits. The twenty is this project's reading, set to the same order of tolerance as Natenberg's tenth-of-mid line applied to a different denominator; Sinclair states the test qualitatively and publishes no share.",
    tools: [
      {
        tool_id: "master_sinclair.round_trip_cost",
        operation: "multiply",
        inputs: [{ fact_id: "execution.bid_ask" }, { literal: 2 }],
        output_id: "execution.round_trip_cost",
        value_kind: "ratio",
        unit: "decimal_of_mid",
        purpose:
          "The width is crossed twice, once to get the position on and once to get it off. Every edge has to clear the round trip, and the round trip is where most of the volatility edges he examines stop existing.",
      },
      {
        tool_id: "master_sinclair.volatility_per_unit_of_width",
        operation: "divide",
        inputs: [{ fact_id: "options.implied_volatility" }, { fact_id: "execution.bid_ask" }],
        output_id: "options.volatility_per_unit_of_width",
        value_kind: "ratio",
        unit: "multiple",
        purpose:
          "How many times the quoted width fits inside the volatility being traded. The gross edge is some fraction of that volatility and is not computable from these facts, so the number of widths available is the strongest statement this pack supports about whether any residual edge could survive execution.",
      },
    ],
    eligibility: {
      all: [
        // The method starts from a realised-volatility forecast, which this pack does not carry.
        // The weakest honest substitute for "is there a volatility position to price at all" is
        // a two-sided surface: with no skew there is a single number, no shape, and nothing to
        // be long or short of. That is missing inputs rather than an absent edge.
        {
          condition_id: "master_sinclair.surface_has_a_shape",
          condition: { op: "exists", value: { fact_id: "options.skew_25d" } },
          on_false: { native_state: "insufficient_inputs", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "insufficient_inputs", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_sinclair.edge_dies_in_the_spread",
        rationale:
          "His flat refusal, and the difference between this seat and the Natenberg one: where Natenberg scores the same comparison as a friction screen, Sinclair treats it as disqualifying. A round trip costing as much as the whole volatility being traded cannot leave a residual edge behind under any forecast, so there is nothing to size and the refusal needs no chosen threshold.",
        condition: { op: "gte", left: { output_id: "execution.round_trip_cost" }, right: { fact_id: "options.implied_volatility" } },
        on_trigger: { common_stance: "opposed", native_state: "no_net_edge" },
      },
    ],
    scoring: [
      {
        rule_id: "sinclair_round_trip_leaves_room_for_an_edge",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Volatility Trading's practical constraint stated as a share rather than as a refusal: twenty widths inside the traded volatility means the round trip consumes a tenth of it, which is the most friction he would ask a residual edge to carry. The tenth is this project's reading, deliberately the same order of tolerance as the Natenberg seat's tenth-of-mid line. This is the executability half of his test; the forecast half cannot be computed from these facts at all.",
        condition: { op: "gte", left: { output_id: "options.volatility_per_unit_of_width" }, right: { literal: 20 } },
      },
      {
        rule_id: "sinclair_premium_sits_in_the_puts",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Where he says the harvestable volatility premium actually lives in equity options: the downside is bid relative to the upside, and a surface whose puts are no dearer than its calls is one in which the usual premium is simply absent. Zero is the natural line - the point at which the twenty-five-delta put and call are priced alike - so nothing is calibrated here.",
        condition: { op: "gt", left: { fact_id: "options.skew_25d" }, right: { literal: 0 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "no_net_edge" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "paper_edge" },
      { min_ratio: 1, common_stance: "constructive", native_state: "executable_edge" },
    ],
  },

  master_burry: {
    provenance:
      "Michael Burry's own writing rather than accounts of it: the Scion Capital investor letters (2000-2008) and the MSN Money \"Value Investing\" columns and Silicon Investor posts that preceded them, in which he states plainly that his framework is Graham and Dodd, that he buys at a discount to a conservatively adjusted book value and hunts net-nets, and that he begins from the filings rather than from a view; and his 2010 testimony to the Financial Crisis Inquiry Commission and the New York Times piece \"I Saw the Crisis Coming. Why Didn't the Fed?\", which are primary evidence of the same habit of opening the original document. The limitation is load-bearing and belongs first: the mispricing mechanism itself is not a fact in this pack. Seniority, covenants, maturity schedules, off-balance-sheet claims, borrow availability and carry are all absent, so the structural, mechanically testable disagreement that is the entire point of the method cannot be located here. What is measurable is leverage, net current asset value against the price, and interest cover - which makes this seat a Graham-and-Dodd screen wearing his name, not a reconstruction of his research, and it should be read that way. Net current assets are put on a per-share basis and the price subtracted from them, so the comparison stays in one currency and never becomes a ratio built from a monetary numerator. The five-times fixed-charge line is Graham's published industrial minimum (The Intelligent Investor ch. 11), adopted because Burry adopted the framework by name; the leverage line at one is this project's reading and he published no ratio.",
    tools: [
      {
        tool_id: "master_burry.net_current_asset_value_per_share",
        operation: "divide",
        inputs: [{ fact_id: "financial.net_current_asset_value" }, { fact_id: "capital_allocation.share_count" }],
        output_id: "valuation.net_current_asset_value_per_share",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "Working capital net of every liability, expressed per share so that it can be set against a share price. This is the balance-sheet floor the early letters describe buying beneath, before any judgement about the business enters.",
      },
      {
        tool_id: "master_burry.net_current_asset_surplus_per_share",
        operation: "subtract",
        inputs: [{ output_id: "valuation.net_current_asset_value_per_share" }, { fact_id: "market.price" }],
        output_id: "valuation.net_current_asset_surplus_per_share",
        value_kind: "monetary",
        unit: "currency_units",
        purpose:
          "What is left per share once the price is paid, counted only in assets that turn into cash inside a year. Kept as a subtraction in one currency rather than as a coverage ratio so that both sides of the comparison stay in the same units.",
      },
    ],
    eligibility: {
      all: [
        // He starts from the capital structure: what stands ahead of the equity, and whether the
        // business covers the charges on it. Missing either, there is no structure to read, and
        // a disagreement that cannot be tested against the structure is precisely the trade he
        // says he will not take.
        {
          condition_id: "master_burry.capital_structure_readable",
          condition: {
            op: "all",
            conditions: [
              { op: "exists", value: { fact_id: "financial.leverage" } },
              { op: "exists", value: { fact_id: "financial.interest_coverage" } },
            ],
          },
          on_false: { native_state: "document_gap", common_stance: "out_of_scope" },
          on_uncomputable: { native_state: "document_gap", common_stance: "out_of_scope" },
        },
      ],
    },
    hard_vetoes: [
      {
        veto_id: "master_burry.cannot_survive_the_wait",
        rationale:
          "The build spec's \"cannot survive early\" family, in the only form these facts allow. An issuer carrying more debt than equity while failing to cover its fixed charges has its outcome settled at the refinancing table, on terms - borrow, carry, covenants - that this pack cannot see. Anything claimed about the price then rests on an opinion about a negotiation rather than on a structure that can be tested, which is the distinction his method turns on.",
        condition: {
          op: "all",
          conditions: [
            { op: "gt", left: { fact_id: "financial.leverage" }, right: { literal: 1 } },
            { op: "lt", left: { fact_id: "financial.interest_coverage" }, right: { literal: 1 } },
          ],
        },
        on_trigger: { common_stance: "opposed", native_state: "opinion_only" },
      },
    ],
    scoring: [
      {
        rule_id: "burry_price_below_net_current_assets",
        points: 1,
        coverage_weight: 1,
        rationale:
          "The Graham-and-Dodd test he claimed by name in the MSN Money columns and applied in the early Scion letters: pay less than the working capital that survives every liability, so the balance sheet alone covers the purchase. A positive surplus per share is that test with no threshold to choose, because zero is where the price crosses the assets.",
        condition: { op: "gt", left: { output_id: "valuation.net_current_asset_surplus_per_share" }, right: { literal: 0 } },
      },
      {
        rule_id: "burry_equity_not_junior_to_more_debt_than_equity",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Where he starts: the common stock is the residual claim, so how much stands in front of it decides what the analysis is even about. Debt no larger than the equity beneath it is this project's reading of a capital structure the equity still governs - he published no ratio - and it is deliberately the same line the Munger, Taleb and Thorp seats read for their own different reasons, so the four readings stay comparable.",
        condition: { op: "lte", left: { fact_id: "financial.leverage" }, right: { literal: 1 } },
      },
      {
        rule_id: "burry_issuer_can_wait_for_the_thesis",
        points: 1,
        coverage_weight: 1,
        rationale:
          "Being early is his documented failure mode, and the issuer has to survive the wait as much as the position does. Five times fixed-charge cover is Graham's published minimum for an industrial issue (The Intelligent Investor ch. 11), used here because Burry adopted that framework explicitly: it is a borrowed number, labelled as borrowed, and not one he set.",
        condition: { op: "gte", left: { fact_id: "financial.interest_coverage" }, right: { literal: 5 } },
      },
    ],
    bands: [
      { min_ratio: 0, common_stance: "opposed", native_state: "opinion_only" },
      { min_ratio: 0.5, common_stance: "cautious", native_state: "watch" },
      { min_ratio: 1, common_stance: "constructive", native_state: "structural_mispricing" },
    ],
  },
});

export default quantSeats;
