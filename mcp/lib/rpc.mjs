import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { LIMITS, OUTPUT_MODES, SERVER_NAME, VERSION } from "./constants.mjs";
import { RpcCode, methodNotFound, toRpcError } from "./errors.mjs";
import { readJson, readJsonl } from "./fsutil.mjs";
import { resolveLanguage } from "./lang.mjs";
import { sweepStaleOutputs } from "./codex.mjs";
import { sourceManifest } from "./gates.mjs";
import { artifactPaths, runPath } from "./run-store.mjs";
import { summaryModes } from "./output-modes.mjs";
import { registry } from "./personas/registry.mjs";
import { preflightNetworkPermissions } from "./preflight.mjs";
import { getQuotes } from "./quotes.mjs";
import { MACRO_BLOCKS, getMacroSnapshot } from "./macro.mjs";
import { screenTicker, explainResult } from "./screen.mjs";
import { fetchUniverse } from "./sec.mjs";
import { analyzeSymbol, collectEvidence, recordMasterOpinion, recordVerifierVerdict, recordVisibleDecision, recordVisiblePacket, visibleAgentSpecs, visibleRun } from "./orchestrator.mjs";

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
  // Derived from personas/, not from a frozen list: adding a persona file makes the role
  // selectable through the tool schema with no code change.
  const analystIds = registry().ids("analyst");
  const debateIds = registry().ids("debate");
  const masterIds = registry().ids("master");
  const masterRosters = [...new Set(registry().all().filter((p) => p.kind === "master" && p.enabled).flatMap((p) => p.rosters))].sort();
  const common = {
    symbol: { type: "string", description: "Exchange ticker. US, HK, JP, KR, CN and TW symbols all work, e.g. AAPL, 0700.HK, 7203.T, 005930.KS, 600519.SS." },
    as_of: { type: "string", description: "Analysis date YYYY-MM-DD. Defaults to today." },
    prompt: { type: "string", description: "User objective or extra instructions." },
    language: { type: "string", default: "auto", description: "Reader-facing language for subagents and final report, e.g. auto, zh-CN, en-US, ja-JP. Auto infers from prompt." },
    tasks: { type: "array", items: { type: "string", enum: analystIds } },
    dry_run: { type: "boolean", default: false, description: "Default false. Set true only for planning/self-tests without launching Codex subagents." },
    max_concurrency: { type: "number", default: LIMITS.CONCURRENCY_DEFAULT },
    timeout_ms: { type: "number", default: LIMITS.CODEX_TIMEOUT_MS },
    synthesis: { type: "boolean", default: true, description: "Run bull, bear, and portfolio-manager synthesis after evidence collection." },
    synthesis_timeout_ms: { type: "number", default: LIMITS.CODEX_TIMEOUT_MS },
    output_mode: { type: "string", enum: OUTPUT_MODES, default: "public_equity", description: "Final synthesis target shape." },
    masters_roster: { type: "string", enum: masterRosters, description: "Optional master bench. Masters read the finished evidence through one philosophy each and run BETWEEN the evidence stage and the debate; their disagreements become inputs the bull and bear must answer. They never gather evidence and are not part of the completeness gate." },
    seat_weights: { type: "object", description: "Override the declared weight of any seat, e.g. {\"master_buffett\": 2, \"master_soros\": 0}. Weights are an editable prior, not an optimum: a return backtest of LLM judgment would be invalidated by look-ahead bias." },
    masters: { type: "array", items: { type: "string", enum: masterIds }, description: "Explicit master personas, overriding masters_roster." },
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
        masters_roster: common.masters_roster,
        masters: common.masters,
        seat_weights: common.seat_weights,
        run_id: { type: "string" },
      },
      required: ["symbol"],
    }),
    tool("record_visible_packet", "MANDATORY sequential step (not optional): record one completed visible evidence agent packet into a planned visible run. Every planned evidence task MUST be recorded before the portfolio_manager decision; a run missing any planned packet will be marked incomplete.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        task: { type: "string", enum: analystIds },
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
        role: { type: "string", enum: debateIds },
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
    tool("record_master_opinion", "Record one completed master-seat opinion into a planned visible run. Masters run AFTER every evidence packet is recorded and BEFORE the bull/bear debate, so the debate has their disagreements to argue with. A master may return stance=out_of_scope, which is a conclusion rather than an abstention. Masters are optional and never affect the completeness gate.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        master: { type: "string", enum: masterIds },
        packet: { type: "object" },
        thread_id: { type: "string" },
      },
      required: ["run_id", "master", "packet"],
    }),
    tool("get_macro_snapshot", "Keyless DELAYED top-down macro context in one call: rate curve, dollar and credit, commodities, risk appetite and breadth, and cross-market indices, plus derived pairs (10Y-3M spread, copper/gold, HY/IG, equal-weight vs cap-weight). Use it to place a single name inside its macro environment. These are observations, not a regime call, and unavailable series are data gaps for open_questions.", {
      type: "object",
      properties: {
        blocks: {
          type: "array",
          items: { type: "string", enum: MACRO_BLOCKS.map((b) => b.id) },
          description: "Subset of macro blocks. Defaults to all.",
        },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("record_verifier_verdict", "Record one Stage 2b verifier outcome against the seat that cited the claim. Verdicts that failed verification (contradicted, disagree, refuted) automatically reduce that seat's weight in the portfolio-manager synthesis; cannot_confirm and source_unreachable reduce it less. A seat is down-weighted, never silently erased.", {
      type: "object",
      properties: {
        run_id: { type: "string" },
        verifier: { type: "string", enum: registry().ids("verifier") },
        seat: { type: "string", description: "The seat whose claim was checked, e.g. bull_researcher or master_buffett." },
        verdict: { type: "string", description: "Must be one of the verifier's declared verdict_values." },
        claim: { type: "string" },
        note: { type: "string" },
      },
      required: ["run_id", "verifier", "seat", "verdict"],
    }),
    tool("screen_ticker", "Run the mechanical elimination screen against a company's own SEC filings. No language model is involved: seven hard rules (10y ROE, 5y cumulative FCF, interest cover, gross margin, OCF/NI, net margin, dilution) with three exemptions, and every rejection names the metric, the measured value and the threshold. Rules whose inputs are missing from the filings are reported as skipped, never as passes. Surviving is not a recommendation -- it means the name is worth research time. US filers only; other markets need their own regulator feed.", {
      type: "object",
      properties: {
        cik: { type: "string", description: "SEC CIK. Use list_us_universe to resolve a ticker." },
        ticker: { type: "string" },
        as_of: { type: "string", description: "YYYY-MM-DD. Only filings actually filed by this date are used, which is what keeps a historical screen free of look-ahead bias." },
      },
      required: ["cik"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("list_us_universe", "The full SEC list of US listed companies (~10k) as {cik, ticker, title}. Keyless. Use it to resolve a ticker to a CIK, or as the starting universe for a screen.", {
      type: "object",
      properties: {
        contains: { type: "string", description: "Case-insensitive filter on ticker or company name." },
        limit: { type: "number", default: 50 },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("preflight_permissions", "MANDATORY before a visible run: check that the host actually grants the network tools the evidence agents need. Background subagents cannot raise an interactive permission prompt, so a missing allowlist entry blocks their searches SILENTLY and they answer from training knowledge while still filling in every report section. Returns status ok | blocked | unknown with a remedy.", {
      type: "object",
      properties: {
        roster: { type: "string", default: "default", description: "Which analyst roster the run will use." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("get_quote", "Keyless DELAYED market data (Yahoo/Stooq, ~15m or EOD) for indices, index futures (incl. night session), FX, rates, vol, commodities, and stocks. Accepts plain names ('KOSPI','纳指期货','VIX','美元指数','10年美债','黄金') or raw tickers (^KS11, ES=F, 7203.T). Use for real index/futures/macro numbers; on error treat as a data gap (open_questions). Not real-time, not investment advice.", {
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
    // Returned with the plan, not left to a separate opt-in call: a host that skips the
    // preflight is exactly the host whose subagents will fail silently.
    const preflight = preflightNetworkPermissions({ roster: args.roster || "default" });
    sendResult(id, jsonContent(
      `Planned visible AlphaCouncil Agent run for ${run.symbol}: ${run.run_id}. Network preflight: ${preflight.status}.`,
      {
      run,
      preflight,
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
  if (name === "record_master_opinion") {
    const result = recordMasterOpinion(args);
    sendResult(id, jsonContent(
      `Recorded master opinion ${args.master} (${result.opinion.stance}) for ${result.run.symbol}: ${result.recorded}/${result.expected} master seats in.`,
      result,
    ));
    return;
  }
  if (name === "record_verifier_verdict") {
    const result = recordVerifierVerdict(args);
    const seat = result.weights.seats.find((s) => s.seat === args.seat);
    sendResult(id, jsonContent(
      `Recorded ${args.verifier} -> ${args.verdict} for ${args.seat}. Effective weight now ${seat ? seat.effective_weight : "n/a"}.`,
      result,
    ));
    return;
  }
  if (name === "screen_ticker") {
    const result = await screenTicker(args);
    sendResult(id, jsonContent(explainResult(result, result.ticker), result));
    return;
  }
  if (name === "list_us_universe") {
    const all = await fetchUniverse();
    const needle = String(args.contains || "").trim().toLowerCase();
    const matched = needle
      ? all.filter((c) => c.ticker.toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle))
      : all;
    const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, args.limit)) : 50;
    sendResult(id, jsonContent(
      `${matched.length} of ${all.length} US filers matched${needle ? ` "${args.contains}"` : ""}; returning ${Math.min(limit, matched.length)}.`,
      { total: all.length, matched: matched.length, companies: matched.slice(0, limit) },
    ));
    return;
  }
  if (name === "preflight_permissions") {
    const result = preflightNetworkPermissions({ roster: args.roster || "default" });
    sendResult(id, jsonContent(`Network permission preflight: ${result.status}. ${result.message}`, result));
    return;
  }
  if (name === "get_macro_snapshot") {
    const data = await getMacroSnapshot(args);
    const total = data.blocks.reduce((sum, block) => sum + block.members.length, 0);
    sendResult(id, jsonContent(
      `Macro snapshot: ${total - data.unavailable.length}/${total} series, ${data.derived.filter((d) => d.available).length}/${data.derived.length} derived measures.`,
      data,
    ));
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
  if (startupFailure && id !== undefined) {
    sendError(id, RpcCode.INTERNAL_ERROR, `alphacouncil-agent cannot serve requests: ${startupFailure}`);
    return;
  }
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

/**
 * Set when the persona set fails to load. Every request then answers with an actionable
 * error instead of the server appearing healthy and producing empty prompts later.
 */
let startupFailure = null;

export function startStdioServer() {
  // stdout is the JSON-RPC frame channel; diagnostics must never go there.
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[alphacouncil] uncaught exception: ${error?.stack || error}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[alphacouncil] unhandled rejection: ${reason?.stack || reason}\n`);
  });
  sweepStaleOutputs();
  // Load personas eagerly. Lazy loading made `initialize` succeed against a missing or
  // malformed persona set, so the host believed the server was healthy and only found
  // out several tool calls later.
  try {
    registry();
  } catch (error) {
    startupFailure = error.message;
    process.stderr.write(`[alphacouncil] ${error.message}\n`);
  }
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
