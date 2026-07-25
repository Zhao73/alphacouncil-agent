import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, repoFile } from "../helpers/paths.mjs";
import { registry } from "../../mcp/lib/personas/registry.mjs";

/**
 * Shapes verified against a real opencode 1.18.4 install:
 *   `opencode mcp list`                     -> alphacouncil-agent connected
 *   `opencode debug agent alphacouncil-...` -> parsed, model and permissions resolved
 */
const config = JSON.parse(readFileSync(repoFile("opencode.json"), "utf8"));

test("the MCP entry uses OpenCode's shape, not Claude Code's", () => {
  const server = config.mcp["alphacouncil-agent"];
  assert.equal(server.type, "local");
  // OpenCode takes one argv array. Claude Code takes {command, args}; copying that shape
  // over silently produces a server that never starts.
  assert.ok(Array.isArray(server.command), "command must be an argv array");
  assert.deepEqual(server.command, ["node", "./mcp/server.mjs"]);
  assert.ok(!("args" in server), "args is the Claude Code shape and is ignored here");
  assert.ok(!("env" in server), "OpenCode spells this `environment`");
});

// A global permission block is merged into every agent and overrides the per-agent one,
// which would silently hand the debate roles network access they must not have.
test("opencode.json declares no global permission block", () => {
  assert.ok(!("permission" in config), "a global permission block overrides every agent");
});

test("the config only uses keys OpenCode actually accepts", () => {
  const allowed = new Set(["$schema", "mcp", "instructions", "skills", "agent", "command", "permission", "plugin", "model"]);
  for (const key of Object.keys(config)) {
    assert.ok(allowed.has(key), `unknown opencode.json key: ${key}`);
  }
  assert.equal(config.$schema, "https://opencode.ai/config.json");
});

test("every evidence and debate persona has a generated OpenCode agent", () => {
  const reg = registry();
  const expected = [...reg.ids("analyst"), ...reg.ids("debate")].map((id) => `alphacouncil-${id}.md`).sort();
  const actual = readdirSync(repoFile(".opencode/agent")).filter((f) => f.startsWith("alphacouncil-")).sort();
  assert.deepEqual(actual, expected);
});

test("OpenCode agents use provider/model ids and subagent mode", () => {
  for (const file of readdirSync(repoFile(".opencode/agent"))) {
    const text = readFileSync(join(repoFile(".opencode/agent"), file), "utf8");
    assert.match(text, /^---\n/, `${file} needs frontmatter`);
    assert.match(text, /^description: /m, `${file} must declare a description -- OpenCode requires it`);
    assert.match(text, /^mode: subagent$/m, `${file} must be a subagent`);
    // Bare aliases like "opus" are Claude Code's form and do not resolve here.
    assert.match(text, /^model: [a-z0-9-]+\/[a-z0-9.-]+$/m, `${file} must use provider/model`);
  }
});

test("only the roles that gather evidence are granted the network", () => {
  const reg = registry();
  for (const id of [...reg.ids("analyst"), ...reg.ids("debate")]) {
    const text = readFileSync(repoFile(`.opencode/agent/alphacouncil-${id}.md`), "utf8");
    const wantsSearch = reg.get(id).tools_hint.includes("websearch");
    assert.match(
      text,
      new RegExp(`^  websearch: ${wantsSearch ? "allow" : "deny"}$`, "m"),
      `${id} websearch permission does not match its tools_hint`,
    );
    assert.match(text, /^  edit: deny$/m, `${id} must never edit files`);
    assert.match(text, /^  bash: deny$/m, `${id} must never run shell commands`);
  }
});

test("the Claude Code and OpenCode agent sets stay in step", () => {
  const claude = readdirSync(repoFile(".claude/agents")).filter((f) => f.startsWith("alphacouncil-")).sort();
  const opencode = readdirSync(repoFile(".opencode/agent")).filter((f) => f.startsWith("alphacouncil-")).sort();
  assert.deepEqual(opencode, claude, "both hosts must expose the same roles");
});

test("the MCP entry point the config names actually exists", () => {
  assert.ok(existsSync(join(repoRoot, "mcp", "server.mjs")));
});
