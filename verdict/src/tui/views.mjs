// Screens as arrays of styled lines. The full-screen app scrolls them inside a pane; the
// stream mode prints them. Every function takes the content width.

import { readFileSync } from "node:fs";
import { deskTitle, t } from "../engine/i18n.mjs";
import { DESKS } from "../engine/prompts.mjs";
import { reportPath } from "../engine/pipeline.mjs";
import { upside } from "../render/markdown.mjs";
import { parseRange } from "../render/html.mjs";
import { zoneFor } from "../engine/watch.mjs";
import { pad, renderMarkdown, truncate, width, wrapText } from "../render/terminal.mjs";
import { chip, paint, ratingTone, SPIN, stanceTone, tone } from "./theme.mjs";
import { strings } from "./strings.mjs";

const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const signed = (x, digits = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x > 0 ? "+" : ""}${x.toFixed(digits)}%`);
const colored = (x, s) => (x === null || x === undefined ? tone.dim(s) : x >= 0 ? tone.bull(s) : tone.bear(s));
const big = (x) => (x === null || x === undefined ? "n/a" : Math.abs(x) >= 1e12 ? `${(x / 1e12).toFixed(2)}T` : Math.abs(x) >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : Math.abs(x) >= 1e6 ? `${(x / 1e6).toFixed(0)}M` : String(x));

export function heading(text) {
  return paint(` ${text} `, { fg: "accent", bold: true });
}

function para(text, w, indent = 0, style = (s) => s) {
  return wrapText(String(text || ""), Math.max(10, w - indent)).map((l) => `${" ".repeat(indent)}${style(l)}`);
}

// ---------------------------------------------------------------- wordmark

const MARK = [
  ["█ █", "█▀▀", "█▀█", "█▀▄", "█", "█▀▀", "▀█▀"],
  ["▀▄▀", "██▄", "█▀▄", "█▄▀", "█", "█▄▄", " █ "],
];

export function wordmark() {
  const shades = ["accent", "accent", "hold", "hold", "accentDim", "accentDim", "accentDim"];
  return MARK.map((row) => row.map((g, i) => paint(g, { fg: shades[i], bold: true })).join(" "));
}

export function welcomeLines(w, { language, recent = [], track = null }) {
  const S = strings(language);
  const out = ["", ...wordmark().map((l) => `  ${l}`), `  ${tone.dim(S.tagline)}`, "", `  ${heading(S.quick)}`];
  for (const tip of S.tips) out.push(`   ${tone.accent("›")} ${tone.text(tip)}`);
  if (recent.length) {
    out.push("", `  ${heading(S.recent)}`);
    for (const r of recent.slice(0, 6)) out.push(`   ${pad(tone.strong(r.symbol), 10)} ${pad(r.rating ? paint(r.rating, ratingTone(r.rating)) : tone.dim(r.state), 12)} ${tone.dim(`${r.created_at.slice(0, 10)} · ${truncate(r.name || "", Math.max(8, w - 40))}`)}`);
  }
  if (track?.count) out.push("", `  ${heading(S.track)}`, `   ${S.hitRate} ${tone.strong(`${track.hit_rate}%`)} ${tone.dim(`(${track.count})`)}${track.avg_return_bullish === null ? "" : `  ·  Buy/OW ${S.since} ${colored(track.avg_return_bullish, signed(track.avg_return_bullish))}`}`);
  return out;
}

// ---------------------------------------------------------------- snapshot

export function sparkline(series, w) {
  const vals = (series || []).map((p) => p[1]);
  if (vals.length < 3 || w < 5) return "";
  const step = Math.max(1, Math.ceil(vals.length / w));
  const pts = [];
  for (let i = 0; i < vals.length; i += step) pts.push(vals[i]);
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const bars = "▁▂▃▄▅▆▇█";
  const line = pts.map((v) => bars[Math.round(((v - lo) / (hi - lo || 1)) * 7)]).join("");
  return paint(line, pts.at(-1) >= pts[0] ? "bull" : "bear");
}

export function snapshotLines(s, w, language) {
  const S = strings(language);
  if (!s) return [];
  const i = s.instrument || {};
  const q = s.quote;
  const out = [`${tone.strong(s.symbol)} ${tone.text(truncate(i.name || "", 40))} ${tone.dim([i.exchange, i.type !== "unknown" ? i.type : null].filter(Boolean).join(" · "))}`];
  if (q) out.push(`${paint(`${q.price} ${q.currency}`, { fg: "ink", bold: true })} ${colored(q.change_pct, signed(q.change_pct, 2))}  ${tone.dim(`52w ${q.low_52w}–${q.high_52w}`)}  ${sparkline(s.series, Math.min(40, w - 45))}`);
  const tech = s.technicals;
  const r = s.fundamentals?.ratios || {};
  const bits = [];
  if (tech) bits.push(`12m ${colored(tech.return_12m_pct, signed(tech.return_12m_pct))}`, `RSI ${tech.rsi14}`, `vs 200d ${signed(tech.pct_vs_sma200)}`);
  if (r.pe_ttm) bits.push(`P/E ${r.pe_ttm}`);
  if (r.fcf_yield_pct !== undefined && r.fcf_yield_pct !== null) bits.push(`FCF ${r.fcf_yield_pct}%`);
  if (r.market_cap) bits.push(`cap ${big(r.market_cap)}`);
  if (bits.length) out.push(bits.join(tone.faint("  ·  ")));
  if (s.lenses?.length) out.push(s.lenses.map((l) => `${tone.dim(l.id.split("_")[0])}${paint(l.stance === "supportive" ? "+" : l.stance === "opposed" ? "−" : l.stance === "neutral" ? "~" : "∅", stanceTone(l.stance))}`).join(" "));
  for (const n of (s.news || []).slice(0, 3)) out.push(`${tone.faint(n.date.slice(5))} ${tone.text(truncate(n.title, w - 7))}`);
  if (s.gaps?.length) out.push(tone.hold(truncate(`⚠ ${s.gaps.join(" · ")}`, w)));
  return out;
}

// ---------------------------------------------------------------- live

export function taskList(mode, language) {
  const S = strings(language);
  const desks = mode === "fast" ? ["all"] : ["business", "street", "news", "risk"];
  return [
    { group: S.desks, items: desks.map((id) => ({ id, label: deskTitle(id, language, DESKS) })) },
    ...(mode === "fast" ? [] : [{ group: S.debate, items: [{ id: "bull", label: S.bull }, { id: "bear", label: S.bear }] }]),
    { group: S.decision, items: [{ id: "decision", label: S.pm }] },
  ];
}

export function liveLines(job, w, { tick = 0 } = {}) {
  const S = strings(job.language);
  const out = [];
  if (job.snapshot) out.push(heading(S.snapshot), ...snapshotLines(job.snapshot, w, job.language).map((l) => ` ${l}`), "");
  else out.push(`${tone.accent(SPIN[tick % SPIN.length])} ${tone.dim("…")}`, "");
  for (const g of taskList(job.mode, job.language)) {
    out.push(heading(g.group));
    g.items.forEach((it, idx) => {
      const tk = job.tasks[it.id] || { status: "waiting" };
      const last = idx === g.items.length - 1;
      const icon = tk.status === "done" ? tone.bull("●") : tk.status === "failed" ? tone.bear("✕") : tk.status === "running" ? tone.accent(SPIN[tick % SPIN.length]) : tone.faint("○");
      const time = tk.startedAt ? mmss((tk.endedAt || Date.now()) - tk.startedAt) : "";
      let tail = "";
      if (tk.status === "running") tail = tone.dim(tk.activity || S.thinking);
      else if (tk.status === "done") tail = tk.note ? paint(tk.note, stanceTone(tk.note) === "dim" ? ratingTone(tk.note) : stanceTone(tk.note)) : "";
      else if (tk.status === "failed") tail = tone.bear(tk.error || "");
      else tail = tone.faint(S.waiting);
      out.push(` ${tone.faint(last ? "└" : "├")} ${icon} ${pad(tone.text(truncate(it.label, 20)), 20)} ${tone.dim(pad(time, 5))} ${truncate(tail, Math.max(10, w - 34))}`);
    });
  }
  if (job.draft) {
    out.push("", heading(S.draft));
    if (job.draftRating) out.push(` ${chip(job.draftRating)}`);
    out.push(...para(job.draft, w - 2, 1, tone.ink));
  }
  const secs = mmss((job.endedAt || Date.now()) - job.startedAt);
  out.push("", tone.faint(`⏱ ${secs}${job.cost ? ` · $${job.cost.toFixed(2)}` : ""}${job.error ? ` · ${job.error}` : ""}`));
  return out;
}

// ---------------------------------------------------------------- verdict card

export function valueBar(d, price, w) {
  const v = d.valuation;
  const vals = [v.bear, v.base, v.bull, price].filter((x) => Number.isFinite(x));
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = Math.max(20, w - 4);
  const at = (x) => Math.round(((x - lo) / (hi - lo || 1)) * (span - 1));
  const cells = new Array(span).fill(null).map(() => ({ ch: "─", st: "faint" }));
  const [b0, b1, b2] = [at(v.bear), at(v.base), at(v.bull)];
  for (let i = b0; i <= b2; i += 1) cells[i] = { ch: "━", st: i < b1 ? "bear" : i === b1 ? "accent" : "bull" };
  cells[b0] = { ch: "◆", st: "bear" };
  cells[b1] = { ch: "◆", st: "accent" };
  cells[b2] = { ch: "◆", st: "bull" };
  const bar = cells.map((c) => paint(c.ch, c.st)).join("");
  const labels = new Array(span).fill(" ");
  const put = (pos, text) => {
    const start = Math.max(0, Math.min(span - text.length, pos - Math.floor(text.length / 2)));
    for (let i = 0; i < text.length; i += 1) labels[start + i] = text[i];
  };
  put(b0, String(v.bear));
  put(b1, String(v.base));
  put(b2, String(v.bull));
  const lines = [`  ${tone.dim(labels.join(""))}`, `  ${bar}`];
  if (Number.isFinite(price)) {
    const p = at(price);
    lines.push(`  ${" ".repeat(Math.max(0, Math.min(span - 1, p)))}${tone.accent("▲")}`, `  ${" ".repeat(Math.max(0, Math.min(span - 12, p - 3)))}${tone.accent(`${price}`)}`);
  }
  return lines;
}

export function verdictLines(run, w) {
  const S = strings(run.language);
  const L = t(run.language);
  const d = run.decision;
  const q = run.snapshot?.quote;
  const out = [];
  const head = `${tone.strong(run.symbol)} ${tone.text(truncate(run.name || "", 36))}`;
  if (!d) {
    out.push(head, "", `${chip(run.state)} ${tone.dim(run.reason || "")}`);
    return out;
  }
  const up = upside(run);
  out.push(`${head}`, "", ` ${chip(d.rating)}  ${tone.dim(`${S.confidence}`)} ${tone.strong(L.levels[d.confidence] || d.confidence)}${up === null ? "" : `   ${tone.dim(L.basev)} ${colored(up, signed(up, 0))}`}${q ? `   ${tone.dim(`${q.price} ${q.currency}`)}` : ""}`);
  out.push("", ...para(d.conclusion, w - 2, 1, tone.ink));
  out.push("", heading(`${S.value} · ${d.valuation.currency}`), ...valueBar(d, q?.price, Math.min(w, 90)), ...para(d.valuation.method, w - 2, 1, tone.dim));
  const zone = zoneFor(d.price_levels, q?.price);
  out.push("", heading(S.levels));
  const actW = Math.min(18, Math.max(8, ...d.price_levels.map((l) => width(String(l.action)))));
  const rangeW = Math.min(16, Math.max(8, ...d.price_levels.map((l) => width(String(l.range)))));
  for (const l of d.price_levels) {
    const act = String(l.action);
    const st = /avoid|trim|sell|回避|减|卖/.test(act) ? "bear" : /add|buy|加|买/.test(act) ? "bull" : "hold";
    const here = zone === l ? tone.accent(`  ◀ ${S.youAreHere}`) : "";
    out.push(` ${paint("▌", st)} ${pad(tone.strong(truncate(l.range, rangeW)), rangeW)}  ${pad(paint(truncate(act, actW), st), actW)}  ${tone.dim(truncate(l.why, Math.max(10, w - rangeW - actW - 10)))}${here}`);
  }
  const bull = run.cases?.bull?.thesis || d.bull_case;
  const bear = run.cases?.bear?.thesis || d.bear_case;
  if (w >= 90) {
    const col = Math.floor((w - 4) / 2);
    const a = para(bull, col - 2);
    const b = para(bear, col - 2);
    out.push("", `${pad(heading(S.bullCase), col + 2)}${heading(S.bearCase)}`);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) out.push(` ${tone.bull("┃")} ${pad(tone.text(a[i] || ""), col - 2)} ${tone.bear("┃")} ${tone.text(b[i] || "")}`);
  } else {
    out.push("", heading(S.bullCase), ...para(bull, w - 3, 1, tone.text).map((l) => `${tone.bull("┃")}${l}`), "", heading(S.bearCase), ...para(bear, w - 3, 1, tone.text).map((l) => `${tone.bear("┃")}${l}`));
  }
  if (d.debate_winner !== "none") out.push("", ` ${tone.dim(S.verdictLine)} ${tone.strong(L.winner[d.debate_winner] || d.debate_winner)} ${tone.dim("—")} ${tone.text(d.debate_reason)}`.slice(0, 4000));
  if (d.catalysts.length) out.push("", heading(S.catalysts), ...d.catalysts.map((c) => ` ${tone.accent("◷")} ${pad(tone.strong(truncate(c.timing, 18)), 18)} ${tone.text(truncate(c.event, w - 26))} ${paint(c.direction === "positive" ? "↑" : c.direction === "negative" ? "↓" : "↕", c.direction === "positive" ? "bull" : c.direction === "negative" ? "bear" : "hold")}`));
  if (d.risks.length) out.push("", heading(S.risks), ...d.risks.flatMap((r) => para(r.risk, w - 10, 0).map((l, i) => ` ${i ? "      " : paint(pad(L.levels[r.severity] || r.severity, 6), r.severity === "high" ? "bear" : r.severity === "medium" ? "hold" : "dim")} ${tone.text(l)}`)));
  out.push("", heading(S.position), ` ${tone.strong(d.position.action)} ${tone.dim("·")} ${tone.text(d.position.sizing)}`, ...para(`${L.entry}: ${d.position.entry}`, w - 2, 1, tone.dim), ...para(`${L.exit}: ${d.position.exit}`, w - 2, 1, tone.dim));
  out.push("", heading(S.horizons));
  for (const [k, label] of [["short_term", S.h1], ["medium_term", S.h2], ["long_term", S.h3]]) out.push(...para(d.horizons[k], w - 14, 0).map((l, i) => ` ${i ? " ".repeat(11) : tone.accent(pad(label, 11))} ${tone.text(l)}`));
  out.push("", heading(S.wrong), ...d.invalidation.flatMap((x) => para(x, w - 4, 0).map((l, i) => ` ${i ? " " : tone.bear("✕")} ${tone.text(l)}`)));
  const secs = mmss(run.elapsed_ms || 0);
  out.push("", tone.faint(`${run.as_of} · ${run.mode} · ${S.elapsed} ${secs}${run.cost_usd ? ` · ${S.cost} $${run.cost_usd.toFixed(2)}` : ""} · ${S.status} ${run.state}`));
  return out;
}

export function reportLines(run, w) {
  try {
    return renderMarkdown(readFileSync(reportPath(run.run_id), "utf8"), w).split("\n");
  } catch {
    return [tone.dim("no report yet")];
  }
}

// ---------------------------------------------------------------- evidence

/** Findings with their resolved sources; returns { lines, anchors } for selection. */
export function evidenceLines(run, w, { selected = 0, open = -1 } = {}) {
  const S = strings(run.language);
  const lines = [];
  const anchors = [];
  const srcIndex = { ...(run.snapshot?.sources || {}) };
  for (const [desk, p] of Object.entries(run.desks || {})) for (const s of p?.sources || []) srcIndex[`${desk}:${s.id}`] = s;
  let n = 0;
  for (const [desk, p] of Object.entries(run.desks || {})) {
    lines.push(heading(`${deskTitle(desk, run.language, DESKS)}${p ? ` · ${p.findings.length} ${S.findings}` : ""}`));
    if (!p) {
      lines.push(tone.bear(" ✕ failed"));
      continue;
    }
    for (const f of p.findings) {
      const idx = n++;
      anchors.push(lines.length);
      const sel = idx === selected;
      const mark = paint(f.impact === "bullish" ? "▲" : f.impact === "bearish" ? "▼" : "◆", stanceTone(f.impact));
      para(f.claim, w - 6, 0).forEach((l, i) => lines.push(`${sel ? tone.accent("▌") : " "} ${i ? " " : mark} ${sel ? tone.ink(l) : tone.text(l)}`));
      if (idx === open) {
        for (const id of f.sources) {
          const full = /^S\d+$/.test(id) ? `${desk}:${id}` : id;
          const s = srcIndex[full];
          lines.push(`     ${tone.accent("↳")} ${tone.faint(full)} ${tone.text(truncate(s?.title || "", w - 30))}`);
          if (s?.url) lines.push(`       ${paint(truncate(s.url, w - 8), { fg: "info", underline: true })}`);
        }
      }
    }
    if (p.key_numbers?.length) {
      lines.push(` ${tone.dim(S.keyNumbers)}`);
      for (const k of p.key_numbers) lines.push(`   ${pad(tone.text(truncate(k.label, 28)), 28)} ${tone.strong(k.value)} ${tone.faint(k.source || "")}`);
    }
    lines.push("");
  }
  return { lines, anchors, count: n };
}

// ---------------------------------------------------------------- ask

export function askLines(language, transcript, w, { pending = null } = {}) {
  const S = strings(language);
  const out = [...para(S.askIntro, w, 0, tone.dim), ""];
  for (const turn of transcript) {
    out.push(`${tone.accent("›")} ${tone.strong(turn.question)}`, ...para(turn.answer, w - 2, 2, tone.text), "");
  }
  if (pending) out.push(`${tone.accent("›")} ${tone.strong(pending.question)}`, ...para(pending.answer || S.thinking, w - 2, 2, pending.answer ? tone.text : tone.dim));
  return out;
}

// ---------------------------------------------------------------- compare / track

export function compareLines(cmp, w, { tick = 0 } = {}) {
  const S = strings(cmp.language);
  const out = [heading(`${S.compareTitle} · ${cmp.symbols.join(" · ")}`), ""];
  const rank = new Map((cmp.ranking?.ranking || []).map((x) => [String(x.symbol).toUpperCase(), x]));
  const rows = [...cmp.symbols].sort((a, b) => (rank.get(a)?.rank ?? 99) - (rank.get(b)?.rank ?? 99));
  for (const sym of rows) {
    const job = cmp.jobs[sym];
    const run = job?.run;
    const k = rank.get(sym);
    const status = run ? chip(run.decision?.rating || run.state) : `${tone.accent(SPIN[tick % SPIN.length])} ${tone.dim(job?.stage || "…")}`;
    const up = run ? upside(run) : null;
    out.push(` ${tone.accent(pad(k ? `#${k.rank}` : "", 4))}${pad(tone.strong(sym), 10)} ${pad(status, 16)} ${pad(run?.snapshot?.quote ? tone.text(String(run.snapshot.quote.price)) : "", 10)} ${run ? colored(up, signed(up, 0)) : ""}`);
    if (k?.why) out.push(...para(k.why, w - 16, 15, tone.dim));
  }
  if (cmp.ranking?.summary) out.push("", ...para(cmp.ranking.summary, w - 2, 1, tone.ink));
  return out;
}

export function trackLines(track, w, language) {
  const S = strings(language);
  if (!track) return [tone.dim("…")];
  const out = [heading(S.track), ""];
  if (!track.count) return [...out, tone.dim(" —")];
  out.push(` ${S.hitRate} ${tone.strong(`${track.hit_rate}%`)} ${tone.dim(`· ${track.count}`)}${track.avg_return_bullish === null ? "" : `   Buy/OW ${colored(track.avg_return_bullish, signed(track.avg_return_bullish))}`}`, "");
  for (const r of track.rows.slice(0, Math.max(5, 200))) out.push(` ${tone.dim(r.date)}  ${pad(tone.strong(r.symbol), 9)} ${pad(paint(r.rating, ratingTone(r.rating)), 12)} ${pad(tone.text(`${r.then} → ${r.now}`), 22)} ${colored(r.return_pct, signed(r.return_pct))} ${r.hit ? tone.bull("✓") : tone.bear("✕")}`);
  return out;
}

export { width };
