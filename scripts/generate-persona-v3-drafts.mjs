#!/usr/bin/env node
/** Generate or verify all 26 non-production PersonaPack v3 editorial draft slices. */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { defaultStagingRoot } from "../mcp/lib/personas-v3/staging.mjs";
import {
  inspectPersonaV3DraftPacks,
  renderPersonaV3DraftReport,
  writePersonaV3DraftPacks,
} from "./lib/persona-v3-draft-packs.mjs";

export function parseArgs(argv) {
  const args = {
    write: false,
    json: false,
    markdown: false,
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
    else if (arg === "--markdown") args.markdown = true;
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
  if (args.json && args.markdown) throw new Error("--json and --markdown are mutually exclusive");
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
      "Usage: node scripts/generate-persona-v3-drafts.mjs [--check|--write] [--json|--markdown]",
      "",
      "  --check            verify only (default; never writes)",
      "  --write            deterministically write all 26 editorial draft slices, then verify",
      "  --json             emit the machine-readable inventory",
      "  --markdown         emit the full Markdown inventory report",
      "  --root PATH        override the staging root",
      "  --production-root  override the production knowledge root",
      "  --persona-dir      override the canonical persona registry root",
      "",
      "This command never writes manifest.json or production knowledge/masters artifacts.",
      "",
    ].join("\n"));
    return 0;
  }
  const write = args.write ? writePersonaV3DraftPacks(options(args)) : null;
  const report = inspectPersonaV3DraftPacks(options(args));
  if (args.json) process.stdout.write(`${JSON.stringify({ mode: args.write ? "write_then_check" : "check_only", write, report }, null, 2)}\n`);
  else if (args.markdown) process.stdout.write(renderPersonaV3DraftReport(report));
  else {
    process.stdout.write([
      "persona-v3-drafts:",
      `mode=${args.write ? "write_then_check" : "check_only"}`,
      `seats=${report.draft_pack_count}/${report.canonical_master_count}`,
      `artifacts=${report.present_artifact_count}/${report.expected_artifact_count}`,
      `computations=${report.totals.computation_prototypes}`,
      `vetoes=${report.totals.veto_hypotheses}`,
      `facts=${report.totals.fact_contracts}`,
      `states=${report.totals.native_states}`,
      `invalid=${report.invalid_count}`,
      `loader_visible=${report.production_loader_visible_count}`,
      `production_eligible=${report.production_eligible_count}`,
      `hash=${report.draft_inventory_hash}`,
      "",
    ].join(" "));
  }
  return report.invalid_count
    || report.draft_pack_count !== report.canonical_master_count
    || report.present_artifact_count !== report.expected_artifact_count
    || report.production_loader_visible_count
    || report.production_eligible_count
    || report.staging_physical_v3_count
    || report.staging_unsafe_artifact_count ? 1 : 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`persona-v3 draft generation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
