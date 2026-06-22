import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import readline from "node:readline";

const DATA_DIR = process.env.ALPHACOUNCIL_AGENT_DATA_DIR || join(os.homedir(), ".alphacouncil-agent");
const RUNS_DIR = join(DATA_DIR, "runs");
const SERVER_NAME = "alphacouncil-agent";
const VERSION = "0.1.0";
const DEFAULT_TASKS = [
  "market_data",
  "earnings_deep_dive",
  "forward_expectations",
  "sell_side_revisions",
  "earnings_call_transcript",
  "quant_factor",
  "valuation_long_short",
  "news_industry_management",
  "management_industry_voices",
  "insider_sec",
  "ib_event_analysis",
];
const RATINGS = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];
const DEBATE_ROLES = ["bull_researcher", "bear_researcher", "portfolio_manager"];
const OUTPUT_MODES = [
  "chat",
  "documents",
  "pdf",
  "presentations",
  "data_analytics",
  "product_design",
  "creative_production",
  "public_equity",
  "investment_banking",
  "sales",
];

const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function jsonContent(text, structuredContent = {}) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function tool(name, description, inputSchema, annotations = {}) {
  return { name, description, inputSchema, annotations };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function runId(symbol) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return `${symbol.toUpperCase()}-${stamp}`;
}

function safeSymbol(symbol) {
  if (typeof symbol !== "string" || !/^[A-Za-z0-9.^=+\-]{1,32}$/.test(symbol)) {
    throw new Error("symbol must be 1-32 chars and contain only ticker-safe characters.");
  }
  if (/^\.+$/.test(symbol)) throw new Error("symbol cannot be only dots.");
  return symbol.toUpperCase();
}

function normalizeLanguage(value) {
  const text = String(value || "").trim();
  if (!text || /^auto|default|same|follow|跟随|默认$/i.test(text)) return "";
  if (/^(zh|zh-cn|cn|chinese|中文|简体中文|繁体中文)$/i.test(text)) return "中文";
  if (/^(en|en-us|english|英文)$/i.test(text)) return "English";
  if (/^(ja|jp|ja-jp|japanese|日文|日本語)$/i.test(text)) return "日本語";
  if (/^(ko|kr|korean|韩文|韓文|한국어)$/i.test(text)) return "한국어";
  return text.slice(0, 40);
}

function inferLanguage(text = "") {
  if (/[\u3040-\u30ff]/.test(text)) return "日本語";
  if (/[\uac00-\ud7af]/.test(text)) return "한국어";
  if (/[\u3400-\u9fff]/.test(text)) return "中文";
  return "English";
}

function resolveLanguage(args = {}) {
  return normalizeLanguage(args.language || args.output_language || args.user_language) || inferLanguage(args.prompt || args.user_prompt || "");
}

function isChineseLanguage(language) {
  return /中文|chinese|zh/i.test(String(language || ""));
}

