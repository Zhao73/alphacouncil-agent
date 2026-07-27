import { createHmac, timingSafeEqual } from "node:crypto";

import { canonicalJson, sha256 } from "./canonical.mjs";

const EPSILON = 1e-9;
const SYSTEM_MINIMUM_JOINT_CASES = 36;
const MINIMUM_BOOTSTRAP_REPLICATES = 200;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const HMAC_PATTERN = /^hmac-sha256:[a-f0-9]{64}$/;
const TOP_LEVEL_KEYS = new Set([
  "schema_version", "estimator_version", "preregistered_at", "evaluated_at",
  "metric", "scoring_rule", "matrix_kind", "resolved_outcomes", "case_unit",
  "horizon", "minimum_joint_cases", "cluster_keys", "bootstrap_cluster_key",
  "abstention_policy", "seat_ids", "weights", "shrinkage_alpha",
  "bootstrap_iterations", "bootstrap_seed", "maximum_ci_width",
  "prediction_ledger_hash", "outcome_ledger_hash", "prediction_ledger",
  "outcome_ledger", "attestation",
]);

function finiteArray(values) {
  return Array.isArray(values) && values.every((value) => Number.isFinite(value));
}

function validTime(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateCorrelationMatrix(matrix, size) {
  const errors = [];
  if (!Array.isArray(matrix) || matrix.length !== size) return [`correlation_matrix must have ${size} rows`];
  for (let i = 0; i < size; i += 1) {
    const row = matrix[i];
    if (!finiteArray(row) || row.length !== size) {
      errors.push(`correlation_matrix[${i}] must contain ${size} finite numbers`);
      continue;
    }
    if (Math.abs(row[i] - 1) > EPSILON) errors.push(`correlation_matrix[${i}][${i}] must equal 1`);
    for (let j = 0; j < size; j += 1) {
      if (row[j] < -1 - EPSILON || row[j] > 1 + EPSILON) errors.push(`correlation_matrix[${i}][${j}] must be within [-1, 1]`);
      if (matrix[j]?.[i] !== undefined && Math.abs(row[j] - matrix[j][i]) > EPSILON) {
        errors.push(`correlation_matrix must be symmetric at [${i},${j}]`);
      }
    }
  }
  if (errors.length) return [...new Set(errors)];

  const lower = Array.from({ length: size }, () => Array(size).fill(0));
  for (let i = 0; i < size; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let residual = matrix[i][j];
      for (let k = 0; k < j; k += 1) residual -= lower[i][k] * lower[j][k];
      if (i === j) {
        if (residual < -1e-7) return ["correlation_matrix is not positive semidefinite"];
        lower[i][j] = Math.sqrt(Math.max(0, residual));
      } else if (lower[j][j] > EPSILON) {
        lower[i][j] = residual / lower[j][j];
      } else if (Math.abs(residual) > 1e-7) {
        return ["correlation_matrix is not positive semidefinite"];
      }
    }
  }
  return [];
}

export function effectiveSampleSizeFromCorrelation(weights, correlationMatrix) {
  if (!finiteArray(weights) || !weights.length || weights.some((weight) => weight < 0)) {
    throw new Error("weights must be a non-empty array of non-negative finite numbers");
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) throw new Error("at least one weight must be positive");
  const errors = validateCorrelationMatrix(correlationMatrix, weights.length);
  if (errors.length) throw new Error(errors.join("; "));
  let denominator = 0;
  for (let i = 0; i < weights.length; i += 1) {
    for (let j = 0; j < weights.length; j += 1) denominator += weights[i] * correlationMatrix[i][j] * weights[j];
  }
  if (!(denominator > 0)) throw new Error("w^T C w must be positive");
  return (total ** 2) / denominator;
}

