/**
 * Installed npm-tarball adapter parity E2E for Claude Code, Codex, OpenCode and Grok.
 *
 * This deliberately tests only the packaged MCP/configuration boundary. It does not invoke
 * any external host CLI or model, does not claim live-host execution, and cannot claim a
 * PersonaPack v3 decision comparison while the production package contains zero v3 packs.
 */

import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  HOST_SELECTION_INSTRUCTION_PATHS,
  inspectHostSelectionInstruction,
} from "./host-selection-instruction-contract.mjs";
import {
  assertPackageInventory,
  buildPackageInventoryReport,
} from "./package-inventory.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACKAGED_PARITY_REPO_ROOT = resolve(HERE, "../..");
export const PACKAGED_HOST_IDS = Object.freeze(["claude_code", "codex", "opencode", "grok"]);
export const PACKAGED_SELECTION_INPUT = Object.freeze([
  "master_buffett",
  "master_damodaran",
  "master_taleb",
  "master_sinclair",
]);

const TEMP_PREFIX = "alphacouncil-packaged-parity-";
const SYMBOL = "NOK";
const AS_OF = "2026-07-27";
const LANGUAGE = "English";
const PROMPT = "packaged adapter parity fixture";
const TASKS = Object.freeze(["market_data"]);
const REQUEST_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 120_000;
const EXPECTED_TOOL_COUNT = 34;
const INSTALLED_LOCALE_CASES = Object.freeze([
  Object.freeze({ language: "en-US", prompt: "installed package locale smoke", key: "en", script: /[A-Za-z]/u }),
  Object.freeze({ language: "zh-CN", prompt: "安装包语言烟雾测试", key: "zh", script: /\p{Script=Han}/u }),
  Object.freeze({ language: "ja-JP", prompt: "インストール済みパッケージの言語スモークテスト", key: "ja", script: /[\p{Script=Hiragana}\p{Script=Katakana}]/u }),
  Object.freeze({ language: "ko-KR", prompt: "설치 패키지 언어 스모크 테스트", key: "ko", script: /\p{Script=Hangul}/u }),
]);
const REQUIRED_PACKAGE_FILES = Object.freeze([
  "mcp/server.mjs",
  "data/host-capabilities.v1.json",
  "commands/alpha.md",
  "docs/persona-v3-deterministic-policy.md",
]);
const POLICY_MARKERS = Object.freeze([
  "PersonaPack v3 deterministic policy DSL 1.1",
  "typed facts",
  "min_coverage",
  "out_of_scope",
  "不会回退",
]);
const GROUNDING = Object.freeze({
  facts_unavailable: true,
  unavailable: Object.freeze([
    "packaged adapter parity fixture: network is disabled and no market fact is asserted",
  ]),
});

export class PackagedHostParityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PackagedHostParityError";
    this.details = details;
  }
}

function fail(message, details = {}) {
  throw new PackagedHostParityError(message, details);
}

