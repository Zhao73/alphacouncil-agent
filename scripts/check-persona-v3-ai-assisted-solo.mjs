#!/usr/bin/env node
/** Report or gate the isolated AI-assisted solo assurance profile. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_AI_ASSISTED_SOLO_PROFILE,
  inspectAiAssistedSoloStatus,
  renderAiAssistedSoloStatus,
} from "./lib/persona-v3-ai-assisted-solo-status.mjs";

export function parseArgs(argv) {
  const out = {
    json: false,
    help: false,
    requirement: "integrity",
    profileFile: DEFAULT_AI_ASSISTED_SOLO_PROFILE,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--status") out.requirement = "integrity";
    else if (arg === "--check" || arg === "--require-local-ready") out.requirement = "local";
    else if (arg === "--gate" || arg === "--require-release-ready") out.requirement = "release";
    else if ([
      "--profile", "--pack-root", "--formula-root", "--source-review-root",
      "--formula-review-root", "--experiment-root", "--host-e2e-root", "--n-eff-file",
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      const field = {
        "--profile": "profileFile",
        "--pack-root": "packRoot",
        "--formula-root": "formulaRoot",
        "--source-review-root": "sourceReviewRoot",
        "--formula-review-root": "formulaReviewRoot",
        "--experiment-root": "experimentRoot",
        "--host-e2e-root": "hostE2eRoot",
        "--n-eff-file": "nEffFile",
      }[arg];
      out[field] = resolve(value);
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return Object.freeze(out);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage: node scripts/check-persona-v3-ai-assisted-solo.mjs [--status|--check|--gate] [--json]",
      "",
      "  --status                 report integrity and all coverage (default)",
      "  --check                  require 26 packs + 31 source + 52 formula AI reviews",
      "  --gate                   require 8 machine simulations, 4 live hosts and an honest N_eff disclosure",
      "  --profile PATH           override the immutable AI-assisted profile contract",
      "  --source-review-root PATH",
      "  --formula-review-root PATH",
      "  --experiment-root PATH",
      "  --host-e2e-root PATH",
      "  --n-eff-file PATH",
      "  --json",
      "",
      "This command never satisfies human review and has formal_ga_effect=none.",
      "",
    ].join("\n"));
    return 0;
  }
  const report = inspectAiAssistedSoloStatus(args);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderAiAssistedSoloStatus(report)}\n`);
  if (report.integrity_status !== "passed") return 1;
  if (args.requirement === "local" && report.local_test_status !== "ready") return 1;
  if (args.requirement === "release" && report.release_status !== "ready") return 1;
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`AI-assisted solo status failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
