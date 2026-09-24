// Stream mode: one command, live progress redrawn in place, then the verdict card printed to
// scrollback. Without a TTY (or with --plain) it prints one line per event instead.

import { liveLines } from "../tui/views.mjs";
import { tone } from "../tui/theme.mjs";
import { deskTitle } from "../engine/i18n.mjs";
import { DESKS } from "../engine/prompts.mjs";

export function createStream({ job, tty = process.stdout.isTTY, write = (s) => process.stdout.write(s), cols = () => process.stdout.columns || 100, rows = () => process.stdout.rows || 40 }) {
  let drawn = 0;
  let tick = 0;
  let timer = null;
  const started = Date.now();

  function draw() {
    tick += 1;
    const w = Math.min(cols(), 110) - 2;
    let lines = liveLines(job, w, { tick }).map((l) => ` ${l}`);
    const max = Math.max(6, rows() - 2);
    if (lines.length > max) lines = lines.slice(lines.length - max);
    write(`${drawn ? `\x1b[${drawn}F` : ""}\x1b[J${lines.join("\n")}\n`);
    drawn = lines.length;
  }

  const label = (task) => (DESKS[task] ? deskTitle(task, job.language, DESKS) : task);
  const log = (text) => write(`${tone.faint(`${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`)} ${text}\n`);

  return {
    event(e) {
      if (e.type === "snapshot") job.snapshot = e.snapshot;
      if (e.type === "cost") job.cost = e.usd;
      if (e.type === "task") {
        const tk = (job.tasks[e.task] ||= {});
        if (e.status === "running") Object.assign(tk, { status: "running", startedAt: Date.now(), activity: "" });
        else Object.assign(tk, { status: e.status, endedAt: Date.now(), note: e.stance || e.rating || "", error: e.error });
        if (!tty) log(`${label(e.task)} ${e.status}${e.error ? ` — ${e.error}` : e.stance ? ` (${e.stance})` : e.rating ? ` (${e.rating})` : ""}`);
      }
      if (e.type === "activity" && job.tasks[e.task]) {
        job.tasks[e.task].activity = e.text;
        if (!tty && !/^writing/.test(e.text)) log(tone.dim(`  ${label(e.task)} · ${e.text}`));
      }
      if (e.type === "draft") {
        job.draft = e.text;
        if (e.rating) job.draftRating = e.rating;
      }
      if (e.type === "stage" && !tty) log(tone.accent(e.stage));
      if (tty && !timer) timer = setInterval(draw, 120);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      job.endedAt = Date.now();
      // The live region is replaced by the verdict card, so it never duplicates the conclusion.
      if (tty && drawn) write(`\x1b[${drawn}F\x1b[J`);
      drawn = 0;
    },
  };
}
