// Assemble the saved report from recorded packets. The PM decides; code writes the document,
// so no section, seat, citation or gap can be dropped by a model summarizing its own work.

import { join } from "node:path";
import { lensName, LENSES } from "./lenses.mjs";
import { labels, roleTitle } from "./spec.mjs";
import { packetPath, readJson, runDir, writeJson, writeText } from "./store.mjs";

const BULL = "bull_researcher";
const BEAR = "bear_researcher";

const cite = (ids) => (ids?.length ? ` [${ids.join(", ")}]` : "");
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function load(runId) {
  const dir = runDir(runId);
  const run = readJson(join(dir, "run.json"));
  const g = readJson(join(dir, "grounding.json"), {});
  const lenses = readJson(join(dir, "lenses.json"), []);
  const ev = {};
  for (const role of run.evidence_roles) ev[role] = readJson(packetPath(runId, `evidence/${role}`))?.packet || null;
  const debate = {};
  for (let r = 1; r <= run.rounds; r += 1) {
    debate[r] = {
      [BULL]: readJson(packetPath(runId, `debate/r${r}/${BULL}`))?.packet || null,
      [BEAR]: readJson(packetPath(runId, `debate/r${r}/${BEAR}`))?.packet || null,
    };
  }
  const pm = readJson(packetPath(runId, "pm/portfolio_manager"))?.packet || null;
  return { run, g, lenses, ev, debate, pm };
}

function roleFindings(ctx, role, L) {
  const p = ctx.ev[role];
  if (!ctx.run.evidence_roles.includes(role)) return null;
  if (!p) return `_${roleTitle(role, ctx.run.language)}: ${L.failed} — ${L.missing}._`;
  const lines = [`**${roleTitle(role, ctx.run.language)}** (${p.signal}, ${p.confidence}): ${p.summary}`, ""];
  for (const f of p.findings) lines.push(`- ${f.claim}${cite(f.sources.map((s) => `${role}:${s}`))}`);
  return lines.join("\n");
}

function snapshot(ctx, L) {
  const q = ctx.g.quote;
  if (!q) return `- ${L.missing}: price snapshot (${(ctx.g.gaps || []).filter((x) => x.startsWith("quote")).join("; ") || "quote unavailable"})`;
  return `- ${q.symbol}: **${q.price} ${q.currency}** · ${q.market_time || "time n/a"} · delayed · ${q.exchange || ""} · [grounding:quote](${q.source?.url || ""})`;
}

function worklog(ctx, L) {
  const rows = ["| Seat | Status | Signal | Confidence | Summary |", "|---|---|---|---|---|"];
  for (const role of ctx.run.evidence_roles) {
    const p = ctx.ev[role];
    rows.push(p
      ? `| ${roleTitle(role, ctx.run.language)} | ✓ | ${p.signal} | ${p.confidence} | ${esc(p.summary)} |`
      : `| ${roleTitle(role, ctx.run.language)} | ✗ ${L.failed} | – | – | ${L.missing} |`);
  }
  return rows.join("\n");
}

function lensTable(ctx) {
  if (!ctx.lenses.length) return "_No method lenses selected._";
  const rows = ["| Lens | Stance | Score | Checks |", "|---|---|---|---|"];
  for (const l of ctx.lenses) {
    const def = LENSES.find((x) => x.id === l.id);
    const checks = l.checks.map((c) => `${c.label} ${c.display} ${c.pass === null ? "–" : c.pass ? "✓" : "✗"}`).join("; ");
    rows.push(`| ${esc(def ? lensName(def, ctx.run.language) : l.id)} (\`lens:${l.id}\`) | **${l.stance}** | ${l.score ?? "–"} | ${esc(checks || l.rationale)} |`);
  }
  rows.push("", "_Stances are computed from the frozen facts before any model writes. `out_of_scope` means too little data or the wrong instrument type — a gap, not a vote._");
  return rows.join("\n");
}

function debateSection(ctx, L) {
  const out = [];
  for (let r = 1; r <= ctx.run.rounds; r += 1) {
    const title = { 1: L.opening, 2: L.rebuttal, 3: L.answers }[r];
    out.push(`### ${L.round.replace("{n}", r)}: ${title}`);
    for (const role of [BULL, BEAR]) {
      const p = ctx.debate[r][role];
      const who = roleTitle(role, ctx.run.language);
      if (!p) {
        out.push(`**${who}:** _${L.missing}_`);
        continue;
      }
      if (r === 1) {
        out.push(`**${who}:** ${p.thesis}`);
        for (const a of p.arguments) out.push(`- ${a.point}${cite(a.evidence)}`);
        if (p.concessions?.length) {
          out.push("- _Concedes:_");
          for (const x of p.concessions) out.push(`  - ${x}`);
        }
      } else if (r === 2) {
        out.push(`**${who}:**`);
        for (const x of p.rebuttals) out.push(`- ↳ _${x.target}_ — ${x.response}${cite(x.evidence)}`);
        for (const q of p.questions) out.push(`- **${q.id}:** ${q.question}`);
      } else {
        out.push(`**${who}:**`);
        for (const a of p.answers) out.push(`- **${a.question_id}:** ${a.answer}${cite(a.evidence)}`);
        out.push(`- _Closing:_ ${p.closing}`);
      }
      out.push("");
    }
  }
  if (ctx.pm) out.push(`**${L.winner}: ${ctx.pm.debate_winner}.** ${ctx.pm.debate_assessment}`);
  return out.join("\n");
}

