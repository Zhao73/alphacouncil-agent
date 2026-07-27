import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname as systemHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadV3Packs } from "../../mcp/lib/personas-v3/loader.mjs";
import { signCanonicalAttestation } from "../../mcp/lib/personas-v3/attestations.mjs";
import { TRUSTED_SOURCE_REVIEW_KEYS_ENV } from "../../mcp/lib/personas-v3/source-review-attestations.mjs";
import { runSourceAcquisition, sha256Bytes } from "../../mcp/lib/personas-v3/source-acquisition.mjs";
import {
  SOURCE_ADJUDICATION_FILES,
  inspectSourceAdjudications,
  prepareSourceAdjudication,
  reviewSourceAdjudication,
  validateAdjudicationLedger,
  validateReviewerAttestation,
  validateSourceAnchorProposal,
} from "../../mcp/lib/personas-v3/source-adjudication.mjs";
import { scaffoldPersonaV3Staging } from "../../mcp/lib/personas-v3/staging.mjs";
import { parseArgs } from "../../scripts/adjudicate-persona-source.mjs";

const PERSONA = "master_buffett";
const CANDIDATE = "buffett-letter-2024";
const SOURCE_ID = "buffett:letter:2024";
const ACQUIRED_AT = new Date("2026-07-27T06:00:00.000Z");
const ACTION_NOW = new Date("2026-07-27T10:00:00.000Z");
const SCHEMAS = [
  "source-anchor-proposal-v1.schema.json",
  "source-review-attestation-v2.schema.json",
  "source-adjudication-ledger-v1.schema.json",
].map((name) => fileURLToPath(new URL(`../../schemas/${name}`, import.meta.url)));

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-source-adjudication-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "staging");
  const productionRoot = join(dir, "production");
  mkdirSync(productionRoot);
  scaffoldPersonaV3Staging({ root, productionRoot });
  return { dir, root, productionRoot };
}

function seat(paths) {
  return join(paths.root, PERSONA);
}

function queueFile(paths) {
  return join(seat(paths), "source-adjudication-queue.json");
}

function ledgerFile(paths) {
  return join(seat(paths), "source-adjudication-ledger.json");
}

function acquisitionRecordFile(paths, candidateId = CANDIDATE) {
  return join(seat(paths), "acquisitions", "candidates", candidateId, "record.json");
}

function acquisitionArchiveFile(paths, candidateId = CANDIDATE) {
  return join(seat(paths), "acquisitions", "candidates", candidateId, "source.bin");
}

function json(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function fakeRetriever(bytes) {
  const body = Buffer.from(bytes);
  return async (url) => ({
    requested_url: url,
    final_url: url,
    redirect_chain: [url],
    network_trace: [{
      url,
      hostname: new URL(url).hostname,
      address: "93.184.216.34",
      family: 4,
    }],
    http_status: 200,
    content_type: "text/plain; charset=utf-8",
    content_encoding: null,
    bytes: Buffer.from(body),
  });
}

async function acquire(paths, { candidateId = CANDIDATE, bytes = Buffer.from("human-reviewed primary source bytes"), url = "https://example.test/buffett-letter-2024" } = {}) {
  return runSourceAcquisition({
    write: true,
    root: paths.root,
    productionRoot: paths.productionRoot,
    personaId: PERSONA,
    candidateId,
    url,
    now: ACQUIRED_AT,
    retrieve: fakeRetriever(bytes),
  });
}

function proposal(overrides = {}) {
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
    summary: "The specified section states the capital-allocation principle under review.",
    excerpt: "A short human-entered excerpt.",
    supports: ["doctrine:capital-allocation"],
    ...overrides,
  };
}

const reviewerKeys = new Map();

function normalizedReviewer(value) {
  return value.normalize("NFKC").trim();
}

function reviewerKey(reviewerId) {
  const principal = normalizedReviewer(reviewerId);
  if (!reviewerKeys.has(principal)) {
    const pair = generateKeyPairSync("ed25519");
    reviewerKeys.set(principal, {
      keyId: `reviewer:key-${reviewerKeys.size + 1}`,
      principal,
      ...pair,
    });
  }
  const key = reviewerKeys.get(principal);
  process.env[TRUSTED_SOURCE_REVIEW_KEYS_ENV] = JSON.stringify(Object.fromEntries(
    [...reviewerKeys.values()].map((entry) => [entry.keyId, {
      public_key: entry.publicKey.export({ type: "spki", format: "pem" }),
      principal_id: entry.principal,
      purposes: ["source_review"],
    }]),
  ));
  return key;
}

