#!/usr/bin/env node
/** Plan/write the 52-entry formula queue, or compile reviewed specs to DSL 1.1 JSON. */

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultStagingRoot } from "../mcp/lib/personas-v3/staging.mjs";
import {
  DEFAULT_FORMULA_CANDIDATE_ROOT,
  DEFAULT_COMPILED_FORMULA_ROOT,
  planApprovedFormulaCompilation,
  planPersonaV3FormulaPipeline,
  renderFormulaAuthoringPlan,
  writePersonaV3FormulaCandidates,
  writeApprovedFormulaCompilation,
} from "./lib/persona-v3-formula-pipeline.mjs";
import {
  DEFAULT_SOLO_TEST_FORMULA_ROOT,
  planSoloTestFormulaCompilation,
  writeSoloTestFormulaCompilation,
} from "./lib/persona-v3-solo-formula-pipeline.mjs";

export function parseArgs(argv) {
  const args = {
    write: false,
    json: false,
    markdown: false,
    help: false,
    root: defaultStagingRoot(),
    outputRoot: DEFAULT_FORMULA_CANDIDATE_ROOT,
    compiledOutputRoot: DEFAULT_COMPILED_FORMULA_ROOT,
    candidateRoot: DEFAULT_FORMULA_CANDIDATE_ROOT,
    compileApproved: false,
    compileSoloTest: false,
    trustedFormulaReviewerKeysFile: null,
    soloOutputRoot: DEFAULT_SOLO_TEST_FORMULA_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--compile-approved" || arg === "--check-candidates") args.compileApproved = true;
    else if (arg === "--compile-solo-test" || arg === "--solo-test") args.compileSoloTest = true;
    else if (arg === "--check" || arg === "--plan") args.write = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--markdown") args.markdown = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if ([
      "--root", "--output-root", "--compiled-output-root", "--candidate-root",
      "--trusted-formula-reviewer-keys", "--solo-output-root",
    ].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      if (arg === "--root") args.root = resolve(value);
      else if (arg === "--output-root") args.outputRoot = resolve(value);
      else if (arg === "--compiled-output-root") args.compiledOutputRoot = resolve(value);
      else if (arg === "--candidate-root") args.candidateRoot = resolve(value);
      else if (arg === "--solo-output-root") args.soloOutputRoot = resolve(value);
      else args.trustedFormulaReviewerKeysFile = resolve(value);
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.json && args.markdown) throw new Error("--json and --markdown are mutually exclusive");
  if (args.compileApproved && args.compileSoloTest) throw new Error("--compile-approved and --compile-solo-test are mutually exclusive");
  if (args.compileApproved && args.markdown) throw new Error("--compile-approved cannot be combined with --markdown");
  if (args.compileSoloTest && args.markdown) throw new Error("--compile-solo-test cannot be combined with --markdown");
  if (args.compileApproved && !args.trustedFormulaReviewerKeysFile) {
    throw new Error("--compile-approved requires --trusted-formula-reviewer-keys");
  }
  return Object.freeze(args);
}

