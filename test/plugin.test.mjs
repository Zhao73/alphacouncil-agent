// Host mode (Claude Code / Codex) through the MCP server, and the plugin files.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { casePacket, decisionPacket, deskPacket, isolateHome } from "./helpers.mjs";

isolateHome();
process.env.ALPHA_OFFLINE = "1";
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
  const start = await call("research_start", { symbol: "TEST", question: "值得买吗？", host: "claude-code" });
  assert.equal(start.error, false);
  const runId = start.text.match(/run_id: (\S+)/)[1];
  assert.match(start.text, /language: zh-CN/);
  assert.match(start.text, /business, street, news, risk/);

  const brief = await call("research_brief", { run_id: runId, task: "business" });
  assert.match(brief.text, /research_submit/);
  assert.match(brief.text, /"key_numbers"/);
  assert.match((await call("research_brief", { run_id: runId, task: "bull" })).text, /needs at least 2 research desk/);
  assert.match((await call("research_brief", { run_id: runId, task: "nope" })).text, /unknown task/);

  const bad = await call("research_submit", { run_id: runId, task: "business", result: { summary: "x" } });
  assert.equal(bad.error, true);
  assert.match(bad.text, /stance: missing/);

  // Parallel subagents submit at the same time; every result must survive.
  const subs = await Promise.all(["business", "street", "news", "risk"].map((t) => call("research_submit", { run_id: runId, task: t, result: JSON.stringify(deskPacket(t)) })));
  assert.ok(subs.every((s) => !s.error), subs.map((s) => s.text).join("\n"));
  for (const side of ["bull", "bear"]) assert.equal((await call("research_submit", { run_id: runId, task: side, result: casePacket(side) })).error, false);
  const dbrief = await call("research_brief", { run_id: runId, task: "decision" });
  assert.match(dbrief.text, /## Bull/);
  const dec = await call("research_submit", { run_id: runId, task: "decision", result: decisionPacket() });
  assert.deepEqual(JSON.parse(dec.text).remaining, []);
  const fin = JSON.parse((await call("research_finalize", { run_id: runId })).text);
  assert.equal(fin.state, "complete");
  assert.match(fin.summary, /Overweight/);
  const report = await call("research_report", { run: "TEST" });
  assert.match(report.text, /## 多空对决/);
  assert.match((await call("research_submit", { run_id: runId, task: "decision", result: decisionPacket() })).text, /already complete/);
});

test("host fast run finalized with a missing task is degraded or incomplete, never complete", async () => {
  const runId = (await call("research_start", { symbol: "TEST", mode: "fast" })).text.match(/run_id: (\S+)/)[1];
  const fin = JSON.parse((await call("research_finalize", { run_id: runId, reason: "host gave up" })).text);
  assert.equal(fin.state, "incomplete");
});

test("plugin files are wired together", () => {
  const read = (p) => readFileSync(join(root, p), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const cc = JSON.parse(read(".claude-plugin/plugin.json"));
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  const codex = JSON.parse(read(".codex-plugin/plugin.json"));
  for (const v of [cc.version, market.plugins[0].version, codex.version]) assert.equal(v, pkg.version);
  assert.deepEqual(JSON.parse(read(".mcp.json")).mcpServers.alphacouncil.args, ["${CLAUDE_PLUGIN_ROOT}/src/mcp/server.mjs"]);
  assert.deepEqual(codex.mcpServers.alphacouncil.args, ["./src/mcp/server.mjs"]);
  const skill = read("skills/alpha/SKILL.md");
  for (const t of ["research_start", "research_brief", "research_submit", "research_finalize"]) assert.match(skill, new RegExp(`mcp__plugin_alphacouncil_alphacouncil__${t}`));
  assert.match(skill, /alphacouncil:analyst/);
  assert.match(skill, /alphacouncil:advocate/);
  for (const a of ["analyst", "advocate"]) assert.match(read(`agents/${a}.md`), /research_brief[\s\S]*research_submit/);
  // The MCP server must run from a plugin checkout without node_modules.
  const serverImports = read("src/mcp/server.mjs") + read("src/core/pipeline.mjs") + read("src/core/host.mjs");
  assert.doesNotMatch(serverImports, /@anthropic-ai|from "(?!\.|node:)/);
});
