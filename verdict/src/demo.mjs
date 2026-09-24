// `verdict demo`: the full experience offline, on a fictional company. Nothing here is real
// market data — ACME Robotics does not exist. Used for first runs, screenshots and tests.

import { evaluateLenses, LENS_IDS } from "./engine/lenses.mjs";

const SYMBOL = "ACME";

export function demoSnapshot() {
  const series = Array.from({ length: 126 }, (_, i) => {
    const d = new Date(Date.UTC(2025, 9, 1) + i * 2 * 864e5).toISOString().slice(0, 10);
    const v = 118 + i * 0.55 + Math.sin(i / 7) * 6 + Math.sin(i / 23) * 9;
    return [d, Math.round(v * 100) / 100];
  });
  const price = series.at(-1)[1];
  const s = {
    symbol: SYMBOL,
    as_of: new Date().toISOString(),
    instrument: { symbol: SYMBOL, name: "Acme Robotics (fictional demo)", type: "equity", route: "operating_company", exchange: "DEMO", cik: null, gaps: [] },
    quote: { symbol: SYMBOL, price, currency: "USD", change_pct: 1.84, market_time: new Date().toISOString(), high_52w: 196.4, low_52w: 112.3, dividend_yield_pct: 0.4, source: { title: "Demo quote (fictional)", url: "https://example.com/demo/quote" } },
    technicals: { available: true, return_1m_pct: 6.2, return_3m_pct: 14.8, return_12m_pct: 41.5, momentum_12_1_pct: 33.1, pct_vs_sma50: 4.1, pct_vs_sma200: 17.9, sma50: price / 1.041, sma200: price / 1.179, rsi14: 61.4, realized_vol_30d_pct: 31.2, pct_from_52w_high: -6.3, max_drawdown_1y_pct: -22.4, volume_20d_vs_3m: 1.3 },
    series,
    fundamentals: {
      metrics: { revenue: { value: 18.4e9, as_of: "2026-06-30" }, net_income: { value: 2.9e9 }, free_cash_flow: { value: 3.3e9 }, eps_diluted: { value: 4.62 } },
      ratios: { gross_margin_pct: 47.2, operating_margin_pct: 19.8, net_margin_pct: 15.8, roe_pct: 24.1, fcf_conversion: 1.14, debt_to_equity: 0.35, pe_ttm: 39.8, pb: 8.9, ps_ttm: 6.3, peg: 1.6, eps_growth_pct: 24.9, revenue_growth_pct: 21.4, revenue_cagr_3y_pct: 18.2, fcf_yield_pct: 2.8, shareholder_yield_pct: 1.2, share_count_change_pct: 0.6, debt_to_ocf: 0.9, interest_coverage: 31, current_ratio: 2.1, net_cash: 2.1e9, market_cap: 116e9 },
      annual: { revenue: [{ fiscal_year_end: "2023-12-31", value: 11.1e9 }, { fiscal_year_end: "2024-12-31", value: 13.6e9 }, { fiscal_year_end: "2025-12-31", value: 16.5e9 }] },
      source: { title: "Demo financials (fictional)", url: "https://example.com/demo/financials" },
    },
    filings: null,
    options: { available: true, spot: price, put_call_oi_ratio: 0.71, put_call_volume_ratio: 0.64, term_structure: [{ days: 23, atm_iv_pct: 34.1, skew_25d_pct: 3.2 }, { days: 51, atm_iv_pct: 32.6, skew_25d_pct: 3.9 }], source: { title: "Demo options (fictional)", url: "https://example.com/demo/options" } },
    news: [
      { id: "news:N1", title: "Acme wins a multi-year warehouse automation contract", url: "https://example.com/demo/n1", publisher: "Demo Wire", date: "2026-09-18" },
      { id: "news:N2", title: "Acme raises full-year revenue outlook after strong quarter", url: "https://example.com/demo/n2", publisher: "Demo Wire", date: "2026-08-06" },
      { id: "news:N3", title: "Rival cuts prices on entry-level robot arms", url: "https://example.com/demo/n3", publisher: "Demo Journal", date: "2026-07-29" },
    ],
    gaps: ["demo mode: every number is fictional"],
    elapsed_ms: 900,
  };
  s.sources = {
    "data:quote": s.quote.source,
    "data:technicals": { title: "Demo price history (fictional)", url: "https://example.com/demo/history" },
    "data:fundamentals": s.fundamentals.source,
    "data:options": s.options.source,
    ...Object.fromEntries(s.news.map((n) => [n.id, { title: n.title, url: n.url, date: n.date }])),
  };
  s.lenses = evaluateLenses(s, LENS_IDS);
  return s;
}