function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function readJson(file, label = file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${label}: invalid JSON (${error.message})`);
  }
}

function safeTempRoot() {
  const base = realpathSync(tmpdir());
  const root = mkdtempSync(join(base, TEMP_PREFIX));
  const physical = realpathSync(root);
  if (dirname(physical) !== base || !basename(physical).startsWith(TEMP_PREFIX)) {
    fail(`temporary workspace escaped the OS temp directory: ${physical}`);
  }
  return physical;
}

function cleanupTempRoot(root) {
  const base = realpathSync(tmpdir());
  const target = resolve(root);
  if (!inside(base, target) || dirname(target) !== base || !basename(target).startsWith(TEMP_PREFIX)) {
    fail(`refusing unsafe packaged-parity cleanup target: ${target}`);
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) fail("temporary workspace must not be a symlink");
  rmSync(target, { recursive: true, force: true });
  if (existsSync(target)) fail("temporary packaged-parity workspace cleanup failed");
}

export function npmInvocation(args, {
  platform = process.platform,
  env = process.env,
  nodeExecutable = process.execPath,
  fileExists = existsSync,
} = {}) {
  const npmExecPath = env.npm_execpath;
  if (typeof npmExecPath === "string" && npmExecPath.trim() && fileExists(npmExecPath)) {
    return Object.freeze({ command: nodeExecutable, args: Object.freeze([npmExecPath, ...args]) });
  }
  if (platform === "win32") {
    return Object.freeze({
      command: env.ComSpec || "cmd.exe",
      args: Object.freeze(["/d", "/s", "/c", "npm.cmd", ...args]),
    });
  }
  return Object.freeze({ command: "npm", args: Object.freeze([...args]) });
}

function isolatedNpmEnv(tempRoot) {
  const userConfig = join(tempRoot, "empty-user.npmrc");
  const globalConfig = join(tempRoot, "empty-global.npmrc");
  writeFileSync(userConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  writeFileSync(globalConfig, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const env = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_cache: join(tempRoot, "npm-cache"),
    npm_config_fund: "false",
    npm_config_globalconfig: globalConfig,
    npm_config_ignore_scripts: "true",
    npm_config_offline: "true",
    npm_config_package_lock: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: userConfig,
  };
  // An outer `npm publish --dry-run` exports this setting to lifecycle scripts. The
  // packaged-parity check must still create its private temporary tarball, so do not
  // let the outer rehearsal turn the nested `npm pack` into another metadata-only run.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "npm_config_dry_run") delete env[key];
  }
  return env;
}

function runCommand(command, args, { cwd, env, label, timeout = PROCESS_TIMEOUT_MS } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  if (result.error) fail(`${label || command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label || command} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`, {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
}

function parseNpmJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    fail(`${label} did not emit valid JSON: ${error.message}`, { stdout });
  }
}

function normalizedPackagePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^package\//u, "").replace(/^\.\//u, "");
}

function walkFiles(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    const rel = normalizedPackagePath(relative(root, file));
    if (entry.isSymbolicLink()) {
      out.push({ path: rel, type: "symlink" });
      continue;
    }
    if (entry.isDirectory()) walkFiles(root, file, out);
    else if (entry.isFile()) out.push({ path: rel, type: "file" });
    else out.push({ path: rel, type: "special" });
  }
  return out;
}

function forbiddenPackageArtifact(path) {
  const normalized = `/${normalizedPackagePath(path)}`;
  return normalized.includes("/knowledge/staging/")
    || normalized.includes("/acquisitions/")
    || normalized.endsWith("/source.bin");
}

function packAndInstall({ repoRoot, tempRoot }) {
  const packDir = join(tempRoot, "pack");
  const installPrefix = join(tempRoot, "install");
  mkdirSync(packDir);
  mkdirSync(installPrefix);
  const npmEnv = isolatedNpmEnv(tempRoot);
  // `--ignore-scripts` is a hard recursion boundary: package.json prepublishOnly runs the
  // repository check, which may itself include this packaged E2E.
  const packInvocation = npmInvocation([
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    packDir,
  ], { env: npmEnv });
  const packed = runCommand(packInvocation.command, packInvocation.args, {
    cwd: repoRoot,
    env: npmEnv,
    label: "npm pack --ignore-scripts",
  });
  const packJson = parseNpmJson(packed.stdout, "npm pack");
  if (!Array.isArray(packJson) || packJson.length !== 1) fail("npm pack must return exactly one package result");
  const metadata = packJson[0];
  const tarball = resolve(packDir, metadata.filename || "");
  if (!inside(packDir, tarball) || !existsSync(tarball) || !statSync(tarball).isFile()) {
    fail(`npm pack returned an unsafe or missing tarball: ${metadata.filename}`);
  }
  const tarFiles = (metadata.files || []).map((entry) => normalizedPackagePath(entry.path));
  if (!tarFiles.length || new Set(tarFiles).size !== tarFiles.length) fail("npm pack file inventory is empty or duplicated");

  const installInvocation = npmInvocation([
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    "--prefix",
    installPrefix,
    tarball,
  ], { env: npmEnv });
  runCommand(installInvocation.command, installInvocation.args, {
    cwd: tempRoot,
    env: npmEnv,
    label: "offline npm install from tarball",
  });

  const sourcePackage = readJson(join(repoRoot, "package.json"), "source package.json");
  const packageSegments = String(sourcePackage.name).split("/");
  const installedRoot = realpathSync(join(installPrefix, "node_modules", ...packageSegments));
  if (!inside(tempRoot, installedRoot) || !statSync(installedRoot).isDirectory()) {
    fail("installed package root escaped the temporary workspace");
  }
  const installedPackage = readJson(join(installedRoot, "package.json"), "installed package.json");
  if (installedPackage.name !== sourcePackage.name || installedPackage.version !== sourcePackage.version) {
    fail("installed package identity differs from the packed repository package");
  }
  return {
    repoRoot,
    installedRoot,
    metadata,
    tarballHash: sha256(readFileSync(tarball)),
    tarFiles,
    packageName: installedPackage.name,
    packageVersion: installedPackage.version,
  };
}

function requireInstalledFile(installedRoot, packageFiles, rel, label) {
  const normalized = normalizedPackagePath(rel);
  if (!packageFiles.has(normalized)) fail(`${label} is absent from npm pack inventory: ${normalized}`);
  const file = resolve(installedRoot, normalized);
  if (!inside(installedRoot, file) || !existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) {
    fail(`${label} is absent or unsafe after tarball install: ${normalized}`);
  }
  const content = readFileSync(file, "utf8");
  if (!content.trim()) fail(`${label} is empty after tarball install: ${normalized}`);
  return content;
}

function countInstalledPackVersions(installedRoot, installedFiles) {
  let physicalV3 = 0;
  let legacyV2 = 0;
  for (const entry of installedFiles) {
    if (entry.type !== "file" || !/^knowledge\/masters\/[^/]+\/manifest\.json$/u.test(entry.path)) continue;
    const manifest = readJson(join(installedRoot, entry.path), entry.path);
    if (manifest.schema_version === 3) physicalV3 += 1;
    else if (manifest.schema_version === 2) legacyV2 += 1;
  }
  return { physical_v3: physicalV3, legacy_v2: legacyV2 };
}

function validatePackagedSurfaces(pack) {
  const packageFiles = new Set(pack.tarFiles);
  const packageInventory = assertPackageInventory(buildPackageInventoryReport(
    pack.repoRoot,
    pack.metadata,
  ));
  const installedEntries = walkFiles(pack.installedRoot);
  const installedFiles = new Set(installedEntries.map((entry) => entry.path));
  if (pack.tarFiles.some((path) => path === "fuzz" || path.startsWith("fuzz/"))) {
    fail("npm package leaked the development-only fuzz lane");
  }
  const forbiddenTar = pack.tarFiles.filter(forbiddenPackageArtifact);
  const forbiddenInstalled = installedEntries.map((entry) => entry.path).filter(forbiddenPackageArtifact);
  if (forbiddenTar.length || forbiddenInstalled.length) {
    fail("npm package leaked staging acquisition artifacts", { forbiddenTar, forbiddenInstalled });
  }
  const reviewPrefix = "knowledge/ai-assisted-solo/reviews/";
  const packagedReviews = pack.tarFiles.filter((path) => path.startsWith(reviewPrefix) && path.endsWith(".json"));
  // The capsule is complete when the package carries every review the repository holds. Pinning
  // a number instead would only restate the roster size, and would have to be edited on the
  // day a seat is added -- which is exactly when the check should still be meaningful.
  const repoReviews = walkFiles(resolve(pack.repoRoot, reviewPrefix))
    .filter((entry) => entry.path.endsWith(".json"));
  if (packagedReviews.length !== repoReviews.length) {
    fail(`installed AI-assisted review capsule must contain every one of the ${repoReviews.length} repository review files; got ${packagedReviews.length}`);
  }
  if (pack.tarFiles.some((path) => path.startsWith("knowledge/ai-assisted-solo/host-e2e/"))) {
    fail("local external-host failure evidence must not ship in the npm package");
  }
  for (const rel of REQUIRED_PACKAGE_FILES) requireInstalledFile(pack.installedRoot, packageFiles, rel, rel);

  const contract = JSON.parse(requireInstalledFile(
    pack.installedRoot,
    packageFiles,
    "data/host-capabilities.v1.json",
    "packaged host capability contract",
  ));
  if (!isDeepStrictEqual(contract.hosts?.map((host) => host.host_id), PACKAGED_HOST_IDS)) {
    fail("packaged host capability contract does not contain the canonical four-host order");
  }
  if (contract.live_e2e_overall !== "not_run") fail("packaged static contract fabricates external live E2E");
  const canonicalCommand = requireInstalledFile(pack.installedRoot, packageFiles, "commands/alpha.md", "canonical command");
  const hosts = [];
  const shippedPaths = new Set(REQUIRED_PACKAGE_FILES);
  for (const rel of HOST_SELECTION_INSTRUCTION_PATHS) {
    const instruction = requireInstalledFile(
      pack.installedRoot,
      packageFiles,
      rel,
      "packaged host selection instruction",
    );
    const result = inspectHostSelectionInstruction(instruction, {
      path: rel,
      canonicalCount: CANONICAL_MASTER_COUNT,
    });
    if (result.status !== "passed") {
      fail(`packaged host selection instruction violates returned-catalog contract: ${rel}`, {
        errors: result.errors,
      });
    }
    shippedPaths.add(rel);
  }
  for (const host of contract.hosts) {
    if (host.live_e2e?.status !== "not_run" || host.live_e2e?.artifact !== null) {
      fail(`${host.host_id} packaged contract fabricates external live E2E`);
    }
    const configPaths = [...host.config_paths];
    const commandPaths = [host.command_surface.canonical_source, ...host.command_surface.repository_adapters];
    for (const rel of [...configPaths, ...commandPaths]) {
      requireInstalledFile(pack.installedRoot, packageFiles, rel, `${host.host_id} packaged surface`);
      shippedPaths.add(rel);
    }
    for (const adapter of host.command_surface.repository_adapters) {
      const content = readFileSync(join(pack.installedRoot, adapter), "utf8");
      if (content !== canonicalCommand) fail(`${host.host_id} packaged command adapter is stale: ${adapter}`);
    }
    hosts.push({
      host_id: host.host_id,
      config_paths: configPaths,
      command_paths: commandPaths,
      command_hash: sha256(canonicalCommand),
      external_cli_live_e2e: "not_run",
      status: "present_in_installed_tarball",
    });
  }
  const policy = requireInstalledFile(
    pack.installedRoot,
    packageFiles,
    "docs/persona-v3-deterministic-policy.md",
    "deterministic policy document",
  );
  for (const marker of POLICY_MARKERS) if (!policy.includes(marker)) fail(`packaged deterministic policy document is missing ${marker}`);
  for (const rel of packageFiles) if (!installedFiles.has(rel)) fail(`tarball file did not survive npm install: ${rel}`);
  const productionPacks = countInstalledPackVersions(pack.installedRoot, installedEntries);
  if (productionPacks.physical_v3 !== 0) fail("physical v3 packs appeared in the packaged parity fixture unexpectedly");
  const statusEnv = { ...process.env };
  for (const key of Object.keys(statusEnv)) if (key.startsWith("ALPHACOUNCIL_")) delete statusEnv[key];
  const statusResult = runCommand(process.execPath, [
    "scripts/check-persona-v3-ai-assisted-solo.mjs",
    "--check",
    "--json",
  ], {
    cwd: pack.installedRoot,
    env: statusEnv,
    label: "installed AI-assisted review-capsule check",
  });
  const aiAssistedStatus = parseNpmJson(statusResult.stdout, "installed AI-assisted status");
  if (aiAssistedStatus.integrity_status !== "passed" || aiAssistedStatus.local_test_status !== "ready"
    || aiAssistedStatus.human_review_satisfied !== false || aiAssistedStatus.formal_ga_effect !== "none") {
    fail("installed AI-assisted review capsule crossed its assurance boundary", { aiAssistedStatus });
  }
  if (aiAssistedStatus.ai_review_coverage?.source?.verification_mode !== "packaged_capsule_only"
    || aiAssistedStatus.ai_review_coverage?.source?.raw_source_revalidated_count !== 0
    || !["extraction", "skeptic", "adjudication"].every((stage) => (
      aiAssistedStatus.ai_review_coverage?.semantic?.[stage]?.verification_mode === "packaged_capsule_only"
      && aiAssistedStatus.ai_review_coverage?.semantic?.[stage]?.raw_source_revalidated_count === 0
    ))) {
    fail("installed AI-assisted status must disclose capsule-only verification", { aiAssistedStatus });
  }
  return {
    contract,
    hosts,
    shipped_surface_count: shippedPaths.size,
    host_selection_instructions: {
      status: "passed",
      contract_id: "host_selector_returned_catalog_v1",
      canonical_catalog_count: CANONICAL_MASTER_COUNT,
      files: [...HOST_SELECTION_INSTRUCTION_PATHS],
    },
    deterministic_policy: {
      path: "docs/persona-v3-deterministic-policy.md",
      hash: sha256(policy),
      dsl_version: "1.1",
      status: "present_in_installed_tarball",
    },
    exclusions: {
      knowledge_staging: "absent",
      acquisitions: "absent",
      source_bin: "absent",
      local_host_e2e_evidence: "absent",
    },
    ai_assisted_review_capsule: {
      status: "passed",
      json_file_count: packagedReviews.length,
      source_verification_mode: aiAssistedStatus.ai_review_coverage.source.verification_mode,
      semantic_verification_modes: Object.fromEntries(
        ["extraction", "skeptic", "adjudication"].map((stage) => [
          stage,
          aiAssistedStatus.ai_review_coverage.semantic[stage].verification_mode,
        ]),
      ),
      local_test_status: aiAssistedStatus.local_test_status,
      human_review_satisfied: aiAssistedStatus.human_review_satisfied,
      formal_ga_effect: aiAssistedStatus.formal_ga_effect,
    },
    package_inventory: {
      status: "passed",
      runtime_closure_file_count: packageInventory.runtime_closure.file_count,
      classifications: packageInventory.classification_summary,
      forbidden_paths: packageInventory.forbidden_paths,
      required_trees: packageInventory.required_trees,
    },
    production_pack_inventory: productionPacks,
  };
}

function networkBlockerSource() {
  return [
    "const fs = require('node:fs');",
    "const sentinel = process.env.ALPHACOUNCIL_PACKAGED_PARITY_NETWORK_SENTINEL;",
    "function blocked() {",
    "  if (sentinel) fs.appendFileSync(sentinel, 'blocked\\n');",
    "  const error = new Error('PACKAGED_PARITY_NETWORK_DISABLED');",
    "  error.code = 'PACKAGED_PARITY_NETWORK_DISABLED';",
    "  throw error;",
    "}",
    "const http = require('node:http');",
    "const https = require('node:https');",
    "const net = require('node:net');",
    "const tls = require('node:tls');",
    "const dns = require('node:dns');",
    "http.request = blocked; http.get = blocked;",
    "https.request = blocked; https.get = blocked;",
    "net.connect = blocked; net.createConnection = blocked;",
    "tls.connect = blocked;",
    "dns.lookup = blocked; dns.resolve = blocked; dns.resolve4 = blocked; dns.resolve6 = blocked;",
    "if (dns.promises) { dns.promises.lookup = async () => blocked(); dns.promises.resolve = async () => blocked(); }",
    "globalThis.fetch = async () => blocked();",
    "",
  ].join("\n");
}

function serverEnv({ dataDir, networkBlocker, networkSentinel }) {
  const env = { ...process.env };
  for (const key of [
    "ALPHACOUNCIL_AGENT_DATA_DIR",
    "ALPHACOUNCIL_KNOWLEDGE_DIR",
    "ALPHACOUNCIL_PERSONAS_DIR",
    "ALPHACOUNCIL_PERSONA_STAGING_DIR",
    "ALPHACOUNCIL_CODEX_PROMPTS_DIR",
    "ALPHACOUNCIL_DART_KEY",
    "ALPHACOUNCIL_EDINET_KEY",
    "ALPHACOUNCIL_TRUSTED_EXPERIMENT_SIGNERS",
  ]) delete env[key];
  return {
    ...env,
    ALPHACOUNCIL_AGENT_DATA_DIR: dataDir,
    ALPHACOUNCIL_PACKAGED_PARITY_NETWORK_SENTINEL: networkSentinel,
    NODE_OPTIONS: `--require=${networkBlocker}`,
  };
}

function startPackagedServer({ installedRoot, dataDir, networkBlocker, networkSentinel }) {
  const serverEntry = realpathSync(join(installedRoot, "mcp/server.mjs"));
  if (!inside(installedRoot, serverEntry)) fail("packaged server entry escaped the installed package");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: installedRoot,
    env: serverEnv({ dataDir, networkBlocker, networkSentinel }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const stderr = [];
  let buffer = "";
  let exited = null;
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (error) {
        const failure = new Error(`packaged server emitted non-JSON stdout: ${line} (${error.message})`);
        for (const waiter of pending.values()) waiter.reject(failure);
        pending.clear();
        continue;
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  child.on("close", (code, signal) => {
    exited = { code, signal };
    const error = new Error(`packaged server exited code=${code} signal=${signal}; stderr=${stderr.join("")}`);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });
  child.on("error", (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });

  function request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (exited) return Promise.reject(new Error("packaged server already exited"));
    const id = nextId++;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`timed out waiting for packaged ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return promise;
  }

  async function close() {
    if (!exited) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5_000);
      await once(child, "close");
      clearTimeout(timer);
    }
    if (exited?.code !== 0) fail(`packaged server did not close cleanly: ${JSON.stringify(exited)} ${stderr.join("")}`);
    return { stderr: stderr.join("") };
  }

  return {
    request,
    callTool: (name, args) => request("tools/call", { name, arguments: args }),
    close,
  };
}

