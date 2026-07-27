import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import {
  RELEASE_EVIDENCE_CHECK_IDS,
  RELEASE_EVIDENCE_OPERATION_IDS,
  RELEASE_EVIDENCE_PURPOSE,
  signReleaseEvidenceAttestation,
  validateReleaseEvidenceDocument,
  verifyReleaseEvidenceDocument,
} from "../../mcp/lib/personas-v3/release-evidence.mjs";

const MANIFEST_HASH = `sha256:${"a".repeat(64)}`;
const GENERATED_AT = "2026-07-27T12:00:00.000Z";
const NOW = new Date("2026-07-27T13:00:00.000Z");

function signer(keyId, principal) {
  return { keyId, principal, ...generateKeyPairSync("ed25519") };
}

function header(status = "passed") {
  const binding = (name) => ({
    relative_path: `${name}.json`,
    file_hash: sha256({ name, kind: "file" }),
    artifact_hash: sha256({ name, kind: "artifact" }),
  });
  return {
    schema_version: 1,
    artifact_kind: "persona_v3_ga_release_evidence",
    release_id: "0.9.0-rc.1",
    release_manifest_hash: MANIFEST_HASH,
    release_source_review_evidence_hash: sha256("source-review-evidence"),
    expected_version: "0.9.0",
    generated_at: GENERATED_AT,
    artifacts: {
      external_hosts: ["claude_code", "codex", "opencode", "grok"].map((hostId) => ({
        host_id: hostId,
        ...binding(hostId),
      })),
      package: binding("package"),
      experiment_adjudication: binding("experiment-adjudication"),
      release_operations: {
        ...Object.fromEntries(RELEASE_EVIDENCE_OPERATION_IDS.map((operation) => [operation, {
          pointer_history: binding(`${operation}-pointer`),
          approval: binding(`${operation}-approval`),
          release_manifest: binding(`${operation}-manifest`),
          previous_release_manifest: binding(`${operation}-previous-manifest`),
        }])),
        current_pointer: binding("current-pointer"),
        activation_marker: binding("activation-marker"),
      },
    },
    claims: {
      experiment_adjudication: "passed",
      external_host_e2e: "passed",
      package: "passed",
      ...(status === "passed" ? {} : { unexpected_status: status }),
    },
  };
}

function document(signers, status = "passed") {
  const value = header(status);
  return {
    ...value,
    attestations: signers.map((entry, index) => signReleaseEvidenceAttestation(value, {
      reviewer_id: entry.principal,
      signer_key_id: entry.keyId,
      signed_at: new Date(Date.parse(GENERATED_AT) + (index + 1) * 1_000).toISOString(),
    }, { privateKey: entry.privateKey, signerKeyId: entry.keyId })),
  };
}

function registry(signers, purpose = RELEASE_EVIDENCE_PURPOSE) {
  return Object.fromEntries(signers.map((entry) => [entry.keyId, {
    public_key: entry.publicKey,
    principal_id: entry.principal,
    purposes: [purpose],
  }]));
}

