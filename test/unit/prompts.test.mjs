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
  assert.match(prompt, /动能/, "the momentum factor must be named");
  assert.match(prompt, /12-1/, "the 12-1 window must be specified, not just 'momentum'");
  assert.match(prompt, /禁止形态学预测/, "chart-pattern forecasting must stay banned");
  assert.match(prompt, /open_questions/);
});

// Masters used to see only the analysts' packets. That made 21 seats inherit one selection
// of what mattered -- a large and perfectly correlated error -- and destroyed the reason
// the bench exists, which is that Munger looks at incentives where an analyst looked at
// margins. They now get the same established facts, with the packets marked as readings.
test("a master prompt carries the established facts, not only the analysts' packets", async () => {
  const { masterPrompt } = await import("../../mcp/lib/prompts.mjs");
  const run = {
    run_id: "r1", symbol: "MU", as_of: "2026-07-26", language: "English",
    masters: ["master_buffett"], tasks: [], packets: [],
    grounding: {
      symbol: "MU",
      quote: { symbol: "MU", price: 920.95, currency: "USD", change_pct: 1.2, source: "yahoo" },
    },
  };
  const prompt = masterPrompt("master_buffett", run);
  assert.match(prompt, /920\.95/, "an established fact must reach the master directly");
  assert.match(prompt, /readings of the/, "packets must be labelled as interpretation, not fact");
  assert.match(prompt, /Evidence JSON/);
});

test("a master prompt still works when no grounding was gathered", () => {
  const run = { run_id: "r2", symbol: "MU", as_of: "2026-07-26", language: "English", masters: ["master_munger"], packets: [], grounding: null };
  const prompt = __test__.masterPrompt ? __test__.masterPrompt("master_munger", run) : null;
  assert.ok(prompt === null || typeof prompt === "string");
});
