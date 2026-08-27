import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SOURCE_PORTABLE_EXCLUDED_TEST_COUNT,
  SOURCE_PORTABLE_EXCLUDED_TESTS,
  WINDOWS_SOURCE_TEST_CONCURRENCY,
  WINDOWS_SERIAL_TEST_FILES,
  buildTestPlan,
  main,
  sourceTestConcurrencyArg,
  validatePortableExclusions,
} from "../../scripts/run-tests.mjs";
import { repoRoot } from "../../scripts/selfcheck.mjs";

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
const EXPECTED_WINDOWS_SERIAL_TEST_FILES = Object.freeze([
  "test/integration/full-analysis.test.mjs",
  "test/integration/master-runtime-observability.test.mjs",
  "test/contract/packaged-host-parity.test.mjs",
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
  assert.equal(WINDOWS_SOURCE_TEST_CONCURRENCY, 2);
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
  assert.equal(WINDOWS_SERIAL_TEST_FILES.length, 3);
  assert.deepEqual(WINDOWS_SERIAL_TEST_FILES, EXPECTED_WINDOWS_SERIAL_TEST_FILES);
  assert.deepEqual(validatePortableExclusions(root), [...EXPECTED_PORTABLE_EXCLUSIONS, "test/contract/portable.test.mjs"].sort());

  const plan = buildTestPlan(root);
  assert.equal(plan.mode, "source_portable");
  assert.deepEqual(plan.excluded, EXPECTED_PORTABLE_EXCLUSIONS);
  assert.deepEqual(plan.args, ["--test", "--test-concurrency=4", "test/contract/portable.test.mjs"]);

  const syntheticWindowsPlan = buildTestPlan(root, { platform: "win32" });
  assert.deepEqual(syntheticWindowsPlan.phases, [{
    id: "source_suite",
    invocations: [{ file: null, args: syntheticWindowsPlan.args }],
  }]);

  write(root, "scripts/run-tests.mjs");
  assert.throws(
    () => buildTestPlan(root, { platform: "win32" }),
    /Windows serial test group is missing from the source suite/,
  );
  write(root, WINDOWS_SERIAL_TEST_FILES[0]);
  assert.throws(
    () => buildTestPlan(root, { platform: "win32" }),
    new RegExp(WINDOWS_SERIAL_TEST_FILES[1].replaceAll("/", "\\/")),
  );
  write(root, WINDOWS_SERIAL_TEST_FILES[1]);
  assert.throws(
    () => buildTestPlan(root, { platform: "win32" }),
    new RegExp(WINDOWS_SERIAL_TEST_FILES[2].replaceAll("/", "\\/")),
  );
  write(root, WINDOWS_SERIAL_TEST_FILES[2]);
  const markedRealWindowsPlan = buildTestPlan(root, { platform: "win32" });
  assert.deepEqual(markedRealWindowsPlan.phases.map((phase) => phase.id), ["windows_bounded_source", "windows_serial"]);
  assert.equal(markedRealWindowsPlan.phases[0].invocations[0].args[1], "--test-concurrency=2");
  assert.deepEqual(
    markedRealWindowsPlan.phases[1].invocations.map((invocation) => invocation.file),
    WINDOWS_SERIAL_TEST_FILES,
  );
  assert.ok(markedRealWindowsPlan.phases[1].invocations.every((invocation) =>
    invocation.args.length === 3
    && invocation.args[0] === "--test"
    && invocation.args[1] === "--test-concurrency=1"
    && invocation.args[2] === invocation.file));

  const realWindowsPlan = buildTestPlan(repoRoot, { platform: "win32" });
  assert.deepEqual(realWindowsPlan.phases.map((phase) => phase.id), ["windows_bounded_source", "windows_serial"]);
  const [concurrent, serial] = realWindowsPlan.phases;
  assert.equal(concurrent.invocations.length, 1);
  assert.equal(concurrent.invocations[0].file, null);
  assert.equal(concurrent.invocations[0].args[1], "--test-concurrency=2");
  assert.deepEqual(serial.invocations.map((invocation) => invocation.file), WINDOWS_SERIAL_TEST_FILES);
  assert.ok(WINDOWS_SERIAL_TEST_FILES.every((file) => !concurrent.invocations[0].args.includes(file)));
  const selectedFiles = realWindowsPlan.args.filter((arg) => arg.endsWith(".mjs")).sort();
  const scheduledFiles = [
    ...concurrent.invocations[0].args,
    ...serial.invocations.flatMap((invocation) => invocation.args),
  ].filter((arg) => arg.endsWith(".mjs")).sort();
  assert.deepEqual(scheduledFiles, selectedFiles, "Windows phases must preserve the exact selected-file multiset");

  const successfulCalls = [];
  const successfulOutput = [];
  assert.equal(main(repoRoot, {
    platform: "win32",
    spawn: (_command, args) => {
      successfulCalls.push(args);
      return { status: 0 };
    },
    write: (chunk) => successfulOutput.push(chunk),
  }), 0);
  assert.deepEqual(successfulCalls, [
    concurrent.invocations[0].args,
    ...serial.invocations.map((invocation) => invocation.args),
  ]);
  assert.deepEqual(
    successfulOutput.filter((line) => line.includes("serial_file=")),
    WINDOWS_SERIAL_TEST_FILES.map((file) => `alphacouncil-test: serial_file=${file}\n`),
  );

  const stoppedCalls = [];
  assert.equal(main(repoRoot, {
    platform: "win32",
    spawn: (_command, args) => {
      stoppedCalls.push(args);
      return { status: stoppedCalls.length === 3 ? 7 : 0 };
    },
    write: () => {},
  }), 7);
  assert.deepEqual(stoppedCalls, successfulCalls.slice(0, 3), "a failed serial file must stop before parity");
});

test("portable mode fails closed when an exclusion no longer names a source test", (t) => {
  const root = temporaryRoot(t);
  createSourceTree(root);
  for (const rel of EXPECTED_PORTABLE_EXCLUSIONS.slice(1)) write(root, rel);
  write(root, "test/contract/portable.test.mjs");
  assert.throws(() => buildTestPlan(root), /source_portable exclusion is missing from this source tree/);
});
