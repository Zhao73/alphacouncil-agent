// A single self-contained HTML report (no scripts, no external assets) with an inline SVG price
// chart and a valuation bar. Light and dark themes follow the reader's system setting.

import { deskTitle, t } from "../engine/i18n.mjs";
import { DESKS } from "../engine/prompts.mjs";
import { allGaps, upside } from "./markdown.mjs";

const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tone = (rating) => (/Buy|Overweight/.test(rating) ? "bull" : /Sell|Underweight/.test(rating) ? "bear" : "hold");

/** "> 280", "205-235", "< 198", "180 – 210" → [lo, hi] (null = open end). */
export function parseRange(text) {
  const s = String(text).replace(/,/g, "");
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return null;
  if (/^\s*[>≥]/.test(s) || /above|以上|超过/.test(s)) return [nums[0], null];
  if (/^\s*[<≤]/.test(s) || /below|以下|低于/.test(s)) return [null, nums[0]];
  if (nums.length >= 2) return [Math.min(nums[0], nums[1]), Math.max(nums[0], nums[1])];
  return [nums[0], nums[0]];
}

function actionTone(action) {
  const a = String(action).toLowerCase();
  if (/avoid|trim|sell|回避|减|卖|避/.test(a)) return "bear";
  if (/add|buy|加|买|買/.test(a)) return "bull";
  return "hold";
}

