import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  checkExternalHostE2eFile,
  computeExternalHostArtifactHash,
  externalHostCollectionPlan,
  preflightExternalHost,
  validateExternalHostE2eArtifact,
  writeExternalHostPreflightArtifact,
} from "../../scripts/lib/external-host-e2e-artifacts.mjs";
import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";

const H = (value) => sha256(value);
const PH = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function notRun() {
  const artifact = {
    schema_version: 1,
    artifact_kind: "alphacouncil_external_host_e2e_result",
    host_id: "claude_code",
    collected_at: "2026-07-27T00:00:00.000Z",
    status: "not_run",
    executable: { requested_name: "claude", resolved_path: null, file_hash: null, version: null, version_output_hash: null },
    package: { name: "alphacouncil-agent", version: "0.8.0", physical_artifact_path: null, physical_artifact_hash: null },
    catalog: { catalog_hash: null, catalog_order_hash: null, selected_master_ids: [], selected_pack_hashes: [] },
    selection_receipt: { receipt_binding_hash: null, confirmed: false, consumed_once: false, replay_rejected: false },
    result_bindings: {
      fact_artifact: { physical_artifact_path: null, physical_artifact_hash: null },
      deterministic_decision: { physical_artifact_path: null, physical_artifact_hash: null },
      report: { physical_artifact_path: null, physical_artifact_hash: null },
      report_quality: { physical_artifact_path: null, physical_artifact_hash: null },
    },
    preconditions: { credentials: "not_checked", repository_trust: "not_checked", external_run_authorization: { status: "not_checked", reference_hash: null } },
    capabilities: { mcp_handshake: "not_run", complete_catalog_display: "not_run", visible_subagents: "not_run", parallelism: "not_run", permissions: "not_run", resume: "not_run" },
    degradation: ["default runtime failed before host execution"],
    blockers: ["cli_runtime_failed", "credential_not_checked", "repository_trust_not_checked"],
    collector_initiated_paid_calls: false,
    artifact_hash: H("placeholder"),
    attestations: [],
  };
  artifact.artifact_hash = computeExternalHostArtifactHash(artifact);
  return artifact;
}

test("host collector defaults to plan-only and covers exactly four hosts", () => {
  const plan = externalHostCollectionPlan();
  assert.deepEqual(plan.host_order, ["claude_code", "codex", "opencode", "grok"]);
  assert.equal(plan.default_status, "not_run");
  assert.equal(plan.collector_initiated_paid_calls, false);
});

test("external host result schema is parseable and cannot contain collector attestations", () => {
  const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas/external-host-e2e-result-v1.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.host_id.enum, ["claude_code", "codex", "opencode", "grok"]);
  assert.equal(schema.properties.collector_initiated_paid_calls.const, false);
  assert.equal(schema.properties.attestations.maxItems, 0);
});

test("a concrete not_run blocker is valid and is not promoted to passed", () => {
  assert.equal(validateExternalHostE2eArtifact(notRun()).valid, true);
  const fabricated = notRun();
  fabricated.status = "passed";
  fabricated.blockers = [];
  fabricated.artifact_hash = computeExternalHostArtifactHash(fabricated);
  const result = validateExternalHostE2eArtifact(fabricated);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /actual executable/.test(error)));
  assert.ok(result.errors.some((error) => /physical fact, deterministic-decision/.test(error)));
});

