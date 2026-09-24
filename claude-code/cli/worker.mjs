// One council task = one headless Claude Code process (`claude -p`). The worker gets its seat's
// agent definition as system prompt, the task prompt (with its briefing inline), web tools for
// evidence seats, and this package's MCP server for data + council_record. Packets land on disk
// through council_record; the process result is only telemetry.

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAgent } from "../lib/agents.mjs";
import { ALL_TOOLS } from "../lib/tools.mjs";
import { homeDir, runDir } from "../lib/store.mjs";

const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const MCP_NAME = "alphacouncil";

export function claudeBin() {
  return process.env.ALPHACOUNCIL_CLAUDE_BIN || "claude";
}

export function workerArgs(task, { model, budgetUsd = null } = {}) {
  const agent = loadAgent(task.agent);
  const evidence = task.stage === "evidence";
  const mcpTools = ALL_TOOLS.map((t) => `mcp__${MCP_NAME}__${t.name}`);
  const mcpConfig = { mcpServers: { [MCP_NAME]: { command: process.execPath, args: [SERVER], env: { ALPHACOUNCIL_HOME: homeDir() } } } };
  // The prompt itself goes over stdin: a PM briefing can exceed Windows' 32K command line.
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--system-prompt", `${agent.body}\n\nYou are running as a headless AlphaCouncil worker. Your full instructions and briefing are in the user message; do not call council_brief.`,
    "--model", model,
    "--mcp-config", JSON.stringify(mcpConfig),
    "--strict-mcp-config",
    "--tools", evidence ? "WebSearch,WebFetch" : "",
    "--allowedTools", [...(evidence ? ["WebSearch", "WebFetch"] : []), ...mcpTools].join(","),
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  if (budgetUsd) args.push("--max-budget-usd", String(budgetUsd));
  return args;
}

function summarizeToolUse(block) {
  const input = block.input || {};
  const name = String(block.name || "").replace(`mcp__${MCP_NAME}__`, "");
  const detail = input.query || input.url || input.symbol || input.role || "";
  return `${name}${detail ? ` ${String(detail).slice(0, 60)}` : ""}`;
}

/**
 * Run one task. Resolves (never rejects) with { ok, costUsd, turns, tools, error, reply }.
 * onActivity receives short strings like "WebSearch nvidia guidance".
 */
export function runWorker(task, { model, budgetUsd, onActivity = () => {}, signal } = {}) {
  return new Promise((resolve) => {
    const cwd = runDir(task.run_id);
    mkdirSync(cwd, { recursive: true });
    let child;
    try {
      const bin = claudeBin();
      const args = workerArgs(task, { model, budgetUsd });
      // A path to Claude Code's cli.js (e.g. an npm install on Windows) runs through node.
      child = /\.(c|m)?js$/.test(bin)
        ? spawn(process.execPath, [bin, ...args], { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(bin, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      child.stdin.end(task.prompt);
    } catch (error) {
      resolve({ ok: false, error: `could not start claude: ${error.message}`, tools: 0 });
      return;
    }
    const state = { tools: 0, costUsd: 0, turns: 0, reply: "", error: null };
    let buf = "";
    let stderr = "";
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({ ...state, ...extra });
    };
    const kill = (why) => {
      state.error = why;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    };
    const timer = setTimeout(() => kill(`timed out after ${Math.round(task.timeout_ms / 1000)}s`), task.timeout_ms);
    const onAbort = () => kill("stopped");
    signal?.addEventListener?.("abort", onAbort);

    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "assistant") {
          for (const block of ev.message?.content || []) {
            if (block.type === "tool_use") {
              state.tools += 1;
              onActivity(summarizeToolUse(block));
            }
          }
        } else if (ev.type === "result") {
          state.costUsd = ev.total_cost_usd || 0;
          state.turns = ev.num_turns || 0;
          state.reply = String(ev.result || "").trim().slice(0, 300);
          if (ev.is_error || ev.subtype !== "success") state.error ||= ev.subtype || "worker error";
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.on("error", (error) => finish({ ok: false, error: error.code === "ENOENT" ? `\`${claudeBin()}\` not found — install Claude Code` : error.message }));
    child.on("close", (code) => {
      const ok = code === 0 && !state.error;
      finish({ ok, error: ok ? null : state.error || `exit ${code}${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}` });
    });
  });
}
