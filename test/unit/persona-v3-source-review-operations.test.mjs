import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { signSourceReviewAttestation, verifySourceReviewAttestation } from "../../mcp/lib/personas-v3/source-review-attestations.mjs";
import { runSourceAcquisition } from "../../mcp/lib/personas-v3/source-acquisition.mjs";
import { prepareSourceAdjudication, reviewSourceAdjudication } from "../../mcp/lib/personas-v3/source-adjudication.mjs";
import { buildSourceReviewBatch, trustedSourceReviewQuorum } from "../../mcp/lib/personas-v3/source-review-operations.mjs";
import { runOfflineSourceReviewSigning } from "../../mcp/lib/personas-v3/source-review-signing.mjs";
import { scaffoldPersonaV3Staging } from "../../mcp/lib/personas-v3/staging.mjs";
import { parseArgs as parseBatchArgs } from "../../scripts/export-persona-source-review-batch.mjs";
import { parseArgs as parseSigningArgs } from "../../scripts/sign-persona-source-review.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

const PERSONA = "master_buffett";
const CANDIDATE = "buffett-letter-2024";
const SOURCE_ID = "buffett:letter:2024";
const CONTENT = Buffer.from("archived bytes inspected by a real human reviewer");
const ACQUIRED_AT = new Date("2026-07-27T06:00:00.000Z");
const NOW = new Date("2026-07-27T10:00:00.000Z");

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-review-operations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "staging");
  const productionRoot = join(dir, "production");
  mkdirSync(productionRoot);
  scaffoldPersonaV3Staging({ root, productionRoot });
  return { dir, root, productionRoot };
}

function retrieve(url) {
  return Promise.resolve({
    requested_url: url,
    final_url: url,
    redirect_chain: [url],
    network_trace: [{ url, hostname: new URL(url).hostname, address: "93.184.216.34", family: 4 }],
    http_status: 200,
    content_type: "text/plain",
    content_encoding: null,
    bytes: Buffer.from(CONTENT),
  });
}

async function acquire(paths) {
  return runSourceAcquisition({
    write: true,
    root: paths.root,
    productionRoot: paths.productionRoot,
    personaId: PERSONA,
    candidateId: CANDIDATE,
    url: "https://example.test/buffett-letter-2024",
    retrieve,
    now: ACQUIRED_AT,
  });
}

function proposal() {
  return {
    schema_version: 1,
    artifact_kind: "persona_v3_source_anchor_proposal",
    persona_id: PERSONA,
    candidate_id: CANDIDATE,
    source_id: SOURCE_ID,
    source_kind: "primary_text",
    grade: "A",
    author: "Warren E. Buffett",
    title: "2024 shareholder letter",
    url: "https://example.test/buffett-letter-2024",
    published_at: "2024-02-24",
    public_at: "2024-02-24",
    known_at: "2024-02-24",
    locator: { section: "Berkshire's goal" },
    summary: "The exact section supports the capital-allocation rule under review.",
    supports: ["doctrine:capital-allocation"],
  };
}

function reviewer(name, keyId) {
  const pair = generateKeyPairSync("ed25519");
  return { name, keyId, ...pair };
}

function registry(reviewers) {
  return Object.fromEntries(reviewers.map((item) => [item.keyId, {
    public_key: item.publicKey.export({ type: "spki", format: "pem" }),
    principal_id: item.name,
    purposes: ["source_review"],
  }]));
}

function unsigned(prepared, reviewerRecord, overrides = {}) {
  return {
    schema_version: 2,
    artifact_kind: "persona_v3_source_review_attestation",
    reviewer_id: reviewerRecord.name,
    signer_key_id: reviewerRecord.keyId,
    decision: "approve",
    content_hash: prepared.content_hash,
    anchor_hash: prepared.anchor_hash,
    reviewed_at: "2026-07-27T08:00:00.000Z",
    affirmations: {
      reviewed_raw_archive_bytes: true,
      verified_locator_against_raw_material: true,
      reviewer_is_human: true,
      review_was_independent: true,
    },
    notes: "I inspected the archived bytes and exact locator independently.",
    ...overrides,
  };
}

