import { OUTPUT_MODES } from "./constants.mjs";
import { isChineseLanguage } from "./lang.mjs";

/**
 * The output shapes the portfolio manager can target.
 *
 * best_for/effect used to be Chinese-only strings that outputModeInstruction interpolated
 * straight into English PM prompts, so an English run received two lines of Chinese
 * instructions. They are per-language now.
 *
 * The former product_design / creative_production / sales modes described themselves as
 * "not for investment summary" and have been removed. Unknown values still fall back to
 * public_equity, so a host that passes an old name degrades instead of erroring.
 */
export function summaryModes(language = "English") {
  const zh = isChineseLanguage(language);
  const pick = (pair) => (zh ? pair.zh : pair.en);
  return MODES.map((mode) => ({
    mode: mode.mode,
    best_for: pick(mode.best_for),
    effect: pick(mode.effect),
    fit: mode.fit,
  }));
}

const MODES = [
  {
    mode: "chat",
    best_for: {
      zh: "默认最终答复、快速判断、直接复制到聊天窗口。",
      en: "Default final reply, quick judgment, paste straight into chat.",
    },
    effect: {
      zh: "聊天里给不冗长但完整的交付摘要；完整报告必须写入 final_report.md，并覆盖新闻、财报、前瞻、估值、风险和文件位置。",
      en: "A short but complete handoff in chat; the full report still goes to final_report.md and must cover news, earnings, forward thresholds, valuation, risks, and file locations.",
    },
    fit: "best_default",
  },
  {
    mode: "documents",
    best_for: {
      zh: "正式投资备忘录、IC memo、可继续编辑的 Word/Google Docs 文档。",
      en: "Formal investment memos, IC memos, editable Word/Google Docs deliverables.",
    },
    effect: {
      zh: "更像严肃 memo：封面信息、执行摘要、论证、来源附录、风险和反证条件。",
      en: "Reads like a serious memo: cover details, executive summary, argument, source appendix, risks, and invalidation conditions.",
    },
    fit: "best_formal_memo",
  },
  {
    mode: "pdf",
    best_for: {
      zh: "只读交付、归档、对外发送、版式固定的正式报告。",
      en: "Read-only delivery, archiving, external distribution, fixed-layout reports.",
    },
    effect: {
      zh: "内容应先按报告写好，再渲染为 PDF；适合最终版，不适合迭代。",
      en: "Write the report first, then render to PDF. Good for a final version, poor for iteration.",
    },
    fit: "best_locked_report",
  },
  {
    mode: "presentations",
    best_for: {
      zh: "投资委员会汇报、pitch deck、老板快速看结论。",
      en: "Investment-committee readouts, pitch decks, a fast look at the conclusion.",
    },
    effect: {
      zh: "8-10 页 slide outline：结论页、多头页、空头页、估值页、催化剂页、风险页、仓位页。",
      en: "An 8-10 slide outline: conclusion, long case, short case, valuation, catalysts, risks, position.",
    },
    fit: "best_committee_deck",
  },
  {
    mode: "data_analytics",
    best_for: {
      zh: "指标表、KPI、估值敏感性、可视化 dashboard。",
      en: "Metric tables, KPIs, valuation sensitivity, dashboard visuals.",
    },
    effect: {
      zh: "适合把 revenue、margin、multiple、scenario 做成表和图；不适合单独写最终投资判断。",
      en: "Good for turning revenue, margin, multiple and scenario work into tables and charts; not a substitute for the investment judgment itself.",
    },
    fit: "supporting_analytics",
  },
  {
    mode: "public_equity",
    best_for: {
      zh: "上市股票 long/short、财报、估值、催化剂、仓位建议。",
      en: "Listed-equity long/short, earnings, valuation, catalysts, position sizing.",
    },
    effect: {
      zh: "最适合作为研究子代理和最终 PM memo 的核心材料。",
      en: "The best fit for both the research subagents and the final PM memo.",
    },
    fit: "best_research_brain",
  },
  {
    mode: "investment_banking",
    best_for: {
      zh: "增发、并购、融资、稀释、accretion/dilution、交易影响。",
      en: "Offerings, M&A, financing, dilution, accretion/dilution, transaction impact.",
    },
    effect: {
      zh: "适合写交易事件章节；没有活跃交易时不应让它主导最终结论。",
      en: "Good for the transaction-event section; it should not drive the final conclusion when there is no live transaction.",
    },
    fit: "event_specialist",
  },
];

export function outputModeInstruction(mode, language = "English") {
  const selected = OUTPUT_MODES.includes(mode) ? mode : "public_equity";
  const picked = summaryModes(language).find((item) => item.mode === selected);
  const chinese = isChineseLanguage(language);
  return [
    chinese ? "最终报告语言：中文。" : `Final report language: ${language}.`,
    `Final output mode: ${selected}.`,
    `Mode purpose: ${picked?.best_for || ""}`,
    `Mode effect: ${picked?.effect || ""}`,
    chinese
      ? "report_markdown 必须是完整正文，不是运行说明。必须覆盖 report contract 的所有章节，尤其新闻、最新财报、前瞻门槛、卖方修正、估值、风险、仓位、数据缺口和来源表。聊天摘要可以简洁，但 final_report.md 不得偷懒。"
      : "report_markdown must be the complete report body, not an execution note. It must cover every report-contract section, especially news, latest earnings, forward thresholds, sell-side revisions, valuation, risks, position sizing, data gaps, and source table. The chat handoff may be concise; final_report.md must not be lazy.",
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
  ].filter(Boolean).join("\n");
}