function structured(response, label) {
  if (response?.error) fail(`${label}: ${response.error.code} ${response.error.message}`, { response });
  if (response?.result?.isError) fail(`${label}: tool returned isError`, { response });
  const value = response?.result?.structuredContent;
  if (!value || typeof value !== "object") fail(`${label}: missing structuredContent`, { response });
  return value;
}

function errorReason(response, label) {
  const reason = response?.error?.data?.reason;
  if (typeof reason !== "string") fail(`${label}: expected a structured JSON-RPC error reason`, { response });
  return reason;
}

function assertCompleteCatalog(opened, text, hostId) {
  if (opened.maximum !== CANONICAL_MASTER_COUNT || opened.masters?.length !== CANONICAL_MASTER_COUNT) fail(`${hostId}: packaged selector is not ${CANONICAL_MASTER_COUNT} seats`);
  const seen = new Set();
  for (const [offset, master] of opened.masters.entries()) {
    if (master.index !== offset + 1 || seen.has(master.id)) fail(`${hostId}: catalog order or IDs are invalid`);
    seen.add(master.id);
    for (const field of ["identity", "method", "best_for", "maturity", "maturity_label", "pack_hash"]) {
      if (typeof master[field] !== "string" || !master[field]) fail(`${hostId}: catalog seat ${master.id} lacks ${field}`);
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(master.pack_hash)) fail(`${hostId}: ${master.id} pack hash is invalid`);
    for (const visible of [`${master.index}. `, `[${master.id}]`, master.identity, master.method, master.best_for, master.maturity, master.maturity_label]) {
      if (!text.includes(visible)) fail(`${hostId}: returned text did not display ${master.id} field ${visible}`);
    }
  }
}

