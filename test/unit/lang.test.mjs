import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";

const { resolveLanguage, cleanLog, isDryRun } = __test__;

const ESC = String.fromCharCode(27);

test("language is inferred from the user prompt", () => {
  assert.equal(resolveLanguage({ prompt: "帮我看看 NOK" }), "中文");
  assert.equal(resolveLanguage({ prompt: "Can I enter NOK?" }), "English");
});

test("cleanLog strips ANSI escapes and truncates", () => {
  const cleaned = cleanLog(`${ESC}[31m${"x".repeat(5000)}`, 20);
  assert.ok(!cleaned.includes(ESC), "ANSI escapes must be stripped");
  assert.equal(cleaned.length, 20);
});

test("dry_run defaults to false so real subagents launch", () => {
  assert.equal(isDryRun({}), false);
  assert.equal(isDryRun({ dry_run: true }), true);
  assert.equal(isDryRun({ dry_run: false }), false);
});
