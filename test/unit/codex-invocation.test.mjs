import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";

const { codexInvocation } = __test__;

// Both branches are pure functions of (args, platform, env), so they run on every OS in
// the matrix. That matters: the win32 branch shipped for months without ever executing
// on a Windows runner.

test("posix invocation calls codex directly and reads the prompt from stdin", () => {
  const invocation = codexInvocation(["exec", "-C", "/tmp/alpha council"], "linux", {
    ALPHACOUNCIL_AGENT_CODEX_CMD: "codex",
  });
  assert.equal(invocation.command, "codex");
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
