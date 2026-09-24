// The full-screen Verdict app: sidebar (watchlist + research history), a tabbed main pane
// (live run, verdict, report, evidence, follow-up questions) and a command bar.

import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { selectBackend } from "../models/index.mjs";
import { compare } from "../engine/compare.mjs";
import * as data from "../engine/data.mjs";
import { detectLanguage, normalizeLanguage } from "../engine/i18n.mjs";
import { ask, htmlPath, loadRun, research } from "../engine/pipeline.mjs";
import { listRuns, readJsonl, runDir } from "../engine/store.mjs";
import { resolveTarget } from "../engine/target.mjs";
import { addWatch, lastVerdict, removeWatch, trackRecord, watchlist } from "../engine/watch.mjs";
import { pad, truncate, width } from "../render/terminal.mjs";
import { Frame } from "./frame.mjs";
import { LineEditor, parseKeys } from "./keys.mjs";
import { strings } from "./strings.mjs";
import { chip, paint, ratingTone, sgr, SPIN, tone } from "./theme.mjs";
import * as V from "./views.mjs";

const RUN_TABS = ["verdict", "report", "evidence", "ask"];

export class App {
  constructor({ cols = process.stdout.columns || 100, rows = process.stdout.rows || 30, language, engine, models = {}, write = (s) => process.stdout.write(s), backendFactory = selectBackend, clock = () => new Date() } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.language = normalizeLanguage(language || detectLanguage());
    this.engine = engine;
    this.models = models;
    this.write = write;
    this.backendFactory = backendFactory;
    this.clock = clock;
    this.input = new LineEditor();
    this.focus = "input";
    this.view = { type: "welcome" };
    this.tab = "verdict";
    this.scroll = 0;
    this.sideIndex = 0;
    this.evidence = { selected: 0, open: -1 };
    this.jobs = new Map();
    this.compares = new Map();
    this.asks = new Map();
    this.quotes = new Map();
    this.toast = null;
    this.tick = 0;
    this.prev = null;
    this.track = null;
    this.quitArmed = false;
    this.backend = null;
    this.hits = [];
    this.refreshRuns();
  }

  get S() {
    return strings(this.language);
  }

  // ------------------------------------------------------------ lifecycle

  start({ stdin = process.stdin, stdout = process.stdout } = {}) {
    this.stdin = stdin;
    stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[2J");
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    this.onData = (chunk) => {
      for (const key of parseKeys(chunk)) this.handleKey(key);
      this.render();
    };
    this.onResize = () => {
      this.cols = stdout.columns;
      this.rows = stdout.rows;
      this.prev = null;
      this.render();
    };
    stdin.on("data", this.onData);
    stdout.on("resize", this.onResize);
    this.timer = setInterval(() => {
      this.tick += 1;
      if (this.busy() || this.toast) this.render();
    }, 110);
    this.quoteTimer = setInterval(() => this.refreshQuotes(), 60_000);
    this.refreshQuotes();
    this.render();
    return new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.quoteTimer);
    this.stdin?.off("data", this.onData);
    process.stdout.off("resize", this.onResize);
    if (this.stdin?.isTTY) this.stdin.setRawMode(false);
    this.stdin?.pause();
    this.write("\x1b[?2004l\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l");
    this.resolveExit?.();
  }

  busy() {
    return [...this.jobs.values()].some((j) => !j.endedAt) || [...this.asks.values()].some((a) => a.pending);
  }

  notify(text, tone = "accent") {
    this.toast = { text, tone, until: Date.now() + 4000 };
  }

  refreshRuns() {
    this.history = listRuns().slice(0, 40);
  }

  async refreshQuotes() {
    await Promise.all(watchlist().map(async (sym) => {
      try {
        const q = await data.getQuote(sym);
        this.quotes.set(sym, q);
      } catch {
        // offline or unknown symbol: the row shows no price
      }
    }));
    this.render();
  }

  async getBackend() {
    if (!this.backend) this.backend = await this.backendFactory({ engine: this.engine, models: this.models });
    return this.backend;
  }

