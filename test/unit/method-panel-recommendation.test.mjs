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
const UNKNOWN_MARKET_PRICE_RESULT_DIGEST = "b654cd95511a9feed2aed549f6416ab0cc121298d2c54f63473f07e3eeafaec4";
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

test("the same frozen inputs produce one byte-identical eight-family recommendation and 26 reasoned decisions", () => {
  const first = recommendation();
  const second = recommendation();

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schema_version, 2);
  assert.equal(first.status, "recommended");
  assert.match(first.recommendation_hash, /^sha256:[a-f0-9]{64}$/u);
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
  assert.equal(
    createHash("sha256").update(JSON.stringify(result)).digest("hex"),
    UNKNOWN_MARKET_PRICE_RESULT_DIGEST,
    "the v1 fail-closed contract must remain byte-identical",
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