function quantExtras(ctx) {
  const t = ctx.g.technicals;
  const lines = [];
  if (t?.available) lines.push(`- Technicals (grounding:technicals): 12m ${t.return_12m_pct}%, 3m ${t.return_3m_pct}%, vs SMA200 ${t.pct_vs_sma200}%, RSI14 ${t.rsi14}, 30d realized vol ${t.realized_vol_30d_pct}%, 1y max drawdown ${t.max_drawdown_1y_pct}%.`);
  return lines.join("\n");
}

function optionsExtras(ctx) {
  const o = ctx.g.options;
  if (!o?.available) return "";
  return `- Options (grounding:options): put/call OI ${o.put_call_oi_ratio}, put/call volume ${o.put_call_volume_ratio}; ATM IV ${o.term_structure.slice(0, 4).map((x) => `${x.days}d ${x.atm_iv_pct}%`).join(", ")}.`;
}

function sourceTable(ctx) {
  const rows = ["| ID | Title | Date | Link |", "|---|---|---|---|"];
  for (const [id, s] of Object.entries(ctx.g.sources || {})) rows.push(`| \`${id}\` | ${esc(s.title)} | ${s.retrieved || ""} | ${s.url || ""} |`);
  for (const role of ctx.run.evidence_roles) {
    for (const s of ctx.ev[role]?.sources || []) rows.push(`| \`${role}:${s.id}\` | ${esc(s.title)}${s.publisher ? ` — ${esc(s.publisher)}` : ""} | ${s.date || ""} | ${s.url} |`);
  }
  return rows.join("\n");
}

function allGaps(ctx, status) {
  const gaps = [];
  for (const g of ctx.g.gaps || []) gaps.push(`grounding — ${g}`);
  for (const role of ctx.run.evidence_roles) {
    if (!ctx.ev[role]) gaps.push(`${role} — seat failed; its coverage is missing`);
    for (const g of ctx.ev[role]?.data_gaps || []) gaps.push(`${role} — ${g}`);
  }
  for (const l of ctx.lenses) if (l.stance === "out_of_scope") gaps.push(`lens:${l.id} — ${l.rationale}`);
  for (const g of ctx.pm?.data_gaps || []) gaps.push(`portfolio_manager — ${g}`);
  for (const s of status.skipped || []) gaps.push(`${s} — not run`);
  return [...new Set(gaps)];
}

/** Every material ID cited anywhere must resolve to the source table. */
function unresolvedCitations(ctx) {
  const known = new Set(Object.keys(ctx.g.sources || {}));
  for (const l of ctx.lenses) known.add(`lens:${l.id}`);
  for (const role of ctx.run.evidence_roles) for (const s of ctx.ev[role]?.sources || []) known.add(`${role}:${s.id}`);
  const cited = [];
  for (const r of Object.values(ctx.debate)) {
    for (const p of Object.values(r)) {
      if (!p) continue;
      for (const a of p.arguments || []) cited.push(...a.evidence);
      for (const a of p.rebuttals || []) cited.push(...a.evidence);
      for (const a of p.answers || []) cited.push(...a.evidence);
    }
  }
  cited.push(...(ctx.pm?.key_sources || []));
  return [...new Set(cited.filter((id) => !known.has(id)))];
}

