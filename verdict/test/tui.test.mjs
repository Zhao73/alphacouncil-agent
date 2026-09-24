import { strict as assert } from "node:assert";
import { test } from "node:test";
import { fakeBackend, fakeSnapshot, isolateHome } from "./helpers.mjs";

isolateHome();
process.env.VERDICT_OFFLINE = "1";
const { Frame } = await import("../src/tui/frame.mjs");
const { parseKeys, LineEditor } = await import("../src/tui/keys.mjs");
const { App } = await import("../src/tui/app.mjs");
const { research } = await import("../src/engine/pipeline.mjs");
const { addWatch, watchlist } = await import("../src/engine/watch.mjs");

test("frame: ANSI styles, wide glyphs, clipping and row diffs", () => {
  const f = new Frame(12, 2);
  f.text(0, 0, "a\x1b[1mb\x1b[0m中文xyz", "", 7);
  assert.equal(f.plain().split("\n")[0], "ab中文x");
  assert.equal(f.chars[0][3], "");
  assert.match(f.rowString(0), /\x1b\[1mb/);
  const g = new Frame(12, 2);
  g.text(0, 0, "a\x1b[1mb\x1b[0m中文xyz", "", 7);
  assert.equal(g.diff(f), "");
  g.text(0, 1, "changed");
  assert.match(g.diff(f), /^\x1b\[2;1H/);
});

test("keys: arrows, shift-tab, paste, wheel, CJK text", () => {
  const keys = parseKeys("\x1b[A\x1b[Z\x1b[200~NVDA\nAMD\x1b[201~\x1b[<65;10;5M中文\r\x7f\x03");
  assert.deepEqual(keys.map((k) => k.name), ["up", "shift-tab", "text", "wheel-down", "text", "enter", "backspace", "ctrl-c"]);
  assert.equal(keys[2].text, "NVDA AMD");
  assert.equal(keys[4].text, "中文");
  const ed = new LineEditor();
  ed.handle({ name: "text", text: "NVDA 贵吗" });
  ed.handle({ name: "left" });
  ed.handle({ name: "backspace" });
  assert.equal(ed.value, "NVDA 吗");
  ed.handle({ name: "ctrl-w" });
  assert.equal(ed.value, "吗");
  ed.handle({ name: "end" });
  ed.handle({ name: "ctrl-w" });
  assert.equal(ed.value, "");
});

function app(opts = {}) {
  const a = new App({ cols: 110, rows: 32, language: "en", backendFactory: async () => fakeBackend(), clock: () => new Date("2026-09-24T09:00:00"), ...opts });
  a.stdin = {};
  return a;
}

test("app: welcome, typing a ticker runs research and opens the verdict", async () => {
  const a = app();
  assert.match(a.buildFrame().plain(), /QUICK START/);
  for (const k of parseKeys("TEST")) a.handleKey(k);
  assert.match(a.buildFrame().plain(), /❯ TEST/);
  a.handleKey({ name: "enter" });
  await new Promise((r) => setTimeout(r, 400));
  const job = [...a.jobs.values()][0];
  assert.ok(job.endedAt, "job finished");
  assert.equal(a.view.type, "run");
  const frame = a.buildFrame().plain();
  assert.match(frame, /1 Verdict/);
  assert.match(frame, /OVERWEIGHT ▲/);
  assert.match(frame, /PRICE LEVELS/);
});

test("app: tabs, evidence drill-down, watch toggle, help and quit guard", async () => {
  const run = await research({ symbol: "TEST", backend: fakeBackend(), snapshot: await fakeSnapshot() });
  const a = app();
  a.openRun(run.run_id);
  a.focus = "main";
  a.handleKey({ name: "right" });
  assert.equal(a.tab, "report");
  assert.match(a.buildFrame().plain(), /The verdict/);
  a.switchTab(2);
  a.handleKey({ name: "enter" });
  assert.match(a.buildFrame().plain(), /↳ business:S1/);
  a.handleKey({ name: "text", text: "w" });
  assert.deepEqual(watchlist(), ["TEST"]);
  assert.match(a.buildFrame().plain(), /added to watchlist/);
  a.handleKey({ name: "text", text: "?" });
  assert.match(a.buildFrame().plain(), /\/compare NVDA AMD AVGO/);
  let stopped = false;
  a.stop = () => { stopped = true; };
  a.jobs.set("x", { endedAt: null, controller: new AbortController() });
  a.handleKey({ name: "text", text: "q" });
  assert.equal(stopped, false);
  assert.match(a.buildFrame().plain(), /press q again/);
  a.handleKey({ name: "text", text: "q" });
  assert.equal(stopped, true);
});

test("app: follow-up questions stream into the Ask tab", async () => {
  const run = await research({ symbol: "TEST", backend: fakeBackend(), snapshot: await fakeSnapshot() });
  const a = app();
  a.openRun(run.run_id, "ask");
  await a.submit("what about rates?");
  assert.match(a.buildFrame().plain(), /answer to: what about rates\?/);
});

test("app: commands and small terminals", async () => {
  addWatch("TEST");
  const a = app();
  await a.command("/lang zh-CN");
  assert.match(a.buildFrame().plain(), /快速开始/);
  await a.command("/unwatch TEST");
  assert.deepEqual(watchlist(), []);
  await a.command("/nope");
  assert.match(a.buildFrame().plain(), /\? \/nope/);
  const tiny = app({ cols: 50, rows: 12 });
  assert.match(tiny.buildFrame().plain(), /enlarge the terminal/);
});
