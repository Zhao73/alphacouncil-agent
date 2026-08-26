#!/usr/bin/env node
/** Repack the current tree and classify every shipped file by evidence level. */

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertPackageInventory, buildPackageInventoryReport } from "./lib/package-inventory.mjs";

export const PACKAGE_INVENTORY_REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMP_PREFIX = "alphacouncil-package-inventory-";

function npmCommand(args, env) {
  if (env.npm_execpath && existsSync(env.npm_execpath)) return { command: process.execPath, args: [env.npm_execpath, ...args] };
  if (process.platform === "win32") return { command: env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] };
  return { command: "npm", args };
}

function packMetadata(repoRoot, tempRoot) {
  const env = { ...process.env, npm_config_ignore_scripts: "true" };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "npm_config_dry_run") delete env[key];
  const invocation = npmCommand(["pack", "--json", "--ignore-scripts", "--pack-destination", tempRoot], env);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm pack exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch (error) { throw new Error(`npm pack emitted invalid JSON: ${error.message}`); }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("npm pack must emit exactly one result");
  return parsed[0];
}

export function runPackageInventory(repoRoot = PACKAGE_INVENTORY_REPO_ROOT) {
  const osTemp = realpathSync(tmpdir());
  const tempRoot = mkdtempSync(join(osTemp, TEMP_PREFIX));
  if (dirname(tempRoot) !== osTemp || !basename(tempRoot).startsWith(TEMP_PREFIX)) {
    throw new Error(`unsafe package-inventory temporary root: ${tempRoot}`);
  }
  try {
    return buildPackageInventoryReport(realpathSync(resolve(repoRoot)), packMetadata(repoRoot, tempRoot));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function renderPackageInventoryMarkdown(report) {
  const lines = [
    "# npm package inventory",
    "",
    `- Package: \`${report.package.name}@${report.package.version}\``,
    `- Tarball: ${report.package.compressed_bytes} compressed bytes; ${report.package.unpacked_bytes} unpacked bytes; ${report.package.file_count} files`,
    `- Runtime static closure: ${report.runtime_closure.file_count} files; unresolved=${report.runtime_closure.unresolved.length}; non-literal dynamic/require=${report.runtime_closure.non_literal_dynamic_or_require.length}`,
    `- Validation issues: ${report.issues.length}`,
    "",
    "| Classification | Files | Bytes |",
    "|---|---:|---:|",
    ...Object.entries(report.classification_summary).map(([category, value]) => `| ${category} | ${value.files} | ${value.bytes} |`),
    "",
    "Every file is listed by `--json`; unknown files are retained, not treated as removal candidates.",
  ];
  return `${lines.join("\n")}\n`;
}

export function main(args = process.argv.slice(2)) {
  const report = runPackageInventory();
  if (args.includes("--check")) assertPackageInventory(report);
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : renderPackageInventoryMarkdown(report));
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = main(); }
  catch (error) {
    process.stderr.write(`package inventory failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
