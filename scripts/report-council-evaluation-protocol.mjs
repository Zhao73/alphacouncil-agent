#!/usr/bin/env node

import {
  CANONICAL_PROTOCOL_FILE,
  councilEvaluationProtocolReport,
  loadCouncilEvaluationProtocol,
} from "./lib/council-evaluation-protocol.mjs";

function parseArgs(argv) {
  const options = { check: false, json: false, markdown: false, file: CANONICAL_PROTOCOL_FILE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--markdown") options.markdown = true;
    else if (arg === "--file") {
      options.file = argv[index + 1];
      index += 1;
      if (!options.file) throw new Error("--file requires a path");
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.json && options.markdown) throw new Error("choose only one of --json or --markdown");
  return options;
}

export function evaluationProtocolMarkdown(report) {
  const lines = [
    "# AlphaCouncil canonical-arm evaluation protocol v1",
    "",
    "> **DRAFT / UNREGISTERED / NO RESULTS.** This document contains no frozen dataset, case ledger, signature, passed comparison or release claim.",
    "",
    `Validation: **${report.valid ? "passed" : "failed"}**`,
    "",
    `Draft hash: \`${report.draft_hash}\` (content identity only; not a preregistration signature)`,
    "",
    `Registration: ${report.registered ? "registered" : "not registered"}; dataset hash: ${report.dataset_hash || "null"}; case-ledger hash: ${report.case_ledger_hash || "null"}.`,
    "",
    `Results: ${report.result_count}; signatures: ${report.signature_count}; passed claims: ${report.passed_claim_count}.`,
    "",
    "## Canonical arms",
    "",
    "| Arm | Execution | Analysts | Masters | Verifiers | Inherits/variants | Result status |",
    "|---|---|---:|---:|---:|---|---|",
  ];
  for (const arm of report.arms) {
    lines.push(`| ${arm.arm_id} | ${arm.execution_mode} | ${arm.analysts} | ${arm.masters} | ${arm.verifiers} | ${arm.base_arm_ids.join(", ") || "none"} | ${arm.result_status} |`);
  }
  lines.push(
    "",
    "E is deliberately one canonical arm with paired D13 and D26 variants; it does not hide which v3 base configuration receives verification.",
    "",
    "H is a blinded human-quality reference with two or three independent analysts and one separate adjudicator. It is not an automated vote.",
    "",
    "## Metrics reserved for registration",
    "",
    ...report.metric_ids.map((id) => `- \`${id}\`: no result`),
    "",
    "Agreement and seat count are reported separately from independence. Error `N_eff` remains governed by its separate resolved-outcome protocol and is otherwise `null`.",
    "",
    "## Registration blockers",
    "",
    ...report.blockers.map((blocker) => `- ${blocker}`),
  );
  if (report.errors.length) lines.push("", "## Validation errors", "", ...report.errors.map((error) => `- ${error}`));
  return `${lines.join("\n")}\n`;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}

if (options) {
  let report;
  try {
    report = councilEvaluationProtocolReport(loadCouncilEvaluationProtocol(options.file));
  } catch (error) {
    report = {
      protocol_id: null,
      status: null,
      valid: false,
      draft_hash: null,
      registered: false,
      dataset_hash: null,
      case_ledger_hash: null,
      result_count: 0,
      signature_count: 0,
      passed_claim_count: 0,
      arm_count: 0,
      metric_ids: [],
      arms: [],
      blockers: ["protocol_unreadable"],
      errors: [error.message],
    };
  }
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (options.markdown) process.stdout.write(evaluationProtocolMarkdown(report));
  else {
    process.stdout.write(
      `council-evaluation-protocol: status=${report.status || "invalid"} arms=${report.arm_count} `
      + `results=${report.result_count} signatures=${report.signature_count} passed_claims=${report.passed_claim_count} `
      + `${report.valid ? "valid" : `${report.errors.length} errors`}\n`,
    );
    if (!report.valid) for (const error of report.errors) process.stderr.write(`- ${error}\n`);
  }
  if (options.check && !report.valid) process.exitCode = 1;
}
