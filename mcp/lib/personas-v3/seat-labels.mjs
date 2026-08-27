/**
 * Auditable labels for one frozen method-seat result.
 *
 * This module is deliberately pure. It receives the frozen opinion and the exact catalog
 * slice used for that seat; it never loads the catalog, reads the run, or guesses an
 * instrument class. That keeps every label reproducible from persisted inputs.
 */

export const CAPABILITY_STATUSES = Object.freeze([
  "deterministic_stance",
  "abstain_missing_fact",
  "abstain_no_producer",
]);

export const EVIDENCE_QUALITIES = Object.freeze([
  "estimated_only",
  "mixed",
  "recomputed",
  "not_evaluable",
]);

const KNOWN_INSTRUMENT_CLASSES = new Set(["equity", "etf", "mutual_fund", "index"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function strings(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter((item) => typeof item === "string" && item.length))].sort();
}

function missingFacts(frozenOpinion) {
  return strings(
    frozenOpinion?.missing_required_fact_types
      || frozenOpinion?.eligibility?.missing_required_fact_types
      || frozenOpinion?.decision?.missing_required_fact_types
      || [],
  );
}

function capabilityStatus(frozenOpinion, coverage) {
  if (frozenOpinion?.stance !== "out_of_scope") return "deterministic_stance";
  const missing = missingFacts(frozenOpinion);
  const noProducer = new Set((coverage?.routes || [])
    .filter((route) => route?.critical === true && route?.status === "no_producer")
    .map((route) => route.fact_id));
  return missing.length > 0 && missing.every((factId) => noProducer.has(factId))
    ? "abstain_no_producer"
    : "abstain_missing_fact";
}

function producerApplies(producer, instrumentClass) {
  return (producer?.conditions || [])
    .filter((condition) => condition?.kind === "instrument_class")
    .every((condition) => Array.isArray(condition.any_of) && condition.any_of.includes(instrumentClass));
}

function evidenceBasis(coverage, instrumentClass) {
  if (!KNOWN_INSTRUMENT_CLASSES.has(instrumentClass)) return [];
  const producers = new Map((coverage?.producers || [])
    .map((producer) => [producer?.producer_id, producer]));
  const basis = [];
  for (const route of (coverage?.routes || []).filter((entry) => entry?.critical === true)) {
    const applicable = (route.producer_ids || [])
      .map((producerId) => producers.get(producerId))
      .filter((producer) => producer && producerApplies(producer, instrumentClass));
    const producer = applicable.length === 1
      ? applicable[0]
      : applicable.find((candidate) => candidate.maximal_precedence === true);
    if (!producer) continue;
    basis.push({
      fact_id: route.fact_id,
      producer_id: producer.producer_id,
      derivation: producer.observed?.derivation,
      confidence: producer.observed?.confidence,
    });
  }
  return basis.sort((left, right) => left.fact_id.localeCompare(right.fact_id)
    || left.producer_id.localeCompare(right.producer_id));
}

function evidenceQuality(basis, instrumentClass) {
  if (!KNOWN_INSTRUMENT_CLASSES.has(instrumentClass) || basis.length === 0) return "not_evaluable";
  const derivations = basis.map((item) => item.derivation);
  if (derivations.every((derivation) => derivation === "estimated")) return "estimated_only";
  if (derivations.every((derivation) => ["reported", "rederived"].includes(derivation))) return "recomputed";
  return "mixed";
}

export function labelFor({ frozenOpinion, coverage, instrumentClass } = {}) {
  const basis = evidenceBasis(coverage, String(instrumentClass || ""));
  return deepFreeze({
    capability_status: capabilityStatus(frozenOpinion, coverage),
    evidence_quality: evidenceQuality(basis, String(instrumentClass || "")),
    evidence_quality_basis: basis,
  });
}