function percentile(sorted, probability) {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function unsignedArtifact(artifact) {
  const copy = { ...artifact };
  delete copy.attestation;
  return copy;
}

export function neffLedgerHash(records) {
  return sha256(records);
}

export function signNeffArtifact(artifact, { signerId, secret }) {
  if (typeof signerId !== "string" || !signerId.trim()) throw new Error("signerId is required");
  if (typeof secret !== "string" || !secret) throw new Error("signer secret is required");
  const payloadHash = sha256(unsignedArtifact(artifact));
  const digest = createHmac("sha256", secret)
    .update(canonicalJson({ signer_id: signerId, payload_hash: payloadHash }))
    .digest("hex");
  return {
    ...artifact,
    attestation: {
      signer_id: signerId,
      payload_hash: payloadHash,
      signature: `hmac-sha256:${digest}`,
    },
  };
}

function verifyAttestation(artifact, trustedSignerKeys) {
  const attestation = artifact.attestation;
  if (!attestation || typeof attestation !== "object" || Array.isArray(attestation)) {
    return "a trusted evaluator attestation is required";
  }
  if (typeof attestation.signer_id !== "string" || !attestation.signer_id.trim()) return "attestation.signer_id is required";
  const secret = trustedSignerKeys?.[attestation.signer_id];
  if (typeof secret !== "string" || !secret) return `attestation signer ${attestation.signer_id} is not trusted by this evaluator`;
  const payloadHash = sha256(unsignedArtifact(artifact));
  if (attestation.payload_hash !== payloadHash) return "attestation payload_hash does not bind the supplied artifact";
  if (!HMAC_PATTERN.test(attestation.signature || "")) return "attestation.signature must be an HMAC-SHA256 digest";
  const expected = createHmac("sha256", secret)
    .update(canonicalJson({ signer_id: attestation.signer_id, payload_hash: payloadHash }))
    .digest("hex");
  const actual = attestation.signature.slice("hmac-sha256:".length);
  if (!timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))) return "attestation signature is invalid";
  return null;
}

function validatePrediction(record, index, artifact, outcomeByCase, reasons) {
  const prefix = `prediction_ledger[${index}]`;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    reasons.push(`${prefix} must be an object`);
    return;
  }
  if (typeof record.case_id !== "string" || !record.case_id.trim()) reasons.push(`${prefix}.case_id is required`);
  if (!artifact.seat_ids.includes(record.seat_id)) reasons.push(`${prefix}.seat_id is not preregistered`);
  if (!(["scored", "abstain"].includes(record.status))) reasons.push(`${prefix}.status must be scored or abstain`);
  if (record.status === "scored" && !Number.isFinite(record.value)) reasons.push(`${prefix}.value must be finite when scored`);
  if (record.status === "abstain" && record.value !== null) reasons.push(`${prefix}.value must be null when abstaining`);
  const asOf = validTime(record.as_of);
  const predictedAt = validTime(record.prediction_at);
  const preregisteredAt = validTime(artifact.preregistered_at);
  if (asOf === null) reasons.push(`${prefix}.as_of must be a valid timestamp`);
  if (predictedAt === null) reasons.push(`${prefix}.prediction_at must be a valid timestamp`);
  if (asOf !== null && predictedAt !== null && asOf > predictedAt) reasons.push(`${prefix}.as_of must not follow prediction_at`);
  if (preregisteredAt !== null && predictedAt !== null && preregisteredAt >= predictedAt) reasons.push(`${prefix}.prediction_at must follow preregistered_at`);
  for (const field of ["pack_hash", "model_hash", "prompt_hash", "runner_hash", "case_manifest_hash"]) {
    if (!SHA256_PATTERN.test(record[field] || "")) reasons.push(`${prefix}.${field} must be a SHA-256 content hash`);
  }
  if (!record.clusters || typeof record.clusters !== "object" || Array.isArray(record.clusters)) {
    reasons.push(`${prefix}.clusters is required`);
  } else {
    for (const key of artifact.cluster_keys) {
      if (typeof record.clusters[key] !== "string" || !record.clusters[key].trim()) reasons.push(`${prefix}.clusters.${key} is required`);
    }
  }
  const outcome = outcomeByCase.get(record.case_id);
  const outcomePublicAt = validTime(outcome?.outcome_public_at);
  if (predictedAt !== null && outcomePublicAt !== null && predictedAt >= outcomePublicAt) {
    reasons.push(`${prefix}.prediction_at must precede outcome_public_at`);
  }
}