  // ------------------------------------------------------------ actions

  sideItems() {
    const items = watchlist().map((symbol) => ({ kind: "watch", symbol }));
    const running = [...this.jobs.values()].filter((j) => !j.endedAt && !j.compareId).map((j) => ({ kind: "job", id: j.id, symbol: j.symbol }));
    const comps = [...this.compares.values()].map((c) => ({ kind: "compare", id: c.id, symbol: c.symbols.join(" ") }));
    const runs = this.history.map((r) => ({ kind: "run", runId: r.run_id, symbol: r.symbol, rating: r.rating, state: r.state, date: r.created_at }));
    return [...items, ...running, ...comps, ...runs];
  }

  open(item) {
    if (!item) return;
    if (item.kind === "watch") {
      const last = lastVerdict(item.symbol);
      if (last) this.openRun(last.run_id);
      else this.notify(`${item.symbol}: ${this.S.noRuns} — Enter ${item.symbol}`);
      return;
    }
    if (item.kind === "job") this.setView({ type: "job", id: item.id }, "live");
    if (item.kind === "compare") this.setView({ type: "compare", id: item.id });
    if (item.kind === "run") this.openRun(item.runId);
  }

  openRun(runId, tab = "verdict") {
    this.setView({ type: "run", runId }, tab);
  }

  setView(view, tab = this.tab) {
    this.view = view;
    this.tab = tab;
    this.scroll = 0;
    this.evidence = { selected: 0, open: -1 };
  }

  currentRun() {
    if (this.view.type === "run") {
      if (!this.runCache || this.runCache.run_id !== this.view.runId) {
        try {
          this.runCache = loadRun(this.view.runId);
        } catch {
          this.runCache = null;
        }
      }
      return this.runCache;
    }
    if (this.view.type === "job") return this.jobs.get(this.view.id)?.run || null;
    return null;
  }

  currentSymbol() {
    if (this.view.type === "job") return this.jobs.get(this.view.id)?.symbol;
    return this.currentRun()?.symbol;
  }

  async startResearch({ symbol, question = "", mode = "deep", compareId = null }) {
    const id = `${symbol}-${Date.now().toString(36)}`;
    const language = this.language === "en" ? normalizeLanguage(detectLanguage(question, { LANG: "" })) : this.language;
    const job = { id, symbol, question, mode, language, tasks: {}, startedAt: Date.now(), cost: 0, controller: new AbortController(), compareId, stage: "snapshot" };
    this.jobs.set(id, job);
    if (!compareId) {
      this.setView({ type: "job", id }, "live");
      this.notify(`${this.S.started}: ${symbol}`);
    }
    try {
      const backend = await this.getBackend();
      const run = await research({ symbol, mode, language, question, backend, signal: job.controller.signal, onEvent: (e) => this.onEvent(job, e) });
      job.run = run;
      job.runId = run.run_id;
    } catch (error) {
      job.error = error.message;
      this.notify(error.message, "bear");
    } finally {
      job.endedAt = Date.now();
      this.refreshRuns();
      if (this.view.type === "job" && this.view.id === id && job.run) this.setView({ type: "run", runId: job.run.run_id }, "verdict");
      this.render();
    }
    return job;
  }

  onEvent(job, e) {
    if (e.type === "stage") job.stage = e.stage;
    if (e.type === "snapshot") job.snapshot = e.snapshot;
    if (e.type === "cost") job.cost = e.usd;
    if (e.type === "task") {
      const tk = (job.tasks[e.task] ||= {});
      if (e.status === "running") Object.assign(tk, { status: "running", startedAt: Date.now(), endedAt: null, activity: "" });
      else Object.assign(tk, { status: e.status, endedAt: Date.now(), note: e.stance || e.rating || "", error: e.error });
    }
    if (e.type === "activity" && job.tasks[e.task]) job.tasks[e.task].activity = e.text;
    if (e.type === "draft") {
      job.draft = e.text;
      if (e.rating) job.draftRating = e.rating;
    }
  }