function assertLocalizedCatalog(opened, text, locale) {
  assertCompleteCatalog(opened, text, `installed-${locale.key}`);
  for (const master of opened.masters) {
    for (const field of ["identity", "method", "best_for", "maturity_label"]) {
      if (!locale.script.test(master[field])) fail(`installed-${locale.key}: ${master.id}.${field} lacks requested-locale prose`);
      if (locale.key !== "en" && /\b[a-z]+(?:_[a-z0-9]+)+\b/u.test(master[field])) {
        fail(`installed-${locale.key}: ${master.id}.${field} leaked a machine domain id into reader-facing prose`);
      }
    }
  }
}

function normalizedReceiptBinding(record) {
  return {
    symbol: record.symbol,
    catalog_hash: record.catalog_hash,
    intent_hash: record.intent_hash,
    selection_mode: record.selection_mode,
    selected_master_ids: record.selected_master_ids,
    selected_master_pack_hashes: record.selected_master_pack_hashes,
  };
}

function normalizedParity(session) {
  return {
    catalog: session.catalog,
    catalog_hash: session.opened.catalog_hash,
    selected_master_ids: session.confirmed.selected_master_ids,
    selected_master_pack_hashes: session.confirmed.selected_master_pack_hashes,
    receipt_binding: session.receiptBinding,
    run_masters: session.plan.run.masters,
    run_selection_pack_hashes: session.plan.run.master_selection.selected_master_pack_hashes,
  };
}

