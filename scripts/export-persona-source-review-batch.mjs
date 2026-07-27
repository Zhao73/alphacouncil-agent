#!/usr/bin/env node
/** Export an auditable, non-production human source-review batch. */

import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync,
  statSync, writeFileSync, constants as fsConstants,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultKnowledgeDir } from "../mcp/lib/personas-v3/admission.mjs";
import { buildSourceReviewBatch } from "../mcp/lib/personas-v3/source-review-operations.mjs";
import { readHumanJsonFile } from "../mcp/lib/personas-v3/source-adjudication.mjs";
import { defaultStagingRoot } from "../mcp/lib/personas-v3/staging.mjs";

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function take(seen, flag, value) {
  if (seen.has(flag)) throw new Error(`${flag} may be supplied only once`);
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  seen.add(flag);
  return resolve(value);
}

export function parseArgs(argv) {
  const args = {
    write: false, json: false, help: false, output: null,
    root: defaultStagingRoot(), productionRoot: defaultKnowledgeDir(), personaDir: undefined,
    trustedReviewerKeysFile: null,
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--write") args.write = true;
    else if (flag === "--check") args.write = false;
    else if (flag === "--json") args.json = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (["--output", "--root", "--production-root", "--persona-dir", "--trusted-reviewer-keys"].includes(flag)) {
      const value = take(seen, flag, argv[index + 1]);
      if (flag === "--output") args.output = value;
      if (flag === "--root") args.root = value;
      if (flag === "--production-root") args.productionRoot = value;
      if (flag === "--persona-dir") args.personaDir = value;
      if (flag === "--trusted-reviewer-keys") args.trustedReviewerKeysFile = value;
      index += 1;
    } else throw new Error(`unknown argument: ${flag}`);
  }
  if (args.write && !args.output) throw new Error("--write requires an explicit --output file");
  return Object.freeze(args);
}

function writeExclusiveJson(file, value, { root, productionRoot }) {
  if (existsSync(file)) throw new Error(`output already exists; refusing overwrite: ${file}`);
  const parent = dirname(file);
  if (!existsSync(parent) || lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory()) {
    throw new Error(`output parent must be an existing physical directory: ${parent}`);
  }
  const physicalParent = realpathSync(parent);
  const physicalProduction = realpathSync(productionRoot);
  const physicalStaging = realpathSync(root);
  if (inside(physicalProduction, physicalParent)) throw new Error("review batch output must not be written inside production knowledge");
  if (inside(physicalStaging, physicalParent)) throw new Error("review batch output must not be written inside the staging tree");
  const target = resolve(physicalParent, basename(file));
  const descriptor = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(descriptor).isFile()) throw new Error("review batch output must be a regular file");
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return target;
}

function helpText() {
  return [
    "Usage:",
    "  node scripts/export-persona-source-review-batch.mjs [--check] [--trusted-reviewer-keys FILE] [--json]",
    "  node scripts/export-persona-source-review-batch.mjs --output FILE --write [--trusted-reviewer-keys FILE] [--json]",
    "",
    "Default/check mode is read-only. --write creates one new audit batch and never overwrites it.",
    "The batch includes all 26 seats, raw acquisition bindings, human-only proposal templates, hashes, locator gaps, and strict trusted-principal quorum progress.",
    "It never prepares, reviews, approves, promotes, or writes production knowledge.",
    "",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(helpText()); return 0; }
  const options = Object.fromEntries(Object.entries({
    root: args.root,
    productionRoot: args.productionRoot,
    personaDir: args.personaDir,
    trustedReviewerKeys: args.trustedReviewerKeysFile
      ? readHumanJsonFile(args.trustedReviewerKeysFile) : undefined,
  }).filter(([, value]) => value !== undefined));
  const batch = buildSourceReviewBatch(options);
  const output = args.write ? writeExclusiveJson(args.output, batch, {
    root: args.root,
    productionRoot: args.productionRoot,
  }) : null;
  const result = {
    mode: args.write ? "write" : "check",
    wrote: Boolean(output),
    output,
    batch_hash: batch.batch_hash,
    progress: batch.progress,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write([
    "persona-source-review-batch:",
    `mode=${result.mode}`,
    `seats=${batch.progress.seats_with_raw_acquisition}/${batch.progress.seat_count}`,
    `raw=${batch.progress.raw_acquisition_count}`,
    `proposal_pending=${batch.progress.proposal_pending_count}`,
    `prepared=${batch.progress.prepared_source_count}`,
    `quorum=${batch.progress.trusted_quorum_source_count}`,
    `invalid_seats=${batch.progress.invalid_seat_count}`,
    `wrote=${result.wrote}`,
    "production_writes=0",
    `hash=${batch.batch_hash}`,
    "",
  ].join(" "));
  return batch.progress.invalid_seat_count ? 1 : 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = await main(); }
  catch (error) { process.stderr.write(`source review batch export failed: ${error.message}\n`); process.exitCode = 1; }
}