const DESK = {
  business: {
    summary: "Growth is broad-based and cash-backed: revenue +21% with operating margin up 180 bp, and free cash flow above net income. The watch item is a rising services mix that lifts margin but depends on renewal rates.",
    stance: "bullish",
    findings: [
      ["Q2 revenue grew 22% year over year to 4.9B, led by logistics robots (+31%).", "bullish", ["S1", "data:fundamentals"]],
      ["Operating margin reached 19.8%, up 1.8 points, on price increases and a higher services mix.", "bullish", ["S1"]],
      ["Free cash flow of 3.3B exceeded net income (conversion 1.14x); receivables grew slower than sales.", "bullish", ["data:fundamentals", "S2"]],
      ["On the call, management called demand 'durable' but twice declined to quantify the order backlog.", "mixed", ["S2"]],
    ],
    key_numbers: [["Q2 revenue", "4.9B USD", "S1"], ["Operating margin", "19.8%", "data:fundamentals"], ["FY guidance", "19.6–19.9B USD", "S2"]],
  },
  street: {
    summary: "Consensus already expects ~20% growth for two more years, so the multiple leaves little room: at 40x trailing earnings the price implies high-teens growth through 2030. Estimates are still rising.",
    stance: "mixed",
    findings: [
      ["Consensus FY2027 EPS is 5.80 USD, raised 6% over the last three months.", "bullish", ["S1"]],
      ["Eight of eleven analysts rate it Buy; the median target is 205 USD after three raises since August.", "bullish", ["S2"]],
      ["Reverse DCF: 185 USD implies ~18% annual FCF growth for five years at a 9% discount rate.", "bearish", ["S3", "data:quote"]],
      ["Trades at 39.8x trailing earnings versus a five-year median of 31x.", "bearish", ["data:fundamentals", "S3"]],
    ],
    key_numbers: [["Consensus FY27 EPS", "5.80 USD", "S1"], ["Median target", "205 USD", "S2"], ["Bear / base / bull", "140 / 205 / 250 USD", "S3"]],
  },
  news: {
    summary: "The news flow is supportive — a large multi-year contract and a raised outlook — but a competitor's price cuts at the low end are the first sign of pressure on entry-level arms.",
    stance: "bullish",
    findings: [
      ["A multi-year warehouse contract (18 Sep) adds an estimated 1.1B USD of revenue over five years.", "bullish", ["news:N1", "S1"]],
      ["The FY outlook was raised on 6 Aug to 19.6–19.9B USD revenue.", "bullish", ["news:N2"]],
      ["A rival cut entry-level arm prices by ~15% on 29 Jul; entry models are ~12% of Acme revenue.", "bearish", ["news:N3", "S2"]],
      ["Investor day on 14 Nov is expected to set 2028 margin targets.", "mixed", ["S3"]],
    ],
    key_numbers: [["Contract value", "~1.1B USD / 5y", "S1"], ["Entry-level revenue share", "~12%", "S2"]],
  },
  risk: {
    summary: "Balance sheet is not the risk (net cash 2.1B). The risks are crowding and valuation: short interest is low, call skew is elevated and insiders sold into strength.",
    stance: "mixed",
    findings: [
      ["Short interest is 1.9% of float with 1.2 days to cover — positioning is crowded long.", "bearish", ["S1"]],
      ["Put/call open interest of 0.71 and 34% near-term implied volatility price a ~7% move into earnings.", "mixed", ["data:options"]],
      ["Two executives sold a combined 38M USD under 10b5-1 plans in August; no open-market buys.", "bearish", ["S2"]],
      ["Net cash of 2.1B USD and 31x interest coverage leave no refinancing risk.", "bullish", ["data:fundamentals"]],
    ],
    key_numbers: [["Short interest", "1.9% of float", "S1"], ["Implied move", "~7%", "data:options"]],
  },
};
DESK.all = { ...DESK.business, findings: [...DESK.business.findings.slice(0, 2), ...DESK.street.findings.slice(2), DESK.news.findings[2]], key_numbers: [...DESK.street.key_numbers] };