async function executePackagedAdapters({ pack, surfaces, tempRoot }) {
  const networkBlocker = join(tempRoot, "network-disabled.cjs");
  const networkSentinel = join(tempRoot, "network-attempted.log");
  writeFileSync(networkBlocker, networkBlockerSource(), { encoding: "utf8", flag: "wx", mode: 0o600 });
  const sessions = [];
  try {
    for (const hostId of PACKAGED_HOST_IDS) {
      const dataDir = join(tempRoot, "runtime", hostId);
      mkdirSync(dataDir, { recursive: true });
      const server = startPackagedServer({
        installedRoot: pack.installedRoot,
        dataDir,
        networkBlocker,
        networkSentinel,
      });
      await server.request("initialize", {});
      const listed = await server.request("tools/list", {});
      const tools = listed.result?.tools || [];
      if (tools.length !== EXPECTED_TOOL_COUNT) fail(`${hostId}: installed server exposed ${tools.length} tools, expected ${EXPECTED_TOOL_COUNT}`);
      sessions.push({ hostId, dataDir, server, toolCount: tools.length });
    }

    const localeCases = process.env.ALPHACOUNCIL_PERSONA_BUILD_PROFILE === "production"
      ? INSTALLED_LOCALE_CASES.slice(0, 1)
      : INSTALLED_LOCALE_CASES;
    const localeCatalogHashes = {};
    for (const locale of localeCases) {
      const response = await sessions[0].server.callTool("begin_council_selection", {
        symbol: SYMBOL,
        as_of: AS_OF,
        language: locale.language,
        prompt: locale.prompt,
        host: "installed-package-locale-smoke",
      });
      const opened = structured(response, `installed ${locale.language} begin_council_selection`);
      assertLocalizedCatalog(opened, response.result.content?.[0]?.text || "", locale);
      localeCatalogHashes[locale.key] = opened.catalog_hash;
    }

    for (const session of sessions) {
      const openedResponse = await session.server.callTool("begin_council_selection", {
        symbol: SYMBOL,
        as_of: AS_OF,
        language: LANGUAGE,
        prompt: PROMPT,
        host: session.hostId,
      });
      const opened = structured(openedResponse, `${session.hostId} begin_council_selection`);
      const catalogText = openedResponse.result.content?.[0]?.text || "";
      assertCompleteCatalog(opened, catalogText, session.hostId);
      const confirmed = structured(await session.server.callTool("confirm_master_selection", {
        selection_id: opened.selection_id,
        catalog_hash: opened.catalog_hash,
        display_ack: true,
        selected_master_ids: PACKAGED_SELECTION_INPUT,
        analyst_scope: "core",
      }), `${session.hostId} confirm_master_selection`);
      session.opened = opened;
      session.confirmed = confirmed;
      session.catalog = opened.masters.map((master) => ({
        index: master.index,
        id: master.id,
        identity: master.identity,
        method: master.method,
        best_for: master.best_for,
        maturity: master.maturity,
        pack_hash: master.pack_hash,
      }));
    }

    if (new Set(sessions.map((session) => session.confirmed.selection_receipt)).size !== sessions.length) {
      fail("packaged hosts returned duplicate selection receipt tokens");
    }
    for (const [index, session] of sessions.entries()) {
      const foreign = sessions[(index + 1) % sessions.length];
      const crossRunId = `PACKAGED-CROSS-${session.hostId.replaceAll("_", "-").toUpperCase()}`;
      const cross = await session.server.callTool("plan_visible_run", {
        symbol: SYMBOL,
        as_of: AS_OF,
        language: LANGUAGE,
        prompt: PROMPT,
        tasks: TASKS,
        grounding: GROUNDING,
        run_id: crossRunId,
        selection_receipt: foreign.confirmed.selection_receipt,
      });
      session.crossHostReason = errorReason(cross, `${session.hostId} foreign receipt`);
      if (session.crossHostReason !== "SELECTION_RECEIPT_UNKNOWN") {
        fail(`${session.hostId}: a foreign host receipt was not rejected as unknown`);
      }
      if (existsSync(join(session.dataDir, "runs", crossRunId))) fail(`${session.hostId}: rejected foreign receipt created a run`);
    }

    for (const session of sessions) {
      const runId = `PACKAGED-${session.hostId.replaceAll("_", "-").toUpperCase()}`;
      const plan = structured(await session.server.callTool("plan_visible_run", {
        symbol: SYMBOL,
        as_of: AS_OF,
        language: LANGUAGE,
        prompt: PROMPT,
        tasks: TASKS,
        grounding: GROUNDING,
        run_id: runId,
        selection_receipt: session.confirmed.selection_receipt,
      }), `${session.hostId} plan_visible_run`);
      if (!isDeepStrictEqual(plan.run.masters, session.confirmed.selected_master_ids)) fail(`${session.hostId}: run masters drifted from receipt`);
      if (!isDeepStrictEqual(plan.run.master_selection.selected_master_pack_hashes, session.confirmed.selected_master_pack_hashes)) {
        fail(`${session.hostId}: run selected pack hashes drifted from receipt`);
      }
      if (plan.run.grounding?.facts_unavailable !== true) fail(`${session.hostId}: explicit network-free grounding was not preserved`);

      const replayRunId = `PACKAGED-REPLAY-${session.hostId.replaceAll("_", "-").toUpperCase()}`;
      const replay = await session.server.callTool("plan_visible_run", {
        symbol: SYMBOL,
        as_of: AS_OF,
        language: LANGUAGE,
        prompt: PROMPT,
        tasks: TASKS,
        grounding: GROUNDING,
        run_id: replayRunId,
        selection_receipt: session.confirmed.selection_receipt,
      });
      session.replayReason = errorReason(replay, `${session.hostId} receipt replay`);
      if (session.replayReason !== "MASTER_SELECTION_REPLAYED") fail(`${session.hostId}: consumed receipt created another run`);
      if (existsSync(join(session.dataDir, "runs", replayRunId))) fail(`${session.hostId}: rejected receipt replay created a run`);

      const receiptFile = join(session.dataDir, "selections", "receipts", `${session.confirmed.selection_receipt}.json`);
      const selectionFile = join(session.dataDir, "selections", `${session.confirmed.selection_id}.json`);
      const receipt = readJson(receiptFile, `${session.hostId} receipt record`);
      const selection = readJson(selectionFile, `${session.hostId} selection record`);
      if (receipt.status !== "consumed" || receipt.consumed_by_run_id !== runId) fail(`${session.hostId}: receipt did not freeze one run`);
      if (selection.status !== "consumed" || selection.host !== session.hostId) fail(`${session.hostId}: selection host/lifecycle binding is invalid`);
      if (!/^[a-f0-9]{64}$/u.test(receipt.selection_hash || "")) fail(`${session.hostId}: receipt selection_hash is missing`);
      session.plan = plan;
      session.receiptBinding = normalizedReceiptBinding(receipt);
      session.requestHash = selection.request_hash;
    }

    const baseline = normalizedParity(sessions[0]);
    for (const session of sessions.slice(1)) {
      if (!isDeepStrictEqual(normalizedParity(session), baseline)) {
        fail(`${session.hostId}: packaged adapter result differs from ${sessions[0].hostId}`);
      }
    }
    if (new Set(sessions.map((session) => session.requestHash)).size !== sessions.length) {
      fail("host-specific request hashes were not distinct");
    }
    if (existsSync(networkSentinel)) fail("packaged adapter E2E attempted a network call despite explicit grounding");
    const maturityCounts = Object.fromEntries(
      [...new Set(baseline.catalog.map((master) => master.maturity))]
        .sort().map((maturity) => [maturity, baseline.catalog.filter((master) => master.maturity === maturity).length]),
    );
    return {
      status: "passed",
      evidence_scope: "installed_npm_tarball_mcp_stdio_adapters_only",
      host_order: PACKAGED_HOST_IDS,
      host_count: sessions.length,
      tool_count: EXPECTED_TOOL_COUNT,
      locale_count: localeCases.length,
      locale_catalog_hashes: localeCatalogHashes,
      catalog_count: baseline.catalog.length,
      catalog_hash: baseline.catalog_hash,
      catalog_order_hash: sha256(baseline.catalog),
      maturity_counts: maturityCounts,
      selection_input: PACKAGED_SELECTION_INPUT,
      selection_input_type: "stable_ids",
      selected_master_ids: baseline.selected_master_ids,
      selected_master_pack_hashes: baseline.selected_master_pack_hashes,
      receipt_binding_hash: sha256(baseline.receipt_binding),
      parity: {
        complete_catalog_order: true,
        catalog_hash: true,
        selected_master_ids: true,
        selected_master_pack_hashes: true,
        receipt_binding: true,
        run_masters: true,
        run_selection_pack_hashes: true,
      },
      controls: {
        npm_lifecycle_scripts: "disabled_with_ignore_scripts",
        npm_registry_access: "disabled_with_offline_install",
        external_model_calls: 0,
        network_attempts: 0,
        grounding: "explicit_facts_unavailable_fixture",
        configuration_write_target: "temporary_paths_only",
        receipt_tokens_in_report: "redacted",
      },
      hosts: sessions.map((session) => ({
        host_id: session.hostId,
        server_entry: "mcp/server.mjs",
        adapter_status: "passed",
        tool_count: session.toolCount,
        catalog_count: session.catalog.length,
        catalog_hash: session.opened.catalog_hash,
        selected_master_ids: session.confirmed.selected_master_ids,
        selected_master_pack_hashes: session.confirmed.selected_master_pack_hashes,
        receipt_binding_hash: sha256(session.receiptBinding),
        receipt_consumption: "one_run_only",
        cross_host_reuse: session.crossHostReason,
        second_run_replay: session.replayReason,
        run_masters: session.plan.run.masters,
        run_selection_pack_hashes: session.plan.run.master_selection.selected_master_pack_hashes,
        grounding: "explicit_facts_unavailable_fixture",
        external_cli_live_e2e: "not_run",
      })),
      packaged_surfaces: surfaces.hosts.map((host) => ({ host_id: host.host_id, status: host.status })),
    };
  } finally {
    const closeErrors = [];
    for (const session of sessions) {
      try { await session.server.close(); } catch (error) { closeErrors.push(`${session.hostId}: ${error.message}`); }
    }
    if (closeErrors.length) fail(`packaged servers did not close cleanly:\n- ${closeErrors.join("\n- ")}`);
  }
}

