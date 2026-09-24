// System-owned labels. Models write prose in any language; these labels cover en, zh-CN, ja
// and fall back to English.

const T = {
  en: {
    conclusion: "The verdict", debate: "The case for and against", bull: "Bull", bear: "Bear", verdict: "Verdict",
    answer: "Answer to the other side", mind: "Would change my mind",
    valuation: "Valuation and price levels", bearv: "Bear", basev: "Base", bullv: "Bull", vs_price: "vs price",
    catalysts: "Catalysts", risks: "Risks", position: "Position", entry: "Entry", exit: "Exit",
    horizons: "By horizon", short_term: "1-4 weeks", medium_term: "3-6 months", long_term: "12 months",
    desks: "Research desks", lenses: "Method lenses", invalidation: "What would prove this wrong",
    gaps: "Data gaps", no_gaps: "No critical data gaps.", sources: "Sources", confidence: "Confidence",
    price: "Price", delayed: "delayed", elapsed: "elapsed", status: "status", failed: "failed",
    winner: { bull: "bull wins", bear: "bear wins", balanced: "balanced", none: "no debate" },
    levels: { low: "low", medium: "medium", high: "high" },
    lens_note: "Deterministic screens on the snapshot, computed before any model wrote. out_of_scope = not enough data, not a vote.",
    disclaimer: "AI-generated research from public sources. Not investment advice.",
    snapshot: "Snapshot", asking: "Question",
  },
  "zh-CN": {
    conclusion: "结论", debate: "多空论证", bull: "多头", bear: "空头", verdict: "裁决",
    answer: "对另一方最强论点的回应", mind: "什么证据会让我改变看法",
    valuation: "估值与价格条件", bearv: "悲观", basev: "基准", bullv: "乐观", vs_price: "较现价",
    catalysts: "催化剂", risks: "风险", position: "仓位建议", entry: "建仓", exit: "退出",
    horizons: "分周期观点", short_term: "1-4 周", medium_term: "3-6 个月", long_term: "12 个月",
    desks: "研究台发现", lenses: "方法透镜", invalidation: "失效条件",
    gaps: "数据缺口", no_gaps: "未发现关键数据缺口。", sources: "来源", confidence: "置信度",
    price: "价格", delayed: "延迟", elapsed: "用时", status: "状态", failed: "失败",
    winner: { bull: "多头胜", bear: "空头胜", balanced: "势均力敌", none: "无辩论" },
    levels: { low: "低", medium: "中", high: "高" },
    lens_note: "基于快照数据的确定性筛选，在任何模型写作之前算出。out_of_scope 表示数据不足，不是反对票。",
    disclaimer: "本报告由 AI 基于公开来源生成，不构成投资建议。",
    snapshot: "快照", asking: "问题",
  },
  ja: {
    conclusion: "結論", debate: "強気 vs 弱気", bull: "強気", bear: "弱気", verdict: "判定",
    answer: "相手側の最強の論点への回答", mind: "見方を変える証拠",
    valuation: "バリュエーションと価格条件", bearv: "弱気", basev: "基本", bullv: "強気", vs_price: "現値比",
    catalysts: "カタリスト", risks: "リスク", position: "ポジション", entry: "エントリー", exit: "イグジット",
    horizons: "期間別", short_term: "1-4 週", medium_term: "3-6 か月", long_term: "12 か月",
    desks: "リサーチデスク", lenses: "メソッドレンズ", invalidation: "無効化条件",
    gaps: "データギャップ", no_gaps: "重要なデータギャップはありません。", sources: "ソース", confidence: "確信度",
    price: "価格", delayed: "遅延", elapsed: "所要", status: "状態", failed: "失敗",
    winner: { bull: "強気の勝ち", bear: "弱気の勝ち", balanced: "互角", none: "討論なし" },
    levels: { low: "低", medium: "中", high: "高" },
    lens_note: "スナップショットに基づく決定論的スクリーニング。out_of_scope はデータ不足で、反対票ではありません。",
    disclaimer: "公開情報に基づく AI 生成リサーチです。投資助言ではありません。",
    snapshot: "スナップショット", asking: "質問",
  },
};

export function normalizeLanguage(raw) {
  const s = String(raw || "").trim();
  if (!s) return "en";
  if (/^(zh|zh[-_]cn|zh[-_]hans|中文|简体中文|chinese)$/i.test(s)) return "zh-CN";
  if (/^(zh[-_]tw|zh[-_]hk|zh[-_]hant|繁體中文)$/i.test(s)) return "zh-TW";
  if (/^(ja|jp|日本語|japanese)$/i.test(s)) return "ja";
  if (/^(en|english)$/i.test(s)) return "en";
  return s;
}

/** Guess the language from the user's own words, then the environment. */
export function detectLanguage(text = "", env = process.env) {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh-CN";
  const loc = `${env.LC_ALL || ""} ${env.LC_MESSAGES || ""} ${env.LANG || ""}`;
  if (/zh/i.test(loc)) return "zh-CN";
  if (/\bja/i.test(loc)) return "ja";
  return "en";
}

export function t(language) {
  return T[language] || T[String(language).split("-")[0]] || T.en;
}

export function deskTitle(desk, language, DESKS) {
  const d = DESKS[desk];
  return d ? d.title[language] || d.title[String(language).split("-")[0]] || d.title.en : desk;
}