function attestation(prepared, reviewerId, decision = "approve", reviewedAt = "2026-07-27T08:00:00.000Z", overrides = {}) {
  const key = reviewerKey(reviewerId);
  const payload = {
    schema_version: 2,
    artifact_kind: "persona_v3_source_review_attestation",
    reviewer_id: reviewerId,
    signer_key_id: key.keyId,
    decision,
    content_hash: prepared.content_hash,
    anchor_hash: prepared.anchor_hash,
    reviewed_at: reviewedAt,
    affirmations: {
      reviewed_raw_archive_bytes: true,
      verified_locator_against_raw_material: true,
      reviewer_is_human: true,
      review_was_independent: true,
    },
    notes: "I inspected the archived bytes and the exact locator.",
    ...overrides,
  };
  return {
    ...payload,
    signature: signCanonicalAttestation(payload, {
      privateKey: key.privateKey,
      signerKeyId: key.keyId,
    }),
  };
}

async function prepare(paths, overrides = {}) {
  await acquire(paths, overrides.acquire || {});
  return prepareSourceAdjudication({
    write: true,
    root: paths.root,
    productionRoot: paths.productionRoot,
    personaId: PERSONA,
    candidateId: overrides.candidateId || CANDIDATE,
    proposal: overrides.proposal || proposal(),
    now: ACTION_NOW,
    ...overrides.options,
  });
}

function writeLease(paths, overrides = {}) {
  const base = Date.parse("2026-07-27T10:00:00.000Z");
  const lease = {
    schema_version: 1,
    artifact_kind: "persona_source_adjudication_write_lease",
    owner_token: "00000000-0000-4000-8000-000000000000",
    hostname: systemHostname(),
    pid: process.pid,
    acquired_at: new Date(base).toISOString(),
    expires_at: new Date(base + SOURCE_ADJUDICATION_FILES.lease_ms).toISOString(),
    ...overrides,
  };
  const file = join(seat(paths), SOURCE_ADJUDICATION_FILES.lock);
  writeFileSync(file, `${JSON.stringify(lease)}\n`);
  return { file, base };
}

test("proposal, attestation and ledger schemas are parseable and require human-only fields", () => {
  const schemas = SCHEMAS.map((file) => JSON.parse(readFileSync(file, "utf8")));
  assert.equal(schemas[0].properties.author.type, "string");
  assert.ok(schemas[0].required.includes("supports"));
  assert.equal(schemas[1].properties.affirmations.properties.reviewer_is_human.const, true);
  assert.equal(schemas[1].properties.schema_version.const, 2);
  assert.match(schemas[1].properties.signature.pattern, /ed25519/);
  assert.equal(schemas[2].properties.records.items.$ref, "#/$defs/ledgerRecord");
  assert.equal(validateSourceAnchorProposal(proposal()).length, 0);
  assert.ok(validateSourceAnchorProposal(proposal({ title: "TBD" })).some((error) => /human-supplied/.test(error)));
  const fake = attestation({ content_hash: `sha256:${"1".repeat(64)}`, anchor_hash: `sha256:${"2".repeat(64)}` }, "reviewer-a", "approve", "2026-07-27T08:00:00.000Z", {
    affirmations: {
      reviewed_raw_archive_bytes: false,
      verified_locator_against_raw_material: true,
      reviewer_is_human: true,
      review_was_independent: true,
    },
  });
  assert.ok(validateReviewerAttestation(fake, { now: ACTION_NOW }).some((error) => /must be true/.test(error)));
});

test("default CLI mode is check and prepare/review remain plan-only without --write", () => {
  assert.equal(parseArgs([]).operation, "check");
  const prepareArgs = parseArgs(["prepare", "--persona", PERSONA, "--candidate-id", CANDIDATE, "--proposal", "/tmp/proposal.json"]);
  assert.equal(prepareArgs.write, false);
  const reviewArgs = parseArgs(["review", "--persona", PERSONA, "--source-id", SOURCE_ID, "--attestation", "/tmp/review.json"]);
  assert.equal(reviewArgs.write, false);
  assert.throws(() => parseArgs(["check", "--write"]), /never accepts --write/);
});

