#!/usr/bin/env node
/**
 * Select a test command that is valid for each distributable tree shape.
 *
 * Private authoring material under knowledge/staging is intentionally excluded
 * from git. A clean source checkout must therefore run every committed test
 * except the small, explicit set whose subject is that private material.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { hasSourceTests, repoRoot, stagingState } from "./selfcheck.mjs";

export const SOURCE_PORTABLE_EXCLUDED_TESTS = Object.freeze([
  "test/integration/persona-v3-solo-formula-execution.test.mjs",
  "test/unit/persona-v3-ai-assisted-solo-status.test.mjs",
  "test/unit/persona-v3-ai-formula-review.test.mjs",
  "test/unit/persona-v3-ai-source-pre-review.test.mjs",
  "test/unit/persona-v3-formula-pipeline.test.mjs",
  "test/unit/persona-v3-formula-review-attestations.test.mjs",
  "test/unit/persona-v3-ga-gate.test.mjs",
  "test/unit/persona-v3-production-candidates.test.mjs",
  "test/unit/persona-v3-production-root.test.mjs",
  "test/unit/persona-v3-release-assembly.test.mjs",
  "test/unit/persona-v3-release-promotion.test.mjs",
  "test/unit/persona-v3-semantic-source-adjudication.test.mjs",
  "test/unit/persona-v3-semantic-source-extraction.test.mjs",
  "test/unit/persona-v3-semantic-source-skeptic-review.test.mjs",
]);

export const SOURCE_PORTABLE_EXCLUDED_TEST_COUNT = 14;

function listMjsFiles(root, directory = join(root, "test")) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return listMjsFiles(root, path);
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) return [];
      return [relative(root, path).split(sep).join("/")];
    })
    .sort();
}

export function sourceTestFiles(root = repoRoot) {
  return Object.freeze(listMjsFiles(root));
}

export function validatePortableExclusions(root = repoRoot) {
  if (SOURCE_PORTABLE_EXCLUDED_TESTS.length !== SOURCE_PORTABLE_EXCLUDED_TEST_COUNT) {
    throw new Error(
      `source_portable exclusion list drifted: expected ${SOURCE_PORTABLE_EXCLUDED_TEST_COUNT}, found ${SOURCE_PORTABLE_EXCLUDED_TESTS.length}`,
    );
  }
  if (new Set(SOURCE_PORTABLE_EXCLUDED_TESTS).size !== SOURCE_PORTABLE_EXCLUDED_TESTS.length) {
    throw new Error("source_portable exclusion list contains duplicates");
  }

  const files = sourceTestFiles(root);
  for (const rel of SOURCE_PORTABLE_EXCLUDED_TESTS) {
    if (!rel.startsWith("test/") || !rel.endsWith(".mjs") || rel.includes("..")) {
      throw new Error(`invalid source_portable exclusion path: ${rel}`);
    }
    if (!files.includes(rel) || !statSync(join(root, rel)).isFile()) {
      throw new Error(`source_portable exclusion is missing from this source tree: ${rel}`);
    }
  }
  return files;
}

export function buildTestPlan(root = repoRoot) {
  const tests = hasSourceTests(root);
  const staging = stagingState(root);
  if (staging === "partial") {
    throw new Error("private staging is partial: personas-v3 and persona-v3-formula-candidates must both exist or both be absent");
  }
  if (!tests) {
    return Object.freeze({ mode: "installed_package", excluded: Object.freeze([]), args: Object.freeze(["scripts/package-smoke.mjs"]) });
  }
  if (staging === "present") {
    return Object.freeze({ mode: "source_with_staging", excluded: Object.freeze([]), args: Object.freeze(["--test"]) });
  }

  const excluded = new Set(SOURCE_PORTABLE_EXCLUDED_TESTS);
  const files = validatePortableExclusions(root);
  const selected = files.filter((file) => !excluded.has(file));
  if (selected.length === 0) throw new Error("source_portable test selection is empty");
  return Object.freeze({
    mode: "source_portable",
    excluded: SOURCE_PORTABLE_EXCLUDED_TESTS,
    args: Object.freeze(["--test", ...selected]),
  });
}

export function main(root = repoRoot) {
  const plan = buildTestPlan(root);
  process.stdout.write(`alphacouncil-test: mode=${plan.mode} excluded=${plan.excluded.length}\n`);
  const result = spawnSync(process.execPath, plan.args, { cwd: root, env: process.env, stdio: "inherit" });
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
