// Host mode (Claude Code / Codex) through the MCP server, and the plugin files.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { casePacket, decisionPacket, deskPacket, isolateHome } from "./helpers.mjs";

isolateHome();
process.env.VERDICT_OFFLINE = "1";
const root = fileURLToPath(new URL("..", import.meta.url));
const { handle, TOOLS } = await import("../src/mcp/server.mjs");

async function call(name, args) {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { error: Boolean(r.isError), text: r.content[0].text };
}

test("MCP protocol basics", async () => {
  const init = await handle({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.protocolVersion, "2025-03-26");
  const { tools } = await handle({ id: 2, method: "tools/list" });
  assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.equal(await handle({ method: "notifications/initialized" }), undefined);
  await assert.rejects(handle({ id: 3, method: "nope" }), /method not found/);
});

test("host deep run: start → desks (concurrent) → debate → decision → finalize", async () => {
  const start = await call("verdict_start", { symbol: "TEST", question: "值得买吗？", host: "claude-code" });
  assert.equal(start.error, false);
  const runId = start.text.match(/run_id: (\S+)/)[1];
  assert.match(start.text, /language: zh-CN/);
  assert.match(start.text, /business, street, news, risk/);

  const brief = await call("verdict_task", { run_id: runId, task: "business" });
  assert.match(brief.text, /verdict_submit/);
  assert.match(brief.text, /"key_numbers"/);
  assert.match((await call("verdict_task", { run_id: runId, task: "bull" })).text, /needs at least 2 research desk/);
  assert.match((await call("verdict_task", { run_id: runId, task: "nope" })).text, /unknown task/);

  const bad = await call("verdict_submit", { run_id: runId, task: "business", result: { summary: "x" } });
  assert.equal(bad.error, true);
  assert.match(bad.text, /stance: missing/);

  // Parallel subagents submit at the same time; every result must survive.
  const subs = await Promise.all(["business", "street", "news", "risk"].map((t) => call("verdict_submit", { run_id: runId, task: t, result: JSON.stringify(deskPacket(t)) })));
  assert.ok(subs.every((s) => !s.error), subs.map((s) => s.text).join("\n"));
  for (const side of ["bull", "bear"]) assert.equal((await call("verdict_submit", { run_id: runId, task: side, result: casePacket(side) })).error, false);
  const dbrief = await call("verdict_task", { run_id: runId, task: "decision" });
  assert.match(dbrief.text, /## Bull/);
  const dec = await call("verdict_submit", { run_id: runId, task: "decision", result: decisionPacket() });
  assert.deepEqual(JSON.parse(dec.text).remaining, []);
  const fin = JSON.parse((await call("verdict_finish", { run_id: runId })).text);
  assert.equal(fin.state, "complete");
  assert.match(fin.summary, /Overweight/);
  const report = await call("verdict_report", { run: "TEST" });
  assert.match(report.text, /## 多空论证/);
  assert.match((await call("verdict_submit", { run_id: runId, task: "decision", result: decisionPacket() })).text, /already complete/);
});

test("host fast run finalized with a missing task is degraded or incomplete, never complete", async () => {
  const runId = (await call("verdict_start", { symbol: "TEST", mode: "fast" })).text.match(/run_id: (\S+)/)[1];
  const fin = JSON.parse((await call("verdict_finish", { run_id: runId, reason: "host gave up" })).text);
  assert.equal(fin.state, "incomplete");
});

test("plugin files are wired together", () => {
  const read = (p) => readFileSync(join(root, p), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const cc = JSON.parse(read(".claude-plugin/plugin.json"));
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  const codex = JSON.parse(read(".codex-plugin/plugin.json"));
  for (const v of [cc.version, market.plugins[0].version, codex.version]) assert.equal(v, pkg.version);
  assert.deepEqual(JSON.parse(read(".mcp.json")).mcpServers.verdict.args, ["${CLAUDE_PLUGIN_ROOT}/src/mcp/server.mjs"]);
  assert.deepEqual(codex.mcpServers.verdict.args, ["./src/mcp/server.mjs"]);
  const skill = read("skills/verdict/SKILL.md");
  for (const t of ["verdict_start", "verdict_task", "verdict_submit", "verdict_finish"]) assert.match(skill, new RegExp(`mcp__plugin_verdict_verdict__${t}`));
  assert.match(skill, /verdict:desk/);
  assert.match(skill, /verdict:advocate/);
  for (const a of ["desk", "advocate"]) assert.match(read(`agents/${a}.md`), /verdict_task[\s\S]*verdict_submit/);
  // The MCP server must run from a plugin checkout without node_modules.
  const serverImports = ["src/mcp/server.mjs", "src/engine/pipeline.mjs", "src/engine/host.mjs", "src/engine/watch.mjs", "src/render/html.mjs", "src/render/markdown.mjs", "src/demo.mjs"].map(read).join("\n");
  assert.doesNotMatch(serverImports, /@anthropic-ai|from "(?!\.|node:)/);
});
