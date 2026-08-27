import assert from "node:assert/strict";
import test from "node:test";

import {
  loadFactProducerCatalog,
  seatCoverage,
} from "../../mcp/lib/personas-v3/fact-producer-catalog.mjs";
import { labelFor } from "../../mcp/lib/personas-v3/seat-labels.mjs";

const catalog = loadFactProducerCatalog();

function frozen(over = {}) {
  return {
    master: "master_buffett",
    stance: "constructive",
    missing_required_fact_types: [],
    ...over,
  };
}

test("seatCoverage returns the complete immutable route and producer slice for one seat", () => {
  const coverage = seatCoverage(catalog, "master_buffett");
  const producerIds = [...new Set(coverage.routes.flatMap((route) => route.producer_ids))].sort();

  assert.equal(coverage.master_id, "master_buffett");
  assert.equal(coverage.catalog_hash, catalog.catalog_hash);
  assert.ok(coverage.routes.length > 0);
  assert.deepEqual(coverage.routes.map((route) => route.fact_id),
    [...coverage.routes.map((route) => route.fact_id)].sort());
  assert.deepEqual(coverage.producers.map((producer) => producer.producer_id), producerIds);
  assert.equal(Object.isFrozen(coverage), true);
  assert.equal(Object.isFrozen(coverage.routes), true);
  assert.equal(Object.isFrozen(coverage.producers[0].observed), true);
});

test("a computed Buffett equity stance is labelled deterministic with a mixed evidence basis", () => {
  const labels = labelFor({
    frozenOpinion: frozen(),
    coverage: seatCoverage(catalog, "master_buffett"),
    instrumentClass: "equity",
  });

  assert.equal(labels.capability_status, "deterministic_stance");
  assert.equal(labels.evidence_quality, "mixed");
  assert.deepEqual(labels.evidence_quality_basis.map((item) => item.fact_id),
    [...labels.evidence_quality_basis.map((item) => item.fact_id)].sort());
  assert.deepEqual(
    labels.evidence_quality_basis.find((item) => item.fact_id === "financial.owner_earnings"),
    {
      fact_id: "financial.owner_earnings",
      producer_id: "grounding_to_typed_facts:fundamentals:financial.owner_earnings",
      derivation: "estimated",
      confidence: 0.65,
    },
  );
  assert.equal(Object.isFrozen(labels.evidence_quality_basis), true);
});

test("Dalio equity is recomputed and unknown instrument classes are not guessed", () => {
  const coverage = seatCoverage(catalog, "master_dalio");
  const equity = labelFor({
    frozenOpinion: frozen({ master: "master_dalio" }),
    coverage,
    instrumentClass: "equity",
  });
  const unknown = labelFor({
    frozenOpinion: frozen({ master: "master_dalio" }),
    coverage,
    instrumentClass: "unknown",
  });

  assert.equal(equity.evidence_quality, "recomputed");
  assert.ok(equity.evidence_quality_basis.length > 0);
  assert.equal(unknown.evidence_quality, "not_evaluable");
  assert.deepEqual(unknown.evidence_quality_basis, []);
});

test("estimated_only is reachable with a synthetic critical coverage slice", () => {
  const labels = labelFor({
    frozenOpinion: frozen(),
    coverage: {
      master_id: "master_buffett",
      catalog_hash: `sha256:${"1".repeat(64)}`,
      routes: [{
        master_id: "master_buffett",
        fact_id: "financial.owner_earnings",
        critical: true,
        producer_ids: ["synthetic:fundamentals:financial.owner_earnings"],
        roles: ["required"],
        status: "produced",
      }],
      producers: [{
        fact_id: "financial.owner_earnings",
        producer_id: "synthetic:fundamentals:financial.owner_earnings",
        conditions: [],
        maximal_precedence: true,
        observed: { derivation: "estimated", confidence: 0.4 },
      }],
    },
    instrumentClass: "equity",
  });

  assert.equal(labels.evidence_quality, "estimated_only");
  assert.deepEqual(labels.evidence_quality_basis, [{
    fact_id: "financial.owner_earnings",
    producer_id: "synthetic:fundamentals:financial.owner_earnings",
    derivation: "estimated",
    confidence: 0.4,
  }]);
});

test("abstention labels distinguish no-producer, missing-fact and policy-gate outcomes", () => {
  for (const [master, missing] of [
    ["master_taleb", ["payoff.max_loss", "risk.ruin_possible"]],
    ["master_damodaran", ["valuation.cash_flow", "valuation.cost_of_capital"]],
  ]) {
    const labels = labelFor({
      frozenOpinion: frozen({ master, stance: "out_of_scope", missing_required_fact_types: missing }),
      coverage: seatCoverage(catalog, master),
      instrumentClass: "equity",
    });
    assert.equal(labels.capability_status, "abstain_no_producer", master);
  }

  const ordinaryGap = labelFor({
    frozenOpinion: frozen({
      stance: "out_of_scope",
      missing_required_fact_types: ["financial.owner_earnings"],
    }),
    coverage: seatCoverage(catalog, "master_buffett"),
    instrumentClass: "equity",
  });
  const emptyGap = labelFor({
    frozenOpinion: frozen({ stance: "out_of_scope" }),
    coverage: seatCoverage(catalog, "master_buffett"),
    instrumentClass: "equity",
  });

  assert.equal(ordinaryGap.capability_status, "abstain_missing_fact");
  assert.equal(emptyGap.capability_status, "abstain_policy_gate");
});
