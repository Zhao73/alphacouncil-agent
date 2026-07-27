#!/usr/bin/env node

import { personaV3BuildSpecReport } from "./lib/persona-v3-build-specs.mjs";

function markdown(report) {
  const lines = [
    "# PersonaPack v3 build-spec inventory",
    "",
    "> Planning-only inventory. It contains no production packs, source admissions, reviewer approvals or experiment passes.",
    "",
    `Validation: **${report.valid ? "passed" : "failed"}**`,
    "",
    `Current material: ${report.current_material.v1_prompt} v1 prompt lenses, ${report.current_material.v2_operator} v2 operator lenses, ${report.current_material.physical_v3} physical v3 packs and ${report.current_material.method_model} method models.`,
    "",
    `Planned inventory: ${report.totals.required_fact_types} required fact types, ${report.totals.planned_tools} dedicated tools, ${report.totals.veto_families} veto families and ${report.totals.source_targets} source-acquisition targets.`,
    "",
    `Case-acquisition floors: ${report.totals.case_targets.decision} decisions, ${report.totals.case_targets.failure} failures, ${report.totals.case_targets.counterfactual} counterfactuals and ${report.totals.case_targets.golden} golden cases. All remain unacquired and pending human adjudication.`,
    "",
    "| # | Seat | Current material | Fact types | Planned tools | Veto families | Source targets | Case floor (D/F/C/G) | Human adjudication |",
    "|---:|---|---|---:|---:|---:|---:|---|---|",
  ];
  for (const [index, seat] of report.seats.entries()) {
    const cases = seat.planned_cases;
    lines.push(`| ${index + 1} | \`${seat.persona_id}\` | ${seat.material_level} | ${seat.required_fact_types} | ${seat.planned_tools} | ${seat.veto_families} | ${seat.source_targets} | ${cases.decision}/${cases.failure}/${cases.counterfactual}/${cases.golden} | pending |`);
  }
  if (report.errors.length) {
    lines.push("", "## Validation errors", "", ...report.errors.map((error) => `- ${error}`));
  }
  return `${lines.join("\n")}\n`;
}

const args = new Set(process.argv.slice(2));
const report = personaV3BuildSpecReport();

if (args.has("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else if (args.has("--markdown")) process.stdout.write(markdown(report));
else {
  process.stdout.write(
    `persona-v3-build-specs: ${report.build_specs}/${report.canonical_seats} specs, `
    + `${report.adjudication.pending_seats} pending human review, `
    + `${report.adjudication.production_promotions} production promotions, `
    + `${report.valid ? "valid" : `${report.errors.length} errors`}\n`,
  );
  if (!report.valid) for (const error of report.errors) process.stderr.write(`- ${error}\n`);
}

if (args.has("--check") && !report.valid) process.exitCode = 1;
