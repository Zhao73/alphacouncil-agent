/**
 * Human-facing selector copy for the master bench.
 *
 * This is deliberately separate from the decision prompt. A selector explains who the
 * lens represents, what it does, and when it is useful. It must never become another way
 * to smuggle policy or unsupported thresholds into the verdict. PersonaPack v3 will move
 * these cards into each pack; this compatibility registry keeps the v0.8 roster usable
 * while that migration is underway.
 */

import { MASTER_SELECTOR_METHOD_LOCALES } from "../../data/master-selector-method-locales.v1.mjs";

const CARDS = Object.freeze({
  master_aschenbrenner: {
    zh: ["Leopold Aschenbrenner，关注 AI 扩张、算力和国家安全的研究者", "研究算力、电力、资本开支和技术时间线是否被市场正确定价。", "AI 基础设施、半导体、电力和长期技术扩散"],
    en: ["Leopold Aschenbrenner, a researcher focused on AI scaling, compute and national security", "Tests compute, power, capital-spending and technology timelines against what the market already prices.", "AI infrastructure, semiconductors, power and long-duration technology adoption"],
  },
  master_buffett: {
    zh: ["沃伦·巴菲特，伯克希尔长期掌舵人和企业所有者型投资代表", "从能力圈、护城河、所有者收益和资本配置判断一家公司是否值得长期拥有。", "商业模式清晰、现金流稳定、可长期复利的企业"],
    en: ["Warren Buffett, Berkshire's long-time leader and a leading business-owner investor", "Judges circle of competence, moat, owner earnings and capital allocation before considering price.", "Understandable, cash-generative businesses with long compounding runways"],
  },
  master_graham: {
    zh: ["本杰明·格雷厄姆，证券分析先驱和现代价值投资奠基者", "先计算资产和盈利下限，再要求价格留下足够安全边际。", "低估值、净资产折价、困境和资产型机会"],
    en: ["Benjamin Graham, a security-analysis pioneer and foundational value-investing thinker", "Builds an asset or earnings floor first, then requires a sufficient discount to that floor.", "Deep value, net-asset discounts, distressed and asset-backed situations"],
  },
  master_simons: {
    zh: ["吉姆·西蒙斯，数学家和文艺复兴科技公司的量化投资先驱", "优先检查样本量、样本外稳定性、多重检验、换手和交易成本。", "量化信号、因子异常和需要验证统计显著性的策略"],
    en: ["Jim Simons, a mathematician and quantitative-investing pioneer at Renaissance Technologies", "Prioritizes sample size, out-of-sample stability, multiple testing, turnover and trading costs.", "Quant signals, factor anomalies and strategies requiring statistical validation"],
  },
  master_soros: {
    zh: ["乔治·索罗斯，以反身性和全球宏观交易闻名的投资人", "寻找价格、信贷、政策和参与者行为相互强化后又可能反转的反馈回路。", "宏观转折、泡沫、政策冲击和拥挤交易"],
    en: ["George Soros, an investor known for reflexivity and global macro trading", "Looks for feedback loops among prices, credit, policy and participant behavior, including their reversal trigger.", "Macro turns, bubbles, policy shocks and crowded trades"],
  },
  master_druckenmiller: {
    zh: ["斯坦利·德鲁肯米勒，以集中仓位和宏观拐点判断著称的投资人", "把流动性、盈利修正、价格确认和未来 12 至 18 个月拐点组合成不对称下注。", "宏观驱动、周期拐点和需要严格时机判断的机会"],
    en: ["Stanley Druckenmiller, an investor known for concentrated positioning around macro inflections", "Combines liquidity, revisions, price confirmation and 12-to-18-month inflections into asymmetric setups.", "Macro-driven, cyclical and timing-sensitive opportunities"],
  },
  master_fisher: {
    zh: ["菲尔·费舍尔，强调传闻调查和长期成长质量的投资人及作者", "通过客户、供应商、竞争者、研发和销售组织的多方证据判断成长质量。", "研发密集、管理能力重要、拥有长期成长跑道的企业"],
    en: ["Phil Fisher, an investor and author known for scuttlebutt research and long-term growth quality", "Triangulates customers, suppliers, competitors, research productivity and sales organization.", "Research-intensive businesses where management quality and runway matter"],
  },
  master_munger: {
    zh: ["查理·芒格，巴菲特的长期合伙人和多学科思维倡导者", "从激励、复杂性和永久损失路径出发，优先寻找必须放弃的原因。", "治理、资本配置、复杂风险和质量型长期投资"],
    en: ["Charlie Munger, Buffett's long-time partner and an advocate of multidisciplinary thinking", "Starts with incentives, complexity and permanent-loss paths to find reasons to walk away.", "Governance, capital allocation, coupled risks and quality compounders"],
  },
  master_thorp: {
    zh: ["爱德华·索普，数学家、量化投资先驱和风险仓位研究者", "独立计算优势、赔率、Kelly 仓位和破产风险。", "特殊情形、套利、可量化赔率和仓位决策"],
    en: ["Edward Thorp, a mathematician, quantitative-investing pioneer and position-sizing researcher", "Recomputes edge, odds, Kelly sizing and risk of ruin.", "Special situations, arbitrage, measurable odds and sizing decisions"],
  },
  master_asness: {
    zh: ["克利夫·阿斯内斯，AQR 联合创始人和系统化因子投资研究者", "分解价值、动量、质量、beta、行业暴露和拥挤度，检查所谓 alpha 是否只是因子。", "多因子投资、风格轮动和组合归因"],
    en: ["Cliff Asness, AQR co-founder and systematic factor-investing researcher", "Decomposes value, momentum, quality, beta, sector exposure and crowding to test whether alpha is only a factor.", "Multi-factor investing, style rotations and portfolio attribution"],
  },
  master_dalio: {
    zh: ["瑞·达利欧，桥水创始人和宏观债务周期研究者", "从增长、通胀、债务周期和政策反应判断当前宏观 regime。", "利率敏感、跨资产、宏观周期和组合平衡问题"],
    en: ["Ray Dalio, Bridgewater founder and researcher of macroeconomic debt cycles", "Classifies the regime through growth, inflation, debt cycles and policy responses.", "Rate-sensitive, cross-asset, macro-cycle and portfolio-balance questions"],
  },
  master_duan_yongping: {
    zh: ["段永平，中国企业家和长期价值投资人，强调本分与用户价值", "用一句话商业模式、用户价值、企业文化、管理层诚信和机会成本决定是否行动。", "消费、品牌、产品驱动和需要长期耐心的企业"],
    en: ["Duan Yongping, a Chinese entrepreneur and long-term value investor focused on user value and integrity", "Uses a one-sentence business model, user value, culture, integrity and opportunity cost to decide whether to act.", "Consumer, brand and product-led businesses requiring long patience"],
  },
  master_lynch: {
    zh: ["彼得·林奇，富达麦哲伦基金前经理和成长股研究代表人物", "先区分慢成长、稳定成长、快速成长、周期、反转和资产型公司，再检验两分钟故事。", "日常可观察企业、门店扩张、成长股、周期和反转机会"],
    en: ["Peter Lynch, former Fidelity Magellan manager and a prominent growth-stock researcher", "Classifies slow growers, stalwarts, fast growers, cyclicals, turnarounds and asset plays before testing the two-minute story.", "Observable businesses, unit expansion, growth, cyclical and turnaround ideas"],
  },
  master_forensic_short: {
    zh: ["不对应单一名人的法证做空专业席位，综合审计、借券和催化剂纪律", "检查会计异常、关联交易、现金转换、借券条件和可验证催化剂。", "财务质量争议、治理红旗和结构性空头研究"],
    en: ["A non-celebrity forensic short-selling specialist combining accounting, borrow and catalyst discipline", "Checks accounting anomalies, related parties, cash conversion, borrow conditions and testable catalysts.", "Financial-quality disputes, governance red flags and structural short research"],
  },
  master_li_lu: {
    zh: ["李录，喜马拉雅资本创始人和长期价值投资人", "关注十年确定性、管理层诚信、文明趋势和永久损失。", "高质量长期持有、中国及全球结构成长企业"],
    en: ["Li Lu, founder of Himalaya Capital and a long-term value investor", "Focuses on ten-year certainty, management integrity, civilization trends and permanent loss.", "High-quality long-term holdings and structural growth businesses"],
  },
  master_marks: {
    zh: ["霍华德·马克斯，橡树资本联合创始人和信用周期投资人", "判断周期温度、市场共识、价格隐含预期和永久损失风险。", "信用、困境、周期资产和市场情绪极端"],
    en: ["Howard Marks, Oaktree co-founder and credit-cycle investor", "Assesses cycle temperature, consensus, price-implied expectations and permanent-loss risk.", "Credit, distress, cyclical assets and sentiment extremes"],
  },
  master_burry: {
    zh: ["迈克尔·伯里，Scion 创始人和以原始文件研究著称的逆向投资人", "从申报文件、资本结构、会计选择、持有成本和机械性错价寻找非共识机会。", "法证多空、特殊情形、结构性错价和冷门文件研究"],
    en: ["Michael Burry, Scion founder and a contrarian investor known for primary-document research", "Searches filings, capital structure, accounting choices, carry and mechanical mispricing for non-consensus setups.", "Forensic long/short, special situations and structural mispricing"],
  },
  master_klarman: {
    zh: ["塞思·卡拉曼，Baupost 投资人和资本保全型价值投资代表", "从现金期权、下行资产保护、催化剂和困境回收率评估绝对回报。", "困境价值、复杂证券、催化型低估和资本保全"],
    en: ["Seth Klarman, a Baupost investor associated with capital-preservation value investing", "Evaluates cash optionality, downside asset protection, catalysts and distressed recoveries.", "Distressed value, complex securities, catalyst-driven discounts and capital preservation"],
  },
  master_taleb: {
    zh: ["纳西姆·塔勒布，前期权交易员、风险研究者和《黑天鹅》作者", "不预测单一路径，先检查破产风险、隐藏杠杆、负凸性和极端情景下的收益形状。", "尾部风险、期权、杠杆、脆弱商业模式和对冲结构"],
    en: ["Nassim Taleb, former options trader, risk researcher and author of The Black Swan", "Avoids single-path forecasts and first checks ruin, hidden leverage, negative convexity and extreme-state payoff shape.", "Tail risk, options, leverage, fragile businesses and hedge structures"],
  },
  master_natenberg: {
    zh: ["谢尔登·纳坦恩伯格，期权交易教育者和《Option Volatility and Pricing》作者", "从隐含波动率、偏度、期限结构、Greeks 和结构损益判断期权是否定价合理。", "期权结构、波动率曲面和相对价值"],
    en: ["Sheldon Natenberg, options educator and author of Option Volatility and Pricing", "Uses implied volatility, skew, term structure, Greeks and payoff structure to judge option pricing.", "Options structures, volatility surfaces and relative value"],
  },
  master_sinclair: {
    zh: ["尤安·辛克莱，量化波动率交易员和期权策略作者", "比较实现波动预测与隐含波动，扣除价差、滑点和仓位风险后判断优势是否仍存在。", "波动率交易、执行成本和系统化期权策略"],
    en: ["Euan Sinclair, quantitative volatility trader and author on options strategies", "Compares realized-volatility forecasts with implied volatility after spreads, slippage and sizing risk.", "Volatility trading, execution costs and systematic options strategies"],
  },
  master_damodaran: {
    zh: ["阿斯瓦特·达莫达兰，纽约大学 Stern 商学院教授和估值研究者", "把商业故事翻译成增长、利润率、再投资、风险和现金流，再形成价值区间。", "高成长、复杂叙事、年轻企业和估值分歧"],
    en: ["Aswath Damodaran, NYU Stern professor and valuation researcher", "Translates a business story into growth, margins, reinvestment, risk and cash flow to produce a value range.", "Growth, narrative-heavy, young and valuation-disputed businesses"],
  },
  master_ackman: {
    zh: ["比尔·阿克曼，Pershing Square 创始人和激进型集中投资人", "寻找价值缺口、治理或资本配置改善抓手，以及可执行的催化剂路径。", "激进投资、治理改善、分拆和资本配置变化"],
    en: ["Bill Ackman, Pershing Square founder and concentrated activist investor", "Looks for a value gap, governance or capital-allocation levers, and an executable catalyst path.", "Activism, governance improvement, breakups and capital-allocation change"],
  },
  master_cathie_wood: {
    zh: ["凯茜·伍德，ARK Invest 创始人和颠覆性创新主题投资人", "连接技术成本曲线、采用率、市场规模、公司收入、单位经济和五年情景估值。", "颠覆性技术、平台融合、早期采用和高不确定成长"],
    en: ["Cathie Wood, ARK Invest founder and disruptive-innovation thematic investor", "Connects technology cost curves, adoption, market size, company revenue, unit economics and five-year scenarios.", "Disruptive technology, platform convergence, early adoption and uncertain growth"],
  },
  master_pabrai: {
    zh: ["Mohnish Pabrai，Pabrai Funds 创始人和 Dhandho 价值投资人", "寻找低永久损失、高不确定性、离散催化剂和明显不对称赔率。", "特殊情形、资产保护、克隆后独立复算和集中机会"],
    en: ["Mohnish Pabrai, Pabrai Funds founder and Dhandho value investor", "Looks for low permanent-loss risk, high uncertainty, discrete catalysts and strongly asymmetric odds.", "Special situations, asset protection, independently rebuilt clones and concentration"],
  },
  master_bogle: {
    zh: ["约翰·博格，先锋集团创始人和低成本指数投资的倡导者", "把一篮子的长期预期回报拆成股息率、盈利增长和估值变化，再减去持有成本。", "指数基金、ETF、整体市场预期回报和持有成本"],
    en: ["John C. Bogle, Vanguard's founder and the advocate of low-cost index investing", "Decomposes a basket's long-run expected return into dividend yield, earnings growth and the change in valuation, then subtracts the cost of holding it.", "Index funds, ETFs, market-wide expected return and cost of ownership"],
  },
  master_jhunjhunwala: {
    zh: ["Rakesh Jhunjhunwala，以长期集中持仓闻名的印度投资人", "结合印度结构成长、promoter 治理、现金质量、规模扩张和流动性。", "印度上市公司、结构渗透、治理和集中成长机会"],
    en: ["Rakesh Jhunjhunwala, an Indian investor known for long-duration concentrated holdings", "Combines Indian structural growth, promoter governance, cash quality, scaling and liquidity.", "Indian equities, structural penetration, governance and concentrated growth"],
  },
});

