import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildCheckPlan } from "../../scripts/selfcheck.mjs";
import { runPackageSmoke } from "../../scripts/package-smoke.mjs";

test("the release package smoke executes selection and rejects receipt replay", async () => {
  const result = await runPackageSmoke();
  assert.deepEqual(result, { tools: 32, catalog: 26, locales: 4, selected: 1, replay_rejected: true });
});

test("selfcheck never treats partial private staging as a valid source tree", (t) => {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-check-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "knowledge", "staging", "personas-v3"), { recursive: true });
  assert.throws(() => buildCheckPlan(root), /private staging is partial/);
});
