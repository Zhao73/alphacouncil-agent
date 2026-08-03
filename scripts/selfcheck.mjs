#!/usr/bin/env node
/** Run every check available in a source checkout and a real runtime smoke in a package. */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const PORTABLE_STEPS = Object.freeze([
  Object.freeze(["--check", "./mcp/server.mjs"]),
  Object.freeze(["scripts/sync-personas.mjs", "--check"]),
  Object.freeze(["scripts/report-persona-corpus-gaps.mjs", "--check"]),
  Object.freeze(["scripts/report-persona-v3-build-specs.mjs", "--check"]),
  Object.freeze(["scripts/check-persona-v3-production-candidates.mjs", "--check"]),
  Object.freeze(["scripts/build-persona-v3-solo-test-packs.mjs", "--check"]),
  Object.freeze(["scripts/run-persona-v3-ai-machine-simulations.mjs", "--check"]),
  Object.freeze(["scripts/check-persona-v3-ai-assisted-solo.mjs", "--check"]),
  Object.freeze(["scripts/report-host-capabilities.mjs", "--check"]),
  Object.freeze(["scripts/check-packaged-host-parity.mjs", "--check"]),
  Object.freeze(["scripts/report-council-evaluation-protocol.mjs", "--check"]),
]);

const PRIVATE_STAGING_STEPS = Object.freeze([
  Object.freeze(["scripts/report-persona-v3-staging.mjs", "--check"]),
  Object.freeze(["scripts/acquire-persona-source.mjs", "--check"]),
  Object.freeze(["scripts/pre-review-persona-sources.mjs", "--check"]),
  Object.freeze(["scripts/extract-persona-source-semantics.mjs", "--check"]),
  Object.freeze(["scripts/review-persona-source-semantics.mjs", "--check"]),
  Object.freeze(["scripts/adjudicate-persona-source-semantics.mjs", "--check"]),
  Object.freeze(["scripts/generate-persona-v3-drafts.mjs", "--check"]),
  Object.freeze(["scripts/compile-persona-v3-formulas.mjs", "--check"]),
  Object.freeze(["scripts/compile-persona-v3-formulas.mjs", "--compile-solo-test"]),
  Object.freeze(["scripts/review-persona-v3-solo-formulas.mjs", "--check"]),
  Object.freeze(["scripts/adjudicate-persona-source.mjs", "--check"]),
  Object.freeze(["scripts/export-persona-source-review-batch.mjs", "--check"]),
]);

export function hasSourceTests(root = repoRoot) {
  return existsSync(join(root, "test", "unit"))
    && existsSync(join(root, "test", "integration"))
    && existsSync(join(root, "test", "contract"));
}

export function stagingState(root = repoRoot) {
  const personas = existsSync(join(root, "knowledge", "staging", "personas-v3"));
  const formulas = existsSync(join(root, "knowledge", "staging", "persona-v3-formula-candidates"));
  if (personas !== formulas) return "partial";
  return personas ? "present" : "absent";
}

export function buildCheckPlan(root = repoRoot) {
  const staging = stagingState(root);
  if (staging === "partial") {
    throw new Error("private staging is partial: personas-v3 and persona-v3-formula-candidates must both exist or both be absent");
  }
  const tests = hasSourceTests(root);
  return Object.freeze({
    mode: tests ? (staging === "present" ? "source_with_staging" : "source_portable") : "installed_package",
    staging,
    tests,
    steps: Object.freeze([
      ...(tests ? [Object.freeze(["scripts/generate-runtime-validators.mjs", "--check"])] : []),
      ...PORTABLE_STEPS,
      ...(staging === "present" ? PRIVATE_STAGING_STEPS : []),
      Object.freeze(["scripts/run-tests.mjs"]),
    ]),
  });
}

function runStep(args, root) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function main(root = repoRoot) {
  const plan = buildCheckPlan(root);
  process.stdout.write(`alphacouncil-check: mode=${plan.mode} staging=${plan.staging} source_tests=${plan.tests}\n`);
  if (plan.staging === "absent") {
    process.stdout.write("alphacouncil-check: private/raw staging absent; verifying the packaged review capsule and solo-test tree instead\n");
  }
  for (const step of plan.steps) {
    const status = runStep(step, root);
    if (status !== 0) return status;
  }
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`alphacouncil check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
