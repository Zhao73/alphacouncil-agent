// The plugin surface and the terminal client: MCP protocol, agent files, CLI end to end.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fakeGrounding, isolateHome } from "./helpers.mjs";

const home = isolateHome();
const root = fileURLToPath(new URL("..", import.meta.url));
const { handle } = await import("../mcp/server.mjs");
const { EVIDENCE_ROLES, DEBATE_ROLES, PM_ROLE, agentName } = await import("../lib/spec.mjs");
const { loadAgent } = await import("../lib/agents.mjs");
const council = await import("../lib/council.mjs");
const { renderDashboard } = await import("../cli/dashboard.mjs");
const { createView } = await import("../cli/orchestrate.mjs");
const { workerArgs } = await import("../cli/worker.mjs");
const { width, renderMarkdown } = await import("../cli/term.mjs");

const call = async (name, args) => {
  const r = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { ...r, text: r.content[0].text };
};

test("MCP: initialize, tools/list, unknown method", async () => {
  const init = await handle({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.protocolVersion, "2025-03-26");
  const { tools } = await handle({ id: 2, method: "tools/list" });
  const names = tools.map((t) => t.name);
  for (const n of ["quote", "fundamentals", "council_plan", "council_start", "council_next", "council_brief", "council_record", "council_finalize"]) assert.ok(names.includes(n), n);
  for (const t of tools) assert.equal(t.inputSchema.type, "object");
  await assert.rejects(handle({ id: 3, method: "bogus" }), /method not found/);
  assert.equal(await handle({ method: "notifications/initialized" }), undefined);
});

test("MCP: council_start refuses a plan_id that does not match the confirmed settings", async () => {
  const plan = JSON.parse((await call("council_plan", { symbol: "TEST", mode: "quick" })).text);
  assert.equal(plan.evidence_roles.length, 4);
  const bad = await call("council_start", { symbol: "TEST", mode: "full", plan_id: plan.plan_id });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /plan_id does not match/);
});

test("MCP: council_next hands out short prompts; council_brief returns full instructions + role guide", async () => {
  const { run } = await council.startCouncil({ symbol: "TEST", mode: "quick", grounding: fakeGrounding() });
  const next = JSON.parse((await call("council_next", { run_id: run.run_id })).text);
  assert.equal(next.tasks.length, 4);
  const t = next.tasks[0];
  assert.match(t.subagent, /^alphacouncil:[a-z-]+$/);
  assert.ok(t.prompt.length < 400, "hand-off prompt stays short");
  const taskId = t.prompt.match(/task_id: (\S+)\./)[1];
  const brief = await call("council_brief", { run_id: run.run_id, task_id: taskId });
  assert.match(brief.text, /Frozen grounding facts/);
  assert.match(brief.text, /Role guide/);
  const rec = await call("council_record", { run_id: run.run_id, role: "market_data", stage: "evidence", packet: { summary: "short" } });
  assert.equal(rec.isError, true);
  assert.match(rec.text, /errors/);
});

test("every seat has an agent file with the plugin frontmatter and protocol", () => {
  const roles = [...Object.keys(EVIDENCE_ROLES), ...Object.keys(DEBATE_ROLES), ...Object.keys(PM_ROLE)];
  const files = readdirSync(join(root, "agents")).map((f) => f.replace(/\.md$/, "")).sort();
  assert.deepEqual(files, roles.map(agentName).sort());
  for (const role of roles) {
    const a = loadAgent(agentName(role));
    assert.equal(a.meta.name, agentName(role));
    assert.ok(a.meta.description.length > 40);
    assert.match(a.meta.disallowedTools, /Write/);
    assert.match(a.body, /council_record/);
    assert.match(a.body, /council_brief/);
  }
});

test("plugin manifest, MCP config and skill are wired together", () => {
  const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(plugin.name, "alphacouncil");
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.alphacouncil.args, ["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"]);
  const skill = readFileSync(join(root, "skills", "alpha", "SKILL.md"), "utf8");
  for (const tool of ["council_plan", "council_start", "council_next", "council_finalize"]) assert.match(skill, new RegExp(`mcp__plugin_alphacouncil_alphacouncil__${tool}`));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.version, plugin.version);
});

