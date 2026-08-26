import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { repoRoot } from "../helpers/paths.mjs";
import {
  PACKAGE_INVENTORY_CATEGORIES,
  WP2_FORBIDDEN_PACKAGE_PATHS,
  WP2_REQUIRED_PACKAGE_TREES,
  deriveStaticImportClosure,
} from "../../scripts/lib/package-inventory.mjs";
import { runPackageInventory } from "../../scripts/report-package-inventory.mjs";

test("package inventory re-derives the server closure and keeps build-only persona tooling outside it", () => {
  const closure = deriveStaticImportClosure(repoRoot);
  assert.equal(closure.entry, "mcp/server.mjs");
  assert.deepEqual(closure.unresolved, []);
  assert.deepEqual(closure.dynamic, []);
  for (const required of [
    "mcp/server.mjs",
    "mcp/lib/rpc.mjs",
    "mcp/lib/orchestrator.mjs",
    "mcp/lib/personas-v2/bridge.mjs",
    "mcp/lib/personas-v3/runtime.mjs",
  ]) assert.ok(closure.files.includes(required), required);
  for (const buildOnly of [
    "mcp/lib/personas-v3/ga-gate.mjs",
    "mcp/lib/personas-v3/n-eff.mjs",
    "mcp/lib/personas-v3/source-acquisition.mjs",
  ]) assert.ok(!closure.files.includes(buildOnly), buildOnly);
  assert.ok(!existsSync(`${repoRoot}/mcp/lib/personas-v2/ablation.mjs`));
  assert.ok(!existsSync(`${repoRoot}/mcp/lib/personas-v2/memory.mjs`));
});

test("real npm pack inventory classifies every path and preserves required trees", { timeout: 120_000 }, () => {
  const report = runPackageInventory(repoRoot);
  assert.deepEqual(report.issues, []);
  assert.equal(report.runtime_closure.file_count, report.runtime_closure.files.length);
  assert.ok(report.runtime_closure.file_count >= 100);
  assert.deepEqual(Object.keys(report.classification_summary), [...PACKAGE_INVENTORY_CATEGORIES]);
  assert.equal(
    Object.values(report.classification_summary).reduce((sum, value) => sum + value.files, 0),
    report.package.file_count,
  );
  assert.equal(report.entries.length, report.package.file_count);
  assert.ok(report.entries.every((entry) => entry.category && entry.evidence));
  assert.ok(report.entries
    .filter((entry) => ["build-only", "unknown"].includes(entry.category))
    .every((entry) => /(?:direct static JS callers:|zero static JS importers)/u.test(entry.evidence)));
  const paths = new Set(report.entries.map((entry) => entry.path));
  for (const forbidden of WP2_FORBIDDEN_PACKAGE_PATHS) assert.ok(!paths.has(forbidden), forbidden);
  for (const tree of WP2_REQUIRED_PACKAGE_TREES) {
    assert.ok(report.entries.some((entry) => entry.path.startsWith(tree.prefix)), tree.prefix);
  }
  assert.equal(
    report.entries.filter((entry) => /^knowledge\/solo-test\/masters\/[^/]+\/manifest\.json$/u.test(entry.path)).length,
    26,
  );
});
