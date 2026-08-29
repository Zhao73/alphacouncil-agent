import { RATINGS } from "./constants.mjs";
import { invalidParams } from "./errors.mjs";

export const PM_RATING_RUBRIC_ID = "pm_rating_rubric_v2";
export const PM_RATING_HORIZON_MONTHS = 12;
export const PM_RATING_RETURN_FORMULA_ID = "price_target_plus_income_v1";
export const PM_RATING_SCALE = Object.freeze([...RATINGS]);

const MIN_TOTAL_RETURN_PCT = -100;
const MAX_TOTAL_RETURN_PCT = 1_000;
const MAX_INCOME_RETURN_PCT = 100;
const TOTAL_RETURN_TOLERANCE_PCT = 0.05;

const RISK_ADJUSTMENTS = Object.freeze(["none", "downgrade_one_notch"]);
const SOURCE_ID_PATTERN = /^[^\s\x00-\x1F\x7F]+$/u;

/**
 * Map the base-case total return from the frozen reference price to the canonical 12-month
 * PM rating. Exact boundary ownership is intentional: +10 is Overweight, -10 is
 * Underweight, +20 is Buy, and -20 is Sell.
 */
export function ratingForTwelveMonthReturn(baseCaseTotalReturnPct) {
  if (typeof baseCaseTotalReturnPct !== "number"
    || !Number.isFinite(baseCaseTotalReturnPct)
    || baseCaseTotalReturnPct < MIN_TOTAL_RETURN_PCT
    || baseCaseTotalReturnPct > MAX_TOTAL_RETURN_PCT) {
    throw invalidParams("PM 12-month base-case total return must be finite and within the supported range.", {
      reason: "PM_RATING_RETURN_INVALID",
      rubric_id: PM_RATING_RUBRIC_ID,
      supplied_value: baseCaseTotalReturnPct ?? null,
      minimum: MIN_TOTAL_RETURN_PCT,
      maximum: MAX_TOTAL_RETURN_PCT,
    });
  }
  if (baseCaseTotalReturnPct >= 20) return "Buy";
  if (baseCaseTotalReturnPct >= 10) return "Overweight";
  if (baseCaseTotalReturnPct > -10) return "Hold";
  if (baseCaseTotalReturnPct > -20) return "Underweight";
  return "Sell";
}

/** Return the one server-frozen quote that owns the calibrated PM denominator. */
export function pmRatingReferencePrice(run) {
  const price = run?.grounding?.quote?.price;
  return finiteNumber(price) && price > 0 ? price : null;
}

/** Return the frozen quote currency so a target cannot silently use another unit. */
export function pmRatingReferenceCurrency(run) {
  const currency = run?.grounding?.quote?.currency;
  return typeof currency === "string" && /\S/u.test(currency) ? currency : null;
}

/**
 * Name the frozen inputs still missing before a calibrated council can start model work.
 * Dry runs remain usable for contract/planning checks, but every real one-year directional
 * run must own both a positive quote and its currency before any analyst or visible host
 * thread is launched.
 */
export function pmRatingReferenceGaps(run = {}) {
  if (run?.decision_context?.rating_basis_required !== true
    || run?.decision_requested === false
    || run?.dry_run === true) return [];
  const missing = [];
  if (pmRatingReferencePrice(run) === null) missing.push("grounding.quote.price");
  if (pmRatingReferenceCurrency(run) === null) missing.push("grounding.quote.currency");
  return missing;
}

/** Fail before fan-out when the server cannot later validate the calibrated PM denominator. */
export function assertPmRatingReferenceAvailable(run, { stage = "council_start" } = {}) {
  const missing = pmRatingReferenceGaps(run);
  if (missing.length) {
    throw invalidParams("A calibrated one-year directional run requires a positive frozen quote and currency before any council worker starts.", {
      reason: "PM_RATING_REFERENCE_REQUIRED",
      rubric_id: PM_RATING_RUBRIC_ID,
      stage,
      missing_fields: missing,
      downstream_model_calls_started: false,
    });
  }
  return {
    reference_price: pmRatingReferencePrice(run),
    price_currency: pmRatingReferenceCurrency(run),
  };
}

function sourceIds(value) {
  return Array.isArray(value) ? value : [];
}

function validSourceIds(value, { allowEmpty = false } = {}) {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every((id) => typeof id === "string" && SOURCE_ID_PATTERN.test(id))
    && new Set(value).size === value.length;
}

