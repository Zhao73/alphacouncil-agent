#!/usr/bin/env node
/** Offline signing CLI for an explicit, human-completed source review. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultKnowledgeDir } from "../mcp/lib/personas-v3/admission.mjs";
import { readHumanJsonFile } from "../mcp/lib/personas-v3/source-adjudication.mjs";
import { runOfflineSourceReviewSigning } from "../mcp/lib/personas-v3/source-review-signing.mjs";
import { defaultStagingRoot } from "../mcp/lib/personas-v3/staging.mjs";

function take(seen, flag, value) {
  if (seen.has(flag)) throw new Error(`${flag} may be supplied only once`);
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  seen.add(flag);
  return resolve(value);
}

export function parseArgs(argv) {
  const args = {
    write: false, json: false, help: false, requestFile: null, privateKeyFile: null,
    outputFile: null, stagingRoot: defaultStagingRoot(), productionRoot: defaultKnowledgeDir(),
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--write") args.write = true;
    else if (flag === "--check") args.write = false;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (["--request", "--private-key", "--output", "--root", "--production-root"].includes(flag)) {
      const value = take(seen, flag, argv[index + 1]);
      if (flag === "--request") args.requestFile = value;
      if (flag === "--private-key") args.privateKeyFile = value;
      if (flag === "--output") args.outputFile = value;
      if (flag === "--root") args.stagingRoot = value;
      if (flag === "--production-root") args.productionRoot = value;
      index += 1;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.help && (!args.requestFile || !args.privateKeyFile)) {
    throw new Error("signing requires --request and --private-key");
  }
  if (args.write && !args.outputFile) throw new Error("--write requires an explicit --output file");
  return Object.freeze(args);
}

function helpText() {
  return [
    "Usage:",
    "  node scripts/sign-persona-source-review.mjs --request FILE --private-key FILE [--check] [--json]",
    "  node scripts/sign-persona-source-review.mjs --request FILE --private-key FILE --output FILE --write [--json]",
    "",
    "The request must already contain the human reviewer identity, approve/reject decision, exact hashes, real reviewed_at timestamp, all true affirmations, and notes.",
    "Check mode validates the request and key without signing or writing. Write mode creates one new signed attestation and refuses overwrite.",
    "On POSIX the private key must deny group and other access; on Windows the signer checks a physical non-symlink key but cannot verify NTFS ACLs. Its bytes are never printed or written elsewhere.",
    "This command never generates a reviewer identity, decision, approval, timestamp, key pair, or production write.",
    "",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(helpText()); return 0; }
  const result = runOfflineSourceReviewSigning({
    write: args.write,
    request: readHumanJsonFile(args.requestFile),
    requestFile: args.requestFile,
    privateKeyFile: args.privateKeyFile,
    outputFile: args.outputFile,
    stagingRoot: args.stagingRoot,
    productionRoot: args.productionRoot,
  });
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write([
    "persona-source-review-signing:",
    `mode=${result.mode}`,
    `decision=${result.decision}`,
    `signer_key_id=${result.signer_key_id}`,
    `wrote=${result.wrote}`,
    `output=${result.output || "none"}`,
    "private_key_output=false",
    "identity_generated=false",
    "approval_generated=false",
    "production_writes=0",
    `payload_hash=${result.signed_payload_hash}`,
    "",
  ].join(" "));
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`source review signing failed: ${error.message}\n`); process.exitCode = 1; }
}
