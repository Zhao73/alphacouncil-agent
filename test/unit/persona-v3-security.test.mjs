import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  normalizeTrustedKeyRegistry,
  signCanonicalAttestation,
  verifyCanonicalAttestation,
} from "../../mcp/lib/personas-v3/attestations.mjs";
import { computePersonaArtifactHashes } from "../../mcp/lib/personas-v3/canonical.mjs";

function artifact(overrides = {}) {
  return {
    manifest: {
      schema_version: 3,
      pack_version: "0.9.0",
      identity: {
        persona_id: "master_test",
        source_cutoff: "2026-07-27",
        maturity: "operator_lens",
        public_label: { en: "Test", zh: "测试" },
      },
      capability: { required_fact_types: ["metric"], optional_fact_types: [] },
      research: { planner: "test" },
      computation: { dsl_version: "1.1", pipeline: ["tool_1"] },
      decision: { abstention_policy: "fail_closed" },
      memory: { leak_rule: "public_at <= as_of AND memory_created_at <= as_of" },
      evaluation: { required_ablations: ["name", "voice", "policy", "evidence", "memory", "model"] },
      voice: { load_after_decision_freeze: true },
      admission: { propositions: 999 },
      release: { release_id: "rc-1" },
    },
    components: {
      sources: [{ source_id: "s1" }],
      doctrine: [{ rule_id: "r1" }],
      decision_cases: [{ case_id: "d1" }],
      failures: [{ case_id: "f1" }],
      counterfactuals: [{ case_id: "c1" }],
      research_policy: { queries: ["q1"] },
      decision_policy: { hard_vetoes: ["v1"] },
      tools: [{ id: "tool_1" }],
      memory_policy: { enabled: true },
      golden_cases: [{ case_id: "g1" }],
      pairwise_cases: [{ case_id: "p1" }],
      calibration_cases: [{ case_id: "cal1" }],
      experiments: { schema_version: 1, persona_id: "master_test", experiments: {} },
    },
    voice: { en: "Neutral voice.", zh: "中性表达。" },
    ...overrides,
  };
}

test("artifact_subject_hash excludes experiment and release/admission metadata without excluding executable content", () => {
  const base = artifact();
  const first = computePersonaArtifactHashes(base);
  const experimentChanged = structuredClone(base);
  experimentChanged.components.experiments.experiments.source_fidelity = { status: "passed" };
  experimentChanged.manifest.release.release_id = "rc-2";
  experimentChanged.manifest.admission.propositions = 0;
  experimentChanged.manifest.identity.maturity = "method_model";
  experimentChanged.manifest.identity.public_label.en = "Renamed";
  const second = computePersonaArtifactHashes(experimentChanged);
  assert.equal(first.artifact_subject_hash, second.artifact_subject_hash);
  assert.notEqual(first.component_hashes.experiments, second.component_hashes.experiments);

  const policyChanged = structuredClone(base);
  policyChanged.components.decision_policy.hard_vetoes.push("v2");
  assert.notEqual(
    first.artifact_subject_hash,
    computePersonaArtifactHashes(policyChanged).artifact_subject_hash,
  );

  const voiceChanged = structuredClone(base);
  voiceChanged.voice.en = "Different voice.";
  assert.notEqual(
    first.artifact_subject_hash,
    computePersonaArtifactHashes(voiceChanged).artifact_subject_hash,
  );
});

test("the same signer id cannot verify without the corresponding Ed25519 private key", () => {
  const signerKeyId = "ci:security-test";
  const first = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  const payload = { signer_key_id: signerKeyId, artifact_subject_hash: `sha256:${"a".repeat(64)}` };
  const registry = { [signerKeyId]: { public_key: first.publicKey, purposes: ["persona_experiment"] } };
  const forged = signCanonicalAttestation(payload, {
    privateKey: attacker.privateKey,
    signerKeyId,
  });
  const result = verifyCanonicalAttestation(payload, {
    signature: forged,
    signerKeyId,
    trustedKeyRegistry: registry,
    purpose: "persona_experiment",
  });
  assert.deepEqual(result, { valid: false, reason: "invalid_signature" });
});

test("trusted key policy enforces revocation, purpose and NFKC-normalized principal identity", () => {
  const signerKeyId = "review:key-1";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = { signer_key_id: signerKeyId, review_id: "r1" };
  const signature = signCanonicalAttestation(payload, { privateKey, signerKeyId });
  const registry = normalizeTrustedKeyRegistry({
    [signerKeyId]: {
      public_key: publicKey,
      purposes: ["source_review"],
      subject_id: "  Ｒｅｖｉｅｗｅｒ－１  ",
    },
  });
  const allowed = verifyCanonicalAttestation(payload, {
    signature,
    signerKeyId,
    trustedKeyRegistry: registry,
    purpose: "source_review",
  });
  assert.equal(allowed.valid, true);
  assert.equal(allowed.principal_id, "Reviewer-1");

  const wrongPurpose = verifyCanonicalAttestation(payload, {
    signature,
    signerKeyId,
    trustedKeyRegistry: registry,
    purpose: "persona_experiment",
  });
  assert.equal(wrongPurpose.reason, "unauthorized_purpose");

  const revoked = verifyCanonicalAttestation(payload, {
    signature,
    signerKeyId,
    trustedKeyRegistry: {
      [signerKeyId]: { public_key: publicKey, revoked: true },
    },
  });
  assert.equal(revoked.reason, "revoked_signer");
});

test("a trusted public-key registry rejects private key material and misspelled policy fields", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  assert.throws(
    () => normalizeTrustedKeyRegistry({
      "ci:private-leak": privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
    /public keys must be public/,
  );
  assert.throws(
    () => normalizeTrustedKeyRegistry({
      "ci:typo": { public_key: publicKey, revokd: true },
    }),
    /unknown fields: revokd/,
  );
});
