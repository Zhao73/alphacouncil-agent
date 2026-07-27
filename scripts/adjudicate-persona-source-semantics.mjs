#!/usr/bin/env node
/** Write/check round-3 AI semantic adjudications; never human approval or production promotion. */

import { pathToFileURL } from "node:url";

import {
  inspectSemanticSourceAdjudications, writeSemanticSourceAdjudications,
} from "../mcp/lib/personas-v3/semantic-source-adjudication.mjs";

export function parseArgs(argv) {
  const options = { write: false, json: false };
  for (const arg of argv) {
    if (arg === "--write") options.write = true;
    else if (arg === "--check") options.write = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

export function usage() {
  return "Usage: node scripts/adjudicate-persona-source-semantics.mjs [--check|--write] [--json]\nRound-3 AI adjudicator only; never human review, method-attribution approval, signature creation, GA-gate mutation, or production promotion.\n";
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(usage()); return 0; }
  const result = options.write ? writeSemanticSourceAdjudications() : inspectSemanticSourceAdjudications();
  const output = { mode: options.write ? "write" : "check", ...result };
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else process.stdout.write(`persona-semantic-source-adjudicator: mode=${output.mode} valid=${output.valid} artifacts=${output.valid_artifact_count}/${output.candidate_count} propositions=${output.proposition_adjudication_count} supported=${output.proposition_verdict_counts.supported} partial=${output.proposition_verdict_counts.partial} unsupported=${output.proposition_verdict_counts.unsupported} unverifiable=${output.proposition_verdict_counts.unverifiable} candidate_unverifiable=${output.candidate_verdict_counts.unverifiable} skeptic_agree=${output.skeptic_agreement_count} skeptic_disagree=${output.skeptic_disagreement_count} human_reviews=0 production_writes=0 errors=${output.errors.length} hash=${output.index_hash}\n`);
  return output.valid ? 0 : 1;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`semantic source adjudication failed: ${error.message}\n`); process.exitCode = 1; });
