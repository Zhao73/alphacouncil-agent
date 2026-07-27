import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  TRUSTED_EXPERIMENT_KEYS_ENV,
  TRUSTED_EXPERIMENT_SIGNERS_ENV,
  computeExperimentSignature,
  evaluateMethodModelExperiments,
  signExperimentEntry,
  validateExperimentDocument,
} from "../../mcp/lib/personas-v3/admission.mjs";

const SIGNER = "ci:release-key-v1";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const TRUSTED_KEYS = {
  [SIGNER]: { public_key: publicKey, purposes: ["persona_experiment"], principal_id: "release-ci" },
};
const EXPECTED_HASHES = Object.freeze({
  artifact_subject_hash: HASH_A,
  corpus_hash: HASH_A,
  policy_hash: HASH_A,
  tool_graph_hash: HASH_A,
  prompt_hash: HASH_A,
});

function entry(id = "source_fidelity", overrides = {}) {
  const value = {
    experiment_id: id,
    status: "passed",
    dataset_hash: HASH_A,
    case_ledger_hash: HASH_A,
    artifact_subject_hash: HASH_A,
    corpus_hash: HASH_A,
    policy_hash: HASH_A,
    tool_graph_hash: HASH_A,
    model_hash: HASH_A,
    prompt_hash: HASH_A,
    runner_hash: HASH_A,
    host_hash: HASH_A,
    thresholds: { support: { operator: ">=", value: 0.95, unit: "ratio" } },
    metrics: {
      support: { value: 0.98, unit: "ratio", sample_size: 48, threshold_id: "support", passed: true },
    },
    started_at: "2026-07-27T00:00:00.000Z",
    evaluated_at: "2026-07-27T01:00:00.000Z",
    signer_key_id: SIGNER,
    signature_algorithm: "ed25519",
    ...overrides,
  };
  value.signature = signExperimentEntry(value, { privateKey, signerKeyId: value.signer_key_id });
  return value;
}

function legacyEntry(id = "source_fidelity") {
  const value = {
    experiment_id: id,
    status: "passed",
    dataset_hash: HASH_A,
    case_ledger_hash: HASH_A,
    pack_hash: HASH_A,
    policy_hash: HASH_A,
    model_hash: HASH_A,
    prompt_hash: HASH_A,
    runner_hash: HASH_A,
    host_hash: HASH_A,
    thresholds: { support: { operator: ">=", value: 0.95, unit: "ratio" } },
    metrics: {
      support: { value: 0.98, unit: "ratio", sample_size: 48, threshold_id: "support", passed: true },
    },
    started_at: "2026-07-27T00:00:00.000Z",
    evaluated_at: "2026-07-27T01:00:00.000Z",
    signer_key_id: SIGNER,
  };
  value.signature = computeExperimentSignature(value);
  return value;
}

function document(experimentId, experiment) {
  return {
    schema_version: 1,
    persona_id: "master_test",
    experiments: { [experimentId]: experiment },
  };
}

function evaluate(experiment, options = {}) {
  return evaluateMethodModelExperiments(document(experiment.experiment_id, experiment), {
    personaId: "master_test",
    trustedSignerKeys: TRUSTED_KEYS,
    expectedArtifactHashes: EXPECTED_HASHES,
    ...options,
  });
}

test("an Ed25519 signature is accepted only with the matching trusted public key", () => {
  const experiment = entry();
  const untrusted = evaluateMethodModelExperiments(document("source_fidelity", experiment), {
    personaId: "master_test",
    expectedArtifactHashes: EXPECTED_HASHES,
  });
  assert.deepEqual(untrusted.passed, []);
  assert.deepEqual(untrusted.untrusted, ["source_fidelity"]);

  const trusted = evaluate(experiment);
  assert.deepEqual(trusted.passed, ["source_fidelity"]);
  assert.deepEqual(trusted.untrusted, []);
});

test("a bare trusted signer id and the old sha256 pseudo-signature never grant admission", () => {
  const experiment = legacyEntry();
  const result = evaluateMethodModelExperiments(document("source_fidelity", experiment), {
    personaId: "master_test",
    trustedSignerKeyIds: [SIGNER],
    expectedArtifactHashes: EXPECTED_HASHES,
  });
  assert.deepEqual(result.passed, []);
  assert.deepEqual(result.legacy_signature, ["source_fidelity"]);
  assert.deepEqual(result.invalid_signature, ["source_fidelity"]);
  assert.deepEqual(result.legacy_trusted_signer_ids_ignored, [SIGNER]);
});

