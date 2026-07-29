#!/usr/bin/env node
/** Create only missing PersonaPack v3 staging artifacts, then validate the full staging tree. */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  defaultStagingRoot,
  inspectPersonaV3Staging,
  scaffoldPersonaV3Staging,
} from "../mcp/lib/personas-v3/staging.mjs";

export function parseArgs(argv) {
  const args = {
    write: false,
    json: false,
    help: false,
    root: defaultStagingRoot(),
    productionRoot: undefined,
    personaDir: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--check") args.write = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (["--root", "--production-root", "--persona-dir"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
      if (arg === "--root") args.root = resolve(value);
      if (arg === "--production-root") args.productionRoot = resolve(value);
      if (arg === "--persona-dir") args.personaDir = resolve(value);
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return Object.freeze(args);
}
function options(args) {
  return Object.fromEntries(Object.entries({
    root: args.root,
    productionRoot: args.productionRoot,
    personaDir: args.personaDir,
  }).filter(([, value]) => value !== undefined));
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage: node scripts/scaffold-persona-v3-staging.mjs [--check|--write] [--json] [--root PATH]",
      "",
      "  --check            validate only (default; never writes)",
      "  --write            create missing scaffolds and empty queues; never overwrite existing work",
      "  --json             emit machine-readable result",
      "  --root PATH        override the staging root",
      "  --production-root  override the production knowledge root for isolation checks",
      "  --persona-dir      override the canonical persona registry root",
      "",
      "This command never creates manifest.json and never registers a production pack.",
      "",
    ].join("\n"));
    return 0;
  }
  const scaffold = args.write ? scaffoldPersonaV3Staging(options(args)) : null;
  const report = inspectPersonaV3Staging(options(args));
  const result = {
    mode: args.write ? "write_missing_then_check" : "check_only",
    scaffold,
    report,
  };
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const created = scaffold?.created.length || 0;
    const existing = scaffold?.existing.length || 0;
    process.stdout.write([
      `persona-v3 staging: mode=${result.mode}`,
      `seats=${report.canonical_master_count}`,
      `created=${created}`,
      `existing=${existing}`,
      `invalid=${report.invalid_count}`,
      `unsafe=${report.unsafe_artifact_count}`,
      `production_eligible=${report.production_eligible_count}`,
      `hash=${report.staging_inventory_hash}`,
      "",
    ].join(" "));
  }
  return report.invalid_count || report.unsafe_artifact_count || report.global_errors.length ? 1 : 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`persona-v3 staging scaffold failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
