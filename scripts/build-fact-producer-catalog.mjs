#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FRED_SERIES } from "../mcp/lib/fred.mjs";
import { FUNDAMENTAL_FACT_IDS } from "../mcp/lib/fundamentals.mjs";
import {
  LOOK_THROUGH_CLAIM_FACTS,
  LOOK_THROUGH_FACT_IDS,
  LOOK_THROUGH_FACT_RULES,
} from "../mcp/lib/instrument-facts.mjs";
import {
  adaptGroundingToTypedFacts,
  CROSS_MARKET_FACTS,
  SCREEN_FACTS,
} from "../mcp/lib/personas-v3/grounding-adapter.mjs";
import {
  factProducerAcknowledgementErrors,
  FactProducerCatalogError,
  FACT_PRODUCER_SECTIONS,
  validateFactProducerCatalog,
} from "../mcp/lib/personas-v3/fact-producer-catalog.mjs";
import { canonicalJson, canonicalValue, sha256 } from "../mcp/lib/personas-v3/canonical.mjs";
import { loadSoloTestV3Packs } from "../mcp/lib/personas-v3/loader.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CATALOG_FILE = resolve(REPO_ROOT, "data/typed-fact-producers.v1.json");
const ACKNOWLEDGEMENT_FILE = resolve(REPO_ROOT, "data/typed-fact-no-producer-acknowledged.v1.json");
const ADAPTER_FILE = resolve(REPO_ROOT, "mcp/lib/personas-v3/grounding-adapter.mjs");
const SOLO_TEST_ROOT = resolve(REPO_ROOT, "knowledge/solo-test/masters");
const ADAPTER_ID = "grounding_to_typed_facts";
const ADAPTER_VERSION = "1.0.0";
const ROLE_ORDER = Object.freeze(["required", "optional", "eligibility", "veto", "scoring", "tool_input"]);
const CRITICAL_ROLES = new Set(["required", "eligibility", "veto", "tool_input"]);

export const FACT_PRODUCER_AS_OF = "2026-08-03T23:59:59.999Z";
const GATHERED_AT = "2026-08-03T12:00:00.000Z";
const PUBLIC_AT = "2026-07-31T00:00:00.000Z";
const OBSERVATION_DATE = "2026-07-31";

const baseGrounding = () => ({ as_of: FACT_PRODUCER_AS_OF, gathered_at: GATHERED_AT });

function quoteFixture() {
  return {
    quote: {
      symbol: "ACME",
      price: 100,
      previous_close: 99,
      change_pct: 1.010101,
      currency: "USD",
      quote_time: PUBLIC_AT,
      source: "yahoo",
    },
  };
}

function optionsFixture() {
  return {
    options: {
      symbol: "ACME",
      available: true,
      delayed: true,
      source: "CBOE delayed quotes",
      source_url: "https://cdn.cboe.com/api/global/delayed_quotes/options/ACME.json",
      observation_time: PUBLIC_AT,
      retrieved_at: GATHERED_AT,
      reference_expiry: { expiry: "2026-09-18", atm_iv: 0.25 },
      skew_25delta: { put_minus_call: 0.02 },
      atm_spread_pct_of_mid: 4,
      term_structure: [
        { expiry: "2026-09-18", dte: 46, atm_iv: 0.25 },
        { expiry: "2026-12-18", dte: 137, atm_iv: 0.23 },
      ],
    },
  };
}

function marketHistoryFixture() {
  const windows = Object.fromEntries([21, 63, 252].map((sessions) => [
    `${sessions}d`,
    { excess_return: sessions / 10_000 },
  ]));
  return {
    market_history: {
      available: true,
      symbol: "ACME",
      subject: {
        first_date: "2025-07-31",
        latest_date: OBSERVATION_DATE,
        session_count: 253,
        realized_volatility: { "20d_annualized": 0.2, "63d_annualized": 0.22 },
        returns: { "5d": 0.01, "21d": 0.02, "63d": 0.03, "126d": 0.04, "252d": 0.05 },
        volume: { ratios: { latest_to_20d: 1.2, latest_to_63d: 1.1 } },
      },
      benchmark_plan: { broad: "SPY", sector: "XLK", sector_basis: "declared_fixture" },
      relative_performance: {
        SPY: { windows },
        XLK: { windows: Object.fromEntries(Object.entries(windows)
          .map(([key, value]) => [key, { excess_return: value.excess_return / 2 }])) },
      },
      source_records: [{
        id: `market_history:ACME:${OBSERVATION_DATE}`,
        title: "ACME daily market history",
        url: "https://query1.finance.yahoo.com/v8/finance/chart/ACME?range=1y&interval=1d",
        observed_at: PUBLIC_AT,
        retrieved_at: GATHERED_AT,
      }],
    },
  };
}

