import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
import { join } from "node:path";
import { hostname as systemHostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  inspectSourceAcquisitions,
  isPublicNetworkAddress,
  normalizeAcquisitionLimits,
  normalizeExplicitHttpUrl,
  resolvePublicDestination,
  retrieveExplicitHttpBytes,
  runSourceAcquisition,
  sha256Bytes,
  validateSourceAcquisitionRecord,
} from "../../mcp/lib/personas-v3/source-acquisition.mjs";
import { scaffoldPersonaV3Staging } from "../../mcp/lib/personas-v3/staging.mjs";
import { parseArgs } from "../../scripts/acquire-persona-source.mjs";

const PERSONA = "master_buffett";
const FIXED_NOW = new Date("2026-07-27T06:00:00.000Z");
const ACQUISITION_SCHEMA = fileURLToPath(new URL("../../schemas/source-candidate-acquisition-v1.schema.json", import.meta.url));

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-source-acquisition-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "staging");
  const productionRoot = join(dir, "production");
  mkdirSync(productionRoot);
  scaffoldPersonaV3Staging({ root, productionRoot });
  return { dir, root, productionRoot };
}

function queueFile(paths) {
  return join(paths.root, PERSONA, "source-adjudication-queue.json");
}

function recordFile(paths, candidateId) {
  return join(paths.root, PERSONA, "acquisitions", "candidates", candidateId, "record.json");
}

function acquisitionOptions(paths, overrides = {}) {
  return {
    root: paths.root,
    productionRoot: paths.productionRoot,
    personaId: PERSONA,
    candidateId: "candidate-one",
    url: "https://example.test/source-one",
    now: FIXED_NOW,
    ...overrides,
  };
}

function fakeRetriever(bytes, overrides = {}) {
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
    content_type: "application/octet-stream",
    content_encoding: null,
    bytes: Buffer.from(body),
    ...overrides,
  });
}

function acquisitionDir(paths) {
  return join(paths.root, PERSONA, "acquisitions");
}

function writeLease(paths, overrides = {}) {
  const acquisitions = acquisitionDir(paths);
  mkdirSync(join(acquisitions, "candidates"), { recursive: true });
  const base = Date.parse("2026-07-27T06:00:00.000Z");
  const lease = {
    schema_version: 1,
    artifact_kind: "persona_source_acquisition_write_lease",
    owner_token: "00000000-0000-4000-8000-000000000000",
    hostname: systemHostname(),
    pid: process.pid,
    acquired_at: new Date(base).toISOString(),
    expires_at: new Date(base + 30_000).toISOString(),
    ...overrides,
  };
  const file = join(acquisitions, ".acquisition-write.lock");
  writeFileSync(file, `${JSON.stringify(lease)}\n`);
  return { file, base };
}

test("plan mode validates an explicit URL without network or filesystem mutation", async (t) => {
  const paths = workspace(t);
  const queueBefore = readFileSync(queueFile(paths));
  let calls = 0;
  const result = await runSourceAcquisition(acquisitionOptions(paths, {
    write: false,
    retrieve: async () => { calls += 1; throw new Error("must not run"); },
  }));
  assert.equal(result.mode, "plan");
  assert.equal(result.status, "network_not_called");
  assert.equal(result.network_called, false);
  assert.equal(calls, 0);
  assert.equal(existsSync(join(paths.root, PERSONA, "acquisitions")), false);
  assert.deepEqual(readFileSync(queueFile(paths)), queueBefore);
});

