import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";
import * as codexWorker from "../../mcp/lib/codex.mjs";

const { codexInvocation } = __test__;

// Both branches are pure functions of (args, platform, env), so they run on every OS in
// the matrix. That matters: the win32 branch shipped for months without ever executing
// on a Windows runner.

test("posix invocation calls codex directly and reads the prompt from stdin", () => {
  const invocation = codexInvocation(["exec", "-C", "/tmp/alpha council"], "linux", {
    ALPHACOUNCIL_AGENT_CODEX_CMD: "/opt/fixture/bin/codex",
  });
  assert.equal(invocation.command, "/opt/fixture/bin/codex");
  assert.equal(invocation.args.at(-1), "-");
  assert.equal(invocation.options.detached, true);
});

test("windows invocation goes through cmd.exe so codex.cmd resolves", () => {
  const invocation = codexInvocation(["exec", "-C", "C:\\Users\\Example User\\.alphacouncil-agent"], "win32", {
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    ALPHACOUNCIL_AGENT_CODEX_CMD: "codex",
  });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(invocation.args.slice(0, 3).join(" "), "/d /s /c");
  assert.ok(
    invocation.args[3].includes("\"C:\\Users\\Example User\\.alphacouncil-agent\""),
    "spaced paths must be quoted",
  );
  assert.ok(invocation.args[3].endsWith(" -"), "prompt must still be read from stdin");
});

test("leaf Codex workers ignore user plugins while retaining native web search", () => {
  assert.equal(typeof codexWorker.codexWorkerArgs, "function");
  const args = codexWorker.codexWorkerArgs("/tmp/worker-output.json", "/tmp/alpha-data");
  assert.ok(args.includes("--search"), "native live web search must remain available");
  assert.ok(args.includes("--ignore-user-config"), "global plugins and MCP servers must not reach leaf workers");
  assert.equal(args.filter((arg) => arg === "--ignore-user-config").length, 1);
  assert.ok(
    args.indexOf("--ignore-user-config") > args.indexOf("exec"),
    "--ignore-user-config is an exec-only flag and must follow the exec subcommand",
  );
});

test("frozen-fact and parse-repair workers can explicitly omit native search", () => {
  const args = codexWorker.codexWorkerArgs("/tmp/worker-output.json", "/tmp/alpha-data", { search: false });
  assert.equal(args.includes("--search"), false);
  assert.ok(args.includes("--ignore-user-config"));
  assert.equal(args.at(-1), "/tmp/worker-output.json");
  assert.equal(args.includes("exec"), true);
});