function screenFixture() {
  const windowStart = (mapping) => mapping.window === "P10Y" ? "2016-01-01"
    : mapping.window === "P5Y" ? "2021-01-01" : "2025-01-01";
  const metrics = Object.entries(SCREEN_FACTS).map(([rule, mapping], index) => {
    const tag = `Fixture${rule.replace(/[^a-z0-9]/giu, "")}`;
    return {
      rule,
      value: mapping.kind === "percent" ? 10 + index : 1 + (index / 10),
      period_start: windowStart(mapping),
      period_end: "2025-12-31",
      fiscal_year: 2025,
      public_at: "2026-02-15T00:00:00.000Z",
      source_ids: [`sec:companyfacts:0000000001:${tag}:0000000001-26-000001:2025-12-31`],
    };
  });
  return { screen: { cik: "0000000001", public_at: "2026-02-15T00:00:00.000Z", metrics } };
}

function fredSeries(id, config, index) {
  return {
    id,
    ...config,
    latest: 1 + (index / 10),
    public_at: PUBLIC_AT,
    observation_date: OBSERVATION_DATE,
    source_url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`,
  };
}

function macroFixture() {
  const series = Object.fromEntries(Object.entries(FRED_SERIES)
    .map(([id, config], index) => [id, fredSeries(id, config, index)]));
  return {
    macro_series: {
      series,
      net_liquidity: {
        public_at: PUBLIC_AT,
        derived_from: ["WALCL", "RRPONTSYD", "WTREGEN"],
      },
      liquidity_impulse: {
        value: 0.01,
        window_days: 91,
        from_date: "2026-04-30",
        to_date: OBSERVATION_DATE,
        from_value: 1,
        to_value: 1.01,
      },
      regime: {
        state: "growth_up_inflation_down",
        window_days: 91,
        growth_axis: 0.01,
        inflation_axis: -0.01,
      },
    },
  };
}

const FUNDAMENTAL_CONTRACTS = Object.freeze({
  "financial.owner_earnings": { value_kind: "monetary", unit: "currency_units", duration: true, derivation: "estimated" },
  "financial.net_current_asset_value": { value_kind: "monetary", unit: "currency_units", duration: false, derivation: "rederived" },
  "valuation.downside_asset_value": { value_kind: "monetary", unit: "currency_units", duration: false, derivation: "rederived" },
  "valuation.downside_floor": { value_kind: "monetary", unit: "currency_units", duration: false, derivation: "rederived" },
  "valuation.revenue_growth": { value_kind: "ratio", unit: "decimal", duration: true, derivation: "rederived" },
  "financial.incremental_return_on_capital": { value_kind: "ratio", unit: "decimal", duration: true, derivation: "rederived" },
  "financial.leverage": { value_kind: "ratio", unit: "decimal", duration: false, derivation: "rederived" },
  "capital_allocation.share_count": { value_kind: "count", unit: "shares", duration: false, derivation: "reported" },
});

function fundamentalsFixture() {
  const metrics = Object.fromEntries(FUNDAMENTAL_FACT_IDS.map((factId, index) => {
    const contract = FUNDAMENTAL_CONTRACTS[factId];
    const tag = `Fixture${index}`;
    const accession = `0000000001-26-${String(index + 10).padStart(6, "0")}`;
    const sourceId = `sec:companyfacts:0000000001:${tag}:${accession}:2025-12-31`;
    return [factId, {
      value: contract.value_kind === "monetary" ? 1_000_000 + index
        : contract.value_kind === "count" ? 10_000_000 : 0.1 + (index / 100),
      value_kind: contract.value_kind,
      unit: contract.unit,
      ...(contract.value_kind === "ratio" ? { ratio_denominator: "declared_fixture_denominator" } : {}),
      currency: contract.value_kind === "monetary" ? "USD" : null,
      scale: contract.value_kind === "monetary" ? 1 : null,
      period_start: contract.duration ? "2025-01-01" : null,
      period_end: contract.duration ? "2025-12-31" : null,
      fiscal_year: 2025,
      public_at: "2026-02-15T00:00:00.000Z",
      source_ids: [sourceId],
      source_records: [{ tag, accession, period_end: "2025-12-31", filed: "2026-02-15" }],
      confidence: factId === "financial.owner_earnings" ? 0.65 : 0.9,
      derivation: contract.derivation,
      assumptions: factId === "financial.owner_earnings" ? ["maintenance capex proxy"] : [],
    }];
  }));
  return { fundamentals: { cik: "0000000001", metrics } };
}

const INSTRUMENT_RATIO_FACTS = Object.freeze([
  ...LOOK_THROUGH_FACT_IDS,
  "index.aggregate_pe_ttm",
  "index.aggregate_earnings_yield",
  "index.aggregate_pe_forward",
  "index.dividend_yield",
  "fund.top_ten_weight",
  "fund.concentration_hhi",
  "fund.expense_ratio",
  "valuation.implied_erp",
  "cycle.valuation_percentile",
  "index.breadth_above_200dma",
  "fund.net_flow_ratio",
  "index.breadth_counted_above_200dma",
]);

function instrumentEntry(factId, index) {
  const monetary = [...LOOK_THROUGH_CLAIM_FACTS, "fund.aum", "fund.net_flow"].includes(factId);
  const count = factId === "capital_allocation.share_count";
  const multiple = ["financial.interest_coverage", "accounting.cash_conversion", "index.aggregate_pe_ttm", "index.aggregate_pe_forward"]
    .includes(factId);
  const duration = [
    "financial.owner_earnings",
    "financial.free_cash_flow_5y",
    "valuation.revenue_growth",
    "accounting.cash_conversion",
    "financial.gross_margin_5y",
    "financial.net_margin_5y",
    "financial.return_on_equity_10y",
    "financial.incremental_return_on_capital",
    "financial.interest_coverage",
  ].includes(factId);
  const reported = [
    "index.aggregate_pe_ttm",
    "index.aggregate_pe_forward",
    "index.dividend_yield",
    "fund.expense_ratio",
    "valuation.implied_erp",
    "capital_allocation.share_count",
  ].includes(factId);
  return {
    fact_id: factId,
    value: monetary ? 1_000_000 + index : count ? 10_000_000 : 0.1 + (index / 1000),
    value_kind: monetary ? "monetary" : count ? "count" : "ratio",
    unit: monetary ? "currency_units" : count ? "shares" : multiple ? "multiple" : "decimal",
    ...(monetary ? { currency: "USD", scale: 1 } : {}),
    ...(duration ? { period_start: "2025-01-01", period_end: "2025-12-31" } : {}),
    ...(!monetary && !count ? { ratio_denominator: multiple ? "reported_denominator" : "price" } : {}),
    source_kind: factId.startsWith("index.") ? "market_snapshot" : "issuer_disclosure",
    source_url: `https://example.test/instrument/${encodeURIComponent(factId)}`,
    public_at: PUBLIC_AT,
    observation_date: OBSERVATION_DATE,
    confidence: reported ? 0.9 : 0.75,
    derivation: reported ? "reported" : "rederived",
    method: "offline_catalog_fixture_over_runtime_contract",
    title: `runtime-capable instrument fact ${factId}`,
  };
}

