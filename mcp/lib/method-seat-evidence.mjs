/** Preregistered evidence gate for method-seat portfolio decisions. */

import { canonicalValue, sha256 } from "./personas-v3/canonical.mjs";

export const METHOD_SEAT_STATUSES = Object.freeze(["active", "conditional", "observe"]);

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const THRESHOLDS = Object.freeze({
  minimum_hash_identical_repeats_per_case: 3,
  minimum_distinct_cases: 6,
  minimum_instrument_types: 3,
});

function strings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))].sort();
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Qualify a run before it can enter a seat decision. Invalid or legacy material is retained as
 * an observation hypothesis, never silently discarded and never upgraded by a seat/file count.
 */
export function classifyMethodSeatEvidence({
  artifact_version,
  required_artifact_version,
  git_dirty,
  seat_count,
  seat_contract_valid_count,
  source_label = null,
} = {}) {
  const reasons = [];
  if (typeof artifact_version !== "string" || artifact_version !== required_artifact_version) {
    reasons.push("artifact_version_mismatch");
  }
  if (git_dirty !== false) reasons.push("dirty_worktree");
  if (!Number.isInteger(seat_count) || seat_count <= 0
    || !Number.isInteger(seat_contract_valid_count)
    || seat_contract_valid_count !== seat_count) {
    reasons.push("seat_contract_invalid");
  }
  return Object.freeze(canonicalValue({
    eligibility: reasons.length ? "observation_hypothesis" : "decision_evidence",
    reasons,
    source_label: typeof source_label === "string" ? source_label : null,
  }));
}

function qualifiedCases(records, masterIds) {
  const byCase = new Map();
  for (const record of records) {
    if (typeof record?.case_id !== "string" || !record.case_id.trim()) continue;
    if (!byCase.has(record.case_id)) byCase.set(record.case_id, []);
    byCase.get(record.case_id).push(record);
  }

  const qualified = [];
  for (const [caseId, group] of byCase) {
    const inputHashes = strings(group.map((record) => record.exact_input_hash));
    const repeatIds = strings(group.map((record) => record.repeat_id));
    const instrumentTypes = strings(group.map((record) => record.instrument_type));
    const complete = group.every((record) => {
      if (!SHA256.test(record?.exact_input_hash || "") || !SHA256.test(record?.vocabulary_hash || "")) return false;
      const seats = Array.isArray(record?.seats) ? record.seats : [];
      const byMaster = new Map(seats.map((seat) => [seat?.master_id, seat]));
      return byMaster.size === masterIds.length && masterIds.every((masterId) => (
        SHA256.test(byMaster.get(masterId)?.outcome_hash || "")
      ));
    });
    if (!complete || inputHashes.length !== 1 || instrumentTypes.length !== 1
      || repeatIds.length < THRESHOLDS.minimum_hash_identical_repeats_per_case
      || group.length < THRESHOLDS.minimum_hash_identical_repeats_per_case) continue;
    qualified.push({
      case_id: caseId,
      exact_input_hash: inputHashes[0],
      instrument_type: instrumentTypes[0],
      records: group.slice().sort((left, right) => stableCompare(left.repeat_id, right.repeat_id)),
    });
  }
  return qualified.sort((left, right) => stableCompare(left.case_id, right.case_id));
}

function seatReview(masterId, cases, gatePassed) {
  if (!gatePassed) {
    return { master_id: masterId, status: "observe", reason: "preregistered_sample_gate_not_met" };
  }
  let stableCases = 0;
  let distinctCases = 0;
  for (const candidate of cases) {
    const hashes = candidate.records.map((record) => (
      record.seats.find((seat) => seat.master_id === masterId)?.outcome_hash || null
    ));
    if (new Set(hashes).size === 1 && hashes[0]) stableCases += 1;
    const representative = candidate.records[0].seats;
    const own = representative.find((seat) => seat.master_id === masterId)?.outcome_hash;
    if (own && representative.some((seat) => seat.master_id !== masterId && seat.outcome_hash !== own)) {
      distinctCases += 1;
    }
  }
  if (stableCases === cases.length && distinctCases === cases.length) {
    return { master_id: masterId, status: "active", reason: "repeat_stable_and_cross_seat_distinct_in_qualified_cases" };
  }
  if (stableCases === cases.length) {
    return { master_id: masterId, status: "conditional", reason: "repeat_stable_but_cross_seat_distinction_requires_review" };
  }
  return { master_id: masterId, status: "observe", reason: "repeat_stability_not_demonstrated" };
}

/** Evaluate only already-qualified records against the frozen 3 x 6 x 3 sample boundary. */
export function evaluateMethodSeatPortfolio(records, { catalog_master_ids } = {}) {
  if (!Array.isArray(records)) throw new Error("method seat evidence records must be an array");
  const masterIds = strings(catalog_master_ids);
  if (!masterIds.length) throw new Error("method seat evidence requires catalog_master_ids");
  const eligible = records.filter((record) => record?.evidence_classification?.eligibility === "decision_evidence");
  const observations = records.filter((record) => record?.evidence_classification?.eligibility === "observation_hypothesis");
  const versions = strings(eligible.map((record) => record.vocabulary_version));
  const vocabularyHashes = strings(eligible.map((record) => record.vocabulary_hash));
  const cases = versions.length <= 1 && vocabularyHashes.length <= 1
    ? qualifiedCases(eligible, masterIds) : [];
  const instrumentTypes = strings(cases.map((candidate) => candidate.instrument_type));
  const gatePassed = cases.length >= THRESHOLDS.minimum_distinct_cases
    && instrumentTypes.length >= THRESHOLDS.minimum_instrument_types;
  const stable = canonicalValue({
    schema_version: 1,
    status: gatePassed ? "eligible_for_seat_review" : "not_evaluable",
    thresholds: THRESHOLDS,
    eligible_record_count: eligible.length,
    observation_hypothesis_count: observations.length,
    eligible_case_count: cases.length,
    instrument_type_count: instrumentTypes.length,
    vocabulary_version: versions.length === 1 ? versions[0] : null,
    vocabulary_hash: vocabularyHashes.length === 1 ? vocabularyHashes[0] : null,
    exclusion_reasons: [
      ...(versions.length > 1 ? ["mixed_vocabulary_versions"] : []),
      ...(vocabularyHashes.length > 1 ? ["mixed_vocabulary_hashes"] : []),
      ...(cases.length < THRESHOLDS.minimum_distinct_cases ? ["insufficient_distinct_cases"] : []),
      ...(instrumentTypes.length < THRESHOLDS.minimum_instrument_types ? ["insufficient_instrument_types"] : []),
    ],
    seat_decisions: masterIds.map((masterId) => seatReview(masterId, cases, gatePassed)),
    independence: {
      seat_count_is_independent_sample_count: false,
      n_eff: null,
      reason: "requires_preregistered_signed_resolved_outcome_ledger",
    },
  });
  return Object.freeze({ ...stable, evidence_evaluation_hash: sha256(stable) });
}