function signed(prepared, reviewerRecord, overrides = {}) {
  return signSourceReviewAttestation(unsigned(prepared, reviewerRecord, overrides), {
    privateKey: reviewerRecord.privateKey,
    signerKeyId: reviewerRecord.keyId,
  });
}

test("review batch covers every canonical seat and exposes human-only proposal work without fabricating hashes", async (t) => {
  const paths = workspace(t);
  await acquire(paths);
  const batch = buildSourceReviewBatch({ ...paths, now: NOW, trustedReviewerKeys: {} });
  assert.equal(batch.canonical_master_count, CANONICAL_MASTER_COUNT);
  assert.equal(batch.personas.length, CANONICAL_MASTER_COUNT);
  assert.equal(batch.progress.raw_acquisition_count, 1);
  assert.equal(batch.progress.proposal_pending_count, 1);
  assert.equal(batch.progress.prepared_source_count, 0);
  assert.equal(batch.progress.trusted_quorum_source_count, 0);
  assert.equal(batch.progress.production_write_count, 0);
  const item = batch.personas.find((seat) => seat.persona_id === PERSONA).candidates[0];
  assert.equal(item.raw_acquisition.content_hash, (await acquire(paths)).record.content_hash);
  assert.equal(item.proposal_template.locator.section, "REPLACE");
  assert.equal(item.exact_locator_pending, true);
  assert.equal(item.anchor_hash, null);
  assert.equal(item.unsigned_review_template, null);
});
test("global progress accepts only two valid approvals from distinct trusted principals and keys", async (t) => {
  const paths = workspace(t);
  await acquire(paths);
  const prepared = await prepareSourceAdjudication({
    write: true, ...paths, personaId: PERSONA, candidateId: CANDIDATE, proposal: proposal(), now: NOW,
  });
  const first = reviewer("Reviewer A", "reviewer:key-a");
  const second = reviewer("Reviewer B", "reviewer:key-b");
  const trusted = registry([first, second]);
  await reviewSourceAdjudication({
    write: true, ...paths, personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: signed(prepared, first), trustedReviewerKeys: trusted, now: NOW,
  });
  let batch = buildSourceReviewBatch({ ...paths, trustedReviewerKeys: trusted, now: NOW });
  let item = batch.personas.find((seat) => seat.persona_id === PERSONA).candidates[0];
  assert.equal(item.trusted_quorum.satisfied, false);
  assert.equal(item.trusted_quorum.distinct_approver_principal_count, 1);
  await reviewSourceAdjudication({
    write: true, ...paths, personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: signed(prepared, second, { reviewed_at: "2026-07-27T09:00:00.000Z" }),
    trustedReviewerKeys: trusted,
    now: NOW,
  });
  batch = buildSourceReviewBatch({ ...paths, trustedReviewerKeys: trusted, now: NOW });
  item = batch.personas.find((seat) => seat.persona_id === PERSONA).candidates[0];
  assert.equal(item.trusted_quorum.satisfied, true);
  assert.equal(item.trusted_quorum.distinct_approver_principal_count, 2);
  assert.equal(item.trusted_quorum.distinct_approver_key_count, 2);
  assert.equal(batch.progress.trusted_quorum_source_count, 1);
  assert.equal(batch.progress.all_seats_have_a_two_principal_quorum_source, false);
});

test("two trusted keys bound to one principal never satisfy quorum", () => {
  const first = reviewer("Same Human", "reviewer:key-one");
  const second = reviewer("Same Human", "reviewer:key-two");
  const prepared = { content_hash: `sha256:${"a".repeat(64)}`, anchor_hash: `sha256:${"b".repeat(64)}` };
  const quorum = trustedSourceReviewQuorum({
    review_attestations: [signed(prepared, first), signed(prepared, second)],
  }, { trustedReviewerKeys: registry([first, second]), now: NOW });
  assert.equal(quorum.distinct_approver_principal_count, 1);
  assert.equal(quorum.distinct_approver_key_count, 2);
  assert.equal(quorum.satisfied, false);
});

