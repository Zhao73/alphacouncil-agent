#!/usr/bin/env node
/** Write/check round-2 AI skeptic artifacts; never adjudication or human approval. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultKnowledgeDir } from "../mcp/lib/personas-v3/admission.mjs";
import { defaultSemanticSourceExtractionRoot } from "../mcp/lib/personas-v3/semantic-source-extraction.mjs";
import {
  defaultSemanticSourceSkepticRoot, inspectSemanticSourceSkepticReviews,
  writeSemanticSourceSkepticReviews,
} from "../mcp/lib/personas-v3/semantic-source-skeptic-review.mjs";
import { defaultStagingRoot } from "../mcp/lib/personas-v3/staging.mjs";

export function parseArgs(argv) {
  const args = {
    write: false, json: false, help: false, root: defaultStagingRoot(), extractionRoot: null,
    outputRoot: null, productionRoot: defaultKnowledgeDir(), personaDir: undefined, pdftotext: undefined,
  };
  const once = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--write") args.write = true;
    else if (flag === "--check") args.write = false;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (["--root", "--extraction-root", "--output-root", "--production-root", "--persona-dir", "--pdftotext"].includes(flag)) {
      if (once.has(flag) || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`${flag} requires one value`);
      once.add(flag);
      const value = resolve(argv[++index]);
      if (flag === "--root") args.root = value;
      else if (flag === "--extraction-root") args.extractionRoot = value;
      else if (flag === "--output-root") args.outputRoot = value;
      else if (flag === "--production-root") args.productionRoot = value;
      else if (flag === "--persona-dir") args.personaDir = value;
      else args.pdftotext = value;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.extractionRoot) args.extractionRoot = defaultSemanticSourceExtractionRoot({ stagingRoot: args.root });
  if (!args.outputRoot) args.outputRoot = defaultSemanticSourceSkepticRoot({ stagingRoot: args.root });
  return Object.freeze(args);
}

export function usage() {
  return "Usage: node scripts/review-persona-source-semantics.mjs [--check|--write] [--json]\nRound-2 AI skeptic only; never human review, adjudication, attribution approval, or production promotion.\n";
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(usage()); return 0; }
  const options = Object.fromEntries(Object.entries(args).filter(([key, value]) => !["write", "json", "help"].includes(key) && value !== undefined));
  const report = args.write ? writeSemanticSourceSkepticReviews(options) : inspectSemanticSourceSkepticReviews(options);
  const result = { mode: args.write ? "write" : "check", ...report };
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`persona-semantic-source-skeptic: mode=${result.mode} valid=${result.valid} artifacts=${result.valid_artifact_count}/${result.candidate_count} propositions=${result.proposition_review_count} supported=${result.proposition_verdict_counts.supported} partial=${result.proposition_verdict_counts.partial} unsupported=${result.proposition_verdict_counts.unsupported} unverifiable=${result.proposition_verdict_counts.unverifiable} candidate_unverifiable=${result.candidate_verdict_counts.unverifiable} human_reviews=0 production_writes=0 errors=${result.errors.length} hash=${result.index_hash}\n`);
  return result.valid ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = main(); }
  catch (error) { process.stderr.write(`semantic source skeptic failed: ${error.message}\n`); process.exitCode = 1; }
}
