#!/usr/bin/env node

import { exportRunBundle, formatVerificationSummary, verifyRunBundle } from "./lib/run-bundle.mjs";

function usage() {
  return [
    "Usage: node scripts/export-run-bundle.mjs --run-dir PATH --output PATH",
    "",
    "Exports one immutable, hash-inventoried review bundle. The output path must not exist.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--run-dir") options.runDir = argv[++index];
    else if (arg === "--output") options.outputDir = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    if (!options.runDir || !options.outputDir) throw new Error(usage());
    const exported = exportRunBundle(options);
    const verified = verifyRunBundle({ bundleDir: exported.bundle_dir });
    process.stdout.write(`${formatVerificationSummary(verified)}\n`);
    process.stdout.write(`bundle_dir: ${exported.bundle_dir}\n`);
    if (verified.structure.status !== "PASS") process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`run-bundle export failed: ${error.message}\n`);
  process.exitCode = 1;
}