test("worker args: evidence gets web tools, debate gets none, MCP tools pre-allowed", () => {
  const ev = workerArgs({ agent: "market-data", stage: "evidence", prompt: "p" }, { model: "sonnet" });
  const db = workerArgs({ agent: "bull-researcher", stage: "debate", prompt: "p" }, { model: "sonnet" });
  const val = (args, flag) => args[args.indexOf(flag) + 1];
  assert.equal(val(ev, "--tools"), "WebSearch,WebFetch");
  assert.equal(val(db, "--tools"), "");
  assert.match(val(ev, "--allowedTools"), /mcp__alphacouncil__council_record/);
  assert.doesNotMatch(val(db, "--allowedTools"), /WebSearch/);
  assert.equal(val(ev, "--permission-mode"), "dontAsk");
  assert.ok(ev.includes("--strict-mcp-config"));
  assert.equal(JSON.parse(val(ev, "--mcp-config")).mcpServers.alphacouncil.env.ALPHACOUNCIL_HOME, home);
});

function cli(args, env = {}) {
  return spawnSync(process.execPath, [join(root, "cli", "alphacouncil.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ALPHACOUNCIL_HOME: home, ALPHACOUNCIL_CLAUDE_BIN: join(root, "test", "fake-claude.mjs"), NO_COLOR: "1", ...env },
    timeout: 60000,
  });
}

test("CLI: resume drives a full run to a degraded report with a repaired-then-failed seat", async () => {
  const { run } = await council.startCouncil({ symbol: "TEST", grounding: fakeGrounding(), executor: "terminal", enforceDeadline: true });
  const r = cli(["resume", run.run_id, "--plain"], { FAKE_CLAUDE_FAIL: "ib_event_analysis" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DEGRADED/);
  assert.match(r.stdout, /ib_event_analysis ✗/);
  const status = council.councilStatus(run.run_id);
  assert.equal(status.state, "degraded");
  assert.equal(status.slots.find((s) => s.slot === "evidence/ib_event_analysis").attempts, 2);
  const runs = cli(["runs"]);
  assert.match(runs.stdout, new RegExp(run.run_id));
  const show = cli(["show", run.run_id, "--raw"]);
  assert.match(show.stdout, /## Bull \/ Bear debate record/);
});

test("CLI: a hung worker is killed at the deadline and the run ends incomplete", async () => {
  const { run } = await council.startCouncil({ symbol: "TEST", mode: "quick", grounding: fakeGrounding(), executor: "terminal", enforceDeadline: true });
  const path = join(home, "runs", run.run_id, "run.json");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.deadline_at = new Date(Date.now() + 27_000).toISOString(); // leaves ~12s per task after the reserve
  const { writeJson } = await import("../lib/store.mjs");
  writeJson(path, doc);
  const t0 = Date.now();
  const r = cli(["resume", run.run_id, "--plain"], { FAKE_CLAUDE_HANG: "market_data" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 40_000);
  assert.match(r.stdout, /timed out/);
  assert.match(r.stdout, /INCOMPLETE/);
});

test("CLI: help, version and a refusal to start unconfirmed without a TTY", () => {
  assert.match(cli(["--help"]).stdout, /alphacouncil resume/);
  assert.match(cli(["--version"]).stdout, /^\d+\.\d+\.\d+/);
  const r = cli(["TEST", "--quick"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--yes/);
});

test("terminal rendering: CJK width and dashboard frame", async () => {
  assert.equal(width("行情ab"), 6);
  assert.match(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |", 60), /│ 1 │ 2 │/);
  const { run } = await council.startCouncil({ symbol: "TEST", grounding: fakeGrounding(), language: "zh-CN" });
  const frame = renderDashboard(createView(run.run_id), { cols: 100, rows: 30 });
  assert.match(frame, /EVIDENCE 0\/8/);
  assert.match(frame, /行情数据/);
  assert.match(frame, /R3/);
});
