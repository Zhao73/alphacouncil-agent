import { OUTPUT_MODES } from "./constants.mjs";
import { isChineseLanguage } from "./lang.mjs";

export function summaryModes() {
  return [
    {
      mode: "chat",
      best_for: "默认最终答复、快速判断、直接复制到聊天窗口。",
      effect: "聊天里给不冗长但完整的交付摘要；完整报告必须写入 final_report.md，并覆盖新闻、财报、前瞻、估值、风险和文件位置。",
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

export function outputModeInstruction(mode, language = "English") {
  const selected = OUTPUT_MODES.includes(mode) ? mode : "public_equity";
  const picked = summaryModes().find((item) => item.mode === selected);
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
    ["product_design", "creative_production", "sales"].includes(selected)
      ? "State that this mode is not recommended for the investment decision itself; provide only how it could support packaging or downstream use."
      : "",
  ].filter(Boolean).join("\n");
}