function instrumentFixture(variant = "maximal") {
  const maximalFactIds = [...new Set([
    ...INSTRUMENT_RATIO_FACTS,
    ...LOOK_THROUGH_CLAIM_FACTS,
    "fund.aum",
    "capital_allocation.share_count",
    "fund.net_flow",
  ])].sort();
  const factIds = variant === "index"
    ? maximalFactIds.filter((factId) => factId.startsWith("index.")
      || factId === "valuation.implied_erp"
      || factId === "cycle.valuation_percentile")
    : maximalFactIds;
  return { instrument_aggregate: { facts: factIds.map(instrumentEntry) } };
}

function insiderFixture() {
  const numeratorId = "sec:ownership:0000000001:0000000001-26-000099";
  const denominatorId = "sec:companyfacts:0000000001:EntityCommonStockSharesOutstanding:0000000001-26-000088:2026-05-15";
  return {
    insider_ownership: {
      value: 0.0955,
      owner_count: 1,
      as_of: "2026-06-16",
      public_at: "2026-06-16T00:00:00.000Z",
      method: "bounded Section 16 register proxy",
      owner_report_date_min: "2026-06-15",
      owner_report_date_max: "2026-06-15",
      coverage: { attempted_document_count: 1, unresolved_document_count: 0 },
      numerator_source_ids: [numeratorId],
      numerator_sources: [{
        source_id: numeratorId,
        accession: "0000000001-26-000099",
        form: "4",
        filing_date: "2026-06-16",
        report_date: "2026-06-15",
        owner_cik: "0000000002",
        url: "https://www.sec.gov/Archives/edgar/data/1/000000000126000099/form4.xml",
      }],
      denominator: {
        value: 10_000_000,
        measurement: "point_in_time_common_shares_outstanding",
        taxonomy: "dei",
        tag: "EntityCommonStockSharesOutstanding",
        form: "10-Q",
        period_end: "2026-05-15",
        public_at: "2026-05-20T00:00:00.000Z",
        source_id: denominatorId,
        source_url: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json",
      },
    },
  };
}

function crossMarketFixture() {
  return {
    cross_market: Object.entries(CROSS_MARKET_FACTS).map(([reference], index) => ({
      reference,
      label: reference,
      correlation: 0.5 + (index / 100),
      from: "2025-07-31",
      to: OBSERVATION_DATE,
      sessions: 252,
      relative_return: 0.01,
    })),
    sector_dispersion: {
      available: true,
      dispersion: 0.12,
      from: "2025-07-31",
      to: OBSERVATION_DATE,
      measured: 11,
      leader: { symbol: "XLK" },
      laggard: { symbol: "XLE" },
    },
  };
}

function basketNewsFixture() {
  return {
    basket_news: {
      available: true,
      window_days: 30,
      constituents_read: 10,
      coverage_weight: 0.72,
      filing_event_weight: 0.15,
      filing_event_count: 2,
      industry: { id: "technology" },
    },
  };
}

const SECTION_BUILDERS = Object.freeze({
  quote: quoteFixture,
  options: optionsFixture,
  market_history: marketHistoryFixture,
  screen: screenFixture,
  macro_series: macroFixture,
  fundamentals: fundamentalsFixture,
  instrument_aggregate: instrumentFixture,
  insider_ownership: insiderFixture,
  cross_market: crossMarketFixture,
  basket_news: basketNewsFixture,
});

const conditionalSections = (...included) => FACT_PRODUCER_SECTIONS
  .filter((section) => included.includes(section));
