// The snapshot: every fact code can fetch, in parallel, before any model runs. Research desks
// start from it instead of each re-searching the basics — the biggest single speed win.

import * as data from "./data.mjs";
import { evaluateLenses, LENS_IDS } from "./lenses.mjs";

async function settle(label, fn, gaps) {
  try {
    return await fn();
  } catch (error) {
    gaps.push(`${label}: ${error.message}`);
    return null;
  }
}

export async function buildSnapshot(query, { news = true, options = true } = {}) {
  const symbol = data.normalizeSymbol(query);
  const gaps = [];
  const started = Date.now();
  const [instrument, quote, history] = await Promise.all([
    settle("instrument", () => data.resolveInstrument(symbol), gaps),
    settle("quote", () => data.getQuote(symbol), gaps),
    settle("price history", () => data.getHistory(symbol, "2y"), gaps),
  ]);
  const inst = instrument || { symbol, type: "unknown", route: "operating_company", gaps: [] };
  gaps.push(...(inst.gaps || []).map((g) => `instrument: ${g}`));
  const newsQuery = inst.name ? `"${inst.name.replace(/[,.]?\s+(Inc|Corp|Corporation|Ltd|plc|Co|Holdings|Group)\.?$/i, "")}" OR ${symbol}` : symbol;
  const [fundamentals, filings, opt, headlines] = await Promise.all([
    settle("fundamentals", () => data.getFundamentals(symbol, { instrument: inst, price: quote?.price, currency: quote?.currency || "USD" }), gaps),
    inst.cik ? settle("filings", () => data.getFilings(symbol, { instrument: inst, limit: 12 }), gaps) : null,
    options && inst.route !== "fund_lookthrough" ? settle("options", () => data.getOptions(symbol), gaps) : null,
    news ? settle("news", () => data.getNews(newsQuery, { days: 30, limit: 15 }), gaps) : null,
  ]);
  if (fundamentals?.available === false) gaps.push(`fundamentals: ${fundamentals.reason}`);
  if (opt?.available === false) gaps.push(`options: ${opt.reason}`);

  const snap = {
    symbol,
    as_of: new Date().toISOString(),
    instrument: inst,
    quote,
    technicals: history?.technicals?.available ? history.technicals : null,
    series: history?.series || [],
    fundamentals: fundamentals?.available ? fundamentals : null,
    filings: filings?.available ? filings : null,
    options: opt?.available ? opt : null,
    news: headlines?.items?.length ? headlines.items.map((n, i) => ({ id: `news:N${i + 1}`, ...n })) : [],
    gaps,
    elapsed_ms: 0,
  };
  snap.sources = snapshotSources(snap, { history, headlines });
  snap.lenses = evaluateLenses(snap, LENS_IDS);
  snap.elapsed_ms = Date.now() - started;
  return snap;
}

function snapshotSources(s, { history, headlines }) {
  const src = {};
  if (s.quote) src["data:quote"] = s.quote.source;
  if (s.technicals) src["data:technicals"] = history.source;
  if (s.fundamentals) src["data:fundamentals"] = s.fundamentals.source;
  if (s.filings) src["data:filings"] = s.filings.source;
  if (s.options) src["data:options"] = s.options.source;
  for (const n of s.news) src[n.id] = { title: n.title, url: n.url, publisher: n.publisher, date: n.date };
  if (headlines && !s.news.length) src["data:news"] = headlines.source;
  return src;
}

const num = (x) => (x === null || x === undefined ? "n/a" : typeof x === "number" && Math.abs(x) >= 1e6 ? `${(x / 1e9).toFixed(2)}B` : String(x));

