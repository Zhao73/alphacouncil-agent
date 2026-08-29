import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { catalogSnapshot } from "../../mcp/lib/council-selection.mjs";
import {
  METHOD_PANEL_FAMILIES,
  recommendMethodPanel,
} from "../../mcp/lib/method-panel-recommendation.mjs";
import { repoFile } from "../helpers/paths.mjs";

const catalog = catalogSnapshot("English");

function manifest(masterId) {
  return JSON.parse(readFileSync(repoFile(`knowledge/solo-test/masters/${masterId}/manifest.json`), "utf8"));
}

const manifests = new Map(catalog.all_master_ids.map((masterId) => [masterId, manifest(masterId)]));
const allFacts = [...new Set([...manifests.values()]
  .flatMap((entry) => entry.capability.required_fact_types))].sort();
const V1_ALL_FACTS_HASH = "sha256:630119afae35062f08443b1ca076318f44906ddb29fa35a438669f6a7fd50499";
const LEGACY_V2_ALL_FACTS_HASH = "sha256:4acf11babdad33beab27d6d7a00e442aa049f9043b26474687f33684610a6aaa";
const UNKNOWN_MARKET_PRICE_PAYLOAD_DIGEST = "5e9d5320dec85cc2d0b62e19e304823539c421393494744fde151162d5261338";
const FUND_FACTS = Object.freeze([
  "market.price",
  "market.change_pct",
  "macro.long_bond_yield",
  "macro.short_bond_yield",
  "macro.real_rate",
  "macro.breakeven_inflation",
  "macro.credit_spread",
  "macro.aaa_corporate_yield",
  "macro.term_structure_slope",
  "macro.liquidity_impulse",
  "index.aggregate_earnings_yield",
  "index.dividend_yield",
  "index.aggregate_pe_ttm",
  "valuation.revenue_growth",
  "options.implied_volatility",
]);

function recommendation(overrides = {}) {
  return recommendMethodPanel({
    catalog_hash: catalog.catalog_hash,
    instrument_classification: {
      asset_type: "equity",
      research_model: "operating_company",
      classification_source: "contract_fixture",
    },
    typed_fact_coverage: allFacts,
    ...overrides,
  });
}

function calibratedRecommendation(overrides = {}) {
  return recommendation({
    objective: "directional_rating",
    holding_horizon: "1_year",
    ...overrides,
  });
}

function familyMaster(result, familyId) {
  return result.family_assignments.find((assignment) => assignment.family_id === familyId)?.master_id;
}

test("the same frozen inputs produce one byte-identical eight-family recommendation and 26 reasoned decisions", () => {
  const first = recommendation();
  const second = recommendation();

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schema_version, 2);
  assert.equal(first.status, "recommended");
  assert.match(first.recommendation_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(first.recommendation_hash, LEGACY_V2_ALL_FACTS_HASH);
  assert.notEqual(first.recommendation_hash, V1_ALL_FACTS_HASH);
  assert.equal(first.included_master_ids.length, 8);
  assert.equal(new Set(first.included_master_ids).size, 8);
  assert.deepEqual(first.included_master_ids, [
    "master_buffett",
    "master_graham",
    "master_simons",
    "master_cathie_wood",
    "master_dalio",
    "master_burry",
    "master_klarman",
    "master_pabrai",
  ]);
  assert.deepEqual(first.unfilled_families, []);
  assert.equal(first.decisions.length, 26);
  assert.deepEqual(first.decisions.map((decision) => decision.master_id), catalog.all_master_ids);
  assert.deepEqual(
    [...new Set(first.decisions.filter((decision) => decision.decision === "include")
      .map((decision) => decision.family_id))].sort(),
    [...METHOD_PANEL_FAMILIES].sort(),
  );

  for (const decision of first.decisions) {
    assert.ok(["include", "exclude"].includes(decision.decision), decision.master_id);
    assert.equal(typeof decision.reason, "string", decision.master_id);
    assert.ok(decision.reason.trim(), decision.master_id);
    assert.ok(Array.isArray(decision.missing_facts), decision.master_id);
    if (decision.decision !== "include") continue;
    assert.deepEqual(decision.missing_facts, [], decision.master_id);

    const source = manifests.get(decision.master_id);
    assert.ok(METHOD_PANEL_FAMILIES.includes(decision.family_id), decision.master_id);
    assert.ok(
      decision.capability_basis.domains.some((domain) => source.capability.domains.includes(domain))
        || decision.capability_basis.required_fact_types
          .some((factId) => source.capability.required_fact_types.includes(factId)),
      `${decision.master_id} must be justified by its physical manifest, not a hard-coded celebrity list`,
    );
  }
});

