#!/usr/bin/env node
/** Prepare and review human source anchors in non-production PersonaPack v3 staging. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectSourceAdjudications,
  prepareSourceAdjudication,
  readHumanJsonFile,
  reviewSourceAdjudication,
} from "../mcp/lib/personas-v3/source-adjudication.mjs";
import { defaultStagingRoot } from "../mcp/lib/personas-v3/staging.mjs";

function takeOnce(seen, flag, value) {
  if (seen.has(flag)) throw new Error(`${flag} may be supplied only once`);
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  seen.add(flag);
  return value;
}

export function parseArgs(argv) {
  const positional = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
  const offset = positional ? 1 : 0;
  if (positional && !["prepare", "review", "check"].includes(positional)) throw new Error(`unknown operation: ${positional}`);
  const args = {
    operation: positional || "check",
    write: false,
    json: false,
    help: false,
    personaId: null,
    candidateId: null,
    sourceId: null,
    proposalFile: null,
    attestationFile: null,
    trustedReviewerKeysFile: null,
    root: defaultStagingRoot(),
    productionRoot: undefined,
    personaDir: undefined,
  };
  const seen = new Set();
  for (let index = offset; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--write") args.write = true;
    else if (flag === "--json") args.json = true;
    else if (flag === "--check") {
      if (positional && positional !== "check") throw new Error("--check cannot be combined with prepare or review");
      args.operation = "check";
    } else if (flag === "--help" || flag === "-h") args.help = true;
    else if (["--persona", "--candidate-id", "--source-id", "--proposal", "--attestation", "--trusted-reviewer-keys", "--root", "--production-root", "--persona-dir"].includes(flag)) {
      const value = takeOnce(seen, flag, argv[index + 1]);
      if (flag === "--persona") args.personaId = value;
      if (flag === "--candidate-id") args.candidateId = value;
      if (flag === "--source-id") args.sourceId = value;
      if (flag === "--proposal") args.proposalFile = resolve(value);
      if (flag === "--attestation") args.attestationFile = resolve(value);
      if (flag === "--trusted-reviewer-keys") args.trustedReviewerKeysFile = resolve(value);
      if (flag === "--root") args.root = resolve(value);
      if (flag === "--production-root") args.productionRoot = resolve(value);
      if (flag === "--persona-dir") args.personaDir = resolve(value);
      index += 1;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (args.operation === "check") {
    if (args.write) throw new Error("check mode never accepts --write");
    if ([args.personaId, args.candidateId, args.sourceId, args.proposalFile, args.attestationFile, args.trustedReviewerKeysFile].some((value) => value !== null)) {
      throw new Error("check mode does not accept prepare/review inputs");
    }
  }
  if (args.operation === "prepare") {
    if (!args.personaId || !args.candidateId || !args.proposalFile) throw new Error("prepare requires --persona, --candidate-id and --proposal");
    if (args.sourceId || args.attestationFile || args.trustedReviewerKeysFile) throw new Error("prepare does not accept review inputs");
  }
  if (args.operation === "review") {
    if (!args.personaId || !args.sourceId || !args.attestationFile) throw new Error("review requires --persona, --source-id and --attestation");
    if (args.candidateId || args.proposalFile) throw new Error("review does not accept --candidate-id or --proposal");
  }
  return Object.freeze(args);
}

function roots(args) {
  return Object.fromEntries(Object.entries({
    root: args.root,
    productionRoot: args.productionRoot,
    personaDir: args.personaDir,
  }).filter(([, value]) => value !== undefined));
}

function helpText() {
  return [
    "Usage:",
    "  node scripts/adjudicate-persona-source.mjs [check|--check] [--json]",
    "  node scripts/adjudicate-persona-source.mjs prepare --persona ID --candidate-id ID --proposal FILE [--write] [--json]",
    "  node scripts/adjudicate-persona-source.mjs review --persona ID --source-id ID --attestation FILE [--trusted-reviewer-keys FILE] [--write] [--json]",
    "",
    "The default is read-only check mode. Prepare/review without --write are plan-only.",
    "Proposal metadata and Ed25519 reviewer attestations must be supplied by humans as JSON files.",
    "Trusted reviewer public keys come from --trusted-reviewer-keys or ALPHACOUNCIL_TRUSTED_SOURCE_REVIEW_KEYS.",
    "The command never infers metadata, auto-approves a source, edits acquisition records, or writes production knowledge.",
    "",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(helpText());
    return 0;
  }
  let result;
  if (args.operation === "check") result = inspectSourceAdjudications(roots(args));
  else if (args.operation === "prepare") {
    result = await prepareSourceAdjudication({
      ...roots(args),
      write: args.write,
      personaId: args.personaId,
      candidateId: args.candidateId,
      proposal: readHumanJsonFile(args.proposalFile),
    });
  } else {
    result = await reviewSourceAdjudication({
      ...roots(args),
      write: args.write,
      personaId: args.personaId,
      sourceId: args.sourceId,
      attestation: readHumanJsonFile(args.attestationFile),
      trustedReviewerKeys: args.trustedReviewerKeysFile
        ? readHumanJsonFile(args.trustedReviewerKeysFile) : undefined,
    });
  }
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (args.operation === "check") {
    process.stdout.write([
      "persona-source-adjudication:",
      `records=${result.record_count}`,
      `pending=${result.status_counts.pending}`,
      `approved=${result.status_counts.approved}`,
      `rejected=${result.status_counts.rejected}`,
      `blocked=${result.status_counts.blocked}`,
      `invalid=${result.invalid_count}`,
      "production_writes=0",
      `hash=${result.inventory_hash}`,
      "",
    ].join(" "));
  } else {
    process.stdout.write([
      "persona-source-adjudication:",
      `operation=${args.operation}`,
      `mode=${result.mode}`,
      `status=${result.status}`,
      `wrote=${result.wrote}`,
      `source_id=${result.source_id}`,
      `anchor_hash=${result.anchor_hash}`,
      "production_writes=0",
      "",
    ].join(" "));
  }
  return args.operation === "check" && result.invalid_count ? 1 : 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`persona source adjudication failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
