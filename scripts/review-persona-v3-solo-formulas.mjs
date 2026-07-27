#!/usr/bin/env node
/** Build or verify the isolated 52-tool AI-assisted formula cross-review tree. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_AI_FORMULA_REVIEW_ROOT,
  planAIFormulaCrossReviews,
  verifyAIFormulaCrossReviewTree,
  writeAIFormulaCrossReviews,
} from "./lib/persona-v3-ai-formula-review.mjs";
import { DEFAULT_SOLO_TEST_FORMULA_ROOT } from "./lib/persona-v3-solo-formula-pipeline.mjs";

export function parseArgs(argv) {
  const args = {
    mode: "check",
    json: false,
    help: false,
    formulaRoot: DEFAULT_SOLO_TEST_FORMULA_ROOT,
    reviewRoot: DEFAULT_AI_FORMULA_REVIEW_ROOT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.mode = "write";
    else if (arg === "--check") args.mode = "check";
    else if (arg === "--plan") args.mode = "plan";
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (["--formula-root", "--review-root"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      if (arg === "--formula-root") args.formulaRoot = resolve(value);
      else args.reviewRoot = resolve(value);
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return [
    "Usage: node scripts/review-persona-v3-solo-formulas.mjs [--check|--plan|--write] [--json]",
    "",
    "--plan         recompute 52 machine review records without reading the review tree",
    "--write        write 52 reviews plus the manifest below isolated staging",
    "--check        require exact physical files and byte-stable recomputation (default)",
    "--formula-root override the physical solo-test formula tree",
    "--review-root  override the isolated AI review tree",
    "",
    "This command never writes formula approvals, human signatures, production packs, or releases.",
    "",
  ].join("\n");
}

function compact(result) {
  return [
    "persona-v3-ai-formula-review:",
    `mode=${result.mode || "plan_ai_formula_cross_reviews"}`,
    `reviews=${result.review_count}/52`,
    `roles=${result.role_count}/156`,
    `vectors=${result.test_vector_count}`,
    `invariants=${result.invariant_count}`,
    `mechanical_pass=${result.mechanical_pass_count}/52`,
    `disagreements=${result.disagreement_count}`,
    `semantic_unknown=${result.semantic_unknown_count}/52`,
    `human_reviewers=${result.human_reviewer_count}`,
    `approvals=${result.approval_count}`,
    `production_eligible=${result.production_eligible}`,
    `hash=${result.manifest_hash}`,
    "",
  ].join(" ");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  const options = { formulaRoot: args.formulaRoot };
  let result;
  if (args.mode === "write") result = writeAIFormulaCrossReviews({ ...options, outputRoot: args.reviewRoot });
  else if (args.mode === "check") result = verifyAIFormulaCrossReviewTree({ ...options, reviewRoot: args.reviewRoot });
  else {
    const plan = planAIFormulaCrossReviews(options);
    result = { ...plan.manifest, mode: "plan_ai_formula_cross_reviews" };
  }
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(compact(result));
  const okay = result.review_count === 52
    && result.role_count === 156
    && result.mechanical_pass_count === 52
    && result.disagreement_count === 0
    && result.semantic_unknown_count === 52
    && result.human_reviewer_count === 0
    && result.approval_count === 0
    && result.production_eligible === false;
  return okay ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`persona-v3 AI formula review failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
