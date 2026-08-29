import test from "node:test";
import assert from "node:assert/strict";

import {
  PM_RATING_HORIZON_MONTHS,
  PM_RATING_RETURN_FORMULA_ID,
  PM_RATING_RUBRIC_ID,
  assertPmRatingBasis,
  assertPmRatingReferenceAvailable,
  pmRatingReferenceGaps,
  ratingForTwelveMonthReturn,
} from "../../mcp/lib/pm-rating-rubric.mjs";

const REFERENCE_PRICE = 100;
const REFERENCE_CURRENCY = "USD";

function packet(overrides = {}, rating = overrides.final_rating || "Hold") {
  const referencePrice = overrides.reference_price ?? REFERENCE_PRICE;
  const incomeReturnPct = overrides.income_return_pct ?? 0;
  const totalReturnPct = overrides.base_case_total_return_pct ?? 0;
  const baseCasePriceTarget = overrides.base_case_price_target
    ?? referencePrice * (1 + ((totalReturnPct - incomeReturnPct) / 100));
  return {
    rating,
    rating_basis: {
      rubric_id: PM_RATING_RUBRIC_ID,
      horizon_months: PM_RATING_HORIZON_MONTHS,
      return_formula_id: PM_RATING_RETURN_FORMULA_ID,
      price_currency: REFERENCE_CURRENCY,
      reference_price: referencePrice,
      base_case_price_target: baseCasePriceTarget,
      income_return_pct: incomeReturnPct,
      base_case_total_return_pct: 0,
      raw_rating: "Hold",
      risk_adjustment: "none",
      final_rating: "Hold",
      adjustment_reason: null,
      source_ids: ["valuation_long_short:S1"],
      adjustment_source_ids: [],
      adjustment_context_ids: [],
      ...overrides,
    },
  };
}

function validate(input, options = {}) {
  return assertPmRatingBasis(input, {
    referencePrice: REFERENCE_PRICE,
    referenceCurrency: REFERENCE_CURRENCY,
    ...options,
  });
}

function hasProblem(error, code) {
  return error?.data?.reason === "PM_RATING_BASIS_MISMATCH"
    && error.data.problems.some((entry) => entry.code === code);
}

test("12-month return bands own every exact boundary deterministically", () => {
  const cases = [
    [50, "Buy"],
    [20, "Buy"],
    [19.999, "Overweight"],
    [10, "Overweight"],
    [9.999, "Hold"],
    [0, "Hold"],
    [-9.999, "Hold"],
    [-10, "Underweight"],
    [-19.999, "Underweight"],
    [-20, "Sell"],
    [-80, "Sell"],
  ];
  for (const [totalReturn, expected] of cases) {
    assert.equal(ratingForTwelveMonthReturn(totalReturn), expected, String(totalReturn));
  }
});

test("return mapper rejects strings and non-finite numbers with an orchestrator-readable reason", () => {
  for (const value of ["10", Number.NaN, Number.POSITIVE_INFINITY, -100.001, 1_000.001]) {
    assert.throws(
      () => ratingForTwelveMonthReturn(value),
      (error) => error?.code === -32602 && error?.data?.reason === "PM_RATING_RETURN_INVALID",
    );
  }
});

test("real calibrated decisions fail before fan-out without a frozen quote and currency", () => {
  const calibratedRun = {
    decision_requested: true,
    decision_context: { rating_basis_required: true },
    grounding: { quote: { price: null, currency: "" } },
  };
  assert.deepEqual(pmRatingReferenceGaps(calibratedRun), [
    "grounding.quote.price",
    "grounding.quote.currency",
  ]);
  assert.throws(
    () => assertPmRatingReferenceAvailable(calibratedRun, { stage: "fixture" }),
    (error) => error?.data?.reason === "PM_RATING_REFERENCE_REQUIRED"
      && error?.data?.downstream_model_calls_started === false,
  );
  assert.deepEqual(pmRatingReferenceGaps({ ...calibratedRun, dry_run: true }), []);
  assert.deepEqual(pmRatingReferenceGaps({ ...calibratedRun, decision_requested: false }), []);
});

test("a complete unadjusted basis is accepted without mutating input", () => {
  const input = packet({
    base_case_total_return_pct: 12,
    raw_rating: "Overweight",
    final_rating: "Overweight",
  }, "Overweight");
  const before = structuredClone(input);
  assert.deepEqual(validate(input), input.rating_basis);
  assert.deepEqual(input, before);
});