function withDisclaimer(markdown, language) {
  const text = typeof markdown === "string" ? markdown : "";
  if (/##\s*(Disclaimer|免责声明)/i.test(text)) return text;
  const note = isChineseLanguage(language)
    ? "\n\n---\n\n## 免责声明\n\n本报告由 AI 自动生成,**仅供教育与研究**,**不构成投资建议**,不构成任何证券买卖推荐或要约。AI 分析可能不完整、过时或错误。投资决策前请自行核实并咨询持牌专业人士。作者不对任何损失承担责任。"
    : "\n\n---\n\n## Disclaimer\n\nThis report is AI-generated for **educational and research purposes only**. It is **not investment advice**, not a recommendation to buy or sell any security, and not a solicitation. AI analysis can be incomplete, outdated, or wrong. Do your own research and consult a licensed professional before any investment decision. The authors accept no liability for any loss.";
  return `${text}${note}`;
}

function runPath(id) {
  if (typeof id !== "string" || !/^[A-Z0-9.^=+\-_]{1,80}$/.test(id)) {
    throw new Error("run_id is invalid.");
  }
  return join(RUNS_DIR, id);
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function appendLimited(base, chunk, max = 20000) {
  const next = `${base}${chunk}`;
  return next.length > max ? next.slice(-max) : next;
}

function cleanLog(value, max = 4000) {
  return String(value || "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .slice(-max);
}

function taskState(run, task) {
  return run.task_status?.[task] || { task, status: "pending" };
}

function agentState(run, role) {
  return run.agent_status?.[role] || { role, status: "pending" };
}

function statusSnapshot(run) {
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    language: run.language,
    execution_mode: run.execution_mode,
    visibility_required: run.visibility_required,
    dry_run: run.dry_run,
    status: run.status,
    phase: run.phase,
    started_at: run.started_at,
    updated_at: run.updated_at,
    completed_at: run.completed_at,
    tasks: run.tasks.map((task) => taskState(run, task)),
    agents: DEBATE_ROLES.map((role) => agentState(run, role)),
  };
}

function writeStatus(run, patch = {}) {
  Object.assign(run, patch, { updated_at: new Date().toISOString() });
  writeJson(join(runPath(run.run_id), "status.json"), statusSnapshot(run));
}

function appendEvent(run, type, data = {}) {
  appendFileSync(join(runPath(run.run_id), "events.jsonl"), `${JSON.stringify({
    at: new Date().toISOString(),
    type,
    ...data,
  })}\n`);
}

function scopedSourceId(task, id, index = 0) {
  const raw = String(id || `S${index + 1}`).trim() || `S${index + 1}`;
  return raw.includes(":") ? raw : `${task}:${raw}`;
}

function sourceManifest(run) {
  const sources = [];
  const known = new Set();
  for (const packet of run.packets || []) {
    for (const source of packet.sources || []) {
      if (!source?.id) continue;
      known.add(source.id);
      sources.push({ task: packet.task, ...source });
    }
  }
  const missing_claim_source_ids = [];
  for (const packet of run.packets || []) {
    for (const claim of packet.claims || []) {
      for (const id of claim.source_ids || []) {
        if (!known.has(id)) missing_claim_source_ids.push({ task: packet.task, source_id: id });
      }
    }
  }
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    source_count: sources.length,
    sources,
    missing_claim_source_ids,
  };
}

function writeSourceManifest(run) {
  writeJson(join(runPath(run.run_id), "source_manifest.json"), sourceManifest(run));
}

function updateTask(run, task, status, patch = {}) {
  run.task_status[task] = { ...taskState(run, task), ...patch, task, status, updated_at: new Date().toISOString() };
  writeStatus(run);
  appendEvent(run, `task_${status}`, { task, ...patch });
}

function updateAgent(run, role, status, patch = {}) {
  run.agent_status[role] = { ...agentState(run, role), ...patch, role, status, updated_at: new Date().toISOString() };
  writeStatus(run);
  appendEvent(run, `agent_${status}`, { role, ...patch });
}

function fence(value, lang = "text") {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `~~~${lang}\n${text.replaceAll("~~~", "~~~\\u200b")}\n~~~`;
}

function bullets(items) {
  if (!Array.isArray(items) || items.length === 0) return "- None";
  return items.map((item) => `- ${typeof item === "string" ? item : JSON.stringify(item)}`).join("\n");
}

function renderPacketMarkdown(packet, index) {
  const claims = packet.claims.length
    ? packet.claims.map((claim, claimIndex) => [
      `${claimIndex + 1}. ${claim.claim || ""}`,
      `   - Evidence: ${claim.evidence || ""}`,
      `   - Confidence: ${claim.confidence || "low"}`,
      `   - Sources: ${(claim.source_ids || []).join(", ") || "None"}`,
    ].join("\n")).join("\n")
    : "No claims.";
  const sources = packet.sources.length
    ? packet.sources.map((source) => `- ${source.id || "S?"}: ${source.title || ""} (${source.published_at || "unknown"}) ${source.url || ""}`).join("\n")
    : "- None";
  return [
    `## Evidence Subagent ${index + 1}: ${packet.task}`,
    "",
    `- Symbol: ${packet.symbol}`,
    `- As-of: ${packet.as_of}`,
    packet.thread_id ? `- Visible thread ID: ${packet.thread_id}` : "",
    packet.thread_title ? `- Visible thread title: ${packet.thread_title}` : "",
    `- Confidence: ${packet.confidence}`,
    "",
    "### Summary",
    packet.summary || "",
    "",
    "### Claims",
    claims,
    "",
    "### Metrics",
    fence(packet.metrics || {}, "json"),
    "",
    "### Sources",
    sources,
    "",
    "### Open Questions",
    bullets(packet.open_questions),
    "",
    "### Raw Output / Prompt",
    fence(packet.raw_text || "", "text"),
  ].join("\n");
}

function renderDebateMarkdown(agent) {
  if (!agent) return "";
  return [
    `## ${agent.role}`,
    "",
    `- Rating: ${agent.rating}`,
    `- Winner: ${agent.winner}`,
    `- Verdict: ${agent.verdict}`,
    `- Confidence: ${agent.confidence}`,
    agent.thread_id ? `- Visible thread ID: ${agent.thread_id}` : "",
    agent.thread_title ? `- Visible thread title: ${agent.thread_title}` : "",
    "",
    "### Summary",
    agent.summary || "",
    "",
    "### Long Thesis",
    bullets(agent.long_thesis),
    "",
    "### Short Thesis",
    bullets(agent.short_thesis),
    "",
    "### Valuation Range",
    agent.valuation_range || "None",
    "",
    "### Catalysts",
    bullets(agent.catalysts),
    "",
    "### Risks",
    bullets(agent.risks),
    "",
    "### Position",
    agent.position || "None",
    "",
    "### Invalidation",
    bullets(agent.invalidation),
    "",
    "### Source IDs",
    bullets(agent.source_ids),
    "",
    "### Report Markdown",
    agent.report_markdown || "",
    "",
    "### Raw Output / Prompt",
    fence(agent.raw_text || "", "text"),
  ].join("\n");
}

function writeAllAgentsMarkdown(run, debate = {}) {
  const dir = runPath(run.run_id);
  const taskStatus = run.tasks.map((task) => {
    const state = taskState(run, task);
    return `- ${task}: ${state.status}${state.output ? ` (${state.output})` : ""}${state.error ? ` - ${state.error}` : ""}`;
  }).join("\n");
  const agentStatus = DEBATE_ROLES.map((role) => {
    const state = agentState(run, role);
    return `- ${role}: ${state.status}${state.output ? ` (${state.output})` : ""}${state.error ? ` - ${state.error}` : ""}`;
  }).join("\n");
  const sections = [
    `# AlphaCouncil Agent Full Agent Trace: ${run.symbol}`,
    "",
    "## Run Metadata",
    "",
    `- Run ID: ${run.run_id}`,
    `- Symbol: ${run.symbol}`,
    `- As-of: ${run.as_of}`,
    `- Language: ${run.language || "auto"}`,
    `- Execution mode: ${run.execution_mode || "background_codex_exec"}`,
    `- Visibility required: ${run.visibility_required || false}`,
    `- Dry run: ${run.dry_run}`,
    `- Status: ${run.status || "unknown"}`,
    `- Phase: ${run.phase || "unknown"}`,
    `- Started: ${run.started_at}`,
    `- Updated: ${run.updated_at || ""}`,
    `- Completed: ${run.completed_at || ""}`,
    `- Tasks: ${run.tasks.join(", ")}`,
    "",
    "## Task Status",
    "",
    taskStatus || "- None",
    "",
    "## Analyst Status",
    "",
    agentStatus || "- None",
    "",
    "# Evidence Subagents",
    "",
    ...run.packets.map(renderPacketMarkdown),
  ];
  if (debate.bull || debate.bear || debate.manager) {
    sections.push(
      "",
      "# Analyst Debate And Portfolio Manager",
      "",
      renderDebateMarkdown(debate.bull),
      "",
      renderDebateMarkdown(debate.bear),
      "",
      renderDebateMarkdown(debate.manager),
    );
  }
  const path = join(dir, "all_agents.md");
  writeFileSync(path, `${sections.filter(Boolean).join("\n\n")}\n`);
  return path;
}

function taskPrompt(task, symbol, asOfDate, userPrompt = "", language = "auto") {
  const resolvedLanguage = resolveLanguage({ language, prompt: userPrompt });
  if (isChineseLanguage(resolvedLanguage)) {
    const base = [
      `你是 ${symbol} 股票研究流程里的一个叶子证据子代理，只负责自己的任务。`,
      `分析日期：${asOfDate}。必须使用精确日期，区分信号日期、来源发布日期和检索日期。`,
      "不要调用 alphacouncil-agent 插件/MCP 工具、collect_evidence、analyze_symbol、read_run，也不要再启动嵌套子代理；直接产出本子代理的证据包。",
      "只返回合法 JSON，不要 Markdown 代码块。",
      "JSON 字段名保持英文；summary、claims、evidence、open_questions 等面向读者的字段内容用中文。ticker、URL、source id、rating enum 保持英文或原文。",
      "Schema: {\"task\":\"string\",\"symbol\":\"string\",\"as_of\":\"YYYY-MM-DD\",\"summary\":\"string\",\"claims\":[{\"claim\":\"string\",\"evidence\":\"string\",\"confidence\":\"high|medium|low\",\"source_ids\":[\"S1\"]}],\"metrics\":{},\"sources\":[{\"id\":\"S1\",\"title\":\"string\",\"url\":\"string\",\"published_at\":\"YYYY-MM-DD or unknown\",\"retrieved_at\":\"YYYY-MM-DD\"}],\"open_questions\":[\"string\"],\"confidence\":\"high|medium|low\"}.",
      "如果数据不可得，要直接说明并降低 confidence；不要编造私人或非公开信息。",
      userPrompt ? `用户目标：${userPrompt}` : "",
    ].filter(Boolean).join("\n");
    const prompts = {
      market_data: "使用联网搜索和可靠行情页面，总结近期股价变动、价格趋势、成交量、可得的估值 headline multiples 和技术面背景。优先使用交易所、公司公告、SEC/监管文件和可信金融媒体。",
      earnings_deep_dive: "使用 Public Equity Investing 思路。分析最新财报、收入、毛利率、关键业务分部表现、指引、现金流、资产负债表和最近一次 earnings call transcript。重点判断哪些信息支持或削弱做多 thesis。",
      forward_expectations: "使用 Public Equity Investing 思路。分析未来 1/3/6 个月市场预期和隐含门槛：公司 guidance、sell-side consensus、收入/EPS/EBIT 或 comparable operating profit 预期、beat/miss thresholds、催化剂日历，以及股价已经 price in 了什么。",
      sell_side_revisions: "使用联网搜索和可靠金融来源。收集分析师评级上调/下调、目标价变化、EPS/revenue/EBIT 或 comparable operating profit 预期修正、共识分歧和日期。没有可靠来源时要明确说明不可得。",
      earnings_call_transcript: "使用 Public Equity Investing 思路。读取最近一次 earnings call prepared remarks 和 Q&A；总结管理层语气、指引措辞变化、分析师追问重点、相对上一季的变化，以及哪些表述支持或反驳 investment thesis。",
      quant_factor: "你是量化组合经理视角的因子证据代理。使用可验证行情和金融数据，分析动能、趋势、相对强弱、成交量/流动性、波动率、回撤、均线/RSI/MACD等技术背景、short interest、borrow、options skew/IV/expected move（能取到才写）。不要做未经验证的回测；把缺失因子数据列入 open_questions。",
      valuation_long_short: "使用 Public Equity Investing 思路。构建 long/short pitch：核心 thesis、bear case、估值区间、催化剂时间表、风险和仓位建议。估值必须锚定明确假设，能找到可比倍数时要引用。",
      news_industry_management: "使用联网搜索。收集近期公司新闻、行业新闻、CEO/管理层公开发言、investor day 材料、会议发言和电话会评论，并标注来源质量。",
      management_industry_voices: "使用联网搜索。专门调查可公开验证的人物发言：CEO/CFO/高管/董事会、公司内部公开口径、客户、供应商、竞争对手、监管方、行业专家和渠道人士。区分原话、转述和媒体解读；总结语气变化、分歧点、可信度、与公司 guidance/市场预期是否一致，以及这些发言对 long/short thesis 的影响。不得使用或暗示非公开内部信息。",
      insider_sec: "使用联网搜索。检查 SEC filings、Form 4 insider transactions、10-Q/10-K/8-K、风险因素、股权稀释、回购和资本回报披露，筛选与投资 thesis 相关的信息。",
      ib_event_analysis: "使用 Investment Banking 思路。查找相关 ECM、M&A、战略投资、债务、回购或资本配置事件。如果存在交易，分析 EPS、稀释、净现金、估值倍数、溢价、accretion/dilution、协同效应和股价压力；如果没有相关交易，要带来源说明没有找到。",
    };
    return `${base}\n\n任务：${task}\n${prompts[task] || "收集与投资决策相关的证据。"}`;
  }

  const base = [
    `You are one leaf research worker in a larger equity research workflow for ${symbol}.`,
    `As-of date: ${asOfDate}. Use exact dates; separate signal date, source date, and retrieval date.`,
    "Do not call the alphacouncil-agent plugin/MCP tools, collect_evidence, analyze_symbol, read_run, or spawn nested subagents. Produce this worker's packet directly.",
    "Return ONLY valid JSON. No markdown fences.",
    `Keep JSON field names in English. Write reader-facing fields such as summary, claims, evidence, and open_questions in ${resolvedLanguage}. Keep tickers, URLs, source IDs, and rating enums in English/original form.`,
    "Schema: {\"task\":\"string\",\"symbol\":\"string\",\"as_of\":\"YYYY-MM-DD\",\"summary\":\"string\",\"claims\":[{\"claim\":\"string\",\"evidence\":\"string\",\"confidence\":\"high|medium|low\",\"source_ids\":[\"S1\"]}],\"metrics\":{},\"sources\":[{\"id\":\"S1\",\"title\":\"string\",\"url\":\"string\",\"published_at\":\"YYYY-MM-DD or unknown\",\"retrieved_at\":\"YYYY-MM-DD\"}],\"open_questions\":[\"string\"],\"confidence\":\"high|medium|low\"}.",
    "If data is unavailable, say so directly and lower confidence. Do not invent private or non-public information.",
    userPrompt ? `User objective: ${userPrompt}` : "",
  ].filter(Boolean).join("\n");
  const prompts = {
    market_data: "Use live web search and reliable market pages to summarize recent stock move, price trend, volume, valuation headline multiples if available, and technical context. Prefer official exchange/company/filing sources and reputable finance sources.",
    earnings_deep_dive: "Use Public Equity Investing. Analyze the latest earnings, revenue, gross margin, key segment performance, guidance, cash flow, balance sheet, and the last earnings call transcript. Focus on what supports or weakens a long thesis.",
    forward_expectations: "Use Public Equity Investing. Analyze 1/3/6-month market expectations and implied thresholds: company guidance, sell-side consensus, revenue/EPS/EBIT or comparable operating profit expectations, beat/miss thresholds, catalyst calendar, and what the stock already prices in.",
    sell_side_revisions: "Use live web search and reputable finance sources. Collect analyst upgrades/downgrades, target price changes, EPS/revenue/EBIT or comparable operating profit estimate revisions, dispersion, and dates. State clearly when reliable data is unavailable.",
    earnings_call_transcript: "Use Public Equity Investing. Read the latest earnings call prepared remarks and Q&A; summarize management tone, guidance-language changes, analyst question themes, changes versus the prior call, and which statements support or challenge the investment thesis.",
    quant_factor: "You are a quant portfolio-manager factor evidence worker. Using verifiable market and finance data, analyze momentum, trend, relative strength, volume/liquidity, volatility, drawdown, moving averages/RSI/MACD or similar technical context, short interest, borrow, options skew/IV/expected move when available. Do not invent or imply an unverified backtest; put unavailable factor data in open_questions.",
    valuation_long_short: "Use Public Equity Investing. Build a long/short pitch with core thesis, bear case, valuation range, catalyst calendar, risks, and position sizing. Anchor valuation in explicit assumptions and comparable multiples when available.",
    news_industry_management: "Use live web search. Gather recent company news, industry news, CEO or management public remarks, investor-day material, conference comments, and call commentary. Flag source quality.",
    management_industry_voices: "Use live web search. Focus only on publicly verifiable human commentary: CEO/CFO/executives/board, official company internal messaging made public, customers, suppliers, competitors, regulators, industry experts, and channel voices. Separate direct quotes, paraphrases, and media interpretation; summarize tone changes, disagreement points, credibility, consistency with guidance/market expectations, and impact on the long/short thesis. Do not use or imply non-public inside information.",
    insider_sec: "Use live web search. Review SEC filings, Form 4 insider transactions, 10-Q/10-K/8-K items, risk factors, shareholder dilution, buyback, and capital return disclosures relevant to the equity thesis.",
    ib_event_analysis: "Use Investment Banking. Look for relevant ECM, M&A, strategic investment, debt, buyback, or capital allocation events. If a transaction exists, analyze EPS, dilution, net cash, valuation multiple, premium, accretion/dilution, synergies, and stock-pressure implications. If no relevant transaction exists, return that finding with sources.",
  };
  return `${base}\n\nTask: ${task}\n${prompts[task] || "Collect evidence relevant to the investment decision."}`;
}

function visibleRun(args) {
  const symbol = safeSymbol(args.symbol);
  const asOfDate = args.as_of || today();
  const id = args.run_id || runId(symbol);
  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : DEFAULT_TASKS;
  const language = resolveLanguage(args);
  const dir = runPath(id);
  mkdirSync(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const run = {
    run_id: id,
    symbol,
    as_of: asOfDate,
    language,
    dry_run: false,
    execution_mode: "visible_host_threads",
    visibility_required: true,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "planned",
    phase: "visible_planned",
    tasks,
    task_status: Object.fromEntries(tasks.map((task) => [task, { task, status: "pending" }])),
    agent_status: Object.fromEntries(DEBATE_ROLES.map((role) => [role, { role, status: "pending" }])),
    packets: [],
  };
  writeStatus(run);
  appendEvent(run, "visible_run_planned", { tasks });
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeAllAgentsMarkdown(run);
  return run;
}

function visibleAgentSpecs(run, userPrompt = "") {
  const evidence_agents = run.tasks.map((task) => ({
    role: task,
    title: isChineseLanguage(run.language) ? `AlphaCouncil Agent ${run.symbol} ${task} 证据子代理` : `AlphaCouncil Agent ${run.symbol} ${task} evidence subagent`,
    prompt: taskPrompt(task, run.symbol, run.as_of, userPrompt, run.language),
    output_contract: isChineseLanguage(run.language) ? "只返回一个 JSON evidence packet。" : `Return one JSON evidence packet with reader-facing fields in ${run.language}.`,
  }));
  const debate_agents = DEBATE_ROLES.map((role) => ({
    role,
    title: `AlphaCouncil Agent ${run.symbol} ${role}`,
    prompt_template: [
      debatePrompt(role, run),
      "",
      isChineseLanguage(run.language) ? "主线程必须先粘贴已完成的 Evidence JSON，再运行这个可见代理。" : "The main thread must paste the completed Evidence JSON before running this visible agent.",
      role === "bear_researcher" ? (isChineseLanguage(run.language) ? "主线程还必须粘贴 Bull argument JSON。" : "The main thread must also paste Bull argument JSON.") : "",
      role === "portfolio_manager" ? (isChineseLanguage(run.language) ? "主线程还必须粘贴 Bull 和 Bear argument JSON。" : "The main thread must also paste Bull and Bear argument JSON.") : "",
    ].filter(Boolean).join("\n"),
    output_contract: isChineseLanguage(run.language) ? "只返回一个 JSON debate packet。" : `Return one JSON debate packet with reader-facing fields in ${run.language}.`,
  }));
  return { evidence_agents, debate_agents };
}

function existingDebate(dir) {
  return {
    bull: existsSync(join(dir, "bull_researcher.json")) ? readJson(join(dir, "bull_researcher.json")) : null,
    bear: existsSync(join(dir, "bear_researcher.json")) ? readJson(join(dir, "bear_researcher.json")) : null,
    manager: existsSync(join(dir, "manager_synthesis.json")) ? readJson(join(dir, "manager_synthesis.json")) : null,
  };
}

function visibleStatusAfterPacket(run) {
  if (agentState(run, "portfolio_manager").status === "completed") {
    return { status: "complete", phase: "complete", completed_at: run.completed_at || new Date().toISOString() };
  }
  if (DEBATE_ROLES.some((role) => agentState(run, role).status === "completed")) {
    return { status: "running", phase: "visible_debate", completed_at: null };
  }
  return { status: "running", phase: "visible_evidence", completed_at: null };
}

function rawRecordText(packet) {
  if (typeof packet?.raw_text === "string" && packet.raw_text.trim()) return packet.raw_text;
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return JSON.stringify(packet || {}, null, 2);
  const { raw_text, ...withoutRawText } = packet;
  return JSON.stringify(withoutRawText, null, 2);
}

function saveRun(run) {
  writeJson(join(runPath(run.run_id), "evidence.json"), run);
  writeSourceManifest(run);
  writeStatus(run);
}

function recordVisiblePacket(args) {
  const run = readJson(join(runPath(args.run_id), "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw new Error("record_visible_packet requires a run created by plan_visible_run.");
  }
  const task = args.task;
  if (!run.tasks.includes(task)) throw new Error(`Unknown task for this run: ${task}`);
  const dir = runPath(run.run_id);
  const packet = normalizePacket({
    ...(args.packet || {}),
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    execution_mode: "visible_host_threads",
  }, task, run.symbol, run.as_of, rawRecordText(args.packet));
  const byTask = new Map(run.packets.map((item) => [item.task, item]));
  byTask.set(task, packet);
  run.packets = run.tasks.map((item) => byTask.get(item)).filter(Boolean);
  Object.assign(run, visibleStatusAfterPacket(run));
  writeJson(join(dir, `${task}.json`), packet);
  saveRun(run);
  updateTask(run, task, "completed", {
    completed_at: new Date().toISOString(),
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    output: join(dir, `${task}.json`),
  });
  writeJson(join(dir, "evidence.json"), run);
  writeAllAgentsMarkdown(run, existingDebate(dir));
  return run;
}

function recordVisibleDecision(args) {
  const run = readJson(join(runPath(args.run_id), "evidence.json"));
  if (run.execution_mode !== "visible_host_threads") {
    throw new Error("record_visible_decision requires a run created by plan_visible_run.");
  }
  const role = args.role;
  if (!DEBATE_ROLES.includes(role)) throw new Error(`Unknown decision role: ${role}`);
  const dir = runPath(run.run_id);
  const packet = normalizeDebate({
    ...(args.packet || {}),
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    execution_mode: "visible_host_threads",
  }, role, run, rawRecordText(args.packet));
  const file = role === "portfolio_manager" ? "manager_synthesis.json" : `${role}.json`;
  writeJson(join(dir, file), packet);
  if (role === "portfolio_manager") {
    writeJson(join(dir, "decision.json"), packet);
    writeFileSync(join(dir, "final_report.md"), `${withDisclaimer(packet.report_markdown || packet.summary, run.language)}\n`);
    run.status = "complete";
    run.phase = "complete";
    run.completed_at = new Date().toISOString();
  } else {
    run.status = "running";
    run.phase = "visible_debate";
  }
  saveRun(run);
  updateAgent(run, role, "completed", {
    completed_at: new Date().toISOString(),
    thread_id: args.thread_id,
    thread_title: args.thread_title,
    output: join(dir, file),
  });
  writeJson(join(dir, "evidence.json"), run);
  if (role === "portfolio_manager") appendEvent(run, "run_complete", { decision: packet.rating, winner: packet.winner });
  writeAllAgentsMarkdown(run, existingDebate(dir));
  return { run, decision: packet };
}

function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("subagent did not return JSON");
  }
}

function normalizePacket(packet, task, symbol, asOfDate, raw = "") {
  const sourceIdMap = new Map();
  const sources = Array.isArray(packet?.sources) ? packet.sources.map((source, index) => {
    const original = String(source?.id || `S${index + 1}`);
    const id = scopedSourceId(task, original, index);
    sourceIdMap.set(original, id);
    return { ...(source && typeof source === "object" ? source : {}), id };
  }) : [];
  const claims = Array.isArray(packet?.claims) ? packet.claims.map((claim) => ({
    ...(claim && typeof claim === "object" ? claim : {}),
    source_ids: Array.isArray(claim?.source_ids)
      ? claim.source_ids.map((id) => sourceIdMap.get(String(id)) || scopedSourceId(task, id)).filter(Boolean)
      : [],
  })) : [];
  return {
    task,
    symbol,
    as_of: asOfDate,
    summary: typeof packet?.summary === "string" ? packet.summary : raw.slice(0, 4000),
    claims,
    metrics: packet?.metrics && typeof packet.metrics === "object" ? packet.metrics : {},
    sources,
    open_questions: Array.isArray(packet?.open_questions) ? packet.open_questions : [],
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low",
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    thread_title: typeof packet?.thread_title === "string" ? packet.thread_title : undefined,
    execution_mode: typeof packet?.execution_mode === "string" ? packet.execution_mode : undefined,
    raw_text: raw,
  };
}

function normalizeDebate(packet, role, run, raw = "") {
  return {
    role,
    symbol: run.symbol,
    as_of: run.as_of,
    verdict: typeof packet?.verdict === "string" ? packet.verdict : "",
    rating: RATINGS.includes(packet?.rating) ? packet.rating : "Hold",
    winner: ["bull", "bear", "balanced", "unknown"].includes(packet?.winner) ? packet.winner : "unknown",
    summary: typeof packet?.summary === "string" ? packet.summary : raw.slice(0, 4000),
    long_thesis: Array.isArray(packet?.long_thesis) ? packet.long_thesis : [],
    short_thesis: Array.isArray(packet?.short_thesis) ? packet.short_thesis : [],
    valuation_range: typeof packet?.valuation_range === "string" ? packet.valuation_range : "",
    catalysts: Array.isArray(packet?.catalysts) ? packet.catalysts : [],
    risks: Array.isArray(packet?.risks) ? packet.risks : [],
    position: typeof packet?.position === "string" ? packet.position : "",
    invalidation: Array.isArray(packet?.invalidation) ? packet.invalidation : [],
    source_ids: Array.isArray(packet?.source_ids) ? packet.source_ids : [],
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low",
    report_markdown: typeof packet?.report_markdown === "string" ? packet.report_markdown : "",
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    thread_title: typeof packet?.thread_title === "string" ? packet.thread_title : undefined,
    execution_mode: typeof packet?.execution_mode === "string" ? packet.execution_mode : undefined,
    raw_text: raw,
  };
}

function dryPacket(task, symbol, asOfDate, prompt, language = "English") {
  const chinese = isChineseLanguage(language);
  return normalizePacket({
    summary: chinese ? `已计划 ${symbol} 的 ${task} 子代理。` : `Planned ${task} subagent for ${symbol}.`,
    claims: [{
      claim: chinese ? "仅 dry run；没有执行外部研究。" : "Dry run only; no external research executed.",
      evidence: chinese ? "生成的 prompt 已保存在 raw_text。" : "The generated prompt is stored in raw_text.",
      confidence: "low",
      source_ids: [],
    }],
    open_questions: [chinese ? "不要传 dry_run，或传 dry_run=false，即可执行 Codex 子代理。" : "Run again without dry_run, or with dry_run=false, to execute Codex subagents."],
    confidence: "low",
  }, task, symbol, asOfDate, prompt);
}

function dryDebate(role, run, prompt) {
  const chinese = isChineseLanguage(run.language);
  return normalizeDebate({
    verdict: "DRY_RUN",
    rating: "Hold",
    winner: "unknown",
    summary: chinese ? `已计划 ${run.symbol} 的 ${role} 综合。` : `Planned ${role} synthesis for ${run.symbol}.`,
    confidence: "low",
    report_markdown: chinese ? `# ${run.symbol} ${role}\n\n仅 dry run。\n` : `# ${run.symbol} ${role}\n\nDry run only.\n`,
  }, role, run, prompt);
}

function runCodex(prompt, timeoutMs, onStart = () => {}, onHeartbeat = () => {}) {
  return new Promise((resolvePromise) => {
    mkdirSync(DATA_DIR, { recursive: true });
    const outFile = join(DATA_DIR, `codex-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    const args = [
      "--search",
      "-s",
      "read-only",
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "-C",
      DATA_DIR,
      "-o",
      outFile,
      prompt,
    ];
    const child = spawn("codex", args, { cwd: DATA_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    onStart({ pid: child.pid, output: outFile });
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(value);
    };
    const heartbeat = setInterval(() => {
      onHeartbeat({ pid: child.pid, output: outFile, elapsed_ms: Date.now() - startedAt });
    }, 30000);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      killTimer = setTimeout(() => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);
    // ponytail: drain both pipes; switch to streaming logs if progress UI needs live CLI output.
    child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk.toString()); });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk.toString()); });
    child.on("error", (error) => {
      finish({ ok: false, code: null, text: "", stderr: String(error.message || error), stdout, outFile, timedOut });
    });
    child.on("close", (code) => {
      let text = "";
      if (existsSync(outFile)) text = readFileSync(outFile, "utf8");
      finish({ ok: code === 0 && text.trim().length > 0, code, text, stderr, stdout, outFile, timedOut });
    });
  });
}

function compactEvidence(run) {
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    packets: run.packets.map((packet) => ({
      task: packet.task,
      summary: packet.summary,
      claims: packet.claims,
      metrics: packet.metrics,
      sources: packet.sources,
      open_questions: packet.open_questions,
      confidence: packet.confidence,
    })),
  };
}

function debatePrompt(role, run, context = {}) {
  const evidencePath = join(runPath(run.run_id), "evidence.json");
  const evidenceJson = JSON.stringify(compactEvidence(run));
  const language = run.language || "English";
  const chinese = isChineseLanguage(language);
  const base = chinese ? [
    `你是 ${run.symbol} 投资组合研究辩论里的 ${role}。`,
    `分析日期：${run.as_of}。Evidence file: ${evidencePath}.`,
    "只能使用提供的 evidence 和其中的公开来源引用；证据缺失就明确说明。",
    "不要调用 alphacouncil-agent 插件/MCP 工具、collect_evidence、analyze_symbol、read_run，也不要启动嵌套子代理；直接产出本分析师 packet。",
    "面向读者的字段内容用中文；ticker、source ID 和 rating enum 保持英文。",
    "只返回合法 JSON，不要 Markdown 代码块。",
    "Rating enum: Buy, Overweight, Hold, Underweight, Sell.",
    "Schema: {\"role\":\"string\",\"symbol\":\"string\",\"as_of\":\"YYYY-MM-DD\",\"verdict\":\"string\",\"rating\":\"Buy|Overweight|Hold|Underweight|Sell\",\"winner\":\"bull|bear|balanced|unknown\",\"summary\":\"string\",\"long_thesis\":[\"string\"],\"short_thesis\":[\"string\"],\"valuation_range\":\"string\",\"catalysts\":[\"string\"],\"risks\":[\"string\"],\"position\":\"string\",\"invalidation\":[\"string\"],\"source_ids\":[\"market_data:S1\"],\"confidence\":\"high|medium|low\",\"report_markdown\":\"string\"}.",
  ] : [
    `You are the ${role} in a portfolio research debate for ${run.symbol}.`,
    `As-of date: ${run.as_of}. Evidence file: ${evidencePath}.`,
    "Use only the provided evidence and public-source citations in it. If evidence is missing, say so.",
    "Do not call the alphacouncil-agent plugin/MCP tools, collect_evidence, analyze_symbol, read_run, or spawn nested subagents. Produce this analyst packet directly.",
    `Write all reader-facing fields in ${language}. Keep ticker, source IDs, and rating enum in English/original form.`,
    "Return ONLY valid JSON. No markdown fences.",
    "Rating enum: Buy, Overweight, Hold, Underweight, Sell.",
    "Schema: {\"role\":\"string\",\"symbol\":\"string\",\"as_of\":\"YYYY-MM-DD\",\"verdict\":\"string\",\"rating\":\"Buy|Overweight|Hold|Underweight|Sell\",\"winner\":\"bull|bear|balanced|unknown\",\"summary\":\"string\",\"long_thesis\":[\"string\"],\"short_thesis\":[\"string\"],\"valuation_range\":\"string\",\"catalysts\":[\"string\"],\"risks\":[\"string\"],\"position\":\"string\",\"invalidation\":[\"string\"],\"source_ids\":[\"market_data:S1\"],\"confidence\":\"high|medium|low\",\"report_markdown\":\"string\"}.",
  ];
  const roleText = chinese ? {
    bull_researcher: "你站在多头一方。构建最强 long case，引用 evidence IDs，直接回应空头攻击；只有证据足够时才建议 Buy/Overweight/Hold。",
    bear_researcher: "你站在空头一方。构建最强 short/underweight case，引用 evidence IDs，攻击多头假设里的薄弱处；只有证据足够时才建议 Sell/Underweight/Hold。",
    portfolio_manager: "你是最终 Portfolio Manager。读取 evidence、多头论证和空头论证，判断谁赢了：bull、bear 或 balanced。输出最终 rating、仓位建议、估值区间、催化剂、风险、反证条件、置信度，以及正式中文报告。报告必须是完整投资委员会报告，读者不打开附件也能看懂全貌。报告必须包括独立可见章节：结论、分析师工作记录、多空辩论记录、多头观点、空头观点、市场预期与隐含门槛、分析师评级/目标价变化、电话会管理层信号、量化/因子视角、新闻和公司/行业人物发言信号、short interest / borrow / options 信息、战略交易或 NVIDIA 条款、估值区间、关键催化剂、主要风险、仓位建议、短线 1-4 周 / 中期 3-6 个月 / 长期 12 个月判断、数据缺口/未覆盖项、反证条件、置信度、来源表。分析师工作记录必须逐个总结 evidence agent 的核心数据、新闻、财报、SEC、量化和估值发现。多空辩论记录必须总结 bull、bear 的核心论点、反驳、未解决问题和最终胜负。不要写“可见版”“lite”“smoke test”“debug”“没有改成某输出格式”等执行说明。不要只在来源表里提到新闻或人物发言。任何缺失数据都必须在“数据缺口/未覆盖项”列出；如果没有关键缺口，也必须写“未发现关键数据缺口”。",
  }[role] || "产出投资组合辩论 memo。" : {
    bull_researcher: "Take the bullish side. Build the strongest long case, cite evidence IDs, address the bear case directly, and recommend Buy/Overweight/Hold only if warranted.",
    bear_researcher: "Take the bearish side. Build the strongest short/underweight case, cite evidence IDs, attack weak assumptions in the bull case, and recommend Sell/Underweight/Hold only if warranted.",
    portfolio_manager: `You are the final Portfolio Manager. Read the evidence plus bull and bear arguments. Decide who won: bull, bear, or balanced. Output the final rating, position sizing, valuation range, catalysts, risks, invalidation, confidence, and a polished final report in ${language}. The report must be a complete investment-committee report that is readable without opening attachments. It must include separate visible sections for conclusion, analyst work log, bull/bear debate record, long thesis, short thesis, market expectations and implied thresholds, analyst rating/target-price revisions, earnings-call management signals, quant factor / technical risk view, news and company/industry voice signals, short interest / borrow / options information, strategic transaction or NVIDIA terms, valuation range, key catalysts, major risks, position recommendation, separate short-term 1-4 week / medium-term 3-6 month / long-term 12 month views, data gaps / unavailable data, invalidation conditions, confidence, and source table. The analyst work log must summarize every evidence agent's key data, news, earnings, filings, quant, and valuation findings. The debate record must summarize the bull case, bear case, rebuttal, unresolved questions, and winner. Do not write execution labels such as "visible version", "lite", "smoke test", "debug", or explain that another output format was not used. Do not hide news or voice work only in the source table. List every missing data item in the data-gaps section; if no critical item is missing, state that no critical data gaps were found.`,
  }[role] || "Produce a portfolio debate memo.";

  return [
    ...base,
    roleText,
    context.bull ? `Bull argument JSON: ${JSON.stringify(context.bull)}` : "",
    context.bear ? `Bear argument JSON: ${JSON.stringify(context.bear)}` : "",
    role === "portfolio_manager" ? outputModeInstruction(context.outputMode || "chat", language) : "",
    `Evidence JSON: ${evidenceJson}`,
  ].filter(Boolean).join("\n\n");
}

function summaryModes() {
  return [
    {
      mode: "chat",
      best_for: "默认最终答复、快速判断、直接复制到聊天窗口。",
      effect: "一页中文投资委员会结论，先给 Buy/Overweight/Hold/Underweight/Sell，再给多空胜负和证据。",
      fit: "best_default",
    },
    {
      mode: "documents",
      best_for: "正式投资备忘录、IC memo、可继续编辑的 Word/Google Docs 文档。",
      effect: "更像严肃 memo：封面信息、执行摘要、论证、来源附录、风险和反证条件。",
      fit: "best_formal_memo",
    },
    {
      mode: "pdf",
      best_for: "只读交付、归档、对外发送、版式固定的正式报告。",
      effect: "内容应先按报告写好，再渲染为 PDF；适合最终版，不适合迭代。",
      fit: "best_locked_report",
    },
    {
      mode: "presentations",
      best_for: "投资委员会汇报、pitch deck、老板快速看结论。",
      effect: "8-10 页 slide outline：结论页、多头页、空头页、估值页、催化剂页、风险页、仓位页。",
      fit: "best_committee_deck",
    },
    {
      mode: "data_analytics",
      best_for: "指标表、KPI、估值敏感性、可视化 dashboard。",
      effect: "适合把 revenue、margin、multiple、scenario 做成表和图；不适合单独写最终投资判断。",
      fit: "supporting_analytics",
    },
    {
      mode: "public_equity",
      best_for: "上市股票 long/short、财报、估值、催化剂、仓位建议。",
      effect: "最适合作为研究子代理和最终 PM memo 的核心材料。",
      fit: "best_research_brain",
    },
    {
      mode: "investment_banking",
      best_for: "增发、并购、融资、稀释、accretion/dilution、交易影响。",
      effect: "适合写交易事件章节；普通 NVDA long/short 不应让它主导最终结论。",
      fit: "event_specialist",
    },
    {
      mode: "product_design",
      best_for: "把结果做成产品界面、研究终端、交互式工作台。",
      effect: "不适合投资总结本体；适合以后做 AlphaCouncil Agent UI。",
      fit: "not_for_investment_summary",
    },
    {
      mode: "creative_production",
      best_for: "营销图、视觉素材、宣传海报。",
      effect: "不适合金融研究总结。",
      fit: "not_for_investment_summary",
    },
    {
      mode: "sales",
      best_for: "客户沟通、销售跟进、账户策略。",
      effect: "不适合股票投资委员会结论。",
      fit: "not_for_investment_summary",
    },
  ];
}

function outputModeInstruction(mode, language = "English") {
  const selected = OUTPUT_MODES.includes(mode) ? mode : "public_equity";
  const picked = summaryModes().find((item) => item.mode === selected);
  const chinese = isChineseLanguage(language);
  return [
    chinese ? "最终报告语言：中文。" : `Final report language: ${language}.`,
    `Final output mode: ${selected}.`,
    `Mode purpose: ${picked?.best_for || ""}`,
    `Mode effect: ${picked?.effect || ""}`,
    chinese
      ? "report_markdown 必须是完整正文，不是运行说明。必须包含“分析师工作记录”和“多空辩论记录”；禁止写“可见版”“lite”“smoke test”“debug”“没有使用某输出格式”等执行标签。"
      : "report_markdown must be the complete report body, not an execution note. Include Analyst Work Log and Bull/Bear Debate Record; do not write execution labels such as visible version, lite, smoke test, debug, or mention that another output format was not used.",
    selected === "presentations"
      ? "In report_markdown, write a slide-by-slide outline with slide titles and concise bullets, not dense prose."
      : "",
    selected === "documents"
      ? "In report_markdown, write a formal investment memo suitable for DOCX conversion: title, executive summary, recommendation, evidence, risks, source appendix."
      : "",
    selected === "pdf"
      ? "In report_markdown, write a polished locked-report structure with page-ready headings, source table, and concise executive summary."
      : "",
    selected === "data_analytics"
      ? "In report_markdown, emphasize tables, chart specs, metrics, scenario sensitivity, and dashboard-ready fields."
      : "",
    selected === "public_equity"
      ? "In report_markdown, write like a Public Equity Investing memo-builder final output: Recommendation / Decision Ask, Executive Summary, Thesis and Evidence, What Must Be True, Valuation / Scenario Work, Risks and Disconfirmers, Catalysts and Monitoring, Short / Medium / Long-Term View, Implementation Considerations, Open Items, and Source Table. Make it read like a PM-facing equity research report, not a generic chatbot answer."
      : "",
    selected === "investment_banking"
      ? "In report_markdown, write the final synthesis like a banker event-analysis section only when transaction evidence exists: transaction overview, dilution/accretion, EPS/share-count impact, net cash/debt, valuation multiple, stock-pressure implications, and deal risks. If there is no live transaction, state that Investment Banking is supporting context rather than the final owner."
      : "",
    ["product_design", "creative_production", "sales"].includes(selected)
      ? "State that this mode is not recommended for the investment decision itself; provide only how it could support packaging or downstream use."
      : "",
  ].filter(Boolean).join("\n");
}

function debateFromCodex(result, role, run, fallbackPrompt) {
  if (!result.ok) return dryDebate(role, run, cleanLog(result.stderr || result.text || fallbackPrompt));
  try {
    return normalizeDebate(extractJson(result.text), role, run, result.text);
  } catch {
    return normalizeDebate({
      verdict: "PARSE_FAILED",
      rating: "Hold",
      winner: "unknown",
      summary: `${role} returned non-JSON output.`,
      confidence: "low",
      report_markdown: cleanLog(result.text),
    }, role, run, cleanLog(result.text));
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

function isDryRun(args = {}) {
  return args.dry_run === true;
}

async function collectEvidence(args) {
  if (args.visibility_required) {
    throw new Error("visibility_required=true cannot be satisfied by headless MCP. Use host-level multi_agent or codex_app threads first, then record_visible_packet/record_visible_decision.");
  }
  const symbol = safeSymbol(args.symbol);
  const asOfDate = args.as_of || today();
  const id = args.run_id || runId(symbol);
  const tasks = Array.isArray(args.tasks) && args.tasks.length ? args.tasks : DEFAULT_TASKS;
  const dryRun = isDryRun(args);
  const language = resolveLanguage(args);
  const timeoutMs = Number.isFinite(args.timeout_ms) ? args.timeout_ms : 600000;
  const maxConcurrency = Math.max(1, Math.min(6, Number(args.max_concurrency || 3)));
  const dir = runPath(id);
  mkdirSync(dir, { recursive: true });

  const startedAt = new Date().toISOString();
  const run = {
    run_id: id,
    symbol,
    as_of: asOfDate,
    language,
    dry_run: dryRun,
    execution_mode: dryRun ? "dry_run" : "background_codex_exec",
    visibility_required: false,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "running",
    phase: "evidence",
    tasks,
    task_status: Object.fromEntries(tasks.map((task) => [task, { task, status: "pending" }])),
    agent_status: {},
    packets: [],
  };
  const packetsByTask = new Map();
  writeStatus(run);
  appendEvent(run, "run_started", { tasks });
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeAllAgentsMarkdown(run);

  const commitPacket = (packet) => {
    packetsByTask.set(packet.task, packet);
    run.packets = tasks.map((task) => packetsByTask.get(task)).filter(Boolean);
    writeJson(join(dir, `${packet.task}.json`), packet);
    writeJson(join(dir, "evidence.json"), run);
    writeSourceManifest(run);
    writeAllAgentsMarkdown(run);
  };

  await mapLimit(tasks, maxConcurrency, async (task) => {
    const prompt = taskPrompt(task, symbol, asOfDate, args.prompt || "", language);
    updateTask(run, task, "running", { started_at: new Date().toISOString() });
    if (dryRun) {
      const packet = dryPacket(task, symbol, asOfDate, prompt, language);
      commitPacket(packet);
      updateTask(run, task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`) });
      return packet;
    }
    const result = await runCodex(prompt, timeoutMs, ({ pid, output }) => {
      updateTask(run, task, "running", { pid, output });
    }, ({ pid, output, elapsed_ms }) => {
      updateTask(run, task, "running", { pid, output });
      appendEvent(run, "task_heartbeat", { task, pid, output, elapsed_ms });
    });
    let packet;
    if (!result.ok) {
      const failure = cleanLog(result.stderr || result.stdout || `exit code ${result.code}`);
      packet = normalizePacket({
        summary: `Subagent ${task} failed or timed out.`,
        claims: [{ claim: "Subagent failure", evidence: failure, confidence: "low", source_ids: [] }],
        open_questions: ["Retry this packet or lower concurrency."],
        confidence: "low",
      }, task, symbol, asOfDate, cleanLog(result.text || result.stderr || result.stdout));
      commitPacket(packet);
      updateTask(run, task, result.timedOut ? "timed_out" : "failed", {
        completed_at: new Date().toISOString(),
        output: join(dir, `${task}.json`),
        error: result.timedOut ? "timeout" : `exit code ${result.code}`,
      });
      return packet;
    }
    try {
      packet = normalizePacket(extractJson(result.text), task, symbol, asOfDate, result.text);
      commitPacket(packet);
      updateTask(run, task, "completed", { completed_at: new Date().toISOString(), output: join(dir, `${task}.json`) });
      return packet;
    } catch (error) {
      const raw = cleanLog(result.text);
      packet = normalizePacket({
        summary: `Subagent ${task} returned non-JSON output.`,
        claims: [{ claim: "Output was not parseable JSON", evidence: String(error.message || error), confidence: "low", source_ids: [] }],
        open_questions: ["Inspect raw_text and rerun with a stricter prompt."],
        confidence: "low",
      }, task, symbol, asOfDate, raw);
      commitPacket(packet);
      updateTask(run, task, "failed", {
        completed_at: new Date().toISOString(),
        output: join(dir, `${task}.json`),
        error: "parse_failed",
      });
      return packet;
    }
  });

  run.completed_at = new Date().toISOString();
  run.phase = "evidence_complete";
  run.status = tasks.every((task) => taskState(run, task).status === "completed") ? "evidence_complete" : "partial";
  writeJson(join(dir, "evidence.json"), run);
  writeSourceManifest(run);
  writeStatus(run);
  appendEvent(run, "evidence_complete", { completed: run.packets.length, total: tasks.length });
  writeAllAgentsMarkdown(run);
  return run;
}

function confidenceScore(value) {
  return ({ high: 3, medium: 2, low: 1 })[value] || 1;
}

function summarizeRun(run, userPrompt = "") {
  const claims = run.packets.flatMap((packet) =>
    packet.claims.map((claim) => ({ ...claim, task: packet.task, packet_confidence: packet.confidence }))
  );
  const avg = run.packets.reduce((sum, packet) => sum + confidenceScore(packet.confidence), 0) / Math.max(1, run.packets.length);
  const confidence = avg >= 2.5 ? "high" : avg >= 1.7 ? "medium" : "low";
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    objective: userPrompt,
    final_decision: run.dry_run ? "DRY_RUN" : "NEEDS_MANAGER_REVIEW",
    confidence,
    thesis: claims.slice(0, 12),
    open_questions: [...new Set(run.packets.flatMap((packet) => packet.open_questions || []))],
    source_count: run.packets.reduce((sum, packet) => sum + (packet.sources?.length || 0), 0),
    evidence_path: join(runPath(run.run_id), "evidence.json"),
  };
}

function managerFallback(run, userPrompt = "") {
  const summary = summarizeRun(run, userPrompt);
  const chinese = isChineseLanguage(run.language);
  const analystLog = run.packets.length
    ? run.packets.map((packet) => {
        const claims = (packet.claims || []).slice(0, 5).map((claim) => `  - ${claim.claim}`).join("\n");
        const gaps = (packet.open_questions || []).slice(0, 3).map((item) => `  - ${item}`).join("\n");
        return `### ${packet.task}\n- Confidence: ${packet.confidence || "unknown"}\n- Summary: ${packet.summary || "None"}\n${claims ? `- Key findings:\n${claims}\n` : ""}${gaps ? `- Data gaps:\n${gaps}\n` : ""}`;
      }).join("\n\n")
    : (chinese ? "未生成 evidence packets。" : "No evidence packets were generated.");
  const debateRecord = chinese
    ? "经理综合子代理未完成，因此没有完整多空交叉辩论记录；以上证据只能作为投资委员会初稿。"
    : "The manager synthesis subagent did not complete, so a full bull/bear cross-debate record is unavailable; the evidence above is only an investment-committee draft.";
  return normalizeDebate({
    verdict: summary.final_decision,
    rating: "Hold",
    winner: "unknown",
    summary: chinese ? "证据已收集，但未运行经理综合子代理。" : "Evidence was collected, but the manager synthesis subagent did not run.",
    long_thesis: summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => claim.claim),
    short_thesis: summary.open_questions.slice(0, 6),
    confidence: summary.confidence,
    report_markdown: chinese
      ? `# ${run.symbol} 投资委员会初稿\n\n## 结论\n${summary.final_decision}\n\n## 分析师工作记录\n${analystLog}\n\n## 多空辩论记录\n${debateRecord}\n\n## 证据状态\n已生成 ${run.packets.length} 个 evidence packets，来源数量 ${summary.source_count}。\n\n## 数据缺口/未覆盖项\n${summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : "- 未发现关键数据缺口。"}\n`
      : `# ${run.symbol} Investment Committee Draft\n\n## Conclusion\n${summary.final_decision}\n\n## Analyst Work Log\n${analystLog}\n\n## Bull/Bear Debate Record\n${debateRecord}\n\n## Evidence Status\nGenerated ${run.packets.length} evidence packets with ${summary.source_count} sources.\n\n## Data Gaps / Unavailable Data\n${summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : "- No critical data gaps were found."}\n`,
  }, "portfolio_manager", run);
}

async function synthesizeDecision(run, args) {
  const dir = runPath(run.run_id);
  const timeoutMs = Number.isFinite(args.synthesis_timeout_ms) ? args.synthesis_timeout_ms : Number(args.timeout_ms || 600000);
  const outputMode = OUTPUT_MODES.includes(args.output_mode) ? args.output_mode : "public_equity";
  run.phase = "debate";
  run.status = "running";
  run.completed_at = null;
  writeStatus(run);
  appendEvent(run, "debate_started", { output_mode: outputMode });
  if (run.dry_run || args.synthesis === false) {
    updateAgent(run, "bull_researcher", "running", { started_at: new Date().toISOString() });
    const bull = dryDebate("bull_researcher", run, debatePrompt("bull_researcher", run));
    updateAgent(run, "bull_researcher", "completed", { completed_at: new Date().toISOString(), output: join(dir, "bull_researcher.json") });
    updateAgent(run, "bear_researcher", "running", { started_at: new Date().toISOString() });
    const bear = dryDebate("bear_researcher", run, debatePrompt("bear_researcher", run, { bull }));
    updateAgent(run, "bear_researcher", "completed", { completed_at: new Date().toISOString(), output: join(dir, "bear_researcher.json") });
    updateAgent(run, "portfolio_manager", "running", { started_at: new Date().toISOString() });
    const fallback = managerFallback(run, args.prompt || "");
    updateAgent(run, "portfolio_manager", "completed", { completed_at: new Date().toISOString(), output: join(dir, "manager_synthesis.json") });
    writeJson(join(dir, "bull_researcher.json"), bull);
    writeJson(join(dir, "bear_researcher.json"), bear);
    writeJson(join(dir, "manager_synthesis.json"), fallback);
    writeJson(join(dir, "decision.json"), fallback);
    writeFileSync(join(dir, "final_report.md"), `${withDisclaimer(fallback.report_markdown, run.language)}\n`);
    run.completed_at = new Date().toISOString();
    run.phase = "complete";
    run.status = "complete";
    writeStatus(run);
    appendEvent(run, "run_complete", { decision: fallback.rating, winner: fallback.winner });
    writeAllAgentsMarkdown(run, { bull, bear, manager: fallback });
    return { bull, bear, manager: fallback };
  }

  const bullPrompt = debatePrompt("bull_researcher", run);
  updateAgent(run, "bull_researcher", "running", { started_at: new Date().toISOString() });
  const bullResult = await runCodex(bullPrompt, timeoutMs, ({ pid, output }) => {
    updateAgent(run, "bull_researcher", "running", { pid, output });
  }, ({ pid, output, elapsed_ms }) => {
    updateAgent(run, "bull_researcher", "running", { pid, output });
    appendEvent(run, "agent_heartbeat", { role: "bull_researcher", pid, output, elapsed_ms });
  });
  const bull = debateFromCodex(bullResult, "bull_researcher", run, bullPrompt);
  writeJson(join(dir, "bull_researcher.json"), bull);
  updateAgent(run, "bull_researcher", bullResult.ok && bull.verdict !== "PARSE_FAILED" ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "bull_researcher.json"),
    error: bullResult.ok ? undefined : (bullResult.timedOut ? "timeout" : `exit code ${bullResult.code}`),
  });
  writeAllAgentsMarkdown(run, { bull });

  const bearPrompt = debatePrompt("bear_researcher", run, { bull });
  updateAgent(run, "bear_researcher", "running", { started_at: new Date().toISOString() });
  const bearResult = await runCodex(bearPrompt, timeoutMs, ({ pid, output }) => {
    updateAgent(run, "bear_researcher", "running", { pid, output });
  }, ({ pid, output, elapsed_ms }) => {
    updateAgent(run, "bear_researcher", "running", { pid, output });
    appendEvent(run, "agent_heartbeat", { role: "bear_researcher", pid, output, elapsed_ms });
  });
  const bear = debateFromCodex(bearResult, "bear_researcher", run, bearPrompt);
  writeJson(join(dir, "bear_researcher.json"), bear);
  updateAgent(run, "bear_researcher", bearResult.ok && bear.verdict !== "PARSE_FAILED" ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "bear_researcher.json"),
    error: bearResult.ok ? undefined : (bearResult.timedOut ? "timeout" : `exit code ${bearResult.code}`),
  });
  writeAllAgentsMarkdown(run, { bull, bear });

  const managerPrompt = debatePrompt("portfolio_manager", run, { bull, bear, outputMode });
  updateAgent(run, "portfolio_manager", "running", { started_at: new Date().toISOString() });
  const managerResult = await runCodex(managerPrompt, timeoutMs, ({ pid, output }) => {
    updateAgent(run, "portfolio_manager", "running", { pid, output });
  }, ({ pid, output, elapsed_ms }) => {
    updateAgent(run, "portfolio_manager", "running", { pid, output });
    appendEvent(run, "agent_heartbeat", { role: "portfolio_manager", pid, output, elapsed_ms });
  });
  const manager = managerResult.ok
    ? debateFromCodex(managerResult, "portfolio_manager", run, managerPrompt)
    : managerFallback(run, args.prompt || "");
  writeJson(join(dir, "manager_synthesis.json"), manager);
  writeJson(join(dir, "decision.json"), manager);
  writeFileSync(join(dir, "final_report.md"), `${withDisclaimer(manager.report_markdown || manager.summary, run.language)}\n`);
  updateAgent(run, "portfolio_manager", managerResult.ok && manager.verdict !== "PARSE_FAILED" ? "completed" : "failed", {
    completed_at: new Date().toISOString(),
    output: join(dir, "manager_synthesis.json"),
    error: managerResult.ok ? undefined : (managerResult.timedOut ? "timeout" : `exit code ${managerResult.code}`),
  });
  run.completed_at = new Date().toISOString();
  run.phase = "complete";
  run.status = "complete";
  writeStatus(run);
  appendEvent(run, "run_complete", { decision: manager.rating, winner: manager.winner });
  writeAllAgentsMarkdown(run, { bull, bear, manager });
  return { bull, bear, manager };
}

async function analyzeSymbol(args) {
  const run = await collectEvidence(args);
  const debate = await synthesizeDecision(run, args);
  return { run, debate, decision: debate.manager };
}

function tools() {
  const common = {
    symbol: { type: "string", description: "Ticker, e.g. NVDA." },
    as_of: { type: "string", description: "Analysis date YYYY-MM-DD. Defaults to today." },
    prompt: { type: "string", description: "User objective or extra instructions." },
    language: { type: "string", default: "auto", description: "Reader-facing language for subagents and final report, e.g. auto, zh-CN, en-US, ja-JP. Auto infers from prompt." },
    tasks: { type: "array", items: { type: "string", enum: DEFAULT_TASKS } },
    dry_run: { type: "boolean", default: false, description: "Default false. Set true only for planning/self-tests without launching Codex subagents." },
    max_concurrency: { type: "number", default: 3 },
    timeout_ms: { type: "number", default: 600000 },
    synthesis: { type: "boolean", default: true, description: "Run bull, bear, and portfolio-manager synthesis after evidence collection." },
    synthesis_timeout_ms: { type: "number", default: 600000 },
    output_mode: { type: "string", enum: OUTPUT_MODES, default: "public_equity", description: "Final synthesis target shape." },
    visibility_required: { type: "boolean", default: false, description: "When true, headless MCP execution is rejected; use host-visible agents/threads and record their outputs." },
  };
  return [
    tool("plan_visible_run", "Create a visible-host-thread AlphaCouncil Agent run plan. Does not execute; the host must create visible agents/threads.", {
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
    tool("record_visible_packet", "Record one completed visible evidence agent packet into a planned visible run.", {
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
    tool("record_visible_decision", "Record one completed visible bull/bear/portfolio-manager packet into a planned visible run.", {
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
      properties: {},
    }, { readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
  ];
}

async function handleToolCall(id, params) {
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
    const statusPath = join(dir, "status.json");
    const eventsPath = join(dir, "events.jsonl");
    const sourceManifestPath = join(dir, "source_manifest.json");
    sendResult(id, jsonContent(`Loaded AlphaCouncil Agent run ${idArg}`, {
      evidence,
      decision,
      source_manifest: existsSync(sourceManifestPath) ? readJson(sourceManifestPath) : sourceManifest(evidence),
      status: existsSync(statusPath) ? readJson(statusPath) : null,
      events: existsSync(eventsPath) ? readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [],
      artifacts: {
        all_agents_md: allAgentsPath,
        final_report_md: join(dir, "final_report.md"),
        source_manifest_json: sourceManifestPath,
        status_json: statusPath,
        events_jsonl: eventsPath,
      },
      all_agents_markdown: existsSync(allAgentsPath) ? readFileSync(allAgentsPath, "utf8") : "",
    }));
    return;
  }
  if (name === "compare_summary_modes") {
    const modes = summaryModes();
    sendResult(id, jsonContent(JSON.stringify(modes, null, 2), { modes }));
    return;
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(message) {
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
      sendError(id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

export function startStdioServer() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    try {
      void handleRequest(JSON.parse(line));
    } catch {
      // Ignore malformed host messages.
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startStdioServer();
}

export const __test__ = { taskPrompt, extractJson, normalizePacket, sourceManifest, summarizeRun, safeSymbol, summaryModes, outputModeInstruction, writeAllAgentsMarkdown, cleanLog, isDryRun, resolveLanguage };
