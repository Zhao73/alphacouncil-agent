#!/usr/bin/env node
/** Validate or atomically assemble one immutable 26-seat PersonaPack v3 release. */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assemblePersonaRelease,
  defaultPersonaReleaseRoot,
  planPersonaRelease,
} from "../mcp/lib/personas-v3/releases.mjs";

export function parseArgs(argv) {
  const args = {
    write: false,
    json: false,
    help: false,
    releaseId: null,
    sourceRoot: null,
    releaseRoot: defaultPersonaReleaseRoot(),
    personaDir: null,
    adjudicationRoot: null,
    trustedReviewerKeysFile: null,
    trustedFormulaReviewerKeysFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--check") args.write = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if ([
      "--release-id", "--source-root", "--release-root", "--persona-dir",
      "--adjudication-root", "--trusted-reviewer-keys", "--trusted-formula-reviewer-keys",
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--release-id") args.releaseId = value;
      if (arg === "--source-root") args.sourceRoot = resolve(value);
      if (arg === "--release-root") args.releaseRoot = resolve(value);
      if (arg === "--persona-dir") args.personaDir = resolve(value);
      if (arg === "--adjudication-root") args.adjudicationRoot = resolve(value);
      if (arg === "--trusted-reviewer-keys") args.trustedReviewerKeysFile = resolve(value);
      if (arg === "--trusted-formula-reviewer-keys") args.trustedFormulaReviewerKeysFile = resolve(value);
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.help && !args.releaseId) throw new Error("--release-id is required");
  if (!args.help && !args.sourceRoot) throw new Error("--source-root is required");
  if (!args.help && !args.adjudicationRoot) throw new Error("--adjudication-root is required");
  if (!args.help && !args.trustedReviewerKeysFile) throw new Error("--trusted-reviewer-keys is required");
  if (!args.help && !args.trustedFormulaReviewerKeysFile) throw new Error("--trusted-formula-reviewer-keys is required");
  return Object.freeze(args);
}

function readTrustedReviewerKeys(file) {
  if (lstatSync(file).isSymbolicLink()) throw new Error("--trusted-reviewer-keys must be a physical regular file");
  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("--trusted-reviewer-keys must be a physical regular file");
    try {
      return JSON.parse(readFileSync(descriptor, "utf8"));
    } catch (error) {
      throw new Error(`--trusted-reviewer-keys is invalid JSON (${error.message})`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function options(args) {
  return Object.fromEntries(Object.entries({
    releaseId: args.releaseId,
    sourceRoot: args.sourceRoot,
    releaseRoot: resolve(args.releaseRoot),
    personaDir: args.personaDir,
    adjudicationRoot: args.adjudicationRoot,
    trustedReviewerKeys: readTrustedReviewerKeys(args.trustedReviewerKeysFile),
    trustedFormulaReviewerKeys: readTrustedReviewerKeys(args.trustedFormulaReviewerKeysFile),
  }).filter(([, value]) => value !== null));
}

export function renderResult(result) {
  return [
    "persona-v3-release-assemble:",
    `mode=${result.mode}`,
    `release_id=${result.release_id}`,
    `packs=${result.canonical_master_count}`,
    `manifest_hash=${result.release_manifest_hash}`,
    `inventory_hash=${result.source_inventory_hash}`,
    `status=${result.status || "planned"}`,
  ].join(" ");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage: node scripts/assemble-persona-v3-release.mjs --release-id ID --source-root PATH --adjudication-root PATH --trusted-reviewer-keys FILE --trusted-formula-reviewer-keys FILE [--check|--write]",
      "",
      "  --check            validate and render the planned immutable release (default; no writes)",
      "  --write            copy, fsync and publish with one same-filesystem atomic rename",
      "  --release-root     override knowledge/persona-releases",
      "  --persona-dir      override the canonical persona registry",
      "  --adjudication-root directory containing <persona>/source-adjudication-ledger.json",
      "  --trusted-reviewer-keys JSON public-key registry authorized for source_review",
      "  --trusted-formula-reviewer-keys JSON public-key registry authorized for formula_review",
      "  --json             emit machine-readable output",
      "",
    ].join("\n"));
    return 0;
  }
  const result = args.write ? assemblePersonaRelease(options(args)) : planPersonaRelease(options(args));
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${renderResult(result)}\n`);
  return result.canonical_master_count === 26 ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`persona-v3 release assembly failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