function deskPacket(id) {
  const d = DESK[id];
  return {
    summary: d.summary,
    stance: d.stance,
    findings: d.findings.map(([claim, impact, sources]) => ({ claim, impact, sources })),
    key_numbers: d.key_numbers.map(([label, value, source]) => ({ label, value, source })),
    sources: [1, 2, 3].map((n) => ({ id: `S${n}`, title: `Demo source ${n} for the ${id} desk (fictional)`, url: `https://example.com/demo/${id}/${n}`, date: "2026-09-1" + n })),
    gaps: id === "street" ? ["no independent survey of end-customer demand"] : [],
  };
}

const CASES = {
  bull: {
    thesis: "Acme is compounding at 20%+ with rising margins and cash conversion above 1x; the new contract and services mix extend that runway beyond what the multiple assumes.",
    points: [
      { point: "Revenue +22% with operating margin +1.8 points shows operating leverage, not just volume.", evidence: ["business:S1", "data:fundamentals"] },
      { point: "Estimates are still being raised (+6% in three months) — the direction that predicts returns.", evidence: ["street:S1"] },
      { point: "The multi-year contract adds visible revenue the market has not fully modelled.", evidence: ["news:N1", "news:S1"] },
      { point: "Net cash and 1.14x cash conversion mean growth is self-funded.", evidence: ["risk:S1", "data:fundamentals"] },
    ],
    answer_to_other_side: "The multiple is high, but earnings are growing 25%; on FY2027 consensus the stock trades near 32x, in line with its history.",
    would_change_my_mind: "Operating margin falling below 18% or estimate revisions turning negative for a quarter.",
  },
  bear: {
    thesis: "Everything good is known and priced: at 40x earnings the stock needs ~18% FCF growth for five years, positioning is crowded, and the low end is starting to see price competition.",
    points: [
      { point: "The reverse DCF already assumes ~18% FCF growth for five years — little room for a miss.", evidence: ["street:S3", "data:quote"] },
      { point: "A rival's 15% price cut hits a ~12% slice of revenue and could spread up-market.", evidence: ["news:N3", "news:S2"] },
      { point: "Short interest of 1.9% and elevated call skew make the stock vulnerable to a crowded exit.", evidence: ["risk:S1", "data:options"] },
      { point: "Insiders sold 38M USD into strength with no offsetting buys.", evidence: ["risk:S2"] },
    ],
    answer_to_other_side: "Rising estimates are real, but they are already in the median target of 205 USD — the upside is the consensus.",
    would_change_my_mind: "Services revenue sustaining 30%+ growth with margin expansion through the investor day targets.",
  },
};

const DECISION = {
  rating: "Overweight",
  conclusion: "Overweight, but build the position on weakness rather than chase. Acme is growing above 20% with expanding margins and cash conversion above 1x, and estimates are still rising — the strongest signals in the record. The bear is right that the price already assumes high-teens growth for years and that positioning is crowded, so the entry matters: below 175 USD the margin of safety is adequate; above 215 USD the upside is the consensus.",
  confidence: "medium",
  confidence_reason: "Fundamentals and revisions are consistent; valuation leaves little room for error and end-demand data is thin.",
  debate_winner: "bull",
  debate_reason: "The bull's operating-leverage and revision evidence is harder data; the bear's valuation point is valid but argues for entry discipline, not avoidance.",
  bull_case: CASES.bull.thesis,
  bear_case: CASES.bear.thesis,
  valuation: { currency: "USD", bear: 140, base: 205, bull: 250, method: "Base: 32x FY2027 EPS of 5.80 plus net cash; bear: 24x on 5.20 if growth slows to mid-teens; bull: 38x on 6.30 with services mix above 30%." },
  price_levels: [
    { range: "> 215", action: "avoid", why: "upside is the consensus target; risk/reward turns negative" },
    { range: "175-195", action: "start", why: "base case offers ~10-15% with limited multiple risk" },
    { range: "< 160", action: "add", why: "bear-case value within reach; buy the dislocation" },
  ],
  catalysts: [
    { event: "Q3 results and backlog disclosure", timing: "late Oct 2026", direction: "either" },
    { event: "Investor day — 2028 margin targets", timing: "14 Nov 2026", direction: "positive" },
    { event: "Competitor pricing response", timing: "Q4 2026", direction: "negative" },
  ],
  risks: [
    { risk: "Price competition spreads from entry-level arms to the core range", severity: "high" },
    { risk: "Crowded positioning unwinds on any growth wobble", severity: "medium" },
    { risk: "Services renewals disappoint and margin expansion stalls", severity: "medium" },
  ],
  position: { action: "start a half position, add below 175", sizing: "2-3% of the portfolio at full size", entry: "half now if below 195, the rest in the 160-175 zone", exit: "trim above 215; exit if operating margin falls below 18%" },
  horizons: { short_term: "Expect volatility into Q3 results; the options market prices a ~7% move.", medium_term: "Investor day targets are the key re-rating event.", long_term: "Base value 205 USD if growth holds near 20% and margins keep expanding." },
  invalidation: ["Operating margin below 18% for two quarters", "Consensus EPS revisions negative for a full quarter", "Entry-level price cuts spread to the core range"],
  gaps: ["No independent data on end-customer demand"],
  key_sources: ["business:S1", "street:S1", "street:S3", "news:N1", "data:fundamentals", "data:options"],
};

