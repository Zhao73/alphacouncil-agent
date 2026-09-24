#!/usr/bin/env node
// Regenerate README images from the real renderers: the full-screen app and the stream-mode card
// become SVGs (ANSI → SVG); the HTML report and the icon become PNGs when playwright-core and a
// Chromium are available. Uses the fictional ACME demo — no network, no model calls.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.VERDICT_HOME = mkdtempSync(join(tmpdir(), "verdict-shots-"));
process.env.FORCE_COLOR = "1";
process.env.VERDICT_TRUECOLOR = "1";
process.env.VERDICT_OFFLINE = "1";

const root = fileURLToPath(new URL("..", import.meta.url));
const assets = join(root, "assets");
const { research, htmlPath } = await import("../src/engine/pipeline.mjs");
const { createDemoBackend } = await import("../src/demo.mjs");
const { addWatch } = await import("../src/engine/watch.mjs");
const { App } = await import("../src/tui/app.mjs");
const { verdictLines, liveLines } = await import("../src/tui/views.mjs");
const { width } = await import("../src/render/terminal.mjs");

const CELL_W = 8.43;
const LINE_H = 18.5;
const PAD = 18;
const BAR = 30;

function parseAnsi(line) {
  const runs = [];
  let st = { fg: null, bg: null, bold: false, italic: false, underline: false, inverse: false };
  let text = "";
  const push = () => {
    if (text) runs.push({ text, ...st });
    text = "";
  };
  for (let i = 0; i < line.length;) {
    const m = /^\x1b\[([0-9;]*)m/.exec(line.slice(i));
    if (m) {
      push();
      const p = m[1].split(";").filter((x) => x !== "").map(Number);
      if (!p.length) st = { ...st, fg: null, bg: null, bold: false, italic: false, underline: false, inverse: false };
      for (let k = 0; k < p.length; k += 1) {
        const n = p[k];
        if (n === 0) st = { fg: null, bg: null, bold: false, italic: false, underline: false, inverse: false };
        else if (n === 1) st = { ...st, bold: true };
        else if (n === 3) st = { ...st, italic: true };
        else if (n === 4) st = { ...st, underline: true };
        else if (n === 7) st = { ...st, inverse: true };
        else if ((n === 38 || n === 48) && p[k + 1] === 2) {
          const hex = `#${p.slice(k + 2, k + 5).map((x) => x.toString(16).padStart(2, "0")).join("")}`;
          st = { ...st, [n === 38 ? "fg" : "bg"]: hex };
          k += 4;
        }
      }
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i));
    text += ch;
    i += ch.length;
  }
  push();
  return runs;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function toSvg(lines, { cols, title }) {
  const w = Math.round(cols * CELL_W + PAD * 2);
  const h = Math.round(lines.length * LINE_H + PAD * 2 + BAR);
  const body = [];
  lines.forEach((line, row) => {
    let col = 0;
    const y = BAR + PAD + row * LINE_H;
    for (const r of parseAnsi(line)) {
      const cw = width(r.text);
      const x = PAD + col * CELL_W;
      let fg = r.fg || "#c9c5bb";
      let bg = r.bg;
      if (r.inverse) [fg, bg] = [bg || "#0f1115", fg];
      if (bg) body.push(`<rect x="${x.toFixed(1)}" y="${(y - 1).toFixed(1)}" width="${(cw * CELL_W + 0.6).toFixed(1)}" height="${LINE_H + 0.5}" fill="${bg}"/>`);
      // Place every word at its own cell column: SVG would collapse runs of spaces.
      let sub = col;
      for (const part of r.text.split(/(\s+)/)) {
        const pw = width(part);
        if (part.trim()) body.push(`<text x="${(PAD + sub * CELL_W).toFixed(1)}" y="${(y + 13.5).toFixed(1)}" fill="${fg}"${r.bold ? ' font-weight="700"' : ""}${r.italic ? ' font-style="italic"' : ""}${r.underline ? ' text-decoration="underline"' : ""} textLength="${(pw * CELL_W).toFixed(1)}" lengthAdjust="spacingAndGlyphs">${esc(part)}</text>`);
        sub += pw;
      }
      col += cw;
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="'JetBrains Mono','SFMono-Regular',Menlo,Consolas,'DejaVu Sans Mono',monospace" font-size="14" xml:space="preserve">
<rect width="${w}" height="${h}" rx="12" fill="#0f1115"/>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="12" fill="none" stroke="#262a33"/>
<circle cx="22" cy="17" r="6" fill="#f85149"/><circle cx="42" cy="17" r="6" fill="#d29922"/><circle cx="62" cy="17" r="6" fill="#3fb950"/>
<text x="${w / 2}" y="21" fill="#8b8780" font-size="12" text-anchor="middle">${esc(title)}</text>
${body.join("\n")}
</svg>
`;
}

const backend = createDemoBackend({ speed: 0 });
const run = await research({ symbol: "ACME", backend, question: "" });
addWatch("ACME");

// 1. full-screen app, verdict tab
const clock = () => new Date("2026-09-24T14:32:00");
const app = new App({ cols: 118, rows: 40, language: "en", backendFactory: async () => backend, clock });
app.quotes.set("ACME", run.snapshot.quote);
app.stdin = {};
app.backend = backend;
app.openRun(run.run_id);
app.focus = "main";
let f = app.buildFrame();
writeFileSync(join(assets, "app.svg"), toSvg(Array.from({ length: f.h }, (_, y) => f.rowString(y)), { cols: f.w, title: "verdict" }));

// 2. full-screen app, evidence tab with a finding opened
app.switchTab(2);
app.evidence = { selected: 1, open: 1 };
f = app.buildFrame();
writeFileSync(join(assets, "evidence.svg"), toSvg(Array.from({ length: f.h }, (_, y) => f.rowString(y)), { cols: f.w, title: "verdict — evidence" }));

// 3. live research mid-run (stream mode)
const t0 = Date.now() - 83_000;
const job = {
  symbol: "ACME", mode: "deep", language: "en", startedAt: t0, cost: 0.61, snapshot: run.snapshot,
  tasks: {
    business: { status: "done", startedAt: t0, endedAt: t0 + 64_000, note: "bullish" },
    street: { status: "done", startedAt: t0, endedAt: t0 + 71_000, note: "mixed" },
    news: { status: "done", startedAt: t0, endedAt: t0 + 52_000, note: "bullish" },
    risk: { status: "done", startedAt: t0, endedAt: t0 + 69_000, note: "mixed" },
    bull: { status: "done", startedAt: t0 + 71_000, endedAt: t0 + 80_000 },
    bear: { status: "done", startedAt: t0 + 71_000, endedAt: t0 + 82_000 },
    decision: { status: "running", startedAt: t0 + 82_000, activity: "" },
  },
  draft: run.decision.conclusion.slice(0, 190),
  draftRating: "Overweight",
};
const live = liveLines(job, 100, { tick: 3 }).map((l) => ` ${l}`);
const head = `\x1b[38;2;27;20;0;48;2;245;165;36;1m ◆ VERDICT \x1b[0m \x1b[38;2;139;135;128mACME · deep · claude sonnet/opus · en\x1b[0m`;
writeFileSync(join(assets, "live.svg"), toSvg([head, "", ...live], { cols: 104, title: "verdict ACME" }));

// 4. stream-mode verdict card
const card = verdictLines(run, 100).map((l) => ` ${l}`);
writeFileSync(join(assets, "card.svg"), toSvg(card.slice(0, 44), { cols: 104, title: "verdict ACME — result" }));

// 5. PNGs: HTML report and icon (optional)
try {
  const { chromium } = await import(process.env.PLAYWRIGHT_CORE || "playwright-core");
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 960, height: 1400 }, deviceScaleFactor: 2, colorScheme: "dark" });
  await page.goto(`file://${htmlPath(run.run_id)}`);
  await page.screenshot({ path: join(assets, "report.png"), clip: { x: 0, y: 0, width: 960, height: 1250 } });
  await page.setViewportSize({ width: 512, height: 512 });
  await page.goto(`file://${join(assets, "logo.svg")}`);
  await page.screenshot({ path: join(assets, "icon.png"), omitBackground: true, clip: { x: 0, y: 0, width: 512, height: 512 } });
  await browser.close();
  console.log("png: report.png icon.png");
} catch (error) {
  console.log(`png skipped: ${error.message.split("\n")[0]}`);
}
console.log("svg: app.svg evidence.svg live.svg card.svg");
