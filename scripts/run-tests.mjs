#!/usr/bin/env node
/** Select the full source test suite or a non-zero installed-package runtime smoke. */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hasSourceTests, repoRoot } from "./selfcheck.mjs";

export function main(root = repoRoot) {
  const args = hasSourceTests(root) ? ["--test"] : ["scripts/package-smoke.mjs"];
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`alphacouncil test failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
