import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalValue, sha256 } from "./canonical.mjs";

export const GA_PACKAGE_ARTIFACT_KIND = "persona_v3_ga_package_artifact";
export const GA_VERSION_METADATA_PATHS = Object.freeze([
  "package.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
]);

const HASH = /^sha256:[a-f0-9]{64}$/u;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const ROOT_FIELDS = Object.freeze([
  "schema_version", "artifact_kind", "generated_at", "status", "release_id",
  "release_manifest_hash", "package", "catalog", "selection_receipt",
  "result_bindings", "artifact_hash", "attestations",
]);
const PACKAGE_FIELDS = Object.freeze([
  "name", "version", "package_json_file_hash", "tarball_path", "tarball_file_hash",
  "tarball_package_json_hash",
]);
const CATALOG_FIELDS = Object.freeze([
  "catalog_hash", "catalog_order_hash", "selected_master_ids", "selected_pack_hashes",
]);
const RESULT_FIELDS = Object.freeze([
  "fact_artifact", "deterministic_decision", "report", "report_quality",
]);

function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label, errors) {
  if (!isObject(value)) { errors.push(`${label} must be an object`); return false; }
  const allowed = new Set(fields);
  for (const field of fields) if (!Object.hasOwn(value, field)) errors.push(`${label}.${field} is required`);
  for (const field of Object.keys(value)) if (!allowed.has(field)) errors.push(`${label}.${field} is not allowed`);
  return true;
}
function hash(value, label, errors) { if (!HASH.test(value || "")) errors.push(`${label} must be a canonical sha256 hash`); }
function string(value, label, errors) { if (typeof value !== "string" || !value.trim()) errors.push(`${label} must be a non-empty string`); }
function safeRelative(value, label, errors) {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.split(/[\\/]/u).includes("..")) errors.push(`${label} must be a safe relative path`);
}
function resultBinding(value, label, errors) {
  if (!exact(value, ["relative_path", "file_hash"], label, errors)) return;
  safeRelative(value.relative_path, `${label}.relative_path`, errors);
  hash(value.file_hash, `${label}.file_hash`, errors);
}

export function gaPackageArtifactSubject(artifact) {
  if (!isObject(artifact)) return artifact;
  const { artifact_hash: ignored, attestations: ignoredAttestations, ...subject } = artifact;
  return canonicalValue(subject);
}

export function computeGaPackageArtifactHash(artifact) {
  return sha256({ domain: "alphacouncil.persona-v3.ga-package-artifact.v1", subject: gaPackageArtifactSubject(artifact) });
}

export function validateGaPackageArtifact(artifact) {
  const errors = [];
  if (!exact(artifact, ROOT_FIELDS, "package artifact", errors)) return { valid: false, errors };
  if (artifact.schema_version !== 1 || artifact.artifact_kind !== GA_PACKAGE_ARTIFACT_KIND) errors.push("package artifact header is invalid");
  if (!ISO_UTC.test(artifact.generated_at || "") || !Number.isFinite(Date.parse(artifact.generated_at))) errors.push("package artifact generated_at is invalid");
  if (artifact.status !== "passed") errors.push("package artifact status must be passed");
  if (!RELEASE_ID.test(artifact.release_id || "")) errors.push("package artifact release_id is invalid");
  hash(artifact.release_manifest_hash, "package artifact release_manifest_hash", errors);
  if (exact(artifact.package, PACKAGE_FIELDS, "package artifact.package", errors)) {
    string(artifact.package.name, "package artifact.package.name", errors);
    if (!VERSION.test(artifact.package.version || "")) errors.push("package artifact.package.version must be a semantic version");
    for (const field of ["package_json_file_hash", "tarball_file_hash", "tarball_package_json_hash"]) hash(artifact.package[field], `package artifact.package.${field}`, errors);
    safeRelative(artifact.package.tarball_path, "package artifact.package.tarball_path", errors);
  }
  if (exact(artifact.catalog, CATALOG_FIELDS, "package artifact.catalog", errors)) {
    hash(artifact.catalog.catalog_hash, "package artifact.catalog.catalog_hash", errors);
    hash(artifact.catalog.catalog_order_hash, "package artifact.catalog.catalog_order_hash", errors);
    if (!Array.isArray(artifact.catalog.selected_master_ids) || !Array.isArray(artifact.catalog.selected_pack_hashes)
      || artifact.catalog.selected_master_ids.length !== artifact.catalog.selected_pack_hashes.length
      || artifact.catalog.selected_master_ids.length === 0) errors.push("package artifact selected IDs/hashes must be equal non-empty arrays");
    artifact.catalog.selected_master_ids?.forEach((value, index) => string(value, `package artifact.catalog.selected_master_ids[${index}]`, errors));
    artifact.catalog.selected_pack_hashes?.forEach((value, index) => hash(value, `package artifact.catalog.selected_pack_hashes[${index}]`, errors));
  }
  if (exact(artifact.selection_receipt, ["receipt_binding_hash"], "package artifact.selection_receipt", errors)) hash(artifact.selection_receipt.receipt_binding_hash, "package artifact.selection_receipt.receipt_binding_hash", errors);
  if (exact(artifact.result_bindings, RESULT_FIELDS, "package artifact.result_bindings", errors)) {
    for (const field of RESULT_FIELDS) resultBinding(artifact.result_bindings[field], `package artifact.result_bindings.${field}`, errors);
  }
  if (!Array.isArray(artifact.attestations) || artifact.attestations.length !== 0) errors.push("package collector attestations must remain empty");
  hash(artifact.artifact_hash, "package artifact.artifact_hash", errors);
  if (HASH.test(artifact.artifact_hash || "") && artifact.artifact_hash !== computeGaPackageArtifactHash(artifact)) errors.push("package artifact artifact_hash mismatch");
  return { valid: errors.length === 0, errors, artifact_hash: artifact.artifact_hash };
}