function readTrustedFormulaReviewerKeys(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("--trusted-formula-reviewer-keys must be a physical JSON file");
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`--trusted-formula-reviewer-keys is invalid JSON (${error.message})`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage: node scripts/compile-persona-v3-formulas.mjs [--check|--plan|--write] [--json|--markdown]",
      "       node scripts/compile-persona-v3-formulas.mjs --compile-approved --candidate-root PATH --trusted-formula-reviewer-keys FILE [--write]",
      "       node scripts/compile-persona-v3-formulas.mjs --compile-solo-test --candidate-root PATH [--write]",
      "",
      "  --check, --plan     inspect and validate the 52-entry authoring queue (default; no writes)",
      "  --write             write only isolated non-production staging candidate artifacts",
      "  --compile-approved  require and compile exactly 52 human-edited specs plus dual-signed bundles",
      "  --check-candidates   alias for --compile-approved without writes",
      "  --compile-solo-test derive 52 executable identity proxies from the exact pending queue; never production eligible",
      "  --solo-test          alias for --compile-solo-test",
      "  --candidate-root     root containing specs/ and approvals/ for all 52 planned tools",
      "  --trusted-formula-reviewer-keys  Ed25519 public-key registry authorized for formula_review",
      "  --compiled-output-root  isolated staging output for per-persona tools/evidence",
      "  --solo-output-root   isolated staging output for provisional derived-proxy tools/evidence",
      "  --root PATH         override the 26-seat prototype staging root",
      "  --output-root PATH  override write root; basename must be persona-v3-formula-candidates below staging",
      "  --json              emit the machine-readable plan",
      "  --markdown          emit the complete 52-entry authoring queue",
      "",
      "No mode writes knowledge/masters, production manifests, release evidence, registry data, or version metadata.",
      "",
    ].join("\n"));
    return 0;
  }

  if (args.compileApproved) {
    const options = {
      root: args.root,
      candidateRoot: args.candidateRoot,
      trustedFormulaReviewerKeys: readTrustedFormulaReviewerKeys(args.trustedFormulaReviewerKeysFile),
    };
    const result = args.write
      ? writeApprovedFormulaCompilation({ ...options, outputRoot: args.compiledOutputRoot })
      : planApprovedFormulaCompilation(options);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write([
      "persona-v3-formulas:",
      `mode=${args.write ? "write_isolated_staging_compilation" : "check_approved_candidates"}`,
      `tools=${result.compiled_tool_count}/52`,
      `formula_approvals=${result.formula_approval_binding_count}/52`,
      `hash=${result.compilation_hash}`,
      "",
    ].join(" "));
    return result.compiled_tool_count === 52 && result.formula_approval_binding_count === 52 ? 0 : 1;
  }

  if (args.compileSoloTest) {
    const options = {
      root: args.root,
      candidateRoot: args.candidateRoot,
    };
    const result = args.write
      ? writeSoloTestFormulaCompilation({ ...options, outputRoot: args.soloOutputRoot })
      : planSoloTestFormulaCompilation(options);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write([
      "persona-v3-formulas:",
      `mode=${args.write ? "write_isolated_solo_test_compilation" : "check_solo_test_compilation"}`,
      `tools=${result.compiled_tool_count}/52`,
      `provisional_derivations=${result.provisional_derivation_count}/52`,
      `formula_approvals=${result.formula_approval_binding_count}/52`,
      `assurance=${result.assurance_class}`,
      `production_eligible=${result.production_eligible}`,
      `hash=${result.compilation_hash}`,
      "",
    ].join(" "));
    return result.compiled_tool_count === 52
      && result.provisional_derivation_count === 52
      && result.formula_approval_binding_count === 0
      && result.production_eligible === false ? 0 : 1;
  }

  const result = args.write
    ? writePersonaV3FormulaCandidates({ root: args.root, outputRoot: args.outputRoot })
    : planPersonaV3FormulaPipeline({ root: args.root });
  const plan = args.write ? { mode: result.mode, errors: [], inventory: result.inventory } : result;
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (args.markdown) process.stdout.write(renderFormulaAuthoringPlan(plan));
  else process.stdout.write([
    "persona-v3-formulas:",
    `mode=${args.write ? "write_staging_candidates_then_check" : "check_plan"}`,
    `seats=${plan.inventory.canonical_seat_count}/26`,
    `prototypes=${plan.inventory.prototype_count}/52`,
    `needs_authorship=${plan.inventory.needs_formula_authorship_count}`,
    `executable_candidates=${plan.inventory.executable_candidate_count}`,
    `dedicated_tools=${plan.inventory.dedicated_tool_count}`,
    `invalid=${plan.errors.length}`,
    `hash=${plan.inventory.inventory_hash}`,
    "",
  ].join(" "));
  return plan.errors.length ? 1 : 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`persona-v3 formula pipeline failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