  async startCompare(symbols, mode = "fast") {
    const id = `cmp-${Date.now().toString(36)}`;
    const cmp = { id, symbols: symbols.map(data.normalizeSymbol), language: this.language, jobs: {}, ranking: null, startedAt: Date.now() };
    this.compares.set(id, cmp);
    this.setView({ type: "compare", id });
    try {
      const backend = await this.getBackend();
      const result = await compare({
        symbols: cmp.symbols,
        mode,
        language: this.language,
        backend,
        onEvent: (e) => {
          if (!e.symbol) return;
          const job = (cmp.jobs[e.symbol] ||= { tasks: {}, stage: "snapshot" });
          if (e.type === "stage") job.stage = e.stage;
          if (e.type === "done") job.run = e.run;
        },
      });
      cmp.ranking = result.ranking;
      for (const r of result.runs) (cmp.jobs[r.symbol] ||= {}).run = r;
    } catch (error) {
      this.notify(error.message, "bear");
    } finally {
      cmp.endedAt = Date.now();
      this.refreshRuns();
      this.render();
    }
  }

  async runAsk(runId, question) {
    const entry = this.asks.get(runId) || { transcript: readJsonl(join(runDir(runId), "followups.jsonl")).map((x) => ({ question: x.question, answer: x.answer })), pending: null };
    this.asks.set(runId, entry);
    entry.pending = { question, answer: "" };
    try {
      const backend = await this.getBackend();
      const r = await ask({ runId, question, backend, onText: (d) => { entry.pending.answer += d; } });
      entry.transcript.push({ question, answer: r.text || entry.pending.answer });
    } catch (error) {
      entry.transcript.push({ question, answer: `⚠ ${error.message}` });
    } finally {
      entry.pending = null;
      this.render();
    }
  }

  exportCurrent() {
    const run = this.currentRun();
    if (!run || !existsSync(htmlPath(run.run_id))) return this.notify("—");
    const name = `${run.symbol}-verdict-${run.as_of}.html`.replace(/[^\w.-]/g, "_");
    const dest = join(process.cwd(), name);
    try {
      copyFileSync(htmlPath(run.run_id), dest);
      this.notify(`${this.S.exported} → ${dest}`);
    } catch {
      this.notify(`${this.S.exported} → ${htmlPath(run.run_id)}`);
    }
    return dest;
  }

  toggleWatch(sym = this.currentSymbol()) {
    if (!sym) return;
    if (watchlist().includes(sym)) {
      removeWatch(sym);
      this.notify(`${sym} ${this.S.unwatched}`);
    } else {
      addWatch(sym);
      this.notify(`${sym} ${this.S.watched}`);
      this.refreshQuotes();
    }
  }

  quit() {
    if (this.busy() && !this.quitArmed) {
      this.quitArmed = true;
      this.notify(this.S.quitConfirm, "hold");
      return;
    }
    for (const j of this.jobs.values()) j.controller?.abort(new Error("stopped by user"));
    this.stop();
  }

  async submit(text) {
    const value = text.trim();
    if (!value) return;
    if (value.startsWith("/")) return this.command(value);
    const run = this.currentRun();
    if (run && this.tab === "ask" && this.view.type === "run") return this.runAsk(run.run_id, value);
    const target = await resolveTarget(value);
    if (!target) return this.notify(this.S.noTicker, "bear");
    return this.startResearch({ ...target, mode: "deep" });
  }

