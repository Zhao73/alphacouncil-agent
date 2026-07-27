import { test } from "node:test";
import assert from "node:assert/strict";

import {
  adaptGroundingToTypedFacts,
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
  assert.ok(first.sources.every((source) => /^https?:\/\//.test(source.url)));
  const sourceIds = new Set(first.sources.map((source) => source.source_id));
  assert.ok(first.fact_pack.facts.every((fact) => fact.source_ids.every((id) => sourceIds.has(id))));
  assert.equal(Object.isFrozen(first.fact_pack.facts), true);
});

test("untimestamped observations are skipped instead of inheriting the run cutoff", () => {
  const grounding = liveGrounding();
  delete grounding.gathered_at;
  delete grounding.quote.quote_time;
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
