#!/usr/bin/env node
/** Build or verify machine-only, non-production source pre-review artifacts. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultAiSourcePreReviewRoot,
  inspectAiSourcePreReviews,
  writeAiSourcePreReviews,
} from "../mcp/lib/personas-v3/ai-source-pre-review.mjs";
import { defaultKnowledgeDir } from "../mcp/lib/personas-v3/admission.mjs";
import { defaultStagingRoot } from "../mcp/lib/personas-v3/staging.mjs";

function take(seen, flag, value) {
  if (seen.has(flag)) throw new Error(`${flag} may be supplied only once`);
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  seen.add(flag);
  return resolve(value);
}
export function parseArgs(argv) {
  const args = {
    write: false,
    json: false,
    help: false,
    root: defaultStagingRoot(),
    preReviewRoot: null,
    productionRoot: defaultKnowledgeDir(),
    personaDir: undefined,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--write") args.write = true;
    else if (flag === "--check") args.write = false;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (["--root", "--output-root", "--production-root", "--persona-dir"].includes(flag)) {
      const value = take(seen, flag, argv[index + 1]);
      if (flag === "--root") args.root = value;
      if (flag === "--output-root") args.preReviewRoot = value;
      if (flag === "--production-root") args.productionRoot = value;
      if (flag === "--persona-dir") args.personaDir = value;
      index += 1;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.preReviewRoot) args.preReviewRoot = defaultAiSourcePreReviewRoot({ stagingRoot: args.root });
  return Object.freeze(args);
}

function helpText() {
  return [
    "Usage:",
    "  node scripts/pre-review-persona-sources.mjs --check [--json]",
    "  node scripts/pre-review-persona-sources.mjs --write [--json]",
    "",
    "--write creates only missing deterministic AI pre-review files and refuses to overwrite differences.",
    "--check requires every retrieved source candidate to have one exact source-bound artifact.",
    "Artifacts use extractor, skeptic, and adjudicator roles but always remain machine-only:",
    "human_reviewed=false, human_claims=false, production_effect=none.",
    "They do not edit human adjudication ledgers, satisfy trusted review quorum, or promote packs.",
    "",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(helpText()); return 0; }
  const options = Object.fromEntries(Object.entries({
    root: args.root,
    preReviewRoot: args.preReviewRoot,
    productionRoot: args.productionRoot,
    personaDir: args.personaDir,
  }).filter(([, value]) => value !== undefined));
  const report = args.write ? writeAiSourcePreReviews(options) : inspectAiSourcePreReviews(options);
  const result = {
    mode: args.write ? "write" : "check",
    ...report,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write([
    "persona-ai-source-prereview:",
    `mode=${result.mode}`,
    `valid=${result.valid}`,
    `seats=${result.seats_with_candidates}/${result.canonical_master_count}`,
    `artifacts=${result.valid_artifact_count}/${result.candidate_count}`,
    `role_outputs=${result.role_output_count}`,
    "human_reviews=0",
    "human_claims=0",
    "production_writes=0",
    `errors=${result.errors.length}`,
    `index_hash=${result.index_hash ?? "none"}`,
    "",
  ].join(" "));
  return result.valid ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`AI source pre-review failed: ${error.message}\n`); process.exitCode = 1; }
}
