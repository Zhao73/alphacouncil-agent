import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import {
  EXPERIMENT_ADJUDICATION_PURPOSE,
  EXPERIMENT_HUMAN_REFERENCE_BOUNDARY,
  signExperimentAdjudication,
  validateExperimentAdjudicationDocument,
  verifyExperimentAdjudicationFile,
} from "../../mcp/lib/personas-v3/experiment-adjudication.mjs";
import {
  computeGaPackageArtifactHash,
  checkGaPackageArtifactFile,
  stripNpmDryRunEnv,
  validateGaPackageArtifact,
} from "../../mcp/lib/personas-v3/ga-package-evidence.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-ga-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function hash(name) { return sha256({ fixture: "ga-external", name }); }

test("physical package installs ignore inherited npm dry-run settings only", () => {
  const env = stripNpmDryRunEnv({
    npm_config_dry_run: "true",
    NPM_CONFIG_DRY_RUN: "true",
    Npm_Config_Dry_Run: "true",
    npm_config_offline: "true",
    PATH: "/fixture/bin",
  });
  assert.deepEqual(env, {
    npm_config_offline: "true",
    PATH: "/fixture/bin",
  });
});

function experimentDocument() {
  const binding = (name) => ({ relative_path: `${name}.json`, file_hash: hash(`${name}:file`), artifact_hash: hash(`${name}:artifact`) });
  return {
    schema_version: 1,
    artifact_kind: "persona_v3_experiment_adjudication",
    release_id: "0.9.0-rc.1",
    release_manifest_hash: hash("release-manifest"),
    adjudicated_at: "2026-07-27T10:00:00.000Z",
    adjudicator_id: "External Experiment Adjudicator",
    registered_protocol: { relative_path: "registered-protocol.json", file_hash: hash("protocol:file"), protocol_hash: hash("protocol") },
    case_freeze: binding("case-freeze"),
    result_manifest: binding("result-manifest"),
    runs: ["A", "B", "C", "D13", "D26", "E:D13", "E:D26", "H"].map((runKey) => ({ run_key: runKey, ...binding(`run-${runKey.replace(":", "-")}`) })),
    promotion_thresholds: { fact_accuracy_delta_minimum: 0.02 },
    multiplicity_policy: { family: "holm", family_wise_alpha: 0.05 },
    human_reference_boundary: EXPERIMENT_HUMAN_REFERENCE_BOUNDARY,
    release_claims: ["persona_v3_release_supported"],
    decision: "passed",
  };
}

test("experiment adjudication requires a trusted purpose-bound external signature and physical evidence", (t) => {
  const root = workspace(t);
  const signer = generateKeyPairSync("ed25519");
  const unsigned = experimentDocument();
  const document = signExperimentAdjudication(unsigned, {
    privateKey: signer.privateKey,
    signerKeyId: "experiment:key-1",
    signedAt: "2026-07-27T10:01:00.000Z",
  });
  assert.deepEqual(validateExperimentAdjudicationDocument(document, {
    expectedReleaseId: unsigned.release_id,
    expectedManifestHash: unsigned.release_manifest_hash,
    now: new Date("2026-07-27T11:00:00.000Z"),
  }), []);
  const file = join(root, "experiment-adjudication.json");
  writeJson(file, document);
  const trusted = {
    "experiment:key-1": {
      public_key: signer.publicKey,
      principal_id: unsigned.adjudicator_id,
      purposes: [EXPERIMENT_ADJUDICATION_PURPOSE],
    },
  };
  const missingPhysical = verifyExperimentAdjudicationFile(file, {
    trustedKeyRegistry: trusted,
    now: new Date("2026-07-27T11:00:00.000Z"),
  });
  assert.equal(missingPhysical.valid, false);
  assert.equal(missingPhysical.reason, "experiment_physical_evidence_failed");
  assert.ok(missingPhysical.errors.some((error) => /registered protocol is missing/u.test(error)));

  const wrongPurpose = verifyExperimentAdjudicationFile(file, {
    trustedKeyRegistry: {
      "experiment:key-1": {
        public_key: signer.publicKey,
        principal_id: unsigned.adjudicator_id,
        purposes: ["persona_release_evidence"],
      },
    },
    now: new Date("2026-07-27T11:00:00.000Z"),
  });
  assert.equal(wrongPurpose.valid, false);
  assert.equal(wrongPurpose.reason, "unauthorized_purpose");
});

