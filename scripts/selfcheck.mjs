import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { __test__ } from "../mcp/server.mjs";

const workerPrompt = __test__.taskPrompt("market_data", "NOK", "2026-06-22", "帮我看看 NOK", "auto");
if (!workerPrompt.includes("不要调用 alphacouncil-agent 插件/MCP 工具") || !workerPrompt.includes("字段内容用中文")) {
  throw new Error("worker prompt must be Chinese and block recursive alphacouncil-agent calls.");
}
const englishPrompt = __test__.taskPrompt("market_data", "NOK", "2026-06-22", "Can I enter NOK?", "auto");
if (!englishPrompt.includes("reader-facing fields") || !englishPrompt.includes("English") || englishPrompt.includes("字段内容用中文")) {
  throw new Error("worker prompt must follow non-Chinese language requests.");
}
const quantPrompt = __test__.taskPrompt("quant_factor", "NOK", "2026-06-22", "帮我看看 NOK", "auto");
if (!quantPrompt.includes("量化组合经理") || !quantPrompt.includes("动能") || !quantPrompt.includes("open_questions")) {
  throw new Error("quant_factor prompt must request factor evidence and missing-data reporting.");
}
if (__test__.resolveLanguage({ prompt: "帮我看看 NOK" }) !== "中文" || __test__.resolveLanguage({ prompt: "Can I enter NOK?" }) !== "English") {
  throw new Error("language inference failed.");
}
const cleaned = __test__.cleanLog(`\u001b[31m${"x".repeat(5000)}`, 20);
if (cleaned.includes("\u001b") || cleaned.length !== 20) {
  throw new Error("cleanLog did not strip ANSI and truncate.");
}
if (__test__.isDryRun({}) || !__test__.isDryRun({ dry_run: true }) || __test__.isDryRun({ dry_run: false })) {
  throw new Error("dry_run default must launch real Codex subagents.");
}
const scoped = __test__.normalizePacket({
  claims: [{ claim: "price", evidence: "source", confidence: "high", source_ids: ["S1"] }],
  sources: [{ id: "S1", title: "Quote", url: "https://example.com" }],
  confidence: "high",
}, "market_data", "NVDA", "2026-06-22", "{}");
if (scoped.sources[0].id !== "market_data:S1" || scoped.claims[0].source_ids[0] !== "market_data:S1") {
  throw new Error("source IDs must be task-scoped.");
}
const manifest = __test__.sourceManifest({ run_id: "TEST", symbol: "NVDA", as_of: "2026-06-22", packets: [scoped] });
if (manifest.source_count !== 1 || manifest.missing_claim_source_ids.length !== 0) {
  throw new Error("source manifest did not preserve scoped sources.");
}

const child = spawn("node", ["./mcp/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "inherit"],
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

const lines = [];
child.stdout.on("data", (chunk) => {
  lines.push(...chunk.toString().trim().split("\n").filter(Boolean));
});

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
send({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: {
    name: "analyze_symbol",
    arguments: { symbol: "NVDA", dry_run: true, tasks: ["market_data", "valuation_long_short"] },
  },
});

await new Promise((resolve) => setTimeout(resolve, 800));
child.kill("SIGTERM");
await once(child, "close");

const responses = lines.map((line) => JSON.parse(line));
if (!responses.some((item) => item.id === 2 && item.result?.tools?.length === 7)) {
  throw new Error("tools/list did not return the expected tools.");
}
const toolsList = responses.find((item) => item.id === 2)?.result?.tools || [];
const analyzeTool = toolsList.find((tool) => tool.name === "analyze_symbol");
if (analyzeTool?.inputSchema?.properties?.dry_run?.default !== false) {
  throw new Error("analyze_symbol dry_run schema default must be false.");
}
if (!analyzeTool?.inputSchema?.properties?.language) {
  throw new Error("analyze_symbol must expose language selection.");
}
if (!analyzeTool?.inputSchema?.properties?.tasks?.items?.enum?.includes("quant_factor")) {
  throw new Error("analyze_symbol must expose quant_factor as a task.");
}
if (!responses.some((item) => item.id === 3 && item.result?.structuredContent?.decision?.verdict === "DRY_RUN")) {
  throw new Error("dry-run analyze_symbol did not return a DRY_RUN decision.");
}
const analysis = responses.find((item) => item.id === 3);
const runId = analysis?.result?.structuredContent?.run?.run_id;
const tracePath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "all_agents.md");
const statusPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "status.json");
const eventsPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "events.jsonl");
const sourceManifestPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "source_manifest.json");
const finalReportPath = join(os.homedir(), ".alphacouncil-agent", "runs", runId, "final_report.md");
if (!existsSync(tracePath)) {
  throw new Error("all_agents.md was not written.");
}
if (!existsSync(statusPath)) {
  throw new Error("status.json was not written.");
}
if (!existsSync(eventsPath)) {
  throw new Error("events.jsonl was not written.");
}
if (!existsSync(sourceManifestPath)) {
  throw new Error("source_manifest.json was not written.");
}
if (!existsSync(finalReportPath)) {
  throw new Error("final_report.md was not written.");
}
const trace = readFileSync(tracePath, "utf8");
if (!trace.includes("Evidence Subagent") || !trace.includes("portfolio_manager")) {
  throw new Error("all_agents.md does not include the expected agent sections.");
}
const finalReport = readFileSync(finalReportPath, "utf8");
if (!finalReport.includes("数据缺口/未覆盖项") && !finalReport.includes("Data Gaps / Unavailable Data")) {
  throw new Error("final_report.md must report data gaps explicitly.");
}
if (!finalReport.includes("分析师工作记录") && !finalReport.includes("Analyst Work Log")) {
  throw new Error("final_report.md must include analyst work log.");
}
if (!finalReport.includes("多空辩论记录") && !finalReport.includes("Bull/Bear Debate Record")) {
  throw new Error("final_report.md must include bull/bear debate record.");
}
const status = JSON.parse(readFileSync(statusPath, "utf8"));
if (status.status !== "complete" || !status.tasks.every((task) => task.status === "completed")) {
  throw new Error("status.json did not record a complete dry run.");
}
const events = readFileSync(eventsPath, "utf8");
if (!events.includes("run_started") || !events.includes("run_complete")) {
  throw new Error("events.jsonl did not record run lifecycle events.");
}