function physicalFile(file, label) {
  const absolute = resolve(file);
  if (!existsSync(absolute)) throw new Error(`${label} is missing: ${absolute}`);
  let descriptor;
  try {
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
    descriptor = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    if (!fstatSync(descriptor).isFile()) throw new Error(`${label} must be a physical regular file`);
    const bytes = readFileSync(descriptor);
    return { absolute: realpathSync(absolute), bytes, file_hash: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  } catch (error) {
    throw new Error(`${label} cannot be opened without following symlinks: ${absolute} (${error.code || error.message})`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error(`${label} is invalid JSON (${error.message})`); }
}

function tarballEntry(tarball, relativePath) {
  const entry = `package/${relativePath}`;
  const result = spawnSync("tar", ["-xOf", tarball, entry], {
    encoding: null,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  if (result.error || result.status !== 0 || !result.stdout?.length) {
    throw new Error(`package tarball does not contain readable ${entry} (${result.error?.code || result.status})`);
  }
  return Buffer.from(result.stdout);
}

function inside(base, target) {
  const back = relative(base, target);
  return back === "" || (back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back));
}

function containedPhysicalFile(root, relativePath, label) {
  const target = resolve(root, relativePath);
  if (target === root || !inside(root, target)) throw new Error(`${label} escapes its physical root`);
  if (existsSync(target) && !inside(root, realpathSync(target))) throw new Error(`${label} uses a symlinked path that escapes its physical root`);
  return physicalFile(target, label);
}

function isolatedNpmEnv(root) {
  const userConfig = join(root, "empty-user.npmrc");
  const globalConfig = join(root, "empty-global.npmrc");
  writeFileSync(userConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(globalConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  return {
    ...process.env,
    npm_config_audit: "false",
    npm_config_cache: join(root, "npm-cache"),
    npm_config_fund: "false",
    npm_config_globalconfig: globalConfig,
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
    npm_config_package_lock: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: userConfig,
  };
}

function npmInvocation(args, env) {
  const npmExecPath = env.npm_execpath;
  if (typeof npmExecPath === "string" && npmExecPath.trim() && existsSync(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  if (process.platform === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm.cmd", ...args],
    };
  }
  return { command: "npm", args };
}

function safelyInstallAndDerive(tarball, { packageName, releaseId }) {
  const tempBase = realpathSync(tmpdir());
  const root = mkdtempSync(join(tempBase, "alphacouncil-ga-package-"));
  if (dirname(realpathSync(root)) !== tempBase || !basename(root).startsWith("alphacouncil-ga-package-")) throw new Error("GA package temporary root escaped the OS temp directory");
  try {
    const prefix = join(root, "install");
    mkdirSync(prefix);
    const npmEnv = isolatedNpmEnv(root);
    const invocation = npmInvocation([
      "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund",
      "--package-lock=false", "--prefix", prefix, tarball,
    ], npmEnv);
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      env: npmEnv,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    });
    if (result.error || result.status !== 0) throw new Error(`offline script-disabled npm install failed (${result.error?.code || result.status}): ${(result.stderr || result.stdout || "").trim()}`);
    const segments = String(packageName).split("/");
    if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) throw new Error("package name cannot resolve an installed path");
    const installedRoot = realpathSync(join(prefix, "node_modules", ...segments));
    if (!inside(root, installedRoot) || !statSync(installedRoot).isDirectory()) throw new Error("installed package root escaped the temporary workspace");
    const installedPackageFile = containedPhysicalFile(installedRoot, "package.json", "installed package.json");
    const installedPackage = parseJson(installedPackageFile.bytes, "installed package.json");
    const releaseFile = containedPhysicalFile(installedRoot, join("knowledge", "persona-releases", releaseId, "manifest.json"), "installed release manifest");
    const release = parseJson(releaseFile.bytes, "installed release manifest");
    if (release.artifact_kind !== "persona_v3_release_manifest" || release.release_id !== releaseId) throw new Error("installed release manifest identity differs from the package artifact");
    if (release.canonical_master_count !== 26 || !Array.isArray(release.canonical_master_ids)
      || release.canonical_master_ids.length !== 26 || new Set(release.canonical_master_ids).size !== 26
      || !Array.isArray(release.packs) || release.packs.length !== 26) throw new Error("installed release manifest does not contain exactly 26 canonical packs");
    const selectedPackHashes = release.packs.map((pack, index) => {
      if (pack?.persona_id !== release.canonical_master_ids[index] || !HASH.test(pack?.pack_hash || "")) throw new Error(`installed release manifest pack ${index} does not bind canonical ID/order/hash`);
      return pack.pack_hash;
    });
    if (!HASH.test(release.canonical_catalog_hash || "")) throw new Error("installed release manifest canonical_catalog_hash is invalid");
    return canonicalValue({
      package: { name: installedPackage.name, version: installedPackage.version, package_json_file_hash: installedPackageFile.file_hash },
      catalog: {
        catalog_hash: release.canonical_catalog_hash,
        catalog_order_hash: sha256(release.canonical_master_ids),
        selected_master_ids: release.canonical_master_ids,
        selected_pack_hashes: selectedPackHashes,
      },
      release_manifest_file_hash: releaseFile.file_hash,
    });
  } finally {
    const target = resolve(root);
    if (!inside(tempBase, target) || dirname(target) !== tempBase || !basename(target).startsWith("alphacouncil-ga-package-")) throw new Error(`refusing unsafe GA package cleanup target: ${target}`);
    rmSync(target, { recursive: true, force: true });
  }
}

function verifyResultBindings(artifact, artifactFile, errors) {
  const verified = {};
  const root = dirname(artifactFile);
  for (const field of RESULT_FIELDS) {
    try {
      const binding = artifact.result_bindings[field];
      const opened = containedPhysicalFile(root, binding.relative_path, `package result_bindings.${field}`);
      if (opened.file_hash !== binding.file_hash) errors.push(`package result_bindings.${field} physical file hash mismatch`);
      else verified[field] = canonicalValue({ physical_path: opened.absolute, file_hash: opened.file_hash });
    } catch (error) {
      errors.push(error.message);
    }
  }
  return canonicalValue(verified);
}

function declaredVersions(value, path = "$") {
  const declarations = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => declarations.push(...declaredVersions(entry, `${path}[${index}]`)));
  } else if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const entryPath = `${path}.${key}`;
      if (key === "version") declarations.push({ path: entryPath, version: entry });
      declarations.push(...declaredVersions(entry, entryPath));
    }
  }
  return declarations;
}