export async function runPackagedHostParity({ repoRoot = PACKAGED_PARITY_REPO_ROOT } = {}) {
  const root = realpathSync(resolve(repoRoot));
  const packageFile = join(root, "package.json");
  if (!existsSync(packageFile) || !statSync(packageFile).isFile()) fail(`repository package.json is missing: ${root}`);
  const tempRoot = safeTempRoot();
  let report;
  try {
    const pack = packAndInstall({ repoRoot: root, tempRoot });
    const surfaces = validatePackagedSurfaces(pack);
    const packagedAdapterE2e = await executePackagedAdapters({ pack, surfaces, tempRoot });
    const externalCli = Object.fromEntries(PACKAGED_HOST_IDS.map((hostId) => [hostId, "not_run"]));
    report = {
      schema_version: 1,
      artifact_kind: "alphacouncil_packaged_host_parity",
      evidence_scope: "installed_npm_tarball_mcp_stdio_adapters_only",
      package: {
        name: pack.packageName,
        version: pack.packageVersion,
        tarball_hash: pack.tarballHash,
        tarball_file_count: pack.tarFiles.length,
        installed_server_entry: "mcp/server.mjs",
      },
      package_surfaces: {
        hosts: surfaces.hosts,
        shipped_surface_count: surfaces.shipped_surface_count,
        host_selection_instructions: surfaces.host_selection_instructions,
        deterministic_policy: surfaces.deterministic_policy,
        exclusions: surfaces.exclusions,
        ai_assisted_review_capsule: surfaces.ai_assisted_review_capsule,
        package_inventory: surfaces.package_inventory,
      },
      packaged_adapter_e2e: packagedAdapterE2e,
      external_cli_live_e2e: {
        status: "not_run",
        hosts: externalCli,
      },
      physical_v3_decision_parity: {
        status: "not_run",
        reason: "production package contains zero physical PersonaPack v3 packs",
        production_pack_inventory: surfaces.production_pack_inventory,
      },
      temporary_workspace_cleanup: "pending",
    };
  } finally {
    cleanupTempRoot(tempRoot);
  }
  report.temporary_workspace_cleanup = "completed";
  return report;
}

