import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, closeSync, copyFileSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";

export const EXTERNAL_HOST_IDS = Object.freeze(["claude_code", "codex", "opencode", "grok"]);
export const EXTERNAL_E2E_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HASH = /^sha256:[a-f0-9]{64}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const RESULT_BINDING_KEYS = Object.freeze([
  "fact_artifact",
  "deterministic_decision",
  "report",
  "report_quality",
]);

export class HostE2eArtifactError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "HostE2eArtifactError";
    this.errors = errors;
  }
}

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, expected, path, errors) {
  if (!isObject(value)) { errors.push(`${path} must be an object`); return false; }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const missing = wanted.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !wanted.includes(key));
  if (missing.length) errors.push(`${path} missing fields: ${missing.join(", ")}`);
  if (extra.length) errors.push(`${path} unknown fields: ${extra.join(", ")}`);
  return missing.length === 0 && extra.length === 0;
}
function hash(value, path, errors, nullable = false) {
  if (nullable && value === null) return;
  if (!HASH.test(value || "")) errors.push(`${path} must be a canonical sha256 hash${nullable ? " or null" : ""}`);
}
function string(value, path, errors, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !value.trim()) errors.push(`${path} must be a non-empty string${nullable ? " or null" : ""}`);
}
function date(value, path, errors) {
  if (!DATE.test(value || "") || Number.isNaN(Date.parse(value))) errors.push(`${path} must be a UTC date-time`);
}
function safePhysicalPath(value, path, errors, nullable = false) {
  if (nullable && value === null) return;
  string(value, path, errors);
  if (typeof value === "string" && !isAbsolute(value) && value.split(/[\\/]/u).includes("..")) {
    errors.push(`${path} must be an absolute path or a safe relative path`);
  }
}
function validatePhysicalBinding(value, path, errors) {
  if (!exactKeys(value, ["physical_artifact_path", "physical_artifact_hash"], path, errors)) return;
  safePhysicalPath(value.physical_artifact_path, `${path}.physical_artifact_path`, errors, true);
  hash(value.physical_artifact_hash, `${path}.physical_artifact_hash`, errors, true);
  if ((value.physical_artifact_path === null) !== (value.physical_artifact_hash === null)) {
    errors.push(`${path} physical path and hash must either both be null or both be present`);
  }
}

export function externalHostArtifactSubject(artifact) {
  const { artifact_hash: ignoredHash, attestations: ignoredAttestations, ...subject } = artifact;
  return canonicalValue(subject);
}

export function computeExternalHostArtifactHash(artifact) {
  return sha256({ hash_domain: "alphacouncil.external-host-e2e-result.v1", subject: externalHostArtifactSubject(artifact) });
}

