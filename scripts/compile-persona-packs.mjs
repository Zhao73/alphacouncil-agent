#!/usr/bin/env node
/**
 * Compile the physical PersonaPack v3 directories into a stable, read-only index summary.
 *
 * This command deliberately writes no generated artifact. `--require-count` is the explicit
 * release gate; without it the command still fails when zero physical v3 packs exist so an
 * empty migration can never be reported as complete.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { canonicalValue, sha256 } from "../mcp/lib/personas-v3/canonical.mjs";
import { loadCompiledPersonaPacks } from "../mcp/lib/personas-v3/registry.mjs";

function stableExperimentStatus(value) {
  return value && typeof value === "object" ? value.status || "unknown" : "unknown";
}

export function summarizeCompiledPack(pack) {
  return canonicalValue({
    schema_version: 3,
    persona_id: pack.persona_id,
    pack_version: pack.pack_version,
    maturity: pack.maturity,
    admitted_label: pack.admitted_label,
    source_cutoff: pack.source_cutoff,
    pack_hash: pack.pack_hash,
    corpus_hash: pack.corpus_hash,
    tool_graph_hash: pack.tool_graph_hash,
    policy_hash: pack.policy_hash,
    component_hashes: pack.component_hashes,
    admission: {
      level: pack.admission.level,
      counts: pack.admission.counts,
      delta_to_operational: pack.admission.delta_to_operational,
      delta_to_candidate: pack.admission.delta_to_candidate,
      method_model_experiment_status: stableExperimentStatus(
        pack.admission.method_model_experiment_status,
      ),
    },
  });
}

export function createPackIndex(compiledRegistry) {
  const packs = [...compiledRegistry.packs]
    .map(summarizeCompiledPack)
    .sort((a, b) => a.persona_id.localeCompare(b.persona_id));
  const legacyIds = [...compiledRegistry.legacy_ids].sort((a, b) => a.localeCompare(b));
  const stablePayload = canonicalValue({
    schema_version: 1,
    physical_v3_count: packs.length,
    legacy_count: legacyIds.length,
    legacy_ids: legacyIds,
    packs,
  });
  return Object.freeze({
    ...stablePayload,
    pack_index_hash: sha256(stablePayload),
  });
}

export function compilePersonaPackIndex({ knowledgeDir, personaDir } = {}) {
  return createPackIndex(loadCompiledPersonaPacks({ knowledgeDir, personaDir }));
}

export function evaluateCountGate(actualCount, requiredCount = null) {
  if (actualCount === 0) {
    return Object.freeze({
      status: "failed",
      required_count: requiredCount,
      actual_count: actualCount,
      reason: "no_physical_v3_packs",
    });
  }
  if (requiredCount !== null && actualCount !== requiredCount) {
    return Object.freeze({
      status: "failed",
      required_count: requiredCount,
      actual_count: actualCount,
      reason: "required_count_mismatch",
    });
  }
  return Object.freeze({
    status: requiredCount === null ? "not_requested" : "passed",
    required_count: requiredCount,
    actual_count: actualCount,
    reason: null,
  });
}

function parsePositiveCount(raw) {
  if (!/^[1-9]\d*$/u.test(raw || "")) {
    throw new Error("--require-count must be a positive integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("--require-count exceeds the safe integer range");
  return value;
}

export function parseArgs(argv) {
  const parsed = { json: false, check: false, help: false, requiredCount: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") parsed.json = true;
    else if (arg === "--check") parsed.check = true;
    else if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--require-count") {
      if (parsed.requiredCount !== null) throw new Error("--require-count may be supplied only once");
      parsed.requiredCount = parsePositiveCount(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith("--require-count=")) {
      if (parsed.requiredCount !== null) throw new Error("--require-count may be supplied only once");
      parsed.requiredCount = parsePositiveCount(arg.slice("--require-count=".length));
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return Object.freeze(parsed);
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/gu, " ");
}

export function renderPackIndexMarkdown(report) {
  const gate = report.count_gate;
  const lines = [
    "# PersonaPack v3 compile index",
    "",
    `Physical v3 packs: ${report.physical_v3_count}`,
    `Legacy IDs: ${report.legacy_ids.length ? report.legacy_ids.map((id) => `\`${id}\``).join(", ") : "none"}`,
    `Pack index hash: \`${report.pack_index_hash}\``,
    `Count gate: ${gate.status}${gate.reason ? ` (${gate.reason})` : ""}`,
    "",
    "| Persona | Maturity | Pack version | Pack hash | Corpus hash |",
    "|---|---|---|---|---|",
  ];
  for (const pack of report.packs) {
    lines.push(`| \`${escapeCell(pack.persona_id)}\` | ${escapeCell(pack.maturity)} | ${escapeCell(pack.pack_version)} | \`${escapeCell(pack.pack_hash)}\` | \`${escapeCell(pack.corpus_hash)}\` |`);
  }
  if (!report.packs.length) lines.push("| _none_ | incomplete | - | - | - |");
  lines.push("");
  return lines.join("\n");
}

function renderCheck(report) {
  const gate = report.count_gate;
  return [
    "persona-v3 compile:",
    `physical_v3=${report.physical_v3_count}`,
    `legacy=${report.legacy_count}`,
    `count_gate=${gate.status}`,
    `reason=${gate.reason || "none"}`,
    `pack_index_hash=${report.pack_index_hash}`,
  ].join(" ");
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage: node scripts/compile-persona-packs.mjs [--json] [--check] [--require-count N]",
      "",
      "  --json             emit the stable machine-readable index and count gate",
      "  --check            emit one terse validation line",
      "  --require-count N  require exactly N physical v3 packs (use 26 for the GA gate)",
      "",
    ].join("\n"));
    return 0;
  }

  const index = compilePersonaPackIndex();
  const report = {
    ...index,
    count_gate: evaluateCountGate(index.physical_v3_count, args.requiredCount),
  };
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (args.check) process.stdout.write(`${renderCheck(report)}\n`);
  else process.stdout.write(renderPackIndexMarkdown(report));
  return report.count_gate.status === "failed" ? 1 : 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`persona-v3 compile failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