export function priceChart(run, { width = 720, height = 220 } = {}) {
  const series = run.snapshot?.series || [];
  if (series.length < 5) return "";
  const d = run.decision;
  const closes = series.map((p) => p[1]);
  const extra = d ? [d.valuation.bear, d.valuation.bull] : [];
  let lo = Math.min(...closes, ...extra);
  let hi = Math.max(...closes, ...extra);
  const padY = (hi - lo) * 0.08 || 1;
  lo -= padY;
  hi += padY;
  const L = 48;
  const R = 12;
  const T = 10;
  const B = 24;
  const x = (i) => L + (i / (series.length - 1)) * (width - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (height - T - B);
  const bands = (d?.price_levels || []).map((l) => {
    const r = parseRange(l.range);
    if (!r) return "";
    const top = y(Math.min(r[1] ?? hi, hi));
    const bot = y(Math.max(r[0] ?? lo, lo));
    return bot > top ? `<rect x="${L}" y="${top.toFixed(1)}" width="${width - L - R}" height="${(bot - top).toFixed(1)}" class="band ${actionTone(l.action)}"><title>${h(l.range)} · ${h(l.action)}</title></rect>` : "";
  }).join("");
  const line = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
  const refs = d ? [["bear", d.valuation.bear], ["base", d.valuation.base], ["bull", d.valuation.bull]].map(([k, v]) => `<line x1="${L}" x2="${width - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="ref ${k}"/><text x="${width - R - 4}" y="${(y(v) - 4).toFixed(1)}" class="lbl" text-anchor="end">${k} ${v}</text>`).join("") : "";
  const ticks = [lo + padY, (lo + hi) / 2, hi - padY].map((v) => `<text x="${L - 6}" y="${(y(v) + 4).toFixed(1)}" class="axis" text-anchor="end">${v.toFixed(v < 10 ? 2 : 0)}</text>`).join("");
  const dates = [0, Math.floor(series.length / 2), series.length - 1].map((i) => `<text x="${x(i).toFixed(1)}" y="${height - 6}" class="axis" text-anchor="${i === 0 ? "start" : i === series.length - 1 ? "end" : "middle"}">${h(series[i][0])}</text>`).join("");
  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="1-year price with value range and price levels">${bands}${refs}<path d="${line}" class="price"/>${ticks}${dates}</svg>`;
}

function valuationBar(run) {
  const d = run.decision;
  const price = run.snapshot?.quote?.price;
  if (!d) return "";
  const vals = [d.valuation.bear, d.valuation.base, d.valuation.bull, price].filter((v) => Number.isFinite(v));
  const lo = Math.min(...vals) * 0.92;
  const hi = Math.max(...vals) * 1.05;
  const pos = (v) => (((v - lo) / (hi - lo)) * 100).toFixed(1);
  const mark = (v, cls, label) => (Number.isFinite(v) ? `<div class="mk ${cls}" style="left:${pos(v)}%"><span>${h(label)}<b>${v}</b></span></div>` : "");
  return `<div class="vbar"><div class="range" style="left:${pos(d.valuation.bear)}%;right:${(100 - pos(d.valuation.bull)).toFixed(1)}%"></div>${mark(d.valuation.bear, "bear", "bear")}${mark(d.valuation.base, "base", "base")}${mark(d.valuation.bull, "bull", "bull")}${mark(price, "px", "price")}</div>`;
}

export function renderHtml(run) {
  const L = t(run.language);
  const d = run.decision;
  const q = run.snapshot?.quote;
  const up = upside(run);
  const title = `${run.symbol}${run.name ? ` · ${run.name}` : ""}`;
  const section = (heading, body) => (body ? `<section><h2>${h(heading)}</h2>${body}</section>` : "");
  const list = (items) => (items?.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>` : "");
  const cite = (ids) => (ids?.length ? ` <span class="cite">${ids.map(h).join(" · ")}</span>` : "");

  const debate = run.cases || d ? ["bull", "bear"].map((side) => {
    const c = run.cases?.[side];
    const body = c ? `<p>${h(c.thesis)}</p>${list(c.points.map((p) => `${h(p.point)}${cite(p.evidence)}`))}<p class="muted">${h(L.mind)}: ${h(c.would_change_my_mind)}</p>` : `<p>${h(side === "bull" ? d?.bull_case : d?.bear_case)}</p>`;
    return `<div class="side ${side}"><h3>${h(L[side])}</h3>${body}</div>`;
  }).join("") : "";

  const desks = Object.entries(run.desks || {}).map(([id, p]) => (p
    ? `<details><summary>${h(deskTitle(id, run.language, DESKS))} <span class="pill ${p.stance === "bullish" ? "bull" : p.stance === "bearish" ? "bear" : "hold"}">${h(p.stance)}</span></summary><p>${h(p.summary)}</p>${list(p.findings.map((f) => `${h(f.claim)}${cite(f.sources.map((s) => (/^S\d+$/.test(s) ? `${id}:${s}` : s)))}`))}${p.key_numbers?.length ? `<table>${p.key_numbers.map((k) => `<tr><td>${h(k.label)}</td><td><b>${h(k.value)}</b></td></tr>`).join("")}</table>` : ""}</details>`
    : `<details><summary>${h(deskTitle(id, run.language, DESKS))} <span class="pill bear">${h(L.failed)}</span></summary></details>`)).join("");

  const sources = [
    ...Object.entries(run.snapshot?.sources || {}).map(([id, s]) => [id, s.title, s.url, s.date]),
    ...Object.entries(run.desks || {}).flatMap(([desk, p]) => (p?.sources || []).map((s) => [`${desk}:${s.id}`, s.title, s.url, s.date])),
  ];

  const body = `
<header>
  <div class="brand">VERDICT</div>
  <h1>${h(title)}</h1>
  <div class="meta">${h(run.as_of)} · ${h(run.mode)}${q ? ` · ${h(q.price)} ${h(q.currency)}` : ""}${run.question ? ` · “${h(run.question)}”` : ""}</div>
  ${d ? `<div class="verdict ${tone(d.rating)}"><span class="rating">${h(d.rating)}</span><span>${h(L.confidence)} ${h(L.levels[d.confidence] || d.confidence)}</span>${up === null ? "" : `<span>${h(L.basev)} ${up >= 0 ? "+" : ""}${up.toFixed(0)}%</span>`}</div>` : `<div class="verdict hold"><span class="rating">${h(run.state)}</span><span>${h(run.reason || "")}</span></div>`}
</header>
${d ? `<p class="lead">${h(d.conclusion)}</p>` : ""}
${priceChart(run)}
${valuationBar(run)}
${d ? section(L.valuation, `<p class="muted">${h(d.valuation.method)}</p><table>${d.price_levels.map((l) => `<tr><td>${h(l.range)}</td><td><span class="pill ${actionTone(l.action)}">${h(l.action)}</span></td><td>${h(l.why)}</td></tr>`).join("")}</table>`) : ""}
${section(L.debate, debate ? `<div class="sides">${debate}</div>${d && d.debate_winner !== "none" ? `<p><b>${h(L.verdict)}: ${h(L.winner[d.debate_winner] || d.debate_winner)}</b> — ${h(d.debate_reason)}</p>` : ""}` : "")}
${d ? section(L.catalysts, list(d.catalysts.map((c) => `<b>${h(c.timing)}</b> · ${h(c.event)} <span class="muted">(${h(c.direction)})</span>`))) : ""}
${d ? section(L.risks, list(d.risks.map((r) => `<span class="pill ${r.severity === "high" ? "bear" : "hold"}">${h(L.levels[r.severity] || r.severity)}</span> ${h(r.risk)}`))) : ""}
${d ? section(L.position, `<p><b>${h(d.position.action)}</b> · ${h(d.position.sizing)}</p><p>${h(L.entry)}: ${h(d.position.entry)}<br>${h(L.exit)}: ${h(d.position.exit)}</p>`) : ""}
${d ? section(L.horizons, `<div class="grid3"><div><h4>${h(L.short_term)}</h4><p>${h(d.horizons.short_term)}</p></div><div><h4>${h(L.medium_term)}</h4><p>${h(d.horizons.medium_term)}</p></div><div><h4>${h(L.long_term)}</h4><p>${h(d.horizons.long_term)}</p></div></div>`) : ""}
${d ? section(L.invalidation, list(d.invalidation.map(h))) : ""}
${section(L.desks, desks)}
${run.snapshot?.lenses?.length ? section(L.lenses, `<table>${run.snapshot.lenses.map((l) => `<tr><td>${h(l.name)}</td><td><span class="pill ${l.stance === "supportive" ? "bull" : l.stance === "opposed" ? "bear" : "hold"}">${h(l.stance)}</span></td><td class="muted">${h(l.checks.map((c) => `${c.label} ${c.display}${c.pass === null ? "" : c.pass ? " ✓" : " ✗"}`).join(" · ") || l.rationale)}</td></tr>`).join("")}</table><p class="muted">${h(L.lens_note)}</p>`) : ""}
${section(L.gaps, (() => { const g = allGaps(run); return g.length ? list(g.map(h)) : `<p>${h(L.no_gaps)}</p>`; })())}
${section(L.sources, `<table class="src">${sources.map(([id, title, url, date]) => `<tr><td><code>${h(id)}</code></td><td>${url ? `<a href="${h(url)}">${h(title)}</a>` : h(title)}</td><td class="muted">${h(date || "")}</td></tr>`).join("")}</table>`)}
<footer>${h(L.disclaimer)} · Verdict</footer>`;

  return `<!doctype html>
<html lang="${h(run.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(run.symbol)} — ${h(d?.rating || run.state)} · Verdict</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1b16;--muted:#6b665c;--line:#e6e1d6;--card:#fff;--accent:#c98a0b;--bull:#1a7f37;--bear:#cf222e;--hold:#9a6700;--bullbg:#dafbe1;--bearbg:#ffebe9;--holdbg:#fff8c5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8e6e1;--muted:#9a978f;--line:#262a33;--card:#161a21;--accent:#f5a524;--bull:#3fb950;--bear:#f85149;--hold:#d29922;--bullbg:#12261a;--bearbg:#2d1416;--holdbg:#2b230f}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans","Noto Sans CJK SC",sans-serif}
main{max-width:880px;margin:0 auto;padding:32px 20px 64px}
.brand{font:700 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.25em;color:var(--accent)}
h1{font-size:30px;margin:8px 0 4px}h2{font-size:17px;margin:0 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}h3{margin:0 0 6px;font-size:15px}h4{margin:0 0 4px;font-size:13px;color:var(--muted)}
.meta,.muted{color:var(--muted)}.meta{font-size:13px}
.verdict{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:14px;font-size:14px}
.rating{font-weight:800;font-size:18px;padding:4px 14px;border-radius:999px}
.verdict.bull .rating{background:var(--bullbg);color:var(--bull)}.verdict.bear .rating{background:var(--bearbg);color:var(--bear)}.verdict.hold .rating{background:var(--holdbg);color:var(--hold)}
.lead{font-size:17px;margin:22px 0}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:16px 0}
.chart{width:100%;height:auto;margin:10px 0}.price{fill:none;stroke:var(--fg);stroke-width:1.6}
.band.bull{fill:var(--bull);opacity:.10}.band.bear{fill:var(--bear);opacity:.10}.band.hold{fill:var(--hold);opacity:.08}
.ref{stroke-dasharray:4 4;stroke-width:1}.ref.bear{stroke:var(--bear)}.ref.base{stroke:var(--accent)}.ref.bull{stroke:var(--bull)}
.lbl,.axis{font:11px ui-monospace,Menlo,monospace;fill:var(--muted)}
.vbar{position:relative;height:56px;margin:8px 0 18px;border-bottom:2px solid var(--line)}
.vbar .range{position:absolute;bottom:-2px;height:6px;background:linear-gradient(90deg,var(--bear),var(--accent),var(--bull));border-radius:3px}
.mk{position:absolute;bottom:0;transform:translateX(-50%);font-size:11px;text-align:center;color:var(--muted)}.mk span{display:block;padding-bottom:10px}.mk b{display:block;color:var(--fg);font-size:13px}
.mk.px b{color:var(--accent)}.mk.px::after{content:"";position:absolute;left:50%;bottom:-6px;width:2px;height:16px;background:var(--accent)}
.sides{display:grid;grid-template-columns:1fr 1fr;gap:14px}.side{border-left:3px solid var(--line);padding-left:12px}.side.bull{border-color:var(--bull)}.side.bear{border-color:var(--bear)}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:1px 8px;border-radius:999px}.pill.bull{background:var(--bullbg);color:var(--bull)}.pill.bear{background:var(--bearbg);color:var(--bear)}.pill.hold{background:var(--holdbg);color:var(--hold)}
table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}
.src td{font-size:12px}code,.cite{font:12px ui-monospace,Menlo,monospace;color:var(--muted)}a{color:var(--accent)}
details{border-top:1px solid var(--line);padding:8px 0}summary{cursor:pointer;font-weight:600}
ul{padding-left:20px;margin:6px 0}footer{margin-top:28px;font-size:12px;color:var(--muted)}
@media (max-width:640px){.sides,.grid3{grid-template-columns:1fr}h1{font-size:24px}}
</style></head><body><main>${body}</main></body></html>
`;
}
