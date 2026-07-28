#!/usr/bin/env node
/**
 * Report physical PersonaPack corpus/admission gaps for the canonical master roster.
 *
 * Default output is Markdown for maintainers. `--json` emits only machine-readable JSON.
 * Gaps are expected and do not make the command fail; malformed physical artifacts do.
 */

import { CANONICAL_MASTER_COUNT } from "../mcp/lib/personas-v3/staging.mjs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { loadPersonas, defaultPersonaDir } from "../mcp/lib/personas/registry.mjs";
import {
  CANDIDATE_BAR,
  EXPERIMENT_RESULTS_PATH,
  METHOD_MODEL_EXPERIMENTS,
  METHOD_MODEL_RULE_BAR,
  OPERATIONAL_BAR,
  defaultKnowledgeDir,
  deltaToBar,
  evaluateMethodModelExperiments,
  gapDetails,
  inspectPersonaAdmission,
} from "../mcp/lib/personas-v3/admission.mjs";

// Re-exported rather than redeclared: two independent copies of the seat count is how a
// roster change passes one gate and fails another.
export { CANONICAL_MASTER_COUNT } from "../mcp/lib/personas-v3/staging.mjs";

function invalidResult(personaId, promptPresent, error) {
  const counts = {};
  const experiments = evaluateMethodModelExperiments(null, { file: EXPERIMENT_RESULTS_PATH });
  return {
    persona_id: personaId,
    admission_level: "invalid",
    pack_format: "invalid",
    prompt_present: promptPresent,
    manifest_present: false,
    schema_version: null,
    declared_maturity: null,
    declared_admission_ignored: false,
    manifest_self_claim_effective: false,
    manifest_self_claim_present: false,
    physical_corpus_counts: counts,
    raw_physical_counts: {},
    excluded_physical_counts: {},
    source_contract: "invalid",
    source_anchor_errors: [],
    failure_case_source: "none",
    missing_artifacts: [],
    component_files: {},
    delta_to_operational: deltaToBar(counts, OPERATIONAL_BAR),
    delta_to_candidate: deltaToBar(counts, CANDIDATE_BAR),
    gaps_to_operational: gapDetails(counts, OPERATIONAL_BAR),
    gaps_to_candidate: gapDetails(counts, CANDIDATE_BAR),
    operational_clear: false,
    candidate_clear: false,
    method_model_rule_review_status: {
      status: "incomplete",
      required: { ...METHOD_MODEL_RULE_BAR },
      counted: Object.fromEntries(Object.keys(METHOD_MODEL_RULE_BAR).map((key) => [key, 0])),
      gaps: { ...METHOD_MODEL_RULE_BAR },
    },
    method_model_experiment_status: experiments,
    errors: [error?.message || String(error)],
  };
}

export function scanPersonaCorpusGaps({
  personaDir = defaultPersonaDir(),
  knowledgeDir = defaultKnowledgeDir(),
  expectedCount = CANONICAL_MASTER_COUNT,
  now = new Date(),
} = {}) {
  const reg = loadPersonas({ dir: personaDir });
  const ids = reg.ids("master");
  if (ids.length !== expectedCount) {
    throw new Error(`canonical master roster has ${ids.length} seats; expected ${expectedCount}`);
  }

  const personas = ids.map((personaId) => {
    const persona = reg.get(personaId);
    const promptFile = join(reg.dir, persona.file);
    const packDir = join(knowledgeDir, personaId);
    try {
      return inspectPersonaAdmission({ persona_id: personaId, prompt_file: promptFile, pack_dir: packDir });
    } catch (error) {
      return invalidResult(personaId, true, error);
    }
  });
  const levels = {};
  for (const persona of personas) levels[persona.admission_level] = (levels[persona.admission_level] || 0) + 1;
  const invalid = personas.filter((persona) => persona.admission_level === "invalid");
  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    canonical_master_count: ids.length,
    expected_master_count: expectedCount,
    invalid_count: invalid.length,
    summary: {
      levels,
      operational_or_higher: personas.filter((persona) => ["operational", "candidate", "method_model"].includes(persona.admission_level)).length,
      candidates_or_higher: personas.filter((persona) => ["candidate", "method_model"].includes(persona.admission_level)).length,
      method_models: personas.filter((persona) => persona.admission_level === "method_model").length,
      experiment_requirements: METHOD_MODEL_EXPERIMENTS.length,
    },
    personas,
  };
}

