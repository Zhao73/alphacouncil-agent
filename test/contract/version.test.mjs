import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
    "data/build-profile.v1.json package_version": readJson("data/build-profile.v1.json").package_version,
  };
  for (const [where, version] of Object.entries(declared)) {
    assert.equal(version, expected, `${where} drifted from package.json`);
  }
});

test("the 0.9.3 preview stays non-GA across all 26 physical packs", () => {
  const expected = readJson("package.json").version;
  const pkg = readJson("package.json");
  const profile = readJson("data/build-profile.v1.json");
  const schema = readJson("schemas/persona-v3.schema.json");
  assert.equal(expected, "0.9.3");
  assert.equal(pkg.publishConfig.tag, "next");
  assert.equal(profile.channel, "solo_test");
  assert.equal(profile.production_eligible, false);
  assert.equal(profile.method_model_eligible, false);
  assert.equal(new RegExp(schema.properties.pack_version.pattern, "u").test(expected), true);

  const root = repoFile("knowledge/solo-test/masters");
  const personaIds = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.equal(personaIds.length, 26);
  for (const personaId of personaIds) {
    assert.equal(
      readJson(`knowledge/solo-test/masters/${personaId}/manifest.json`).pack_version,
      expected,
      `${personaId} pack version drifted from package.json`,
    );
  }
});