function checkDeclaredVersions(document, relativePath, location, expectedVersion, errors) {
  const declarations = declaredVersions(document);
  if (!declarations.length) {
    errors.push(`${location} ${relativePath} does not declare a version`);
  }
  for (const declaration of declarations) {
    if (!VERSION.test(declaration.version || "")) {
      errors.push(`${location} ${relativePath}${declaration.path.slice(1)} has an invalid version`);
    } else if (declaration.version !== expectedVersion) {
      errors.push(`${location} ${relativePath}${declaration.path.slice(1)}=${declaration.version}; expected=${expectedVersion}`);
    }
  }
  return declarations;
}

export function checkGaPackageArtifactFile(file, { packageJsonPath, expectedVersion = null } = {}) {
  const physical = physicalFile(file, "package artifact");
  const artifact = parseJson(physical.bytes, "package artifact");
  const validation = validateGaPackageArtifact(artifact);
  const errors = [...validation.errors];
  let sourcePackage = null;
  let tarballPackage = null;
  let tarballFile = null;
  let installedMetadata = null;
  const versionMetadata = [];
  const verifiedResultBindings = validation.valid
    ? verifyResultBindings(artifact, physical.absolute, errors)
    : canonicalValue({});
  try {
    const source = physicalFile(packageJsonPath, "repository package.json");
    sourcePackage = parseJson(source.bytes, "repository package.json");
    if (source.file_hash !== artifact.package?.package_json_file_hash) errors.push("package artifact does not bind the physical repository package.json");
    const root = dirname(physical.absolute);
    const tarballPath = resolve(root, artifact.package?.tarball_path || "");
    const back = relative(root, tarballPath);
    if (back === "" || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) throw new Error("package tarball path escapes the package-artifact root");
    if (existsSync(tarballPath) && realpathSync(tarballPath) !== tarballPath) {
      throw new Error("package tarball path contains a symlinked component");
    }
    tarballFile = physicalFile(tarballPath, "package tarball");
    if (tarballFile.file_hash !== artifact.package?.tarball_file_hash) errors.push("package artifact tarball file hash mismatch");
    const tarPackageBytes = tarballEntry(tarballFile.absolute, "package.json");
    const tarPackageHash = `sha256:${createHash("sha256").update(tarPackageBytes).digest("hex")}`;
    if (tarPackageHash !== artifact.package?.tarball_package_json_hash) errors.push("package artifact tarball package.json hash mismatch");
    tarballPackage = parseJson(tarPackageBytes, "tarball package.json");
    for (const field of ["name", "version"]) {
      if (artifact.package?.[field] !== sourcePackage?.[field]) errors.push(`package artifact ${field} differs from repository package.json`);
      if (artifact.package?.[field] !== tarballPackage?.[field]) errors.push(`package artifact ${field} differs from tarball package.json`);
    }
    if (artifact.catalog?.selected_master_ids?.length === 26) {
      installedMetadata = safelyInstallAndDerive(tarballFile.absolute, {
        packageName: tarballPackage.name,
        releaseId: artifact.release_id,
      });
      if (installedMetadata.package.name !== artifact.package?.name || installedMetadata.package.version !== artifact.package?.version) errors.push("installed tarball package identity differs from the package artifact");
      if (installedMetadata.package.package_json_file_hash !== artifact.package?.tarball_package_json_hash) errors.push("installed tarball package.json bytes differ from the package artifact");
      if (JSON.stringify(installedMetadata.catalog) !== JSON.stringify(artifact.catalog)) errors.push("package artifact catalog/pack declarations differ from the safely installed physical tarball");
    }

    const requiredVersion = expectedVersion || artifact.package?.version;
    if (!VERSION.test(requiredVersion || "")) {
      errors.push("expected package version is missing or invalid");
    } else {
      const repositoryRoot = dirname(source.absolute);
      for (const relativePath of GA_VERSION_METADATA_PATHS) {
        try {
          const repositoryFile = physicalFile(resolve(repositoryRoot, relativePath), `repository ${relativePath}`);
          if (repositoryFile.absolute !== resolve(repositoryRoot, relativePath)) {
            throw new Error(`repository ${relativePath} uses a symlinked path component`);
          }
          const repositoryDocument = parseJson(repositoryFile.bytes, `repository ${relativePath}`);
          const tarballBytes = relativePath === "package.json"
            ? tarPackageBytes
            : tarballEntry(tarballFile.absolute, relativePath);
          const tarballDocument = parseJson(tarballBytes, `tarball ${relativePath}`);
          const repositoryVersions = checkDeclaredVersions(
            repositoryDocument,
            relativePath,
            "repository",
            requiredVersion,
            errors,
          );
          const tarballVersions = checkDeclaredVersions(
            tarballDocument,
            relativePath,
            "tarball",
            requiredVersion,
            errors,
          );
          if (JSON.stringify(repositoryVersions) !== JSON.stringify(tarballVersions)) {
            errors.push(`repository and tarball ${relativePath} version declarations differ`);
          }
          versionMetadata.push({
            relative_path: relativePath,
            repository_file_hash: repositoryFile.file_hash,
            tarball_file_hash: `sha256:${createHash("sha256").update(tarballBytes).digest("hex")}`,
            repository_versions: repositoryVersions,
            tarball_versions: tarballVersions,
          });
        } catch (error) {
          errors.push(error?.message || String(error));
        }
      }
    }
  } catch (error) {
    errors.push(error?.message || String(error));
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors,
    file: physical.absolute,
    file_hash: physical.file_hash,
    artifact_hash: artifact?.artifact_hash || null,
    artifact,
    package_name: artifact?.package?.name || null,
    package_version: artifact?.package?.version || null,
    tarball_hash: tarballFile?.file_hash || null,
    source_package: sourcePackage,
    tarball_package: tarballPackage,
    version_metadata: versionMetadata,
    installed_package: installedMetadata?.package || null,
    derived_catalog: installedMetadata?.catalog || null,
    installed_release_manifest_file_hash: installedMetadata?.release_manifest_file_hash || null,
    verified_result_bindings: verifiedResultBindings,
  });
}