export function renderReport(runId, status) {
  const ctx = load(runId);
  const { run, pm } = ctx;
  const L = labels(run.language);
  const full = run.mode === "full";
  const sections = [];
  const add = (key, body) => sections.push({ key, title: L[key], body: body || `_${L.missing}_` });

  const head = [
    `# ${L.title}: ${run.symbol}${run.instrument?.name ? ` — ${run.instrument.name}` : ""}`,
    "",
    `> ${run.mode === "quick" ? "quick" : `full · ${run.pace}`} · ${run.as_of} · run \`${run.run_id}\` · ${L.status}: **${status.state}**${status.state !== "complete" ? ` — ${status.reason}` : ""}`,
  ].join("\n");

  add("conclusion", pm ? `**${pm.rating}** · ${L.confidence}: ${pm.confidence}\n\n${pm.conclusion}\n\n${snapshot(ctx, L)}` : `**${status.state}** — ${status.reason}\n\n${snapshot(ctx, L)}`);
  add("worklog", worklog(ctx, L));
  add("lenses", lensTable(ctx));
  add("debate", debateSection(ctx, L));
  if (pm) {
    add("long", pm.long_thesis);
    add("short", pm.short_thesis);
  }
  if (full) {
    add("expectations", pm?.market_expectations);
    add("revisions", roleFindings(ctx, "forward_expectations", L));
  }
  add("earnings", roleFindings(ctx, "earnings_deep_dive", L));
  if (full) add("quant", [roleFindings(ctx, "quant_factor", L), quantExtras(ctx)].filter(Boolean).join("\n\n"));
  add("news", roleFindings(ctx, "news_industry_management", L));
  if (full) {
    add("positioning", [optionsExtras(ctx), ctx.ev.quant_factor ? "_See the quant factor seat above for short interest and borrow._" : ""].filter(Boolean).join("\n\n"));
    add("banking", roleFindings(ctx, "ib_event_analysis", L));
    add("insider", roleFindings(ctx, "insider_sec", L));
  }
  add("valuation", [
    pm ? `| Bear | Base | Bull |\n|---|---|---|\n| ${pm.valuation.bear} ${pm.valuation.currency} | **${pm.valuation.base} ${pm.valuation.currency}** | ${pm.valuation.bull} ${pm.valuation.currency} |\n\n${pm.valuation.method}` : "",
    roleFindings(ctx, "valuation_long_short", L),
  ].filter(Boolean).join("\n\n"));
  if (pm) {
    add("price_levels", ["| Price | Meaning | Action |", "|---|---|---|", ...pm.price_levels.map((l) => `| ${esc(l.range)} | ${esc(l.meaning)} | ${esc(l.action)} |`)].join("\n"));
    if (full) add("catalysts", pm.catalysts.map((c) => `- **${c.timing}** — ${c.event} (${c.direction})`).join("\n"));
    add("risks", pm.risks.map((r) => `- **${r.severity}** — ${r.risk}${r.mitigant ? ` _Mitigant:_ ${r.mitigant}` : ""}`).join("\n"));
    add("position", `- **${pm.position.action}** · ${pm.position.sizing}\n- Entry: ${pm.position.entry}\n- Exit: ${pm.position.exit}`);
    if (pm.horizons) add("horizons", `- **${L.short_term}:** ${pm.horizons.short_term}\n- **${L.medium_term}:** ${pm.horizons.medium_term}\n- **${L.long_term}:** ${pm.horizons.long_term}`);
  }
  const gaps = allGaps(ctx, status);
  add("gaps", gaps.length ? gaps.map((g) => `- ${g}`).join("\n") : L.no_gaps);
  if (pm) {
    add("invalidation", pm.invalidation.map((x) => `- ${x}`).join("\n"));
    add("confidence", `**${pm.confidence}** — ${pm.confidence_rationale}`);
  }
  add("sources", sourceTable(ctx));

  const unresolved = unresolvedCitations(ctx);
  const markdown = [head, ...sections.map((s) => `## ${s.title}\n\n${s.body}`), `---\n_${L.disclaimer}_`].join("\n\n") + "\n";

  const dir = runDir(runId);
  const files = {
    report: join(dir, "final_report.md"),
    transcript: join(dir, "transcript.md"),
    quality: join(dir, "report_quality.json"),
    handoff: join(dir, "user_response.md"),
  };
  writeText(files.report, markdown);
  writeText(files.transcript, transcript(ctx));
  const quality = {
    contract: run.mode === "full" ? "full" : "quick",
    state: status.state,
    sections: sections.map((s) => s.key),
    empty_sections: sections.filter((s) => s.body.startsWith("_") && s.body.includes(L.missing)).map((s) => s.key),
    unresolved_citations: unresolved,
    passed: status.state !== "incomplete" && unresolved.length === 0,
  };
  writeJson(files.quality, quality);

  const handoff = [
    `**${run.symbol} — ${pm ? pm.rating : status.state.toUpperCase()}** (${run.mode}${run.pace ? ` · ${run.pace}` : ""}, ${status.state})`,
    pm ? pm.conclusion : status.reason,
    "",
    snapshot(ctx, L),
    ...(pm ? [`- Value range: ${pm.valuation.bear} / **${pm.valuation.base}** / ${pm.valuation.bull} ${pm.valuation.currency} · debate: ${pm.debate_winner} · confidence: ${pm.confidence}`] : []),
    `- Seats: ${run.evidence_roles.map((r) => `${r} ${ctx.ev[r] ? "✓" : "✗"}`).join(", ")}`,
    `- Lenses: ${ctx.lenses.map((l) => `${l.id}=${l.stance}`).join(", ") || "none"}`,
    `- Elapsed ${Math.round(status.elapsed_ms / 1000)}s${status.past_deadline ? " (past the pace ceiling)" : ""}`,
    `- Report: ${files.report}`,
  ].join("\n");
  writeText(files.handoff, `${handoff}\n`);
  return { files, handoff, quality };
}

function transcript(ctx) {
  const out = [`# Transcript — ${ctx.run.symbol} (${ctx.run.run_id})`, ""];
  for (const role of ctx.run.evidence_roles) out.push(`## evidence / ${role}`, "```json", JSON.stringify(ctx.ev[role], null, 2), "```", "");
  for (const [r, sides] of Object.entries(ctx.debate)) {
    for (const [role, p] of Object.entries(sides)) out.push(`## debate r${r} / ${role}`, "```json", JSON.stringify(p, null, 2), "```", "");
  }
  out.push("## portfolio_manager", "```json", JSON.stringify(ctx.pm, null, 2), "```");
  return `${out.join("\n")}\n`;
}