function validateOutcome(record, index, artifact, reasons) {
  const prefix = `outcome_ledger[${index}]`;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    reasons.push(`${prefix} must be an object`);
    return;
  }
  if (typeof record.case_id !== "string" || !record.case_id.trim()) reasons.push(`${prefix}.case_id is required`);
  if (!Number.isFinite(record.value)) reasons.push(`${prefix}.value must be finite`);
  const publicAt = validTime(record.outcome_public_at);
  const evaluatedAt = validTime(record.evaluated_at);
  const artifactEvaluatedAt = validTime(artifact.evaluated_at);
  if (publicAt === null) reasons.push(`${prefix}.outcome_public_at must be a valid timestamp`);
  if (evaluatedAt === null) reasons.push(`${prefix}.evaluated_at must be a valid timestamp`);
  if (publicAt !== null && evaluatedAt !== null && publicAt > evaluatedAt) reasons.push(`${prefix}.outcome_public_at must not follow evaluated_at`);
  if (evaluatedAt !== null && artifactEvaluatedAt !== null && evaluatedAt > artifactEvaluatedAt) reasons.push(`${prefix}.evaluated_at exceeds artifact evaluated_at`);
  if (!SHA256_PATTERN.test(record.source_hash || "")) reasons.push(`${prefix}.source_hash must be a SHA-256 content hash`);
}

function ledgerRows(artifact, reasons) {
  const outcomeByCase = new Map();
  for (const [index, outcome] of (artifact.outcome_ledger || []).entries()) {
    validateOutcome(outcome, index, artifact, reasons);
    if (outcomeByCase.has(outcome?.case_id)) reasons.push(`duplicate outcome case_id ${outcome.case_id}`);
    else outcomeByCase.set(outcome?.case_id, outcome);
  }
  const predictionByKey = new Map();
  const predictionsByCase = new Map();
  for (const [index, prediction] of (artifact.prediction_ledger || []).entries()) {
    validatePrediction(prediction, index, artifact, outcomeByCase, reasons);
    const key = `${prediction?.case_id}\u0000${prediction?.seat_id}`;
    if (predictionByKey.has(key)) reasons.push(`duplicate prediction for ${prediction?.case_id}/${prediction?.seat_id}`);
    else predictionByKey.set(key, prediction);
    if (!predictionsByCase.has(prediction?.case_id)) predictionsByCase.set(prediction?.case_id, new Map());
    predictionsByCase.get(prediction?.case_id).set(prediction?.seat_id, prediction);
  }

  const rows = [];
  for (const [caseId, outcome] of outcomeByCase) {
    const perSeat = predictionsByCase.get(caseId);
    if (!perSeat) continue;
    const records = artifact.seat_ids.map((seatId) => perSeat.get(seatId));
    if (records.some((record) => !record || record.status !== "scored")) continue;
    const firstClusters = records[0].clusters || {};
    for (const record of records.slice(1)) {
      for (const key of artifact.cluster_keys) {
        if (record.clusters?.[key] !== firstClusters[key]) reasons.push(`case ${caseId} has inconsistent cluster ${key} across seats`);
      }
    }
    rows.push({
      case_id: caseId,
      cluster: firstClusters[artifact.bootstrap_cluster_key],
      residuals: records.map((record) => record.value - outcome.value),
    });
  }
  return rows;
}

function pearsonCorrelation(rows, seatCount) {
  if (!rows.length) throw new Error("no jointly scorable rows");
  const means = Array(seatCount).fill(0);
  for (const row of rows) for (let index = 0; index < seatCount; index += 1) means[index] += row.residuals[index];
  for (let index = 0; index < seatCount; index += 1) means[index] /= rows.length;
  const covariance = Array.from({ length: seatCount }, () => Array(seatCount).fill(0));
  for (const row of rows) {
    for (let i = 0; i < seatCount; i += 1) {
      for (let j = 0; j < seatCount; j += 1) covariance[i][j] += (row.residuals[i] - means[i]) * (row.residuals[j] - means[j]);
    }
  }
  const scale = covariance.map((row, index) => Math.sqrt(row[index]));
  if (scale.some((value) => !(value > EPSILON))) throw new Error("at least one seat has zero residual variance");
  return covariance.map((row, i) => row.map((value, j) => value / (scale[i] * scale[j])));
}

function shrinkToIdentity(matrix, alpha) {
  return matrix.map((row, i) => row.map((value, j) => (i === j ? 1 : (1 - alpha) * value)));
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clusterBootstrap(rows, artifact) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.cluster)) groups.set(row.cluster, []);
    groups.get(row.cluster).push(row);
  }
  const clusterIds = [...groups.keys()].sort();
  if (clusterIds.length < 2) throw new Error("at least two bootstrap clusters are required");
  const random = seededRandom(artifact.bootstrap_seed);
  const estimates = [];
  for (let iteration = 0; iteration < artifact.bootstrap_iterations; iteration += 1) {
    const sampledRows = [];
    for (let draw = 0; draw < clusterIds.length; draw += 1) {
      const clusterId = clusterIds[Math.floor(random() * clusterIds.length)];
      sampledRows.push(...groups.get(clusterId));
    }
    try {
      const correlation = shrinkToIdentity(pearsonCorrelation(sampledRows, artifact.seat_ids.length), artifact.shrinkage_alpha);
      estimates.push(effectiveSampleSizeFromCorrelation(artifact.weights, correlation));
    } catch {
      // Degenerate bootstrap draws are counted by the validity gate below, not replaced by
      // a fabricated value.
    }
  }
  return estimates;
}

