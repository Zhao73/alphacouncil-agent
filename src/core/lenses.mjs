// Deterministic method lenses. Each lens is a small, published-style screen evaluated on the
// run's frozen facts BEFORE any model writes prose, so a stance can never be talked into
// existence. A lens with too few evaluable checks abstains as `out_of_scope`; an abstention is
// a coverage gap, never a negative vote. These are method reconstructions, not the views of
// any person.

function fmt(x, unit = "") {
  if (x === null || x === undefined) return "n/a";
  const n = Number(x);
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return `${Math.round(n * 100) / 100}${unit}`;
}

// check(label, value, rule, test) -> { label, value, rule, pass }
function check(label, value, rule, test, unit = "") {
  const evaluable = value !== null && value !== undefined && Number.isFinite(Number(value));
  return { label, value: evaluable ? Number(value) : null, display: fmt(evaluable ? value : null, unit), rule, pass: evaluable ? Boolean(test(Number(value))) : null };
}

export const LENSES = [
  {
    id: "deep_value",
    name: { en: "Deep value (defensive-investor screens)", "zh-CN": "深度价值（防御型投资者筛选）", ja: "ディープバリュー" },
    family: "value",
    question: "Is the price low against earnings and book, with a balance sheet that can wait?",
    scope: ["operating_company"],
    minEvaluable: 3,
    checks: ({ r }) => [
      check("P/E (TTM)", r.pe_ttm, "< 15", (x) => x > 0 && x < 15),
      check("P/B", r.pb, "< 1.5", (x) => x > 0 && x < 1.5),
      check("P/E × P/B", r.pe_ttm && r.pb ? r.pe_ttm * r.pb : null, "< 22.5", (x) => x > 0 && x < 22.5),
      check("Debt / equity", r.debt_to_equity, "< 1.0", (x) => x < 1),
      check("Current ratio", r.current_ratio, "> 1.5", (x) => x > 1.5),
    ],
  },
  {
    id: "quality_compounder",
    name: { en: "Quality compounder", "zh-CN": "高质量复利", ja: "クオリティ複利" },
    family: "quality",
    question: "Does the business earn high returns with cash-backed profits and modest leverage?",
    scope: ["operating_company"],
    minEvaluable: 3,
    checks: ({ r }) => [
      check("ROE", r.roe_pct, "> 15%", (x) => x > 15, "%"),
      check("Gross margin", r.gross_margin_pct, "> 40%", (x) => x > 40, "%"),
      check("Operating margin", r.operating_margin_pct, "> 15%", (x) => x > 15, "%"),
      check("FCF / net income", r.fcf_conversion, "> 0.8", (x) => x > 0.8),
      check("Debt / equity", r.debt_to_equity, "< 1.0", (x) => x < 1),
    ],
  },
  {
    id: "garp",
    name: { en: "Growth at a reasonable price", "zh-CN": "合理价格成长（GARP）", ja: "GARP" },
    family: "growth",
    question: "Is earnings growth available without paying a speculative multiple?",
    scope: ["operating_company"],
    minEvaluable: 2,
    checks: ({ r }) => [
      check("PEG", r.peg, "< 1.5", (x) => x > 0 && x < 1.5),
      check("EPS growth (FY)", r.eps_growth_pct ?? r.net_income_growth_pct, "> 10%", (x) => x > 10, "%"),
      check("P/E (TTM)", r.pe_ttm, "< 30", (x) => x > 0 && x < 30),
      check("Revenue growth (FY)", r.revenue_growth_pct, "> 5%", (x) => x > 5, "%"),
    ],
  },
  {
    id: "growth",
    name: { en: "Secular growth", "zh-CN": "长期成长", ja: "長期成長" },
    family: "growth",
    question: "Is revenue compounding fast enough, with gross margin to fund reinvestment?",
    scope: ["operating_company"],
    minEvaluable: 2,
    checks: ({ r }) => [
      check("Revenue growth (FY)", r.revenue_growth_pct, "> 15%", (x) => x > 15, "%"),
      check("Revenue CAGR 3y", r.revenue_cagr_3y_pct, "> 12%", (x) => x > 12, "%"),
      check("Gross margin", r.gross_margin_pct, "> 45%", (x) => x > 45, "%"),
      check("P/S (TTM)", r.ps_ttm, "< 15", (x) => x > 0 && x < 15),
    ],
  },
  {
    id: "trend_momentum",
    name: { en: "Trend and momentum", "zh-CN": "趋势与动量", ja: "トレンド・モメンタム" },
    family: "technical",
    question: "Is the price trend confirming or fighting the thesis?",
    scope: ["operating_company", "fund_lookthrough", "index_aggregate"],
    minEvaluable: 3,
    checks: ({ t }) => [
      check("Price vs 200-day avg", t.pct_vs_sma200, "> 0%", (x) => x > 0, "%"),
      check("50-day avg vs 200-day avg", t.sma50 && t.sma200 ? ((t.sma50 - t.sma200) / t.sma200) * 100 : null, "> 0%", (x) => x > 0, "%"),
      check("12-1 month momentum", t.momentum_12_1_pct, "> 0%", (x) => x > 0, "%"),
      check("Distance from 52w high", t.pct_from_52w_high, "> -15%", (x) => x > -15, "%"),
    ],
  },
  {
    id: "shareholder_yield",
    name: { en: "Shareholder yield", "zh-CN": "股东回报收益率", ja: "株主還元利回り" },
    family: "income",
    question: "Does the company return cash, and is that return covered by free cash flow?",
    scope: ["operating_company"],
    minEvaluable: 2,
    checks: ({ r, q }) => [
      check("Dividend + buyback yield", r.shareholder_yield_pct, "> 3%", (x) => x > 3, "%"),
      check("FCF yield", r.fcf_yield_pct, "> 4%", (x) => x > 4, "%"),
      check("Share count change (1y)", r.share_count_change_pct, "< 0%", (x) => x < 0, "%"),
      check("Dividend yield", q.dividend_yield_pct, "> 1.5%", (x) => x > 1.5, "%"),
    ],
  },
  {
    id: "balance_sheet_risk",
    name: { en: "Forensic balance-sheet risk", "zh-CN": "资产负债表风险排查", ja: "財務リスク点検" },
    family: "risk",
    question: "Could leverage, cash burn or dilution break the thesis before it plays out?",
    scope: ["operating_company"],
    minEvaluable: 3,
    // Passing checks here mean LOW risk, so a supportive stance is "no red flags".
    checks: ({ r, m }) => [
      check("Debt / operating cash flow", r.debt_to_ocf, "< 3x", (x) => x < 3),
      check("Interest coverage", r.interest_coverage, "> 5x", (x) => x > 5),
      check("Free cash flow (TTM)", m.free_cash_flow?.value ?? null, "> 0", (x) => x > 0),
      check("Share count change (1y)", r.share_count_change_pct, "< 3%", (x) => x < 3, "%"),
      check("Current ratio", r.current_ratio, "> 1.0", (x) => x > 1),
    ],
  },
  {
    id: "contrarian_reversal",
    name: { en: "Contrarian reversal", "zh-CN": "逆向反转", ja: "逆張りリバーサル" },
    family: "contrarian",
    question: "Has the market punished a still-cash-generative business far enough to offer asymmetry?",
    scope: ["operating_company"],
    minEvaluable: 3,
    checks: ({ r, t }) => [
      check("Distance from 52w high", t.pct_from_52w_high, "< -30%", (x) => x < -30, "%"),
      check("RSI(14)", t.rsi14, "< 40", (x) => x < 40),
      check("FCF yield", r.fcf_yield_pct, "> 5%", (x) => x > 5, "%"),
      check("Net cash", r.net_cash, "> 0", (x) => x > 0),
    ],
  },
];