test("write mode archives exact bytes as retrieved_unadjudicated and never edits the queue", async (t) => {
  const paths = workspace(t);
  const queueBefore = readFileSync(queueFile(paths));
  const bytes = Buffer.from([0, 255, 16, 32, 65, 66, 67]);
  const result = await runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    retrieve: fakeRetriever(bytes),
  }));
  assert.equal(result.status, "retrieved_unadjudicated");
  assert.equal(result.network_called, true);
  assert.equal(result.record.content_hash, sha256Bytes(bytes));
  assert.equal(result.record.byte_length, bytes.length);
  assert.deepEqual(result.record.human_review, { status: "not_requested", reviewer_ids: [] });
  assert.equal(Object.hasOwn(result.record, "grade"), false);
  assert.equal(Object.hasOwn(result.record, "approval"), false);
  assert.deepEqual(readFileSync(queueFile(paths)), queueBefore);
  assert.equal(existsSync(join(paths.root, PERSONA, "manifest.json")), false);

  const archived = readFileSync(join(paths.root, PERSONA, result.record.archive_path));
  assert.deepEqual(archived, bytes);
  const persisted = JSON.parse(readFileSync(recordFile(paths, "candidate-one"), "utf8"));
  assert.deepEqual(validateSourceAcquisitionRecord(persisted), []);

  const report = inspectSourceAcquisitions(paths);
  assert.equal(report.retrieved_unadjudicated_count, 1);
  assert.equal(report.approved_count, 0);
  assert.equal(report.graded_count, 0);
  assert.equal(report.production_eligible_count, 0);
  assert.equal(report.invalid_count, 0);
});

test("the same candidate and URL is idempotent without a second retrieval", async (t) => {
  const paths = workspace(t);
  const bytes = Buffer.from("same snapshot", "utf8");
  await runSourceAcquisition(acquisitionOptions(paths, { write: true, retrieve: fakeRetriever(bytes) }));
  let calls = 0;
  const second = await runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    retrieve: async () => { calls += 1; throw new Error("must not retrieve twice"); },
  }));
  assert.equal(second.status, "already_retrieved_unadjudicated");
  assert.equal(second.network_called, false);
  assert.equal(calls, 0);
  assert.equal(inspectSourceAcquisitions(paths).retrieved_unadjudicated_count, 1);
});

test("candidate IDs, requested URLs and content hashes cannot be ambiguously duplicated", async (t) => {
  const paths = workspace(t);
  const bytes = Buffer.from("one physical source", "utf8");
  await runSourceAcquisition(acquisitionOptions(paths, { write: true, retrieve: fakeRetriever(bytes) }));

  await assert.rejects(runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    url: "https://example.test/different-url",
    retrieve: fakeRetriever(Buffer.from("different")),
  })), /candidate_id candidate-one already names a different URL/);

  await assert.rejects(runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    candidateId: "candidate-two",
    retrieve: fakeRetriever(Buffer.from("different")),
  })), /requested URL already belongs to candidate_id candidate-one/);

  await assert.rejects(runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    candidateId: "candidate-two",
    url: "https://example.test/source-two",
    retrieve: fakeRetriever(bytes),
  })), /retrieved content duplicates candidate_id candidate-one/);
  assert.equal(existsSync(recordFile(paths, "candidate-two")), false);
  assert.equal(inspectSourceAcquisitions(paths).retrieved_unadjudicated_count, 1);
});

