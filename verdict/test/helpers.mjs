// Fixtures: an isolated VERDICT_HOME, a snapshot and a scripted backend.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function isolateHome() {
  const dir = mkdtempSync(join(tmpdir(), "verdict-test-"));
  process.env.VERDICT_HOME = dir;
  process.env.VERDICT_NO_CACHE = "1";
  return dir;
}

export async function fakeSnapshot(symbol = "TEST") {
  const { evaluateLenses, LENS_IDS } = await import("../src/engine/lenses.mjs");
  const s = {
    symbol,
    as_of: new Date().toISOString(),
    instrument: { symbol, name: "Test Corp", type: "equity", route: "operating_company", cik: "0000000001", exchange: "NASDAQ", gaps: [] },
    quote: { symbol, price: 100, currency: "USD", change_pct: 1.2, market_time: "2026-09-23T20:00:00.000Z", high_52w: 120, low_52w: 70, dividend_yield_pct: 1.1, source: { title: "Yahoo Finance chart", url: "https://example.com/q" } },
    technicals: { available: true, return_1m_pct: 3, return_3m_pct: 8, return_12m_pct: 25, momentum_12_1_pct: 20, pct_vs_sma50: 2, pct_vs_sma200: 10, sma50: 98, sma200: 91, rsi14: 58, realized_vol_30d_pct: 24, pct_from_52w_high: -8, max_drawdown_1y_pct: -18, volume_20d_vs_3m: 1.1 },
    fundamentals: {
      metrics: { revenue: { value: 5e10, as_of: "2026-06-30" }, net_income: { value: 1e10 }, free_cash_flow: { value: 1.2e10 }, eps_diluted: { value: 5 } },
      ratios: { gross_margin_pct: 55, operating_margin_pct: 28, net_margin_pct: 20, roe_pct: 30, fcf_conversion: 1.2, debt_to_equity: 0.4, pe_ttm: 20, pb: 6, ps_ttm: 4, peg: 1.2, eps_growth_pct: 16, revenue_growth_pct: 12, revenue_cagr_3y_pct: 11, fcf_yield_pct: 6, shareholder_yield_pct: 4, share_count_change_pct: -2, debt_to_ocf: 1, interest_coverage: 20, current_ratio: 1.6, net_cash: 5e9 },
      annual: { revenue: [{ fiscal_year_end: "2025-12-31", value: 4.6e10 }] },
      source: { title: "SEC companyfacts", url: "https://example.com/f" },
    },
    filings: null,
    options: null,
    news: [{ id: "news:N1", title: "Test Corp beats estimates", url: "https://example.com/n1", publisher: "Wire", date: "2026-09-20" }],
    gaps: ["options: not in fixture"],
    elapsed_ms: 12,
  };
  s.sources = {
    "data:quote": s.quote.source,
    "data:technicals": { title: "Yahoo history", url: "https://example.com/h" },
    "data:fundamentals": s.fundamentals.source,
    "news:N1": { title: s.news[0].title, url: s.news[0].url, date: s.news[0].date },
  };
  s.lenses = evaluateLenses(s, LENS_IDS);
  return s;
}

export function deskPacket(tag = "desk") {
  return {
    summary: `${tag}: steady growth with a full valuation; margins hold.`,
    stance: "bullish",
    findings: [
      { claim: `${tag}: revenue grew 12% in the latest fiscal year.`, impact: "bullish", sources: ["S1", "data:fundamentals"] },
      { claim: `${tag}: operating margin held at 28%.`, impact: "bullish", sources: ["S1"] },
      { claim: `${tag}: 20x earnings leaves little room for a miss.`, impact: "bearish", sources: ["data:quote", "S9"] },
      { claim: `${tag}: an unsourced rumor.`, impact: "neutral", sources: ["S7"] },
    ],
    key_numbers: [{ label: "Consensus FY EPS", value: "5.75 USD", source: "S1" }, { label: "junk", value: "", source: "" }],
    sources: [{ id: "S1", title: "Q2 10-Q", url: "https://example.com/10q", date: "2026-08-01" }, { id: "S2", title: "Bad", url: "not-a-url", date: "" }],
    gaps: [],
  };
}

export function casePacket(side) {
  return {
    thesis: `${side}: the evidence points ${side === "bull" ? "up" : "down"} over twelve months.`,
    points: [
      { point: `${side} point one`, evidence: ["business:S1", "data:quote"] },
      { point: `${side} point two`, evidence: ["lens:garp", "made:up"] },
    ],
    answer_to_other_side: "They overstate the multiple risk.",
    would_change_my_mind: "Operating margin below 24% for two quarters.",
  };
}

export function decisionPacket() {
  return {
    rating: "Overweight",
    conclusion: "Overweight: durable margins and cash conversion outweigh a full multiple.",
    confidence: "medium",
    confidence_reason: "Consensus data was thin.",
    debate_winner: "bull",
    debate_reason: "Bull won on cash conversion.",
    bull_case: "Compounding at a reasonable multiple.",
    bear_case: "A slowdown compresses margin and multiple together.",
    valuation: { currency: "USD", bear: 140, base: 115, bull: 80, method: "20x base EPS." },
    price_levels: [{ range: "> 130", action: "avoid", why: "prices in the bull case" }, { range: "95-115", action: "start", why: "fair" }, { range: "< 85", action: "add", why: "cheap" }],
    catalysts: [{ event: "Q3 earnings", timing: "late Oct 2026", direction: "either" }],
    risks: [{ risk: "Demand slowdown", severity: "high" }],
    position: { action: "initiate small long", sizing: "2%", entry: "95-110", exit: "trim above 130" },
    horizons: { short_term: "range-bound", medium_term: "upside if margins hold", long_term: "toward base value" },
    invalidation: ["Operating margin below 24%"],
    gaps: [],
    key_sources: ["business:S1", "data:quote", "nope:X"],
  };
}

/** A backend that answers from fixtures; `fail` names tasks to throw on (matched by prompt). */
export function fakeBackend({ fail = [], delayMs = 5 } = {}) {
  const calls = [];
  return {
    name: "fake",
    models: { research: "fake", debate: "fake", decision: "fake", chat: "fake" },
    calls,
    async call(req) {
      calls.push(req);
      await new Promise((r) => setTimeout(r, delayMs));
      const who = req.tier === "research" ? (req.system.match(/"([^"]+)" desk/) || [])[1] : req.tier === "debate" ? (/BULL/.test(req.system) ? "bull" : "bear") : req.tier;
      if (fail.includes(who)) throw new Error(`${who} exploded`);
      req.onActivity?.(`search: ${who}`);
      if (req.tier === "research") return { data: deskPacket(who), costUsd: 0.1 };
      if (req.tier === "debate") return { data: casePacket(who), costUsd: 0.05 };
      if (req.schema?.properties?.ranking) {
        const syms = [...req.user.matchAll(/^([A-Z0-9.^-]+)(?: \(|:)/gm)].map((m) => m[1]);
        return { data: { summary: `${syms[0]} is the best idea.`, ranking: syms.map((symbol, i) => ({ symbol, rank: i + 1, why: `${symbol} reason` })) }, costUsd: 0.1 };
      }
      if (req.tier === "decision") {
        const json = JSON.stringify(decisionPacket());
        for (let i = 0; i < json.length; i += 40) req.onText?.(json.slice(i, i + 40));
        return { data: decisionPacket(), costUsd: 0.2 };
      }
      return { text: `answer to: ${req.user.split("Q: ").pop()}`, costUsd: 0.01 };
    },
  };
}