const visible = spawn("node", ["./mcp/server.mjs"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "inherit"],
});
const visibleLines = [];
visible.stdout.on("data", (chunk) => {
  visibleLines.push(...chunk.toString().trim().split("\n").filter(Boolean));
});
function sendVisible(message) {
  visible.stdin.write(`${JSON.stringify(message)}\n`);
}
sendVisible({
  jsonrpc: "2.0",
  id: 10,
  method: "tools/call",
  params: { name: "plan_visible_run", arguments: { symbol: "NOK", run_id: "SELFTEST-VISIBLE", tasks: ["market_data"] } },
});
sendVisible({
  jsonrpc: "2.0",
  id: 11,
  method: "tools/call",
  params: {
    name: "record_visible_packet",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      task: "market_data",
      thread_id: "thread-visible-market",
      thread_title: "AlphaCouncil Agent NOK market_data",
      packet: { summary: "visible packet", claims: [], metrics: {}, sources: [], open_questions: [], confidence: "medium" },
    },
  },
});
sendVisible({
  jsonrpc: "2.0",
  id: 12,
  method: "tools/call",
  params: {
    name: "record_visible_decision",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      role: "portfolio_manager",
      thread_id: "thread-visible-pm",
      thread_title: "AlphaCouncil Agent NOK portfolio_manager",
      packet: { verdict: "VISIBLE_OK", rating: "Hold", winner: "balanced", summary: "visible decision", confidence: "medium", report_markdown: "# Visible OK" },
    },
  },
});
sendVisible({
  jsonrpc: "2.0",
  id: 13,
  method: "tools/call",
  params: {
    name: "record_visible_packet",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      task: "market_data",
      thread_id: "thread-visible-market",
      thread_title: "AlphaCouncil Agent NOK market_data",
      packet: { summary: "late visible packet update", claims: [], metrics: {}, sources: [], open_questions: [], confidence: "medium" },
    },
  },
});
sendVisible({
  jsonrpc: "2.0",
  id: 14,
  method: "tools/call",
  params: {
    name: "record_visible_packet",
    arguments: {
      run_id: "SELFTEST-VISIBLE",
      task: "market_data",
      thread_id: "thread-visible-market",
      thread_title: "AlphaCouncil Agent NOK market_data",
      packet: { summary: "replayed visible packet", claims: [], metrics: {}, sources: [], open_questions: [], confidence: "medium", raw_text: "original visible agent output" },
    },
  },
});
await new Promise((resolve) => setTimeout(resolve, 800));
visible.kill("SIGTERM");
await once(visible, "close");
const visibleResponses = visibleLines.map((line) => JSON.parse(line));
if (!visibleResponses.some((item) => item.id === 12 && item.result?.structuredContent?.decision?.thread_id === "thread-visible-pm")) {
  throw new Error("visible decision was not recorded with thread id.");
}
if (!visibleResponses.some((item) => item.id === 13 && item.result?.structuredContent?.status === "complete")) {
  throw new Error("late visible packet update downgraded a complete run.");
}
if (!visibleResponses.some((item) => item.id === 14 && item.result?.structuredContent?.status === "complete")) {
  throw new Error("replayed visible packet update downgraded a complete run.");
}
const visibleTrace = readFileSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-VISIBLE", "all_agents.md"), "utf8");
if (!visibleTrace.includes("Visible thread ID: thread-visible-market") || !visibleTrace.includes("Visible thread ID: thread-visible-pm")) {
  throw new Error("visible thread ids were not written to all_agents.md.");
}
const visibleStatus = JSON.parse(readFileSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-VISIBLE", "status.json"), "utf8"));
if (visibleStatus.status !== "complete" || visibleStatus.phase !== "complete") {
  throw new Error("late visible packet update did not preserve complete status.");
}
const visiblePacket = JSON.parse(readFileSync(join(os.homedir(), ".alphacouncil-agent", "runs", "SELFTEST-VISIBLE", "market_data.json"), "utf8"));
if (visiblePacket.raw_text !== "original visible agent output") {
  throw new Error("replayed visible packet nested or rewrote raw_text.");
}

console.log("selfcheck passed");