test("concurrent identical-content commits serialize and leave at most one candidate", async (t) => {
  const paths = workspace(t);
  const bytes = Buffer.from("one concurrent physical source", "utf8");
  let calls = 0;
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const retrieve = async (url) => {
    calls += 1;
    if (calls === 2) release();
    await barrier;
    return fakeRetriever(bytes)(url);
  };
  const outcomes = await Promise.allSettled([
    runSourceAcquisition(acquisitionOptions(paths, {
      write: true,
      candidateId: "concurrent-one",
      url: "https://example.test/concurrent-one",
      retrieve,
    })),
    runSourceAcquisition(acquisitionOptions(paths, {
      write: true,
      candidateId: "concurrent-two",
      url: "https://example.test/concurrent-two",
      retrieve,
    })),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  const report = inspectSourceAcquisitions(paths);
  assert.equal(report.invalid_count, 0);
  assert.equal(report.retrieved_unadjudicated_count, 1);
});

test("write leases never pre-empt live owners and recover only dead local owners after grace", async (t) => {
  const activePaths = workspace(t);
  const active = writeLease(activePaths);
  await assert.rejects(runSourceAcquisition(acquisitionOptions(activePaths, {
    write: true,
    retrieve: fakeRetriever(Buffer.from("active lease", "utf8")),
    leaseClock: () => active.base + 1_000,
  })), /confirmed live write lease/);
  assert.equal(existsSync(active.file), true);

  const liveExpiredPaths = workspace(t);
  const liveExpired = writeLease(liveExpiredPaths, {
    acquired_at: new Date(Date.parse("2026-07-27T05:59:00.000Z")).toISOString(),
    expires_at: new Date(Date.parse("2026-07-27T05:59:30.000Z")).toISOString(),
  });
  await assert.rejects(runSourceAcquisition(acquisitionOptions(liveExpiredPaths, {
    write: true,
    retrieve: fakeRetriever(Buffer.from("live owner after expiry", "utf8")),
    leaseClock: () => liveExpired.base + 1_000,
  })), /confirmed live write lease/);
  assert.equal(existsSync(liveExpired.file), true);

  const deadPaths = workspace(t);
  const dead = writeLease(deadPaths, { pid: 999_999_999 });
  const recoveredDead = await runSourceAcquisition(acquisitionOptions(deadPaths, {
    write: true,
    retrieve: fakeRetriever(Buffer.from("dead owner recovered", "utf8")),
    leaseClock: () => dead.base + 6_000,
  }));
  assert.equal(recoveredDead.status, "retrieved_unadjudicated");
  assert.equal(existsSync(dead.file), false);

  const expiredPaths = workspace(t);
  const expired = writeLease(expiredPaths, {
    hostname: "another-host.example",
    acquired_at: new Date(Date.parse("2026-07-27T05:59:00.000Z")).toISOString(),
    expires_at: new Date(Date.parse("2026-07-27T05:59:30.000Z")).toISOString(),
  });
  await assert.rejects(runSourceAcquisition(acquisitionOptions(expiredPaths, {
    write: true,
    retrieve: fakeRetriever(Buffer.from("foreign expired owner", "utf8")),
    leaseClock: () => expired.base + 1_000,
  })), /owner is foreign/);
  assert.equal(existsSync(expired.file), true);
});

test("malformed leases fail closed and abandoned pre-publish transactions are recovered", async (t) => {
  const malformedPaths = workspace(t);
  const malformed = writeLease(malformedPaths);
  writeFileSync(malformed.file, "\n");
  await assert.rejects(runSourceAcquisition(acquisitionOptions(malformedPaths, {
    write: true,
    retrieve: fakeRetriever(Buffer.from("must not commit", "utf8")),
    leaseClock: () => malformed.base + 31_000,
  })), /write lease is invalid JSON/);
  assert.equal(existsSync(malformed.file), true);

  const recoveryPaths = workspace(t);
  const transactions = join(acquisitionDir(recoveryPaths), ".candidate-transaction-abandoned");
  mkdirSync(join(acquisitionDir(recoveryPaths), "candidates"), { recursive: true });
  mkdirSync(transactions);
  writeFileSync(join(transactions, "source.bin"), "unpublished bytes");
  const recovered = await runSourceAcquisition(acquisitionOptions(recoveryPaths, {
    write: true,
    retrieve: fakeRetriever(Buffer.from("new complete candidate", "utf8")),
  }));
  assert.equal(recovered.status, "retrieved_unadjudicated");
  assert.equal(existsSync(transactions), false);
  assert.equal(inspectSourceAcquisitions(recoveryPaths).invalid_count, 0);
});

test("byte bounds are enforced before an acquisition record can be written", async (t) => {
  const paths = workspace(t);
  const queueBefore = readFileSync(queueFile(paths));
  await assert.rejects(runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    limits: { timeout_ms: 1_000, max_bytes: 4, max_redirects: 0 },
    retrieve: fakeRetriever(Buffer.from("five!", "utf8")),
  })), /retrieved bytes exceed max_bytes 4/);
  assert.equal(existsSync(recordFile(paths, "candidate-one")), false);
  assert.deepEqual(readFileSync(queueFile(paths)), queueBefore);
  assert.equal(inspectSourceAcquisitions(paths).retrieved_unadjudicated_count, 0);
});

