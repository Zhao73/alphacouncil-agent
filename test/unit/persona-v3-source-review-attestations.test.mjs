import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  signSourceReviewAttestation,
  verifySourceReviewAttestation,
} from "../../mcp/lib/personas-v3/source-review-attestations.mjs";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY_ID = "reviewer:key-a";
const PRINCIPAL = "Reviewer A";

function unsigned(overrides = {}) {
  return {
    schema_version: 2,
    artifact_kind: "persona_v3_source_review_attestation",
    reviewer_id: PRINCIPAL,
    signer_key_id: KEY_ID,
    decision: "approve",
    content_hash: HASH_A,
    anchor_hash: HASH_B,
    reviewed_at: "2026-07-27T08:00:00.000Z",
    affirmations: {
      reviewed_raw_archive_bytes: true,
      verified_locator_against_raw_material: true,
      reviewer_is_human: true,
      review_was_independent: true,
    },
    notes: "Reviewed against the archived primary material.",
    ...overrides,
  };
}

function registry(overrides = {}) {
  return {
    [KEY_ID]: {
      public_key: publicKey,
      principal_id: PRINCIPAL,
      purposes: ["source_review"],
      ...overrides,
    },
  };
}

test("a trusted reviewer principal can sign and verify one exact source review", () => {
  const attestation = signSourceReviewAttestation(unsigned(), { privateKey, signerKeyId: KEY_ID });
  const result = verifySourceReviewAttestation(attestation, {
    trustedKeyRegistry: registry(),
    now: new Date("2026-07-27T09:00:00.000Z"),
  });
  assert.equal(result.valid, true);
  assert.equal(result.key_id, KEY_ID);
  assert.equal(result.principal_id, PRINCIPAL);
});

test("a bare reviewer id or an untrusted key cannot authorize a source", () => {
  const attestation = signSourceReviewAttestation(unsigned(), { privateKey, signerKeyId: KEY_ID });
  const result = verifySourceReviewAttestation(attestation, {
    trustedKeyRegistry: {},
    now: new Date("2026-07-27T09:00:00.000Z"),
  });
  assert.equal(result.valid, false);
  assert.equal(result.reason, "untrusted_signer");
});

test("content, anchor, reviewer and decision tampering invalidates the signature", () => {
  const attestation = signSourceReviewAttestation(unsigned(), { privateKey, signerKeyId: KEY_ID });
  for (const mutation of [
    { content_hash: HASH_B },
    { anchor_hash: HASH_A },
    { reviewer_id: "Reviewer B" },
    { decision: "reject" },
  ]) {
    const result = verifySourceReviewAttestation({ ...attestation, ...mutation }, {
      trustedKeyRegistry: registry(),
      now: new Date("2026-07-27T09:00:00.000Z"),
    });
    assert.equal(result.valid, false);
  }
});

test("two keys assigned to the same principal remain the same human identity", () => {
  const pair = generateKeyPairSync("ed25519");
  const otherKeyId = "reviewer:key-b";
  const attestation = signSourceReviewAttestation(unsigned({ signer_key_id: otherKeyId }), {
    privateKey: pair.privateKey,
    signerKeyId: otherKeyId,
  });
  const result = verifySourceReviewAttestation(attestation, {
    trustedKeyRegistry: {
      [otherKeyId]: {
        public_key: pair.publicKey,
        principal_id: PRINCIPAL,
        purposes: ["source_review"],
      },
    },
    now: new Date("2026-07-27T09:00:00.000Z"),
  });
  assert.equal(result.valid, true);
  assert.equal(result.principal_id, PRINCIPAL);
});

test("revoked, expired or wrong-purpose keys fail closed", () => {
  const attestation = signSourceReviewAttestation(unsigned(), { privateKey, signerKeyId: KEY_ID });
  for (const descriptor of [
    { revoked: true },
    { not_after: "2026-07-27T07:59:59.000Z" },
    { purposes: ["experiment"] },
  ]) {
    const result = verifySourceReviewAttestation(attestation, {
      trustedKeyRegistry: registry(descriptor),
      now: new Date("2026-07-27T09:00:00.000Z"),
    });
    assert.equal(result.valid, false);
  }
});
