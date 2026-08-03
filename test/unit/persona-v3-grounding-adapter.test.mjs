import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adaptGroundingToTypedFacts,
  enforceTypedFactSourceVisibility,
  typedFactPackFromGrounding,
} from "../../mcp/lib/personas-v3/grounding-adapter.mjs";

const AS_OF = "2026-07-27";

function liveGrounding() {
  return {
    as_of: AS_OF,
    gathered_at: "2026-07-27T12:00:00.000Z",
    quote: {
      symbol: "NOK",
      price: 9.1,
      previous_close: 9.73,
      change_pct: -6.47,
      currency: "USD",
      quote_time: "2026-07-27T11:45:00.000Z",
      source: "yahoo",
    },
    options: {
      symbol: "NOK",
      available: true,
      delayed: true,
      source: "CBOE delayed quotes",
      quote_time: "2026-07-27T11:30:00.000Z",
      chain_timestamp: "2026-07-27T11:30:00.000Z",
      reference_expiry: { expiry: "2026-08-15", atm_iv: 0.45 },
      skew_25delta: { put_minus_call: 0.0033 },
      atm_spread_pct_of_mid: 8,
      term_structure: [{ expiry: "2026-08-15", dte: 19, atm_iv: 0.45 }],
    },
  };
}

test("timestamped grounding becomes one immutable typed fact pack", () => {
  const first = adaptGroundingToTypedFacts(liveGrounding(), { asOf: AS_OF });
  const second = typedFactPackFromGrounding(liveGrounding(), { asOf: AS_OF });
  assert.equal(first.fact_pack.fact_pack_hash, second.fact_pack_hash);
  assert.deepEqual(first.fact_pack.facts.map((fact) => fact.fact_id), [
    "execution.bid_ask",
    "market.change_pct",
    "market.price",
    "options.implied_volatility",
    "options.skew_25d",
    "options.term_structure",
  ]);
  assert.equal(first.fact_pack.facts.find((fact) => fact.fact_id === "market.price").currency, "USD");
  assert.equal(first.fact_pack.facts.find((fact) => fact.fact_id === "options.skew_25d").value, 0.0033);
  assert.equal(first.sources.length, 2);
  const optionSource = first.sources.find((source) => /option chain/i.test(source.title));
  assert.equal(optionSource.public_at, "2026-07-27T11:30:00.000Z");
  assert.equal(optionSource.retrieved_at, "2026-07-27T12:00:00.000Z");
  assert.equal(optionSource.locator.observation_time, "2026-07-27T11:30:00.000Z");
  assert.ok(first.sources.every((source) => /^https?:\/\//.test(source.url)));
  const sourceIds = new Set(first.sources.map((source) => source.source_id));
  assert.ok(first.fact_pack.facts.every((fact) => fact.source_ids.every((id) => sourceIds.has(id))));
  assert.equal(Object.isFrozen(first.fact_pack.facts), true);
});

test("untimestamped observations are skipped instead of inheriting the run cutoff", () => {
  const grounding = liveGrounding();
  delete grounding.gathered_at;
  delete grounding.quote.quote_time;
  delete grounding.options.quote_time;
  delete grounding.options.chain_timestamp;
  const adapted = adaptGroundingToTypedFacts(grounding, { asOf: AS_OF });
  assert.equal(adapted.fact_pack.facts.length, 0);
  assert.deepEqual(adapted.diagnostics.map((entry) => entry.source), ["quote", "options"]);
});

test("an observation after an exact cutoff is not converted", () => {
  const adapted = adaptGroundingToTypedFacts(liveGrounding(), {
    asOf: "2026-07-27T11:00:00.000Z",
    knowledgeAsOf: "2026-07-27T11:00:00.000Z",
  });
  assert.equal(adapted.fact_pack.facts.length, 0);
  assert.ok(adapted.diagnostics.every((entry) => entry.code === "missing_public_at"));
});

test("options metrics use the chain observation instead of an older underlying trade", () => {
  const grounding = liveGrounding();
  grounding.as_of = "2026-08-03";
  grounding.gathered_at = "2026-08-03T10:19:08.015Z";
  grounding.options.quote_time = "2026-07-31T19:59:59.000Z";
  grounding.options.last_trade_time = "2026-07-31T19:59:59.000Z";
  grounding.options.chain_timestamp = "2026-08-03T10:17:46.000Z";
  grounding.options.retrieved_at = "2026-08-03T10:19:08.015Z";

  const adapted = adaptGroundingToTypedFacts(grounding, { asOf: "2026-08-03" });
  const optionSource = adapted.sources.find((source) => /option chain/iu.test(source.title));
  const optionFacts = adapted.fact_pack.facts.filter((fact) => fact.source_ids.includes(optionSource.source_id));
  const optionFactIds = new Set(optionFacts.map((fact) => fact.fact_id));
  for (const factId of [
    "execution.bid_ask",
    "options.implied_volatility",
    "options.skew_25d",
    "options.term_structure",
  ]) assert.equal(optionFactIds.has(factId), true, `${factId} was not published from the chain snapshot`);
  assert.ok(optionFacts.every((fact) => fact.public_at === "2026-08-03T10:17:46.000Z"));

  assert.equal(optionSource.public_at, "2026-08-03T10:17:46.000Z");
  assert.equal(optionSource.locator.observation_time, "2026-08-03T10:17:46.000Z");
  assert.equal(optionSource.locator.underlying_price_observation_time, "2026-07-31T19:59:59.000Z");
  assert.equal(adapted.diagnostics.some((entry) => entry.code === "fact_public_at_precedes_source"), false);
});

test("source visibility rejects options metrics backdated to the underlying trade", () => {
  const diagnostics = [];
  const sourceId = "options:CBOE:NOK:2026-08-03T10:17:46.000Z";
  const facts = enforceTypedFactSourceVisibility([
    {
      fact_id: "options.implied_volatility",
      public_at: "2026-07-31T19:59:59.000Z",
      source_ids: [sourceId],
    },
    {
      fact_id: "execution.bid_ask",
      public_at: "2026-07-31T19:59:59.000Z",
      source_ids: [sourceId],
    },
  ], new Map([[sourceId, {
    source_id: sourceId,
    public_at: "2026-08-03T10:17:46.000Z",
  }]]), diagnostics);

  assert.deepEqual(facts, []);
  assert.deepEqual(diagnostics.map((entry) => ({
    code: entry.code,
    fact_id: entry.fact_id,
    source_public_at: entry.sources[0].source_public_at,
  })), [
    {
      code: "fact_public_at_precedes_source",
      fact_id: "options.implied_volatility",
      source_public_at: "2026-08-03T10:17:46.000Z",
    },
    {
      code: "fact_public_at_precedes_source",
      fact_id: "execution.bid_ask",
      source_public_at: "2026-08-03T10:17:46.000Z",
    },
  ]);
});

test("unversioned screen and macro summaries remain explicit lineage gaps", () => {
  const grounding = liveGrounding();
  grounding.screen = { metrics: [{ rule: "gross_margin", value: 20 }] };
  grounding.macro = { derived: [{ id: "spread_10y_3m", value: 0.5 }] };
  const adapted = adaptGroundingToTypedFacts(grounding, { asOf: AS_OF });
  assert.deepEqual(
    adapted.diagnostics.filter((entry) => entry.code === "missing_source_lineage").map((entry) => entry.source),
    ["screen.gross_margin", "macro"],
  );
  assert.equal(adapted.fact_pack.facts.some((fact) => fact.fact_id.startsWith("financial.")), false);
});

test("filing-derived screen metrics convert only when period, publication and source lineage exist", () => {
  const grounding = liveGrounding();
  grounding.screen = {
    cik: "0000000001",
    public_at: "2026-02-15",
    metrics: [{
      rule: "ocf_over_ni",
      value: 1.25,
      unit: "x",
      period_start: "2021-01-01",
      period_end: "2025-12-31",
      fiscal_year: 2025,
      public_at: "2026-02-15",
      source_ids: ["sec:companyfacts:0000000001:cash:2026-02-15:2025-12-31"],
    }],
  };
  const adapted = adaptGroundingToTypedFacts(grounding, { asOf: AS_OF });
  const fact = adapted.fact_pack.facts.find((item) => item.fact_id === "accounting.cash_conversion");
  assert.equal(fact.value, 1.25);
  assert.equal(fact.public_at, "2026-02-15");
  assert.equal(fact.period_start, "2021-01-01");
  assert.equal(fact.period_end, "2025-12-31");
  assert.equal(fact.derivation, "rederived");
  assert.match(fact.lineage.calculation_hash, /^sha256:[a-f0-9]{64}$/);
});

test("one SEC record can ground multiple derived metrics without a source identity collision", () => {
  const grounding = liveGrounding();
  const sharedSource = "sec:companyfacts:0000000001:NetIncomeLoss:0000000001-26-000001:2025-12-31";
  grounding.screen = {
    cik: "0000000001",
    public_at: "2026-02-15",
    metrics: [
      {
        rule: "roe_10y",
        value: 12,
        unit: "%",
        period_start: "2016-01-01",
        period_end: "2025-12-31",
        fiscal_year: 2025,
        public_at: "2026-02-15",
        source_ids: [sharedSource],
      },
      {
        rule: "net_margin",
        value: 8,
        unit: "%",
        period_start: "2021-01-01",
        period_end: "2025-12-31",
        fiscal_year: 2025,
        public_at: "2026-02-15",
        source_ids: [sharedSource],
      },
    ],
  };

  const adapted = adaptGroundingToTypedFacts(grounding, { asOf: AS_OF });
  assert.deepEqual(
    adapted.fact_pack.facts
      .filter((fact) => fact.fact_id === "financial.return_on_equity_10y" || fact.fact_id === "financial.net_margin_5y")
      .map((fact) => fact.fact_id),
    ["financial.net_margin_5y", "financial.return_on_equity_10y"],
  );
  const [source] = adapted.sources.filter((item) => item.source_id === sharedSource);
  assert.ok(source);
  assert.deepEqual(source.locator, {
    accession: "0000000001-26-000001",
    cik: "0000000001",
    period_end: "2025-12-31",
    tag: "NetIncomeLoss",
  });
  assert.doesNotMatch(source.title, /roe|margin/iu);
  assert.equal(adapted.diagnostics.some((entry) => entry.code === "source_id_collision"), false);
  assert.equal(
    adapted.fact_pack.facts.find((fact) => fact.fact_id === "financial.return_on_equity_10y").lineage.tool_id,
    "grounding_to_typed_facts:screen:roe_10y",
  );
  assert.equal(
    adapted.fact_pack.facts.find((fact) => fact.fact_id === "financial.net_margin_5y").lineage.tool_id,
    "grounding_to_typed_facts:screen:net_margin",
  );
});

test("liquidity impulse becomes public no earlier than its latest cited FRED input", () => {
  const fred = (id, observationDate, publicAt) => ({
    id,
    fact: null,
    latest: 1,
    label: id,
    observation_date: observationDate,
    public_at: publicAt,
    source_url: `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`,
  });
  const grounding = {
    as_of: "2026-08-03",
    gathered_at: "2026-08-03T12:00:00.000Z",
    macro_series: {
      series: {
        WALCL: fred("WALCL", "2026-07-29", "2026-07-29T00:00:00.000Z"),
        RRPONTSYD: fred("RRPONTSYD", "2026-07-31", "2026-07-31T00:00:00.000Z"),
        WTREGEN: fred("WTREGEN", "2026-07-29", "2026-07-29T00:00:00.000Z"),
      },
      net_liquidity: {
        public_at: "2026-07-29T00:00:00.000Z",
        derived_from: ["WALCL", "RRPONTSYD", "WTREGEN"],
      },
      liquidity_impulse: {
        value: 0.01,
        window_days: 91,
        from_date: "2026-04-29",
        to_date: "2026-07-29",
        from_value: 1,
        to_value: 1.01,
      },
    },
  };

  const adapted = adaptGroundingToTypedFacts(grounding, { asOf: "2026-08-03" });
  const impulse = adapted.fact_pack.facts.find((fact) => fact.fact_id === "macro.liquidity_impulse");
  assert.equal(impulse.public_at, "2026-07-31T00:00:00.000Z");
  assert.ok(impulse.source_ids.some((id) => id.includes("RRPONTSYD:2026-07-31")));
  assert.equal(adapted.diagnostics.some((entry) => entry.code === "fact_public_at_precedes_source"), false);
});

test("the final source-visibility gate drops a fact dated before a cited source", () => {
  const diagnostics = [];
  const sourceId = "fred:RRPONTSYD:2026-07-31";
  const facts = enforceTypedFactSourceVisibility([{
    fact_id: "macro.liquidity_impulse",
    public_at: "2026-07-29T00:00:00.000Z",
    source_ids: [sourceId],
  }], new Map([[sourceId, {
    source_id: sourceId,
    public_at: "2026-07-31T00:00:00.000Z",
  }]]), diagnostics);

  assert.deepEqual(facts, []);
  assert.deepEqual(diagnostics, [{
    code: "fact_public_at_precedes_source",
    fact_id: "macro.liquidity_impulse",
    fact_public_at: "2026-07-29T00:00:00.000Z",
    sources: [{ source_id: sourceId, source_public_at: "2026-07-31T00:00:00.000Z" }],
    action: "not_converted",
  }]);
});

test("insider ownership keeps every exact Form 4 document in typed-fact lineage", () => {
  const numeratorId = "sec:ownership:0000320193:0000320193-26-000099";
  const denominatorId = "sec:companyfacts:0000320193:EntityCommonStockSharesOutstanding:0000320193-26-000088:2026-05-15";
  const grounding = {
    as_of: "2026-08-03",
    gathered_at: "2026-08-03T12:00:00.000Z",
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
        accession: "0000320193-26-000099",
        form: "4",
        filing_date: "2026-06-16",
        report_date: "2026-06-15",
        owner_cik: "0001780525",
        url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000099/form4.xml",
      }],
      denominator: {
        value: 1_000_000,
        measurement: "point_in_time_common_shares_outstanding",
        taxonomy: "dei",
        tag: "EntityCommonStockSharesOutstanding",
        form: "10-Q",
        period_end: "2026-05-15",
        public_at: "2026-05-20T00:00:00.000Z",
        source_id: denominatorId,
        source_url: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
      },
    },
  };
  const adapted = adaptGroundingToTypedFacts(grounding, { asOf: "2026-08-03" });
  const fact = adapted.fact_pack.facts.find((candidate) => candidate.fact_id === "governance.insider_ownership");
  assert.deepEqual(fact.source_ids, [numeratorId, denominatorId]);
  const numerator = adapted.sources.find((source) => source.source_id === numeratorId);
  assert.equal(numerator.url, grounding.insider_ownership.numerator_sources[0].url);
  assert.equal(numerator.locator.accession, "0000320193-26-000099");
  assert.equal(numerator.locator.owner_cik, "0001780525");
  assert.equal(adapted.diagnostics.length, 0);
});