export function validateExternalHostE2eArtifact(artifact) {
  const errors = [];
  if (!exactKeys(artifact, [
    "schema_version", "artifact_kind", "host_id", "collected_at", "status", "executable", "package",
    "catalog", "selection_receipt", "result_bindings", "preconditions", "capabilities", "degradation", "blockers",
    "collector_initiated_paid_calls", "artifact_hash", "attestations",
  ], "artifact", errors)) return { valid: false, errors };
  if (artifact.schema_version !== 1) errors.push("schema_version must be 1");
  if (artifact.artifact_kind !== "alphacouncil_external_host_e2e_result") errors.push("artifact_kind is invalid");
  if (!EXTERNAL_HOST_IDS.includes(artifact.host_id)) errors.push(`host_id must be one of ${EXTERNAL_HOST_IDS.join(", ")}`);
  date(artifact.collected_at, "collected_at", errors);
  if (!["passed", "failed", "not_run"].includes(artifact.status)) errors.push("status must be passed, failed or not_run");
  if (artifact.collector_initiated_paid_calls !== false) errors.push("collector_initiated_paid_calls must be false for this import-only collector");
  if (!Array.isArray(artifact.attestations) || artifact.attestations.length !== 0) errors.push("attestations must remain empty; collector cannot self-certify");

  if (exactKeys(artifact.executable, ["requested_name", "resolved_path", "file_hash", "version", "version_output_hash"], "executable", errors)) {
    string(artifact.executable.requested_name, "executable.requested_name", errors);
    for (const field of ["resolved_path", "version"]) string(artifact.executable[field], `executable.${field}`, errors, true);
    for (const field of ["file_hash", "version_output_hash"]) hash(artifact.executable[field], `executable.${field}`, errors, true);
    if (artifact.executable.resolved_path !== null && !isAbsolute(artifact.executable.resolved_path)) errors.push("executable.resolved_path must be absolute when recorded");
    if (artifact.executable.version !== null && artifact.executable.version_output_hash !== sha256(artifact.executable.version)) errors.push("executable.version_output_hash must bind the exact recorded version output");
  }
  if (exactKeys(artifact.package, ["name", "version", "physical_artifact_path", "physical_artifact_hash"], "package", errors)) {
    string(artifact.package.name, "package.name", errors);
    string(artifact.package.version, "package.version", errors, true);
    string(artifact.package.physical_artifact_path, "package.physical_artifact_path", errors, true);
    if (artifact.package.physical_artifact_path !== null && !isAbsolute(artifact.package.physical_artifact_path || "")) errors.push("package.physical_artifact_path must be absolute when recorded");
    hash(artifact.package.physical_artifact_hash, "package.physical_artifact_hash", errors, true);
  }
  if (exactKeys(artifact.catalog, ["catalog_hash", "catalog_order_hash", "selected_master_ids", "selected_pack_hashes"], "catalog", errors)) {
    for (const field of ["catalog_hash", "catalog_order_hash"]) hash(artifact.catalog[field], `catalog.${field}`, errors, true);
    if (!Array.isArray(artifact.catalog.selected_master_ids) || !Array.isArray(artifact.catalog.selected_pack_hashes) || artifact.catalog.selected_master_ids.length !== artifact.catalog.selected_pack_hashes.length) errors.push("catalog selected IDs and pack hashes must be equal-length arrays");
    artifact.catalog.selected_master_ids?.forEach((id, index) => string(id, `catalog.selected_master_ids[${index}]`, errors));
    artifact.catalog.selected_pack_hashes?.forEach((value, index) => hash(value, `catalog.selected_pack_hashes[${index}]`, errors));
  }
  if (exactKeys(artifact.selection_receipt, ["receipt_binding_hash", "confirmed", "consumed_once", "replay_rejected"], "selection_receipt", errors)) {
    hash(artifact.selection_receipt.receipt_binding_hash, "selection_receipt.receipt_binding_hash", errors, true);
    for (const field of ["confirmed", "consumed_once", "replay_rejected"]) if (typeof artifact.selection_receipt[field] !== "boolean") errors.push(`selection_receipt.${field} must be boolean`);
  }
  if (exactKeys(artifact.result_bindings, RESULT_BINDING_KEYS, "result_bindings", errors)) {
    for (const field of RESULT_BINDING_KEYS) validatePhysicalBinding(artifact.result_bindings[field], `result_bindings.${field}`, errors);
  }
  if (exactKeys(artifact.preconditions, ["credentials", "repository_trust", "external_run_authorization"], "preconditions", errors)) {
    for (const field of ["credentials", "repository_trust"]) if (!["verified", "missing", "not_checked"].includes(artifact.preconditions[field])) errors.push(`preconditions.${field} has invalid status`);
    if (exactKeys(artifact.preconditions.external_run_authorization, ["status", "reference_hash"], "preconditions.external_run_authorization", errors)) {
      if (!["verified", "missing", "not_checked"].includes(artifact.preconditions.external_run_authorization.status)) errors.push("preconditions.external_run_authorization.status is invalid");
      hash(artifact.preconditions.external_run_authorization.reference_hash, "preconditions.external_run_authorization.reference_hash", errors, true);
      if (artifact.preconditions.external_run_authorization.status === "verified" && artifact.preconditions.external_run_authorization.reference_hash === null) errors.push("verified external run authorization requires reference_hash");
      if (artifact.preconditions.external_run_authorization.status !== "verified" && artifact.preconditions.external_run_authorization.reference_hash !== null) errors.push("unverified external run authorization cannot carry reference_hash");
    }
  }
  if (exactKeys(artifact.capabilities, ["mcp_handshake", "complete_catalog_display", "visible_subagents", "parallelism", "permissions", "resume"], "capabilities", errors)) {
    for (const field of Object.keys(artifact.capabilities)) {
      if (!["passed", "failed", "not_run", "degraded"].includes(artifact.capabilities[field])) errors.push(`capabilities.${field} has invalid status`);
    }
  }
  for (const field of ["degradation", "blockers"]) {
    if (!Array.isArray(artifact[field])) errors.push(`${field} must be an array`);
    else artifact[field].forEach((item, index) => string(item, `${field}[${index}]`, errors));
  }

  const requiredLiveHashes = [
    artifact.catalog?.catalog_hash, artifact.catalog?.catalog_order_hash,
    artifact.selection_receipt?.receipt_binding_hash,
    ...RESULT_BINDING_KEYS.map((field) => artifact.result_bindings?.[field]?.physical_artifact_hash),
  ];
  if (artifact.status === "passed") {
    if (artifact.executable?.resolved_path === null || artifact.executable?.version === null || artifact.executable?.file_hash === null || artifact.executable?.version_output_hash === null) errors.push("passed requires the actual executable path, version, file hash and version-output hash");
    if (requiredLiveHashes.some((value) => !HASH.test(value || ""))
      || RESULT_BINDING_KEYS.some((field) => !artifact.result_bindings?.[field]?.physical_artifact_path)) {
      errors.push("passed requires catalog, receipt and physical fact, deterministic-decision, report and report-quality path/hash bindings");
    }
    if (artifact.package?.physical_artifact_path === null || !HASH.test(artifact.package?.physical_artifact_hash || "")) errors.push("passed requires a physical package path and hash");
    if (artifact.package?.version === null) errors.push("passed requires the installed package version");
    if (artifact.selection_receipt?.confirmed !== true || artifact.selection_receipt?.consumed_once !== true || artifact.selection_receipt?.replay_rejected !== true) errors.push("passed requires confirmation, one-use consumption and replay rejection");
    if (artifact.capabilities?.mcp_handshake !== "passed" || artifact.capabilities?.complete_catalog_display !== "passed") errors.push("passed requires MCP handshake and complete catalog display");
    if (artifact.preconditions?.credentials !== "verified" || artifact.preconditions?.repository_trust !== "verified" || artifact.preconditions?.external_run_authorization?.status !== "verified") errors.push("passed requires verified credentials, repository trust and external run authorization");
    if (artifact.blockers.length) errors.push("passed cannot contain blockers");
    if (Object.values(artifact.capabilities || {}).some((value) => value === "failed" || value === "not_run")) errors.push("passed cannot contain failed or not_run capabilities");
  }
  if (artifact.status === "not_run") {
    if (!artifact.blockers.length) errors.push("not_run requires a concrete missing CLI, credential, trust or execution blocker");
    if (requiredLiveHashes.some((value) => value !== null)) errors.push("not_run must not contain invented live result hashes");
    if (RESULT_BINDING_KEYS.some((field) => artifact.result_bindings?.[field]?.physical_artifact_path !== null)) errors.push("not_run must not contain invented live result paths");
    if (Object.values(artifact.capabilities || {}).some((value) => value === "passed")) errors.push("not_run must not mark live capabilities passed");
    if (artifact.preconditions?.credentials === "verified" && artifact.preconditions?.repository_trust === "verified" && artifact.preconditions?.external_run_authorization?.status === "verified" && !artifact.blockers.includes("external_execution_not_run")) errors.push("not_run with verified preconditions must identify external_execution_not_run");
  }
  hash(artifact.artifact_hash, "artifact_hash", errors);
  if (HASH.test(artifact.artifact_hash || "")) {
    const expected = computeExternalHostArtifactHash(artifact);
    if (artifact.artifact_hash !== expected) errors.push(`artifact_hash mismatch; expected ${expected}`);
  }
  return { valid: errors.length === 0, errors, host_id: artifact.host_id, status: artifact.status, artifact_hash: artifact.artifact_hash };
}

