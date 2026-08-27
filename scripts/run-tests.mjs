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

import { hasRunnableSourceTests, repoRoot, stagingState } from "./selfcheck.mjs";

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
// The suite contains several package-install and hash-audit files that each spawn
// their own child processes. Node's CPU-count default can oversubscribe large CI
// hosts and turn deterministic sub-second fixtures into platform-specific timeouts.
export const SOURCE_TEST_CONCURRENCY = 4;
export const WINDOWS_SERIAL_TEST_FILES = Object.freeze([
  // A wall-clock parallel-wave assertion failed under Windows file-level concurrency:
  // https://github.com/Zhao73/alphacouncil-agent/actions/runs/33043857486/job/98423253736
  "test/integration/full-analysis.test.mjs",
  // Concurrent temporary installs produced bounded double-ETIMEDOUT parity failures:
  // https://github.com/Zhao73/alphacouncil-agent/actions/runs/33041464732/job/98415795513
  "test/contract/packaged-host-parity.test.mjs",
]);
export const PACKAGED_HOST_PARITY_TEST_FILE = WINDOWS_SERIAL_TEST_FILES[1];

export function sourceTestConcurrencyArg(concurrency = SOURCE_TEST_CONCURRENCY, nodeVersion = process.versions.node) {
  const [major = 0, minor = 0] = String(nodeVersion).split(".").map(Number);
  const supported = (major === 18 && minor >= 19)
    || (major === 20 && minor >= 10)
    || major >= 21;
  return supported ? `--test-concurrency=${concurrency}` : null;
}

function sourceTestArgs(files = [], concurrency = SOURCE_TEST_CONCURRENCY) {
  const concurrencyArg = sourceTestConcurrencyArg(concurrency);
  return Object.freeze(["--test", ...(concurrencyArg ? [concurrencyArg] : []), ...files]);
}

function executionPhases({ mode, args, selectedFiles, requireWindowsSerialGroup }, platform = process.platform) {
  if (!mode.startsWith("source_") || platform !== "win32") {
    return Object.freeze([
      Object.freeze({ id: mode === "installed_package" ? "installed_package" : "source_suite", args }),
    ]);
  }

  const presentSerialFiles = WINDOWS_SERIAL_TEST_FILES.filter((file) => selectedFiles.includes(file));
  const missingSerialFiles = WINDOWS_SERIAL_TEST_FILES.filter((file) => !selectedFiles.includes(file));
  if (missingSerialFiles.length > 0) {
    if (requireWindowsSerialGroup || presentSerialFiles.length > 0) {
      throw new Error(`Windows serial test group is missing from the source suite: ${missingSerialFiles.join(", ")}`);
    }
    return Object.freeze([Object.freeze({ id: "source_suite", args })]);
  }

  const serialFiles = new Set(WINDOWS_SERIAL_TEST_FILES);
  const concurrentFiles = selectedFiles.filter((file) => !serialFiles.has(file));
  if (concurrentFiles.length === 0) throw new Error("Windows concurrent source-test phase is empty");
  return Object.freeze([
    Object.freeze({
      id: "source_concurrent",
      args: sourceTestArgs(concurrentFiles),
    }),
    Object.freeze({
      id: "windows_serial",
      args: sourceTestArgs(WINDOWS_SERIAL_TEST_FILES, 1),
    }),
  ]);
}

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

export function buildTestPlan(root = repoRoot, { platform = process.platform } = {}) {
  const tests = hasRunnableSourceTests(root);
  const staging = stagingState(root);
  // Contract fixtures construct intentionally minimal source-shaped trees. A real checkout is
  // identified by the runner file itself and must never silently lose the Windows serial group.
  const requireWindowsSerialGroup = existsSync(join(root, "scripts", "run-tests.mjs"));
  if (staging === "partial") {
    throw new Error("private staging is partial: personas-v3 and persona-v3-formula-candidates must both exist or both be absent");
  }
  if (!tests) {
    const mode = "installed_package";
    const args = Object.freeze(["scripts/package-smoke.mjs"]);
    return Object.freeze({
      mode,
      excluded: Object.freeze([]),
      args,
      phases: executionPhases({ mode, args, selectedFiles: Object.freeze([]), requireWindowsSerialGroup }, platform),
    });
  }
  if (staging === "present") {
    const mode = "source_with_staging";
    const args = sourceTestArgs();
    const selectedFiles = Object.freeze(sourceTestFiles(root).filter((file) => file.endsWith(".test.mjs")));
    return Object.freeze({
      mode,
      excluded: Object.freeze([]),
      args,
      phases: executionPhases({ mode, args, selectedFiles, requireWindowsSerialGroup }, platform),
    });
  }

  const excluded = new Set(SOURCE_PORTABLE_EXCLUDED_TESTS);
  const files = validatePortableExclusions(root);
  const selected = files.filter((file) => !excluded.has(file));
  if (selected.length === 0) throw new Error("source_portable test selection is empty");
  const mode = "source_portable";
  const args = sourceTestArgs(selected);
  return Object.freeze({
    mode,
    excluded: SOURCE_PORTABLE_EXCLUDED_TESTS,
    args,
    phases: executionPhases({
      mode,
      args,
      selectedFiles: Object.freeze(selected),
      requireWindowsSerialGroup,
    }, platform),
  });
}

export function main(root = repoRoot) {
  const plan = buildTestPlan(root);
  process.stdout.write(`alphacouncil-test: mode=${plan.mode} excluded=${plan.excluded.length}\n`);
  for (const phase of plan.phases) {
    process.stdout.write(`alphacouncil-test: phase=${phase.id}\n`);
    const result = spawnSync(process.execPath, phase.args, { cwd: root, env: process.env, stdio: "inherit" });
    if (result.error) throw result.error;
    if ((result.status ?? 1) !== 0) return result.status ?? 1;
  }
  return 0;
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