function langKey(language) {
  const text = String(language || "");
  if (/中文|chinese|zh/i.test(text)) return "zh";
  if (/日本語|japanese|ja/i.test(text)) return "ja";
  if (/한국어|korean|ko/i.test(text)) return "ko";
  return "en";
}

export function selectorCard(persona, language = "English") {
  const key = langKey(language);
  const fallbackTags = (persona?.philosophy_tags || persona?.tags || []).join(", ") || persona?.id || "method lens";
  let card = CARDS[persona?.id]?.[key];
  if (!card && (key === "ja" || key === "ko") && MASTER_SELECTOR_METHOD_LOCALES[persona?.id]?.[key]) {
    const title = persona?.title?.en || persona?.id;
    card = key === "ja"
      ? [
        `${title}。プロジェクト派生で、人による方法帰属の審査を受けていない暫定メソッド視点。本人の発言や現在の見解ではない。`,
        MASTER_SELECTOR_METHOD_LOCALES[persona.id][key],
        `適用領域（安定タグ）：${fallbackTags}`,
      ]
      : [
        `${title}. 프로젝트에서 파생되었고 방법 귀속에 대한 인적 심사를 거치지 않은 임시 방법론 관점이다. 본인의 발언이나 현재 견해가 아니다.`,
        MASTER_SELECTOR_METHOD_LOCALES[persona.id][key],
        `적합 영역(안정 태그): ${fallbackTags}`,
      ];
  }
  const [identity, method, bestFor] = card || (key === "zh"
    ? [`${persona?.title?.zh || persona?.id}方法视角`, `重点检查：${fallbackTags}。`, "适用于其公开方法能够覆盖的问题"]
    : key === "ja"
      ? [`${persona?.title?.en || persona?.id}の方法視点`, `重点項目：${fallbackTags}`, "文書化された方法の範囲内の問いに適用"]
      : key === "ko"
        ? [`${persona?.title?.en || persona?.id} 방법론 관점`, `중점 점검: ${fallbackTags}`, "문서화된 방법 범위의 질문에 적용"]
        : [`${persona?.title?.en || persona?.id} method lens`, `Focuses on: ${fallbackTags}.`, "Questions within the method's documented scope"]);
  return { identity, method, best_for: bestFor };
}

export function knownSelectorCardIds() {
  return Object.keys(CARDS).sort();
}
