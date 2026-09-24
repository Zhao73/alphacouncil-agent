// The saved report, assembled by code from the recorded packets: nothing a model summarised
// away can go missing, and every citation is checked against the source table.

import { deskTitle, t } from "./i18n.mjs";
import { DESKS } from "./prompts.mjs";

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const cite = (ids) => (ids?.length ? ` [${ids.join(", ")}]` : "");
const pct = (a, b) => (a && b ? `${a >= b ? "+" : ""}${(((a - b) / b) * 100).toFixed(0)}%` : "");

export function upside(run) {
  const price = run.snapshot?.quote?.price;
  const base = run.decision?.valuation?.base;
  return price && base ? ((base - price) / price) * 100 : null;
}

function priceLine(run, L) {
  const q = run.snapshot?.quote;
  if (!q) return `${L.price}: n/a`;
  return `${L.price} ${q.price} ${q.currency} (${L.delayed}, ${String(q.market_time || "").slice(0, 16).replace("T", " ")})`;
}

export function renderReport(run) {
  const L = t(run.language);
  const d = run.decision;
  const s = run.snapshot;
  const out = [];
  const title = `${run.symbol}${run.name ? ` — ${run.name}` : ""}`;
  out.push(`# ${title}: ${d ? d.rating : run.state}`);
  const meta = [run.as_of, run.mode, priceLine(run, L)];
  if (d) meta.push(`${d.valuation.bear} / ${d.valuation.base} / ${d.valuation.bull} ${d.valuation.currency}`, `${L.confidence} ${L.levels[d.confidence] || d.confidence}`);
  if (run.elapsed_ms) meta.push(`${L.elapsed} ${Math.round(run.elapsed_ms / 1000)}s`);
  if (run.state !== "complete") meta.push(`${L.status}: ${run.state}`);
  out.push(`> ${meta.join(" · ")}`);
  if (run.question) out.push(`> ${L.asking}: ${run.question}`);

  if (d) {
    out.push(`## ${L.conclusion}`, d.conclusion, `_${L.confidence}: ${L.levels[d.confidence] || d.confidence} — ${d.confidence_reason}_`);
  } else {
    out.push(`## ${L.conclusion}`, `**${run.state}** — ${run.reason || ""}`);
  }

  if (run.cases || d) {
    out.push(`## ${L.debate}`);
    for (const side of ["bull", "bear"]) {
      const c = run.cases?.[side];
      if (c) {
        out.push(`### ${L[side]}`, c.thesis, [...c.points.map((p) => `- ${p.point}${cite(p.evidence)}`), `- _${L.answer}:_ ${c.answer_to_other_side}`, `- _${L.mind}:_ ${c.would_change_my_mind}`].join("\n"));
      } else if (d) {
        out.push(`### ${L[side]}`, side === "bull" ? d.bull_case : d.bear_case);
      }
    }
    if (d && d.debate_winner !== "none") out.push(`**${L.verdict}: ${L.winner[d.debate_winner] || d.debate_winner}.** ${d.debate_reason}`);
  }

  if (d) {
    const price = s?.quote?.price;
    const v = d.valuation;
    out.push(`## ${L.valuation}`);
    out.push([`| ${L.bearv} | ${L.basev} | ${L.bullv} |`, "|---|---|---|", `| ${v.bear} ${v.currency} ${pct(v.bear, price)} | **${v.base} ${v.currency}** ${pct(v.base, price)} | ${v.bull} ${v.currency} ${pct(v.bull, price)} |`].join("\n"));
    out.push(v.method);
    out.push(["| | | |", "|---|---|---|", ...d.price_levels.map((l) => `| ${esc(l.range)} | **${esc(l.action)}** | ${esc(l.why)} |`)].join("\n"));
    if (d.catalysts.length) out.push(`## ${L.catalysts}`, d.catalysts.map((c) => `- **${c.timing}** · ${c.event} (${c.direction})`).join("\n"));
    if (d.risks.length) out.push(`## ${L.risks}`, d.risks.map((r) => `- **${L.levels[r.severity] || r.severity}** · ${r.risk}`).join("\n"));
    out.push(`## ${L.position}`, `**${d.position.action}** · ${d.position.sizing}`, [`- ${L.entry}: ${d.position.entry}`, `- ${L.exit}: ${d.position.exit}`].join("\n"));
    out.push(`## ${L.horizons}`, [`- **${L.short_term}:** ${d.horizons.short_term}`, `- **${L.medium_term}:** ${d.horizons.medium_term}`, `- **${L.long_term}:** ${d.horizons.long_term}`].join("\n"));
    out.push(`## ${L.invalidation}`, d.invalidation.map((x) => `- ${x}`).join("\n"));
  }

  out.push(`## ${L.desks}`);
  for (const [id, p] of Object.entries(run.desks || {})) {
    if (!p) {
      out.push(`### ${deskTitle(id, run.language, DESKS)} — ${L.failed}`);
      continue;
    }
    const scoped = (x) => (/^S\d+$/.test(x) ? `${id}:${x}` : x);
    out.push(`### ${deskTitle(id, run.language, DESKS)} (${p.stance})`, p.summary, p.findings.map((f) => `- ${f.claim}${cite(f.sources.map(scoped))}`).join("\n"));
    if (p.key_numbers?.length) out.push(["| | | |", "|---|---|---|", ...p.key_numbers.map((k) => `| ${esc(k.label)} | **${esc(k.value)}** | ${k.source ? `\`${scoped(k.source)}\`` : ""} |`)].join("\n"));
  }

  if (s?.lenses?.length) {
    out.push(`## ${L.lenses}`, ["| | | |", "|---|---|---|", ...s.lenses.map((l) => `| ${esc(l.name)} (\`lens:${l.id}\`) | **${l.stance}** | ${esc(l.checks.map((c) => `${c.label} ${c.display}${c.pass === null ? "" : c.pass ? " ✓" : " ✗"}`).join("; ") || l.rationale)} |`)].join("\n"), `_${L.lens_note}_`);
  }

  const gaps = allGaps(run);
  out.push(`## ${L.gaps}`, gaps.length ? gaps.map((g) => `- ${g}`).join("\n") : L.no_gaps);

  const rows = ["| ID | | |", "|---|---|---|"];
  for (const [id, src] of Object.entries(s?.sources || {})) rows.push(`| \`${id}\` | ${esc(src.title)}${src.date ? ` (${src.date})` : ""} | ${src.url || ""} |`);
  for (const [desk, p] of Object.entries(run.desks || {})) for (const x of p?.sources || []) rows.push(`| \`${desk}:${x.id}\` | ${esc(x.title)}${x.date ? ` (${x.date})` : ""} | ${x.url} |`);
  out.push(`## ${L.sources}`, rows.join("\n"));

  out.push("---", `_${L.disclaimer}_`);
  return `${out.filter((x) => x !== "" && x !== undefined).join("\n\n")}\n`;
}

export function allGaps(run) {
  const gaps = [];
  for (const g of run.snapshot?.gaps || []) gaps.push(g);
  for (const [desk, p] of Object.entries(run.desks || {})) {
    if (!p) gaps.push(`${desk}: desk failed — ${run.failures?.[desk] || "no result"}`);
    for (const g of p?.gaps || []) gaps.push(`${desk}: ${g}`);
  }
  for (const side of ["bull", "bear"]) if (run.cases && !run.cases[side]) gaps.push(`${side}: case failed — ${run.failures?.[side] || "no result"}`);
  for (const g of run.decision?.gaps || []) gaps.push(g);
  return [...new Set(gaps)];
}