export function readPhysicalHostResult(file) {
  const physical = readPhysicalBytesNoFollow(resolve(file), "host result");
  let value;
  try { value = JSON.parse(physical.bytes.toString("utf8")); } catch (error) {
    throw new HostE2eArtifactError(`host result is invalid JSON: ${error.message}`);
  }
  return { ...physical, value };
}

function readPhysicalBytesNoFollow(file, label) {
  const absolute = resolve(file);
  let descriptor;
  try {
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) throw new HostE2eArtifactError(`${label} is a symlink: ${absolute}`);
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new HostE2eArtifactError(`${label} must be a physical regular file: ${absolute}`);
    return { absolute: realpathSync(absolute), bytes: readFileSync(descriptor) };
  } catch (error) {
    if (error instanceof HostE2eArtifactError) throw error;
    throw new HostE2eArtifactError(`${label} cannot be opened without following symlinks: ${absolute} (${error.code || error.message})`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function resolveEvidencePath(resultFile, recordedPath, label) {
  const root = dirname(resultFile);
  const target = isAbsolute(recordedPath) ? resolve(recordedPath) : resolve(root, recordedPath);
  if (!isAbsolute(recordedPath)) {
    const back = relative(root, target);
    if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
      throw new HostE2eArtifactError(`${label} escapes the host-result directory`);
    }
    if (existsSync(target)) {
      const physical = realpathSync(target);
      const physicalBack = relative(root, physical);
      if (physicalBack === "" || physicalBack === ".." || physicalBack.startsWith(`..${sep}`) || isAbsolute(physicalBack)) {
        throw new HostE2eArtifactError(`${label} uses a symlinked path component that escapes the host-result directory`);
      }
    }
  }
  return target;
}

export function checkExternalHostE2eFile(file) {
  const physical = readPhysicalHostResult(file);
  const validation = validateExternalHostE2eArtifact(physical.value);
  const verifiedResultBindings = {};
  let verifiedPackageHash = null;
  if (validation.valid && physical.value.status === "passed") {
    const evidence = [
      ["executable", physical.value.executable.resolved_path, physical.value.executable.file_hash],
      ["package", physical.value.package.physical_artifact_path, physical.value.package.physical_artifact_hash],
      ...RESULT_BINDING_KEYS.map((field) => [
        `result_bindings.${field}`,
        physical.value.result_bindings[field].physical_artifact_path,
        physical.value.result_bindings[field].physical_artifact_hash,
        field,
      ]),
    ];
    for (const [label, path, expected, resultKey = null] of evidence) {
      try {
        const target = resolveEvidencePath(physical.absolute, path, label);
        const opened = readPhysicalBytesNoFollow(target, label);
        const actual = `sha256:${createHash("sha256").update(opened.bytes).digest("hex")}`;
        if (actual !== expected) validation.errors.push(`${label} physical file hash mismatch; expected ${expected}, got ${actual}`);
        else if (label === "package") verifiedPackageHash = actual;
        else if (resultKey) verifiedResultBindings[resultKey] = canonicalValue({
          physical_artifact_path: opened.absolute,
          physical_artifact_hash: actual,
        });
      } catch (error) {
        validation.errors.push(error.message);
      }
    }
    validation.valid = validation.errors.length === 0;
  }
  return {
    ...validation,
    file: physical.absolute,
    file_hash: `sha256:${createHash("sha256").update(physical.bytes).digest("hex")}`,
    artifact: canonicalValue(physical.value),
    verified_package_hash: verifiedPackageHash,
    verified_result_bindings: canonicalValue(verifiedResultBindings),
  };
}

export function importExternalHostE2eResult(file, outputDirectory) {
  const checked = checkExternalHostE2eFile(file);
  if (!checked.valid) throw new HostE2eArtifactError("host result failed validation", checked.errors);
  const source = realpathSync(file);
  const out = resolve(outputDirectory);
  mkdirSync(out, { recursive: true });
  if (lstatSync(out).isSymbolicLink() || !statSync(out).isDirectory()) throw new HostE2eArtifactError(`output must be a physical directory: ${out}`);
  const target = join(out, `${checked.host_id}-${basename(source)}`);
  const back = relative(out, target);
  if (back.startsWith(`..${sep}`) || isAbsolute(back)) throw new HostE2eArtifactError("unsafe import target");
  copyFileSync(source, target, constants.COPYFILE_EXCL);
  return canonicalValue({ status: "imported_unsigned_external_result", host_id: checked.host_id, execution_status: checked.status, source_file_hash: checked.file_hash, artifact_hash: checked.artifact_hash, target });
}

export function externalHostCollectionPlan() {
  return canonicalValue({
    mode: "plan_only",
    host_order: EXTERNAL_HOST_IDS,
    collector_initiated_paid_calls: false,
    default_status: "not_run",
    required_physical_evidence: [
      "resolved executable plus executable file hash and version output hash",
      "installed package tarball path and hash",
      "catalog order and selected pack hashes",
      "one-use receipt binding plus replay rejection",
      "fact decision report and quality artifact hashes",
      "capability status and every degradation",
    ],
    blockers_that_must_remain_not_run: ["cli_missing", "credential_missing", "repository_untrusted", "execution_not_authorized"],
    collector_behavior: "explicit --import-result only; never invokes a host or paid model",
  });
}

function resolveExecutable(name, pathValue) {
  if (isAbsolute(name)) {
    try { accessSync(name, constants.X_OK); const file = realpathSync(name); return statSync(file).isFile() ? file : null; } catch { return null; }
  }
  for (const directory of String(pathValue || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, name);
    try { accessSync(candidate, constants.X_OK); const file = realpathSync(candidate); if (statSync(file).isFile()) return file; } catch { /* keep searching */ }
  }
  return null;
}

export function preflightExternalHost({ hostId, executable, runtime = null, pathOverride = null, packageName = "alphacouncil-agent", packageVersion = null, packageArtifact = null }) {
  if (!EXTERNAL_HOST_IDS.includes(hostId)) throw new HostE2eArtifactError(`host must be one of ${EXTERNAL_HOST_IDS.join(", ")}`);
  if (typeof executable !== "string" || !executable) throw new HostE2eArtifactError("preflight requires an executable name or absolute path");
  const effectivePath = pathOverride ?? process.env.PATH ?? "";
  const executablePath = resolveExecutable(executable, effectivePath);
  const runtimePath = runtime ? resolveExecutable(runtime, effectivePath) : null;
  const blockers = [];
  const degradation = [];
  if (!executablePath) blockers.push("cli_missing");
  if (runtime && !runtimePath) blockers.push("runtime_missing");
  let probe = null;
  if (executablePath && (!runtime || runtimePath)) {
    const command = runtimePath || executablePath;
    const args = runtimePath ? [executablePath, "--version"] : ["--version"];
    const result = spawnSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, PATH: effectivePath },
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    probe = canonicalValue({
      command: command,
      arguments: args,
      exit_status: result.status,
      signal: result.signal || null,
      error_code: result.error?.code || null,
      output_hash: sha256(output),
      version_text: result.status === 0 && output ? output : null,
    });
    if (result.error || result.status !== 0) {
      blockers.push("version_probe_failed");
      degradation.push(`version probe failed${result.error?.code ? `: ${result.error.code}` : ` with status ${result.status}`}`);
    }
  }
  if (pathOverride !== null) degradation.push("explicit PATH override used for read-only version preflight");
  if (runtime !== null) degradation.push("explicit runtime override used for read-only version preflight");
  let packagePath = null;
  let packageHash = null;
  if (packageArtifact !== null) {
    const candidate = resolve(packageArtifact);
    if (!existsSync(candidate) || lstatSync(candidate).isSymbolicLink() || !statSync(candidate).isFile()) blockers.push("package_artifact_missing_or_unsafe");
    else {
      packagePath = realpathSync(candidate);
      packageHash = `sha256:${createHash("sha256").update(readFileSync(packagePath)).digest("hex")}`;
    }
  } else blockers.push("package_artifact_not_provided");
  blockers.push("credential_not_checked", "repository_trust_not_checked", "external_run_authorization_not_checked", "external_execution_not_run");
  const artifact = {
    schema_version: 1,
    artifact_kind: "alphacouncil_external_host_e2e_result",
    host_id: hostId,
    collected_at: new Date().toISOString(),
    status: "not_run",
    executable: {
      requested_name: executable,
      resolved_path: executablePath,
      file_hash: executablePath ? `sha256:${createHash("sha256").update(readFileSync(executablePath)).digest("hex")}` : null,
      version: probe?.version_text || null,
      version_output_hash: probe?.output_hash || null,
    },
    package: {
      name: packageName,
      version: packageVersion,
      physical_artifact_path: packagePath,
      physical_artifact_hash: packageHash,
    },
    catalog: { catalog_hash: null, catalog_order_hash: null, selected_master_ids: [], selected_pack_hashes: [] },
    selection_receipt: { receipt_binding_hash: null, confirmed: false, consumed_once: false, replay_rejected: false },
    result_bindings: Object.fromEntries(RESULT_BINDING_KEYS.map((field) => [field, {
      physical_artifact_path: null,
      physical_artifact_hash: null,
    }])),
    preconditions: {
      credentials: "not_checked",
      repository_trust: "not_checked",
      external_run_authorization: { status: "not_checked", reference_hash: null },
    },
    capabilities: { mcp_handshake: "not_run", complete_catalog_display: "not_run", visible_subagents: "not_run", parallelism: "not_run", permissions: "not_run", resume: "not_run" },
    degradation: [
      ...degradation,
      ...(pathOverride === null ? [] : [`PATH override hash ${sha256(pathOverride)}`]),
      ...(runtime === null ? [] : [`runtime override ${runtimePath || runtime} used for version probe`]),
      ...(probe ? [`version probe status ${probe.exit_status ?? probe.error_code ?? "unknown"}; output hash ${probe.output_hash}`] : []),
    ],
    blockers: [...new Set(blockers)],
    collector_initiated_paid_calls: false,
    artifact_hash: null,
    attestations: [],
  };
  artifact.artifact_hash = computeExternalHostArtifactHash(artifact);
  const validation = validateExternalHostE2eArtifact(artifact);
  if (!validation.valid) throw new HostE2eArtifactError("generated preflight artifact is invalid", validation.errors);
  return canonicalValue(artifact);
}

