#!/usr/bin/env node
/** Verify, cut over to, or roll back an immutable PersonaPack v3 release pointer. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync, readFileSync } from "node:fs";

import {
  defaultPersonaReleaseRoot,
  planPersonaReleasePointer,
  promotePersonaRelease,
  resolveCurrentPersonaRelease,
  verifyPersonaRelease,
} from "../mcp/lib/personas-v3/releases.mjs";

export function parseArgs(argv) {
  const args = {
    action: null,
    releaseId: null,
    write: false,
    json: false,
    help: false,
    releaseRoot: defaultPersonaReleaseRoot(),
    personaDir: null,
    approvalFile: null,
    trustedReleaseKeysFile: null,
    trustedReviewerKeysFile: null,
    trustedFormulaReviewerKeysFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--verify", "--cutover", "--rollback"].includes(arg)) {
      if (args.action) throw new Error("choose exactly one of --verify, --cutover, --rollback or --current");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a release id`);
      args.action = arg.slice(2);
      args.releaseId = value;
      index += 1;
    } else if (arg === "--current") {
      if (args.action) throw new Error("choose exactly one action");
      args.action = "current";
    } else if (arg === "--write") args.write = true;
    else if (arg === "--check") args.write = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if ([
      "--release-root", "--persona-dir", "--approval", "--trusted-release-keys",
      "--trusted-reviewer-keys", "--trusted-formula-reviewer-keys",
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      if (arg === "--release-root") args.releaseRoot = resolve(value);
      if (arg === "--persona-dir") args.personaDir = resolve(value);
      if (arg === "--approval") args.approvalFile = resolve(value);
      if (arg === "--trusted-release-keys") args.trustedReleaseKeysFile = resolve(value);
      if (arg === "--trusted-reviewer-keys") args.trustedReviewerKeysFile = resolve(value);
      if (arg === "--trusted-formula-reviewer-keys") args.trustedFormulaReviewerKeysFile = resolve(value);
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && !args.action) throw new Error("one of --verify, --cutover, --rollback or --current is required");
  if (args.write && new Set(["verify", "current"]).has(args.action)) throw new Error("--write is valid only with --cutover or --rollback");
  if (!args.help && new Set(["cutover", "rollback"]).has(args.action) && !args.approvalFile) {
    throw new Error("--approval is required for cutover and rollback previews and writes");
  }
  if (!args.help && new Set(["verify", "current"]).has(args.action) && args.approvalFile) {
    throw new Error("--approval is valid only with --cutover or --rollback");
  }
  if (!args.help && args.action === "verify" && args.trustedReleaseKeysFile) {
    throw new Error("--trusted-release-keys is only used for current, cutover or rollback");
  }
  return Object.freeze(args);
}

function common(args) {
  return Object.fromEntries(Object.entries({
    releaseRoot: resolve(args.releaseRoot),
    personaDir: args.personaDir,
  }).filter(([, value]) => value !== null));
}

function readPhysicalJson(file, label) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a physical regular file`);
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`${label} is invalid JSON (${error.message})`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage:",
      "  node scripts/promote-persona-v3-release.mjs --verify ID --trusted-reviewer-keys FILE --trusted-formula-reviewer-keys FILE",
      "  node scripts/promote-persona-v3-release.mjs --cutover ID --approval FILE [--trusted-release-keys FILE] --trusted-reviewer-keys FILE --trusted-formula-reviewer-keys FILE [--write]",
      "  node scripts/promote-persona-v3-release.mjs --rollback ID --approval FILE [--trusted-release-keys FILE] --trusted-reviewer-keys FILE --trusted-formula-reviewer-keys FILE [--write]",
      "  node scripts/promote-persona-v3-release.mjs --current [--trusted-release-keys FILE] --trusted-reviewer-keys FILE --trusted-formula-reviewer-keys FILE",
      "",
      "Cutover and rollback are check-only previews unless --write is explicit.",
      "",
    ].join("\n"));
    return 0;
  }
  let result;
  const approvalOptions = args.approvalFile ? {
    approvalDocument: readPhysicalJson(args.approvalFile, "release approval"),
  } : {};
  const trustOptions = {
    ...(args.trustedReleaseKeysFile
      ? { trustedReleaseKeys: readPhysicalJson(args.trustedReleaseKeysFile, "trusted release key registry") }
      : {}),
    ...(args.trustedReviewerKeysFile
      ? { trustedReviewerKeys: readPhysicalJson(args.trustedReviewerKeysFile, "trusted source-review key registry") }
      : {}),
    ...(args.trustedFormulaReviewerKeysFile
      ? { trustedFormulaReviewerKeys: readPhysicalJson(args.trustedFormulaReviewerKeysFile, "trusted formula-review key registry") }
      : {}),
  };
  if (args.action === "verify") result = verifyPersonaRelease({ releaseId: args.releaseId, ...trustOptions, ...common(args) });
  else if (args.action === "current") result = resolveCurrentPersonaRelease({ ...trustOptions, ...common(args) });
  else if (args.write) result = promotePersonaRelease({
    releaseId: args.releaseId,
    operation: args.action,
    ...approvalOptions,
    ...trustOptions,
    ...common(args),
  });
  else result = planPersonaReleasePointer({
    releaseId: args.releaseId,
    operation: args.action,
    ...approvalOptions,
    ...trustOptions,
    ...common(args),
  });
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const releaseId = result.release_id || result.pointer?.release_id || result.target?.release_id || result.release?.release_id;
    process.stdout.write(`persona-v3-release-promote: mode=${args.write ? "write" : "check_only"} action=${args.action} release_id=${releaseId || "none"} status=${result.status || result.current?.status || "planned"}\n`);
  }
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`persona-v3 release promotion failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
