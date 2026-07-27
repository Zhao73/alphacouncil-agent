#!/usr/bin/env node
/** Write/check round-1 AI semantic extractor artifacts; no adjudication. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSemanticSourceExtractionRoot, inspectSemanticSourceExtractions,
  writeSemanticSourceExtractions,
} from "../mcp/lib/personas-v3/semantic-source-extraction.mjs";
import { defaultKnowledgeDir } from "../mcp/lib/personas-v3/admission.mjs";
import { defaultStagingRoot } from "../mcp/lib/personas-v3/staging.mjs";

export function parseArgs(argv) {
  const args = { write: false, json: false, help: false, root: defaultStagingRoot(), outputRoot: null, productionRoot: defaultKnowledgeDir(), personaDir: undefined, pdftotext: undefined };
  const once = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--write") args.write = true;
    else if (flag === "--check") args.write = false;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (["--root", "--output-root", "--production-root", "--persona-dir", "--pdftotext"].includes(flag)) {
      if (once.has(flag) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${flag} requires one value`);
      once.add(flag); const value = resolve(argv[++i]);
      if (flag === "--root") args.root = value;
      if (flag === "--output-root") args.outputRoot = value;
      if (flag === "--production-root") args.productionRoot = value;
      if (flag === "--persona-dir") args.personaDir = value;
      if (flag === "--pdftotext") args.pdftotext = value;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (!args.outputRoot) args.outputRoot = defaultSemanticSourceExtractionRoot({ stagingRoot: args.root });
  return Object.freeze(args);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write("Usage: node scripts/extract-persona-source-semantics.mjs [--check|--write] [--json]\nRound-1 AI extractor only; never human review, attribution approval, or production promotion.\n");
    return 0;
  }
  const options = Object.fromEntries(Object.entries(args).filter(([key, value]) => !["write", "json", "help"].includes(key) && value !== undefined));
  const report = args.write ? writeSemanticSourceExtractions(options) : inspectSemanticSourceExtractions(options);
  const result = { mode: args.write ? "write" : "check", ...report };
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`persona-semantic-source-extractor: mode=${result.mode} valid=${result.valid} artifacts=${result.valid_artifact_count}/${result.candidate_count} readable=${result.readability_counts.readable} partial=${result.readability_counts.partial} unreadable=${result.readability_counts.unreadable} propositions=${result.proposition_count} human_reviews=0 production_writes=0 errors=${result.errors.length} hash=${result.index_hash}\n`);
  return result.valid ? 0 : 1;
}
const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().then((code) => { process.exitCode = code; }).catch((error) => { process.stderr.write(`semantic source extraction failed: ${error.message}\n`); process.exitCode = 1; });
