import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkReleaseConsistency,
  formatReleaseConsistency,
  resolveDistTag,
} from "../../scripts/check-release-consistency.mjs";
import { repoFile } from "../helpers/paths.mjs";

const roots = [];
const measured = Object.freeze({ packCount: 26, toolCount: 34 });

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

function write(root, relative, value) {
  const target = join(root, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function writeJson(root, relative, value) {
  write(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture({ version = "1.5.0", unreleased = "- Pending source work.\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "alphacouncil-release-consistency-"));
  roots.push(root);

  writeJson(root, "package.json", { name: "alphacouncil-agent", version });
  writeJson(root, "package-lock.json", { version, packages: { "": { version } } });
  writeJson(root, "work/package.json", { name: "@alphacouncil/chatgpt-work-gateway", version });
  writeJson(root, "work/package-lock.json", { version, packages: { "": { version } } });
  writeJson(root, ".claude-plugin/plugin.json", {
    name: "alphacouncil-agent",
    version,
    description: "26 method lenses and 34 MCP tools.",
  });
  writeJson(root, ".codex-plugin/plugin.json", {
    name: "alphacouncil-agent",
    version,
    description: "26 method seats and 34 tools.",
  });
  writeJson(root, ".claude-plugin/marketplace.json", {
    metadata: { version },
    plugins: [{ version }],
  });
  writeJson(root, "server.json", {
    description: "26 method lenses and 34 MCP tools.",
    version,
    packages: [{ version }],
  });
  writeJson(root, "data/build-profile.v1.json", { package_version: version });
  write(root, "CLAUDE.md", `The declared package/plugin version is \`${version}\`.\n`);
  write(root, "AGENTS.md", `Package/plugin version \`${version}\` is the current source release candidate.\n`);
  write(
    root,
    "CHANGELOG.md",
    `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [${version}] — 2026-08-26\n\n- Released.\n`,
  );
  write(root, "README.md", "All 26 physical pack manifests expose 34 tools.\n");
  write(root, "README.zh-CN.md", "全部 26 个方法席，共 34 个工具。\n");
  write(root, "README.ja.md", "The 26 method lenses expose 34 MCP tools.\n");
  write(root, "docs/INSTALL.md", "Display the complete 26-seat catalog.\n");
  write(root, "PRODUCT.md", "There are 26 method seats and 34 keyless tools.\n");
  write(root, "skills/alphacouncil-agent/SKILL.md", "Route to 26 method lenses and 34 tools.\n");
  return root;
}

function check(root, options = {}) {
  return checkReleaseConsistency({
    root,
    mode: options.mode ?? "source",
    tag: options.tag,
    measured,
  });
}

test("a clean source tree passes with a complete stable output line", () => {
  const result = check(fixture());
  assert.equal(result.ok, true);
  assert.equal(result.unreleased, "non_empty");
  assert.equal(
    formatReleaseConsistency(result),
    "release-consistency: passed mode=source version=1.5.0 tag=none dist_tag=none packs=26 tools=34 changelog_top=1.5.0 unreleased=non_empty",
  );
});

test("a manifest version change or missing version aggregates as VERSION_MISMATCH", () => {
  const root = fixture();
  writeJson(root, ".claude-plugin/plugin.json", { name: "alphacouncil-agent", version: "1.4.9" });
  writeJson(root, ".codex-plugin/plugin.json", { name: "alphacouncil-agent" });
  const errors = check(root).errors.filter(({ code }) => code === "VERSION_MISMATCH");
  assert.equal(errors.length, 2);
  assert.deepEqual(errors.map(({ file }) => file), [
    join(".claude-plugin", "plugin.json"),
    join(".codex-plugin", "plugin.json"),
  ]);
});

test("the Work gateway manifest and lockfile cannot drift from the release version", () => {
  const root = fixture();
  writeJson(root, "work/package.json", { name: "@alphacouncil/chatgpt-work-gateway", version: "1.4.9" });
  writeJson(root, "work/package-lock.json", { version: "1.4.9", packages: { "": { version: "1.4.9" } } });
  const errors = check(root).errors.filter(({ code }) => code === "VERSION_MISMATCH");
  const workLock = join("work", "package-lock.json");
  const workPackage = join("work", "package.json");
  assert.deepEqual(errors.map(({ location }) => location), [
    `${workLock}:packages..version`,
    `${workLock}:version`,
    `${workPackage}:version`,
  ]);
});

test("the first numeric changelog section must match the canonical package version", () => {
  const root = fixture();
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8").replace("## [1.5.0]", "## [1.4.9]");
  write(root, "CHANGELOG.md", changelog);
  assert.deepEqual(check(root).errors.map(({ code }) => code), ["CHANGELOG_TOP_VERSION_MISMATCH"]);
});

test("the current changelog release section must carry a UTC date", () => {
  const root = fixture();
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8").replace(" — 2026-08-26", "");
  write(root, "CHANGELOG.md", changelog);
  assert.deepEqual(check(root).errors.map(({ code }) => code), ["CHANGELOG_RELEASE_DATE_MISSING"]);
});

test("Unreleased content is a source note but a tag-mode failure", () => {
  const root = fixture();
  assert.equal(check(root).ok, true);
  const tagged = check(root, { mode: "tag", tag: "v1.5.0" });
  assert.deepEqual(tagged.errors.map(({ code }) => code), ["CHANGELOG_UNRELEASED_NOT_EMPTY"]);
});

test("a stale public pack count reports its file, line, claim and measurement", () => {
  const root = fixture();
  write(root, "README.md", "All 27 physical packs expose 34 tools.\n");
  const [error] = check(root).errors;
  assert.equal(error.code, "PUBLIC_COUNT_MISMATCH");
  assert.equal(error.file, "README.md");
  assert.equal(error.line, 1);
  assert.equal(error.claimed, 27);
  assert.equal(error.measured, 26);
  assert.equal(error.kind, "packs");
});

test("tag mode distinguishes malformed tags from a valid but mismatched version", () => {
  const root = fixture({ unreleased: "" });
  for (const tag of ["1.5.0", "release-1.5.0"]) {
    assert.ok(check(root, { mode: "tag", tag }).errors.some(({ code }) => code === "TAG_FORMAT_INVALID"));
  }
  assert.ok(check(root, { mode: "tag", tag: "v1.5.1" }).errors.some(({ code }) => code === "TAG_VERSION_MISMATCH"));
});

test("rc.N versions route only to rc while unsupported prerelease ids fail closed", () => {
  const rcRoot = fixture({ version: "1.5.0-rc.1", unreleased: "" });
  const rc = check(rcRoot, { mode: "tag", tag: "v1.5.0-rc.1" });
  assert.equal(rc.ok, true);
  assert.equal(rc.distTag, "rc");
  assert.equal(resolveDistTag("v1.5.0-rc.1", "1.5.0-rc.1"), "rc");

  const betaRoot = fixture({ version: "1.5.0-beta.1", unreleased: "" });
  const beta = check(betaRoot, { mode: "tag", tag: "v1.5.0-beta.1" });
  assert.ok(beta.errors.some(({ code }) => code === "TAG_PRERELEASE_ID_UNSUPPORTED"));
});

test("independent failures are reported together instead of stopping at the first", () => {
  const root = fixture();
  writeJson(root, ".claude-plugin/plugin.json", { version: "1.4.9" });
  write(root, "README.md", "All 27 physical packs expose 35 tools.\n");
  write(root, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- Pending.\n\n## [1.4.9]\n");
  const codes = new Set(check(root).errors.map(({ code }) => code));
  assert.deepEqual(codes, new Set([
    "VERSION_MISMATCH",
    "CHANGELOG_TOP_VERSION_MISMATCH",
    "CHANGELOG_RELEASE_DATE_MISSING",
    "PUBLIC_COUNT_MISMATCH",
  ]));
});

test("the real checkout passes the offline CLI without network access", () => {
  const output = execFileSync(
    process.execPath,
    [repoFile("scripts/check-release-consistency.mjs"), "--source"],
    { cwd: repoFile("."), encoding: "utf8", timeout: 30_000 },
  );
  assert.match(output, /^release-consistency: passed mode=source .* packs=26 tools=\d+ /mu);
  assert.match(output, /^remote_checks: out_of_scope \(WP-6\)$/mu);
});
