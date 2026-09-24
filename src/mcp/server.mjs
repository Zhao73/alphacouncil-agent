#!/usr/bin/env node
// AlphaCouncil MCP server for Claude Code and Codex: newline-delimited JSON-RPC over stdio,
// no dependencies (plugins run straight from a git checkout without `npm install`).

import { readFileSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as data from "../core/data.mjs";
import { finalizeHostRun, briefTask, startHostRun, submitTask } from "../core/host.mjs";
import { detectLanguage, normalizeLanguage } from "../core/i18n.mjs";
import { reportPath } from "../core/pipeline.mjs";
import { snapshotBrief, buildSnapshot } from "../core/snapshot.mjs";
import { listRuns, resolveRun } from "../core/store.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const sym = { type: "string", description: "Ticker, e.g. NVDA, AAPL, 0700.HK, 7203.T, SPY, ^GSPC" };
const runId = { type: "string", description: "run_id from research_start" };

export const TOOLS = [
  {
    name: "research_start",
    description: "Start research on a stock/ETF/index: fetches a live data snapshot (price, fundamentals, technicals, options, dated news, method lenses) in seconds and returns the run_id and the task list. mode deep (default): 4 research desks, bull and bear, decision. mode fast: 1 research task, decision.",
    inputSchema: { type: "object", properties: { symbol: sym, mode: { type: "string", enum: ["deep", "fast"] }, language: { type: "string", description: "language of the user's request, e.g. en, zh-CN, ja" }, question: { type: "string", description: "the user's question, if any" }, host: { type: "string", description: "claude-code or codex" } }, required: ["symbol"] },
    handler: async ({ symbol, mode = "deep", language, question = "", host = "host" }) => {
      const run = await startHostRun({ symbol, mode, language: normalizeLanguage(language || detectLanguage(question)), question, host });
      const tasks = Object.keys(run.desks);
      return [
        `run_id: ${run.run_id}`,
        `mode: ${mode} · language: ${run.language} · snapshot in ${(run.snapshot.elapsed_ms / 1000).toFixed(1)}s`,
        "",
        "## Snapshot",
        snapshotBrief(run.snapshot),
        "",
        "## Tasks",
        `1. research (in parallel if you can): ${tasks.join(", ")}`,
        mode === "deep" ? "2. debate (in parallel if you can): bull, bear" : null,
        `${mode === "deep" ? 3 : 2}. decision`,
        `${mode === "deep" ? 4 : 3}. research_finalize`,
        "For each task: research_brief(run_id, task) → do the work → research_submit(run_id, task, result).",
      ].filter((x) => x !== null).join("\n");
    },
  },
  {
    name: "research_brief",
    description: "Exact instructions, inputs and the JSON result schema for one task of a run (a desk id, bull, bear or decision).",
    inputSchema: { type: "object", properties: { run_id: runId, task: { type: "string" } }, required: ["run_id", "task"] },
    handler: ({ run_id: id, task }) => briefTask(id, task),
  },
  {
    name: "research_submit",
    description: "Submit a task result. Validates it against the schema and the run's sources; returns ok plus the remaining tasks, or errors to fix and resubmit.",
    inputSchema: { type: "object", properties: { run_id: runId, task: { type: "string" }, result: { type: "object", description: "result object matching the schema from research_brief" } }, required: ["run_id", "task", "result"] },
    handler: ({ run_id: id, task, result }) => submitTask(id, task, result),
  },
  {
    name: "research_finalize",
    description: "Close the run: writes report.md and returns a summary to show the user. Tasks never submitted are recorded as failed.",
    inputSchema: { type: "object", properties: { run_id: runId, reason: { type: "string" } }, required: ["run_id"] },
    handler: ({ run_id: id, reason }) => finalizeHostRun(id, { reason }),
  },
  {
    name: "research_report",
    description: "Read a saved report (default: latest; or a run_id or ticker) to answer follow-up questions without researching again.",
    inputSchema: { type: "object", properties: { run: { type: "string", description: "run_id, ticker or 'latest'" } } },
    handler: ({ run }) => readFileSync(reportPath(resolveRun(run || "latest")), "utf8"),
  },
  {
    name: "research_runs",
    description: "List saved research runs, newest first.",
    inputSchema: { type: "object", properties: {} },
    handler: () => listRuns().slice(0, 25),
  },
  {
    name: "snapshot",
    description: "Live data snapshot only (no model work): quote, technicals, SEC fundamentals and multiples, filings, options, dated news, method lenses.",
    inputSchema: { type: "object", properties: { symbol: sym }, required: ["symbol"] },
    handler: async ({ symbol }) => snapshotBrief(await buildSnapshot(symbol)),
  },
  {
    name: "quote",
    description: "Delayed quote with day change, 52-week range and dividend yield.",
    inputSchema: { type: "object", properties: { symbol: sym }, required: ["symbol"] },
    handler: ({ symbol }) => data.getQuote(symbol),
  },
  {
    name: "news",
    description: "Dated headlines (Google News) within a window of up to 120 days.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, days: { type: "number" } }, required: ["query"] },
    handler: ({ query, days }) => data.getNews(query, { days: Math.min(Number(days) || 30, 120) }),
  },
  {
    name: "filings",
    description: "Recent SEC filings with links (US filers).",
    inputSchema: { type: "object", properties: { symbol: sym, forms: { type: "array", items: { type: "string" } } }, required: ["symbol"] },
    handler: ({ symbol, forms }) => data.getFilings(symbol, { forms, limit: 20 }),
  },
  {
    name: "options",
    description: "US listed options: put/call ratios, ATM implied-vol term structure, 25-delta skew.",
    inputSchema: { type: "object", properties: { symbol: sym }, required: ["symbol"] },
    handler: ({ symbol }) => data.getOptions(symbol),
  },
  {
    name: "macro",
    description: "Rates, curve, CPI, VIX, credit spread and USD from FRED.",
    inputSchema: { type: "object", properties: {} },
    handler: () => data.getMacro(),
  },
];

const text = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 1);
  return s.length > 150_000 ? `${s.slice(0, 150_000)}\n…[truncated]` : s;
};

export async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return {
      protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "alphacouncil", version: VERSION },
      instructions: "Equity research: research_start → research_brief/research_submit per task → research_finalize. Data tools cost no model calls.",
    };
  }
  if (method === "ping") return {};
  if (method === "tools/list") return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  if (method === "tools/call") {
    const tool = TOOLS.find((x) => x.name === params?.name);
    if (!tool) return { content: [{ type: "text", text: `Error: unknown tool ${params?.name}` }], isError: true };
    try {
      const result = await tool.handler(params.arguments || {});
      return { content: [{ type: "text", text: text(result) }], ...(result && result.ok === false ? { isError: true } : {}) };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  }
  if (id === undefined) return undefined;
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

function serve() {
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const inflight = new Set();
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const job = (async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      }
      try {
        const result = await handle(msg);
        if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
      } catch (error) {
        if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: error.code || -32603, message: error.message } });
      }
      return undefined;
    })().finally(() => inflight.delete(job));
    inflight.add(job);
  });
  rl.on("close", () => Promise.allSettled([...inflight]).then(() => process.exit(0)));
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) serve();
