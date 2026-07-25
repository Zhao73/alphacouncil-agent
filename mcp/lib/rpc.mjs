import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { DEBATE_ROLES, DEFAULT_TASKS, LIMITS, OUTPUT_MODES, SERVER_NAME, VERSION } from "./constants.mjs";
import { RpcCode, methodNotFound, toRpcError } from "./errors.mjs";
import { readJson, readJsonl } from "./fsutil.mjs";
import { resolveLanguage } from "./lang.mjs";
import { sweepStaleOutputs } from "./codex.mjs";
import { sourceManifest } from "./gates.mjs";
import { artifactPaths, runPath } from "./run-store.mjs";
import { summaryModes } from "./output-modes.mjs";
import { getQuotes } from "./quotes.mjs";
import { analyzeSymbol, collectEvidence, recordVisibleDecision, recordVisiblePacket, visibleAgentSpecs, visibleRun } from "./orchestrator.mjs";

export function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

export function sendError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

export function jsonContent(text, structuredContent = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

export function tool(name, description, inputSchema, annotations = {}) {
  return { name, description, inputSchema, annotations };
}

export function tools() {
  const common = {
    symbol: { type: "string", description: "Ticker, e.g. NVDA." },
    as_of: { type: "string", description: "Analysis date YYYY-MM-DD. Defaults to today." },
    prompt: { type: "string", description: "User objective or extra instructions." },
    language: { type: "string", default: "auto", description: "Reader-facing language for subagents and final report, e.g. auto, zh-CN, en-US, ja-JP. Auto infers from prompt." },
    tasks: { type: "array", items: { type: "string", enum: DEFAULT_TASKS } },
    dry_run: { type: "boolean", default: false, description: "Default false. Set true only for planning/self-tests without launching Codex subagents." },
    max_concurrency: { type: "number", default: LIMITS.CONCURRENCY_DEFAULT },
    timeout_ms: { type: "number", default: LIMITS.CODEX_TIMEOUT_MS },
    synthesis: { type: "boolean", default: true, description: "Run bull, bear, and portfolio-manager synthesis after evidence collection." },
    synthesis_timeout_ms: { type: "number", default: LIMITS.CODEX_TIMEOUT_MS },
    output_mode: { type: "string", enum: OUTPUT_MODES, default: "public_equity", description: "Final synthesis target shape." },
    visibility_required: { type: "boolean", default: false, description: "When true, headless MCP execution is rejected; use host-visible agents/threads and record their outputs." },
  };
  return [
    tool("plan_visible_run", "MANDATORY first step (not optional): create the visible-host-thread AlphaCouncil Agent run envelope and prompts. Does NOT execute. You MUST then run every planned evidence agent and record each via record_visible_packet, then record bull_researcher and bear_researcher, before recording the portfolio_manager decision.", {
      type: "object",
      properties: {
        symbol: common.symbol,
        as_of: common.as_of,
        prompt: common.prompt,
        language: common.language,
        tasks: common.tasks,
        run_id: { type: "string" },
      },
      required: ["symbol"],
    }),
    tool("record_visible_packet", "MANDATORY sequential step (not optional): record one completed visible evidence agent packet into a planned visible run. Every planned evidence task MUST be recorded before the portfolio_manager decision; a run missing any planned packet will be marked incomplete.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        task: { type: "string", enum: DEFAULT_TASKS },
        packet: { type: "object" },
        thread_id: { type: "string" },
        thread_title: { type: "string" },
      },
      required: ["run_id", "task", "packet"],
    }),
    tool("record_visible_decision", "Record one completed visible bull_researcher / bear_researcher / portfolio_manager packet. Record bull_researcher and bear_researcher before portfolio_manager. For role=portfolio_manager, ALL planned evidence packets AND both debate researchers (bull_researcher and bear_researcher) MUST already be recorded; otherwise the run is marked status=incomplete (NOT complete) and final_report.md gets a visible INCOMPLETE banner. This is the LAST step.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        role: { type: "string", enum: DEBATE_ROLES },
        packet: { type: "object" },
        thread_id: { type: "string" },
        thread_title: { type: "string" },
      },
      required: ["run_id", "role", "packet"],
    }),
    tool("collect_evidence", "Launch Codex subagents and save shared JSON evidence packets. Use dry_run=true only for planning/self-tests.", {
      type: "object",
      properties: common,
      required: ["symbol"],
    }),
    tool("analyze_symbol", "Collect evidence and write a manager-style decision summary.", {
      type: "object",
      properties: common,
      required: ["symbol"],
    }),
    tool("read_run", "Read a saved AlphaCouncil Agent run from the shared evidence store.", {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("compare_summary_modes", "Compare chat, PDF, presentation, document, and specialist plugin modes for final AlphaCouncil Agent synthesis.", {
      type: "object",
      properties: { language: common.language },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("get_quote", "Keyless DELAYED market data (Yahoo/Stooq, ~15m or EOD) for indices, index futures (incl. night session), FX, rates, vol, commodities, and stocks. Accepts plain names ('KOSPI','纳指期货','VIX','美元指数','10年美债','黄金') or raw tickers (^KS11, ES=F, NVDA). Use for real index/futures/macro numbers; on error treat as a data gap (open_questions). Not real-time, not investment advice.", {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Names or tickers, e.g. ['KOSPI','ES=F','VIX','美元指数']." },
        symbol: { type: "string", description: "Single name/ticker (alternative to symbols[])." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
  ];
}

export async function handleToolCall(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};
  if (name === "plan_visible_run") {
    const run = visibleRun(args);
    const specs = visibleAgentSpecs(run, args.prompt || "");
    sendResult(id, jsonContent(`Planned visible AlphaCouncil Agent run for ${run.symbol}: ${run.run_id}`, {
      run,
      ...specs,
      artifacts: {
        all_agents_md: join(runPath(run.run_id), "all_agents.md"),
        status_json: join(runPath(run.run_id), "status.json"),
        events_jsonl: join(runPath(run.run_id), "events.jsonl"),
      },
    }));
    return;
  }
  if (name === "record_visible_packet") {
    const run = recordVisiblePacket(args);
    sendResult(id, jsonContent(`Recorded visible evidence packet ${args.task} for ${run.symbol}: ${run.run_id}`, run));
    return;
  }
  if (name === "record_visible_decision") {
    const result = recordVisibleDecision(args);
    sendResult(id, jsonContent(`Recorded visible decision ${args.role} for ${result.run.symbol}: ${result.run.run_id}`, result));
    return;
  }
  if (name === "get_quote") {
    const data = await getQuotes(args);
    const ok = data.quotes.filter((q) => !q.error).length;
    sendResult(id, jsonContent(`Fetched ${ok}/${data.quotes.length} delayed quotes`, data));
    return;
  }
  if (name === "collect_evidence") {
    const run = await collectEvidence(args);
    sendResult(id, jsonContent(`Saved ${run.packets.length} evidence packets for ${run.symbol}: ${run.run_id}`, run));
    return;
  }
  if (name === "analyze_symbol") {
    const result = await analyzeSymbol(args);
    sendResult(id, jsonContent(`Saved AlphaCouncil Agent analysis for ${result.run.symbol}: ${result.run.run_id}`, result));
    return;
  }
  if (name === "read_run") {
    const idArg = args.run_id;
    const dir = runPath(idArg);
    const evidence = readJson(join(dir, "evidence.json"));
    const decisionPath = join(dir, "decision.json");
    const decision = existsSync(decisionPath) ? readJson(decisionPath) : null;
    const allAgentsPath = join(dir, "all_agents.md");
    const finalReportPath = join(dir, "final_report.md");
    const userResponsePath = join(dir, "user_response.md");
    const statusPath = join(dir, "status.json");
    const eventsPath = join(dir, "events.jsonl");
    const sourceManifestPath = join(dir, "source_manifest.json");
    const reportQualityPath = join(dir, "report_quality.json");
    const eventLog = readJsonl(eventsPath);
    sendResult(id, jsonContent(`Loaded AlphaCouncil Agent run ${idArg}`, {
      evidence,
      decision,
      source_manifest: existsSync(sourceManifestPath) ? readJson(sourceManifestPath) : sourceManifest(evidence),
      report_quality: existsSync(reportQualityPath) ? readJson(reportQualityPath) : null,
      status: existsSync(statusPath) ? readJson(statusPath) : null,
      events: eventLog.entries,
      events_parse_errors: eventLog.parse_errors,
      artifacts: {
        ...artifactPaths(evidence),
        all_agents_md: allAgentsPath,
        final_report_md: finalReportPath,
        user_response_md: userResponsePath,
        source_manifest_json: sourceManifestPath,
        status_json: statusPath,
        events_jsonl: eventsPath,
      },
      all_agents_markdown: existsSync(allAgentsPath) ? readFileSync(allAgentsPath, "utf8") : "",
      final_report_markdown: existsSync(finalReportPath) ? readFileSync(finalReportPath, "utf8") : "",
      user_response_markdown: existsSync(userResponsePath) ? readFileSync(userResponsePath, "utf8") : "",
    }));
    return;
  }
  if (name === "compare_summary_modes") {
    const modes = summaryModes(resolveLanguage(args));
    sendResult(id, jsonContent(JSON.stringify(modes, null, 2), { modes }));
    return;
  }
  throw methodNotFound(`Unknown tool: ${name}`);
}

export async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions: "Use AlphaCouncil Agent to coordinate public-equity research subagents, save shared evidence packets, and produce manager-style long/short decisions.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: tools() });
    return;
  }
  if (method === "tools/call") {
    try {
      await handleToolCall(id, params);
    } catch (error) {
      // Previously every throw became INVALID_PARAMS, so a missing run directory or a
      // failed fetch was reported to the host as a caller mistake.
      const rpc = toRpcError(error);
      sendError(id, rpc.code, rpc.message, rpc.data);
    }
    return;
  }
  if (id !== undefined) {
    sendError(id, RpcCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export function startStdioServer() {
  // stdout is the JSON-RPC frame channel; diagnostics must never go there.
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[alphacouncil] uncaught exception: ${error?.stack || error}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[alphacouncil] unhandled rejection: ${reason?.stack || reason}\n`);
  });
  sweepStaleOutputs();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      // Answering is strictly better than the old silent `catch {}`: the host learns
      // its frame was rejected instead of waiting for a reply that never comes.
      sendError(null, RpcCode.PARSE_ERROR, `invalid JSON frame: ${error.message}`);
      return;
    }
    void handleRequest(message);
  });
}