test("experiment claim tampering and incomplete run coverage fail before signature trust", () => {
  const document = experimentDocument();
  document.attestation = { signer_key_id: "experiment:key-1", signed_at: "2026-07-27T10:01:00.000Z", signature: `ed25519:${"A".repeat(86)}` };
  const missingRun = { ...document, runs: document.runs.slice(0, 7) };
  assert.ok(validateExperimentAdjudicationDocument(missingRun).some((error) => /exactly eight/u.test(error)));
  const driftedBoundary = { ...document, human_reference_boundary: { ...document.human_reference_boundary, automated_vote: true } };
  assert.ok(validateExperimentAdjudicationDocument(driftedBoundary).some((error) => /H boundary/u.test(error)));
  const noClaims = { ...document, release_claims: [] };
  assert.ok(validateExperimentAdjudicationDocument(noClaims).some((error) => /explicit release claims/u.test(error)));
});

test("package artifact opens every shipped repository/tarball version surface and fails closed on drift", (t) => {
  const root = workspace(t);
  const packageRoot = join(root, "package");
  mkdirSync(packageRoot);
  const packageJson = join(root, "package.json");
  const packageValue = { name: "alphacouncil-agent", version: "0.9.0" };
  const metadata = {
    "package.json": packageValue,
    ".claude-plugin/plugin.json": { name: "alphacouncil-agent", version: "0.9.0" },
    ".codex-plugin/plugin.json": { name: "alphacouncil-agent", version: "0.9.0" },
    ".claude-plugin/marketplace.json": {
      metadata: { version: "0.9.0" },
      plugins: [{ name: "alphacouncil-agent", version: "0.9.0" }],
    },
  };
  for (const [relativePath, value] of Object.entries(metadata)) {
    writeJson(join(root, relativePath), value);
    writeJson(join(packageRoot, relativePath), value);
  }
  const tarball = join(root, "alphacouncil-agent-0.9.0.tgz");
  const packed = spawnSync("tar", ["-czf", tarball, "package"], { cwd: root, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const sourceBytes = readFileSync(packageJson);
  const tarPackageBytes = readFileSync(join(packageRoot, "package.json"));
  const physicalHash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const resultFiles = {
    fact_artifact: "facts.json",
    deterministic_decision: "decision.json",
    report: "report.md",
    report_quality: "report-quality.json",
  };
  for (const [field, name] of Object.entries(resultFiles)) writeFileSync(join(root, name), `${field}\n`);
  const artifact = {
    schema_version: 1,
    artifact_kind: "persona_v3_ga_package_artifact",
    generated_at: "2026-07-27T10:00:00.000Z",
    status: "passed",
    release_id: "0.9.0-rc.1",
    release_manifest_hash: hash("release-manifest"),
    package: {
      name: packageValue.name,
      version: packageValue.version,
      package_json_file_hash: physicalHash(sourceBytes),
      tarball_path: "alphacouncil-agent-0.9.0.tgz",
      tarball_file_hash: physicalHash(readFileSync(tarball)),
      tarball_package_json_hash: physicalHash(tarPackageBytes),
    },
    catalog: {
      catalog_hash: hash("catalog"),
      catalog_order_hash: hash("catalog-order"),
      selected_master_ids: ["master_buffett"],
      selected_pack_hashes: [hash("master_buffett")],
    },
    selection_receipt: { receipt_binding_hash: hash("receipt") },
    result_bindings: Object.fromEntries(Object.entries(resultFiles).map(([field, relativePath]) => [field, {
      relative_path: relativePath,
      file_hash: physicalHash(readFileSync(join(root, relativePath))),
    }])),
    artifact_hash: null,
    attestations: [],
  };
  artifact.artifact_hash = computeGaPackageArtifactHash(artifact);
  assert.equal(validateGaPackageArtifact(artifact).valid, true);
  const artifactFile = join(root, "package-artifact.json");
  writeJson(artifactFile, artifact);
  const checked = checkGaPackageArtifactFile(artifactFile, {
    packageJsonPath: packageJson,
    expectedVersion: "0.9.0",
  });
  assert.equal(checked.valid, true, checked.errors.join("; "));
  assert.equal(checked.package_version, "0.9.0");
  assert.equal(checked.tarball_hash, artifact.package.tarball_file_hash);
  assert.equal(checked.verified_result_bindings.fact_artifact.file_hash, artifact.result_bindings.fact_artifact.file_hash);
  assert.equal(checked.version_metadata.length, 4);
  assert.equal(checked.version_metadata
    .find((entry) => entry.relative_path === ".claude-plugin/marketplace.json")
    .repository_versions.length, 2);

  writeFileSync(join(root, "facts.json"), "tampered\n");
  const resultTamper = checkGaPackageArtifactFile(artifactFile, {
    packageJsonPath: packageJson,
    expectedVersion: "0.9.0",
  });
  assert.equal(resultTamper.valid, false);
  assert.ok(resultTamper.errors.some((error) => /fact_artifact physical file hash mismatch/u.test(error)));
  writeFileSync(join(root, "facts.json"), "fact_artifact\n");

  writeJson(packageJson, { ...packageValue, version: "0.8.0" });
  const mismatch = checkGaPackageArtifactFile(artifactFile, {
    packageJsonPath: packageJson,
    expectedVersion: "0.9.0",
  });
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.errors.some((error) => /physical repository package.json|differs from repository/u.test(error)));

  writeJson(packageJson, packageValue);
  writeJson(join(root, ".codex-plugin/plugin.json"), { name: "alphacouncil-agent", version: "0.8.0" });
  const repositoryDrift = checkGaPackageArtifactFile(artifactFile, {
    packageJsonPath: packageJson,
    expectedVersion: "0.9.0",
  });
  assert.equal(repositoryDrift.valid, false);
  assert.ok(repositoryDrift.errors.some((error) => /repository \.codex-plugin\/plugin\.json\.version=0\.8\.0; expected=0\.9\.0/u.test(error)));

  writeJson(join(root, ".codex-plugin/plugin.json"), metadata[".codex-plugin/plugin.json"]);
  writeJson(join(packageRoot, ".claude-plugin/marketplace.json"), {
    metadata: { version: "0.9.0" },
    plugins: [{ name: "alphacouncil-agent", version: "0.8.0" }],
  });
  const repacked = spawnSync("tar", ["-czf", tarball, "package"], { cwd: root, encoding: "utf8" });
  assert.equal(repacked.status, 0, repacked.stderr);
  artifact.package.tarball_file_hash = physicalHash(readFileSync(tarball));
  artifact.artifact_hash = computeGaPackageArtifactHash(artifact);
  writeJson(artifactFile, artifact);
  const tarballDrift = checkGaPackageArtifactFile(artifactFile, {
    packageJsonPath: packageJson,
    expectedVersion: "0.9.0",
  });
  assert.equal(tarballDrift.valid, false);
  assert.ok(tarballDrift.errors.some((error) => /tarball \.claude-plugin\/marketplace\.json\.plugins\[0\]\.version=0\.8\.0; expected=0\.9\.0/u.test(error)));

  rmSync(join(packageRoot, ".codex-plugin/plugin.json"));
  const repackedMissing = spawnSync("tar", ["-czf", tarball, "package"], { cwd: root, encoding: "utf8" });
  assert.equal(repackedMissing.status, 0, repackedMissing.stderr);
  artifact.package.tarball_file_hash = physicalHash(readFileSync(tarball));
  artifact.artifact_hash = computeGaPackageArtifactHash(artifact);
  writeJson(artifactFile, artifact);
  const unshipped = checkGaPackageArtifactFile(artifactFile, {
    packageJsonPath: packageJson,
    expectedVersion: "0.9.0",
  });
  assert.equal(unshipped.valid, false);
  assert.ok(unshipped.errors.some((error) => /does not contain readable package\/\.codex-plugin\/plugin\.json/u.test(error)));
});

test("a full-roster GA claim is derived from a safely installed physical tarball", (t) => {
  const root = workspace(t);
  const packageRoot = join(root, "package");
  const packageValue = { name: "alphacouncil-agent", version: "0.9.0" };
  const metadata = {
    "package.json": packageValue,
    ".claude-plugin/plugin.json": { name: packageValue.name, version: packageValue.version },
    ".codex-plugin/plugin.json": { name: packageValue.name, version: packageValue.version },
    ".claude-plugin/marketplace.json": { metadata: { version: packageValue.version }, plugins: [{ name: packageValue.name, version: packageValue.version }] },
  };
  for (const [relativePath, value] of Object.entries(metadata)) {
    writeJson(join(root, relativePath), value);
    writeJson(join(packageRoot, relativePath), value);
  }
  const ids = Array.from({ length: CANONICAL_MASTER_COUNT }, (_, index) => `master_fixture_${String(index + 1).padStart(2, "0")}`);
  const packHashes = ids.map((id) => hash(`pack:${id}`));
  const releaseId = "0.9.0-rc.1";
  const catalogHash = hash("installed-canonical-catalog");
  writeJson(join(packageRoot, "knowledge", "persona-releases", releaseId, "manifest.json"), {
    schema_version: 1,
    artifact_kind: "persona_v3_release_manifest",
    release_id: releaseId,
    canonical_master_count: CANONICAL_MASTER_COUNT,
    canonical_master_ids: ids,
    canonical_catalog_hash: catalogHash,
    packs: ids.map((personaId, index) => ({ persona_id: personaId, pack_hash: packHashes[index] })),
  });
  const resultFiles = {
    fact_artifact: "facts.json",
    deterministic_decision: "decision.json",
    report: "report.md",
    report_quality: "report-quality.json",
  };
  for (const [field, relativePath] of Object.entries(resultFiles)) writeFileSync(join(root, relativePath), `${field}\n`);
  const tarball = join(root, "alphacouncil-agent-0.9.0.tgz");
  const packed = spawnSync("tar", ["-czf", tarball, "package"], { cwd: root, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const rawHash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const artifact = {
    schema_version: 1,
    artifact_kind: "persona_v3_ga_package_artifact",
    generated_at: "2026-07-27T10:00:00.000Z",
    status: "passed",
    release_id: releaseId,
    release_manifest_hash: hash("release-manifest"),
    package: {
      name: packageValue.name,
      version: packageValue.version,
      package_json_file_hash: rawHash(readFileSync(join(root, "package.json"))),
      tarball_path: "alphacouncil-agent-0.9.0.tgz",
      tarball_file_hash: rawHash(readFileSync(tarball)),
      tarball_package_json_hash: rawHash(readFileSync(join(packageRoot, "package.json"))),
    },
    catalog: {
      catalog_hash: catalogHash,
      catalog_order_hash: sha256(ids),
      selected_master_ids: ids,
      selected_pack_hashes: packHashes,
    },
    selection_receipt: { receipt_binding_hash: hash("receipt") },
    result_bindings: Object.fromEntries(Object.entries(resultFiles).map(([field, relativePath]) => [field, {
      relative_path: relativePath,
      file_hash: rawHash(readFileSync(join(root, relativePath))),
    }])),
    artifact_hash: null,
    attestations: [],
  };
  artifact.artifact_hash = computeGaPackageArtifactHash(artifact);
  const artifactFile = join(root, "package-artifact.json");
  writeJson(artifactFile, artifact);
  const checked = checkGaPackageArtifactFile(artifactFile, { packageJsonPath: join(root, "package.json"), expectedVersion: "0.9.0" });
  assert.equal(checked.valid, true, checked.errors.join("; "));
  assert.deepEqual(checked.derived_catalog.selected_master_ids, ids);
  assert.deepEqual(checked.derived_catalog.selected_pack_hashes, packHashes);

  artifact.catalog.selected_pack_hashes[0] = hash("invented-pack-hash");
  artifact.artifact_hash = computeGaPackageArtifactHash(artifact);
  writeJson(artifactFile, artifact);
  const invented = checkGaPackageArtifactFile(artifactFile, { packageJsonPath: join(root, "package.json"), expectedVersion: "0.9.0" });
  assert.equal(invented.valid, false);
  assert.ok(invented.errors.some((error) => /differ from the safely installed physical tarball/u.test(error)));
});