export function renderPackagedHostParityMarkdown(report) {
  const e2e = report.packaged_adapter_e2e;
  const lines = [
    "# Installed npm-tarball packaged host parity",
    "",
    `Package: \`${report.package.name}@${report.package.version}\``,
    `Evidence scope: \`${report.evidence_scope}\``,
    `Packaged adapter E2E: **${e2e.status}**`,
    `External host CLI/model live E2E: **${report.external_cli_live_e2e.status}**`,
    `Physical PersonaPack v3 decision parity: **${report.physical_v3_decision_parity.status}** (${report.physical_v3_decision_parity.reason})`,
    "",
    `Tarball files: ${report.package.tarball_file_count}; tarball hash \`${report.package.tarball_hash}\`.`,
    `Catalog: ${e2e.catalog_count} seats; catalog hash \`${e2e.catalog_hash}\`.`,
    `Selection: \`${e2e.selection_input}\` → ${e2e.selected_master_ids.map((id) => `\`${id}\``).join(", ")}.`,
    "",
    "| Host adapter | Catalog | Receipt one-run | Cross-host reuse | Second-run replay | External CLI live E2E |",
    "|---|---:|---|---|---|---|",
  ];
  for (const host of e2e.hosts) {
    lines.push(`| \`${host.host_id}\` | ${host.catalog_count} | ${host.receipt_consumption} | ${host.cross_host_reuse} | ${host.second_run_replay} | ${host.external_cli_live_e2e} |`);
  }
  lines.push(
    "",
    "> This is an installed-package MCP adapter test. It is not evidence that Claude Code, Codex, OpenCode, or Grok Build external CLIs or models executed.",
    "",
    "Package exclusions:",
    "",
    `- knowledge/staging: ${report.package_surfaces.exclusions.knowledge_staging}`,
    `- acquisitions: ${report.package_surfaces.exclusions.acquisitions}`,
    `- source.bin: ${report.package_surfaces.exclusions.source_bin}`,
    "",
    "Package inventory:",
    "",
    `- status: ${report.package_surfaces.package_inventory.status}`,
    `- runtime static closure: ${report.package_surfaces.package_inventory.runtime_closure_file_count} files`,
    ...Object.entries(report.package_surfaces.package_inventory.classifications)
      .map(([category, value]) => `- ${category}: ${value.files} files; ${value.bytes} bytes`),
    "",
  );
  return lines.join("\n");
}