const EQUITY_US_SECTIONS = conditionalSections(
  "quote", "options", "market_history", "screen", "macro_series",
  "fundamentals", "insider_ownership", "cross_market",
);
const CONDITIONAL_SECTIONS = Object.freeze({
  equity_us: EQUITY_US_SECTIONS,
  equity_non_us: conditionalSections("quote", "options", "market_history", "macro_series", "cross_market"),
  fund: conditionalSections("quote", "options", "market_history", "macro_series", "instrument_aggregate", "cross_market", "basket_news"),
  index: conditionalSections("quote", "options", "market_history", "macro_series", "instrument_aggregate", "cross_market", "basket_news"),
  options_absent: EQUITY_US_SECTIONS.filter((section) => section !== "options"),
  cross_market_absent: EQUITY_US_SECTIONS.filter((section) => section !== "cross_market"),
});

function mergeSections(names) {
  return names.reduce((grounding, name) => Object.assign(grounding, SECTION_BUILDERS[name]()), baseGrounding());
}

export function buildSectionGrounding(section) {
  const build = SECTION_BUILDERS[section];
  if (!build) throw new Error(`unknown fact-producer section: ${section}`);
  return { ...baseGrounding(), ...build() };
}

export function buildMaximalGrounding() {
  return mergeSections(FACT_PRODUCER_SECTIONS);
}

export function buildConditionalGrounding(variant) {
  const sections = CONDITIONAL_SECTIONS[variant];
  if (!sections) throw new Error(`unknown fact-producer conditional fixture: ${variant}`);
  const grounding = mergeSections(sections);
  if (variant === "index") Object.assign(grounding, instrumentFixture("index"));
  return grounding;
}

function buildFactProducerGroundingFixtures() {
  return {
    maximal: buildMaximalGrounding(),
    sections: Object.fromEntries(FACT_PRODUCER_SECTIONS.map((section) => [section, buildSectionGrounding(section)])),
    conditional: Object.fromEntries(Object.keys(CONDITIONAL_SECTIONS)
      .map((variant) => [variant, buildConditionalGrounding(variant)])),
  };
}

const stableCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fail(code, message) {
  throw new FactProducerCatalogError(code, message);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function dataSource(id) {
  return { kind: "data_source", id };
}

function instrumentClass(...anyOf) {
  return { kind: "instrument_class", any_of: [...anyOf] };
}

function inferConditions(producer, presence) {
  const present = (variant) => presence.get(variant).has(producer.producer_id);
  const classes = [];
  if (present("equity_us")) classes.push("equity");
  if (present("fund")) classes.push("fund");
  if (present("index")) classes.push("index");
  if (!classes.length) {
    fail("NOT_EMITTED_IN_ANY_CLASS_VARIANT", `${producer.producer_id}: no class fixture emitted this producer`);
  }
  const conditions = [];
  if (classes.length !== 3) {
    const expanded = classes.flatMap((kind) => kind === "equity" ? ["equity"]
      : kind === "fund" ? ["etf", "mutual_fund"] : ["index"]);
    conditions.push(instrumentClass(...[...new Set(expanded)].sort()));
  }
  if (present("equity_us") && !present("equity_non_us")) {
    if (["screen", "fundamentals"].includes(producer.section)) conditions.push(dataSource("sec_companyfacts"));
    else if (producer.section === "insider_ownership") conditions.push(dataSource("sec_insider"));
    else fail("VARIANT_ATTRIBUTION_AMBIGUOUS", `${producer.producer_id}: equity-only difference has no source mapping`);
  }
  if (present("equity_us") && !present("options_absent")) {
    if (producer.section !== "options") {
      fail("VARIANT_ATTRIBUTION_AMBIGUOUS", `${producer.producer_id}: options-absence difference is not from options`);
    }
    conditions.push(dataSource("options_chain"));
  }
  if (present("equity_us") && !present("cross_market_absent")) {
    if (producer.section !== "cross_market") {
      fail("VARIANT_ATTRIBUTION_AMBIGUOUS", `${producer.producer_id}: cross-market difference is not from cross_market`);
    }
    conditions.push(dataSource("cross_market_reference"));
  }
  return conditions;
}

function declaredSources() {
  const records = [
    {
      source_module: "mcp/lib/fred.mjs",
      export_name: "FRED_SERIES",
      export_hash: sha256(FRED_SERIES),
      fact_ids: Object.values(FRED_SERIES).map((entry) => entry.fact).filter(Boolean).sort(),
    },
    {
      source_module: "mcp/lib/fundamentals.mjs",
      export_name: "FUNDAMENTAL_FACT_IDS",
      export_hash: sha256(FUNDAMENTAL_FACT_IDS),
      fact_ids: [...FUNDAMENTAL_FACT_IDS].sort(),
    },
    {
      source_module: "mcp/lib/instrument-facts.mjs",
      export_name: "LOOK_THROUGH_FACT_IDS",
      export_hash: sha256(LOOK_THROUGH_FACT_RULES),
      fact_ids: [...LOOK_THROUGH_FACT_IDS].sort(),
    },
    {
      source_module: "mcp/lib/personas-v3/grounding-adapter.mjs",
      export_name: "CROSS_MARKET_FACTS",
      export_hash: sha256(CROSS_MARKET_FACTS),
      fact_ids: Object.values(CROSS_MARKET_FACTS).sort(),
    },
    {
      source_module: "mcp/lib/personas-v3/grounding-adapter.mjs",
      export_name: "SCREEN_FACTS",
      export_hash: sha256(SCREEN_FACTS),
      fact_ids: Object.values(SCREEN_FACTS).map((entry) => entry.fact_id).sort(),
    },
  ];
  return records.sort((left, right) => stableCompare(
    `${left.source_module}\0${left.export_name}`,
    `${right.source_module}\0${right.export_name}`,
  ));
}

function declarationFor(section, factId) {
  if (section === "macro_series") {
    const match = Object.entries(FRED_SERIES).find(([, entry]) => entry.fact === factId);
    if (match) return { source_module: "mcp/lib/fred.mjs", export_name: "FRED_SERIES", key: match[0] };
  }
  if (section === "fundamentals" && FUNDAMENTAL_FACT_IDS.includes(factId)) {
    return { source_module: "mcp/lib/fundamentals.mjs", export_name: "FUNDAMENTAL_FACT_IDS", key: factId };
  }
  if (section === "instrument_aggregate" && LOOK_THROUGH_FACT_IDS.includes(factId)) {
    return { source_module: "mcp/lib/instrument-facts.mjs", export_name: "LOOK_THROUGH_FACT_IDS", key: factId };
  }
  if (section === "screen") {
    const match = Object.entries(SCREEN_FACTS).find(([, entry]) => entry.fact_id === factId);
    if (match) {
      return {
        source_module: "mcp/lib/personas-v3/grounding-adapter.mjs",
        export_name: "SCREEN_FACTS",
        key: match[0],
      };
    }
  }
  if (section === "cross_market") {
    const match = Object.entries(CROSS_MARKET_FACTS).find(([, emitted]) => emitted === factId);
    if (match) {
      return {
        source_module: "mcp/lib/personas-v3/grounding-adapter.mjs",
        export_name: "CROSS_MARKET_FACTS",
        key: match[0],
      };
    }
  }
  return null;
}

function runFixture(grounding, label) {
  const result = adaptGroundingToTypedFacts(grounding, { asOf: FACT_PRODUCER_AS_OF });
  const unexpected = result.diagnostics.filter((diagnostic) => diagnostic.code !== "duplicate_fact_id_skipped");
  if (unexpected.length) fail("FIXTURE_ADAPTER_ERROR", `${label}: ${canonicalJson(unexpected)}`);
  return result.fact_pack.facts;
}

function producerKind(fact, section) {
  if (fact.derivation !== "reported") return "deterministic_derived";
  return section === "macro_series" ? "normalized_source_field" : "direct_fetch";
}

function attributedVariantSection(fact, grounding) {
  const toolId = fact.lineage.tool_id;
  const prefixSections = [
    [`${ADAPTER_ID}:fundamentals:`, "fundamentals"],
    [`${ADAPTER_ID}:screen:`, "screen"],
    [`${ADAPTER_ID}:instrument:`, "instrument_aggregate"],
    [`${ADAPTER_ID}:market_history`, "market_history"],
    [`${ADAPTER_ID}:macro:`, "macro_series"],
    [`${ADAPTER_ID}:news:`, "basket_news"],
    [`${ADAPTER_ID}:cross_market:`, "cross_market"],
    [`${ADAPTER_ID}:sector_dispersion`, "cross_market"],
    [`${ADAPTER_ID}:section16:`, "insider_ownership"],
  ];
  const prefixed = prefixSections.filter(([prefix]) => toolId?.startsWith(prefix)).map(([, section]) => section);
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    fail("VARIANT_ATTRIBUTION_AMBIGUOUS", `${fact.fact_id}: lineage matches multiple runtime sections`);
  }
  if (toolId === ADAPTER_ID || toolId === null) {
    if (["market.price", "market.change_pct"].includes(fact.fact_id)) return "quote";
    if (fact.fact_id.startsWith("options.") || fact.fact_id === "execution.bid_ask") return "options";
    if (fact.fact_id.startsWith("macro.")) return "macro_series";
    const inFundamentals = Object.hasOwn(grounding.fundamentals?.metrics || {}, fact.fact_id);
    const inInstrument = grounding.instrument_aggregate?.facts?.some((entry) => entry.fact_id === fact.fact_id) || false;
    if (inFundamentals !== inInstrument) return inFundamentals ? "fundamentals" : "instrument_aggregate";
  }
  fail("VARIANT_ATTRIBUTION_AMBIGUOUS", `${fact.fact_id}: cannot attribute ${toolId || "reported"} to one runtime section`);
}

function buildVariantPresence(fixtures, producers) {
  const known = new Set(producers.map((producer) => producer.producer_id));
  const presence = new Map();
  for (const [variant, grounding] of Object.entries(fixtures.conditional)) {
    const observed = new Set();
    for (const fact of runFixture(grounding, `conditional:${variant}`)) {
      const section = attributedVariantSection(fact, grounding);
      const producerId = `${ADAPTER_ID}:${section}:${fact.fact_id}`;
      if (!known.has(producerId)) {
        fail("VARIANT_ATTRIBUTION_AMBIGUOUS", `${variant}/${fact.fact_id}: attributed producer ${producerId} was not isolated`);
      }
      observed.add(producerId);
    }
    presence.set(variant, observed);
  }
  return presence;
}