test("inventory counts only records whose physical bytes still match length and hash", async (t) => {
  const paths = workspace(t);
  await runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    retrieve: fakeRetriever(Buffer.from("original exact bytes", "utf8")),
  }));
  writeFileSync(join(paths.root, PERSONA, "acquisitions", "candidates", "candidate-one", "source.bin"), "tampered");

  const report = inspectSourceAcquisitions(paths);
  assert.equal(report.invalid_count, 1);
  assert.equal(report.retrieved_unadjudicated_count, 0,
    "a schema-valid record with mismatched physical bytes is not an acquired source");
});

test("atomic candidate publication removes staged bytes when record writing fails", async (t) => {
  const paths = workspace(t);
  await assert.rejects(runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    retrieve: fakeRetriever(Buffer.from("must not become an orphan", "utf8")),
    commitHooks: { beforeRecordWrite: () => { throw new Error("simulated record write failure"); } },
  })), /simulated record write failure/);
  assert.equal(existsSync(recordFile(paths, "candidate-one")), false);
  const acquisitionDir = join(paths.root, PERSONA, "acquisitions");
  assert.deepEqual(
    [...new Set((existsSync(acquisitionDir) ? readdirSync(acquisitionDir) : []).filter((name) => name.startsWith(".candidate-transaction-")))],
    [],
  );
  const report = inspectSourceAcquisitions(paths);
  assert.equal(report.invalid_count, 0);
  assert.equal(report.retrieved_unadjudicated_count, 0);
});

test("the raw HTTP retriever enforces timeout and declared Content-Length without live network", async () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const hangingRequest = () => {
    const request = new EventEmitter();
    request.end = () => {};
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    return request;
  };
  await assert.rejects(retrieveExplicitHttpBytes("https://example.test/hang", {
    limits: { timeout_ms: 100, max_bytes: 16, max_redirects: 0 },
    requestImpl: hangingRequest,
    lookupImpl: publicLookup,
  }), /timed out after 100ms/);

  const oversizedRequest = (_url, _options, callback) => {
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { "content-length": "17" };
      response.resume = () => {};
      response.destroy = () => {};
      callback(response);
    });
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    return request;
  };
  await assert.rejects(retrieveExplicitHttpBytes("https://example.test/large", {
    limits: { timeout_ms: 1_000, max_bytes: 16, max_redirects: 0 },
    requestImpl: oversizedRequest,
    lookupImpl: publicLookup,
  }), /Content-Length 17 exceeds max_bytes 16/);
});

test("SSRF protection denies private DNS and redirects while pinning a validated public address", async () => {
  for (const address of ["127.0.0.1", "10.0.0.8", "169.254.169.254", "192.168.1.1", "198.51.100.9"]) {
    assert.equal(isPublicNetworkAddress(address, 4), false);
  }
  assert.equal(isPublicNetworkAddress("93.184.216.34", 4), true);
  assert.equal(isPublicNetworkAddress("::1", 6), false);
  assert.equal(isPublicNetworkAddress("2001:db8::1", 6), false);
  assert.equal(isPublicNetworkAddress("2606:4700:4700::1111", 6), true);

  await assert.rejects(resolvePublicDestination("https://primary.example.test/source", {
    lookupImpl: async () => [{ address: "10.0.0.8", family: 4 }],
  }), /non-public or reserved address/);

  let requestCalls = 0;
  const pinnedRequest = (_url, options, callback) => {
    requestCalls += 1;
    options.lookup("primary.example.test", {}, (error, address, family) => {
      assert.equal(error, null);
      assert.equal(address, "93.184.216.34");
      assert.equal(family, 4);
    });
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { "content-length": "2" };
      response.resume = () => {};
      response.destroy = () => {};
      callback(response);
      response.emit("data", Buffer.from("ok"));
      response.emit("end");
    });
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    return request;
  };
  const pinned = await retrieveExplicitHttpBytes("https://primary.example.test/source", {
    limits: { timeout_ms: 1_000, max_bytes: 16, max_redirects: 1 },
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl: pinnedRequest,
  });
  assert.equal(requestCalls, 1);
  assert.equal(pinned.network_trace[0].address, "93.184.216.34");

  let redirectRequests = 0;
  const redirectRequest = (_url, _options, callback) => {
    redirectRequests += 1;
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 302;
      response.headers = { location: "http://169.254.169.254/latest/meta-data" };
      response.resume = () => {};
      response.destroy = () => {};
      callback(response);
    });
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    return request;
  };
  await assert.rejects(retrieveExplicitHttpBytes("https://primary.example.test/redirect", {
    limits: { timeout_ms: 1_000, max_bytes: 16, max_redirects: 1 },
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl: redirectRequest,
  }), /non-public or reserved address/);
  assert.equal(redirectRequests, 1);
});

