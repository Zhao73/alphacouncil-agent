import { CANONICAL_MASTER_COUNT } from "./staging.mjs";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { checkExternalHostE2eFile } from "../../../scripts/lib/external-host-e2e-artifacts.mjs";
import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";
import { verifyExperimentAdjudicationFile } from "./experiment-adjudication.mjs";
import { checkGaPackageArtifactFile } from "./ga-package-evidence.mjs";
import {
  RELEASE_EVIDENCE_HOST_IDS,
  verifyReleaseEvidenceDocument,
} from "./release-evidence.mjs";
import { verifyReleaseApprovalDocument } from "./release-approvals.mjs";
import {
  readPersonaReleasePointerHistory,
  resolveCurrentPersonaRelease,
  verifyPersonaRelease,
} from "./releases.mjs";

function physicalJson(file, label) {
  const absolute = resolve(file);
  if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a physical regular file`);
  const bytes = readFileSync(absolute);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch (error) {
    throw new Error(`${label} is invalid JSON (${error.message})`);
  }
  return {
    absolute: realpathSync(absolute),
    bytes,
    value,
    file_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    artifact_hash: sha256(value),
  };
}

function bindingPath(root, binding, label) {
  const target = resolve(root, binding?.relative_path || "");
  const back = relative(root, target);
  if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new Error(`${label} escapes the release-evidence root`);
  }
  if (existsSync(target)) {
    const physical = realpathSync(target);
    const physicalBack = relative(root, physical);
    if (physical !== target || physicalBack === ".." || physicalBack.startsWith(`..${sep}`)
      || isAbsolute(physicalBack)) {
      throw new Error(`${label} uses a symlinked path component or escapes the release-evidence root`);
    }
  }
  return target;
}

function same(left, right) { return canonicalJson(left) === canonicalJson(right); }

function failureResult(errors, details = {}) {
  return Object.freeze(canonicalValue({
    provided: true,
    status: "invalid",
    evidence_hash: details.evidence_hash || null,
    release_id: details.release_id || null,
    release_manifest_hash: details.release_manifest_hash || null,
    manifest_bound: false,
    signature_valid: Boolean(details.signature_valid),
    approver_key_ids: details.approver_key_ids || [],
    approver_principal_ids: details.approver_principal_ids || [],
    experiment: "failed",
    host: "failed",
    package: "failed",
    cutover: "failed",
    rollback: "failed",
    physical_artifact_hashes: {},
    errors,
  }));
}

function normalizedRelative(path) { return path.split(sep).join("/"); }

function boundJson(root, binding, label, expectedRelativePath = null) {
  const physical = physicalJson(bindingPath(root, binding, label), label);
  if (physical.file_hash !== binding.file_hash || physical.artifact_hash !== binding.artifact_hash) {
    throw new Error(`${label} does not match its signed physical binding`);
  }
  const actualRelative = normalizedRelative(relative(root, physical.absolute));
  if (expectedRelativePath !== null && actualRelative !== expectedRelativePath) {
    throw new Error(`${label} path=${actualRelative}; expected=${expectedRelativePath}`);
  }
  return physical;
}

function pointerHistoryRelative(version) {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("release-operation pointer version is invalid");
  return `pointers/${String(version).padStart(8, "0")}.json`;
}

function verifyBoundOperation({
  name,
  binding,
  root,
  history,
  trustedReleaseKeys,
  now,
}) {
  const pointerPhysical = boundJson(root, binding.pointer_history, `${name} pointer history`);
  const pointer = pointerPhysical.value;
  const recorded = history[pointer?.pointer_version - 1];
  if (!recorded || !same(recorded, pointer)) throw new Error(`${name} pointer is not in the validated monotonic history`);
  boundJson(
    root,
    binding.pointer_history,
    `${name} pointer history`,
    pointerHistoryRelative(pointer.pointer_version),
  );
  if (pointer.operation !== (name === "rollback" ? "rollback" : "cutover")) {
    throw new Error(`${name} pointer operation is invalid`);
  }
  if (!pointer.previous_release_id) throw new Error(`${name} pointer must bind a previous release`);

  const approval = boundJson(
    root,
    binding.approval,
    `${name} approval`,
    `approvals/${pointer.approval_hash.slice("sha256:".length)}.json`,
  );
  if (approval.artifact_hash !== pointer.approval_hash) throw new Error(`${name} approval hash differs from its pointer`);
  const approvalVerification = verifyReleaseApprovalDocument(approval.value, {
    trustedKeyRegistry: trustedReleaseKeys,
    expectedReleaseId: pointer.release_id,
    expectedManifestHash: pointer.release_manifest_hash,
    expectedOperation: pointer.operation,
    expectedPreviousReleaseId: pointer.previous_release_id,
    now,
  });
  if (!approvalVerification.valid) {
    throw new Error(`${name} approval failed external persona_release verification: ${approvalVerification.reason}`);
  }
  if (!same(approvalVerification.approver_key_ids, pointer.approver_key_ids)) {
    throw new Error(`${name} approval keys differ from its pointer`);
  }

  const manifest = boundJson(
    root,
    binding.release_manifest,
    `${name} release manifest`,
    `${pointer.release_id}/release-manifest.json`,
  );
  if (manifest.artifact_hash !== pointer.release_manifest_hash
    || manifest.value?.release_id !== pointer.release_id) {
    throw new Error(`${name} release manifest differs from its pointer`);
  }
  const previousRecord = history.slice(0, pointer.pointer_version - 1)
    .reverse().find((record) => record.release_id === pointer.previous_release_id);
  if (!previousRecord) throw new Error(`${name} previous release was never active`);
  const previousManifest = boundJson(
    root,
    binding.previous_release_manifest,
    `${name} previous release manifest`,
    `${pointer.previous_release_id}/release-manifest.json`,
  );
  if (previousManifest.artifact_hash !== previousRecord.release_manifest_hash
    || previousManifest.value?.release_id !== pointer.previous_release_id) {
    throw new Error(`${name} previous release manifest differs from pointer history`);
  }
  return Object.freeze({
    pointer,
    approval_principal_ids: approvalVerification.approver_principal_ids,
    approval_key_ids: approvalVerification.approver_key_ids,
    hashes: Object.freeze({
      pointer_history: pointerPhysical.file_hash,
      approval: approval.file_hash,
      release_manifest: manifest.file_hash,
      previous_release_manifest: previousManifest.file_hash,
    }),
  });
}

export function verifyPhysicalReleaseOperations({
  releaseRoot,
  releaseOperations,
  verifiedRelease,
  personaDir,
  inspectPack,
  trustedReleaseKeys,
  trustedSourceReviewerKeys,
  trustedFormulaReviewerKeys,
  now = new Date(),
} = {}) {
  const root = resolve(releaseRoot || "");
  if (!releaseRoot || !existsSync(root)) throw new Error("physical release root is required");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error("physical release root must be a non-symlinked directory");
  }
  const history = readPersonaReleasePointerHistory({ releaseRoot: root });
  const common = { root, history, trustedReleaseKeys, now };
  const cutover = verifyBoundOperation({ name: "cutover", binding: releaseOperations.cutover, ...common });
  const rollback = verifyBoundOperation({ name: "rollback", binding: releaseOperations.rollback, ...common });
  const finalCutover = verifyBoundOperation({ name: "final_cutover", binding: releaseOperations.final_cutover, ...common });
  if (rollback.pointer.pointer_version !== cutover.pointer.pointer_version + 1
    || finalCutover.pointer.pointer_version !== rollback.pointer.pointer_version + 1) {
    throw new Error("cutover, rollback and final cutover pointer versions must be contiguous and monotonic");
  }
  const candidateId = verifiedRelease.release_id;
  const candidateHash = verifiedRelease.release_manifest_hash;
  const oldReleaseId = cutover.pointer.previous_release_id;
  if (cutover.pointer.release_id !== candidateId || cutover.pointer.release_manifest_hash !== candidateHash) {
    throw new Error("cutover does not target the verified GA candidate");
  }
  if (rollback.pointer.release_id !== oldReleaseId
    || rollback.pointer.previous_release_id !== candidateId) {
    throw new Error("rollback does not restore the release that preceded the candidate cutover");
  }
  if (finalCutover.pointer.release_id !== candidateId
    || finalCutover.pointer.release_manifest_hash !== candidateHash
    || finalCutover.pointer.previous_release_id !== oldReleaseId) {
    throw new Error("final cutover does not reactivate the verified GA candidate after rollback");
  }
  const current = boundJson(root, releaseOperations.current_pointer, "current pointer", "current.json");
  if (!same(current.value, finalCutover.pointer)) throw new Error("current pointer is not the final verified candidate cutover");
  const marker = boundJson(root, releaseOperations.activation_marker, "activation marker", "cutover-ever.json");
  if (marker.value?.artifact_kind !== "persona_v3_cutover_ever_marker"
    || marker.value?.highest_pointer_version !== finalCutover.pointer.pointer_version
    || marker.value?.updated_at !== finalCutover.pointer.created_at) {
    throw new Error("activation marker is not monotonic through the final candidate cutover");
  }
  const runtime = resolveCurrentPersonaRelease({
    releaseRoot: root,
    ...(personaDir ? { personaDir } : {}),
    ...(inspectPack ? { inspectPack } : {}),
    trustedReleaseKeys,
    trustedReviewerKeys: trustedSourceReviewerKeys,
    trustedFormulaReviewerKeys,
    now,
  });
  if (runtime.release.release_id !== candidateId
    || runtime.release.release_manifest_hash !== candidateHash) {
    throw new Error("externally trusted runtime resolution did not select the verified GA candidate");
  }
  const oldRelease = verifyPersonaRelease({
    releaseId: oldReleaseId,
    releaseRoot: root,
    ...(personaDir ? { personaDir } : {}),
    ...(inspectPack ? { inspectPack } : {}),
    trustedReviewerKeys: trustedSourceReviewerKeys,
    trustedFormulaReviewerKeys,
  });
  return Object.freeze({
    valid: true,
    cutover: "passed",
    rollback: "passed",
    current_release_id: runtime.release.release_id,
    retained_release_id: oldRelease.release_id,
    approval_principal_ids: [...new Set([
      ...cutover.approval_principal_ids,
      ...rollback.approval_principal_ids,
      ...finalCutover.approval_principal_ids,
    ])].sort(),
    artifact_hashes: Object.freeze({
      cutover: cutover.hashes,
      rollback: rollback.hashes,
      final_cutover: finalCutover.hashes,
      current_pointer: current.file_hash,
      activation_marker: marker.file_hash,
    }),
  });
}

export function inspectGaExternalEvidence({
  releaseEvidencePath,
  verifiedRelease,
  expectedVersion,
  packageJsonPath,
  trustedReleaseEvidenceKeys,
  trustedExperimentAdjudicationKeys,
  releaseRoot,
  personaDir,
  trustedReleaseKeys,
  trustedSourceReviewerKeys,
  trustedFormulaReviewerKeys,
  now = new Date(),
} = {}) {
  if (!releaseEvidencePath) {
    return Object.freeze(canonicalValue({
      provided: false,
      status: "not_provided",
      evidence_hash: null,
      release_id: null,
      release_manifest_hash: null,
      manifest_bound: false,
      signature_valid: false,
      approver_key_ids: [],
      approver_principal_ids: [],
      experiment: "not_provided",
      host: "not_provided",
      package: "not_provided",
      cutover: "not_provided",
      rollback: "not_provided",
      physical_artifact_hashes: {},
      errors: [],
    }));
  }
  let physical;
  try { physical = physicalJson(releaseEvidencePath, "release evidence"); } catch (error) {
    return failureResult([error.message]);
  }
  const manifest = verifiedRelease?.release_manifest;
  if (verifiedRelease?.status !== "verified" || !manifest) {
    return failureResult(["release evidence requires a fully verified immutable release"], {
      evidence_hash: sha256(physical.value),
      release_id: physical.value?.release_id,
      release_manifest_hash: physical.value?.release_manifest_hash,
    });
  }
  const verified = verifyReleaseEvidenceDocument(physical.value, {
    trustedKeyRegistry: trustedReleaseEvidenceKeys,
    expectedReleaseId: verifiedRelease.release_id,
    expectedManifestHash: verifiedRelease.release_manifest_hash,
    expectedSourceReviewEvidenceHash: manifest.source_review_evidence?.evidence_hash,
    expectedVersion,
    now,
  });
  if (!verified.valid) {
    return failureResult([
      verified.reason || "release evidence verification failed",
      ...(verified.errors || []),
      ...(verified.failures || []).map((failure) => `${failure.signer_key_id}: ${failure.reason}`),
    ], {
      evidence_hash: sha256(physical.value),
      release_id: physical.value?.release_id,
      release_manifest_hash: physical.value?.release_manifest_hash,
    });
  }

  const errors = [];
  const root = dirname(physical.absolute);
  let experiment = null;
  let packageEvidence = null;
  const hosts = [];
  let releaseOperations = null;
  const artifactHashes = {};
  try {
    const experimentBinding = verified.artifacts.experiment_adjudication;
    experiment = verifyExperimentAdjudicationFile(
      bindingPath(root, experimentBinding, "experiment adjudication"),
      {
        trustedKeyRegistry: trustedExperimentAdjudicationKeys,
        expectedReleaseId: verifiedRelease.release_id,
        expectedManifestHash: verifiedRelease.release_manifest_hash,
        now,
      },
    );
    if (!experiment.valid) errors.push(`experiment adjudication failed: ${[experiment.reason, ...(experiment.errors || [])].filter(Boolean).join("; ")}`);
    if (experiment.file_hash !== experimentBinding.file_hash || experiment.artifact_hash !== experimentBinding.artifact_hash) errors.push("signed experiment-adjudication binding does not match its physical file");
    artifactHashes.experiment_adjudication = experiment.file_hash || null;

    const packageBinding = verified.artifacts.package;
    packageEvidence = checkGaPackageArtifactFile(bindingPath(root, packageBinding, "package artifact"), {
      packageJsonPath,
      expectedVersion,
    });
    if (!packageEvidence.valid) errors.push(`package artifact failed: ${packageEvidence.errors.join("; ")}`);
    if (packageEvidence.file_hash !== packageBinding.file_hash || packageEvidence.artifact_hash !== packageBinding.artifact_hash) errors.push("signed package-artifact binding does not match its physical file");
    artifactHashes.package = packageEvidence.file_hash || null;

    releaseOperations = verifyPhysicalReleaseOperations({
      releaseRoot,
      releaseOperations: verified.artifacts.release_operations,
      verifiedRelease,
      personaDir,
      trustedReleaseKeys,
      trustedSourceReviewerKeys,
      trustedFormulaReviewerKeys,
      now,
    });
    for (const [operation, hashes] of Object.entries(releaseOperations.artifact_hashes)) {
      if (typeof hashes === "string") artifactHashes[`release_operations.${operation}`] = hashes;
      else for (const [artifact, hash] of Object.entries(hashes)) {
        artifactHashes[`release_operations.${operation}.${artifact}`] = hash;
      }
    }

    for (const [index, binding] of verified.artifacts.external_hosts.entries()) {
      const checked = checkExternalHostE2eFile(bindingPath(root, binding, `host ${binding.host_id}`));
      hosts.push(checked);
      if (!checked.valid || checked.status !== "passed") errors.push(`${binding.host_id} external-host artifact is not a validated pass: ${checked.errors.join("; ")}`);
      if (checked.host_id !== RELEASE_EVIDENCE_HOST_IDS[index] || checked.host_id !== binding.host_id) errors.push(`${binding.host_id} external-host identity/order mismatch`);
      if (checked.file_hash !== binding.file_hash || checked.artifact_hash !== binding.artifact_hash) errors.push(`${binding.host_id} signed binding does not match its physical file`);
      artifactHashes[binding.host_id] = checked.file_hash || null;
    }
  } catch (error) {
    errors.push(error?.message || String(error));
  }

  if (hosts.length === RELEASE_EVIDENCE_HOST_IDS.length && packageEvidence?.artifact) {
    const hostDocuments = hosts.map((host) => host.artifact);
    const packageArtifact = packageEvidence.artifact;
    const physicalCatalog = packageEvidence.derived_catalog;
    const baseline = hostDocuments[0];
    const resultHashes = (bindings) => Object.fromEntries(Object.entries(bindings || {}).map(([field, binding]) => [
      field,
      binding?.physical_artifact_hash || binding?.file_hash || null,
    ]));
    const baselineResults = resultHashes(hosts[0].verified_result_bindings);
    const packageResults = resultHashes(packageEvidence.verified_result_bindings);
    if (!physicalCatalog) errors.push("package GA evidence did not derive a 26-pack catalog from a safely installed physical tarball");
    for (const [index, host] of hostDocuments.entries()) {
      const label = RELEASE_EVIDENCE_HOST_IDS[index];
      if (host.package?.name !== packageEvidence.package_name) errors.push(`${label} package name differs from the package artifact`);
      if (host.package?.version !== expectedVersion) errors.push(`${label} package version does not equal expected version ${expectedVersion}`);
      if (hosts[index].verified_package_hash !== packageEvidence.tarball_hash) errors.push(`${label} recomputed package hash differs from the physical package tarball`);
      for (const field of ["catalog_hash", "catalog_order_hash", "selected_master_ids", "selected_pack_hashes"]) {
        if (!same(host.catalog?.[field], baseline.catalog?.[field])) errors.push(`${label} catalog.${field} differs across hosts`);
        if (!same(host.catalog?.[field], physicalCatalog?.[field])) errors.push(`${label} catalog.${field} differs from the safely installed physical package`);
      }
      if (host.selection_receipt?.receipt_binding_hash !== baseline.selection_receipt?.receipt_binding_hash
        || host.selection_receipt?.receipt_binding_hash !== packageArtifact.selection_receipt?.receipt_binding_hash) {
        errors.push(`${label} receipt binding differs across host/package evidence`);
      }
      const openedResults = resultHashes(hosts[index].verified_result_bindings);
      if (!same(openedResults, baselineResults) || !same(openedResults, packageResults)) {
        errors.push(`${label} recomputed physical result hashes differ across host/package evidence`);
      }
    }
    if (packageEvidence.package_version !== expectedVersion) errors.push(`package artifact version does not equal expected version ${expectedVersion}`);
    if (packageEvidence.source_package?.version !== expectedVersion) errors.push(`repository package.json version does not equal expected version ${expectedVersion}`);
    if (packageEvidence.tarball_package?.version !== expectedVersion) errors.push(`tarball package.json version does not equal expected version ${expectedVersion}`);
    if (packageArtifact.release_id !== verifiedRelease.release_id
      || packageArtifact.release_manifest_hash !== verifiedRelease.release_manifest_hash) {
      errors.push("package artifact is not bound to the verified immutable release");
    }
  }

  const releaseIds = manifest.canonical_master_ids || [];
  const releasePackHashes = (manifest.packs || []).map((pack) => pack.pack_hash);
  const releaseVersions = (manifest.packs || []).map((pack) => pack.pack_version);
  if (releaseVersions.length !== CANONICAL_MASTER_COUNT || releaseVersions.some((version) => version !== expectedVersion)) {
    errors.push(`all 26 immutable release pack versions must equal ${expectedVersion}`);
  }
  if (packageEvidence?.artifact) {
    if (!same(packageEvidence.derived_catalog?.selected_master_ids, releaseIds)) errors.push("installed package selected master IDs/order differ from the release manifest");
    if (!same(packageEvidence.derived_catalog?.selected_pack_hashes, releasePackHashes)) errors.push("installed package selected pack hashes differ from the release manifest");
  }
  if (experiment?.valid && !same(experiment.release_claims, physical.value.claims?.release_claims)
    && Object.hasOwn(physical.value.claims || {}, "release_claims")) {
    errors.push("release-evidence claims differ from the experiment adjudication");
  }

  const status = errors.length ? "invalid" : "valid";
  return Object.freeze(canonicalValue({
    provided: true,
    status,
    evidence_hash: verified.evidence_hash,
    release_id: verified.release_id,
    release_manifest_hash: verified.release_manifest_hash,
    manifest_bound: verified.release_id === verifiedRelease.release_id
      && verified.release_manifest_hash === verifiedRelease.release_manifest_hash,
    signature_valid: true,
    approver_key_ids: verified.approver_key_ids,
    approver_principal_ids: verified.approver_principal_ids,
    experiment: status === "valid" ? verified.statuses.experiment : "failed",
    host: status === "valid" ? verified.statuses.host : "failed",
    package: status === "valid" ? verified.statuses.package : "failed",
    cutover: status === "valid" && releaseOperations?.valid ? "passed" : "failed",
    rollback: status === "valid" && releaseOperations?.valid ? "passed" : "failed",
    physical_artifact_hashes: artifactHashes,
    errors,
  }));
}
