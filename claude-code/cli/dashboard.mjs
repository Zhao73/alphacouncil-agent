// Live run dashboard. Full-screen redraw on a TTY; append-only progress lines otherwise.

import { join } from "node:path";
import { readJson, runDir } from "../lib/store.mjs";
import { roleTitle } from "../lib/spec.mjs";
import { c, pad, truncate, width } from "./term.mjs";

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const mmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function icon(seat, tick) {
  switch (seat.status) {
    case "done": return c.green("✓");
    case "failed": return c.red("✗");
    case "retry": return c.yellow("↻");
    case "running": return c.cyan(SPIN[tick % SPIN.length]);
    default: return c.gray("·");
  }
}

const signalColor = (s) => (/bull|buy|overweight/i.test(s || "") ? c.green(s) : /bear|sell|underweight/i.test(s || "") ? c.red(s) : c.yellow(s || ""));

function seatLine(seat, lang, tick, cols) {
  const title = pad(truncate(roleTitle(seat.role, lang), 24), 24);
  const elapsed = seat.startedAt ? mmss((seat.endedAt || Date.now()) - seat.startedAt) : "     ";
  let tail = "";
  if (seat.status === "done") tail = `${signalColor(seat.signal)}  ${c.gray(`${seat.tools} tools${seat.costUsd ? ` · $${seat.costUsd.toFixed(2)}` : ""}`)}`;
  else if (seat.status === "running") tail = c.gray(truncate(seat.activity || "", Math.max(10, cols - 44)));
  else if (seat.status === "retry" || seat.status === "failed") tail = c.yellow(truncate(seat.error || "", Math.max(10, cols - 44)));
  return `  ${icon(seat, tick)} ${title} ${c.dim(elapsed)}  ${tail}`;
}

function header(view, cols) {
  const r = view.run;
  const inst = r.instrument || {};
  const left = `${c.bold(c.cyan("◆ AlphaCouncil"))}  ${c.bold(r.symbol)}${inst.name ? ` — ${truncate(inst.name, 28)}` : ""} ${c.gray(`· ${r.mode}${r.pace ? ` · ${r.pace}` : ""} · ${r.language}`)}`;
  const limit = Date.parse(r.deadline_at) - view.started;
  const right = `${mmss(Date.now() - view.started)} / ${mmss(limit)}${view.costUsd ? ` · $${view.costUsd.toFixed(2)}` : ""}`;
  const gap = Math.max(1, cols - width(left) - width(right) - 1);
  return `${left}${" ".repeat(gap)}${c.dim(right)}`;
}

function groundingLine(view) {
  if (!view.grounding) {
    view.grounding = readJson(join(runDir(view.run.run_id), "grounding.json"), {});
    view.lenses = readJson(join(runDir(view.run.run_id), "lenses.json"), []);
  }
  const q = view.grounding.quote;
  const t = view.grounding.technicals;
  const parts = [q ? `${c.bold(`${q.price} ${q.currency}`)} ${c.gray("delayed")}` : c.yellow("price unavailable")];
  if (t?.available) parts.push(`12m ${t.return_12m_pct}%`);
  const pe = view.grounding.fundamentals?.ratios?.pe_ttm;
  if (pe) parts.push(`P/E ${pe}`);
  const lens = (view.lenses || []).map((l) => `${l.id.split("_")[0]}${l.stance === "supportive" ? c.green("+") : l.stance === "opposed" ? c.red("−") : l.stance === "neutral" ? c.yellow("~") : c.gray("∅")}`).join(" ");
  return `  ${parts.join(c.gray(" · "))}   ${c.gray("lenses")} ${lens}`;
}

export function renderDashboard(view, { cols = process.stdout.columns || 100, rows = process.stdout.rows || 40, tick = 0 } = {}) {
  const lang = view.run.language;
  const seats = [...view.seats.values()];
  const rule = c.gray("─".repeat(Math.min(cols, 110)));
  const out = [header(view, Math.min(cols, 110)), groundingLine(view), rule];
  const ev = seats.filter((s) => s.stage === "evidence");
  out.push(`${c.bold("EVIDENCE")} ${c.gray(`${ev.filter((s) => s.status === "done").length}/${ev.length}`)}`);
  for (const s of ev) out.push(seatLine(s, lang, tick, cols));
  out.push(c.bold("DEBATE"));
  for (let r = 1; r <= view.run.rounds; r += 1) {
    const pair = seats.filter((s) => s.stage === "debate" && s.round === r);
    const cell = (s) => `${icon(s, tick)} ${s.role.startsWith("bull") ? "Bull" : "Bear"} ${c.dim(s.startedAt ? mmss((s.endedAt || Date.now()) - s.startedAt) : "     ")}`;
    const err = pair.find((s) => s.status === "retry" || s.status === "failed");
    out.push(`  R${r}  ${pair.map(cell).join("    ")}${err ? `  ${c.yellow(truncate(err.error || "", 40))}` : ""}`);
  }
  const pm = seats.find((s) => s.stage === "pm");
  out.push(c.bold("DECISION"));
  out.push(seatLine(pm, lang, tick, cols));
  out.push(rule);
  const room = Math.max(3, rows - out.length - 2);
  for (const l of view.log.slice(-room)) out.push(`${c.gray(l.at.toTimeString().slice(0, 8))} ${truncate(l.text, cols - 10)}`);
  out.push(c.gray(view.done ? "done" : "Ctrl+C stops the run and saves what was recorded"));
  return out.join("\n");
}

/** Drive the dashboard; returns { update(view), stop() }. */
export function startDashboard({ interactive = process.stdout.isTTY } = {}) {
  if (!interactive) {
    let printed = 0;
    return {
      update(view) {
        for (const l of view.log.slice(printed)) process.stdout.write(`${l.at.toTimeString().slice(0, 8)} ${l.text}\n`);
        printed = view.log.length;
      },
      stop() {},
    };
  }
  let current = null;
  let tick = 0;
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  const draw = () => {
    if (!current) return;
    const frame = renderDashboard(current, { tick: tick++ });
    process.stdout.write(`\x1b[H${frame.split("\n").map((l) => `${l}\x1b[K`).join("\n")}\x1b[J`);
  };
  const timer = setInterval(draw, 120);
  return {
    update(view) {
      current = view;
    },
    stop() {
      clearInterval(timer);
      draw();
      process.stdout.write("\x1b[?25h\x1b[?1049l");
    },
  };
}