test("sparse equity coverage leaves every family explicitly unfilled instead of recommending known failures", () => {
  const result = recommendation({ typed_fact_coverage: ["market.price"] });

  assert.equal(result.schema_version, 2);
  assert.equal(result.status, "recommended");
  assert.deepEqual(result.included_master_ids, []);
  assert.deepEqual(result.unfilled_families, [...METHOD_PANEL_FAMILIES]);
  assert.deepEqual(
    result.family_assignments,
    METHOD_PANEL_FAMILIES.map((familyId) => ({ family_id: familyId, master_id: null })),
  );
  assert.equal(result.decisions.length, 26);
  assert.ok(result.decisions.every((decision) => decision.decision === "exclude"));
  assert.ok(result.decisions.every((decision) => decision.missing_facts.length > 0));
  assert.ok(result.decisions.every((decision) => decision.reason_code === "required_facts_missing"));
});

for (const instrumentClassification of [
  { asset_type: "etf", research_model: "fund_lookthrough", classification_source: "contract_fixture" },
  { asset_type: "index", research_model: "index_aggregate", classification_source: "contract_fixture" },
]) {
  test(`${instrumentClassification.asset_type} recommendations include only fully covered packs and expose unfilled families`, () => {
    const result = recommendation({
      instrument_classification: instrumentClassification,
      typed_fact_coverage: FUND_FACTS,
    });

    assert.equal(result.schema_version, 2);
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.ok(result.included_master_ids.length > 0);
    assert.ok(result.unfilled_families.length > 0);
    assert.ok(result.decisions
      .filter((decision) => decision.decision === "include")
      .every((decision) => decision.missing_facts.length === 0));
    assert.deepEqual(
      result.family_assignments.filter((assignment) => assignment.master_id === null)
        .map((assignment) => assignment.family_id),
      result.unfilled_families,
    );
  });
}

test("coverage ordering and duplicates do not change the v2 recommendation hash", () => {
  const canonical = recommendation();
  const reordered = recommendation({ typed_fact_coverage: [...allFacts].reverse() });
  const duplicated = recommendation({ typed_fact_coverage: [...allFacts, ...allFacts] });

  assert.equal(reordered.recommendation_hash, canonical.recommendation_hash);
  assert.equal(duplicated.recommendation_hash, canonical.recommendation_hash);
});

test("missing instrument classification fails closed without guessing a default eight", () => {
  const result = recommendation({
    instrument_classification: null,
    typed_fact_coverage: ["market.price"],
  });
  assert.equal(result.status, "not_evaluable");
  assert.equal(result.reason_code, "instrument_classification_missing");
  assert.deepEqual(result.included_master_ids, []);
  assert.equal(result.recommendation_hash, null);
  assert.equal(result.decisions.length, 26);
  assert.ok(result.decisions.every((decision) => decision.decision === "exclude"));
  assert.equal(result.catalog_hash, catalog.catalog_hash);
  const { catalog_hash: currentCatalogIdentity, ...identityIndependentPayload } = result;
  assert.equal(currentCatalogIdentity, catalog.catalog_hash);
  assert.equal(
    createHash("sha256").update(JSON.stringify(identityIndependentPayload)).digest("hex"),
    UNKNOWN_MARKET_PRICE_PAYLOAD_DIGEST,
    "the unknown-classification fail-closed payload is frozen modulo catalog identity",
  );
});

test("instrument and typed-fact coverage activate specialists only when their manifest capability is relevant", () => {
  const etf = recommendation({
    instrument_classification: {
      asset_type: "etf",
      research_model: "fund_lookthrough",
      classification_source: "contract_fixture",
    },
  });
  assert.ok(etf.decisions.some((decision) => {
    const domains = manifests.get(decision.master_id).capability.domains;
    return decision.decision === "include"
      && domains.some((domain) => ["index_funds", "exchange_traded_funds"].includes(domain));
  }), "a fund/index method must be represented for a classified ETF");

  const optionFacts = allFacts.filter((factId) => /^(options|execution|payoff)\./u.test(factId));
  const option = recommendation({
    instrument_classification: {
      asset_type: "option",
      research_model: "derivative_contract",
      classification_source: "contract_fixture",
    },
    typed_fact_coverage: optionFacts,
  });
  assert.ok(option.decisions.some((decision) => {
    const domains = manifests.get(decision.master_id).capability.domains;
    return decision.decision === "include"
      && domains.some((domain) => /options|volatility|tail_risk/u.test(domain));
  }), "an options/volatility specialist must be represented when both classification and facts support it");

  const companyFacts = allFacts.filter((factId) => !/^(options|execution|payoff)\./u.test(factId));
  const company = recommendation({ typed_fact_coverage: companyFacts });
  const pureOptionSpecialists = [...manifests.entries()]
    .filter(([, entry]) => entry.capability.domains
      .some((domain) => ["options_pricing", "volatility_surface", "options_execution", "volatility_forecasting"].includes(domain)))
    .map(([masterId]) => masterId);
  assert.ok(pureOptionSpecialists.length > 0);
  assert.ok(company.decisions
    .filter((decision) => pureOptionSpecialists.includes(decision.master_id))
    .every((decision) => decision.decision === "exclude"));
});