  async command(line) {
    const [cmd, ...args] = line.slice(1).split(/\s+/).filter(Boolean);
    switch ((cmd || "").toLowerCase()) {
      case "fast":
      case "deep": {
        const target = await resolveTarget(args.join(" "));
        if (!target) return this.notify(this.S.noTicker, "bear");
        return this.startResearch({ ...target, mode: cmd.toLowerCase() });
      }
      case "compare": {
        const mode = args[0] === "deep" ? (args.shift(), "deep") : "fast";
        if (args.length < 2) return this.notify("/compare NVDA AMD AVGO", "hold");
        return this.startCompare(args, mode);
      }
      case "watch":
        if (args.length) {
          addWatch(...args);
          this.refreshQuotes();
          return this.notify(`${args.join(" ").toUpperCase()} ${this.S.watched}`);
        }
        return this.toggleWatch();
      case "unwatch":
        removeWatch(...(args.length ? args : [this.currentSymbol()].filter(Boolean)));
        return this.notify(this.S.unwatched);
      case "export":
        return this.exportCurrent();
      case "track":
        this.setView({ type: "track" });
        this.track = null;
        trackRecord().then((t) => {
          this.track = t;
          this.render();
        }).catch((e) => this.notify(e.message, "bear"));
        return undefined;
      case "lang":
        this.language = normalizeLanguage(args[0] || "en");
        this.prev = null;
        return undefined;
      case "help":
        return this.setView({ type: "help" });
      case "home":
        return this.setView({ type: "welcome" });
      case "quit":
      case "q":
        return this.quit();
      default:
        return this.notify(`? /${cmd}`, "hold");
    }
  }

  // ------------------------------------------------------------ keys

  tabs() {
    if (this.view.type === "job") return ["live"];
    if (this.view.type === "run") return RUN_TABS;
    return [];
  }

  handleKey(key) {
    if (key.name !== "text" || key.text !== "q") this.quitArmed = false;
    if (key.name === "ctrl-c") return this.quit();
    if (key.name === "wheel-up" || key.name === "wheel-down") {
      this.scroll = Math.max(0, this.scroll + (key.name === "wheel-up" ? -3 : 3));
      return undefined;
    }
    if (key.name === "click") return this.click(key.x, key.y);
    if (key.name === "tab" || key.name === "shift-tab") {
      const order = this.cols >= 80 ? ["input", "side", "main"] : ["input", "main"];
      const i = order.indexOf(this.focus);
      this.focus = order[(i + (key.name === "tab" ? 1 : order.length - 1)) % order.length];
      return undefined;
    }
    if (this.focus === "input") {
      if (key.name === "enter") {
        const v = this.input.value;
        this.input.set("");
        this.submit(v);
        return undefined;
      }
      if (key.name === "escape") {
        this.focus = "main";
        return undefined;
      }
      if (key.name === "up" || key.name === "down" || key.name === "pageup" || key.name === "pagedown") return this.scrollMain(key.name);
      this.input.handle(key);
      return undefined;
    }
    if (key.name === "text") {
      const ch = key.text;
      if (ch === "q") return this.quit();
      if (ch === "?") return this.setView({ type: "help" });
      if (ch === "w") return this.toggleWatch();
      if (ch === "x") return this.exportCurrent();
      if (ch === "/" || ch === ":") {
        this.focus = "input";
        if (ch === "/") this.input.set("/");
        return undefined;
      }
      if (/^[1-4]$/.test(ch) && this.tabs().length) return this.switchTab(Number(ch) - 1);
      this.focus = "input";
      this.input.handle(key);
      return undefined;
    }
    if (key.name === "escape") {
      this.focus = "input";
      return undefined;
    }
    if (this.focus === "side") {
      const items = this.sideItems();
      if (key.name === "up") this.sideIndex = Math.max(0, this.sideIndex - 1);
      if (key.name === "down") this.sideIndex = Math.min(items.length - 1, this.sideIndex + 1);
      if (key.name === "enter" || key.name === "right") {
        this.open(items[this.sideIndex]);
        this.focus = "main";
      }
      return undefined;
    }
    // main pane
    if (key.name === "left" || key.name === "right") {
      const tabs = this.tabs();
      if (tabs.length) this.switchTab((tabs.indexOf(this.tab) + (key.name === "right" ? 1 : tabs.length - 1)) % tabs.length);
      return undefined;
    }
    if (this.tab === "evidence" && this.view.type === "run") {
      if (key.name === "up") this.evidence.selected = Math.max(0, this.evidence.selected - 1);
      else if (key.name === "down") this.evidence.selected += 1;
      else if (key.name === "enter") this.evidence.open = this.evidence.open === this.evidence.selected ? -1 : this.evidence.selected;
      else return this.scrollMain(key.name);
      return undefined;
    }
    return this.scrollMain(key.name);
  }