function buildProducers(fixtures) {
  const maximalFacts = runFixture(fixtures.maximal, "maximal");
  const maximalById = new Map(maximalFacts.map((fact) => [fact.fact_id, fact]));
  const raw = [];
  for (const section of FACT_PRODUCER_SECTIONS) {
    const facts = runFixture(fixtures.sections[section], `section:${section}`);
    for (const fact of facts) raw.push({ section, fact });
  }
  const sectionUnion = new Set(raw.map((entry) => entry.fact.fact_id));
  if (sectionUnion.size !== maximalById.size
    || [...sectionUnion].some((factId) => !maximalById.has(factId))) {
    fail("MAXIMAL_FIXTURE_DRIFT", "maximal fixture output must equal the union of isolated section outputs");
  }

  const byFact = new Map();
  for (const item of raw) {
    if (!byFact.has(item.fact.fact_id)) byFact.set(item.fact.fact_id, []);
    byFact.get(item.fact.fact_id).push(item);
  }
  const inferred = [];
  const winners = new Map();
  for (const [factId, candidates] of byFact) {
    const maximalBytes = canonicalJson(maximalById.get(factId));
    const matching = candidates.filter((candidate) => canonicalJson(candidate.fact) === maximalBytes);
    const winner = matching[0] || candidates[0];
    if (matching.length !== 1) inferred.push(factId);
    winners.set(factId, `${winner.section}\0${factId}`);
  }

  const producerSkeletons = raw.map(({ section, fact }) => ({
    fact_id: fact.fact_id,
    producer_id: `${ADAPTER_ID}:${section}:${fact.fact_id}`,
    section,
    kind: producerKind(fact, section),
    observed: {
      value_kind: fact.value_kind,
      unit: fact.unit,
      period_basis: fact.period_start === null ? "instant" : "duration",
      derivation: fact.derivation,
      lineage_tool_id: fact.lineage.tool_id,
      confidence: fact.confidence,
    },
    declared_in: declarationFor(section, fact.fact_id),
    observed_in_section_runs: [section],
    maximal_precedence: winners.get(fact.fact_id) === `${section}\0${fact.fact_id}`,
  }));
  const presence = buildVariantPresence(fixtures, producerSkeletons);
  const producers = producerSkeletons.map((producer) => ({
    ...producer,
    conditions: inferConditions(producer, presence),
  })).sort((left, right) => stableCompare(
    `${left.fact_id}\0${left.producer_id}`,
    `${right.fact_id}\0${right.producer_id}`,
  ));
  return { producers, inferred: [...new Set(inferred)].sort(), maximalFacts };
}

function collectFactIds(value, out = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectFactIds(item, out));
    return out;
  }
  if (!value || typeof value !== "object") return out;
  if (typeof value.fact_id === "string") out.add(value.fact_id);
  Object.values(value).forEach((item) => collectFactIds(item, out));
  return out;
}

function addRoles(target, factIds, role) {
  for (const factId of factIds) {
    if (!target.has(factId)) target.set(factId, new Set());
    target.get(factId).add(role);
  }
}

function packFactReferences(pack) {
  const roles = new Map();
  addRoles(roles, pack.manifest.capability.required_fact_types, "required");
  addRoles(roles, pack.manifest.capability.optional_fact_types, "optional");
  addRoles(roles, collectFactIds(pack.components.decision_policy.eligibility), "eligibility");
  addRoles(roles, collectFactIds(pack.components.decision_policy.hard_vetoes), "veto");
  addRoles(roles, collectFactIds(pack.components.decision_policy.scoring), "scoring");

  const contracts = new Map();
  for (const tool of pack.components.tools) {
    for (const [index, input] of tool.inputs.entries()) {
      if (!input.fact_id) continue;
      addRoles(roles, [input.fact_id], "tool_input");
      const inputContract = tool.input_contracts[index];
      const normalized = {
        value_kind: inputContract.value_kind,
        unit: inputContract.unit,
        period_basis: inputContract.period.basis,
      };
      if (contracts.has(input.fact_id)
        && canonicalJson(contracts.get(input.fact_id)) !== canonicalJson(normalized)) {
        fail("TOOL_CONTRACT_CONFLICT", `${pack.manifest.identity.persona_id}/${input.fact_id}: conflicting input contracts`);
      }
      contracts.set(input.fact_id, normalized);
    }
  }
  return { roles, contracts };
}