test("one sourced one-notch downgrade is accepted", () => {
  const adjustmentContexts = [{
    context_id: "method_context_2",
    context_type: "method_risk",
    source_ids: ["earnings_deep_dive:S2"],
  }];
  const input = packet({
    base_case_total_return_pct: 25,
    raw_rating: "Buy",
    risk_adjustment: "downgrade_one_notch",
    final_rating: "Overweight",
    adjustment_reason: "Debt refinancing creates material downside asymmetry.",
    source_ids: ["valuation_long_short:S1", "earnings_deep_dive:S2"],
    adjustment_source_ids: ["earnings_deep_dive:S2"],
    adjustment_context_ids: ["method_context_2"],
  }, "Overweight");
  assert.deepEqual(validate(input, { adjustmentContexts }), input.rating_basis);
});

test("eligible downside context does not force a downgrade when the PM selects none", () => {
  const adjustmentContexts = [{
    context_id: "method_context_2",
    context_type: "method_risk",
    source_ids: ["earnings_deep_dive:S2"],
  }];
  const input = packet({
    base_case_total_return_pct: 24,
    raw_rating: "Buy",
    risk_adjustment: "none",
    final_rating: "Buy",
    adjustment_reason: null,
    source_ids: ["valuation_long_short:S1"],
    adjustment_source_ids: [],
    adjustment_context_ids: [],
  }, "Buy");
  assert.deepEqual(validate(input, { adjustmentContexts }), input.rating_basis);
});

test("a valid source cannot become a downgrade without a server-owned eligible cause", () => {
  const input = packet({
    base_case_total_return_pct: 25,
    raw_rating: "Buy",
    risk_adjustment: "downgrade_one_notch",
    final_rating: "Overweight",
    adjustment_reason: "An out-of-scope method lacked a critical input.",
    source_ids: ["market_data:S1"],
    adjustment_source_ids: ["market_data:S1"],
    adjustment_context_ids: ["method_context_1"],
  }, "Overweight");
  assert.throws(
    () => validate(input, { adjustmentContexts: [] }),
    (error) => hasProblem(error, "downgrade_context_ids_not_eligible")
      && hasProblem(error, "downgrade_source_ids_outside_contexts"),
  );
});

test("raw rating is recomputed from the base-case return", () => {
  assert.throws(
    () => validate(packet({
      base_case_total_return_pct: 10,
      raw_rating: "Hold",
    })),
    (error) => hasProblem(error, "raw_rating_mismatch"),
  );
});

test("final rating must equal the top-level reader-facing rating", () => {
  assert.throws(
    () => validate(packet({ final_rating: "Hold" }, "Underweight")),
    (error) => hasProblem(error, "final_rating_mismatch"),
  );
});

test("none cannot conceal a directional adjustment", () => {
  assert.throws(
    () => validate(packet({
      base_case_total_return_pct: 12,
      raw_rating: "Overweight",
      final_rating: "Hold",
    })),
    (error) => hasProblem(error, "unadjusted_final_rating_mismatch"),
  );
});

test("risk adjustment cannot upgrade or cross more than one notch", () => {
  const sourced = {
    risk_adjustment: "downgrade_one_notch",
    adjustment_reason: "A cited risk requires a conservative adjustment.",
    source_ids: ["valuation_long_short:S1"],
    adjustment_source_ids: ["valuation_long_short:S1"],
    adjustment_context_ids: ["method_context_1"],
  };
  assert.throws(
    () => validate(packet({
      ...sourced,
      base_case_total_return_pct: 0,
      raw_rating: "Hold",
      final_rating: "Overweight",
    }, "Overweight"), { adjustmentContexts: [{ context_id: "method_context_1", source_ids: ["valuation_long_short:S1"] }] }),
    (error) => hasProblem(error, "downgrade_must_be_exactly_one_notch"),
  );
  assert.throws(
    () => validate(packet({
      ...sourced,
      base_case_total_return_pct: 25,
      raw_rating: "Buy",
      final_rating: "Hold",
    }), { adjustmentContexts: [{ context_id: "method_context_1", source_ids: ["valuation_long_short:S1"] }] }),
    (error) => hasProblem(error, "downgrade_must_be_exactly_one_notch"),
  );
});

test("a downgrade requires a reason and scoped source IDs", () => {
  const base = {
    base_case_total_return_pct: 12,
    raw_rating: "Overweight",
    risk_adjustment: "downgrade_one_notch",
    final_rating: "Hold",
  };
  assert.throws(
    () => validate(packet({ ...base, adjustment_reason: "", adjustment_source_ids: [] })),
    (error) => hasProblem(error, "downgrade_reason_required")
      && hasProblem(error, "downgrade_source_ids_required"),
  );
  assert.throws(
    () => validate(packet({
      ...base,
      adjustment_reason: "Material cited downside.",
      adjustment_source_ids: ["quant_factor:S2"],
    })),
    (error) => hasProblem(error, "downgrade_source_ids_outside_basis"),
  );
});