test("changing signed provenance invalidates the Ed25519 attestation", () => {
  const experiment = entry();
  experiment.dataset_hash = HASH_B;
  const result = evaluate(experiment);
  assert.deepEqual(result.passed, []);
  assert.deepEqual(result.invalid_signature, ["source_fidelity"]);
  assert.equal(result.verification_errors.source_fidelity, "invalid_signature");
});

test("a valid signature bound to another artifact cannot be replayed", () => {
  const experiment = entry("policy_adherence", { policy_hash: HASH_B });
  const result = evaluate(experiment);
  assert.deepEqual(result.passed, []);
  assert.deepEqual(result.binding_mismatch, ["policy_adherence"]);
  assert.deepEqual(result.binding_errors.policy_adherence.map(({ field }) => field), ["policy_hash"]);
});

test("a cryptographically valid but unbound experiment fails closed", () => {
  const experiment = entry("host_parity");
  const result = evaluateMethodModelExperiments(document("host_parity", experiment), {
    personaId: "master_test",
    trustedSignerKeys: TRUSTED_KEYS,
  });
  assert.deepEqual(result.passed, []);
  assert.deepEqual(result.unbound, ["host_parity"]);
});

test("empty thresholds, metrics, hashes or timestamps are structurally invalid", () => {
  const experiment = entry("policy_adherence", {
    dataset_hash: "",
    thresholds: {},
    metrics: {},
    started_at: "not-a-time",
  });
  const result = evaluate(experiment);
  assert.deepEqual(result.invalid, ["policy_adherence"]);
  assert.equal(result.passed.length, 0);
  assert.ok(result.error_details.policy_adherence.some((error) => /dataset_hash/.test(error)));
  assert.ok(result.error_details.policy_adherence.some((error) => /thresholds/.test(error)));
  assert.ok(result.error_details.policy_adherence.some((error) => /metrics/.test(error)));
});

test("the key registry environment accepts public keys while the legacy signer-id environment grants no trust", () => {
  const previousKeys = process.env[TRUSTED_EXPERIMENT_KEYS_ENV];
  const previousIds = process.env[TRUSTED_EXPERIMENT_SIGNERS_ENV];
  const experiment = entry("host_parity");
  try {
    delete process.env[TRUSTED_EXPERIMENT_KEYS_ENV];
    process.env[TRUSTED_EXPERIMENT_SIGNERS_ENV] = SIGNER;
    const idOnly = evaluateMethodModelExperiments(document("host_parity", experiment), {
      personaId: "master_test",
      expectedArtifactHashes: EXPECTED_HASHES,
    });
    assert.deepEqual(idOnly.passed, []);
    assert.deepEqual(idOnly.untrusted, ["host_parity"]);

    process.env[TRUSTED_EXPERIMENT_KEYS_ENV] = JSON.stringify({
      [SIGNER]: {
        public_key: publicKey.export({ type: "spki", format: "pem" }),
        purposes: ["persona_experiment"],
      },
    });
    const trusted = evaluateMethodModelExperiments(document("host_parity", experiment), {
      personaId: "master_test",
      expectedArtifactHashes: EXPECTED_HASHES,
    });
    assert.deepEqual(trusted.passed, ["host_parity"]);
  } finally {
    if (previousKeys === undefined) delete process.env[TRUSTED_EXPERIMENT_KEYS_ENV];
    else process.env[TRUSTED_EXPERIMENT_KEYS_ENV] = previousKeys;
    if (previousIds === undefined) delete process.env[TRUSTED_EXPERIMENT_SIGNERS_ENV];
    else process.env[TRUSTED_EXPERIMENT_SIGNERS_ENV] = previousIds;
  }
});

test("the experiment map key, embedded id and pack persona must agree", () => {
  const mismatchedId = entry("source_fidelity", { experiment_id: "policy_adherence" });
  const wrongPersona = document("source_fidelity", mismatchedId);
  wrongPersona.persona_id = "master_other";
  const errors = validateExperimentDocument(wrongPersona, { personaId: "master_test" });
  assert.ok(errors.some((error) => /persona_id does not match/.test(error)));
  assert.ok(errors.some((error) => /experiment_id must equal/.test(error)));
  const result = evaluateMethodModelExperiments(wrongPersona, {
    personaId: "master_test",
    trustedSignerKeys: TRUSTED_KEYS,
    expectedArtifactHashes: EXPECTED_HASHES,
  });
  assert.deepEqual(result.passed, []);
  assert.deepEqual(result.invalid, ["source_fidelity"]);
});
