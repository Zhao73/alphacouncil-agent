// Live progress: a small region redrawn in place under the snapshot card. No alternate screen,
// so everything printed stays in the terminal's scrollback. Non-TTY: one line per event.

import { deskTitle } from "../core/i18n.mjs";
import { DESKS } from "../core/prompts.mjs";
import { ui } from "./labels.mjs";
import { snapshotCard } from "./cards.mjs";
import { c, pad, truncate } from "./term.mjs";

const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function createLive({ language, mode, tty = process.stdout.isTTY, write = (s) => process.stdout.write(s) }) {
  const U = ui(language);
  const tasks = new Map();
  let started = Date.now();
  let cost = 0;
  let snapshotShown = false;
  let lines = 0;
  let tick = 0;
  let timer = null;

  const deskIds = mode === "fast" ? ["all"] : ["business", "street", "news", "risk"];
  for (const id of deskIds) tasks.set(id, { status: "waiting", label: deskTitle(id, language, DESKS) });
  if (mode !== "fast") {
    tasks.set("bull", { status: "waiting", label: U.bull });
    tasks.set("bear", { status: "waiting", label: U.bear });
  }
  tasks.set("decision", { status: "waiting", label: U.pm });

  const icon = (tk) => ({ done: c.green("✓"), failed: c.red("✗"), running: c.cyan(SPIN[tick % SPIN.length]) }[tk.status] || c.gray("·"));
  const row = (id, cols) => {
    const tk = tasks.get(id);
    const time = tk.startedAt ? clock((tk.endedAt || Date.now()) - tk.startedAt) : "";
    let tail = "";
    if (tk.status === "running") tail = c.gray(tk.activity || U.thinking);
    else if (tk.status === "done") tail = tk.note ? c.dim(tk.note) : "";
    else if (tk.status === "failed") tail = c.red(tk.error || "");
    return `  ${icon(tk)} ${pad(truncate(tk.label, 22), 22)} ${c.dim(pad(time, 5))} ${truncate(tail, Math.max(10, cols - 36))}`;
  };

  function frame() {
    const cols = Math.min(process.stdout.columns || 100, 120);
    const out = [c.bold(U.desks), ...deskIds.map((id) => row(id, cols))];
    if (mode !== "fast") out.push(c.bold(U.debate), row("bull", cols), row("bear", cols));
    out.push(c.bold(U.decision), row("decision", cols));
    out.push(c.gray(`⏱ ${clock(Date.now() - started)}${cost ? ` · $${cost.toFixed(2)}` : ""} · ${U.stop}`));
    return out;
  }

  function draw() {
    if (!tty || !snapshotShown) return;
    tick += 1;
    const f = frame();
    write(`${lines ? `\x1b[${lines}F` : ""}\x1b[J${f.join("\n")}\n`);
    lines = f.length;
  }

  function log(text) {
    if (!tty) write(`${clock(Date.now() - started).padStart(5)} ${text}\n`);
  }

  return {
    event(e) {
      if (e.type === "run") started = Date.parse(e.run.created_at);
      if (e.type === "stage" && e.stage === "snapshot" && tty) write(c.gray(`${U.snapshot}\n`));
      if (e.type === "snapshot") {
        if (tty) write("\x1b[1F\x1b[J");
        write(`${snapshotCard(e.snapshot, language)}\n\n`);
        snapshotShown = true;
        if (tty && !timer) timer = setInterval(draw, 120);
      }
      if (e.type === "cost") cost = e.usd;
      const tk = tasks.get(e.task);
      if (e.type === "task" && tk) {
        if (e.status === "running") Object.assign(tk, { status: "running", startedAt: Date.now(), endedAt: null, activity: "" });
        if (e.status === "done") Object.assign(tk, { status: "done", endedAt: Date.now(), note: e.stance || e.rating || "" });
        if (e.status === "failed") Object.assign(tk, { status: "failed", endedAt: Date.now(), error: e.error });
        log(`${tk.label}: ${e.status}${e.error ? ` — ${e.error}` : e.stance ? ` (${e.stance})` : e.rating ? ` (${e.rating})` : ""}`);
      }
      if (e.type === "activity" && tk) {
        tk.activity = e.text;
        if (!/writing/.test(e.text)) log(`  ${tk.label} · ${e.text}`);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      draw();
    },
  };
}