test("prepare plan validates archived bytes but mutates no queue, ledger, acquisition or production file", async (t) => {
  const paths = workspace(t);
  await acquire(paths);
  const queueBefore = readFileSync(queueFile(paths));
  const recordBefore = readFileSync(acquisitionRecordFile(paths));
  const archiveBefore = readFileSync(acquisitionArchiveFile(paths));
  const result = await prepareSourceAdjudication({
    write: false,
    root: paths.root,
    productionRoot: paths.productionRoot,
    personaId: PERSONA,
    candidateId: CANDIDATE,
    proposal: proposal(),
    now: ACTION_NOW,
  });
  assert.equal(result.mode, "plan");
  assert.equal(result.status, "prepared_pending_human_review");
  assert.equal(result.wrote, false);
  assert.deepEqual(readFileSync(queueFile(paths)), queueBefore);
  assert.equal(existsSync(ledgerFile(paths)), false);
  assert.deepEqual(readFileSync(acquisitionRecordFile(paths)), recordBefore);
  assert.deepEqual(readFileSync(acquisitionArchiveFile(paths)), archiveBefore);
  assert.deepEqual(readdirSync(paths.productionRoot), []);
});

test("prepare rejects an archive hash mismatch before writing a pending anchor", async (t) => {
  const paths = workspace(t);
  await acquire(paths);
  writeFileSync(acquisitionArchiveFile(paths), "tampered bytes");
  await assert.rejects(prepareSourceAdjudication({
    write: true,
    root: paths.root,
    productionRoot: paths.productionRoot,
    personaId: PERSONA,
    candidateId: CANDIDATE,
    proposal: proposal(),
    now: ACTION_NOW,
  }), /content_hash does not match/);
  assert.equal(json(queueFile(paths)).records.length, 0);
  assert.equal(existsSync(ledgerFile(paths)), false);
});

test("prepare writes one pending zero-reviewer anchor and is idempotent", async (t) => {
  const paths = workspace(t);
  const prepared = await prepare(paths);
  assert.equal(prepared.status, "prepared_pending_human_review");
  const queue = json(queueFile(paths));
  const ledger = json(ledgerFile(paths));
  assert.equal(queue.records.length, 1);
  assert.deepEqual(queue.records[0].adjudication.reviewer_ids, []);
  assert.equal(queue.records[0].adjudication.status, "pending");
  assert.equal(ledger.records[0].proposal.author, proposal().author);
  assert.equal(ledger.records[0].review_attestations.length, 0);
  assert.deepEqual(validateAdjudicationLedger(ledger, { personaId: PERSONA }), []);
  const before = readFileSync(ledgerFile(paths));
  const again = await prepareSourceAdjudication({
    write: true,
    root: paths.root,
    productionRoot: paths.productionRoot,
    personaId: PERSONA,
    candidateId: CANDIDATE,
    proposal: proposal(),
    now: ACTION_NOW,
  });
  assert.equal(again.status, "already_prepared");
  assert.equal(again.wrote, false);
  assert.deepEqual(readFileSync(ledgerFile(paths)), before);
});

test("one human approval stays pending; two NFKC-distinct humans approve the same hashes", async (t) => {
  const paths = workspace(t);
  const prepared = await prepare(paths);
  const first = await reviewSourceAdjudication({
    write: true,
    root: paths.root,
    productionRoot: paths.productionRoot,
    personaId: PERSONA,
    sourceId: SOURCE_ID,
    attestation: attestation(prepared, "reviewer-a"),
    now: ACTION_NOW,
  });
  assert.equal(first.review_status, "pending");
  assert.equal(json(queueFile(paths)).records[0].adjudication.status, "pending");
  const second = await reviewSourceAdjudication({
    write: true,
    root: paths.root,
    productionRoot: paths.productionRoot,
    personaId: PERSONA,
    sourceId: SOURCE_ID,
    attestation: attestation(prepared, "reviewer-b", "approve", "2026-07-27T09:00:00.000Z"),
    now: ACTION_NOW,
  });
  assert.equal(second.review_status, "approved");
  assert.deepEqual(second.reviewer_ids, ["reviewer-a", "reviewer-b"]);
  const queue = json(queueFile(paths));
  assert.equal(queue.records[0].adjudication.status, "approved");
  assert.equal(queue.records[0].adjudication.reviewer_ids.length, 2);
  const ledger = json(ledgerFile(paths));
  assert.equal(ledger.records[0].review_attestations[1].previous_attestation_hash,
    ledger.records[0].review_attestations[0].attestation_hash);
  assert.equal(ledger.records[0].attestation_chain_head, ledger.records[0].review_attestations[1].attestation_hash);
});

