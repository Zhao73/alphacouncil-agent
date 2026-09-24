// What kind of question is this? The answer changes what the desks prioritise and how the
// portfolio manager frames the decision. Keyword rules in en/zh/ja — fast, free, predictable.

const RULES = [
  {
    kind: "earnings",
    horizon: "into and just after the next earnings report",
    re: /earnings|results|report(ing)?\s+(date|week)|guidance|beat|miss|财报|业绩|季报|年报|指引|決算|業績/i,
    focus: "The user is deciding around the next earnings report. Prioritise: the report date, consensus and whisper numbers, guidance history (beat/miss record), options-implied move, what would surprise, and positioning into the print.",
  },
  {
    kind: "valuation",
    horizon: "12 months",
    re: /valuation|fair value|intrinsic|cheap|expensive|overvalued|undervalued|target price|worth|估值|贵|便宜|高估|低估|目标价|合理价|割安|割高|目標株価/i,
    focus: "The user asks about value. Prioritise: what the price implies (reverse the valuation), bear/base/bull per-share values with explicit assumptions, multiples against history and named peers, and the margin of safety at today's price.",
  },
  {
    kind: "trade",
    horizon: "1-4 weeks",
    re: /short[- ]term|this week|next week|swing|trade|entry|stop|technical|breakout|短线|短期|这周|下周|入场|止损|技术面|短期売買|今週/i,
    focus: "The user is thinking about a short-term trade. Prioritise: the technical position and levels from the snapshot, upcoming dated catalysts in the next 4 weeks, options positioning and flows, and a clear entry/stop plan.",
  },
  {
    kind: "long_term",
    horizon: "3-5 years",
    re: /long[- ]term|hold for|years|retire|compound|moat|长期|长线|几年|拿住|护城河|长期保有|長期/i,
    focus: "The user is a long-term holder. Prioritise: durability of the moat, reinvestment runway, capital allocation, balance-sheet resilience and what the business looks like in 3-5 years; treat short-term noise as noise.",
  },
  {
    kind: "risk",
    horizon: "12 months",
    re: /risk|downside|worst case|should i sell|sell\b|crash|bear case|风险|下跌|卖出|要不要卖|跌|リスク|売る/i,
    focus: "The user is worried about downside. Prioritise: the concrete paths to loss, balance-sheet and refinancing risk, what is and is not priced in, and the levels where the thesis breaks.",
  },
];

export function classifyQuestion(question = "") {
  const q = String(question || "");
  for (const r of RULES) if (r.re.test(q)) return { kind: r.kind, horizon: r.horizon, focus: r.focus };
  return { kind: "general", horizon: "12 months", focus: "" };
}
