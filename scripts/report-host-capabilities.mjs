#!/usr/bin/env node

import { hostCapabilityReport } from "./lib/host-capabilities.mjs";

function markdown(report) {
  const lines = [
    "# AlphaCouncil host capability and parity contract",
    "",
    "> Evidence scope: repository static contract only. This report is not proof of a live host execution.",
    "",
    `Validation: **${report.valid ? "passed" : "failed"}**`,
    "",
    `Canonical selector: ${report.selector_count} IDs; catalog hash \`${report.catalog_hash}\`.`,
    "",
    `Canonical command hash: \`${report.command_hash}\`.`,
    "",
    "| Host | Chooser | Numbered fallback | Visible subagents | Parallelism | Model mapping | Permissions | Resume | Live E2E |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const host of report.hosts) {
    lines.push(`| ${host.display_name} | optional, unverified | required | ${host.visible_subagents} | ${host.parallelism} | ${host.model_mapping} | ${host.permissions} | ${host.resume} | **${host.live_e2e}** |`);
  }
  lines.push("", "Repository command adapters:", "");
  for (const adapter of report.repository_adapters) lines.push(`- ${adapter.host_id}: \`${adapter.path}\` — ${adapter.status}`);
  lines.push(`- codex: \`${report.codex_user_prompt.path}\` — ${report.codex_user_prompt.status}`);
  if (report.errors.length) lines.push("", "## Errors", "", ...report.errors.map((error) => `- ${error}`));
  return `${lines.join("\n")}\n`;
}

const args = new Set(process.argv.slice(2));
const report = hostCapabilityReport();
if (args.has("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else if (args.has("--markdown")) process.stdout.write(markdown(report));
else {
  process.stdout.write(`host-capabilities: ${report.hosts.length} hosts, ${report.selector_count} selector IDs, live_e2e=not_run, ${report.valid ? "valid" : `${report.errors.length} errors`}\n`);
  if (!report.valid) for (const error of report.errors) process.stderr.write(`- ${error}\n`);
}
if (args.has("--check") && !report.valid) process.exitCode = 1;
