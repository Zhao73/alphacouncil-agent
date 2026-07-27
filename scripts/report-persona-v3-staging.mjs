#!/usr/bin/env node
/** Report source-adjudication and component-review progress without implying production maturity. */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { defaultStagingRoot, inspectPersonaV3Staging } from "../mcp/lib/personas-v3/staging.mjs";

export function parseArgs(argv) {
  const args = {
    json: false,
    check: false,
    help: false,
    root: defaultStagingRoot(),
    productionRoot: undefined,
    personaDir: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") args.json = true;
    else if (arg === "--check") args.check = true;
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

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/gu, " ");
}

export function renderStagingMarkdown(report) {
  const lines = [
    "# PersonaPack v3 staging progress",
    "",
    `Generated: ${report.generated_at}`,
    `Canonical staging seats: ${report.canonical_master_count}`,
    `Phases: ${Object.entries(report.phases).map(([phase, count]) => `${phase}=${count}`).join(", ") || "none"}`,
    `Physical production v3 packs represented here: ${report.physical_v3_pack_count}`,
    `Production-eligible staging seats: ${report.production_eligible_count}`,
    `Inventory hash: \`${report.staging_inventory_hash}\``,
    "",
    "> Staging progress is not production admission. This tree is not registered with the production loader and cannot self-promote.",
    "",
    "| # | Persona | Staging phase | Sources P/A/R | Method-defining sources | Components started/reviewed/blocked | Errors |",
    "|---:|---|---|---|---:|---|---|",
  ];
  report.personas.forEach((persona, index) => {
    const sources = persona.source_counts;
    const components = persona.component_progress;
    lines.push(`| ${index + 1} | \`${escapeCell(persona.persona_id)}\` | ${escapeCell(persona.phase)} | ${sources.pending}/${sources.approved}/${sources.rejected} | ${sources.method_defining} | ${components.started}/${components.reviewed}/${components.blocked} of ${components.total} | ${escapeCell(persona.errors.join("; ") || "none")} |`);
  });
  if (report.global_errors.length) {
    lines.push("", "## Global integrity errors", "");
    for (const error of report.global_errors) lines.push(`- ${error}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage: node scripts/report-persona-v3-staging.mjs [--json|--check] [--root PATH]",
      "",
      "  --json             emit the complete machine-readable inventory",
      "  --check            emit one terse integrity line",
      "  --root PATH        override the staging root",
      "  --production-root  override the production knowledge root for isolation checks",
      "  --persona-dir      override the canonical persona registry root",
      "",
    ].join("\n"));
    return 0;
  }
  const report = inspectPersonaV3Staging(options(args));
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (args.check) {
    process.stdout.write([
      "persona-v3-staging:",
      `seats=${report.canonical_master_count}`,
      `invalid=${report.invalid_count}`,
      `unsafe=${report.unsafe_artifact_count}`,
      `production_eligible=${report.production_eligible_count}`,
      `physical_v3=${report.physical_v3_pack_count}`,
      `hash=${report.staging_inventory_hash}`,
      "",
    ].join(" "));
  } else process.stdout.write(renderStagingMarkdown(report));
  return report.invalid_count || report.unsafe_artifact_count || report.global_errors.length ? 1 : 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`persona-v3 staging report failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
