import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../../mcp/server.mjs";

const { taskPrompt } = __test__;

test("worker prompt follows a Chinese request and blocks recursive plugin calls", () => {
  const prompt = taskPrompt("market_data", "NOK", "2026-06-22", "帮我看看 NOK", "auto");
  assert.match(prompt, /不要调用 alphacouncil-agent 插件\/MCP 工具/);
  assert.match(prompt, /字段内容用中文/);
});

test("worker prompt follows a non-Chinese request", () => {
  const prompt = taskPrompt("market_data", "NOK", "2026-06-22", "Can I enter NOK?", "auto");
  assert.match(prompt, /reader-facing fields/);
  assert.match(prompt, /English/);
  assert.doesNotMatch(prompt, /字段内容用中文/);
});

test("quant_factor prompt requests factor evidence and missing-data reporting", () => {
  const prompt = taskPrompt("quant_factor", "NOK", "2026-06-22", "帮我看看 NOK", "auto");
  assert.match(prompt, /量化组合经理/);
  assert.match(prompt, /动能/);
  assert.match(prompt, /open_questions/);
});
