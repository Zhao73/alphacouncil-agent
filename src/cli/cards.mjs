// The two static cards: the snapshot (seconds after start) and the decision summary (end).

import { t } from "../core/i18n.mjs";
import { upside } from "../core/report.mjs";
import { ui } from "./labels.mjs";
import { c, pad, truncate, width, wrapText } from "./term.mjs";

const big = (x) => (x === null || x === undefined ? "n/a" : Math.abs(x) >= 1e12 ? `${(x / 1e12).toFixed(2)}T` : Math.abs(x) >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(0)}M` : String(x));
const signed = (x, suffix = "%") => (x === null || x === undefined ? "n/a" : `${x > 0 ? "+" : ""}${x}${suffix}`);
const colorSigned = (x, s) => (x === null || x === undefined ? c.gray(s) : x >= 0 ? c.green(s) : c.red(s));

function stanceMark(stance) {
  if (stance === "supportive") return c.green("+");
  if (stance === "opposed") return c.red("−");
  if (stance === "neutral") return c.yellow("~");
  return c.gray("∅");
}

export function snapshotCard(s, language, cols = process.stdout.columns || 100) {
  const U = ui(language);
  const w = Math.min(cols, 110) - 2;
  const i = s.instrument || {};
  const out = [`${c.bold(c.cyan("◆"))} ${c.bold(s.symbol)}  ${i.name || ""} ${c.gray([i.exchange, i.type !== "unknown" ? i.type : null].filter(Boolean).join(" · "))}`];
  const q = s.quote;
  if (q) out.push(`  ${U.price} ${c.bold(`${q.price} ${q.currency}`)} ${colorSigned(q.change_pct, signed(q.change_pct))} ${c.gray(`(${String(q.market_time || "").slice(5, 16).replace("T", " ")})`)}   52w ${q.low_52w}–${q.high_52w}`);
  const tech = s.technicals;
  const r = s.fundamentals?.ratios || {};
  const bits = [];
  if (tech) bits.push(`${U.months12} ${colorSigned(tech.return_12m_pct, signed(tech.return_12m_pct))}`, `${U.fromHigh} ${signed(tech.pct_from_52w_high)}`, `RSI ${tech.rsi14}`);
  if (r.pe_ttm) bits.push(`P/E ${r.pe_ttm}`);
  if (r.ps_ttm) bits.push(`P/S ${r.ps_ttm}`);
  if (r.fcf_yield_pct !== undefined && r.fcf_yield_pct !== null) bits.push(`FCF ${r.fcf_yield_pct}%`);
  if (bits.length) out.push(`  ${bits.join(c.gray(" · "))}`);
  const m = s.fundamentals?.metrics;
  if (m?.revenue) out.push(`  ${U.revenue} ${big(m.revenue.value)}${r.revenue_growth_pct !== undefined && r.revenue_growth_pct !== null ? ` (${signed(r.revenue_growth_pct)})` : ""} · ${U.margins} ${r.gross_margin_pct ?? "n/a"}%/${r.operating_margin_pct ?? "n/a"}% · ROE ${r.roe_pct ?? "n/a"}%${r.market_cap ? ` · cap ${big(r.market_cap)}` : ""}`);
  if (s.lenses?.length) out.push(`  ${c.gray(U.lenses)} ${s.lenses.map((l) => `${l.id.split("_")[0]}${stanceMark(l.stance)}`).join(" ")}`);
  for (const n of (s.news || []).slice(0, 3)) out.push(`  ${c.gray(n.date.slice(5))} ${truncate(n.title, w - 8)}`);
  if (s.gaps?.length) out.push(`  ${c.yellow(`${U.gaps}: ${truncate(s.gaps.join("; "), w - 8)}`)}`);
  return out.join("\n");
}

function ratingColor(rating) {
  return /Buy|Overweight/.test(rating) ? c.green : /Sell|Underweight/.test(rating) ? c.red : c.yellow;
}

const arrow = (rating) => (/Buy|Overweight/.test(rating) ? "▲" : /Sell|Underweight/.test(rating) ? "▼" : "◆");

const LABEL_W = 10;

function field(label, text, w, lines = 3) {
  const wrapped = wrapText(String(text || ""), w - LABEL_W - 1);
  const shown = wrapped.slice(0, lines);
  if (wrapped.length > lines) {
    const last = truncate(shown[lines - 1], w - LABEL_W - 3);
    shown[lines - 1] = last.endsWith("…") ? last : `${last}…`;
  }
  return shown.map((l, i) => `${i === 0 ? c.gray(pad(label, LABEL_W)) : " ".repeat(LABEL_W)} ${l}`).join("\n");
}

export function summaryCard(run, { cols = process.stdout.columns || 100, reportFile = "" } = {}) {
  const U = ui(run.language);
  const L = t(run.language);
  const w = Math.min(cols, 110);
  const d = run.decision;
  const rule = c.gray("━".repeat(w));
  const out = [rule];
  const head = `${c.bold(run.symbol)}  ${run.name || ""}`;
  if (d) {
    const r = `${ratingColor(d.rating)(c.bold(`${d.rating} ${arrow(d.rating)}`))}  ${c.gray(`${U.confidence} ${L.levels[d.confidence] || d.confidence}`)}`;
    out.push(`${head}${" ".repeat(Math.max(2, w - width(head) - width(r)))}${r}`);
    const q = run.snapshot?.quote;
    const up = upside(run);
    out.push(`${q ? `${U.price} ${q.price} ${q.currency} · ` : ""}${U.value} ${d.valuation.bear} / ${c.bold(String(d.valuation.base))} / ${d.valuation.bull} ${d.valuation.currency}${up === null ? "" : ` · ${U.upside} ${colorSigned(up, signed(Math.round(up)))}`}`);
    out.push(c.gray("─".repeat(w)));
    out.push(field(U.conclusion, d.conclusion, w, 9));
    if (run.cases?.bull || d.bull_case) out.push(field(U.bull, run.cases?.bull?.thesis || d.bull_case, w, 2));
    if (run.cases?.bear || d.bear_case) out.push(field(U.bear, run.cases?.bear?.thesis || d.bear_case, w, 2));
    if (d.debate_winner !== "none") out.push(field(U.verdict, `${L.winner[d.debate_winner] || d.debate_winner} — ${d.debate_reason}`, w, 2));
    out.push(field(U.levels, d.price_levels.map((l) => `${l.range} ${l.action}`).join(" · "), w, 2));
    if (d.catalysts.length) out.push(field(U.catalysts, d.catalysts.slice(0, 3).map((x) => `${x.timing} ${x.event}`).join(" · "), w, 2));
    if (d.risks.length) out.push(field(U.risks, d.risks.slice(0, 3).map((x) => `${L.levels[x.severity] || x.severity}·${x.risk}`).join(" · "), w, 2));
    out.push(field(U.position, `${d.position.action} · ${d.position.sizing}`, w, 2));
  } else {
    out.push(head, c.red(`${run.state}: ${run.reason || ""}`));
  }
  out.push(rule);
  const stateColor = run.state === "complete" ? c.green : run.state === "degraded" ? c.yellow : c.red;
  const secs = Math.round((run.elapsed_ms || 0) / 1000);
  out.push(c.gray(`${U.report} ${reportFile} · ${U.elapsed} ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}${run.cost_usd ? ` · ${U.cost} $${run.cost_usd.toFixed(2)}` : ""} · ${U.status} `) + stateColor(run.state));
  return out.join("\n");
}
