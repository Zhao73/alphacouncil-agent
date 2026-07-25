import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { __test__ } from "../../mcp/server.mjs";
import { repoFile } from "../helpers/paths.mjs";

const readJson = (rel) => JSON.parse(readFileSync(repoFile(rel), "utf8"));

test("every manifest and the served VERSION agree with package.json", () => {
  const expected = readJson("package.json").version;
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const declared = {
    "mcp/server.mjs VERSION": __test__.VERSION,
    ".claude-plugin/plugin.json": readJson(".claude-plugin/plugin.json").version,
    ".codex-plugin/plugin.json": readJson(".codex-plugin/plugin.json").version,
    ".claude-plugin/marketplace.json metadata": marketplace.metadata.version,
    ".claude-plugin/marketplace.json plugins[0]": marketplace.plugins[0].version,
  };
  for (const [where, version] of Object.entries(declared)) {
    assert.equal(version, expected, `${where} drifted from package.json`);
  }
});