function inside(base, target) {
  const back = relative(base, target);
  return back === "" || (back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back));
}

export function writeExternalHostPreflightArtifact(artifact, outputFile, { repoRoot = EXTERNAL_E2E_REPO_ROOT } = {}) {
  const validation = validateExternalHostE2eArtifact(artifact);
  if (!validation.valid || artifact.status !== "not_run") throw new HostE2eArtifactError("only a valid not_run preflight artifact may be saved", validation.errors);
  const target = resolve(outputFile);
  if (existsSync(target)) throw new HostE2eArtifactError(`refusing to overwrite existing evidence: ${target}`);
  const parent = realpathSync(dirname(target));
  if (!statSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) throw new HostE2eArtifactError(`output parent must be a physical directory: ${parent}`);
  const physicalTarget = join(parent, basename(target));
  if (inside(resolve(repoRoot, "knowledge"), physicalTarget)) throw new HostE2eArtifactError("refusing to write preflight evidence into the production knowledge tree");
  writeFileSync(physicalTarget, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const mode = statSync(physicalTarget).mode & 0o777;
  if (mode !== 0o600) throw new HostE2eArtifactError(`saved evidence permissions are not 0600: ${mode.toString(8)}`);
  return canonicalValue({
    status: "saved_not_run_preflight",
    host_id: artifact.host_id,
    artifact_hash: artifact.artifact_hash,
    file_hash: `sha256:${createHash("sha256").update(readFileSync(physicalTarget)).digest("hex")}`,
    output_file: physicalTarget,
    mode: "0600",
  });
}
