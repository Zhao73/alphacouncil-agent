// Terminal UI strings (en, zh-CN, ja; English fallback).

const UI = {
  en: {
    prompt: "Ticker or question", hint: "e.g. NVDA · AAPL is it a buy? · 0700.HK", engine: "engine", deep: "deep research", fast: "fast read",
    desks: "Desks", debate: "Debate", decision: "Decision", pm: "Portfolio manager", bull: "Bull", bear: "Bear",
    stop: "Ctrl+C stops and saves", reused: "Showing a report from {age} ago — add --fresh to research again",
    price: "Price", value: "Value", upside: "base vs price", conclusion: "Conclusion", verdict: "Verdict", levels: "Levels",
    catalysts: "Catalysts", risks: "Risks", position: "Position", report: "Full report", elapsed: "time", cost: "spend", status: "status",
    follow: "Ask a follow-up (Enter to quit, /report for the full report)", lenses: "Lenses", recent: "Recent", gaps: "Gaps",
    confidence: "confidence", noTicker: "Could not find a ticker in that. Try e.g. NVDA or AAPL.", thinking: "thinking…",
    snapshot: "Fetching live data…", months12: "12m", fromHigh: "from high", revenue: "Revenue TTM", margins: "gross/op margin",
  },
  "zh-CN": {
    prompt: "股票代码或问题", hint: "例如 NVDA · AAPL 现在值得买吗？ · 0700.HK", engine: "引擎", deep: "深度研究", fast: "快速结论",
    desks: "研究台", debate: "辩论", decision: "决策", pm: "投资经理", bull: "多头", bear: "空头",
    stop: "Ctrl+C 停止并保存", reused: "显示 {age}前的报告 —— 加 --fresh 重新研究",
    price: "价格", value: "估值", upside: "基准较现价", conclusion: "结论", verdict: "裁决", levels: "价格条件",
    catalysts: "催化剂", risks: "风险", position: "仓位", report: "完整报告", elapsed: "用时", cost: "花费", status: "状态",
    follow: "继续追问（回车退出，/report 查看完整报告）", lenses: "透镜", recent: "近期", gaps: "缺口",
    confidence: "置信度", noTicker: "没有识别出股票代码，请输入如 NVDA、AAPL、0700.HK。", thinking: "思考中…",
    snapshot: "获取实时数据…", months12: "12个月", fromHigh: "距高点", revenue: "营收 TTM", margins: "毛利/经营利润率",
  },
  ja: {
    prompt: "ティッカーまたは質問", hint: "例: NVDA · AAPL は買い？ · 7203.T", engine: "エンジン", deep: "ディープリサーチ", fast: "クイック",
    desks: "デスク", debate: "討論", decision: "判断", pm: "PM", bull: "強気", bear: "弱気",
    stop: "Ctrl+C で停止・保存", reused: "{age}前のレポートを表示 — 再調査は --fresh",
    price: "価格", value: "価値", upside: "基本値/現値", conclusion: "結論", verdict: "判定", levels: "価格条件",
    catalysts: "カタリスト", risks: "リスク", position: "ポジション", report: "レポート", elapsed: "所要", cost: "費用", status: "状態",
    follow: "追加の質問（Enter で終了、/report で全文）", lenses: "レンズ", recent: "最近", gaps: "ギャップ",
    confidence: "確信度", noTicker: "ティッカーが見つかりません。例: NVDA、7203.T", thinking: "考え中…",
    snapshot: "データ取得中…", months12: "12か月", fromHigh: "高値比", revenue: "売上 TTM", margins: "粗利/営業利益率",
  },
};

export function ui(language) {
  return UI[language] || UI[String(language).split("-")[0]] || UI.en;
}