const ACTIVITY = {
  business: ["search: Acme Robotics Q2 results segment revenue", "read: example.com/demo/10-q", "search: Acme earnings call transcript backlog"],
  street: ["search: Acme consensus EPS 2027 revisions", "search: Acme price target changes", "read: example.com/demo/estimates"],
  news: ["search: Acme Robotics contract September 2026", "search: robot arm price cuts competitor", "read: example.com/demo/press"],
  risk: ["search: Acme short interest days to cover", "search: Acme Form 4 insider sales", "read: example.com/demo/form4"],
  all: ["search: Acme Robotics results guidance", "search: Acme valuation consensus", "search: Acme news risks"],
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.("abort", () => {
    clearTimeout(t);
    reject(new Error("stopped"));
  }, { once: true });
});

/** A backend that plays the fictional ACME research at a watchable pace. */
export function createDemoBackend({ speed = 1 } = {}) {
  const ms = (x) => Math.round(x * speed);
  return {
    name: "demo",
    models: { research: "demo", debate: "demo", decision: "demo", chat: "demo" },
    snapshotFor: async (symbol) => (symbol === SYMBOL ? demoSnapshot() : null),
    async call(req) {
      if (req.tier === "research") {
        const id = (Object.keys(ACTIVITY).find((k) => req.system.includes(`"${{ business: "Business & earnings", street: "Expectations & valuation", news: "News, industry & catalysts", risk: "Positioning & risk", all: "Research" }[k]}"`))) || "all";
        for (const a of ACTIVITY[id]) {
          req.onActivity?.(a);
          await sleep(ms(700 + Math.random() * 700), req.signal);
        }
        return { data: deskPacket(id), costUsd: 0 };
      }
      if (req.tier === "debate") {
        await sleep(ms(1500), req.signal);
        return { data: CASES[/BULL/.test(req.system) ? "bull" : "bear"], costUsd: 0 };
      }
      if (req.tier === "decision" && !req.schema?.properties?.ranking) {
        const json = JSON.stringify(DECISION);
        for (let i = 0; i < json.length; i += 24) {
          req.onText?.(json.slice(i, i + 24));
          await sleep(ms(25), req.signal);
        }
        return { data: DECISION, costUsd: 0 };
      }
      if (req.schema?.properties?.ranking) {
        const syms = [...req.user.matchAll(/^([A-Z0-9.^-]+)(?: \(|:)/gm)].map((m) => m[1]);
        return { data: { summary: "Demo ranking of fictional data.", ranking: syms.map((symbol, i) => ({ symbol, rank: i + 1, why: "demo" })) }, costUsd: 0 };
      }
      const answer = "In this demo the answer comes from the fictional report: the entry zone is 175-195 USD and the thesis breaks if operating margin falls below 18%.";
      for (const word of answer.split(" ")) {
        req.onText?.(`${word} `);
        await sleep(ms(30), req.signal);
      }
      return { text: answer, costUsd: 0 };
    },
  };
}

export const DEMO_SYMBOL = SYMBOL;
