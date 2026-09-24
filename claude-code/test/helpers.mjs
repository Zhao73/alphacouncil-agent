// Shared fixtures: a frozen grounding snapshot and valid packets for every stage.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function isolateHome() {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-test-"));
  process.env.ALPHACOUNCIL_HOME = dir;
  return dir;
}

export function fakeGrounding(symbol = "TEST") {
  return {
    instrument: { symbol, name: "Test Corp", type: "equity", route: "operating_company", cik: "0000000001", gaps: [] },
    quote: { symbol, price: 100, currency: "USD", change_pct: 1.2, market_time: "2026-09-23T20:00:00.000Z", high_52w: 120, low_52w: 70, dividend_yield_pct: 1.1, exchange: "NASDAQ", source: { title: `Yahoo Finance chart ${symbol}`, url: "https://example.com/quote", retrieved: "2026-09-24" } },
    technicals: { available: true, return_1m_pct: 3, return_3m_pct: 8, return_12m_pct: 25, momentum_12_1_pct: 20, pct_vs_sma50: 2, pct_vs_sma200: 10, sma50: 98, sma200: 91, rsi14: 58, realized_vol_30d_pct: 24, pct_from_52w_high: -8, max_drawdown_1y_pct: -18 },
    fundamentals: {
      available: true,
      metrics: { revenue: { value: 5e10, as_of: "2026-06-30" }, net_income: { value: 1e10 }, free_cash_flow: { value: 1.2e10 }, eps_diluted: { value: 5 } },
      ratios: { gross_margin_pct: 55, operating_margin_pct: 28, net_margin_pct: 20, roe_pct: 30, fcf_conversion: 1.2, debt_to_equity: 0.4, pe_ttm: 20, pb: 6, ps_ttm: 4, peg: 1.2, eps_growth_pct: 16, revenue_growth_pct: 12, revenue_cagr_3y_pct: 11, fcf_yield_pct: 6, shareholder_yield_pct: 4, share_count_change_pct: -2, debt_to_ocf: 1, interest_coverage: 20, current_ratio: 1.6, net_cash: 5e9 },
      source: { title: "SEC companyfacts", url: "https://example.com/facts", retrieved: "2026-09-24" },
    },
    filings: null,
    options: null,
    gaps: ["options: fixture has no options"],
    sources: {
      "grounding:quote": { title: "Yahoo Finance chart", url: "https://example.com/quote", retrieved: "2026-09-24" },
      "grounding:technicals": { title: "Yahoo history", url: "https://example.com/hist", retrieved: "2026-09-24" },
      "grounding:fundamentals": { title: "SEC companyfacts", url: "https://example.com/facts", retrieved: "2026-09-24" },
    },
  };
}

export function evidencePacket(role) {
  return {
    summary: `The ${role} seat found steady fundamentals with a few risks worth monitoring closely.`,
    signal: "bullish",
    confidence: "medium",
    findings: [
      { claim: `${role}: revenue grew 12% year over year in the latest fiscal year.`, impact: "bullish", sources: ["S1"] },
      { claim: `${role}: operating margin held at 28% despite input cost pressure.`, impact: "bullish", sources: ["S1", "S2"] },
      { claim: `${role}: valuation at 20x earnings leaves little room for a miss.`, impact: "bearish", sources: ["S2"] },
    ],
    sources: [
      { id: "S1", title: "Q2 2026 10-Q", url: "https://example.com/10q", date: "2026-08-01" },
      { id: "S2", title: "AlphaCouncil quote tool", url: "tool:quote" },
    ],
    data_gaps: [],
  };
}

export function debatePacket(round, side, opponentQuestions = []) {
  if (round === 1) {
    return {
      thesis: `The ${side} case: the evidence supports a ${side === "bull" ? "higher" : "lower"} price over twelve months.`,
      arguments: [
        { point: `${side} argument one grounded in the earnings record.`, evidence: ["earnings_deep_dive:S1"] },
        { point: `${side} argument two grounded in valuation and lenses.`, evidence: ["grounding:fundamentals", "lens:quality_compounder"] },
      ],
    };
  }
  if (round === 2) {
    return {
      rebuttals: [{ target: "the opponent's valuation point", response: `${side} rebuttal: the multiple is justified by the margin record.`, evidence: ["market_data:S1"] }],
      questions: [{ id: "Q1", question: `${side} asks: what margin do you assume for next year?` }, { id: "Q2", question: `${side} asks: what breaks your thesis first?` }],
    };
  }
  return {
    answers: opponentQuestions.map((q) => ({ question_id: q.id, answer: `${side} answer to ${q.id}: we assume stable margins near 28%.`, evidence: ["earnings_deep_dive:S1"] })),
    closing: `${side} closing: the case survives cross-examination with caveats noted.`,
  };
}

export function pmPacket() {
  return {
    rating: "Overweight",
    conclusion: "Overweight: durable margins and cash conversion outweigh a full multiple; the bear case rests on a slowdown not yet visible.",
    confidence: "medium",
    confidence_rationale: "Evidence is consistent but consensus data was thin.",
    debate_winner: "bull",
    debate_assessment: "Bull won on cash conversion; bear raised a fair point about the multiple that remains unresolved.",
    long_thesis: "Margins and FCF support compounding at a reasonable multiple for a quality business.",
    short_thesis: "A cyclical slowdown would compress both margins and the multiple at the same time.",
    market_expectations: "At 20x earnings the price implies roughly 10% annual EPS growth for five years.",
    valuation: { currency: "USD", bear: 80, base: 115, bull: 140, method: "20x base-case 2027 EPS of 5.75 with bear/bull multiples of 15x/23x." },
    price_levels: [
      { range: "> 130", meaning: "prices in the bull case already", action: "avoid" },
      { range: "95-115", meaning: "fair with modest margin of safety", action: "start" },
      { range: "< 85", meaning: "materially undervalued", action: "add" },
    ],
    catalysts: [{ event: "Q3 earnings", timing: "late Oct 2026", direction: "either" }, { event: "Investor day", timing: "Dec 2026", direction: "positive" }],
    risks: [{ risk: "Demand slowdown in core segment", severity: "high" }, { risk: "Input cost inflation", severity: "medium" }, { risk: "Regulatory review", severity: "low" }],
    position: { action: "initiate small long", sizing: "2% of portfolio", entry: "95-110", exit: "trim above 130" },
    horizons: { short_term: "Range-bound into earnings with event risk.", medium_term: "Upside if margins hold through Q4.", long_term: "Compounding toward the base value." },
    invalidation: ["Operating margin below 24% for two quarters", "FCF conversion below 0.8"],
    data_gaps: ["consensus estimates not retrieved"],
    key_sources: ["market_data:S1", "grounding:quote", "lens:quality_compounder"],
  };
}
