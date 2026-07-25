import { join } from "node:path";
import { isChineseLanguage, resolveLanguage } from "./lang.mjs";
import { runPath } from "./run-store.mjs";
import { compactEvidence } from "./packets.mjs";
import { outputModeInstruction } from "./output-modes.mjs";

export function taskPrompt(task, symbol, asOfDate, userPrompt = "", language = "auto") {
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

export function debatePrompt(role, run, context = {}) {
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

  const roundThreeInstruction = context.round === 3
    ? (chinese
        ? "本轮为问答轮:在 `questions` 数组里给出恰好 3 个针对对方的尖锐问题,并在 `questions_answered` 数组里逐条回答对方提出的问题。"
        : "This is the Q&A round: in a `questions` array list exactly 3 sharp questions for the other side, and in a `questions_answered` array answer the 3 questions the other side asked you.")
    : "";

  return [
    ...base,
    roleText,
    roundThreeInstruction,
    context.round ? `Debate round: ${context.round}` : "",
    context.brief ? `Brief length for round 1: ${context.brief}` : "",
    context.otherCaseR1 ? `Opponent prior-round case JSON: ${JSON.stringify(context.otherCaseR1)}` : "",
    context.questionsForYou ? `Questions you must answer JSON: ${JSON.stringify(context.questionsForYou)}` : "",
    context.bull ? `Bull argument JSON: ${JSON.stringify(context.bull)}` : "",
    context.bear ? `Bear argument JSON: ${JSON.stringify(context.bear)}` : "",
    role === "portfolio_manager" ? outputModeInstruction(context.outputMode || "chat", language) : "",
    `Evidence JSON: ${evidenceJson}`,
  ].filter(Boolean).join("\n\n");
}
