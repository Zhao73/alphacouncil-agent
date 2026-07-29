#!/usr/bin/env node
/** Inspect or gate the isolated PersonaPack v3 production-candidate tree. */

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inspectPersonaV3ProductionCandidates,
  renderPersonaV3ProductionCandidateReadiness,
} from "./lib/persona-v3-production-candidates.mjs";

export function parseArgs(argv) {
  const args = {
    root: null,
    personaDir: null,
    requireAdmission: "operational",
    trustedFormulaReviewerKeysFile: null,
    gate: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--gate") args.gate = true;
    else if (arg === "--check") args.gate = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (["--root", "--persona-dir", "--require-admission", "--trusted-formula-reviewer-keys"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--root") args.root = resolve(value);
      else if (arg === "--persona-dir") args.personaDir = resolve(value);
      else if (arg === "--trusted-formula-reviewer-keys") args.trustedFormulaReviewerKeysFile = resolve(value);
      else args.requireAdmission = value;
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return Object.freeze(args);
}

function readTrustedFormulaReviewerKeys(file) {
  if (file === null) return undefined;
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("--trusted-formula-reviewer-keys must be a physical JSON file");
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`--trusted-formula-reviewer-keys is invalid JSON (${error.message})`);
  }
}

function options(args) {
  return Object.fromEntries(Object.entries({
    root: args.root,
    personaDir: args.personaDir,
    requiredAdmission: args.requireAdmission,
    trustedFormulaReviewerKeys: readTrustedFormulaReviewerKeys(args.trustedFormulaReviewerKeysFile),
  }).filter(([, value]) => value !== null));
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage: node scripts/check-persona-v3-production-candidates.mjs [options]",
      "",
      "  --check                    inspect honestly without requiring readiness (default)",
      "  --gate                     exit non-zero unless every canonical seat clears the requested admission",
      "  --require-admission LEVEL  operational | candidate | method_model",
      "  --root PATH                override isolated staging candidate root",
      "  --persona-dir PATH         override canonical persona registry",
      "  --trusted-formula-reviewer-keys FILE  public-key registry authorized for formula_review",
      "  --json                     emit the complete machine-readable report",
      "",
    ].join("\n"));
    return 0;
  }
  const report = inspectPersonaV3ProductionCandidates(options(args));
  process.stdout.write(args.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${renderPersonaV3ProductionCandidateReadiness(report)}\n`);
  return args.gate && !report.summary.gate_clear ? 1 : 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`persona-v3 production-candidate check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