  switchTab(i) {
    const tabs = this.tabs();
    if (!tabs[i]) return;
    this.tab = tabs[i];
    this.scroll = 0;
    if (this.tab === "ask") this.focus = "input";
  }

  scrollMain(name) {
    const page = Math.max(3, this.rows - 8);
    if (name === "up") this.scroll -= 1;
    if (name === "down") this.scroll += 1;
    if (name === "pageup") this.scroll -= page;
    if (name === "pagedown") this.scroll += page;
    if (name === "home") this.scroll = 0;
    if (name === "end") this.scroll = 1e9;
    this.scroll = Math.max(0, this.scroll);
  }

  click(x, y) {
    const hit = this.hits.find((h) => x >= h.x && x < h.x + h.w && y === h.y);
    hit?.action();
  }

  // ------------------------------------------------------------ drawing

  mainLines(w) {
    const S = this.S;
    switch (this.view.type) {
      case "welcome":
        return V.welcomeLines(w, { language: this.language, recent: this.history.filter((r) => r.rating), track: this.track });
      case "help":
        return helpLines(this.language);
      case "track":
        return V.trackLines(this.track, w, this.language);
      case "compare": {
        const cmp = this.compares.get(this.view.id);
        return cmp ? V.compareLines(cmp, w, { tick: this.tick }) : [];
      }
      case "job": {
        const job = this.jobs.get(this.view.id);
        return job ? V.liveLines(job, w, { tick: this.tick }) : [];
      }
      case "run": {
        const run = this.currentRun();
        if (!run) return [tone.dim("—")];
        if (this.tab === "report") return V.reportLines(run, w);
        if (this.tab === "evidence") {
          const ev = V.evidenceLines(run, w, this.evidence);
          if (this.evidence.selected >= ev.count) this.evidence.selected = Math.max(0, ev.count - 1);
          const anchor = ev.anchors[this.evidence.selected] ?? 0;
          const viewH = this.rows - 7;
          if (anchor < this.scroll) this.scroll = anchor;
          if (anchor > this.scroll + viewH - 4) this.scroll = anchor - viewH + 4;
          return ev.lines;
        }
        if (this.tab === "ask") {
          const entry = this.asks.get(run.run_id) || { transcript: readJsonl(join(runDir(run.run_id), "followups.jsonl")).map((x) => ({ question: x.question, answer: x.answer })), pending: null };
          this.asks.set(run.run_id, entry);
          return V.askLines(run.language, entry.transcript, w, { pending: entry.pending });
        }
        return V.verdictLines(run, w);
      }
      default:
        return [S.tagline];
    }
  }

  viewTitle() {
    const v = this.view;
    if (v.type === "job") {
      const j = this.jobs.get(v.id);
      return j ? `${j.symbol} · ${j.mode}${j.question ? ` · ${j.question}` : ""}` : "";
    }
    if (v.type === "run") {
      const r = this.currentRun();
      return r ? `${r.symbol}${r.name ? ` · ${r.name}` : ""}` : "";
    }
    if (v.type === "compare") return this.compares.get(v.id)?.symbols.join(" · ") || "";
    if (v.type === "track") return this.S.track;
    if (v.type === "help") return this.S.help;
    return this.S.tagline;
  }