test("NFKC-homographic reviewer IDs never inflate the independent reviewer count", async (t) => {
  const paths = workspace(t);
  const prepared = await prepare(paths);
  await reviewSourceAdjudication({
    write: true, root: paths.root, productionRoot: paths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: attestation(prepared, "Reviewer-A"), now: ACTION_NOW,
  });
  const duplicate = await reviewSourceAdjudication({
    write: true, root: paths.root, productionRoot: paths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: attestation(prepared, "Ｒｅｖｉｅｗｅｒ－Ａ", "approve", "2026-07-27T08:30:00.000Z"), now: ACTION_NOW,
  });
  assert.equal(duplicate.review_status, "pending");
  assert.deepEqual(duplicate.reviewer_ids, ["Reviewer-A"]);
  assert.deepEqual(duplicate.duplicate_reviewer_ids, ["Reviewer-A"]);
  assert.equal(json(queueFile(paths)).records[0].adjudication.status, "pending");
});

test("an exact repeated attestation is idempotent and does not extend the hash chain", async (t) => {
  const paths = workspace(t);
  const prepared = await prepare(paths);
  const review = attestation(prepared, "reviewer-a");
  await reviewSourceAdjudication({
    write: true, root: paths.root, productionRoot: paths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID, attestation: review, now: ACTION_NOW,
  });
  const before = readFileSync(ledgerFile(paths));
  const repeated = await reviewSourceAdjudication({
    write: true, root: paths.root, productionRoot: paths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID, attestation: review, now: ACTION_NOW,
  });
  assert.equal(repeated.status, "already_recorded");
  assert.equal(repeated.wrote, false);
  assert.deepEqual(readFileSync(ledgerFile(paths)), before);
  assert.equal(json(ledgerFile(paths)).records[0].review_attestations.length, 1);
});

test("a reject can never produce approved; disagreement remains queue-pending and ledger-blocked", async (t) => {
  const paths = workspace(t);
  const prepared = await prepare(paths);
  const rejected = await reviewSourceAdjudication({
    write: true, root: paths.root, productionRoot: paths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: attestation(prepared, "reviewer-r", "reject"), now: ACTION_NOW,
  });
  assert.equal(rejected.review_status, "rejected");
  assert.equal(json(queueFile(paths)).records[0].adjudication.status, "rejected");
  const conflict = await reviewSourceAdjudication({
    write: true, root: paths.root, productionRoot: paths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: attestation(prepared, "reviewer-a", "approve", "2026-07-27T09:00:00.000Z"), now: ACTION_NOW,
  });
  assert.equal(conflict.review_status, "blocked");
  assert.equal(conflict.review_reason, "conflicting_human_reviews");
  assert.equal(json(queueFile(paths)).records[0].adjudication.status, "pending");
  assert.equal(json(ledgerFile(paths)).records[0].status, "blocked");
});

test("review rejects an attestation bound to any other content or anchor hash", async (t) => {
  const paths = workspace(t);
  const prepared = await prepare(paths);
  await assert.rejects(reviewSourceAdjudication({
    write: true, root: paths.root, productionRoot: paths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: attestation(prepared, "reviewer-a", "approve", "2026-07-27T08:00:00.000Z", {
      anchor_hash: `sha256:${"f".repeat(64)}`,
    }),
    now: ACTION_NOW,
  }), /anchor_hash does not match/);
  assert.equal(json(ledgerFile(paths)).records[0].review_attestations.length, 0);
});

test("live owners are never stolen after expiry; dead same-host owners recover after grace", async (t) => {
  const livePaths = workspace(t);
  const livePrepared = await prepare(livePaths);
  const live = writeLease(livePaths, {
    acquired_at: "2026-07-27T09:00:00.000Z",
    expires_at: "2026-07-27T09:00:30.000Z",
  });
  await assert.rejects(reviewSourceAdjudication({
    write: true, root: livePaths.root, productionRoot: livePaths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: attestation(livePrepared, "reviewer-a"), now: ACTION_NOW,
    leaseClock: () => live.base + 120_000,
  }), /confirmed live write lease/);
  assert.equal(existsSync(live.file), true);

  const deadPaths = workspace(t);
  const deadPrepared = await prepare(deadPaths);
  const dead = writeLease(deadPaths, { pid: 999_999_999 });
  const recovered = await reviewSourceAdjudication({
    write: true, root: deadPaths.root, productionRoot: deadPaths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: attestation(deadPrepared, "reviewer-a"), now: ACTION_NOW,
    leaseClock: () => dead.base + SOURCE_ADJUDICATION_FILES.dead_owner_grace_ms + 1,
  });
  assert.equal(recovered.review_status, "pending");
  assert.equal(existsSync(dead.file), false);
});

