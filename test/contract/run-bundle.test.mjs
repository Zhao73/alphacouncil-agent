import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { RUNTIME_BUILD_IDENTITY } from "../../mcp/lib/constants.mjs";
import { jsonlEntryHash } from "../../mcp/lib/fsutil.mjs";
import { canonicalJson } from "../../mcp/lib/personas-v3/canonical.mjs";
import { CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";
import { rehashTimingEvents, timingIso } from "../helpers/timing-fixtures.mjs";
import {
  EVIDENCE_STANDARD_ID,
  analyzeSeatContent,
  exportRunBundle,
  formatVerificationSummary,
  seatContentMonitoringFindings,
  verifyRunBundle,
} from "../../scripts/lib/run-bundle.mjs";

const DOSSIER_HASH = `sha256:${"d".repeat(64)}`;
const PACKET_HASH = `sha256:${"e".repeat(64)}`;
const VERIFY_CLI = fileURLToPath(new URL("../../scripts/verify-run-bundle.mjs", import.meta.url));
const RUN_BUNDLE_SCHEMA_PATH = fileURLToPath(new URL("../../schemas/run-bundle-v1.schema.json", import.meta.url));

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function digest(path) {
  const bytes = readFileSync(path);
  return {
    path,
    byte_length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function canonicalHash(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function voice(master, stance, unique, {
  dossierHash = DOSSIER_HASH,
  packetHash = PACKET_HASH,
} = {}) {
  return {
    master,
    stance,
    deterministic_stance: stance,
    acknowledged_stance: stance,
    voice_statement: unique,
    voice: {
      what_i_see: `${unique} observed evidence`,
      how_my_method_reads_it: `${unique} method interpretation`,
      would_i_act: `${unique} bounded action`,
      what_changes_my_mind: `${unique} invalidation condition`,
      where_i_disagree: `${unique} minority objection`,
    },
    voice_status: "model_voice",
    statement_origin: "dedicated_method_voice_worker",
    voice_mode: "first_person_public_method_simulation_v1",
    disclosure_ack: "alphacouncil.first_person_public_method_simulation.v1",
    position_intent: stance === "constructive" ? "would_buy" : "would_avoid",
    key_findings: [`${unique} finding`],
    disagreements: [`${unique} disagreement`],
    what_would_change_my_mind: [`${unique} change condition`],
    source_ids: ["market_data:S1"],
    confidence: "medium",
    company_dossier_hash_ack: dossierHash,
    evidence_packet_acks: [{
      task: "market_data",
      packet_hash: packetHash,
      status: "used",
      source_ids: ["market_data:S1"],
      note: `${unique} used the packet`,
    }],
    dedicated_worker: { status: "completed", execution_mode: "codex_exec" },
  };
}

function addEvent(events, at, type, fields = {}) {
  const event = {
    schema_version: 1,
    seq: events.length + 1,
    prev_hash: events.at(-1)?.event_hash || null,
    at,
    type,
    ...fields,
  };
  event.event_hash = jsonlEntryHash(event);
  events.push(event);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-run-bundle-"));
  const runDir = join(root, "run");
  mkdirSync(runDir, { mode: 0o700 });
  const runId = "BUNDLE-FIXTURE-1";
  const masters = ["master_buffett", "master_taleb"];
  const packet = {
    task: "market_data",
    sources: [{ id: "S1", url: "https://example.com/source" }],
  };
  const packetHash = canonicalHash(packet);
  const dossierContent = {
    run_id: runId,
    packet_manifest: [{ task: "market_data", packet_hash: packetHash }],
  };
  const dossier = { ...dossierContent, content_hash: canonicalHash(dossierContent) };
  const opinions = [
    voice(masters[0], "constructive", "durable moat owner earnings reinvestment runway", { dossierHash: dossier.content_hash, packetHash }),
    voice(masters[1], "opposed", "convex fragility ruin exposure nonlinear payoff", { dossierHash: dossier.content_hash, packetHash }),
  ];
  const runtime = {
    ...RUNTIME_BUILD_IDENTITY,
    package_version: "1.5.0",
    git_commit: null,
    git_tracked_tree_dirty: true,
    observed_at: "2026-08-26T00:00:00.000Z",
  };
  const evidence = {
    run_id: runId,
    symbol: "TEST",
    as_of: "2026-08-26",
    status: "complete",
    started_at: "2026-08-26T00:00:00.000Z",
    completed_at: "2026-08-26T00:00:06.000Z",
    tasks: ["market_data"],
    masters,
    master_opinions: opinions,
    runtime_provenance: runtime,
    fact_pack_hash: `sha256:${"f".repeat(64)}`,
    master_selection: { catalog_hash: "a".repeat(64), intent_hash: "b".repeat(64) },
  };
  const status = {
    run_id: runId,
    symbol: "TEST",
    status: "complete",
    selected_analysts: ["market_data"],
    selected_masters: masters,
    recorded_masters: masters,
    runtime_provenance: runtime,
    started_at: evidence.started_at,
    completed_at: evidence.completed_at,
  };
  writeJson(join(runDir, "evidence.json"), evidence);
  writeJson(join(runDir, "status.json"), status);
  writeJson(join(runDir, "company_dossier.json"), dossier);
  writeJson(join(runDir, "source_manifest.json"), {
    run_id: runId,
    source_count: 1,
    sources: [{ id: "market_data:S1", source_id: "market_data:S1", url: "https://example.com/source" }],
    missing_claim_source_ids: [],
  });
  writeJson(join(runDir, "market_data.json"), packet);
  for (const opinion of opinions) writeJson(join(runDir, `${opinion.master}.json`), opinion);

  const events = [];
  addEvent(events, "2026-08-26T00:00:00.000Z", "run_started", { masters, tasks: ["market_data"] });
  addEvent(events, "2026-08-26T00:00:01.000Z", "master_running", { master: masters[0], started_at: "2026-08-26T00:00:01.000Z" });
  addEvent(events, "2026-08-26T00:00:02.000Z", "master_running", { master: masters[1], started_at: "2026-08-26T00:00:02.000Z" });
  addEvent(events, "2026-08-26T00:00:04.000Z", "master_completed", { master: masters[0], completed_at: "2026-08-26T00:00:04.000Z" });
  addEvent(events, "2026-08-26T00:00:05.000Z", "master_completed", { master: masters[1], completed_at: "2026-08-26T00:00:05.000Z" });
  writeFileSync(join(runDir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });

  const publicationFiles = [
    "evidence.json",
    "status.json",
    "company_dossier.json",
    "source_manifest.json",
  ];
  writeJson(join(runDir, "publication_manifest.json"), {
    schema: "alphacouncil_publication_manifest_v1",
    schema_version: 1,
    run_id: runId,
    runtime_provenance: runtime,
    status: "complete",
    quality: "passed",
    artifacts: Object.fromEntries(publicationFiles.map((name) => [name.replace(/\W/gu, "_"), digest(join(runDir, name))])),
    published_at: "2026-08-26T00:00:06.000Z",
  });
  return { root, runDir };
}

function refreshPublicationDigests(runDir) {
  const path = join(runDir, "publication_manifest.json");
  const publication = JSON.parse(readFileSync(path, "utf8"));
  for (const record of Object.values(publication.artifacts)) Object.assign(record, digest(record.path));
  writeJson(path, publication);
}

function refreshBundleManifestDigest(bundleDir, relativePath) {
  const manifestPath = join(bundleDir, "bundle-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const record = manifest.files.find((item) => item.path === relativePath);
  assert.ok(record, `${relativePath} must be listed before its digest can be refreshed`);
  const bytes = readFileSync(join(bundleDir, relativePath));
  record.byte_length = bytes.length;
  record.sha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.total_payload_bytes = manifest.files.reduce((sum, item) => sum + item.byte_length, 0);
  writeJson(manifestPath, manifest);
}

test("run bundle exports atomically and verifies structure separately from claim readiness", () => {
  const { root, runDir } = fixture();
  try {
    const bundleDir = join(root, "bundle");
    const exported = exportRunBundle({ runDir, outputDir: bundleDir });
    assert.equal(exported.manifest.schema, "alphacouncil_run_bundle_v1");
    assert.equal(exported.manifest.verification_contract.standard_id, EVIDENCE_STANDARD_ID);
    const verified = verifyRunBundle({ bundleDir });
    assert.equal(verified.structure.status, "PASS");
    assert.equal(verified.claim_readiness.status, "BLOCKED");
    assert.ok(verified.claim_readiness.blockers.some((item) => item.code === "reviewed_vocabulary_contract_pending"));
    const summary = formatVerificationSummary(verified);
    assert.match(summary, /^structure: PASS$/mu);
    assert.match(summary, /^claim_readiness: BLOCKED/mu);
    assert.doesNotMatch(summary, /^PASS$/mu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shipped schema accepts a real manifest and rejects every dot-segment traversal shape", () => {
  const { root, runDir } = fixture();
  try {
    const bundleDir = join(root, "bundle");
    const exported = exportRunBundle({ runDir, outputDir: bundleDir });
    const schema = JSON.parse(readFileSync(RUN_BUNDLE_SCHEMA_PATH, "utf8"));
    const validate = new Ajv2020({ strict: true, validateFormats: false }).compile(schema);
    assert.equal(validate(exported.manifest), true, JSON.stringify(validate.errors));
    assert.equal(schema.properties.files.maxItems, 4_096);

    for (const path of ["payload/../escape.json", "payload/..", "payload/./escape.json", "payload/x/../escape.json"]) {
      const candidate = structuredClone(exported.manifest);
      candidate.files[0].path = path;
      assert.equal(validate(candidate), false, `${path} must be rejected by the published schema`);
    }

    const nested = structuredClone(exported.manifest);
    nested.files[0].path = "payload/nested/review.json";
    assert.equal(validate(nested), true, JSON.stringify(validate.errors));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampering a payload file fails structure even when claim readiness is not required", () => {
  const { root, runDir } = fixture();
  try {
    const bundleDir = join(root, "bundle");
    exportRunBundle({ runDir, outputDir: bundleDir });
    writeFileSync(join(bundleDir, "payload", "status.json"), "{}\n");
    const verified = verifyRunBundle({ bundleDir });
    assert.equal(verified.structure.status, "FAIL");
    assert.ok(verified.structure.errors.some((item) => item.code === "payload_digest_mismatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the verifier rejects traversal paths and unlisted filesystem payloads", () => {
  const { root, runDir } = fixture();
  try {
    const bundleDir = join(root, "bundle");
    exportRunBundle({ runDir, outputDir: bundleDir });
    const manifestPath = join(bundleDir, "bundle-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[0].path = "../escape.json";
    writeJson(manifestPath, manifest);
    const verified = verifyRunBundle({ bundleDir });
    assert.equal(verified.structure.status, "FAIL");
    assert.ok(verified.structure.errors.some((item) => item.code === "payload_path_invalid"));
    assert.ok(verified.structure.errors.some((item) => item.code === "payload_inventory_mismatch"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy missing stance acknowledgement remains a claim blocker and is never backfilled", () => {
  const { root, runDir } = fixture();
  try {
    const masterPath = join(runDir, "master_buffett.json");
    const opinion = JSON.parse(readFileSync(masterPath, "utf8"));
    delete opinion.acknowledged_stance;
    writeJson(masterPath, opinion);
    const evidencePath = join(runDir, "evidence.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    delete evidence.master_opinions.find((item) => item.master === "master_buffett").acknowledged_stance;
    writeJson(evidencePath, evidence);
    refreshPublicationDigests(runDir);
    const bundleDir = join(root, "bundle");
    exportRunBundle({ runDir, outputDir: bundleDir });
    const verified = verifyRunBundle({ bundleDir });
    assert.equal(verified.structure.status, "PASS");
    const blocker = verified.claim_readiness.blockers.find((item) => item.code === "seat_contract_invalid" && item.message.includes("master_buffett"));
    assert.ok(blocker?.details.includes("acknowledged_stance missing from persisted artifact"));
    const persisted = JSON.parse(readFileSync(join(bundleDir, "payload", "master_buffett.json"), "utf8"));
    assert.equal(Object.hasOwn(persisted, "acknowledged_stance"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hash-valid event ledger still fails structure when wall time moves backwards", () => {
  const { root, runDir } = fixture();
  try {
    const eventsPath = join(runDir, "events.jsonl");
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse);
    events[2].at = "2026-08-25T23:59:59.000Z";
    for (let index = 0; index < events.length; index += 1) {
      events[index].prev_hash = events[index - 1]?.event_hash || null;
      events[index].event_hash = jsonlEntryHash(events[index]);
    }
    writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    const bundleDir = join(root, "bundle");
    exportRunBundle({ runDir, outputDir: bundleDir });
    const verified = verifyRunBundle({ bundleDir });
    assert.equal(verified.structure.status, "FAIL");
    assert.ok(verified.structure.errors.some((item) => item.code === "event_timestamp_not_monotonic"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bundle verification re-derives timing and catches a tampered ledger after manifest rehash", () => {
  const { root, runDir } = fixture();
  try {
    const bundleDir = join(root, "bundle");
    exportRunBundle({ runDir, outputDir: bundleDir });
    const ledgerPath = join(bundleDir, "payload", "timing-ledger.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    ledger.total.elapsed_ms += 1;
    writeJson(ledgerPath, ledger);
    refreshBundleManifestDigest(bundleDir, "payload/timing-ledger.json");
    const verified = verifyRunBundle({ bundleDir });
    assert.equal(verified.structure.status, "FAIL");
    assert.ok(
      verified.structure.errors.some((item) => item.code === "timing_ledger_mismatch"),
      "payload digests alone cannot bless a timing ledger that disagrees with status/evidence/events",
    );
    assert.equal(
      verified.structure.errors.some((item) => item.code === "payload_digest_mismatch"),
      false,
      "the adversary already refreshed the ordinary manifest digest",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observed worker timing events without a bundled ledger are an explicit claim blocker", () => {
  const { root, runDir } = fixture();
  try {
    const eventsPath = join(runDir, "events.jsonl");
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map(JSON.parse);
    events.splice(1, 0,
      {
        schema_version: 1,
        at: timingIso(100),
        type: "worker_attempt_started",
        invocation_key: "evidence:market_data:1",
        stage: "evidence",
        attempt: 1,
        attempt_kind: "primary",
        budget_ms: 1_000,
        search_enabled: true,
        started_at: timingIso(100),
        pid: 12_345,
      },
      {
        schema_version: 1,
        at: timingIso(500),
        type: "worker_attempt_finished",
        invocation_key: "evidence:market_data:1",
        stage: "evidence",
        attempt: 1,
        attempt_kind: "primary",
        budget_ms: 1_000,
        search_enabled: true,
        started_at: timingIso(100),
        finished_at: timingIso(500),
        elapsed_ms: 400,
        outcome: "completed",
        timed_out: false,
        forced_settle: false,
        pid: 12_345,
      },
    );
    const rebuilt = rehashTimingEvents(events);
    writeFileSync(eventsPath, `${rebuilt.map((event) => JSON.stringify(event)).join("\n")}\n`);

    const bundleDir = join(root, "bundle");
    exportRunBundle({ runDir, outputDir: bundleDir });
    rmSync(join(bundleDir, "payload", "timing-ledger.json"));
    const manifestPath = join(bundleDir, "bundle-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = manifest.files.filter((item) => item.path !== "payload/timing-ledger.json");
    manifest.total_payload_bytes = manifest.files.reduce((sum, item) => sum + item.byte_length, 0);
    writeJson(manifestPath, manifest);

    const verified = verifyRunBundle({ bundleDir });
    assert.equal(verified.structure.status, "PASS");
    assert.equal(verified.claim_readiness.status, "BLOCKED");
    assert.ok(
      verified.claim_readiness.blockers.some((item) => item.code === "timing_ledger_missing_for_observed_run"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy bundle without attempt events remains structurally valid when timing ledger is absent", () => {
  const { root, runDir } = fixture();
  try {
    const bundleDir = join(root, "bundle");
    exportRunBundle({ runDir, outputDir: bundleDir });
    rmSync(join(bundleDir, "payload", "timing-ledger.json"));
    const manifestPath = join(bundleDir, "bundle-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = manifest.files.filter((item) => item.path !== "payload/timing-ledger.json");
    manifest.total_payload_bytes = manifest.files.reduce((sum, item) => sum + item.byte_length, 0);
    writeJson(manifestPath, manifest);

    const verified = verifyRunBundle({ bundleDir });
    assert.equal(verified.structure.status, "PASS");
    assert.equal(
      verified.claim_readiness.blockers.some((item) => item.code === "timing_ledger_missing_for_observed_run"),
      false,
      "P1a-era bundles without worker attempt events must not be upgraded into a timing claim failure",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI exit codes keep structural verification separate from strict claim readiness", () => {
  const { root, runDir } = fixture();
  try {
    const bundleDir = join(root, "bundle");
    exportRunBundle({ runDir, outputDir: bundleDir });
    const ordinary = spawnSync(process.execPath, [VERIFY_CLI, "--bundle", bundleDir], { encoding: "utf8" });
    assert.equal(ordinary.status, 0, ordinary.stderr);
    assert.match(ordinary.stdout, /^structure: PASS$/mu);
    assert.match(ordinary.stdout, /^claim_readiness: BLOCKED/mu);
    const strict = spawnSync(process.execPath, [VERIFY_CLI, "--bundle", bundleDir, "--require-claim-ready"], { encoding: "utf8" });
    assert.equal(strict.status, 2, strict.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export refuses symlinked run artifacts and an existing output target", () => {
  const { root, runDir } = fixture();
  try {
    const target = join(runDir, "status.real.json");
    writeFileSync(target, readFileSync(join(runDir, "status.json")));
    rmSync(join(runDir, "status.json"));
    symlinkSync(target, join(runDir, "status.json"));
    assert.throws(() => exportRunBundle({ runDir, outputDir: join(root, "bundle") }), /symlink/iu);
    rmSync(join(runDir, "status.json"));
    writeFileSync(join(runDir, "status.json"), readFileSync(target));
    mkdirSync(join(root, "exists"));
    assert.throws(() => exportRunBundle({ runDir, outputDir: join(root, "exists") }), /already exists/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("export explains that an unpublished terminal run is not bundle-ready", () => {
  const { root, runDir } = fixture();
  try {
    rmSync(join(runDir, "publication_manifest.json"));
    assert.throws(
      () => exportRunBundle({ runDir, outputDir: join(root, "bundle") }),
      /not publication-ready.*report_quality\.json.*terminal failure ledger/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("26 renamed copies of one template are flagged by exploratory monitors, not certified as method collapse", () => {
  const opinions = CANONICAL_MASTER_IDS.map((master) => voice(
    master,
    "cautious",
    `I am ${master}; I repeat the same generic valuation template with only my seat name changed`,
  ));
  const result = analyzeSeatContent(opinions);
  assert.equal(result.similarity.status, "failed");
  assert.equal(result.similarity.decision_use, "monitor_only_unpreregistered");
  assert.ok(result.similarity.pairs_at_or_above_threshold > 0);
  assert.equal(result.length_variance.status, "failed");
  assert.equal(result.stance_distribution.status, "failed");
  const findings = seatContentMonitoringFindings(result);
  assert.deepEqual(findings.map(({ code }) => code), [
    "seat_text_similarity_monitor",
    "seat_text_length_monitor",
    "seat_stance_distribution_monitor",
  ]);
  assert.ok(findings.every(({ message }) => /not a fidelity or merge gate|repeated blinded cases/u.test(message)));
});