function problem(code, path, details = {}) {
  return { code, path, ...details };
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function canonicalPercentage(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Enforce the PM rating rubric after transport/schema parsing and before persistence.
 *
 * The function accepts the complete PM packet because the nested final rating must equal the
 * packet's reader-facing top-level rating. It returns a normalized copy of rating_basis and
 * never mutates worker/client input. Failures are RpcErrors with a stable reason and a bounded
 * problem list, so both headless and visible orchestrators can fail closed consistently.
 */
export function assertPmRatingBasis(packet, {
  adjustmentContexts = [],
  referencePrice,
  referenceCurrency,
} = {}) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)
    || !packet.rating_basis || typeof packet.rating_basis !== "object"
    || Array.isArray(packet.rating_basis)) {
    throw invalidParams("portfolio_manager must provide a complete rating_basis.", {
      reason: "PM_RATING_BASIS_REQUIRED",
      rubric_id: PM_RATING_RUBRIC_ID,
    });
  }

  if (!finiteNumber(referencePrice) || referencePrice <= 0) {
    throw invalidParams("A positive frozen reference price is required to validate portfolio_manager rating_basis.", {
      reason: "PM_RATING_REFERENCE_PRICE_REQUIRED",
      rubric_id: PM_RATING_RUBRIC_ID,
      supplied_value: referencePrice ?? null,
    });
  }
  if (typeof referenceCurrency !== "string" || !/\S/u.test(referenceCurrency)) {
    throw invalidParams("A frozen reference currency is required to validate portfolio_manager rating_basis.", {
      reason: "PM_RATING_REFERENCE_CURRENCY_REQUIRED",
      rubric_id: PM_RATING_RUBRIC_ID,
      supplied_value: referenceCurrency ?? null,
    });
  }

  const basis = packet.rating_basis;
  const problems = [];
  const eligibleContexts = new Map((Array.isArray(adjustmentContexts) ? adjustmentContexts : [])
    .filter((context) => context && typeof context.context_id === "string"
      && validSourceIds(context.source_ids))
    .map((context) => [context.context_id, new Set(context.source_ids)]));

  if (basis.rubric_id !== PM_RATING_RUBRIC_ID) {
    problems.push(problem("rubric_id_mismatch", "/rating_basis/rubric_id", {
      expected: PM_RATING_RUBRIC_ID,
      actual: basis.rubric_id ?? null,
    }));
  }
  if (basis.horizon_months !== PM_RATING_HORIZON_MONTHS) {
    problems.push(problem("horizon_mismatch", "/rating_basis/horizon_months", {
      expected: PM_RATING_HORIZON_MONTHS,
      actual: basis.horizon_months ?? null,
    }));
  }

  if (basis.return_formula_id !== PM_RATING_RETURN_FORMULA_ID) {
    problems.push(problem("return_formula_id_mismatch", "/rating_basis/return_formula_id", {
      expected: PM_RATING_RETURN_FORMULA_ID,
      actual: basis.return_formula_id ?? null,
    }));
  }

  if (basis.price_currency !== referenceCurrency) {
    problems.push(problem("price_currency_mismatch", "/rating_basis/price_currency", {
      expected: referenceCurrency,
      actual: basis.price_currency ?? null,
    }));
  }

  const suppliedReferencePriceValid = finiteNumber(basis.reference_price)
    && basis.reference_price > 0;
  if (!suppliedReferencePriceValid) {
    problems.push(problem("reference_price_invalid", "/rating_basis/reference_price"));
  } else if (basis.reference_price !== referencePrice) {
    problems.push(problem("reference_price_mismatch", "/rating_basis/reference_price", {
      expected: referencePrice,
      actual: basis.reference_price,
    }));
  }

  const targetPriceValid = finiteNumber(basis.base_case_price_target)
    && basis.base_case_price_target >= 0;
  if (!targetPriceValid) {
    problems.push(problem("base_case_price_target_invalid", "/rating_basis/base_case_price_target"));
  }

  const incomeReturnValid = finiteNumber(basis.income_return_pct)
    && basis.income_return_pct >= 0
    && basis.income_return_pct <= MAX_INCOME_RETURN_PCT;
  if (!incomeReturnValid) {
    problems.push(problem("income_return_invalid", "/rating_basis/income_return_pct", {
      minimum: 0,
      maximum: MAX_INCOME_RETURN_PCT,
    }));
  }

  let expectedRawRating = null;
  let recomputedTotalReturnPct = null;
  if (typeof basis.base_case_total_return_pct !== "number"
    || !Number.isFinite(basis.base_case_total_return_pct)) {
    problems.push(problem("base_case_total_return_invalid", "/rating_basis/base_case_total_return_pct"));
  } else if (basis.base_case_total_return_pct < MIN_TOTAL_RETURN_PCT
    || basis.base_case_total_return_pct > MAX_TOTAL_RETURN_PCT) {
    problems.push(problem("base_case_total_return_out_of_range", "/rating_basis/base_case_total_return_pct", {
      minimum: MIN_TOTAL_RETURN_PCT,
      maximum: MAX_TOTAL_RETURN_PCT,
      actual: basis.base_case_total_return_pct,
    }));
  }

  if (targetPriceValid && incomeReturnValid) {
    recomputedTotalReturnPct = canonicalPercentage(
      ((basis.base_case_price_target / referencePrice) - 1) * 100
        + basis.income_return_pct,
    );
    if (!finiteNumber(recomputedTotalReturnPct)
      || recomputedTotalReturnPct < MIN_TOTAL_RETURN_PCT
      || recomputedTotalReturnPct > MAX_TOTAL_RETURN_PCT) {
      problems.push(problem("recomputed_total_return_out_of_range", "/rating_basis/base_case_total_return_pct", {
        minimum: MIN_TOTAL_RETURN_PCT,
        maximum: MAX_TOTAL_RETURN_PCT,
        recomputed: recomputedTotalReturnPct,
      }));
    } else {
      expectedRawRating = ratingForTwelveMonthReturn(recomputedTotalReturnPct);
      if (finiteNumber(basis.base_case_total_return_pct)
        && Math.abs(basis.base_case_total_return_pct - recomputedTotalReturnPct)
          > TOTAL_RETURN_TOLERANCE_PCT) {
        problems.push(problem("base_case_total_return_formula_mismatch", "/rating_basis/base_case_total_return_pct", {
          expected: recomputedTotalReturnPct,
          actual: basis.base_case_total_return_pct,
          tolerance_pct: TOTAL_RETURN_TOLERANCE_PCT,
        }));
      }
    }
  }

  if (!PM_RATING_SCALE.includes(basis.raw_rating)) {
    problems.push(problem("raw_rating_invalid", "/rating_basis/raw_rating", {
      actual: basis.raw_rating ?? null,
    }));
  } else if (expectedRawRating && basis.raw_rating !== expectedRawRating) {
    problems.push(problem("raw_rating_mismatch", "/rating_basis/raw_rating", {
      expected: expectedRawRating,
      actual: basis.raw_rating,
    }));
  }

  if (!PM_RATING_SCALE.includes(packet.rating)) {
    problems.push(problem("top_level_rating_invalid", "/rating", {
      actual: packet.rating ?? null,
    }));
  }
  if (!PM_RATING_SCALE.includes(basis.final_rating)) {
    problems.push(problem("final_rating_invalid", "/rating_basis/final_rating", {
      actual: basis.final_rating ?? null,
    }));
  } else if (packet.rating !== basis.final_rating) {
    problems.push(problem("final_rating_mismatch", "/rating_basis/final_rating", {
      expected: packet.rating ?? null,
      actual: basis.final_rating,
    }));
  }

  if (!validSourceIds(basis.source_ids)) {
    problems.push(problem("basis_source_ids_invalid", "/rating_basis/source_ids"));
  }

  const adjustment = basis.risk_adjustment;
  if (!RISK_ADJUSTMENTS.includes(adjustment)) {
    problems.push(problem("risk_adjustment_invalid", "/rating_basis/risk_adjustment", {
      allowed: RISK_ADJUSTMENTS,
      actual: adjustment ?? null,
    }));
  } else if (adjustment === "none") {
    if (PM_RATING_SCALE.includes(basis.raw_rating)
      && PM_RATING_SCALE.includes(basis.final_rating)
      && basis.final_rating !== basis.raw_rating) {
      problems.push(problem("unadjusted_final_rating_mismatch", "/rating_basis/final_rating", {
        expected: basis.raw_rating,
        actual: basis.final_rating,
      }));
    }
    if (basis.adjustment_reason !== null && basis.adjustment_reason !== "") {
      problems.push(problem("unadjusted_reason_must_be_empty", "/rating_basis/adjustment_reason"));
    }
    if (!validSourceIds(basis.adjustment_source_ids, { allowEmpty: true })
      || sourceIds(basis.adjustment_source_ids).length > 0) {
      problems.push(problem("unadjusted_source_ids_must_be_empty", "/rating_basis/adjustment_source_ids"));
    }
    if (!validSourceIds(basis.adjustment_context_ids, { allowEmpty: true })
      || sourceIds(basis.adjustment_context_ids).length > 0) {
      problems.push(problem("unadjusted_context_ids_must_be_empty", "/rating_basis/adjustment_context_ids"));
    }
  } else if (adjustment === "downgrade_one_notch") {
    const rawIndex = PM_RATING_SCALE.indexOf(basis.raw_rating);
    const finalIndex = PM_RATING_SCALE.indexOf(basis.final_rating);
    if (rawIndex < 0 || finalIndex !== rawIndex + 1) {
      problems.push(problem("downgrade_must_be_exactly_one_notch", "/rating_basis/final_rating", {
        raw_rating: basis.raw_rating ?? null,
        expected: rawIndex >= 0 ? PM_RATING_SCALE[rawIndex + 1] ?? null : null,
        actual: basis.final_rating ?? null,
      }));
    }
    if (typeof basis.adjustment_reason !== "string" || !/\S/u.test(basis.adjustment_reason)) {
      problems.push(problem("downgrade_reason_required", "/rating_basis/adjustment_reason"));
    }
    if (!validSourceIds(basis.adjustment_source_ids)) {
      problems.push(problem("downgrade_source_ids_required", "/rating_basis/adjustment_source_ids"));
    } else {
      const basisSources = new Set(sourceIds(basis.source_ids));
      const outsideBasis = basis.adjustment_source_ids.filter((id) => !basisSources.has(id));
      if (outsideBasis.length) {
        problems.push(problem("downgrade_source_ids_outside_basis", "/rating_basis/adjustment_source_ids", {
          source_ids: outsideBasis,
        }));
      }
    }
    if (!validSourceIds(basis.adjustment_context_ids)) {
      problems.push(problem("downgrade_context_ids_required", "/rating_basis/adjustment_context_ids"));
    } else {
      const unknownContexts = basis.adjustment_context_ids
        .filter((contextId) => !eligibleContexts.has(contextId));
      if (unknownContexts.length) {
        problems.push(problem("downgrade_context_ids_not_eligible", "/rating_basis/adjustment_context_ids", {
          context_ids: unknownContexts,
        }));
      }
      const adjustmentSources = new Set(sourceIds(basis.adjustment_source_ids));
      const referencedContexts = basis.adjustment_context_ids
        .filter((contextId) => eligibleContexts.has(contextId));
      const contextSources = new Set(referencedContexts
        .flatMap((contextId) => [...eligibleContexts.get(contextId)]));
      const sourcesOutsideContexts = [...adjustmentSources]
        .filter((sourceId) => !contextSources.has(sourceId));
      if (sourcesOutsideContexts.length) {
        problems.push(problem("downgrade_source_ids_outside_contexts", "/rating_basis/adjustment_source_ids", {
          source_ids: sourcesOutsideContexts,
        }));
      }
      const contextsWithoutCitedSource = referencedContexts.filter((contextId) => (
        ![...eligibleContexts.get(contextId)].some((sourceId) => adjustmentSources.has(sourceId))
      ));
      if (contextsWithoutCitedSource.length) {
        problems.push(problem("downgrade_context_without_cited_source", "/rating_basis/adjustment_context_ids", {
          context_ids: contextsWithoutCitedSource,
        }));
      }
    }
  }

  if (problems.length) {
    throw invalidParams("portfolio_manager rating_basis violated pm_rating_rubric_v2.", {
      reason: "PM_RATING_BASIS_MISMATCH",
      rubric_id: PM_RATING_RUBRIC_ID,
      problems: problems.slice(0, 16),
    });
  }

  return {
    rubric_id: PM_RATING_RUBRIC_ID,
    horizon_months: PM_RATING_HORIZON_MONTHS,
    return_formula_id: PM_RATING_RETURN_FORMULA_ID,
    price_currency: referenceCurrency,
    reference_price: referencePrice,
    base_case_price_target: basis.base_case_price_target,
    income_return_pct: basis.income_return_pct,
    base_case_total_return_pct: recomputedTotalReturnPct,
    raw_rating: expectedRawRating,
    risk_adjustment: basis.risk_adjustment,
    final_rating: basis.final_rating,
    adjustment_reason: basis.adjustment_reason || null,
    source_ids: [...basis.source_ids],
    adjustment_source_ids: [...sourceIds(basis.adjustment_source_ids)],
    adjustment_context_ids: [...sourceIds(basis.adjustment_context_ids)],
  };
}