  buildFrame() {
    const W = Math.max(20, this.cols);
    const H = Math.max(8, this.rows);
    const f = new Frame(W, H);
    this.hits = [];
    if (this.toast && Date.now() > this.toast.until) this.toast = null;
    if (W < 60 || H < 16) {
      f.text(1, 1, tone.accent("VERDICT"));
      f.text(1, 3, tone.dim(`enlarge the terminal (${W}×${H}, need 60×16)`));
      return f;
    }
    const S = this.S;
    // title bar
    f.fill(0, 0, W, 1, sgr({ bg: "panel" }));
    f.text(0, 0, paint(" ◆ VERDICT ", { fg: "onAccent", bg: "accent", bold: true }), sgr({ bg: "panel" }));
    f.text(12, 0, ` ${truncate(this.viewTitle(), W - 40)}`, sgr({ fg: "text", bg: "panel" }), W - 40);
    const right = `${this.backend ? `${this.backend.name} · ` : ""}${this.language} · ${this.clock().toTimeString().slice(0, 5)} `;
    f.text(W - width(right), 0, right, sgr({ fg: "dim", bg: "panel" }));

    const sw = W >= 100 ? 32 : W >= 80 ? 26 : 0;
    const bh = H - 3;
    if (sw) this.drawSide(f, 0, 1, sw, bh);
    this.drawMain(f, sw, 1, W - sw, bh);

    // command bar
    const y = H - 2;
    const prompt = this.focus === "input" ? tone.accent("❯ ") : tone.faint("❯ ");
    f.text(1, y, prompt);
    const placeholder = this.view.type === "run" && this.tab === "ask" ? S.askPlaceholder : S.placeholder;
    if (!this.input.value) f.text(this.focus === "input" ? 5 : 3, y, tone.faint(truncate(placeholder, W - 7)));
    else {
      const chars = [...this.input.value];
      const before = chars.slice(0, this.input.cursor).join("");
      const vis = width(before) > W - 8 ? truncate(before, W - 8) : before;
      f.text(3, y, tone.ink(this.input.value), "", W - 5);
      if (this.focus === "input") {
        const cx = 3 + width(vis);
        const under = chars[this.input.cursor] || " ";
        f.text(cx, y, paint(under, { inverse: true }));
      }
    }
    if (this.focus === "input" && !this.input.value) f.text(3, y, paint(" ", { inverse: true }));
    // hints / toast
    const hy = H - 1;
    f.text(1, hy, tone.faint(truncate(S.hints, W - 2)));
    if (this.toast) {
      const msg = ` ${truncate(this.toast.text, W - 4)} `;
      f.text(Math.max(1, W - width(msg) - 1), hy, paint(msg, { fg: "onAccent", bg: this.toast.tone === "bear" ? "bear" : this.toast.tone === "hold" ? "hold" : "accent", bold: true }));
    }
    return f;
  }

  drawSide(f, x, y, w, h) {
    const S = this.S;
    f.box(x, y, w, h, { title: S.watchlist, active: this.focus === "side" });
    const items = this.sideItems();
    if (this.sideIndex >= items.length) this.sideIndex = Math.max(0, items.length - 1);
    let row = y + 1;
    const maxRow = y + h - 1;
    const inner = w - 4;
    const watchCount = items.filter((i) => i.kind === "watch").length;
    if (!watchCount) f.text(x + 2, row++, tone.faint(truncate(S.empty, inner)));
    let researchHeader = false;
    items.forEach((it, idx) => {
      if (row >= maxRow) return;
      if (it.kind !== "watch" && !researchHeader) {
        researchHeader = true;
        row += 1;
        if (row >= maxRow) return;
        f.text(x + 2, row++, paint(S.research, { fg: "dim", bold: true }));
      }
      if (row >= maxRow) return;
      const sel = idx === this.sideIndex;
      const bg = sel && this.focus === "side" ? sgr({ bg: "select" }) : "";
      if (bg) f.fill(x + 1, row, w - 2, 1, bg);
      const marker = sel ? tone.accent("▸") : " ";
      let line = "";
      if (it.kind === "watch") {
        const q = this.quotes.get(it.symbol);
        const last = this.history.find((r) => r.symbol === it.symbol && r.rating);
        const px = q ? `${q.price}` : "";
        const ch = q && Number.isFinite(q.change_pct) ? paint(`${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(1)}%`, q.change_pct >= 0 ? "bull" : "bear") : "";
        const r = last ? paint(abbrev(last.rating), ratingTone(last.rating)) : tone.faint("·");
        line = `${marker}${pad(tone.strong(it.symbol), 9)}${pad(tone.text(px), 9)}${pad(ch, 7)}${r}`;
      } else if (it.kind === "job") {
        line = `${marker}${tone.accent(SPIN[this.tick % SPIN.length])} ${pad(tone.strong(it.symbol), 9)}${tone.dim(this.jobs.get(it.id)?.stage || "")}`;
      } else if (it.kind === "compare") {
        line = `${marker}${tone.info("⇄")} ${tone.text(truncate(it.symbol, inner - 3))}`;
      } else {
        const st = it.rating ? paint(abbrev(it.rating), ratingTone(it.rating)) : paint(it.state === "running" ? "…" : "✕", it.state === "running" ? "dim" : "bear");
        line = `${marker}${tone.faint(String(it.date).slice(5, 10))} ${pad(tone.strong(it.symbol), 9)}${st}`;
      }
      f.text(x + 1, row, line, bg, w - 2);
      const r0 = row;
      this.hits.push({ x: x + 1, y: r0, w: w - 2, action: () => { this.sideIndex = idx; this.open(it); this.focus = "main"; } });
      row += 1;
    });
  }

