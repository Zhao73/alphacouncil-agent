// Interface strings (en, zh-CN, ja; English fallback).

const S = {
  en: {
    tagline: "a research desk for any stock", placeholder: "Ticker or question — NVDA · is AAPL cheap? · /compare NVDA AMD", askPlaceholder: "Ask about this report…",
    watchlist: "WATCHLIST", research: "RESEARCH", empty: "empty — type /watch NVDA", noRuns: "no research yet",
    tabs: { live: "Live", verdict: "Verdict", report: "Report", evidence: "Evidence", ask: "Ask" },
    hints: "Tab focus · ←→ tabs · ↑↓ move · Enter open · / type · w watch · x export · ? help · q quit",
    snapshot: "SNAPSHOT", desks: "RESEARCH DESKS", debate: "DEBATE", decision: "DECISION", draft: "DRAFTING THE VERDICT",
    waiting: "waiting", thinking: "thinking…", bull: "Bull", bear: "Bear", pm: "Portfolio manager",
    value: "VALUE", levels: "PRICE LEVELS", youAreHere: "price is here", catalysts: "CATALYSTS", risks: "RISKS", position: "POSITION",
    horizons: "HORIZONS", h1: "1-4 weeks", h2: "3-6 months", h3: "12 months", wrong: "WHAT WOULD PROVE IT WRONG", bullCase: "BULL CASE", bearCase: "BEAR CASE", verdictLine: "VERDICT",
    confidence: "confidence", elapsed: "time", cost: "spend", status: "status", findings: "findings", sources: "sources", keyNumbers: "key numbers",
    askIntro: "Ask anything about this report. Answers use the report first and search only when needed.",
    quick: "QUICK START", recent: "RECENT VERDICTS", track: "TRACK RECORD",
    tips: ["NVDA                     deep research (default)", "is 0700.HK cheap?          a question — the verdict answers it", "/fast AAPL                 fast read", "/compare NVDA AMD AVGO     rank several", "/watch NVDA · /track        watchlist · how past verdicts did"],
    started: "started", exported: "exported", watched: "added to watchlist", unwatched: "removed from watchlist", quitConfirm: "Research is running — press q again to stop it and quit",
    noTicker: "No ticker found — try NVDA, 7203.T or 0700.HK", compareTitle: "COMPARE", rank: "rank", upside: "upside", hitRate: "hit rate", since: "since",
    help: "HELP",
  },
  "zh-CN": {
    tagline: "随手可用的股票研究台", placeholder: "输入代码或问题 —— NVDA · AAPL 贵吗？ · /compare NVDA AMD", askPlaceholder: "就这份报告继续提问…",
    watchlist: "自选", research: "研究", empty: "空 —— 输入 /watch NVDA", noRuns: "还没有研究",
    tabs: { live: "实时", verdict: "结论", report: "报告", evidence: "证据", ask: "追问" },
    hints: "Tab 切换区域 · ←→ 标签 · ↑↓ 移动 · 回车打开 · / 输入 · w 自选 · x 导出 · ? 帮助 · q 退出",
    snapshot: "快照", desks: "研究台", debate: "辩论", decision: "决策", draft: "正在撰写结论",
    waiting: "等待", thinking: "思考中…", bull: "多头", bear: "空头", pm: "投资经理",
    value: "估值", levels: "价格条件", youAreHere: "现价在此", catalysts: "催化剂", risks: "风险", position: "仓位",
    horizons: "分周期", h1: "1-4 周", h2: "3-6 个月", h3: "12 个月", wrong: "失效条件", bullCase: "多头观点", bearCase: "空头观点", verdictLine: "裁决",
    confidence: "置信度", elapsed: "用时", cost: "花费", status: "状态", findings: "条发现", sources: "来源", keyNumbers: "关键数字",
    askIntro: "关于这份报告随便问。优先根据报告回答，必要时才搜索。",
    quick: "快速开始", recent: "最近结论", track: "历史战绩",
    tips: ["NVDA                     深度研究（默认）", "0700.HK 现在贵吗？        带问题，结论会直接回答", "/fast AAPL                 快速结论", "/compare NVDA AMD AVGO     多只对比排名", "/watch NVDA · /track        自选股 · 历史结论表现"],
    started: "已开始", exported: "已导出", watched: "已加入自选", unwatched: "已移出自选", quitConfirm: "研究仍在进行 —— 再按一次 q 停止并退出",
    noTicker: "没有识别出股票代码 —— 试试 NVDA、7203.T、0700.HK", compareTitle: "对比", rank: "排名", upside: "空间", hitRate: "命中率", since: "至今",
    help: "帮助",
  },
  ja: {
    tagline: "あらゆる銘柄のリサーチデスク", placeholder: "ティッカーまたは質問 — NVDA · 7203.T は割安？ · /compare NVDA AMD", askPlaceholder: "このレポートについて質問…",
    watchlist: "ウォッチ", research: "リサーチ", empty: "空 — /watch NVDA", noRuns: "まだありません",
    tabs: { live: "進行", verdict: "結論", report: "レポート", evidence: "根拠", ask: "質問" },
    hints: "Tab 移動 · ←→ タブ · ↑↓ 選択 · Enter 開く · / 入力 · w ウォッチ · x 書き出し · ? ヘルプ · q 終了",
    snapshot: "スナップショット", desks: "リサーチデスク", debate: "討論", decision: "判断", draft: "結論を作成中",
    waiting: "待機", thinking: "考え中…", bull: "強気", bear: "弱気", pm: "PM",
    value: "価値", levels: "価格条件", youAreHere: "現在値", catalysts: "カタリスト", risks: "リスク", position: "ポジション",
    horizons: "期間別", h1: "1-4 週", h2: "3-6 か月", h3: "12 か月", wrong: "無効化条件", bullCase: "強気の見方", bearCase: "弱気の見方", verdictLine: "判定",
    confidence: "確信度", elapsed: "所要", cost: "費用", status: "状態", findings: "件", sources: "ソース", keyNumbers: "主要数値",
    askIntro: "このレポートについて何でも質問できます。",
    quick: "クイックスタート", recent: "最近の結論", track: "実績",
    tips: ["NVDA                     ディープリサーチ", "7203.T は割安？             質問付き", "/fast AAPL                 クイック", "/compare NVDA AMD AVGO     比較", "/watch NVDA · /track        ウォッチ · 実績"],
    started: "開始", exported: "書き出し", watched: "ウォッチに追加", unwatched: "ウォッチから削除", quitConfirm: "実行中 — もう一度 q で停止して終了",
    noTicker: "ティッカーが見つかりません", compareTitle: "比較", rank: "順位", upside: "余地", hitRate: "的中率", since: "以降",
    help: "ヘルプ",
  },
};

export function strings(language) {
  return S[language] || S[String(language).split("-")[0]] || S.en;
}