function escapeCell(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/gu, " ");
}

function compactCounts(counts) {
  const c = counts || {};
  return [
    `P${c.propositions || 0}`,
    `S${c.method_sources || 0}`,
    `AB${c.ab_sources || 0}`,
    `D${c.decision_cases || 0}`,
    `F${c.failure_cases || 0}`,
    `V${c.vetoes || 0}`,
    `C${c.counterfactuals || 0}`,
    `G${c.golden_cases || 0}`,
    `T${c.dedicated_tools || 0}/${c.recomputation_tools || 0}`,
    `PW${c.pairwise_groups || 0}`,
    `DR${c.dual_reviewed_propositions || 0}/${c.dual_reviewed_vetoes || 0}`,
  ].join(" ");
}

function compactDelta(delta) {
  const missing = Object.entries(delta || {}).filter(([, value]) => value > 0);
  return missing.length ? missing.map(([key, value]) => `${key}+${value}`).join(", ") : "clear";
}

export function renderPersonaCorpusGapMarkdown(report) {
  const lines = [
    "# Persona corpus and admission gap report",
    "",
    `Generated: ${report.generated_at}`,
    `Canonical seats: ${report.canonical_master_count}`,
    `Levels: ${Object.entries(report.summary.levels).map(([level, count]) => `${level}=${count}`).join(", ") || "none"}`,
    "",
    "> Maturity is computed from physical artifacts. Manifest `admission`, `kind`, and identity maturity are advisory and never promote a pack.",
    "",
    "| # | Persona | Computed maturity | Format | Physical counts | Method rule review | Method experiments | Δ operational | Δ candidate |",
    "|---:|---|---|---|---|---|---|---|---|",
  ];
  report.personas.forEach((persona, index) => {
    lines.push(`| ${index + 1} | \`${escapeCell(persona.persona_id)}\` | ${escapeCell(persona.admission_level)} | ${escapeCell(persona.pack_format)} | ${escapeCell(compactCounts(persona.physical_corpus_counts))} | ${escapeCell(persona.method_model_rule_review_status?.status || "unknown")} | ${escapeCell(persona.method_model_experiment_status?.status || "unknown")} | ${escapeCell(compactDelta(persona.delta_to_operational))} | ${escapeCell(compactDelta(persona.delta_to_candidate))} |`);
  });
  const noteworthy = report.personas.filter((persona) => (
    persona.missing_artifacts?.length || persona.errors?.length
      || persona.source_anchor_errors?.length || persona.declared_admission_ignored
  ));
  if (noteworthy.length) {
    lines.push("", "## Artifact and integrity notes", "");
    for (const persona of noteworthy) {
      const notes = [];
      if (persona.declared_admission_ignored) notes.push("manifest admission claim ignored");
      if (persona.missing_artifacts?.length) notes.push(`missing: ${persona.missing_artifacts.join(", ")}`);
      if (persona.source_anchor_errors?.length) notes.push(`excluded source anchors: ${persona.source_anchor_errors.length}`);
      if (persona.errors?.length) notes.push(`invalid: ${persona.errors.join("; ")}`);
      lines.push(`- \`${persona.persona_id}\`: ${notes.join("; ")}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const flags = new Set(argv);
  const known = new Set(["--json", "--check", "--help", "-h"]);
  const unknown = [...flags].filter((flag) => !known.has(flag));
  if (unknown.length) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  return { json: flags.has("--json"), check: flags.has("--check"), help: flags.has("--help") || flags.has("-h") };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write("Usage: node scripts/report-persona-corpus-gaps.mjs [--json|--check]\n");
    return 0;
  }
  const report = scanPersonaCorpusGaps();
  if (args.check) {
    process.stdout.write(`persona-corpus: ${report.canonical_master_count} seats, ${report.invalid_count} invalid, ${report.summary.method_models} method models\n`);
  } else {
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderPersonaCorpusGapMarkdown(report));
  }
  return report.invalid_count ? 1 : 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`persona corpus report failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
