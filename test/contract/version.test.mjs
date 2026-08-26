import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { __test__ } from "../../mcp/server.mjs";
import { repoFile } from "../helpers/paths.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { RUNTIME_BUILD_IDENTITY } from "../../mcp/lib/constants.mjs";

const readJson = (rel) => JSON.parse(readFileSync(repoFile(rel), "utf8"));
const readText = (rel) => readFileSync(repoFile(rel), "utf8");

test("every manifest and the served VERSION agree with package.json", () => {
  const expected = readJson("package.json").version;
  const marketplace = readJson(".claude-plugin/marketplace.json");
  const packageLock = readJson("package-lock.json");
  const server = readJson("server.json");
  const declared = {
    "mcp/server.mjs VERSION": __test__.VERSION,
    ".claude-plugin/plugin.json": readJson(".claude-plugin/plugin.json").version,
    ".codex-plugin/plugin.json": readJson(".codex-plugin/plugin.json").version,
    ".claude-plugin/marketplace.json metadata": marketplace.metadata.version,
    ".claude-plugin/marketplace.json plugins[0]": marketplace.plugins[0].version,
    "package-lock.json root": packageLock.version,
    "package-lock.json packages root": packageLock.packages[""].version,
    "server.json root": server.version,
    "server.json packages[0]": server.packages[0].version,
    "data/build-profile.v1.json package_version": readJson("data/build-profile.v1.json").package_version,
  };
  for (const [where, version] of Object.entries(declared)) {
    assert.equal(version, expected, `${where} drifted from package.json`);
  }
  assert.ok(
    readText("CLAUDE.md").includes(`declared package/plugin version is \`${expected}\``),
    "CLAUDE.md current build profile drifted from package.json",
  );
  assert.ok(
    readText("AGENTS.md").includes(`Package/plugin version \`${expected}\` is the current source release candidate`),
    "AGENTS.md current release boundary drifted from package.json",
  );
});

test("runtime build identity binds the version to the critical executable source bytes", () => {
  assert.equal(RUNTIME_BUILD_IDENTITY.contract_id, "alphacouncil_runtime_build_v1");
  assert.equal(RUNTIME_BUILD_IDENTITY.package_version, readJson("package.json").version);
  assert.match(RUNTIME_BUILD_IDENTITY.critical_source_sha256, /^[0-9a-f]{64}$/u);
  assert.ok(RUNTIME_BUILD_IDENTITY.critical_source_files.includes("mcp/lib/orchestrator.mjs"));
  assert.ok(RUNTIME_BUILD_IDENTITY.critical_source_files.includes("mcp/lib/codex.mjs"));
  assert.ok(RUNTIME_BUILD_IDENTITY.critical_source_files.includes("mcp/lib/timing-ledger.mjs"));
  assert.ok(RUNTIME_BUILD_IDENTITY.critical_source_files.includes("mcp/lib/timing-replay.mjs"));
  assert.ok(RUNTIME_BUILD_IDENTITY.critical_source_files.includes("mcp/lib/company-source-acquisition.mjs"));
  assert.ok(RUNTIME_BUILD_IDENTITY.critical_source_files.includes("schemas/runtime-headless-portfolio-manager-decision-v1.schema.json"));
  assert.ok(RUNTIME_BUILD_IDENTITY.critical_source_files.includes("scripts/lib/run-bundle.mjs"));
  assert.ok(RUNTIME_BUILD_IDENTITY.critical_source_files.includes("schemas/run-bundle-v1.schema.json"));
  assert.ok(RUNTIME_BUILD_IDENTITY.critical_source_files.includes("schemas/timing-ledger-v1.schema.json"));
  assert.ok(RUNTIME_BUILD_IDENTITY.git_commit === null || /^[0-9a-f]{40}$/u.test(RUNTIME_BUILD_IDENTITY.git_commit));
  assert.ok([true, false, null].includes(RUNTIME_BUILD_IDENTITY.git_tracked_tree_dirty));
});

test("the current runtime keeps the reviewed 0.9.4 PersonaPack snapshot and its admission level", () => {
  const expected = readJson("package.json").version;
  const pkg = readJson("package.json");
  const profile = readJson("data/build-profile.v1.json");
  const schema = readJson("schemas/persona-v3.schema.json");
  assert.equal(expected, "1.5.0");
  assert.equal(profile.persona_pack_version, "0.9.4");
  assert.equal(pkg.publishConfig.tag, "latest");
  assert.equal(profile.channel, "solo_test");
  assert.equal(profile.production_eligible, false);
  assert.equal(profile.method_model_eligible, false);
  assert.equal(new RegExp(schema.properties.pack_version.pattern, "u").test(expected), true);

  const root = repoFile("knowledge/solo-test/masters");
  const personaIds = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.equal(personaIds.length, CANONICAL_MASTER_COUNT);
  for (const personaId of personaIds) {
    assert.equal(
      readJson(`knowledge/solo-test/masters/${personaId}/manifest.json`).pack_version,
      profile.persona_pack_version,
      `${personaId} pack version drifted from package.json`,
    );
  }
});

test("current reference prose does not embed a package version in the solo-test catalog claim", () => {
  assert.doesNotMatch(
    readText("docs/reference/README.ja.md"),
    /\b\d+\.\d+\.\d+\s+`solo_test`\s+カタログ/u,
  );
});
