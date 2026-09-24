// The council contract in one place: roles, modes, paces and labels. The Claude Code plugin,
// the MCP server and the terminal client all read this file, so the hosts cannot drift.

export const VERSION = "2.0.0";

export const EVIDENCE_ROLES = {
  market_data: {
    title: { en: "Market data", "zh-CN": "行情数据", ja: "市場データ" },
    focus: "Price, relative performance, volume structure, 52-week position, moving averages and headline multiples (reported, not judged).",
  },
  earnings_deep_dive: {
    title: { en: "Earnings deep dive", "zh-CN": "财报深度", ja: "決算深掘り" },
    focus: "Latest quarter and fiscal year: revenue, segments, margins, cash flow, balance sheet, and the management signals from the most recent earnings call (tone, guidance language, analyst Q&A pressure points).",
  },
  forward_expectations: {
    title: { en: "Forward expectations", "zh-CN": "预期与修正", ja: "予想と修正" },
    focus: "Guidance, consensus estimates, recent estimate and rating/target-price revisions, and the thresholds the current price implies (what growth or margin the market is paying for).",
  },
  quant_factor: {
    title: { en: "Quant factor & positioning", "zh-CN": "量化因子与持仓", ja: "クオンツ・需給" },
    focus: "Momentum, volatility, drawdown, beta, factor exposures, short interest and days-to-cover, borrow cost, options positioning (IV term structure, skew, put/call).",
  },
  valuation_long_short: {
    title: { en: "Valuation & long/short", "zh-CN": "估值与多空", ja: "バリュエーションと多空" },
    focus: "Valuation against history and peers (P/E, EV/EBITDA, EV/Sales, FCF yield), a bear/base/bull value range with explicit assumptions, and the strongest long and short theses.",
  },
  news_industry_management: {
    title: { en: "News, industry & management", "zh-CN": "新闻、行业与管理层", ja: "ニュース・業界・経営陣" },
    focus: "Dated company and industry developments from the last 120 days, competitor moves, regulation, and what management and industry voices are saying. Undated, older or future-dated items are gaps, not news.",
  },
  insider_sec: {
    title: { en: "Insider & SEC filings", "zh-CN": "内部人与监管文件", ja: "インサイダー・開示" },
    focus: "Recent 10-K/10-Q/8-K content, risk-factor changes, Form 4 insider transactions, 13D/13G holders, buyback authorizations and dilution.",
  },
  ib_event_analysis: {
    title: { en: "Banking events", "zh-CN": "投行事件", ja: "コーポレートイベント" },
    focus: "M&A, divestitures, spin-offs, equity/debt raises, activism, and capital-allocation decisions; if none are live, say so and assess optionality.",
  },
};

export const DEBATE_ROLES = {
  bull_researcher: { side: "bull", title: { en: "Bull researcher", "zh-CN": "多头研究员", ja: "強気リサーチャー" } },
  bear_researcher: { side: "bear", title: { en: "Bear researcher", "zh-CN": "空头研究员", ja: "弱気リサーチャー" } },
};

export const PM_ROLE = { portfolio_manager: { title: { en: "Portfolio manager", "zh-CN": "投资经理", ja: "ポートフォリオマネージャー" } } };

export const MODES = {
  full: {
    evidence: Object.keys(EVIDENCE_ROLES),
    rounds: 3,
    // Minimum evidence coverage to proceed to debate; below it the run ends `incomplete`.
    required: ["market_data", "earnings_deep_dive", "valuation_long_short"],
    minEvidence: 6,
  },
  quick: {
    evidence: ["market_data", "earnings_deep_dive", "valuation_long_short", "news_industry_management"],
    rounds: 1,
    required: ["market_data", "valuation_long_short"],
    minEvidence: 3,
  },
};

// Per-task wall-clock caps used by executors that own worker lifecycles (the terminal client).
// Claude Code subagents are host-managed; the plugin records elapsed time but cannot kill them.
export const PACES = {
  fast: { total_ms: 15 * 60e3, evidence_ms: 5 * 60e3, debate_ms: 2.5 * 60e3, pm_ms: 4 * 60e3, maxFindings: 6, style: "Be terse: short claims, no restatement. Keep every number, date and source." },
  normal: { total_ms: 30 * 60e3, evidence_ms: 9 * 60e3, debate_ms: 4 * 60e3, pm_ms: 7 * 60e3, maxFindings: 10, style: "" },
  slow: { total_ms: 60 * 60e3, evidence_ms: 18 * 60e3, debate_ms: 7 * 60e3, pm_ms: 12 * 60e3, maxFindings: 14, style: "Take room to show derivations: write out the arithmetic behind valuation and implied thresholds." },
};
export const QUICK_PACE = { total_ms: 10 * 60e3, evidence_ms: 3.5 * 60e3, debate_ms: 1.5 * 60e3, pm_ms: 2 * 60e3, maxFindings: 5, style: "Quick read: at most five findings; concise but sourced." };

export const MAX_ATTEMPTS = 2; // first attempt + one repair

export const RATINGS = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];

export function agentName(role) {
  return role.replace(/_/g, "-");
}

export function roleTitle(role, language = "en") {
  const def = EVIDENCE_ROLES[role] || DEBATE_ROLES[role] || PM_ROLE[role];
  if (!def) return role;
  return def.title[language] || def.title[language?.split("-")[0]] || def.title.en;
}

