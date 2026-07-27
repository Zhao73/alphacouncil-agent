#!/usr/bin/env node
/** Retrieve one explicit source URL into non-production PersonaPack v3 staging. */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  SOURCE_ACQUISITION_DEFAULTS,
  inspectSourceAcquisitions,
  runSourceAcquisition,
} from "../mcp/lib/personas-v3/source-acquisition.mjs";
import { defaultStagingRoot } from "../mcp/lib/personas-v3/staging.mjs";

function positiveInteger(raw, flag, { zero = false } = {}) {
  const pattern = zero ? /^\d+$/u : /^[1-9]\d*$/u;
  if (!pattern.test(raw || "")) throw new Error(`${flag} must be ${zero ? "a non-negative" : "a positive"} integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} exceeds the safe integer range`);
  return value;
}
export function parseArgs(argv) {
  const args = {
    write: false,
    check: false,
    json: false,
    help: false,
    personaId: null,
    candidateId: null,
    url: null,
    root: defaultStagingRoot(),
    productionRoot: undefined,
    personaDir: undefined,
    limits: { ...SOURCE_ACQUISITION_DEFAULTS },
  };
  const seen = new Set();
  const single = (flag, value) => {
    if (seen.has(flag)) throw new Error(`${flag} may be supplied only once`);
    seen.add(flag);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") args.write = true;
    else if (arg === "--check") args.check = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (["--persona", "--candidate-id", "--url", "--root", "--production-root", "--persona-dir", "--timeout-ms", "--max-bytes", "--max-redirects"].includes(arg)) {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--persona") args.personaId = single(arg, raw);
      if (arg === "--candidate-id") args.candidateId = single(arg, raw);
      if (arg === "--url") args.url = single(arg, raw);
      if (arg === "--root") args.root = resolve(single(arg, raw));
      if (arg === "--production-root") args.productionRoot = resolve(single(arg, raw));
      if (arg === "--persona-dir") args.personaDir = resolve(single(arg, raw));
      if (arg === "--timeout-ms") args.limits.timeout_ms = positiveInteger(single(arg, raw), arg);
      if (arg === "--max-bytes") args.limits.max_bytes = positiveInteger(single(arg, raw), arg);
      if (arg === "--max-redirects") args.limits.max_redirects = positiveInteger(single(arg, raw), arg, { zero: true });
      index += 1;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.check && args.write) throw new Error("--check and --write cannot be combined");
  const requestFields = [args.personaId, args.candidateId, args.url].filter((value) => value !== null).length;
  if (args.check && requestFields) throw new Error("--check cannot be combined with --persona, --candidate-id or --url");
  if (!args.check && !args.help && requestFields !== 3) {
    throw new Error("plan/write mode requires --persona, --candidate-id and --url together");
  }
  return Object.freeze({ ...args, limits: Object.freeze(args.limits) });
}

function paths(args) {
  return Object.fromEntries(Object.entries({
    root: args.root,
    productionRoot: args.productionRoot,
    personaDir: args.personaDir,
  }).filter(([, value]) => value !== undefined));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage:",
      "  node scripts/acquire-persona-source.mjs --check [--json]",
      "  node scripts/acquire-persona-source.mjs --persona ID --candidate-id ID --url URL [--write] [limits]",
      "",
      "Without --write, the command validates and prints a plan without network access.",
      "--write performs one explicit HTTP(S) retrieval and archives exact response bytes.",
      "It never grades/approves a source, creates a production manifest, or edits an adjudication queue.",
      "",
      "Limits:",
      `  --timeout-ms N     default ${SOURCE_ACQUISITION_DEFAULTS.timeout_ms}`,
      `  --max-bytes N      default ${SOURCE_ACQUISITION_DEFAULTS.max_bytes}`,
      `  --max-redirects N  default ${SOURCE_ACQUISITION_DEFAULTS.max_redirects}`,
      "",
    ].join("\n"));
    return 0;
  }
  if (args.check) {
    const report = inspectSourceAcquisitions(paths(args));
    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write([
      "persona-source-acquisitions:",
      `seats=${report.canonical_master_count}`,
      `retrieved_unadjudicated=${report.retrieved_unadjudicated_count}`,
      `approved=${report.approved_count}`,
      `graded=${report.graded_count}`,
      `invalid=${report.invalid_count}`,
      `production_eligible=${report.production_eligible_count}`,
      `hash=${report.acquisition_inventory_hash}`,
      "",
    ].join(" "));
    return report.invalid_count ? 1 : 0;
  }
  const result = await runSourceAcquisition({
    ...paths(args),
    write: args.write,
    personaId: args.personaId,
    candidateId: args.candidateId,
    url: args.url,
    limits: args.limits,
  });
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write([
    "persona-source-acquisition:",
    `mode=${result.mode}`,
    `status=${result.status}`,
    `network_called=${result.network_called}`,
    result.record?.content_hash ? `content_hash=${result.record.content_hash}` : "content_hash=not_retrieved",
    "",
  ].join(" "));
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`persona source acquisition failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