function coverageForPacks(producers) {
  const byFact = new Map();
  for (const producer of producers) {
    if (!byFact.has(producer.fact_id)) byFact.set(producer.fact_id, []);
    byFact.get(producer.fact_id).push(producer);
  }
  const loaded = loadSoloTestV3Packs({ dir: SOLO_TEST_ROOT });
  if (loaded.packs.length !== 26) fail("PACK_COUNT_DRIFT", `expected 26 physical solo-test packs; found ${loaded.packs.length}`);
  const coverage = [];
  for (const pack of loaded.packs) {
    const masterId = pack.manifest.identity.persona_id;
    const references = packFactReferences(pack);
    for (const [factId, roleSet] of references.roles) {
      const matched = byFact.get(factId) || [];
      const roles = ROLE_ORDER.filter((role) => roleSet.has(role));
      const critical = roles.some((role) => CRITICAL_ROLES.has(role));
      const status = matched.length === 0 ? "no_producer"
        : matched.some((producer) => producer.conditions.length === 0) ? "produced" : "conditional";
      const expected = references.contracts.get(factId) || null;
      const winner = matched.find((producer) => producer.maximal_precedence) || null;
      const observed = winner ? {
        value_kind: winner.observed.value_kind,
        unit: winner.observed.unit,
        period_basis: winner.observed.period_basis,
      } : null;
      const contractStatus = !expected || !observed ? "not_checked"
        : canonicalJson(expected) === canonicalJson(observed) ? "match" : "mismatch";
      coverage.push({
        master_id: masterId,
        fact_id: factId,
        roles,
        critical,
        declared_optional_but_critical: roles.includes("optional") && critical && !roles.includes("required"),
        producer_ids: matched.map((producer) => producer.producer_id).sort(),
        status,
        contract_status: contractStatus,
        contract_detail: contractStatus === "mismatch" ? { expected, observed } : null,
      });
    }
  }
  return coverage.sort((left, right) => stableCompare(
    `${left.master_id}\0${left.fact_id}`,
    `${right.master_id}\0${right.fact_id}`,
  ));
}

function buildNoProducer(coverage) {
  const byFact = new Map();
  for (const entry of coverage.filter((candidate) => candidate.status === "no_producer")) {
    if (!byFact.has(entry.fact_id)) byFact.set(entry.fact_id, {
      fact_id: entry.fact_id,
      master_ids: new Set(),
      critical: false,
      roles: new Set(),
    });
    const aggregate = byFact.get(entry.fact_id);
    aggregate.master_ids.add(entry.master_id);
    aggregate.critical ||= entry.critical;
    entry.roles.forEach((role) => aggregate.roles.add(role));
  }
  return [...byFact.values()].map((entry) => ({
    fact_id: entry.fact_id,
    master_ids: [...entry.master_ids].sort(),
    critical: entry.critical,
    roles: ROLE_ORDER.filter((role) => entry.roles.has(role)),
  })).sort((left, right) => stableCompare(left.fact_id, right.fact_id));
}

function fixtureHashes(fixtures) {
  return {
    maximal: sha256(fixtures.maximal),
    section: Object.fromEntries(FACT_PRODUCER_SECTIONS.map((section) => [section, sha256(fixtures.sections[section])])),
    conditional: Object.fromEntries(Object.entries(fixtures.conditional).map(([key, value]) => [key, sha256(value)])),
  };
}

