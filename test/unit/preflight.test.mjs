import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightNetworkPermissions, requiredTools, canonicalTool } from "../../mcp/lib/preflight.mjs";

/** Build an isolated fake home + cwd so the developer's real settings never leak in. */
function withHost(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "preflight-test-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  try {
    for (const [rel, value] of Object.entries(files)) {
      const path = join(root, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(value, null, 2));
    }
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    return fn({ home, cwd });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const REQUIRED = ["websearch", "webfetch"];
const check = (opts) => preflightNetworkPermissions({ ...opts, required: REQUIRED });

test("required tools come from the personas, and get_quote is excluded", () => {
  const required = requiredTools();
  assert.deepEqual(required, ["webfetch", "websearch"]);
  assert.ok(!required.includes("get_quote"), "get_quote is served by this server, not the host");
});

test("host tool names normalize across Claude Code and OpenCode spellings", () => {
  for (const name of ["WebSearch", "websearch", "WebSearch(*)"]) assert.equal(canonicalTool(name), "websearch");
  for (const name of ["WebFetch", "webfetch"]) assert.equal(canonicalTool(name), "webfetch");
});

test("an explicit denial is blocked", () => {
  withHost({ "home/.claude/settings.json": { permissions: { deny: ["WebSearch"] } } }, (paths) => {
    const result = check(paths);
    assert.equal(result.status, "blocked");
    assert.deepEqual(result.denied, ["websearch"]);
    assert.match(result.message, /complete-looking report with no sources/);
    assert.ok(result.remedy);
  });
});

test("an explicit allowlist entry is ok", () => {
  withHost({ "home/.claude/settings.json": { permissions: { allow: ["WebSearch", "WebFetch"] } } }, (paths) => {
    assert.equal(check(paths).status, "ok");
  });
});

// The regression that motivated the rewrite: a fully permissive machine was reported as
// blocked because its allowlist happened to contain only Bash entries.
test("bypassPermissions is ok even when the allowlist mentions other tools", () => {
  withHost({
    "home/.claude/settings.json": { permissions: { defaultMode: "bypassPermissions", allow: ["Bash(node:*)"] } },
  }, (paths) => {
    const result = check(paths);
    assert.equal(result.status, "ok");
    assert.match(result.message, /bypassPermissions/);
  });
});

test("an unrelated allowlist is unknown, not blocked", () => {
  withHost({
    "home/.claude/settings.local.json": { permissions: { allow: ["Bash(pip3 install:*)", "mcp__something"] } },
  }, (paths) => {
    const result = check(paths);
    assert.equal(result.status, "unknown", "a Bash allowlist says nothing about network access");
    assert.deepEqual(result.missing, ["websearch", "webfetch"]);
    assert.match(result.message, /FOREGROUND session will prompt/);
    assert.match(result.message, /BACKGROUND subagents cannot prompt/);
  });
});

test("no config at all is unknown with the remedy attached", () => {
  withHost({}, (paths) => {
    const result = check(paths);
    assert.equal(result.status, "unknown");
    assert.ok(result.remedy.includes("permissions.allow"));
  });
});

test("OpenCode permission syntax is understood", () => {
  withHost({ "project/opencode.json": { permission: { websearch: "allow", webfetch: "allow" } } }, (paths) => {
    assert.equal(check(paths).status, "ok");
  });
  withHost({ "project/opencode.json": { permission: { websearch: "deny" } } }, (paths) => {
    assert.equal(check(paths).status, "blocked");
  });
});

test("an unreadable config is reported rather than crashing the check", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-bad-"));
  try {
    mkdirSync(join(root, "home", ".claude"), { recursive: true });
    writeFileSync(join(root, "home", ".claude", "settings.json"), "{ not json");
    const result = check({ home: join(root, "home"), cwd: join(root, "project") });
    assert.equal(result.status, "unknown");
    assert.ok(result.checked.some((c) => c.unreadable), "the unreadable file must be reported");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
