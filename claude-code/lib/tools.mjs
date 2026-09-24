// Tool definitions shared by the MCP server and the terminal client's API engine.

import { createHash } from "node:crypto";
import * as council from "./council.mjs";
import * as data from "./data.mjs";
import { evaluateLenses, LENS_IDS } from "./lenses.mjs";
import { listRuns, resolveRunId, runDir } from "./store.mjs";
import { loadAgent } from "./agents.mjs";
import { agentName } from "./spec.mjs";

const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const symbol = str("Ticker, e.g. AAPL, 0700.HK, 7203.T, SPY, ^GSPC");
const runId = str("Run ID returned by council_start");
const modeProp = { type: "string", enum: ["full", "quick"], description: "full (default): 8 analysts, 3 debate rounds. quick: 4 analysts, 1 round." };
const paceProp = { type: "string", enum: ["fast", "normal", "slow"], description: "Full-mode depth: fast (15 min), normal (30), slow (60). Ignored for quick." };
const langProp = str("Language for all prose, e.g. en, zh-CN, ja. Default en.");
const lensesProp = { description: `"all" or a list of lens IDs: ${LENS_IDS.join(", ")}`, anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };

export function planId(plan) {
  const key = JSON.stringify([plan.symbol, plan.mode, plan.pace, plan.language, plan.lenses]);
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export const DATA_TOOLS = [
  {
    name: "instrument_lookup",
    description: "Classify a symbol (company, ETF/fund or index), its exchange and SEC CIK. Decides the research route.",
    inputSchema: { type: "object", properties: { symbol }, required: ["symbol"] },
    handler: ({ symbol: s }) => data.resolveInstrument(s),
  },
  {
    name: "quote",
    description: "Delayed quote: price, currency, day change, 52-week range, trailing dividend yield. Keyless.",
    inputSchema: { type: "object", properties: { symbol }, required: ["symbol"] },
    handler: ({ symbol: s }) => data.getQuote(s),
  },
  {
    name: "price_history",
    description: "Daily history summarized into positional technicals: returns (1w-12m), 12-1 momentum, SMA50/200, RSI14, realized vol, drawdown, volume ratio.",
    inputSchema: { type: "object", properties: { symbol, range: { type: "string", enum: ["6mo", "1y", "2y", "5y"], description: "default 2y" } }, required: ["symbol"] },
    handler: ({ symbol: s, range }) => data.getHistory(s, range || "2y"),
  },
  {
    name: "fundamentals",
    description: "US filers: SEC XBRL company facts as TTM metrics, 5-year annual series, margins, growth, balance sheet and valuation multiples at the current price. Returns available=false with a reason for funds, indices and non-SEC filers.",
    inputSchema: { type: "object", properties: { symbol }, required: ["symbol"] },
    handler: async ({ symbol: s }) => {
      const q = await data.getQuote(s).catch(() => null);
      return data.getFundamentals(s, { price: q?.price, currency: q?.currency || "USD" });
    },
  },
  {
    name: "filings",
    description: "Recent SEC filings with direct document links (10-K, 10-Q, 8-K, 4, SC 13D/G, DEF 14A, S-1...).",
    inputSchema: { type: "object", properties: { symbol, forms: { type: "array", items: { type: "string" }, description: "Filter, e.g. [\"8-K\",\"4\"]" }, limit: { type: "number", description: "default 15, max 40" } }, required: ["symbol"] },
    handler: ({ symbol: s, forms, limit }) => data.getFilings(s, { forms, limit: Math.min(Number(limit) || 15, 40) }),
  },
  {
    name: "news",
    description: "Dated headlines from Google News RSS within a window. Undated or out-of-window items are excluded and counted.",
    inputSchema: { type: "object", properties: { query: str("Company name and/or ticker, or a topic"), days: { type: "number", description: "window in days, default 30, max 120" }, limit: { type: "number", description: "default 20" } }, required: ["query"] },
    handler: ({ query, days, limit }) => data.getNews(query, { days: Math.min(Number(days) || 30, 120), limit: Math.min(Number(limit) || 20, 50) }),
  },
  {
    name: "options_snapshot",
    description: "US listed options from Cboe delayed quotes: put/call open-interest and volume ratios, ATM implied-vol term structure, 25-delta skew.",
    inputSchema: { type: "object", properties: { symbol }, required: ["symbol"] },
    handler: ({ symbol: s }) => data.getOptions(s),
  },
  {
    name: "macro_snapshot",
    description: "FRED macro dashboard: 10Y/2Y yields and curve, fed funds, CPI YoY, VIX, high-yield spread, broad USD.",
    inputSchema: { type: "object", properties: {} },
    handler: () => data.getMacro(),
  },
  {
    name: "method_lenses",
    description: "Evaluate deterministic method lenses (value, quality, GARP, growth, trend, shareholder yield, balance-sheet risk, contrarian) on live facts. No model judgment.",
    inputSchema: { type: "object", properties: { symbol, lenses: lensesProp, language: langProp } },
    handler: async ({ symbol: s, lenses, language }) => {
      const g = await council.gatherGrounding(data.normalizeSymbol(s), { deep: false });
      const ids = !lenses || lenses === "all" ? LENS_IDS : Array.isArray(lenses) ? lenses : String(lenses).split(/[,\s]+/);
      return { symbol: s, gaps: g.gaps, lenses: evaluateLenses(g, ids, language || "en") };
    },
  },
];

export const COUNCIL_TOOLS = [
  {
    name: "council_plan",
    description: "Preview a council run (roles, lenses, stages, model calls, time ceiling). Show the result to the user and get confirmation before council_start. Returns plan_id.",
    inputSchema: { type: "object", properties: { symbol, mode: modeProp, pace: paceProp, language: langProp, lenses: lensesProp }, required: ["symbol"] },
    handler: (args) => {
      const plan = council.planCouncil(args);
      return { plan_id: planId(plan), ...plan };
    },
  },
  {
    name: "council_start",
    description: "Start a confirmed council run: freezes price/fundamental grounding and evaluates the method lenses. Requires the plan_id from council_plan for the SAME settings, obtained after the user confirmed the plan.",
    inputSchema: { type: "object", properties: { symbol, mode: modeProp, pace: paceProp, language: langProp, lenses: lensesProp, question: str("The user's original request"), plan_id: str("plan_id from council_plan") }, required: ["symbol", "plan_id"] },
    handler: async (args) => {
      const plan = council.planCouncil(args);
      if (args.plan_id !== planId(plan)) throw new Error("plan_id does not match these settings: call council_plan with the final settings, show it to the user, then start with its plan_id");
      const { run, grounding, lenses } = await council.startCouncil({ ...args, executor: "claude-code" });
      return {
        run_id: run.run_id,
        dir: runDir(run.run_id),
        instrument: run.instrument,
        price: grounding.quote ? `${grounding.quote.price} ${grounding.quote.currency} (${grounding.quote.market_time})` : "unavailable",
        grounding_gaps: grounding.gaps,
        lenses: lenses.map((l) => `${l.id}: ${l.stance}`),
        next: "call council_next",
      };
    },
  },
  {
    name: "council_next",
    description: "Advance the run. Returns the next wave of tasks — launch ALL of them in parallel (one subagent each, in one message), wait for every one to return, then call council_next again. When done=true, call council_finalize.",
    inputSchema: { type: "object", properties: { run_id: runId }, required: ["run_id"] },
    handler: ({ run_id: id }) => {
      const r = council.nextTasks(id);
      return {
        run_id: r.run_id,
        done: r.done,
        stage: r.stage || null,
        round: r.round || null,
        reason: r.reason || null,
        tasks: r.tasks.map((t) => ({ subagent: `alphacouncil:${t.agent}`, description: `${t.role} ${t.stage}${t.round ? ` r${t.round}` : ""}${t.attempt > 1 ? " (repair)" : ""}`, prompt: t.handoff })),
      };
    },
  },
  {
    name: "council_brief",
    description: "For council subagents: returns the full instructions and frozen briefing for a task_id.",
    inputSchema: { type: "object", properties: { run_id: runId, task_id: str("task_id from your task prompt, e.g. evidence/market_data#1") }, required: ["run_id", "task_id"] },
    handler: ({ run_id: id, task_id: taskId }) => {
      const instructions = council.taskBrief(id, taskId);
      const role = String(taskId).split("#")[0].split("/").pop();
      // The role guide is the subagent's own definition; repeating it here keeps a fallback
      // general-purpose subagent on the same brief.
      return `${instructions}\n\n## Role guide (your subagent definition; already loaded if you are the named subagent)\n\n${loadAgent(agentName(role)).body}`;
    },
  },
  {
    name: "council_record",
    description: "For council subagents: submit your packet. Validates it; returns ok or a list of errors to fix and resubmit.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: runId,
        role: str("Your role ID, e.g. market_data, bull_researcher, portfolio_manager"),
        stage: { type: "string", enum: ["evidence", "debate", "pm"] },
        round: { type: "number", description: "Debate round (1-3); debate stage only" },
        packet: { type: "object", description: "The packet object in the schema from your instructions" },
      },
      required: ["run_id", "role", "stage", "packet"],
    },
    handler: (args) => council.recordPacket(args.run_id, args),
  },
  {
    name: "council_finalize",
    description: "Close the run: writes final_report.md, transcript, quality check and a hand-off summary. Terminal state is complete, degraded (finished with failed seats) or incomplete.",
    inputSchema: { type: "object", properties: { run_id: runId, reason: str("Why the run is being closed early, if it is") }, required: ["run_id"] },
    handler: ({ run_id: id, reason }) => council.finalizeCouncil(id, { reason }),
  },
  {
    name: "council_status",
    description: "Status of a run (default: latest): each seat's state, attempts and last validation error.",
    inputSchema: { type: "object", properties: { run_id: str("Run ID or 'latest'") } },
    handler: ({ run_id: id }) => council.councilStatus(resolveRunId(id)),
  },
  {
    name: "council_runs",
    description: "List saved runs, newest first.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    handler: ({ limit }) => listRuns().slice(0, Number(limit) || 20),
  },
];

export const ALL_TOOLS = [...DATA_TOOLS, ...COUNCIL_TOOLS];

export async function callTool(name, args = {}) {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.handler(args || {});
}
