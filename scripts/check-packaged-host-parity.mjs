#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  renderPackagedHostParityMarkdown,
  runPackagedHostParity,
} from "./lib/packaged-host-parity.mjs";

export function parseArgs(argv) {
  const args = { json: false, markdown: false, help: false, checkOnly: true };
  for (const arg of argv) {
    if (arg === "--check") args.checkOnly = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--markdown") args.markdown = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.json && args.markdown) throw new Error("--json and --markdown are mutually exclusive");
  return Object.freeze(args);
}

export async function runPackagedHostParityWithRetry({
  run = runPackagedHostParity,
  platform = process.platform,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  try {
    return await run();
  } catch (error) {
    const transientWindowsInstallTimeout = platform === "win32"
      && /offline npm install from tarball.*ETIMEDOUT/su.test(String(error?.message || error));
    if (!transientWindowsInstallTimeout) throw error;
    log("packaged-host-parity: offline install timed out; retrying once with a fresh temporary root (attempt 2/2)");
    return run();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      "Usage: node scripts/check-packaged-host-parity.mjs [--check] [--json|--markdown]",
      "",
      "Default mode is check-only: npm pack/install and all MCP runtime data stay in one",
      "validated temporary directory, lifecycle scripts and registry access are disabled,",
      "and no external host CLI or model is invoked.",
      "",
    ].join("\n"));
    return 0;
  }
  const report = await runPackagedHostParityWithRetry();
  if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (args.markdown) process.stdout.write(renderPackagedHostParityMarkdown(report));
  else {
    process.stdout.write([
      "packaged-host-parity:",
      `status=${report.packaged_adapter_e2e.status}`,
      `hosts=${report.packaged_adapter_e2e.host_count}`,
      `catalog=${report.packaged_adapter_e2e.catalog_count}`,
      `selected=${report.packaged_adapter_e2e.selected_master_ids.length}`,
      `external_cli_live_e2e=${report.external_cli_live_e2e.status}`,
      `physical_v3_decision_parity=${report.physical_v3_decision_parity.status}`,
      `inventory=${report.package_surfaces.package_inventory.status}`,
      `closure=${report.package_surfaces.package_inventory.runtime_closure_file_count}`,
      `staging=${report.package_surfaces.exclusions.knowledge_staging}`,
      `acquisitions=${report.package_surfaces.exclusions.acquisitions}`,
      `source_bin=${report.package_surfaces.exclusions.source_bin}`,
      "",
    ].join(" "));
  }
  return report.packaged_adapter_e2e.status === "passed"
    && report.external_cli_live_e2e.status === "not_run"
    && report.physical_v3_decision_parity.status === "not_run"
    && report.temporary_workspace_cleanup === "completed" ? 0 : 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`packaged host parity failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