test("passed host evidence opens and recomputes every physical result binding", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-host-physical-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, "host-cli");
  const tarball = join(dir, "package.tgz");
  writeFileSync(executable, "cli bytes\n", { mode: 0o700 });
  writeFileSync(tarball, "package bytes\n");
  const bindingFiles = {
    fact_artifact: "facts.json",
    deterministic_decision: "decision.json",
    report: "report.md",
    report_quality: "report-quality.json",
  };
  for (const [field, name] of Object.entries(bindingFiles)) writeFileSync(join(dir, name), `${field}\n`);
  const artifact = notRun();
  artifact.status = "passed";
  artifact.executable = {
    requested_name: "host-cli",
    resolved_path: executable,
    file_hash: PH(readFileSync(executable)),
    version: "fixture 1.0.0",
    version_output_hash: H("fixture 1.0.0"),
  };
  artifact.package = { name: "alphacouncil-agent", version: "0.9.0", physical_artifact_path: tarball, physical_artifact_hash: PH(readFileSync(tarball)) };
  artifact.catalog = { catalog_hash: H("catalog"), catalog_order_hash: H("order"), selected_master_ids: ["master_buffett"], selected_pack_hashes: [H("pack")] };
  artifact.selection_receipt = { receipt_binding_hash: H("receipt"), confirmed: true, consumed_once: true, replay_rejected: true };
  artifact.result_bindings = Object.fromEntries(Object.entries(bindingFiles).map(([field, name]) => [field, {
    physical_artifact_path: name,
    physical_artifact_hash: PH(readFileSync(join(dir, name))),
  }]));
  artifact.preconditions = { credentials: "verified", repository_trust: "verified", external_run_authorization: { status: "verified", reference_hash: H("authorization") } };
  artifact.capabilities = { mcp_handshake: "passed", complete_catalog_display: "passed", visible_subagents: "degraded", parallelism: "degraded", permissions: "passed", resume: "passed" };
  artifact.blockers = [];
  artifact.artifact_hash = computeExternalHostArtifactHash(artifact);
  const file = join(dir, "host-result.json");
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
  const checked = checkExternalHostE2eFile(file);
  assert.equal(checked.valid, true, checked.errors.join("; "));
  assert.equal(checked.verified_result_bindings.fact_artifact.physical_artifact_hash, artifact.result_bindings.fact_artifact.physical_artifact_hash);
  writeFileSync(join(dir, "facts.json"), "tampered\n");
  const tampered = checkExternalHostE2eFile(file);
  assert.equal(tampered.valid, false);
  assert.ok(tampered.errors.some((error) => /fact_artifact physical file hash mismatch/u.test(error)));
});

test("read-only preflight supports executable runtime and PATH overrides but stays not_run", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-preflight-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, "fixture-cli.js");
  writeFileSync(executable, "process.stdout.write('fixture 1.2.3\\n');\n", { mode: 0o700 });
  const preflight = preflightExternalHost({
    hostId: "codex",
    executable,
    runtime: process.execPath,
    pathOverride: "/usr/bin:/bin",
  });
  assert.equal(preflight.status, "not_run");
  assert.equal(preflight.collector_initiated_paid_calls, false);
  assert.ok(preflight.blockers.includes("external_execution_not_run"));
  assert.ok(preflight.degradation.some((item) => /PATH override/.test(item)));
  assert.ok(preflight.degradation.some((item) => /runtime override/.test(item)));
  assert.equal(preflight.executable.version, "fixture 1.2.3");
  assert.match(preflight.executable.version_output_hash, /^sha256:/);
  assert.equal(validateExternalHostE2eArtifact(preflight).valid, true);
});

test("explicit preflight save is exclusive and remains valid not_run evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-preflight-save-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const artifact = preflightExternalHost({ hostId: "opencode", executable: "missing-opencode-fixture", pathOverride: "/usr/bin:/bin" });
  const output = join(dir, "opencode-not-run.json");
  const saved = writeExternalHostPreflightArtifact(artifact, output);
  assert.equal(saved.status, "saved_not_run_preflight");
  assert.equal(saved.mode, process.platform === "win32" ? "windows_acl_not_verified" : "0600");
  assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "not_run");
  assert.throws(() => writeExternalHostPreflightArtifact(artifact, output), /overwrite/);
});

test("missing CLI preflight is not_run with cli_missing", () => {
  const result = preflightExternalHost({ hostId: "grok", executable: "definitely-no-such-alphacouncil-cli", pathOverride: "/usr/bin:/bin" });
  assert.equal(result.status, "not_run");
  assert.ok(result.blockers.includes("cli_missing"));
  assert.equal(result.executable.version, null);
  assert.equal(validateExternalHostE2eArtifact(result).valid, true);
});

test("host CLI checks a physical not_run result and does no execution", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-host-result-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "result.json");
  writeFileSync(file, `${JSON.stringify(notRun(), null, 2)}\n`);
  const check = spawnSync(process.execPath, ["scripts/host-e2e-artifacts.mjs", "--check", "--file", file], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const report = JSON.parse(check.stdout);
  assert.equal(report.valid, true);
  assert.equal(report.status, "not_run");
});

test("host CLI writes preflight only with explicit --write and refuses overwrite", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-host-preflight-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "grok-not-run.json");
  const args = ["scripts/host-e2e-artifacts.mjs", "--preflight", "--host", "grok", "--executable", "missing-grok-fixture", "--path", "/usr/bin:/bin", "--write", "--output", output];
  const first = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).mode, process.platform === "win32" ? "windows_acl_not_verified" : "0600");
  assert.equal(JSON.parse(readFileSync(output, "utf8")).status, "not_run");
  const second = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /overwrite/);
});

test("host artifact CLI makes the file-scoped npm check contract explicit", () => {
  const result = spawnSync(process.execPath, ["scripts/host-e2e-artifacts.mjs", "--help"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm run host:e2e:artifacts:check -- --file FILE/u);
});