test("foreign, malformed and symlinked lock or ledger paths fail closed", async (t) => {
  const foreignPaths = workspace(t);
  const foreignPrepared = await prepare(foreignPaths);
  writeLease(foreignPaths, { hostname: "foreign-host.invalid", pid: 999_999_999 });
  await assert.rejects(reviewSourceAdjudication({
    write: true, root: foreignPaths.root, productionRoot: foreignPaths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: attestation(foreignPrepared, "reviewer-a"), now: ACTION_NOW,
  }), /foreign/);

  const malformedPaths = workspace(t);
  const malformedPrepared = await prepare(malformedPaths);
  writeFileSync(join(seat(malformedPaths), SOURCE_ADJUDICATION_FILES.lock), "{}\n");
  await assert.rejects(reviewSourceAdjudication({
    write: true, root: malformedPaths.root, productionRoot: malformedPaths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID,
    attestation: attestation(malformedPrepared, "reviewer-a"), now: ACTION_NOW,
  }), /lease is invalid/);

  const linkedPaths = workspace(t);
  await acquire(linkedPaths);
  const outside = join(linkedPaths.dir, "outside-ledger.json");
  writeFileSync(outside, "{}\n");
  symlinkSync(outside, ledgerFile(linkedPaths));
  await assert.rejects(prepareSourceAdjudication({
    write: true, root: linkedPaths.root, productionRoot: linkedPaths.productionRoot,
    personaId: PERSONA, candidateId: CANDIDATE, proposal: proposal(), now: ACTION_NOW,
  }), /symlink|unsafe/i);
  assert.equal(readFileSync(outside, "utf8"), "{}\n");
});

test("a crash after queue replacement is completed from the fsynced transaction journal", async (t) => {
  const paths = workspace(t);
  const prepared = await prepare(paths);
  const review = attestation(prepared, "reviewer-a");
  await assert.rejects(reviewSourceAdjudication({
    write: true, root: paths.root, productionRoot: paths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID, attestation: review, now: ACTION_NOW,
    transactionHooks: { afterQueueCommit: () => { throw new Error("simulated crash after queue commit"); } },
  }), /simulated crash/);
  assert.equal(json(queueFile(paths)).records[0].adjudication.reviewer_ids.length, 1);
  assert.equal(json(ledgerFile(paths)).records[0].review_attestations.length, 0);
  assert.ok(readdirSync(seat(paths)).some((name) => name.startsWith(SOURCE_ADJUDICATION_FILES.transaction_prefix)));

  const recovered = await reviewSourceAdjudication({
    write: true, root: paths.root, productionRoot: paths.productionRoot,
    personaId: PERSONA, sourceId: SOURCE_ID, attestation: review, now: ACTION_NOW,
  });
  assert.equal(recovered.status, "already_recorded");
  assert.equal(json(ledgerFile(paths)).records[0].review_attestations.length, 1);
  assert.equal(readdirSync(seat(paths)).some((name) => name.startsWith(SOURCE_ADJUDICATION_FILES.transaction_prefix)), false);
});

test("approved staging anchors remain invisible to the production PersonaPack loader", async (t) => {
  const paths = workspace(t);
  const recordBefore = await (async () => {
    const prepared = await prepare(paths);
    const bytes = readFileSync(acquisitionRecordFile(paths));
    await reviewSourceAdjudication({
      write: true, root: paths.root, productionRoot: paths.productionRoot,
      personaId: PERSONA, sourceId: SOURCE_ID,
      attestation: attestation(prepared, "reviewer-a"), now: ACTION_NOW,
    });
    await reviewSourceAdjudication({
      write: true, root: paths.root, productionRoot: paths.productionRoot,
      personaId: PERSONA, sourceId: SOURCE_ID,
      attestation: attestation(prepared, "reviewer-b", "approve", "2026-07-27T09:00:00.000Z"), now: ACTION_NOW,
    });
    return bytes;
  })();
  assert.deepEqual(readFileSync(acquisitionRecordFile(paths)), recordBefore, "adjudication must not edit the acquisition record");
  assert.equal(existsSync(join(seat(paths), "manifest.json")), false);
  assert.equal(loadV3Packs({ dir: paths.productionRoot }).packs.length, 0);
  const report = inspectSourceAdjudications({ root: paths.root, productionRoot: paths.productionRoot, now: ACTION_NOW });
  assert.equal(report.status_counts.approved, 1);
  assert.equal(report.production_write_count, 0);
  assert.equal(report.invalid_count, 0);
  assert.deepEqual(readdirSync(paths.productionRoot), []);
});
