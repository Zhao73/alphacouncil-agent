import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildCheckPlan } from "../../scripts/selfcheck.mjs";
import { runPackageSmoke } from "../../scripts/package-smoke.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

test("the release package smoke executes selection and rejects receipt replay", async () => {
  const result = await runPackageSmoke();
  assert.deepEqual(result, {
    tools: 34,
    catalog: CANONICAL_MASTER_COUNT,
    locales: 4,
    selected: 1,
    replay_rejected: true,
  });
});

test("selfcheck never treats partial private staging as a valid source tree", (t) => {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-check-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "knowledge", "staging", "personas-v3"), { recursive: true });
  assert.throws(() => buildCheckPlan(root), /private staging is partial/);
});

test("selfcheck treats a Codex source cache without devDependencies as an installed package", (t) => {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-installed-cache-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["test/unit", "test/integration", "test/contract"]) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  const plan = buildCheckPlan(root);
  assert.equal(plan.mode, "installed_package");
  assert.equal(plan.tests, false);
  assert.deepEqual(plan.steps.at(-1), ["scripts/run-tests.mjs"]);
});
