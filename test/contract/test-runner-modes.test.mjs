import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SOURCE_PORTABLE_EXCLUDED_TEST_COUNT,
  SOURCE_PORTABLE_EXCLUDED_TESTS,
  buildTestPlan,
  sourceTestConcurrencyArg,
  validatePortableExclusions,
} from "../../scripts/run-tests.mjs";

const EXPECTED_PORTABLE_EXCLUSIONS = Object.freeze([
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

function temporaryRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-test-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, rel) {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "// fixture\n", "utf8");
}

function createSourceTree(root) {
  for (const directory of ["test/unit", "test/integration", "test/contract"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  for (const dependency of ["ajv", "fast-check", "jsonrepair"]) {
    const directory = join(root, "node_modules", dependency);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name: dependency, version: "0.0.0-fixture" })}\n`);
  }
}

test("bounded test concurrency degrades safely on older supported Node releases", () => {
  assert.equal(sourceTestConcurrencyArg(4, "18.18.2"), null);
  assert.equal(sourceTestConcurrencyArg(4, "18.19.0"), "--test-concurrency=4");
  assert.equal(sourceTestConcurrencyArg(8, "20.9.0"), null);
  assert.equal(sourceTestConcurrencyArg(8, "20.10.0"), "--test-concurrency=8");
  assert.equal(sourceTestConcurrencyArg(4, "21.0.0"), "--test-concurrency=4");
});

test("test runner selects installed-package smoke without source tests", (t) => {
  const plan = buildTestPlan(temporaryRoot(t));
  assert.equal(plan.mode, "installed_package");
  assert.deepEqual(plan.excluded, []);
  assert.deepEqual(plan.args, ["scripts/package-smoke.mjs"]);
});

test("test runner selects installed-package smoke when a plugin cache has tests but no dev dependencies", (t) => {
  const root = temporaryRoot(t);
  for (const directory of ["test/unit", "test/integration", "test/contract"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const plan = buildTestPlan(root);
  assert.equal(plan.mode, "installed_package");
  assert.deepEqual(plan.args, ["scripts/package-smoke.mjs"]);
});

test("test runner selects the complete suite when private staging is present", (t) => {
  const root = temporaryRoot(t);
  createSourceTree(root);
  mkdirSync(join(root, "knowledge/staging/personas-v3"), { recursive: true });
  mkdirSync(join(root, "knowledge/staging/persona-v3-formula-candidates"), { recursive: true });
  const plan = buildTestPlan(root);
  assert.equal(plan.mode, "source_with_staging");
  assert.deepEqual(plan.excluded, []);
  assert.deepEqual(plan.args, ["--test", "--test-concurrency=4"]);
});

test("test runner selects every portable source test except the reviewed private-staging list", (t) => {
  const root = temporaryRoot(t);
  createSourceTree(root);
  for (const rel of EXPECTED_PORTABLE_EXCLUSIONS) write(root, rel);
  write(root, "test/contract/portable.test.mjs");

  assert.equal(SOURCE_PORTABLE_EXCLUDED_TEST_COUNT, EXPECTED_PORTABLE_EXCLUSIONS.length);
  assert.deepEqual(SOURCE_PORTABLE_EXCLUDED_TESTS, EXPECTED_PORTABLE_EXCLUSIONS);
  assert.deepEqual(validatePortableExclusions(root), [...EXPECTED_PORTABLE_EXCLUSIONS, "test/contract/portable.test.mjs"].sort());

  const plan = buildTestPlan(root);
  assert.equal(plan.mode, "source_portable");
  assert.deepEqual(plan.excluded, EXPECTED_PORTABLE_EXCLUSIONS);
  assert.deepEqual(plan.args, ["--test", "--test-concurrency=4", "test/contract/portable.test.mjs"]);

  const syntheticWindowsPlan = buildTestPlan(root, { platform: "win32" });
  assert.deepEqual(syntheticWindowsPlan.phases, [{ id: "source_suite", args: syntheticWindowsPlan.args }]);

  write(root, "scripts/run-tests.mjs");
  assert.throws(
    () => buildTestPlan(root, { platform: "win32" }),
    /Windows isolated test is missing from the source suite/,
  );
});

test("portable mode fails closed when an exclusion no longer names a source test", (t) => {
  const root = temporaryRoot(t);
  createSourceTree(root);
  for (const rel of EXPECTED_PORTABLE_EXCLUSIONS.slice(1)) write(root, rel);
  write(root, "test/contract/portable.test.mjs");
  assert.throws(() => buildTestPlan(root), /source_portable exclusion is missing from this source tree/);
});