test("calibration taxonomy has one exact, valid entry for every physical method", () => {
  const calibration = JSON.parse(readFileSync(repoFile("data/method-panel-calibration.v2.json"), "utf8"));
  assert.equal(calibration.schema_version, 2);
  assert.equal(calibration.contract_id, "alphacouncil_method_panel_calibration_v2");
  assert.equal(calibration.methods.length, 26);
  assert.deepEqual(
    calibration.methods.map((method) => method.master_id).sort(),
    [...catalog.all_master_ids].sort(),
  );
  assert.equal(new Set(calibration.methods.map((method) => method.master_id)).size, 26);
  for (const method of calibration.methods) {
    assert.ok(method.roles.length > 0, method.master_id);
    assert.ok(method.primary_intents.length > 0, method.master_id);
    assert.ok(method.supporting_intents.length > 0, method.master_id);
    assert.ok(method.horizons.length > 0, method.master_id);
    assert.ok(method.roles.every((role) => calibration.roles.includes(role)), method.master_id);
    assert.ok([...method.primary_intents, ...method.supporting_intents]
      .every((intent) => calibration.objectives.includes(intent)), method.master_id);
    assert.ok(method.horizons.every((horizon) => calibration.holding_horizons.includes(horizon)), method.master_id);
    assert.deepEqual(
      method.primary_intents.filter((intent) => method.supporting_intents.includes(intent)),
      [],
      `${method.master_id} must not call one intent both primary and supporting`,
    );
  }
});

test("partial or unsupported calibration inputs are rejected instead of guessed", () => {
  assert.throws(
    () => recommendation({ objective: "directional_rating" }),
    /objective and holding_horizon must be provided together/u,
  );
  assert.throws(
    () => recommendation({ holding_horizon: "1_year" }),
    /objective and holding_horizon must be provided together/u,
  );
  assert.throws(
    () => recommendation({ objective: "buy_now", holding_horizon: "1_year" }),
    /objective must be one of/u,
  );
  assert.throws(
    () => recommendation({ objective: "directional_rating", holding_horizon: "twelve_months" }),
    /holding_horizon must be one of/u,
  );
});

