#!/usr/bin/env node
/** Build or verify the packaged 26-seat provisional solo-test PersonaPack v3 tree. */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  DEFAULT_SOLO_TEST_FORMULA_ROOT,
  DEFAULT_SOLO_TEST_PACK_ROOT,
  inspectPersonaV3SoloTestPacks,
  renderPersonaV3SoloTestPackReport,
  writePersonaV3SoloTestPacks,
} from "./lib/persona-v3-solo-test-packs.mjs";
import { resolvePersonaPackVersion } from "./lib/build-profile.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function parseArgs(argv) {
  const args = {
    write: false,
    json: false,
    help: false,
    root: DEFAULT_SOLO_TEST_PACK_ROOT,
    formulaRoot: DEFAULT_SOLO_TEST_FORMULA_ROOT,
    personaDir: undefined,
    packVersion: resolvePersonaPackVersion(REPO_ROOT),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--check") args.write = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (["--root", "--formula-root", "--persona-dir", "--pack-version"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--root") args.root = resolve(value);
      else if (arg === "--formula-root") args.formulaRoot = resolve(value);
      else if (arg === "--persona-dir") args.personaDir = resolve(value);
      else args.packVersion = value;
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return Object.freeze(args);
}

function options(args) {
  return Object.fromEntries(Object.entries({
    root: args.root,
    formulaRoot: args.formulaRoot,
    personaDir: args.personaDir,
    packVersion: args.packVersion,
  }).filter(([, value]) => value !== undefined));
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage: node scripts/build-persona-v3-solo-test-packs.mjs [--check|--write] [--json]",
      "",
      "  --write              materialize all 26 packaged provisional packs, then verify",
      "  --check              read-only verification (default)",
      "  --root PATH          override the isolated solo-test/masters output root",
      "  --formula-root PATH  override the 52-tool provisional formula staging tree",
      "  --persona-dir PATH   override the canonical persona registry",
      "  --pack-version X.Y.Z[-PRERELEASE] override package-derived pack version",
      "  --json               emit a machine-readable report",
      "",
      "This command never creates source approvals, human signatures, experiment passes,",
      "production admission, a release, or a method_model.",
      "",
    ].join("\n"));
    return 0;
  }
  const write = args.write ? writePersonaV3SoloTestPacks(options(args)) : null;
  const report = inspectPersonaV3SoloTestPacks(options(args));
  process.stdout.write(args.json
    ? `${JSON.stringify({ mode: args.write ? "write_then_check" : "check_only", write, report }, null, 2)}\n`
    : `${renderPersonaV3SoloTestPackReport(report)}\n`);
  return report.summary.ready_for_solo_testing ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`persona-v3 solo-test pack build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
