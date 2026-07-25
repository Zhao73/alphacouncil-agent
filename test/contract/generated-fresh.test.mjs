import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../helpers/paths.mjs";

// npm run check already runs --check before the tests, but a contract test means a
// developer running `node --test` alone still finds out.
test("generated host files are in sync with personas/", () => {
  const result = spawnSync(process.execPath, ["scripts/sync-personas.mjs", "--check"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
