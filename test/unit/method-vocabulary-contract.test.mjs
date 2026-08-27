import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { catalogSnapshot } from "../../mcp/lib/council-selection.mjs";
import { signCanonicalAttestation } from "../../mcp/lib/personas-v3/attestations.mjs";
import {
  METHOD_VOCABULARY_REVIEW_PURPOSE,
  evaluateMethodVocabularyStatement,
  methodVocabularyReviewPayload,
  validateMethodVocabularyContract,
} from "../../mcp/lib/method-vocabulary-contract.mjs";
import { repoFile } from "../helpers/paths.mjs";

const catalog = catalogSnapshot("English");
const reviewer = {
  principal_id: "Vocabulary Reviewer Fixture",
  key_id: "test.method-vocabulary-reviewer",
  ...generateKeyPairSync("ed25519"),
};
const trustedKeys = {
  [reviewer.key_id]: {
    public_key: reviewer.publicKey,
    principal_id: reviewer.principal_id,
    purposes: [METHOD_VOCABULARY_REVIEW_PURPOSE],
  },
};

function draftContract() {
  return {
    schema_version: 1,
    artifact_kind: "method_vocabulary_contract",
    vocabulary_version: "1.0.0-test",
    catalog_hash: catalog.catalog_hash,
    authored_at: "2026-08-26T00:00:00.000Z",
    seats: catalog.all_master_ids.map((masterId) => ({
      master_id: masterId,
      positive_markers: Array.from({ length: 8 }, (_, index) => `${masterId} positive marker ${index + 1}`),
    })),
    confusable_pairs: [{
      a: catalog.all_master_ids[0],
      b: catalog.all_master_ids[1],
      neighbor_conflict_markers: Array.from({ length: 4 }, (_, index) => `neighbor conflict marker ${index + 1}`),
    }],
    review: {
      status: "pending",
      reviewer_id: null,
      signer_key_id: null,
      reviewed_at: null,
      signature: null,
    },
  };
}

function signContract(contract) {
  const signed = structuredClone(contract);
  signed.review = {
    status: "approved",
    reviewer_id: reviewer.principal_id,
    signer_key_id: reviewer.key_id,
    reviewed_at: "2026-08-26T01:00:00.000Z",
    signature: null,
  };
  signed.review.signature = signCanonicalAttestation(methodVocabularyReviewPayload(signed), {
    privateKey: reviewer.privateKey,
    signerKeyId: reviewer.key_id,
  });
  return signed;
}

test("the repository vocabulary stays explicitly pending until a real trusted human signs it", () => {
  const repositoryDraft = JSON.parse(readFileSync(
    repoFile("data/method-vocabulary-contract.v1.draft.json"),
    "utf8",
  ));
  const result = validateMethodVocabularyContract(repositoryDraft, {
    trustedKeyRegistry: {},
    now: new Date("2026-08-26T12:00:00.000Z"),
  });
  assert.equal(result.valid, false);
  assert.equal(result.status, "not_evaluable");
  assert.equal(result.reason, "human_review_signature_required");
});

test("an unsigned contract is rejected while an exact trusted Ed25519 review is accepted", () => {
  const unsigned = validateMethodVocabularyContract(draftContract(), {
    trustedKeyRegistry: trustedKeys,
    now: new Date("2026-08-26T12:00:00.000Z"),
  });
  assert.equal(unsigned.valid, false);
  assert.equal(unsigned.reason, "human_review_signature_required");

  const contract = signContract(draftContract());
  const approved = validateMethodVocabularyContract(contract, {
    trustedKeyRegistry: trustedKeys,
    now: new Date("2026-08-26T12:00:00.000Z"),
  });
  assert.equal(approved.valid, true);
  assert.equal(approved.status, "approved");
  assert.equal(approved.vocabulary_version, contract.vocabulary_version);
  assert.match(approved.vocabulary_hash, /^sha256:[a-f0-9]{64}$/u);

  const tampered = structuredClone(contract);
  tampered.seats[0].positive_markers[0] = "changed after review";
  const rejected = validateMethodVocabularyContract(tampered, {
    trustedKeyRegistry: trustedKeys,
    now: new Date("2026-08-26T12:00:00.000Z"),
  });
  assert.equal(rejected.valid, false);
  assert.equal(rejected.reason, "invalid_human_review_signature");
});

test("contracts enforce eight positive markers per seat and four conflict markers per registered pair", () => {
  const weakSeat = draftContract();
  weakSeat.seats[0].positive_markers.pop();
  const weakSeatResult = validateMethodVocabularyContract(signContract(weakSeat), {
    trustedKeyRegistry: trustedKeys,
    now: new Date("2026-08-26T12:00:00.000Z"),
  });
  assert.equal(weakSeatResult.valid, false);
  assert.equal(weakSeatResult.reason, "vocabulary_marker_threshold_failed");

  const weakPair = draftContract();
  weakPair.confusable_pairs[0].neighbor_conflict_markers.pop();
  const weakPairResult = validateMethodVocabularyContract(signContract(weakPair), {
    trustedKeyRegistry: trustedKeys,
    now: new Date("2026-08-26T12:00:00.000Z"),
  });
  assert.equal(weakPairResult.valid, false);
  assert.equal(weakPairResult.reason, "vocabulary_marker_threshold_failed");
});

test("a characteristic statement needs three positive hits and no more conflict hits than positive hits", () => {
  const contract = signContract(draftContract());
  const masterId = contract.confusable_pairs[0].a;
  const positive = contract.seats.find((seat) => seat.master_id === masterId).positive_markers;
  const conflicts = contract.confusable_pairs[0].neighbor_conflict_markers;

  const characteristic = evaluateMethodVocabularyStatement(contract, {
    trustedKeyRegistry: trustedKeys,
    now: new Date("2026-08-26T12:00:00.000Z"),
    master_id: masterId,
    statement: [...positive.slice(0, 3), conflicts[0]].join(". "),
  });
  assert.equal(characteristic.status, "characteristic");
  assert.equal(characteristic.positive_hits, 3);
  assert.equal(characteristic.neighbor_conflict_hits, 1);

  const confused = evaluateMethodVocabularyStatement(contract, {
    trustedKeyRegistry: trustedKeys,
    now: new Date("2026-08-26T12:00:00.000Z"),
    master_id: masterId,
    statement: [positive[0], ...conflicts].join(". "),
  });
  assert.equal(confused.status, "not_characteristic");
  assert.equal(confused.positive_hits, 1);
  assert.equal(confused.neighbor_conflict_hits, 4);
});