  drawMain(f, x, y, w, h) {
    const tabs = this.tabs();
    f.box(x, y, w, h, { active: this.focus === "main" });
    let top = y + 1;
    if (tabs.length) {
      let cx = x + 2;
      tabs.forEach((tb, i) => {
        const label = ` ${i + 1} ${this.S.tabs[tb]} `;
        const active = tb === this.tab;
        const text = active ? paint(label, { fg: "onAccent", bg: "accent", bold: true }) : tone.dim(label);
        f.text(cx, top, text);
        this.hits.push({ x: cx, y: top, w: width(label), action: () => this.switchTab(i) });
        cx += width(label) + 1;
      });
      top += 2;
    }
    const cw = w - 4;
    const ch = y + h - 1 - top;
    const lines = this.mainLines(cw);
    const maxScroll = Math.max(0, lines.length - ch);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    for (let i = 0; i < ch; i += 1) {
      const line = lines[this.scroll + i];
      if (line !== undefined) f.text(x + 2, top + i, line, "", cw);
    }
    if (maxScroll > 0) {
      const barH = Math.max(1, Math.round((ch * ch) / lines.length));
      const barY = top + Math.round((this.scroll / maxScroll) * (ch - barH));
      for (let i = 0; i < barH; i += 1) f.set(x + w - 1, barY + i, "┃", sgr({ fg: "accentDim" }));
    }
  }

  render() {
    if (!this.stdin) return;
    const frame = this.buildFrame();
    const out = frame.diff(this.prev);
    this.prev = frame;
    if (out) this.write(`\x1b[?2026h${out}\x1b[?2026l`);
  }
}

function abbrev(rating) {
  return { Buy: "BUY", Overweight: "OW", Hold: "HOLD", Underweight: "UW", Sell: "SELL" }[rating] || String(rating).slice(0, 4);
}

function helpLines(language) {
  const S = strings(language);
  const rows = [
    ["NVDA / 0700.HK is it cheap?", "research (deep) · a question is answered by the verdict"],
    ["/fast AAPL", "fast read"],
    ["/compare NVDA AMD AVGO", "research several and rank them (/compare deep … for deep)"],
    ["/watch NVDA · /unwatch NVDA", "watchlist"],
    ["/track", "how past verdicts did since"],
    ["/export  or  x", "save the HTML report to the current folder"],
    ["/lang zh-CN · /home · /quit", "language · home · quit"],
    ["", ""],
    ["Tab / Shift-Tab", "move focus: command bar · sidebar · main"],
    ["← →  or  1-4", "switch tabs: Verdict · Report · Evidence · Ask"],
    ["↑ ↓ PgUp PgDn wheel", "scroll · in Evidence, select a finding; Enter shows its sources"],
    ["w · x · ? · q", "watch · export · help · quit"],
  ];
  return ["", ...V.wordmark().map((l) => `  ${l}`), "", `  ${V.heading(S.help)}`, ...rows.map(([k, v]) => (k ? `   ${pad(tone.accent(k), 34)} ${tone.text(v)}` : ""))];
}

export { chip };
