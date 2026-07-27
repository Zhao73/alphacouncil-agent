import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  signReleaseApproval,
  verifyReleaseApprovalDocument,
} from "../../mcp/lib/personas-v3/release-approvals.mjs";

const MANIFEST_HASH = `sha256:${"a".repeat(64)}`;
const header = {
  schema_version: 1,
  artifact_kind: "persona_v3_release_approval_bundle",
  operation: "cutover",
  release_id: "0.9.0-rc.1",
  release_manifest_hash: MANIFEST_HASH,
  previous_release_id: null,
};

function signer(keyId, principal) {
  const pair = generateKeyPairSync("ed25519");
  return { keyId, principal, ...pair };
}

function bundle(signers) {
  return {
    ...header,
    approvals: signers.map((entry, index) => signReleaseApproval(header, {
      reviewer_id: entry.principal,
      signer_key_id: entry.keyId,
      approved_at: `2026-07-27T0${index + 1}:00:00.000Z`,
    }, { privateKey: entry.privateKey, signerKeyId: entry.keyId })),
  };
}

function registry(signers) {
  return Object.fromEntries(signers.map((entry) => [entry.keyId, {
    public_key: entry.publicKey,
    principal_id: entry.principal,
    purposes: ["persona_release"],
  }]));
}

test("two independent trusted principals approve one exact release operation", () => {
  const signers = [signer("release:key-a", "Release Reviewer A"), signer("release:key-b", "Release Reviewer B")];
  const result = verifyReleaseApprovalDocument(bundle(signers), {
    trustedKeyRegistry: registry(signers),
    expectedReleaseId: header.release_id,
    expectedManifestHash: MANIFEST_HASH,
    expectedOperation: "cutover",
    expectedPreviousReleaseId: null,
    now: new Date("2026-07-27T03:00:00.000Z"),
  });
  assert.equal(result.valid, true);
  assert.equal(result.approver_key_ids.length, 2);
});

test("one principal with two keys is still only one reviewer", () => {
  const signers = [signer("release:key-a", "Same Reviewer"), signer("release:key-b", "Same Reviewer")];
  const result = verifyReleaseApprovalDocument(bundle(signers), {
    trustedKeyRegistry: registry(signers),
    now: new Date("2026-07-27T03:00:00.000Z"),
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "insufficient_independent_release_approvals");
});

test("release, manifest, operation and signature tampering fail closed", () => {
  const signers = [signer("release:key-a", "Reviewer A"), signer("release:key-b", "Reviewer B")];
  const original = bundle(signers);
  for (const changed of [
    { ...original, release_id: "0.9.0-rc.2" },
    { ...original, operation: "rollback" },
    { ...original, release_manifest_hash: `sha256:${"b".repeat(64)}` },
    { ...original, approvals: [{ ...original.approvals[0], reviewer_id: "Mallory" }, original.approvals[1]] },
  ]) {
    const result = verifyReleaseApprovalDocument(changed, {
      trustedKeyRegistry: registry(signers),
      now: new Date("2026-07-27T03:00:00.000Z"),
    });
    assert.equal(result.valid, false);
  }
});

test("untrusted, revoked and wrong-purpose release keys fail closed", () => {
  const signers = [signer("release:key-a", "Reviewer A"), signer("release:key-b", "Reviewer B")];
  const document = bundle(signers);
  for (const trusted of [
    {},
    { ...registry(signers), [signers[0].keyId]: { public_key: signers[0].publicKey, principal_id: signers[0].principal, revoked: true } },
    Object.fromEntries(signers.map((entry) => [entry.keyId, { public_key: entry.publicKey, principal_id: entry.principal, purposes: ["source_review"] }])),
  ]) {
    const result = verifyReleaseApprovalDocument(document, {
      trustedKeyRegistry: trusted,
      now: new Date("2026-07-27T03:00:00.000Z"),
    });
    assert.equal(result.valid, false);
  }
});