export function assertDeclaredFactsObserved(catalog, {
  adapterSource = readFileSync(ADAPTER_FILE, "utf8"),
} = {}) {
  const observed = new Set(catalog.producers.map((producer) => producer.fact_id));
  const literalDeclarations = [...adapterSource.matchAll(
    /\bfactI[dD]\s*:\s*["']([a-z0-9_]+(?:\.[a-z0-9_]+)+)["']/gu,
  )].map((match) => match[1]);
  const declared = [
    ...catalog.sources.flatMap((source) => source.fact_ids),
    ...literalDeclarations,
  ];
  const missing = [...new Set(declared)].filter((factId) => !observed.has(factId)).sort();
  if (missing.length) fail("DECLARED_NOT_OBSERVED", `runtime declarations not observed in offline fixtures: ${missing.join(", ")}`);
  return true;
}

export function generateCatalog({ validate = true } = {}) {
  const fixtures = buildFactProducerGroundingFixtures();
  const { producers, inferred } = buildProducers(fixtures);
  const coverage = coverageForPacks(producers);
  const noProducer = buildNoProducer(coverage);
  const subject = canonicalValue({
    schema_version: 1,
    hash_domain: "alphacouncil.typed-fact-producers.v1",
    generator: {
      script: "scripts/build-fact-producer-catalog.mjs",
      adapter_id: ADAPTER_ID,
      adapter_version: ADAPTER_VERSION,
      as_of: FACT_PRODUCER_AS_OF,
      fixture_hashes: fixtureHashes(fixtures),
      precedence_inferred_by_call_order: inferred,
    },
    sources: declaredSources(),
    producers,
    pack_fact_coverage: coverage,
    no_producer: noProducer,
  });
  const catalog = canonicalValue({ ...subject, catalog_hash: sha256(subject) });
  assertDeclaredFactsObserved(catalog);
  if (validate) validateFactProducerCatalog(catalog, readJson(ACKNOWLEDGEMENT_FILE));
  return catalog;
}

export const buildFactProducerCatalog = generateCatalog;

export function renderCatalog(catalog) {
  return `${canonicalJson(catalog)}\n`;
}

export function catalogSummary(catalog) {
  const criticalEntries = catalog.no_producer.filter((entry) => entry.critical);
  const criticalSeats = new Set(criticalEntries.flatMap((entry) => entry.master_ids));
  const preferredOrder = ["master_taleb", "master_damodaran"];
  const seatNames = [...criticalSeats].sort((left, right) => (
    preferredOrder.indexOf(left) - preferredOrder.indexOf(right)
  ));
  const byId = new Map(catalog.producers.map((producer) => [producer.producer_id, producer]));
  const estimatedOnly = catalog.pack_fact_coverage.filter((entry) => (
    entry.critical
    && entry.producer_ids.length > 0
    && entry.producer_ids.every((producerId) => byId.get(producerId)?.observed.derivation === "estimated")
  ));
  const estimatedFactIds = [...new Set(estimatedOnly.map((entry) => entry.fact_id))].sort();
  const criticalByMaster = new Map();
  for (const entry of catalog.pack_fact_coverage.filter((candidate) => candidate.critical)) {
    if (!criticalByMaster.has(entry.master_id)) criticalByMaster.set(entry.master_id, []);
    criticalByMaster.get(entry.master_id).push(entry);
  }
  const fullyProduced = [...criticalByMaster]
    .filter(([, entries]) => entries.every((entry) => entry.status === "produced"))
    .map(([masterId]) => masterId)
    .sort();
  return [
    `typed facts referenced: ${new Set(catalog.pack_fact_coverage.map((entry) => entry.fact_id)).size}`,
    `runtime producer records: ${catalog.producers.length}`,
    `coverage routes: ${catalog.pack_fact_coverage.filter((entry) => entry.status === "produced").length} produced, ${catalog.pack_fact_coverage.filter((entry) => entry.status === "conditional").length} conditional, ${catalog.pack_fact_coverage.filter((entry) => entry.status === "no_producer").length} no_producer`,
    `critical facts fully produced: ${fullyProduced.length}/26 (${fullyProduced.join(", ")})`,
    `critical no_producer: ${criticalSeats.size} (${seatNames.join(", ")}) across ${criticalEntries.length} facts`,
    `critical facts covered only by estimated producers: ${estimatedFactIds.length} (${estimatedFactIds.join(", ")})`,
    "A catalog entry proves an offline runtime path, not live data availability, investment accuracy, or profitability.",
  ].join("\n");
}

function catalogFailure(error, fallbackCode) {
  return error instanceof FactProducerCatalogError
    ? error
    : new FactProducerCatalogError(fallbackCode, error?.message || String(error));
}

export function checkCatalogArtifacts(options = {}) {
  const failures = [];
  let catalog = null;
  let rendered = null;
  try {
    catalog = options.generate ? options.generate() : generateCatalog({ validate: false });
    rendered = renderCatalog(catalog);
  } catch (error) {
    failures.push(catalogFailure(error, "CATALOG_GENERATION_FAILED"));
  }

  if (catalog) {
    try {
      validateFactProducerCatalog(catalog, null, {
        rawCatalogText: rendered,
        checkAcknowledgements: false,
      });
    } catch (error) {
      failures.push(catalogFailure(error, "CATALOG_VALIDATION_FAILED"));
    }
  }

  let acknowledgement = null;
  try {
    acknowledgement = Object.hasOwn(options, "acknowledgement")
      ? options.acknowledgement
      : JSON.parse(readFileSync(ACKNOWLEDGEMENT_FILE, "utf8"));
  } catch (error) {
    failures.push(catalogFailure(error, "ACKNOWLEDGEMENT_READ_FAILED"));
  }
  if (catalog && acknowledgement) {
    failures.push(...factProducerAcknowledgementErrors(catalog, acknowledgement));
  }

  let committedText = null;
  try {
    committedText = Object.hasOwn(options, "committedText")
      ? options.committedText
      : readFileSync(CATALOG_FILE, "utf8");
  } catch (error) {
    failures.push(catalogFailure(error, "CATALOG_READ_FAILED"));
  }
  if (rendered !== null && committedText !== null && rendered !== committedText) {
    failures.push(new FactProducerCatalogError(
      "CATALOG_STALE",
      "typed-fact producer catalog is stale; run npm run facts:catalog:write",
    ));
  }
  return Object.freeze({ ok: failures.length === 0, failures: Object.freeze(failures), catalog });
}

export function main(argv = process.argv.slice(2)) {
  const allowed = new Set(["--write", "--check", "--summary"]);
  const unknown = argv.filter((arg) => !allowed.has(arg));
  if (unknown.length) throw new Error(`unknown argument: ${unknown.join(", ")}`);
  if (argv.includes("--write") && argv.includes("--check")) throw new Error("--write and --check are mutually exclusive");
  if (argv.includes("--check")) {
    const result = checkCatalogArtifacts();
    if (argv.includes("--summary") && result.catalog) process.stdout.write(`${catalogSummary(result.catalog)}\n`);
    if (!result.ok) {
      for (const failure of result.failures) {
        process.stderr.write(`[${failure.code || "ERROR"}] ${failure.message}\n`);
      }
      return 1;
    }
    return 0;
  }
  const catalog = generateCatalog();
  const rendered = renderCatalog(catalog);
  if (argv.includes("--write")) writeFileSync(CATALOG_FILE, rendered);
  if (argv.includes("--summary") || (!argv.includes("--write") && !argv.includes("--check"))) {
    process.stdout.write(`${catalogSummary(catalog)}\n`);
  }
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`Fact-producer catalog failed [${error.code || "ERROR"}]: ${error.message}\n`);
    process.exitCode = 1;
  }
}