export const LENS_IDS = LENSES.map((l) => l.id);

export function lensName(lens, language = "en") {
  return lens.name[language] || lens.name.en;
}

/**
 * @param {{instrument, quote, technicals, fundamentals}} facts
 * @param {string[]} ids selected lens IDs (default all)
 */
export function evaluateLenses(facts, ids = LENS_IDS, language = "en") {
  const route = facts.instrument?.route || "operating_company";
  const ctx = {
    r: facts.fundamentals?.ratios || {},
    m: facts.fundamentals?.metrics || {},
    t: facts.technicals?.available ? facts.technicals : {},
    q: facts.quote || {},
  };
  return ids.map((id) => {
    const lens = LENSES.find((l) => l.id === id);
    if (!lens) throw new Error(`unknown lens: ${id}`);
    const base = { id, name: lensName(lens, language), family: lens.family, question: lens.question };
    if (!lens.scope.includes(route)) {
      return { ...base, stance: "out_of_scope", score: null, checks: [], rationale: `This lens applies to ${lens.scope.join("/")}; the instrument routes as ${route}.` };
    }
    const checks = lens.checks(ctx);
    const evaluable = checks.filter((c) => c.pass !== null);
    const passed = evaluable.filter((c) => c.pass).length;
    if (evaluable.length < lens.minEvaluable) {
      const missing = checks.filter((c) => c.pass === null).map((c) => c.label);
      return { ...base, stance: "out_of_scope", score: null, checks, rationale: `Only ${evaluable.length}/${checks.length} checks had data (needs ${lens.minEvaluable}); missing: ${missing.join(", ")}.` };
    }
    const score = passed / evaluable.length;
    const stance = score >= 0.75 ? "supportive" : score <= 0.25 ? "opposed" : "neutral";
    return {
      ...base,
      stance,
      score: Math.round(score * 100) / 100,
      checks,
      rationale: `${passed}/${evaluable.length} evaluable checks passed.`,
    };
  });
}