export function paceFor(mode, pace) {
  return mode === "quick" ? QUICK_PACE : PACES[pace] || PACES.normal;
}

// Labels owned by the system (not model prose). Unlisted languages fall back to English while
// the workers still write in the requested language.
const LABELS = {
  en: {
    title: "AlphaCouncil research report",
    conclusion: "Conclusion and rating",
    snapshot: "Price snapshot",
    worklog: "Analyst work log",
    lenses: "Method lens bench",
    debate: "Bull / Bear debate record",
    long: "Long thesis",
    short: "Short thesis",
    expectations: "Market expectations and implied thresholds",
    revisions: "Analyst rating and target-price revisions",
    earnings: "Earnings-call management signals",
    quant: "Quant factor / technical risk view",
    news: "News and management / industry voices",
    positioning: "Short interest / borrow / options",
    banking: "Strategic transactions and banking events",
    insider: "Insider activity and filings",
    valuation: "Valuation range",
    catalysts: "Catalysts",
    risks: "Risks",
    price_levels: "Price conditions",
    position: "Position recommendation",
    horizons: "Views by horizon",
    short_term: "Short term (1-4 weeks)",
    medium_term: "Medium term (3-6 months)",
    long_term: "Long term (12 months)",
    gaps: "Data gaps / unavailable data",
    no_gaps: "No critical data gaps were found.",
    invalidation: "Invalidation conditions",
    confidence: "Confidence",
    sources: "Source table",
    status: "Run status",
    failed: "failed",
    missing: "not available",
    round: "Round {n}",
    opening: "Opening statements",
    rebuttal: "Rebuttals and questions",
    answers: "Answers and closing",
    winner: "Debate verdict",
    disclaimer: "Research output generated by AI agents from public sources. Not investment advice. Method lenses are deterministic reconstructions of published screening methods, not the views of any person.",
  },
  "zh-CN": {
    title: "AlphaCouncil 研究报告",
    conclusion: "结论与评级",
    snapshot: "价格快照",
    worklog: "分析师工作日志",
    lenses: "方法透镜席位",
    debate: "多空辩论记录",
    long: "做多逻辑",
    short: "做空逻辑",
    expectations: "市场预期与隐含门槛",
    revisions: "分析师评级与目标价调整",
    earnings: "业绩电话会管理层信号",
    quant: "量化因子 / 技术风险",
    news: "新闻与管理层 / 行业声音",
    positioning: "空头仓位 / 融券 / 期权",
    banking: "战略交易与投行事件",
    insider: "内部人交易与监管文件",
    valuation: "估值区间",
    catalysts: "催化剂",
    risks: "风险",
    price_levels: "价格条件",
    position: "仓位建议",
    horizons: "分周期观点",
    short_term: "短期（1-4 周）",
    medium_term: "中期（3-6 个月）",
    long_term: "长期（12 个月）",
    gaps: "数据缺口 / 不可得数据",
    no_gaps: "未发现关键数据缺口。",
    invalidation: "失效条件",
    confidence: "置信度",
    sources: "来源表",
    status: "运行状态",
    failed: "失败",
    missing: "不可得",
    round: "第 {n} 轮",
    opening: "开场陈述",
    rebuttal: "反驳与提问",
    answers: "回答与总结",
    winner: "辩论裁决",
    disclaimer: "本报告由 AI 代理基于公开来源生成，不构成投资建议。方法透镜是对公开筛选方法的确定性重建，并非任何真实人物的观点。",
  },
  ja: {
    title: "AlphaCouncil リサーチレポート",
    conclusion: "結論とレーティング",
    snapshot: "価格スナップショット",
    worklog: "アナリスト作業ログ",
    lenses: "メソッドレンズ",
    debate: "強気/弱気ディベート記録",
    long: "ロングの論拠",
    short: "ショートの論拠",
    expectations: "市場の期待と織り込み水準",
    revisions: "レーティング・目標株価の修正",
    earnings: "決算説明会の経営陣シグナル",
    quant: "クオンツ・テクニカルリスク",
    news: "ニュースと経営陣・業界の声",
    positioning: "空売り・貸株・オプション",
    banking: "戦略的取引・コーポレートイベント",
    insider: "インサイダー取引と開示",
    valuation: "バリュエーションレンジ",
    catalysts: "カタリスト",
    risks: "リスク",
    price_levels: "価格条件",
    position: "ポジション推奨",
    horizons: "期間別の見方",
    short_term: "短期（1-4 週）",
    medium_term: "中期（3-6 か月）",
    long_term: "長期（12 か月）",
    gaps: "データギャップ",
    no_gaps: "重要なデータギャップは見つかりませんでした。",
    invalidation: "無効化条件",
    confidence: "確信度",
    sources: "ソース一覧",
    status: "実行ステータス",
    failed: "失敗",
    missing: "取得不可",
    round: "ラウンド {n}",
    opening: "冒頭陳述",
    rebuttal: "反論と質問",
    answers: "回答とまとめ",
    winner: "ディベート判定",
    disclaimer: "本レポートは公開情報に基づき AI エージェントが生成したもので、投資助言ではありません。メソッドレンズは公開されたスクリーニング手法の決定論的な再構成であり、特定の人物の見解ではありません。",
  },
};

export function labels(language = "en") {
  return LABELS[language] || LABELS[String(language).split("-")[0]] || LABELS.en;
}