test("offline signer is plan-only by default and writes one signature without exposing or replacing the key", (t) => {
  const paths = workspace(t);
  const human = reviewer("Reviewer A", "reviewer:key-a");
  const request = unsigned({
    content_hash: `sha256:${"a".repeat(64)}`,
    anchor_hash: `sha256:${"b".repeat(64)}`,
  }, human);
  const requestFile = join(paths.dir, "unsigned.json");
  const privateKeyFile = join(paths.dir, "reviewer.pem");
  const outputFile = join(paths.dir, "signed.json");
  writeFileSync(requestFile, `${JSON.stringify(request)}\n`);
  writeFileSync(privateKeyFile, human.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  chmodSync(privateKeyFile, 0o600);
  const keyBefore = readFileSync(privateKeyFile);
  const plan = runOfflineSourceReviewSigning({ request, requestFile, privateKeyFile, outputFile, now: NOW });
  assert.equal(plan.mode, "check");
  assert.equal(plan.wrote, false);
  assert.equal(plan.identity_generated, false);
  assert.equal(plan.approval_generated, false);
  assert.equal(existsSync(outputFile), false);
  const result = runOfflineSourceReviewSigning({
    write: true, request, requestFile, privateKeyFile, outputFile, now: NOW,
  });
  assert.equal(result.wrote, true);
  assert.equal(existsSync(outputFile), true);
  assert.deepEqual(readFileSync(privateKeyFile), keyBefore);
  const attestation = JSON.parse(readFileSync(outputFile, "utf8"));
  const verified = verifySourceReviewAttestation(attestation, {
    trustedKeyRegistry: registry([human]), now: NOW,
  });
  assert.equal(verified.valid, true);
  assert.throws(() => runOfflineSourceReviewSigning({
    write: true, request, requestFile, privateKeyFile, outputFile, now: NOW,
  }), /refusing overwrite/);
});

test("offline signer enforces POSIX owner-only keys while Windows uses its explicit ACL-unverified policy", (t) => {
  const paths = workspace(t);
  const human = reviewer("Reviewer A", "reviewer:key-a");
  const request = unsigned({
    content_hash: `sha256:${"a".repeat(64)}`,
    anchor_hash: `sha256:${"b".repeat(64)}`,
  }, human);
  const requestFile = join(paths.dir, "unsigned.json");
  const privateKeyFile = join(paths.dir, "reviewer.pem");
  writeFileSync(requestFile, `${JSON.stringify(request)}\n`);
  writeFileSync(privateKeyFile, human.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  chmodSync(privateKeyFile, 0o644);
  assert.throws(() => runOfflineSourceReviewSigning({
    request, requestFile, privateKeyFile, now: NOW, platform: "linux",
  }), /deny group and other access/);
  assert.doesNotThrow(() => runOfflineSourceReviewSigning({
    request, requestFile, privateKeyFile, now: NOW, platform: "win32",
  }));
});

test("review operation schemas and CLI defaults preserve explicit-write boundaries", () => {
  for (const name of ["source-review-batch-v1.schema.json", "source-review-signing-request-v1.schema.json"]) {
    const file = fileURLToPath(new URL(`../../schemas/${name}`, import.meta.url));
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf8")));
  }
  assert.equal(parseBatchArgs([]).write, false);
  assert.throws(() => parseBatchArgs(["--write"]), /explicit --output/);
  const signArgs = parseSigningArgs(["--request", "/tmp/request.json", "--private-key", "/tmp/key.pem"]);
  assert.equal(signArgs.write, false);
  assert.throws(() => parseSigningArgs(["--request", "/tmp/request.json", "--private-key", "/tmp/key.pem", "--write"]), /explicit --output/);
});