test("calibration v2 produces one deterministic schema-v3 decision vector and three disjoint groups", () => {
  const first = calibratedRecommendation();
  const second = calibratedRecommendation();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schema_version, 3);
  assert.equal(first.calibration_version, 2);
  assert.equal(first.objective, "directional_rating");
  assert.equal(first.holding_horizon, "1_year");
  assert.match(first.calibration_manifest_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.match(first.recommendation_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(first.recommendation_hash, LEGACY_V2_ALL_FACTS_HASH);
  assert.equal(first.decisions.length, 26);

  const groups = [
    first.directional_rating_master_ids,
    first.risk_coverage_master_ids,
    first.context_only_master_ids,
  ];
  const flattened = groups.flat();
  assert.equal(new Set(flattened).size, flattened.length, "calibrated panel groups must be mutually exclusive");
  assert.deepEqual(
    [...flattened].sort(),
    [...first.included_master_ids].sort(),
    "calibrated panel groups must partition every included method",
  );
  assert.equal(first.directional_rating_evaluable, true);

  for (const decision of first.decisions) {
    assert.ok(Array.isArray(decision.roles) && decision.roles.length > 0, decision.master_id);
    assert.ok(["primary", "supporting", "none"].includes(decision.objective_fit), decision.master_id);
    assert.ok(["exact", "compatible", "agnostic", "mismatch"].includes(decision.horizon_fit), decision.master_id);
    assert.ok(["primary", "supporting", "none"].includes(decision.rating_contribution), decision.master_id);
    if (decision.decision === "include") assert.deepEqual(decision.missing_facts, [], decision.master_id);
  }
  assert.ok(first.directional_rating_master_ids.every((masterId) => {
    const decision = first.decisions.find((candidate) => candidate.master_id === masterId);
    return decision.rating_contribution === "primary" && decision.roles.includes("directional_core");
  }));
});

test("one-year direction is separated from generic risk and instrument coverage", () => {
  const result = calibratedRecommendation();
  for (const masterId of ["master_taleb", "master_natenberg", "master_sinclair", "master_bogle"]) {
    const decision = result.decisions.find((candidate) => candidate.master_id === masterId);
    assert.equal(decision.rating_contribution, "none", `${masterId} is not a one-year underlying direction vote`);
    assert.equal(result.directional_rating_master_ids.includes(masterId), false, masterId);
  }
  const druckenmiller = result.decisions.find((decision) => decision.master_id === "master_druckenmiller");
  assert.equal(druckenmiller.objective_fit, "primary");
  assert.equal(druckenmiller.horizon_fit, "exact");
  assert.equal(druckenmiller.rating_contribution, "primary");

  const risk = calibratedRecommendation({
    objective: "general_risk_coverage",
    holding_horizon: "horizon_agnostic",
  });
  assert.deepEqual(risk.directional_rating_master_ids, []);
  assert.equal(risk.directional_rating_evaluable, null);
  assert.ok(risk.risk_coverage_master_ids.length > 0);
});

test("objective and horizon fit outrank the existing capability score before the stable id tie-breaker", () => {
  const legacy = recommendation();
  const oneYear = calibratedRecommendation();
  assert.equal(familyMaster(legacy, "growth_innovation"), "master_cathie_wood");
  assert.equal(
    familyMaster(oneYear, "growth_innovation"),
    "master_lynch",
    "a primary one-year directional fit must outrank a higher raw domain score that is only supporting",
  );

  const short = calibratedRecommendation({ holding_horizon: "1_4_weeks" });
  assert.equal(familyMaster(short, "quality_compounding"), "master_munger");
  assert.equal(familyMaster(oneYear, "quality_compounding"), "master_buffett");
  assert.notEqual(short.recommendation_hash, oneYear.recommendation_hash);
});

test("calibrated recommendations keep fact completeness and specialist admission as hard gates", () => {
  const sparse = calibratedRecommendation({ typed_fact_coverage: ["market.price"] });
  assert.ok(sparse.decisions
    .filter((decision) => decision.decision === "include")
    .every((decision) => decision.missing_facts.length === 0));
  assert.ok(sparse.unfilled_families.length > 0);

  const company = calibratedRecommendation();
  const optionSpecialists = [...manifests.entries()]
    .filter(([, entry]) => entry.capability.domains
      .some((domain) => ["options_pricing", "volatility_surface", "options_execution", "volatility_forecasting"].includes(domain)))
    .map(([masterId]) => masterId);
  assert.ok(optionSpecialists.length > 0);
  assert.ok(company.decisions
    .filter((decision) => optionSpecialists.includes(decision.master_id))
    .every((decision) => decision.decision === "exclude"));

  const optionFacts = allFacts.filter((factId) => /^(options|execution|payoff)\./u.test(factId));
  const option = calibratedRecommendation({
    instrument_classification: {
      asset_type: "option",
      research_model: "derivative_contract",
      classification_source: "contract_fixture",
    },
    typed_fact_coverage: optionFacts,
    objective: "relative_value",
    holding_horizon: "3_6_months",
  });
  assert.ok(option.decisions.some((decision) => decision.decision === "include"
    && decision.roles.includes("instrument_specialist")));
});

test("a calibrated request with no instrument classification fails closed in schema v3", () => {
  const result = recommendMethodPanel({
    catalog_hash: catalog.catalog_hash,
    instrument_classification: null,
    typed_fact_coverage: ["market.price"],
    objective: "directional_rating",
    holding_horizon: "1_year",
  });
  assert.equal(result.schema_version, 3);
  assert.equal(result.calibration_version, 2);
  assert.equal(result.status, "not_evaluable");
  assert.equal(result.reason_code, "instrument_classification_missing");
  assert.equal(result.recommendation_hash, null);
  assert.deepEqual(result.included_master_ids, []);
  assert.deepEqual(result.directional_rating_master_ids, []);
  assert.deepEqual(result.risk_coverage_master_ids, []);
  assert.deepEqual(result.context_only_master_ids, []);
  assert.equal(result.decisions.length, 26);
  assert.ok(result.decisions.every((decision) => decision.decision === "exclude"));
});

test("calibrated fact coverage remains order- and duplicate-insensitive", () => {
  const canonical = calibratedRecommendation();
  const reversed = calibratedRecommendation({ typed_fact_coverage: [...allFacts].reverse() });
  const duplicated = calibratedRecommendation({ typed_fact_coverage: [...allFacts, ...allFacts] });
  assert.equal(reversed.recommendation_hash, canonical.recommendation_hash);
  assert.equal(duplicated.recommendation_hash, canonical.recommendation_hash);
});
