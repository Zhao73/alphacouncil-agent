#!/usr/bin/env node

import { formatVerificationSummary, verifyRunBundle } from "./lib/run-bundle.mjs";

function usage() {
  return [
    "Usage: node scripts/verify-run-bundle.mjs --bundle PATH [--require-claim-ready] [--json]",
    "",
    "Default exit: nonzero only for structure failure.",
    "--require-claim-ready: also exits nonzero when marketing/release evidence is blocked.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { requireClaimReady: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--bundle") options.bundleDir = argv[++index];
    else if (arg === "--require-claim-ready") options.requireClaimReady = true;
    else if (arg === "--json") options.json = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    if (!options.bundleDir) throw new Error(usage());
    const result = verifyRunBundle({ bundleDir: options.bundleDir });
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatVerificationSummary(result)}\n`);
    if (result.structure.status !== "PASS") process.exitCode = 1;
    else if (options.requireClaimReady && result.claim_readiness.status !== "READY") process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`run-bundle verification failed: ${error.message}\n`);
  process.exitCode = 1;
}
