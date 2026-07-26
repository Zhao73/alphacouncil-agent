import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import readline from "node:readline";
import { LIMITS, OUTPUT_MODES, SERVER_NAME, VERSION } from "./constants.mjs";
import { RpcCode, methodNotFound, invalidParams, toRpcError } from "./errors.mjs";
import { readJson, readJsonl } from "./fsutil.mjs";
import { resolveLanguage } from "./lang.mjs";
import { sweepStaleOutputs } from "./codex.mjs";
import { sourceManifest } from "./gates.mjs";
import { artifactPaths, runPath, saveRun } from "./run-store.mjs";
import { summaryModes } from "./output-modes.mjs";
import { registry } from "./personas/registry.mjs";
import { preflightNetworkPermissions } from "./preflight.mjs";
import { getQuotes } from "./quotes.mjs";
import { MACRO_BLOCKS, getMacroSnapshot } from "./macro.mjs";
import { fetchOptionsChain } from "./options.mjs";
import { getMarketNarrative } from "./narrative.mjs";
import { getSocialPulse, verifyXPost } from "./social.mjs";
import { fetchFeeds, tickerNewsFeed, queryNewsFeed, filingsFeed } from "./feeds.mjs";
import { screenTicker, explainResult, screenBatch } from "./screen.mjs";
import { gatherGrounding, groundingBlock } from "./grounding.mjs";
import { fetchMarketFinancials, coverageFor, MARKETS } from "./markets.mjs";
import { table, mark, metricValue, groundingDashboard, label, threshold, skippedMark } from "./tables.mjs";
import { fetchUniverse } from "./sec.mjs";
import { industryBrief, listIndustries, industryCoverage, peersBySic, SIC_GROUPS } from "./industry.mjs";
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
    masters_roster: { type: "string", enum: masterRosters, description: "Master bench; masters-core is the recommended default with twelve seats spanning value, classic, adversarial and quant schools. Masters read the finished evidence through one philosophy each and run BETWEEN the evidence stage and the debate; their disagreements become inputs the bull and bear must answer. They never gather evidence and are not part of the completeness gate." },
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
        grounding: { type: "object", description: "The `grounding` object from compose_research_brief. Injected into every analyst prompt." },
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
    tool("get_options_chain", "Keyless DELAYED options chain digest from CBOE for one US-listed symbol: ATM implied-volatility term structure, 25-delta skew, put/call ratios on open interest and volume, the strikes holding the most open interest, and the ATM bid-ask spread as a share of mid. Contracts reporting iv = 0 (expired or deep in the money) are excluded rather than read as zero volatility. This is a snapshot with no history, so IV percentile or rank CANNOT be computed from it and must stay an open question. Non-US listings are generally absent and are reported as unavailable, never guessed.", {
      type: "object",
      properties: {
        symbol: { type: "string", description: "US-listed underlying, e.g. MU or BRK.B." },
        as_of: { type: "string", description: "ISO date used to compute days-to-expiry. Defaults to today." },
      },
      required: ["symbol"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("get_market_narrative", "What story the market is currently telling itself, read from keyless news feeds (Federal Reserve, SEC, WSJ, CNBC, Yahoo) and cross-checked against the macro tape. Returns ranked themes with their share of coverage, dated and linked sample headlines, and for each theme the actual market series that would corroborate it. Headline counts measure ATTENTION, never truth: where a theme leads coverage and its series has not moved, that divergence is the finding. Every item must carry a timestamp inside the window or it is reported as excluded. Themes come from a fixed lexicon, so a genuinely new narrative lands in unclassified_headlines rather than being discovered, and the output says so.", {
      type: "object",
      properties: {
        days: { type: "number", description: "Recency window in days. Defaults to 7." },
        as_of: { type: "string", description: "ISO date treated as now. Defaults to today." },
        extra_queries: {
          type: "array", items: { type: "string" },
          description: "Up to 4 extra Google News queries to fold in, e.g. a sector or a country.",
        },
        top: { type: "number", description: "How many themes to return. Defaults to 6." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("get_news", "Dated headlines for one symbol, one search query, or one company's SEC filings, from keyless feeds (Yahoo Finance RSS, Google News RSS, EDGAR Atom). Every item must carry a parsable timestamp inside the window; undated and out-of-window items are counted and sampled under excluded_outside_window rather than being shown as recent. Filings are the one source here that cannot be spun, so prefer them for anything material.", {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker for the Yahoo per-name feed." },
        query: { type: "string", description: "Free-text Google News query, e.g. 'HBM supply Samsung'." },
        cik: { type: "string", description: "SEC CIK for the filings feed." },
        forms: { type: "string", description: "Filing type for the CIK feed. Defaults to 8-K." },
        days: { type: "number", description: "Recency window in days. Defaults to 14." },
        as_of: { type: "string", description: "ISO date treated as now. Defaults to today." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("get_social_pulse", "Keyless retail and technical-community discussion for a name or theme, from Reddit (searched inside the equity subreddits, not site-wide), Hacker News, and any Bluesky handles supplied. IMPORTANT: X / Twitter has NO free discovery channel -- Nitter search is dead, the X API bills per post and xAI bills per call -- so this does NOT cover professional FinTwit, and Reddit is not a substitute for it. Mention volume measures attention, never correctness. Nothing here may enter a conclusion alone; it is a lead to be confirmed against a filing or recorded in open_questions.", {
      type: "object",
      properties: {
        query: { type: "string", description: "Company name or theme to search for." },
        symbol: { type: "string", description: "Used as the query when query is absent." },
        subreddits: { type: "array", items: { type: "string" }, description: "Override the default equity subreddits." },
        handles: { type: "array", items: { type: "string" }, description: "Bluesky handles to read. Search needs auth; reading a named account does not." },
        days: { type: "number", description: "Recency window in days. Defaults to 7." },
        as_of: { type: "string", description: "ISO date treated as now." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("verify_x_post", "Confirm that one X post id exists and read back its text, author and date. Use it whenever a report or search result quotes a post: a decoded snowflake timestamp proves nothing, because any invented 19-digit id decodes to a plausible date, so existence has to be checked separately. This is verification only and cannot search or discover posts.", {
      type: "object",
      properties: { id: { type: "string", description: "Numeric X post id." } },
      required: ["id"],
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
    tool("industry_brief", "Start from an industry rather than a ticker. Returns the participant list by position in the value chain -- INCLUDING the non-US names a SEC-only pipeline would silently drop, such as Korean and Japanese makers -- plus who actually drives demand, the questions a run must answer, how the industry behaves through a cycle, and which participants this pipeline can screen mechanically versus which need their own regulator's feed. Returns a frame, never a verdict.", {
      type: "object",
      properties: {
        industry: { type: "string", description: "Free text; ids and aliases in both languages, e.g. memory, 存储, HBM, DRAM." },
      },
      required: ["industry"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("market_financials", "Structured financials for ANY market, degrading in a stated order: keyless regulator feed (SEC for US, TWSE for Taiwan), then a feed needing a free key (DART for Korea, EDINET for Japan) reported as not-configured rather than pretended away, then quotes plus search which always work. Never returns an empty result silently -- it says which feed is missing, why, and what to use instead.", {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Exchange symbol, e.g. 2408.TW, 000660.KS, 285A.T, 0700.HK." },
        corp_code: { type: "string", description: "Korea only: DART's 8-digit corp_code, which is not the ticker. Samsung Electronics is 00126380, SK hynix 00164779." },
        year: { type: "number", description: "Korea only: fiscal year. Defaults to last year." },
      },
      required: ["symbol"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("market_coverage", "Ask up front what this pipeline can and cannot fetch for a set of symbols, before building a report on them. Returns per-symbol whether structured financials are available, summary-only, or absent, and which environment variable would unlock a market. Names without a feed are still researchable from documents -- but every figure taken that way has to be labelled as such.", {
      type: "object",
      properties: { symbols: { type: "array", items: { type: "string" } } },
      required: ["symbols"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("compose_research_brief", "Assemble the hard facts BEFORE the analysts search: quote, SEC filer profile, the mechanical screen with every computed metric, macro readings, and the industry chain map. Returns both the structured data and a prompt block that tells an analyst these numbers are already established and that its search exists to explain, extend and challenge them -- with the rule that a searched number never silently overwrites a filed one. Pass the returned `grounding` object to plan_visible_run so every analyst prompt carries it.", {
      type: "object",
      properties: {
        symbol: common.symbol,
        cik: { type: "string", description: "SEC CIK; enables the filer profile and the mechanical screen." },
        industry: { type: "string", description: "Industry query; adds the value-chain participants including non-US names." },
        macro: { type: "boolean", default: true },
        as_of: { type: "string", description: "YYYY-MM-DD; only filings filed by this date are used." },
        language: common.language,
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("industry_coverage", "Ask what is actually known about an industry BEFORE researching it. Returns whether a curated value-chain map exists, whether SEC's SIC classification covers it, or neither -- with guidance for each case. SIC reaches every industry with a US filer; a curated map additionally carries chain position, non-US participants and demand drivers. Use this so a report never presents an uncurated participant list as if it were complete.", {
      type: "object",
      properties: { industry: { type: "string" } },
      required: ["industry"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("industry_peers", "Find US filers related to a company using SEC's own SIC classification -- no curation and no model. Covers every industry with a US filer, including ones no curated map reaches. It gives no value-chain position and no non-US participants: for those prefer industry_brief where a map exists. Peer matching is by company name and is a starting universe, not an index membership list.", {
      type: "object",
      properties: {
        cik: { type: "string", description: "Anchor company CIK. Resolve one with list_us_universe." },
        limit: { type: "number", default: 25 },
      },
      required: ["cik"],
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("list_industries", "The industries that have a hand-maintained map. Deliberately a short list: an unmapped industry should be handled by research rather than by inventing a participant list.", {
      type: "object",
      properties: {},
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    tool("screen_ticker", "Run the mechanical elimination screen against a company's own SEC filings. No language model is involved: seven hard rules (10y ROE, 5y cumulative FCF, interest cover, gross margin, OCF/NI, net margin, dilution) with three exemptions, and every rejection names the metric, the measured value and the threshold. Rules whose inputs are missing from the filings are reported as skipped, never as passes. Surviving is not a recommendation -- it means the name is worth research time. US filers only; other markets need their own regulator feed.", {
      type: "object",
      properties: {
        cik: { type: "string", description: "SEC CIK. Use list_us_universe to resolve a ticker." },
        ticker: { type: "string", description: "US ticker, e.g. MU. Resolved to a CIK against the SEC universe, so supplying this is enough." },
        as_of: { type: "string", description: "YYYY-MM-DD. Only filings actually filed by this date are used, which is what keeps a historical screen free of look-ahead bias." },
      },
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: true }),
    tool("screen_candidates", "Run the mechanical elimination screen over a list of candidates and report every rejection with the metric, the measured value and the threshold. This is the 'find me stocks' path, and no language model participates in it. Capped at 40 names: SEC is one request per company and rate-limits, so narrow the funnel first with industry_brief, industry_peers or list_us_universe. A fetch failure is reported as unavailable rather than eliminated, because dropping a name because SEC timed out would bias the survivors.", {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: {
            type: "object",
            properties: { cik: { type: "string" }, ticker: { type: "string" } },
            required: ["cik"],
          },
          description: "Up to 40 companies.",
        },
        as_of: { type: "string", description: "YYYY-MM-DD. Only filings filed by this date are used." },
      },
      required: ["candidates"],
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
    // Gather the established facts here rather than accepting them only when a host
    // remembers to pass them. Without this the whole visible path -- which is the path
    // Claude Code uses -- runs every analyst and every master with no filings, no quote and
    // no macro, and nothing in the output says so. Same reasoning as the preflight below:
    // the host that skips the optional step is exactly the host whose seats fail quietly.
    if (!run.grounding) {
      run.grounding = await gatherGrounding({ symbol: run.symbol, asOf: run.as_of })
        .catch((error) => ({ error: String(error?.message || error), facts_unavailable: true }));
      saveRun(run);
    }
    const specs = visibleAgentSpecs(run, args.prompt || "");
    // Returned with the plan, not left to a separate opt-in call: a host that skips the
    // preflight is exactly the host whose subagents will fail silently.
    const preflight = preflightNetworkPermissions({ roster: args.roster || "default" });
    sendResult(id, jsonContent(
      `Planned visible AlphaCouncil Agent run for ${run.symbol}: ${run.run_id}. `
      + `Network preflight: ${preflight.status}. `
      + `Established facts: ${run.grounding && !run.grounding.facts_unavailable ? "attached to every seat" : "UNAVAILABLE -- seats will run without filings or quotes, say so in the report"}.`,
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
  if (name === "industry_brief") {
    const brief = industryBrief(args.industry);
    const lines = [
      `${brief.title.en} / ${brief.title.zh}: ${brief.participants.length} mapped participants across ${brief.layers.length} chain layers.`,
      `Screenable from SEC filings: ${brief.coverage.sec_screenable.join(", ") || "none"}.`,
      `Need a local regulator feed: ${brief.coverage.needs_local_regulator_feed.map((p) => `${p.symbol} (${p.market})`).join(", ") || "none"}.`,
    ];
    sendResult(id, jsonContent(lines.join("\n"), brief));
    return;
  }
  if (name === "market_financials") {
    const result = await fetchMarketFinancials(args.symbol, { corp_code: args.corp_code, year: args.year });
    let text;
    if (result.financials) {
      const f = result.financials;
      const rows = [
        ["Revenue", metricValue(f.revenue, f.currency)],
        ["Gross profit", metricValue(f.gross_profit, f.currency)],
        ["Operating income", metricValue(f.operating_income, f.currency)],
        ["Net income", metricValue(f.net_income, f.currency)],
        ["EPS", String(f.eps ?? "n/a")],
      ];
      text = [
        table(["Line", `Value (${f.unit})`], rows,
          { title: `${f.company_name} ${f.gregorian_year ?? ""}Q${f.period.quarter} -- ${f.source}` }),
        `\n${f.note}`,
      ].join("\n");
    } else {
      text = [
        `${args.symbol} (${result.market}, ${result.regulator}): no structured feed.`,
        result.guidance,
        result.fallback?.quote ? `Quote: ${result.fallback.quote.price}. ${result.fallback.caveat}` : "",
      ].filter(Boolean).join("\n");
    }
    sendResult(id, jsonContent(text, result));
    return;
  }
  if (name === "market_coverage") {
    const coverage = coverageFor(args.symbols || []);
    const rows = coverage.rows.map((r) => [r.symbol, r.market, r.regulator, r.structured_financials, r.needs_env || r.reason?.slice(0, 50) || "-"]);
    const text = [
      table(["Symbol", "Market", "Regulator", "Structured financials", "Blocker"], rows, { title: "Data coverage" }),
      `\n${coverage.note}`,
    ].join("\n");
    sendResult(id, jsonContent(text, coverage));
    return;
  }
  if (name === "compose_research_brief") {
    const grounding = await gatherGrounding({
      symbol: args.symbol, cik: args.cik, industry: args.industry,
      macro: args.macro !== false, asOf: args.as_of,
    });
    const block = groundingBlock(grounding, resolveLanguage(args));
    const facts = [
      grounding.quote ? "quote" : null,
      grounding.filer ? "filer profile" : null,
      grounding.screen ? `screen (${grounding.screen.rules_computed}/${grounding.screen.rules_total} rules)` : null,
      grounding.macro ? `macro (${grounding.macro.derived.length} readings)` : null,
      grounding.industry?.participants ? `industry (${grounding.industry.participants.length} participants)` : null,
    ].filter(Boolean);
    sendResult(id, jsonContent(
      groundingDashboard(grounding, resolveLanguage(args)),
      { grounding, prompt_block: block, dashboard: groundingDashboard(grounding, resolveLanguage(args)) },
    ));
    return;
  }
  if (name === "industry_coverage") {
    const coverage = industryCoverage(args.industry);
    sendResult(id, jsonContent(
      `"${args.industry}": curated map ${coverage.curated ? `yes (${coverage.curated.id})` : "no"}, SIC group ${coverage.sic_group ? `yes (${coverage.sic_group.id})` : "no"}. ${coverage.guidance}`,
      coverage,
    ));
    return;
  }
  if (name === "industry_peers") {
    const result = await peersBySic(args);
    sendResult(id, jsonContent(
      `${result.anchor.name}: SIC ${result.sic ?? "unknown"} (${result.sic_description ?? "-"})${result.group ? `, group ${result.group.id}` : ""}. ${result.peers.length} name-matched peers.`,
      result,
    ));
    return;
  }
  if (name === "list_industries") {
    const industries = listIndustries();
    sendResult(id, jsonContent(
      `${industries.length} curated industry map(s): ${industries.map((i) => i.id).join(", ")}. `
      + `Plus ${SIC_GROUPS.length} SIC groups covering every US filer -- use industry_coverage to see which applies.`,
      { curated: industries, sic_groups: SIC_GROUPS },
    ));
    return;
  }
  if (name === "screen_ticker") {
    const result = await screenTicker(args);
    const zh = /中文|chinese|zh/i.test(String(args.language || ""));
    const rows = result.rules.map((r) => (r.skipped
      ? [label(r.label, zh), zh ? "无法计算" : "not computable", "-", skippedMark(zh)]
      : [label(r.label, zh), metricValue(r.value, r.unit), threshold(r.threshold, r.direction, r.unit), mark(r.passed)]));
    const text = [
      table(["Rule", "Measured", "Threshold", "Result"], rows, { title: `${result.ticker}: ${result.verdict}` }),
      result.exemptions.length ? `\nExempted: ${result.exemptions.map((e) => `${e.rule} (${e.reason})`).join("; ")}` : "",
      result.skipped_count ? `\n${result.skipped_count} rule(s) not computable from filings and NOT treated as passes.` : "",
    ].filter(Boolean).join("\n");
    sendResult(id, jsonContent(text, result));
    return;
  }
  if (name === "screen_candidates") {
    const result = await screenBatch({ candidates: args.candidates, asOf: args.as_of });
    const rows = [
      ...result.survivors.map((s2) => [s2.ticker, "survives", `${s2.rules_computed}/${s2.rules_total} rules`, "-"]),
      ...result.eliminated.map((e) => [e.ticker, "**eliminated**", "-",
        e.reasons.map((r) => `${r.rule} ${metricValue(r.measured, r.unit)} vs ${r.threshold}`).join("; ")]),
      ...result.unavailable.map((u) => [u.ticker, "_unavailable_", "-", u.error?.slice(0, 60) ?? ""]),
    ];
    const text = [
      table(["Ticker", "Verdict", "Coverage", "Eliminated by"], rows,
        { title: `Screened ${result.screened}: ${result.survivors.length} survive, ${result.eliminated.length} eliminated` }),
      "\nSurviving is not a recommendation -- these rules eliminate, they never select.",
    ].join("\n");
    sendResult(id, jsonContent(text, result));
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
  if (name === "get_options_chain") {
    const data = await fetchOptionsChain(args.symbol, { asOf: args.as_of });
    if (!data.available) {
      sendResult(id, jsonContent(`No options chain for ${data.symbol}: ${data.reason}`, data));
      return;
    }
    const ref = data.reference_expiry;
    sendResult(id, jsonContent(
      `${data.symbol} options: ${data.contracts_with_iv}/${data.contracts_total} contracts with usable IV, `
      + `reference ATM IV ${ref ? (ref.atm_iv * 100).toFixed(1) + "% at " + ref.dte + "d (" + ref.expiry + ")" : "unavailable"}, `
      + `put/call OI ${data.open_interest.put_call_ratio ?? "n/a"}. Delayed. IV percentile is not computable from this snapshot.`,
      data,
    ));
    return;
  }
  if (name === "get_market_narrative") {
    const data = await getMarketNarrative(args || {});
    const lead = data.themes[0];
    sendResult(id, jsonContent(
      `Market narrative over ${data.window_days}d: ${data.headlines_in_window} headlines in window `
      + `(${data.excluded_outside_window} excluded as stale or undated). `
      + (lead ? `Leading theme: ${lead.label.en} at ${lead.share_of_coverage_pct}% of coverage. ` : "No theme matched. ")
      + `${data.unclassified_headlines} headlines matched no known theme.`,
      data,
    ));
    return;
  }
  if (name === "get_news") {
    const specs = [];
    if (args.symbol) specs.push(tickerNewsFeed(args.symbol));
    if (args.query) specs.push(queryNewsFeed(args.query));
    if (args.cik) specs.push(filingsFeed(args.cik, args.forms || "8-K"));
    if (!specs.length) throw invalidParams("get_news needs at least one of symbol, query or cik");
    const data = await fetchFeeds(specs, { days: args.days ?? 14, asOf: args.as_of ?? null });
    sendResult(id, jsonContent(
      `${data.items.length} headlines in the last ${args.days ?? 14}d from ${data.feeds.filter((f) => f.ok).length}/${data.feeds.length} feeds; `
      + `${data.excluded_outside_window} excluded as stale or undated.`,
      data,
    ));
    return;
  }
  if (name === "get_social_pulse") {
    const data = await getSocialPulse(args || {});
    sendResult(id, jsonContent(
      `Social pulse for ${data.query ?? "(no query)"}: ${data.counts.reddit} Reddit, ${data.counts.hackernews} HN, `
      + `${data.counts.bluesky} Bluesky over ${data.window_days}d. No free X discovery exists, so professional `
      + `FinTwit is NOT covered. Mentions measure attention, not correctness.`,
      data,
    ));
    return;
  }
  if (name === "verify_x_post") {
    const data = await verifyXPost(args.id);
    sendResult(id, jsonContent(
      data.exists ? `Post ${data.id} exists: @${data.author ?? "unknown"} on ${(data.created_at || "").slice(0, 10)}.`
        : `Post ${data.id} could not be confirmed: ${data.reason}.`,
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