test("missing critical rating basis fails closed instead of becoming Hold", () => {
  assert.throws(
    () => assertPmRatingBasis({ rating: "Hold" }),
    (error) => error?.code === -32602 && error?.data?.reason === "PM_RATING_BASIS_REQUIRED",
  );

  for (const field of [
    "rubric_id",
    "horizon_months",
    "return_formula_id",
    "price_currency",
    "reference_price",
    "base_case_price_target",
    "income_return_pct",
    "base_case_total_return_pct",
    "raw_rating",
    "risk_adjustment",
    "final_rating",
    "adjustment_reason",
    "source_ids",
    "adjustment_source_ids",
    "adjustment_context_ids",
  ]) {
    const input = packet();
    delete input.rating_basis[field];
    assert.throws(
      () => validate(input),
      (error) => error?.data?.reason === "PM_RATING_BASIS_MISMATCH",
      field,
    );
  }
});

test("rubric and horizon are frozen to pm_rating_rubric_v2 and 12 months", () => {
  assert.throws(
    () => validate(packet({ rubric_id: "legacy", horizon_months: 6 })),
    (error) => hasProblem(error, "rubric_id_mismatch") && hasProblem(error, "horizon_mismatch"),
  );
});

test("validation fails closed when the server has no positive frozen reference price", () => {
  for (const referencePrice of [undefined, null, 0, -1, Number.NaN]) {
    assert.throws(
      () => assertPmRatingBasis(packet(), { referencePrice, referenceCurrency: REFERENCE_CURRENCY }),
      (error) => error?.code === -32602
        && error?.data?.reason === "PM_RATING_REFERENCE_PRICE_REQUIRED",
      String(referencePrice),
    );
  }
});

test("validation binds target and reference prices to the frozen currency", () => {
  assert.throws(
    () => assertPmRatingBasis(packet(), { referencePrice: REFERENCE_PRICE }),
    (error) => error?.code === -32602
      && error?.data?.reason === "PM_RATING_REFERENCE_CURRENCY_REQUIRED",
  );
  assert.throws(
    () => validate(packet({ price_currency: "JPY" })),
    (error) => hasProblem(error, "price_currency_mismatch"),
  );
});

test("the worker reference price must exactly match the frozen server price", () => {
  assert.throws(
    () => validate(packet({ reference_price: 99, base_case_price_target: 99 })),
    (error) => hasProblem(error, "reference_price_mismatch"),
  );
});

test("total return and raw rating are recomputed from target, frozen reference, and income", () => {
  const input = packet({
    base_case_price_target: 118,
    income_return_pct: 2,
    base_case_total_return_pct: 20,
    raw_rating: "Buy",
    final_rating: "Buy",
  }, "Buy");
  assert.deepEqual(validate(input), input.rating_basis);

  assert.throws(
    () => validate(packet({
      base_case_price_target: 118,
      income_return_pct: 2,
      base_case_total_return_pct: 25,
      raw_rating: "Buy",
      final_rating: "Buy",
    }, "Buy")),
    (error) => hasProblem(error, "base_case_total_return_formula_mismatch"),
  );
});

test("formula identity and economically impossible or absurd returns are rejected", () => {
  assert.throws(
    () => validate(packet({ return_formula_id: "worker_defined_formula" })),
    (error) => hasProblem(error, "return_formula_id_mismatch"),
  );
  assert.throws(
    () => validate(packet({ base_case_price_target: -1, base_case_total_return_pct: -101 })),
    (error) => hasProblem(error, "base_case_price_target_invalid")
      && hasProblem(error, "base_case_total_return_out_of_range"),
  );
  assert.throws(
    () => validate(packet({ base_case_price_target: 1_100.01, base_case_total_return_pct: 1_000.01 })),
    (error) => hasProblem(error, "recomputed_total_return_out_of_range")
      && hasProblem(error, "base_case_total_return_out_of_range"),
  );
  assert.throws(
    () => validate(packet({
      base_case_price_target: 1e308,
      base_case_total_return_pct: 1e308,
      raw_rating: "Buy",
      final_rating: "Buy",
      source_ids: ["news_industry_management:S1"],
    }, "Buy")),
    (error) => hasProblem(error, "recomputed_total_return_out_of_range")
      && hasProblem(error, "base_case_total_return_out_of_range"),
  );
  assert.throws(
    () => validate(packet({ income_return_pct: 101, base_case_price_target: 0 })),
    (error) => hasProblem(error, "income_return_invalid"),
  );
});
