import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessErrorNeff,
  effectiveSampleSizeFromCorrelation,
  neffLedgerHash,
  signNeffArtifact,
} from "../../mcp/lib/personas-v3/n-eff.mjs";

const identity = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const allOne = Array.from({ length: 4 }, () => Array(4).fill(1));
const signerId = "independent-eval";
const signerSecret = "test-only-secret-kept-outside-the-artifact";
const trustedSignerKeys = { [signerId]: signerSecret };
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const seatIds = ["seat_a", "seat_b", "seat_c", "seat_d"];

function ledgers(caseCount = 48) {
  const predictionLedger = [];
  const outcomeLedger = [];
  for (let index = 0; index < caseCount; index += 1) {
    const caseId = `case_${String(index).padStart(3, "0")}`;
    outcomeLedger.push({
      case_id: caseId,
      value: 0,
      outcome_public_at: "2025-02-01T00:00:00.000Z",
      evaluated_at: "2025-02-02T00:00:00.000Z",
      source_hash: digest("f"),
    });
    for (let seat = 0; seat < seatIds.length; seat += 1) {
      predictionLedger.push({
        case_id: caseId,
        seat_id: seatIds[seat],
        status: "scored",
        // Repeated orthogonal binary patterns yield a full-rank common-error matrix.
        value: ((index >> seat) & 1) ? 1 : -1,
        as_of: "2025-01-01T12:00:00.000Z",
        prediction_at: "2025-01-02T00:00:00.000Z",
        pack_hash: digest("a"),
        model_hash: digest("b"),
        prompt_hash: digest("c"),
        runner_hash: digest("d"),
        case_manifest_hash: digest("e"),
        clusters: {
          issuer: `issuer_${Math.floor(index / 4)}`,
          event: `event_${index}`,
          regime: `regime_${index % 3}`,
        },
      });
    }
  }
  return { predictionLedger, outcomeLedger };
}

function artifact(overrides = {}, caseCount = 48) {
  const { predictionLedger, outcomeLedger } = ledgers(caseCount);
  const base = {
    schema_version: 1,
    estimator_version: "ledger-error-correlation-v1",
    preregistered_at: "2025-01-01T00:00:00.000Z",
    evaluated_at: "2025-02-03T00:00:00.000Z",
    metric: "common_projection_error",
    scoring_rule: "signed_residual",
    matrix_kind: "error_correlation",
    resolved_outcomes: true,
    case_unit: "issuer-date-event",
    horizon: "30d",
    minimum_joint_cases: 36,
    cluster_keys: ["issuer", "event", "regime"],
    bootstrap_cluster_key: "issuer",
    abstention_policy: "joint_complete_only",
    seat_ids: seatIds,
    weights: [1, 1, 1, 1],
    shrinkage_alpha: 0.1,
    bootstrap_iterations: 240,
    bootstrap_seed: 73,
    maximum_ci_width: 10,
    prediction_ledger: predictionLedger,
    outcome_ledger: outcomeLedger,
    ...overrides,
  };
  base.prediction_ledger_hash = neffLedgerHash(base.prediction_ledger);
  base.outcome_ledger_hash = neffLedgerHash(base.outcome_ledger);
  return signNeffArtifact(base, { signerId, secret: signerSecret });
}

test("the formula distinguishes independent and perfectly correlated seats", () => {
  assert.equal(effectiveSampleSizeFromCorrelation([1, 1, 1, 1], identity), 4);
  assert.equal(effectiveSampleSizeFromCorrelation([1, 1, 1, 1], allOne), 1);
});

test("agreement matrices and caller-supplied correlations cannot self-certify N_eff", () => {
  const agreement = assessErrorNeff(artifact({ matrix_kind: "agreement" }), { trustedSignerKeys });
  assert.equal(agreement.n_eff, null);
  assert.ok(agreement.reasons.some((reason) => /agreement is not error correlation/.test(reason)));

  const injected = assessErrorNeff(artifact({ correlation_matrix: identity }), { trustedSignerKeys });
  assert.equal(injected.n_eff, null);
  assert.ok(injected.reasons.some((reason) => /unexpected artifact field correlation_matrix/.test(reason)));
});

test("too few jointly resolved cases returns null with a derived count", () => {
  const result = assessErrorNeff(artifact({}, 20), { trustedSignerKeys });
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.n_eff, null);
  assert.equal(result.resolved_joint_n, 20);
  assert.ok(result.reasons.some((reason) => /below the preregistered minimum/.test(reason)));
});

test("an artifact cannot trust its own signer declaration", () => {
  const result = assessErrorNeff(artifact());
  assert.equal(result.n_eff, null);
  assert.ok(result.reasons.some((reason) => /is not trusted by this evaluator/.test(reason)));
});

test("future-dated preregistration fails the prediction ordering gate", () => {
  const result = assessErrorNeff(artifact({ preregistered_at: "2999-01-01T00:00:00.000Z" }), { trustedSignerKeys });
  assert.equal(result.n_eff, null);
  assert.ok(result.reasons.some((reason) => /prediction_at must follow preregistered_at/.test(reason)));
});

test("changing a prediction after attestation invalidates both ledger and signature bindings", () => {
  const signed = artifact();
  signed.prediction_ledger[0].value = 999;
  const result = assessErrorNeff(signed, { trustedSignerKeys });
  assert.equal(result.n_eff, null);
  assert.ok(result.reasons.some((reason) => /prediction_ledger_hash does not match/.test(reason)));
  assert.ok(result.reasons.some((reason) => /payload_hash does not bind/.test(reason)));
});

test("a complete attested ledger is recomputed and publishes a bounded interval", () => {
  const result = assessErrorNeff(artifact(), { trustedSignerKeys });
  assert.equal(result.status, "publishable");
  assert.ok(result.n_eff >= 1 && result.n_eff <= 4);
  assert.equal(result.confidence_interval_95.length, 2);
  assert.ok(result.confidence_interval_95[0] <= result.n_eff || result.confidence_interval_95[0] <= result.confidence_interval_95[1]);
  assert.equal(result.resolved_joint_n, 48);
  assert.equal(result.attested_by, signerId);
  assert.match(result.correlation_matrix_hash, /^sha256:[a-f0-9]{64}$/);
});