/** Compact fact sheet for prompts. Every line carries the ID a claim should cite. */
export function snapshotBrief(s) {
  const L = [];
  const i = s.instrument;
  L.push(`Instrument: ${s.symbol}${i.name ? ` — ${i.name}` : ""} · type ${i.type} · route ${i.route}${i.exchange ? ` · ${i.exchange}` : ""}`);
  const q = s.quote;
  if (q) L.push(`[data:quote] ${q.price} ${q.currency} (delayed, ${q.market_time}); day ${q.change_pct}%; 52w ${q.low_52w}–${q.high_52w}; dividend yield ${q.dividend_yield_pct ?? "n/a"}%`);
  const t = s.technicals;
  if (t) L.push(`[data:technicals] return 1m ${t.return_1m_pct}% · 3m ${t.return_3m_pct}% · 12m ${t.return_12m_pct}% · 12-1 momentum ${t.momentum_12_1_pct}%; vs SMA50 ${t.pct_vs_sma50}% · vs SMA200 ${t.pct_vs_sma200}%; RSI14 ${t.rsi14}; 30d vol ${t.realized_vol_30d_pct}%; from 52w high ${t.pct_from_52w_high}%; 1y max drawdown ${t.max_drawdown_1y_pct}%; volume 20d/3m ${t.volume_20d_vs_3m}`);
  const f = s.fundamentals;
  if (f) {
    const m = f.metrics;
    const r = f.ratios;
    L.push(`[data:fundamentals] SEC XBRL, USD, TTM to ${m.revenue?.as_of || "n/a"}: revenue ${num(m.revenue?.value)}, net income ${num(m.net_income?.value)}, FCF ${num(m.free_cash_flow?.value)}, diluted EPS ${m.eps_diluted?.value ?? "n/a"}; gross/op/net margin ${r.gross_margin_pct ?? "n/a"}/${r.operating_margin_pct ?? "n/a"}/${r.net_margin_pct ?? "n/a"}%; revenue growth FY ${r.revenue_growth_pct ?? "n/a"}% (3y CAGR ${r.revenue_cagr_3y_pct ?? "n/a"}%); ROE ${r.roe_pct ?? "n/a"}%; debt/equity ${r.debt_to_equity ?? "n/a"}; net cash ${num(r.net_cash)}; market cap ${num(r.market_cap)}; P/E ${r.pe_ttm ?? "n/a"} · P/S ${r.ps_ttm ?? "n/a"} · P/B ${r.pb ?? "n/a"} · EV/revenue ${r.ev_to_revenue ?? "n/a"} · FCF yield ${r.fcf_yield_pct ?? "n/a"}% · PEG ${r.peg ?? "n/a"}; share count 1y ${r.share_count_change_pct ?? "n/a"}%`);
    const rev = f.annual?.revenue;
    if (rev?.length) L.push(`  annual revenue: ${rev.map((x) => `${x.fiscal_year_end.slice(0, 4)} ${num(x.value)}`).join(", ")}`);
  }
  if (s.filings) L.push(`[data:filings] recent: ${s.filings.filings.slice(0, 10).map((x) => `${x.form} ${x.filed}`).join(", ")}`);
  const o = s.options;
  if (o) L.push(`[data:options] put/call OI ${o.put_call_oi_ratio} · volume ${o.put_call_volume_ratio}; ATM IV ${o.term_structure.slice(0, 5).map((x) => `${x.days}d ${x.atm_iv_pct}%${x.skew_25d_pct !== null ? `/skew ${x.skew_25d_pct}` : ""}`).join(", ")}`);
  if (s.news.length) {
    L.push("Recent headlines (30 days):");
    for (const n of s.news) L.push(`  [${n.id}] ${n.date} ${n.title}${n.publisher ? ` — ${n.publisher}` : ""}`);
  }
  L.push("Method lenses (deterministic screens on the facts above; out_of_scope = not enough data, not a vote):");
  for (const l of s.lenses) L.push(`  [lens:${l.id}] ${l.name.en || l.name}: ${l.stance}${l.score !== null ? ` (${l.score})` : ""} — ${l.checks.map((c) => `${c.label} ${c.display}${c.pass === null ? "" : c.pass ? "✓" : "✗"}`).join("; ") || l.rationale}`);
  if (s.gaps.length) L.push(`Data gaps: ${s.gaps.join("; ")}`);
  return L.join("\n");
}
