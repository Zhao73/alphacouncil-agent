import assert from "node:assert/strict";
import test from "node:test";

import {
  METHOD_SEAT_STATUSES,
  classifyMethodSeatEvidence,
  evaluateMethodSeatPortfolio,
} from "../../mcp/lib/method-seat-evidence.mjs";

const masterIds = ["master_alpha", "master_beta"];

function record(caseNo, repeatNo, instrumentType) {
  return {
    case_id: `case-${caseNo}`,
    repeat_id: `repeat-${repeatNo}`,
    exact_input_hash: `sha256:${String(caseNo).padStart(64, "0")}`,
    instrument_type: instrumentType,
    evidence_classification: {
      eligibility: "decision_evidence",
      reasons: [],
    },
    vocabulary_version: "1.0.0",
    vocabulary_hash: `sha256:${"a".repeat(64)}`,
    seats: masterIds.map((masterId, index) => ({
      master_id: masterId,
      outcome_hash: `sha256:${String(caseNo * 10 + index).padStart(64, "0")}`,
    })),
  };
}

test("the dirty v1.3 AAPL bundle is observation_hypothesis only and cannot enter seat decisions", () => {
  const oldAapl = classifyMethodSeatEvidence({
    artifact_version: "1.3.0",
    required_artifact_version: "1.5.0",
    git_dirty: true,
    seat_count: 26,
    seat_contract_valid_count: 0,
    source_label: "AAPL-20260808T073648Z",
  });
  assert.equal(oldAapl.eligibility, "observation_hypothesis");
  assert.ok(oldAapl.reasons.includes("artifact_version_mismatch"));
  assert.ok(oldAapl.reasons.includes("dirty_worktree"));
  assert.ok(oldAapl.reasons.includes("seat_contract_invalid"));

  const result = evaluateMethodSeatPortfolio([{
    ...record(1, 1, "equity"),
    evidence_classification: oldAapl,
  }], { catalog_master_ids: masterIds });
  assert.equal(result.status, "not_evaluable");
  assert.equal(result.eligible_record_count, 0);
  assert.equal(result.observation_hypothesis_count, 1);
  assert.ok(result.seat_decisions.every((seat) => seat.status === "observe"));
});

test("fewer than three identical repeats, six cases, or three instrument types stays not_evaluable", () => {
  const records = [];
  for (let caseNo = 1; caseNo <= 5; caseNo += 1) {
    const instrumentType = caseNo % 2 ? "equity" : "etf";
    records.push(record(caseNo, 1, instrumentType), record(caseNo, 2, instrumentType));
  }
  const result = evaluateMethodSeatPortfolio(records, { catalog_master_ids: masterIds });
  assert.equal(result.status, "not_evaluable");
  assert.deepEqual(result.thresholds, {
    minimum_hash_identical_repeats_per_case: 3,
    minimum_distinct_cases: 6,
    minimum_instrument_types: 3,
  });
  assert.ok(result.seat_decisions.every((seat) => seat.status === "observe"));
});

test("the preregistered 3 x 6 x 3 boundary becomes reviewable without inventing merge or delete states", () => {
  const records = [];
  const instrumentTypes = ["equity", "etf", "option"];
  for (let caseNo = 1; caseNo <= 6; caseNo += 1) {
    const instrumentType = instrumentTypes[(caseNo - 1) % instrumentTypes.length];
    for (let repeatNo = 1; repeatNo <= 3; repeatNo += 1) {
      records.push(record(caseNo, repeatNo, instrumentType));
    }
  }
  const result = evaluateMethodSeatPortfolio(records, { catalog_master_ids: masterIds });
  assert.equal(result.status, "eligible_for_seat_review");
  assert.equal(result.eligible_case_count, 6);
  assert.equal(result.instrument_type_count, 3);
  assert.deepEqual([...METHOD_SEAT_STATUSES].sort(), ["active", "conditional", "observe"]);
  assert.ok(result.seat_decisions.every((seat) => METHOD_SEAT_STATUSES.includes(seat.status)));
  assert.ok(result.seat_decisions.every((seat) => !["merged", "deleted"].includes(seat.status)));
});