test("record validation has no route to grade or approve an acquisition", async (t) => {
  const paths = workspace(t);
  await runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    retrieve: fakeRetriever(Buffer.from("candidate bytes", "utf8")),
  }));
  const record = JSON.parse(readFileSync(recordFile(paths, "candidate-one"), "utf8"));
  record.grade = "A";
  record.human_review.status = "approved";
  record.human_review.reviewer_ids = ["invented-reviewer"];
  const errors = validateSourceAcquisitionRecord(record);
  assert.ok(errors.some((error) => error.includes("grade is not allowed")));
  assert.ok(errors.some((error) => error.includes("must remain not_requested")));
  assert.ok(errors.some((error) => error.includes("reviewer_ids must remain empty")));
});

test("the published acquisition schema is exact and contains no grade or approval route", () => {
  const schema = JSON.parse(readFileSync(ACQUISITION_SCHEMA, "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.status.const, "retrieved_unadjudicated");
  assert.equal(Object.hasOwn(schema.properties, "grade"), false);
  assert.equal(Object.hasOwn(schema.properties, "approval"), false);
  assert.equal(schema.properties.human_review.additionalProperties, false);
  assert.equal(schema.properties.human_review.properties.status.const, "not_requested");
  assert.equal(schema.properties.human_review.properties.reviewer_ids.maxItems, 0);
});

test("unsafe URLs, limits and candidate paths fail before retrieval", async (t) => {
  const paths = workspace(t);
  assert.throws(() => normalizeExplicitHttpUrl("file:///tmp/source"), /http or https/);
  assert.throws(() => normalizeExplicitHttpUrl("https://user:pass@example.test/source"), /must not contain credentials/);
  assert.throws(() => normalizeExplicitHttpUrl("https://example.test/source#section"), /must not contain a fragment/);
  assert.throws(() => normalizeAcquisitionLimits({ timeout_ms: 99 }), /invalid acquisition limits/);
  let calls = 0;
  await assert.rejects(runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    candidateId: "../escape",
    retrieve: async () => { calls += 1; },
  })), /candidate-id must be/);
  assert.equal(calls, 0);
});

test("symlinked acquisition targets are rejected without overwriting their target", async (t) => {
  const paths = workspace(t);
  const candidates = join(paths.root, PERSONA, "acquisitions", "candidates");
  mkdirSync(candidates, { recursive: true });
  const outside = join(paths.dir, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "sentinel"), "outside remains unchanged\n");
  symlinkSync(outside, join(candidates, "candidate-one"));
  let calls = 0;
  await assert.rejects(runSourceAcquisition(acquisitionOptions(paths, {
    write: true,
    retrieve: async () => { calls += 1; },
  })), /staging must pass integrity checks/);
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside remains unchanged\n");
});

test("CLI argument parsing keeps check, plan and write modes explicit", () => {
  assert.equal(parseArgs(["--check"]).check, true);
  const plan = parseArgs(["--persona", PERSONA, "--candidate-id", "candidate-one", "--url", "https://example.test/source", "--max-redirects", "0"]);
  assert.equal(plan.write, false);
  assert.equal(plan.limits.max_redirects, 0);
  assert.equal(parseArgs(["--write", "--persona", PERSONA, "--candidate-id", "candidate-one", "--url", "https://example.test/source"]).write, true);
  assert.throws(() => parseArgs([]), /requires --persona/);
  assert.throws(() => parseArgs(["--write", "--check"]), /cannot be combined/);
  assert.throws(() => parseArgs(["--check", "--url", "https://example.test/source"]), /cannot be combined/);
});