test("two trusted independent principals attest the exact manifest-bound evidence", () => {
  const signers = [signer("ga:key-a", "GA Reviewer A"), signer("ga:key-b", "GA Reviewer B")];
  const result = verifyReleaseEvidenceDocument(document(signers), {
    trustedKeyRegistry: registry(signers),
    expectedReleaseId: "0.9.0-rc.1",
    expectedManifestHash: MANIFEST_HASH,
    now: NOW,
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.statuses, {
    experiment: "passed",
    host: "passed",
    package: "passed",
  });
  assert.deepEqual(result.approver_principal_ids, ["GA Reviewer A", "GA Reviewer B"]);
  assert.match(result.evidence_hash, /^sha256:[a-f0-9]{64}$/u);
});

test("one principal holding two keys cannot satisfy the independence requirement", () => {
  const signers = [signer("ga:key-a", "Same Reviewer"), signer("ga:key-b", "Same Reviewer")];
  const result = verifyReleaseEvidenceDocument(document(signers), {
    trustedKeyRegistry: registry(signers),
    now: NOW,
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "insufficient_independent_release_evidence_attestations");
});

test("manifest, status, evidence hash and reviewer tampering all fail closed", () => {
  const signers = [signer("ga:key-a", "Reviewer A"), signer("ga:key-b", "Reviewer B")];
  const original = document(signers);
  const mutations = [
    { ...original, release_manifest_hash: `sha256:${"b".repeat(64)}` },
    {
      ...original,
      artifacts: {
        ...original.artifacts,
        release_operations: {
          ...original.artifacts.release_operations,
          rollback: {
            ...original.artifacts.release_operations.rollback,
            approval: {
              ...original.artifacts.release_operations.rollback.approval,
              artifact_hash: sha256("different rollback approval"),
            },
          },
        },
      },
    },
    {
      ...original,
      artifacts: {
        ...original.artifacts,
        package: { ...original.artifacts.package, file_hash: sha256("tampered") },
      },
    },
    { ...original, attestations: [{ ...original.attestations[0], reviewer_id: "Mallory" }, original.attestations[1]] },
  ];
  for (const changed of mutations) {
    const result = verifyReleaseEvidenceDocument(changed, {
      trustedKeyRegistry: registry(signers),
      expectedManifestHash: MANIFEST_HASH,
      now: NOW,
    });
    assert.equal(result.valid, false);
  }
});

test("unsigned, untrusted, revoked and wrong-purpose evidence never counts", () => {
  const signers = [signer("ga:key-a", "Reviewer A"), signer("ga:key-b", "Reviewer B")];
  const signed = document(signers);
  const unsigned = { ...header(), attestations: [] };
  assert.ok(validateReleaseEvidenceDocument(unsigned, { now: NOW })
    .some((error) => /at least two/u.test(error)));
  for (const trusted of [
    {},
    {
      ...registry(signers),
      [signers[0].keyId]: {
        public_key: signers[0].publicKey,
        principal_id: signers[0].principal,
        purposes: [RELEASE_EVIDENCE_PURPOSE],
        revoked: true,
      },
    },
    registry(signers, "persona_release"),
  ]) {
    const result = verifyReleaseEvidenceDocument(signed, {
      trustedKeyRegistry: trusted,
      now: NOW,
    });
    assert.equal(result.valid, false);
  }
});

test("arbitrary standalone evidence_hash strings cannot satisfy the physical binding contract", () => {
  const legacy = {
    schema_version: 1,
    artifact_kind: "persona_v3_ga_release_evidence",
    release_id: "0.9.0-rc.1",
    release_manifest_hash: MANIFEST_HASH,
    generated_at: GENERATED_AT,
    checks: Object.fromEntries(["claude_code", "codex", "opencode", "grok", "package", "cutover", "rollback"]
      .map((id) => [id, { status: "passed", evidence_hash: sha256(id), completed_at: GENERATED_AT }])),
    attestations: [],
  };
  const errors = validateReleaseEvidenceDocument(legacy, { now: NOW });
  assert.ok(errors.some((error) => /artifacts is required/u.test(error)));
  assert.ok(errors.some((error) => /checks is not allowed/u.test(error)));
});

test("arbitrary cutover and rollback passed strings are rejected instead of counted", () => {
  const value = header();
  value.claims = { ...value.claims, cutover: "passed", rollback: "passed" };
  const errors = validateReleaseEvidenceDocument({ ...value, attestations: [] }, { now: NOW });
  assert.ok(errors.some((error) => /claims\.cutover is not allowed/u.test(error)));
  assert.ok(errors.some((error) => /claims\.rollback is not allowed/u.test(error)));
});

test("the published release evidence schema requires physical four-host/package/experiment bindings", () => {
  const schema = JSON.parse(readFileSync(
    new URL("../../schemas/persona-v3-release-evidence-v1.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.artifacts.properties.external_hosts.minItems, 4);
  assert.equal(schema.properties.artifacts.properties.external_hosts.maxItems, 4);
  assert.deepEqual(schema.properties.claims.required, RELEASE_EVIDENCE_CHECK_IDS);
  assert.deepEqual(
    schema.$defs.releaseOperations.required.slice(0, 3),
    RELEASE_EVIDENCE_OPERATION_IDS,
  );
  assert.equal(schema.properties.attestations.minItems, 2);
  assert.equal(schema.$defs.attestation.additionalProperties, false);
  assert.match(schema.$defs.attestation.properties.signature.pattern, /ed25519/u);
});