function insufficient(reasons, extra = {}) {
  return {
    status: "insufficient_data",
    n_eff: null,
    confidence_interval_95: null,
    reasons: [...new Set(reasons)],
    ...extra,
  };
}

/**
 * Recompute error N_eff from point-in-time ledgers. A submitted correlation matrix or a
 * submitted bootstrap vector is never accepted. Publication additionally requires a keyed
 * attestation from a signer trusted by the evaluator process; the artifact cannot trust its
 * own signer declaration.
 */
export function assessErrorNeff(artifact, { trustedSignerKeys = {} } = {}) {
  const reasons = [];
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return insufficient(["artifact must be an object"]);
  for (const key of Object.keys(artifact)) if (!TOP_LEVEL_KEYS.has(key)) reasons.push(`unexpected artifact field ${key}`);
  if (artifact.schema_version !== 1) reasons.push("schema_version must be 1");
  if (artifact.estimator_version !== "ledger-error-correlation-v1") reasons.push("estimator_version must be ledger-error-correlation-v1");
  if (validTime(artifact.preregistered_at) === null) reasons.push("a valid preregistered_at is required");
  if (validTime(artifact.evaluated_at) === null) reasons.push("a valid evaluated_at is required");
  if (validTime(artifact.preregistered_at) !== null && validTime(artifact.evaluated_at) !== null
    && validTime(artifact.preregistered_at) >= validTime(artifact.evaluated_at)) reasons.push("preregistered_at must precede evaluated_at");
  if (typeof artifact.metric !== "string" || !artifact.metric.trim()) reasons.push("a common metric is required");
  if (artifact.scoring_rule !== "signed_residual") reasons.push("scoring_rule must be signed_residual");
  if (artifact.matrix_kind !== "error_correlation") reasons.push("matrix_kind must be error_correlation; agreement is not error correlation");
  if (artifact.resolved_outcomes !== true) reasons.push("resolved_outcomes must be true");
  if (typeof artifact.case_unit !== "string" || !artifact.case_unit.trim()) reasons.push("case_unit is required");
  if (typeof artifact.horizon !== "string" || !artifact.horizon.trim()) reasons.push("horizon is required");
  if (!Number.isInteger(artifact.minimum_joint_cases) || artifact.minimum_joint_cases < SYSTEM_MINIMUM_JOINT_CASES) {
    reasons.push(`minimum_joint_cases must be preregistered at or above ${SYSTEM_MINIMUM_JOINT_CASES}`);
  }
  if (!Array.isArray(artifact.cluster_keys) || !artifact.cluster_keys.length
    || artifact.cluster_keys.some((key) => typeof key !== "string" || !key.trim())
    || new Set(artifact.cluster_keys).size !== artifact.cluster_keys.length) reasons.push("unique cluster_keys are required");
  if (!artifact.cluster_keys?.includes(artifact.bootstrap_cluster_key)) reasons.push("bootstrap_cluster_key must be one of cluster_keys");
  if (artifact.abstention_policy !== "joint_complete_only") reasons.push("abstention_policy must be joint_complete_only for this estimator");
  if (!Array.isArray(artifact.seat_ids) || artifact.seat_ids.length < 2
    || artifact.seat_ids.some((id) => typeof id !== "string" || !id.trim())
    || new Set(artifact.seat_ids).size !== artifact.seat_ids.length) reasons.push("at least two unique preregistered seat_ids are required");
  if (!finiteArray(artifact.weights) || artifact.weights.length !== artifact.seat_ids?.length
    || artifact.weights.some((weight) => weight < 0) || !artifact.weights.some((weight) => weight > 0)) {
    reasons.push("weights must align to seat_ids and contain at least one positive finite weight");
  }
  if (!Number.isFinite(artifact.shrinkage_alpha) || artifact.shrinkage_alpha < 0 || artifact.shrinkage_alpha > 1) reasons.push("shrinkage_alpha must be within [0, 1]");
  if (!Number.isInteger(artifact.bootstrap_iterations) || artifact.bootstrap_iterations < MINIMUM_BOOTSTRAP_REPLICATES) {
    reasons.push(`bootstrap_iterations must be at least ${MINIMUM_BOOTSTRAP_REPLICATES}`);
  }
  if (!Number.isInteger(artifact.bootstrap_seed) || artifact.bootstrap_seed < 0) reasons.push("bootstrap_seed must be a non-negative integer");
  if (!Number.isFinite(artifact.maximum_ci_width) || artifact.maximum_ci_width <= 0) reasons.push("maximum_ci_width must be positive");
  if (!Array.isArray(artifact.prediction_ledger)) reasons.push("prediction_ledger must be an array");
  if (!Array.isArray(artifact.outcome_ledger)) reasons.push("outcome_ledger must be an array");
  if (Array.isArray(artifact.prediction_ledger)
    && artifact.prediction_ledger_hash !== neffLedgerHash(artifact.prediction_ledger)) reasons.push("prediction_ledger_hash does not match prediction_ledger");
  if (Array.isArray(artifact.outcome_ledger)
    && artifact.outcome_ledger_hash !== neffLedgerHash(artifact.outcome_ledger)) reasons.push("outcome_ledger_hash does not match outcome_ledger");

  let rows = [];
  if (Array.isArray(artifact.prediction_ledger) && Array.isArray(artifact.outcome_ledger)
    && Array.isArray(artifact.seat_ids) && Array.isArray(artifact.cluster_keys)) {
    rows = ledgerRows(artifact, reasons);
  }
  if (rows.length < (artifact.minimum_joint_cases || Infinity)) {
    reasons.push(`resolved joint case count ${rows.length} is below the preregistered minimum ${artifact.minimum_joint_cases ?? "missing"}`);
  }
  const attestationError = verifyAttestation(artifact, trustedSignerKeys);
  if (attestationError) reasons.push(attestationError);
  if (reasons.length) return insufficient(reasons, {
    resolved_joint_n: rows.length,
    minimum_required_n: Number.isInteger(artifact.minimum_joint_cases) ? artifact.minimum_joint_cases : null,
    estimator_version: artifact.estimator_version || null,
  });

  let correlation;
  let point;
  let bootstrap;
  try {
    correlation = shrinkToIdentity(pearsonCorrelation(rows, artifact.seat_ids.length), artifact.shrinkage_alpha);
    point = effectiveSampleSizeFromCorrelation(artifact.weights, correlation);
    bootstrap = clusterBootstrap(rows, artifact);
  } catch (error) {
    return insufficient([error.message], {
      resolved_joint_n: rows.length,
      minimum_required_n: artifact.minimum_joint_cases,
      estimator_version: artifact.estimator_version,
    });
  }
  const minimumValidReplicates = Math.max(MINIMUM_BOOTSTRAP_REPLICATES, Math.ceil(artifact.bootstrap_iterations * 0.8));
  if (bootstrap.length < minimumValidReplicates) {
    return insufficient([`only ${bootstrap.length}/${artifact.bootstrap_iterations} bootstrap replicates were identifiable`], {
      resolved_joint_n: rows.length,
      minimum_required_n: artifact.minimum_joint_cases,
      estimator_version: artifact.estimator_version,
    });
  }
  const ordered = [...bootstrap].sort((a, b) => a - b);
  const interval = [percentile(ordered, 0.025), percentile(ordered, 0.975)];
  if (interval[1] - interval[0] > artifact.maximum_ci_width) {
    return insufficient([`bootstrap confidence interval width exceeds preregistered maximum ${artifact.maximum_ci_width}`], {
      resolved_joint_n: rows.length,
      minimum_required_n: artifact.minimum_joint_cases,
      estimator_version: artifact.estimator_version,
    });
  }
  return {
    status: "publishable",
    metric: artifact.metric,
    n_eff: point,
    confidence_interval_95: interval,
    resolved_joint_n: rows.length,
    minimum_required_n: artifact.minimum_joint_cases,
    estimator_version: artifact.estimator_version,
    seat_ids: [...artifact.seat_ids],
    correlation_matrix_hash: sha256(correlation),
    prediction_ledger_hash: artifact.prediction_ledger_hash,
    outcome_ledger_hash: artifact.outcome_ledger_hash,
    attested_by: artifact.attestation.signer_id,
    bootstrap_valid_replicates: bootstrap.length,
    reasons: [],
  };
}
