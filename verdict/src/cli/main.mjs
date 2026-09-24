// `verdict` — no arguments opens the full-screen app; arguments run one command and exit.

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { selectBackend } from "../models/index.mjs";
import { hasClaudeCli } from "../models/claude.mjs";
import { compare, compareRows } from "../engine/compare.mjs";
import * as data from "../engine/data.mjs";
import { detectLanguage, normalizeLanguage } from "../engine/i18n.mjs";
import { ask, htmlPath, loadRun, recentRun, reportPath, research } from "../engine/pipeline.mjs";
import { buildSnapshot } from "../engine/snapshot.mjs";
import { homeDir, listRuns, resolveRun } from "../engine/store.mjs";
import { resolveTarget } from "../engine/target.mjs";
import { addWatch, removeWatch, trackRecord, watchlist, watchStatus } from "../engine/watch.mjs";
import { page, pad, renderMarkdown, truncate } from "../render/terminal.mjs";
import { strings } from "../tui/strings.mjs";
import { chip, paint, ratingTone, tone } from "../tui/theme.mjs";
import { compareLines, heading, snapshotLines, trackLines, verdictLines, wordmark } from "../tui/views.mjs";
import { createStream } from "./stream.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const out = (s = "") => process.stdout.write(`${s}\n`);
const W = () => Math.min(process.stdout.columns || 100, 110) - 2;

function help() {
  const cmd = (a, b) => `  ${pad(tone.accent(a), 40)} ${tone.text(b)}`;
  return [
    "",
    ...wordmark().map((l) => `  ${l}`),
    `  ${tone.dim(`v${VERSION} · a research desk for any stock`)}`,
    "",
    heading("RESEARCH"),
    cmd("verdict", "full-screen app (watchlist, history, live research, reports)"),
    cmd("verdict NVDA", "deep research: 4 desks → bull vs bear → verdict (~3 min)"),
    cmd('verdict AAPL "is it cheap?"', "ask a question; the verdict answers it"),
    cmd("verdict 0700.HK --fast", "fast read (~1 min)"),
    cmd("verdict demo [--app]", "try it offline on a fictional company, no key needed"),
    cmd("verdict compare NVDA AMD AVGO", "research several and rank them (--deep for deep)"),
    cmd("verdict ask NVDA \"what if rates rise?\"", "follow-up on a saved verdict"),
    "",
    heading("KEEP TRACK"),
    cmd("verdict watch [add|rm] NVDA AAPL", "watchlist with price-zone and new-filing alerts"),
    cmd("verdict track", "how past verdicts did since"),
    cmd("verdict history · show NVDA · export NVDA", "saved verdicts · read one · save its HTML report"),
    "",
    heading("DATA (no model calls)"),
    cmd("verdict quote|snapshot|news|filings|options|lenses NVDA", "live data"),
    cmd("verdict macro · doctor [--live] · mcp", "macro · setup check · MCP server"),
    "",
    heading("OPTIONS"),
    cmd("--fast · --deep", "research depth (deep is the default)"),
    cmd("--lang zh-CN|ja|en", "report language (default: the language you type in)"),
    cmd("--engine api|claude", "api = ANTHROPIC_API_KEY (fastest) · claude = your Claude Code login"),
    cmd("--model · --research-model · --decision-model", "override models"),
    cmd("--fresh · --json · --plain", "ignore a recent verdict · JSON output · no live redraw"),
    "",
    tone.faint(`  data: ${homeDir()}`),
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { _: [] };
  const flags = new Set(["fast", "deep", "fresh", "json", "plain", "live", "help", "version", "report", "html", "app"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h") args.help = true;
    else if (a === "-v") args.version = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      args[k] = flags.has(k) ? true : v ?? argv[++i];
    } else args._.push(a);
  }
  return args;
}

function modelsFrom(args) {
  const m = {};
  if (args.model) Object.assign(m, { research: args.model, debate: args.model, decision: args.model, chat: args.model });
  for (const k of ["research", "debate", "decision"]) if (args[`${k}-model`]) m[k] = args[`${k}-model`];
  return m;
}

const backendFor = (args) => selectBackend({ engine: args.engine, models: modelsFrom(args) });

function banner(parts) {
  out(`${paint(" ◆ VERDICT ", { fg: "onAccent", bg: "accent", bold: true })} ${tone.dim(parts.filter(Boolean).join(" · "))}`);
}

function printVerdict(run) {
  out("");
  for (const l of verdictLines(run, W())) out(` ${l}`);
  out("");
  out(tone.faint(` ${reportPath(run.run_id)}`));
  out(tone.faint(` ${htmlPath(run.run_id)}`));
}

async function followUps(run, args) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || args.json) return;
  const S = strings(run.language);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let backend = null;
  try {
    for (;;) {
      const q = (await rl.question(`\n${tone.dim(S.askPlaceholder)} ${tone.faint("(Enter to quit · /report · /html)")}\n${tone.accent("❯")} `)).trim();
      if (!q) return;
      if (q === "/report") {
        page(renderMarkdown(readFileSync(reportPath(run.run_id), "utf8")));
        continue;
      }
      if (q === "/html") {
        out(tone.accent(htmlPath(run.run_id)));
        continue;
      }
      backend ||= await backendFor(args);
      let streamed = false;
      const r = await ask({ runId: run.run_id, question: q, backend, onText: (d) => { streamed = true; process.stdout.write(d); }, onActivity: (a) => { if (!streamed) out(tone.faint(`  · ${a}`)); } });
      if (!streamed) process.stdout.write(r.text);
      out();
    }
  } finally {
    rl.close();
  }
}

async function cmdResearch(args, words) {
  const target = await resolveTarget(words);
  const S = strings(args.lang ? normalizeLanguage(args.lang) : detectLanguage(words.join(" ")));
  if (!target) throw new Error(S.noTicker);
  const language = args.lang ? normalizeLanguage(args.lang) : detectLanguage(target.question || words.join(" "));
  const mode = args.fast ? "fast" : "deep";
  const recent = !args.fresh && !target.question ? recentRun({ symbol: target.symbol, mode, language }) : null;
  if (recent) {
    const run = loadRun(recent.run_id);
    if (args.json) return out(JSON.stringify(run, null, 2));
    out(tone.faint(` ↺ ${Math.round((Date.now() - Date.parse(run.created_at)) / 60000)} min · --fresh`));
    printVerdict(run);
    return followUps(run, args);
  }
  const backend = await backendFor(args);
  const tty = process.stdout.isTTY && !args.plain && !args.json;
  if (!args.json) banner([target.symbol, mode, `${backend.name} ${backend.models.research}/${backend.models.decision}`, language]);
  const job = { symbol: target.symbol, mode, language, question: target.question, tasks: {}, startedAt: Date.now(), cost: 0 };
  const stream = args.json ? { event() {}, stop() {} } : createStream({ job, tty });
  const controller = new AbortController();
  let hits = 0;
  const onSigint = () => {
    hits += 1;
    if (hits > 1) process.exit(130);
    controller.abort(new Error("stopped by user"));
  };
  process.on("SIGINT", onSigint);
  let run;
  try {
    run = await research({ symbol: target.symbol, mode, language, question: target.question, backend, signal: controller.signal, onEvent: (e) => stream.event(e) });
  } finally {
    stream.stop();
    process.off("SIGINT", onSigint);
  }
  if (args.json) return out(JSON.stringify(run, null, 2));
  const done = Object.values(run.desks).filter(Boolean).length;
  out(` ${tone.bull("●")} ${tone.dim(`${done}/${Object.keys(run.desks).length} desks${run.cases ? ` · bull ${run.cases.bull ? "✓" : "✕"} · bear ${run.cases.bear ? "✓" : "✕"}` : ""} · ${Math.floor(run.elapsed_ms / 60000)}:${String(Math.round(run.elapsed_ms / 1000) % 60).padStart(2, "0")}${run.cost_usd ? ` · $${run.cost_usd.toFixed(2)}` : ""}`)}`);
  printVerdict(run);
  if (run.state === "incomplete") process.exitCode = 2;
  if (run.decision) await followUps(run, args);
  return undefined;
}

async function cmdCompare(args) {
  const symbols = args._;
  if (symbols.length < 2) throw new Error("usage: verdict compare NVDA AMD [AVGO …] [--deep]");
  const backend = await backendFor(args);
  const language = args.lang ? normalizeLanguage(args.lang) : detectLanguage();
  const mode = args.deep ? "deep" : "fast";
  if (!args.json) banner([`compare ${symbols.join(" ").toUpperCase()}`, mode, backend.name]);
  const cmp = { symbols: symbols.map((s) => s.toUpperCase()), language, jobs: {}, ranking: null };
  let drawn = 0;
  let tick = 0;
  const tty = process.stdout.isTTY && !args.plain && !args.json;
  const draw = () => {
    tick += 1;
    const lines = compareLines(cmp, W(), { tick }).map((l) => ` ${l}`);
    process.stdout.write(`${drawn ? `\x1b[${drawn}F` : ""}\x1b[J${lines.join("\n")}\n`);
    drawn = lines.length;
  };
  const timer = tty ? setInterval(draw, 150) : null;
  let result;
  try {
    result = await compare({
      symbols,
      mode,
      language,
      backend,
      onEvent: (e) => {
        if (!e.symbol) return;
        const job = (cmp.jobs[e.symbol] ||= {});
        if (e.type === "stage") job.stage = e.stage;
        if (e.type === "done") job.run = e.run;
        if (!tty && !args.json && e.type === "done") out(`${e.symbol} ${e.run.rating || e.run.state}`);
      },
    });
  } finally {
    if (timer) clearInterval(timer);
  }
  if (args.json) return out(JSON.stringify({ ...result, rows: compareRows(result.runs), runs: undefined }, null, 2));
  cmp.ranking = result.ranking;
  for (const r of result.runs) (cmp.jobs[r.symbol] ||= {}).run = r;
  if (tty) draw();
  else for (const l of compareLines(cmp, W())) out(` ${l}`);
  out(tone.faint(` ${join(homeDir(), "compare", result.id, "compare.md")}`));
  return undefined;
}

async function cmdWatch(args) {
  const [sub, ...syms] = args._;
  if (sub === "add") addWatch(...syms);
  else if (sub === "rm" || sub === "remove") removeWatch(...syms);
  else if (sub) addWatch(sub, ...syms);
  const list = watchlist();
  if (!list.length) return out(tone.dim("watchlist is empty — verdict watch add NVDA AAPL"));
  const rows = await watchStatus();
  if (args.json) return out(JSON.stringify(rows, null, 2));
  out(` ${tone.dim(pad("", 2))}${pad(tone.dim("ticker"), 10)}${pad(tone.dim("price"), 12)}${pad(tone.dim("day"), 9)}${pad(tone.dim("verdict"), 14)}${pad(tone.dim("base"), 10)}${pad(tone.dim("upside"), 9)}${tone.dim("zone")}`);
  for (const r of rows) {
    const day = Number.isFinite(r.change_pct) ? paint(`${r.change_pct >= 0 ? "+" : ""}${r.change_pct.toFixed(2)}%`, r.change_pct >= 0 ? "bull" : "bear") : tone.faint("—");
    const up = Number.isFinite(r.upside) ? paint(`${r.upside >= 0 ? "+" : ""}${r.upside.toFixed(0)}%`, r.upside >= 0 ? "bull" : "bear") : tone.faint("—");
    out(` ${r.alerts.some((a) => !/no verdict/.test(a)) ? tone.accent("●") : " "} ${pad(tone.strong(r.symbol), 10)}${pad(tone.text(r.price ?? "—"), 12)}${pad(day, 9)}${pad(r.rating ? paint(r.rating, ratingTone(r.rating)) : tone.faint("—"), 14)}${pad(tone.text(r.base ?? "—"), 10)}${pad(up, 9)}${tone.dim(r.zone || "")}`);
    for (const a of r.alerts) out(`     ${tone.accent("↳")} ${tone.dim(a)}`);
  }
  return undefined;
}

async function cmdTrack(args) {
  const t = await trackRecord();
  if (args.json) return out(JSON.stringify(t, null, 2));
  for (const l of trackLines(t, W(), detectLanguage())) out(` ${l}`);
  return undefined;
}

async function cmdAsk(args) {
  const words = [...args._];
  let runId;
  try {
    runId = resolveRun(words[0]);
    words.shift();
  } catch {
    runId = resolveRun("latest");
  }
  const question = words.join(" ").trim();
  if (!question) throw new Error('usage: verdict ask [NVDA] "your question"');
  const backend = await backendFor(args);
  let streamed = false;
  const r = await ask({ runId, question, backend, onText: (d) => { streamed = true; process.stdout.write(d); } });
  if (!streamed) process.stdout.write(r.text);
  out();
}

function cmdHistory(args) {
  const runs = listRuns();
  if (args.json) return out(JSON.stringify(runs, null, 2));
  if (!runs.length) return out(tone.dim("no verdicts yet — try: verdict NVDA"));
  for (const r of runs.slice(0, 40)) out(` ${tone.faint(r.created_at.slice(0, 16).replace("T", " "))}  ${pad(tone.strong(r.symbol), 10)}${pad(r.rating ? paint(r.rating, ratingTone(r.rating)) : paint(r.state, r.state === "running" ? "dim" : "bear"), 13)}${pad(tone.dim(r.mode), 6)}${tone.dim(truncate(r.name || "", 28))}  ${tone.faint(r.run_id)}`);
  return undefined;
}

function cmdShow(args) {
  const runId = resolveRun(args._[0]);
  if (args.html) return out(htmlPath(runId));
  if (args.report) return page(renderMarkdown(readFileSync(reportPath(runId), "utf8"), W()));
  printVerdict(loadRun(runId));
  return undefined;
}

function cmdExport(args) {
  const runId = resolveRun(args._[0]);
  const run = loadRun(runId);
  const src = htmlPath(runId);
  if (!existsSync(src)) throw new Error("this run has no HTML report");
  const dest = join(process.cwd(), `${run.symbol}-verdict-${run.as_of}.html`.replace(/[^\w.-]/g, "_"));
  copyFileSync(src, dest);
  out(`${tone.bull("✓")} ${dest}`);
}

async function cmdData(cmd, args) {
  const n = (x) => (x === null || x === undefined ? tone.faint("n/a") : String(x));
  if (cmd === "macro") {
    const m = await data.getMacro();
    for (const [id, s] of Object.entries(m.series)) out(` ${pad(tone.strong(id), 14)} ${pad(tone.text(n(s.value)), 9)} ${tone.dim(`${s.label}${s.date ? ` · ${s.date}` : ""}${s.change_12m !== undefined && s.change_12m !== null ? ` · 12m Δ ${s.change_12m}` : ""}${s.yoy_pct ? ` · YoY ${s.yoy_pct}%` : ""}`)}`);
    if (m.gaps.length) out(tone.hold(`⚠ ${m.gaps.join("; ")}`));
    return;
  }
  const target = await resolveTarget(args._);
  if (!target) throw new Error(`usage: verdict ${cmd} NVDA`);
  const sym = target.symbol;
  if (cmd === "snapshot") {
    for (const l of snapshotLines(await buildSnapshot(sym), W(), detectLanguage())) out(` ${l}`);
  } else if (cmd === "quote") {
    const q = await data.getQuote(sym);
    out(` ${tone.strong(sym)} ${paint(`${q.price} ${q.currency}`, { fg: "ink", bold: true })} ${paint(`${q.change_pct >= 0 ? "+" : ""}${q.change_pct}%`, q.change_pct >= 0 ? "bull" : "bear")}  ${tone.dim(`52w ${q.low_52w}–${q.high_52w} · div ${n(q.dividend_yield_pct)}% · ${q.exchange} · delayed`)}`);
  } else if (cmd === "news") {
    const inst = await data.resolveInstrument(sym).catch(() => ({}));
    const r = await data.getNews(inst.name ? `"${inst.name}" OR ${sym}` : sym, { days: Number(args.days) || 30 });
    for (const i of r.items) out(` ${tone.faint(i.date)}  ${tone.text(i.title)}${i.publisher ? tone.dim(` — ${i.publisher}`) : ""}`);
    if (!r.items.length) out(tone.hold(" no dated headlines in the window"));
  } else if (cmd === "filings") {
    const r = await data.getFilings(sym, { limit: Number(args.limit) || 20 });
    if (!r.available) out(tone.hold(r.reason));
    else for (const f of r.filings) out(` ${tone.faint(f.filed)}  ${pad(tone.strong(f.form), 9)}${tone.text(truncate(f.description || "", 36))}  ${tone.faint(f.url)}`);
  } else if (cmd === "options") {
    const o = await data.getOptions(sym);
    if (!o.available) return void out(tone.hold(o.reason));
    out(` ${tone.strong(sym)} spot ${o.spot} · put/call OI ${o.put_call_oi_ratio} · volume ${o.put_call_volume_ratio}`);
    for (const x of o.term_structure) out(`  ${tone.faint(x.expiry)} ${pad(String(x.days), 4)}d  ATM IV ${tone.text(`${x.atm_iv_pct}%`)}  ${x.skew_25d_pct !== null ? tone.dim(`25Δ skew ${x.skew_25d_pct}`) : ""}`);
  } else if (cmd === "lenses") {
    const s = await buildSnapshot(sym, { news: false, options: false });
    for (const l of s.lenses) {
      const st = l.stance === "supportive" ? "bull" : l.stance === "opposed" ? "bear" : l.stance === "neutral" ? "hold" : "dim";
      out(` ${pad(paint(l.stance, st), 13)} ${tone.strong(l.name)}`);
      out(`${" ".repeat(15)}${tone.dim(l.checks.map((x) => `${x.label} ${x.display}${x.pass === null ? "" : x.pass ? " ✓" : " ✗"}`).join(" · ") || l.rationale)}`);
    }
    if (s.gaps.length) out(tone.hold(`⚠ ${s.gaps.join("; ")}`));
  }
}

async function cmdDoctor(args) {
  const ok = (m) => out(` ${tone.bull("✓")} ${m}`);
  const bad = (m) => out(` ${tone.bear("✕")} ${m}`);
  const info = (m) => out(` ${tone.dim("·")} ${m}`);
  banner(["doctor", `v${VERSION}`]);
  const major = Number(process.versions.node.split(".")[0]);
  (major >= 20 ? ok : bad)(`Node ${process.versions.node} (20+)`);
  const key = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  (key ? ok : info)(`api engine: ${key ? "ANTHROPIC_API_KEY set" : "no ANTHROPIC_API_KEY (optional, fastest)"}`);
  const cli = hasClaudeCli();
  (cli ? ok : info)(`claude engine: ${cli || "Claude Code not found (optional)"}`);
  if (!key && !cli) bad("no engine: set ANTHROPIC_API_KEY or install Claude Code");
  for (const [name, fn] of [
    ["Yahoo Finance · quotes, history, search", () => data.getQuote("AAPL")],
    ["SEC EDGAR · fundamentals, filings", () => data.lookupCik("AAPL")],
    ["Google News · dated headlines", () => data.getNews("Apple", { days: 7, limit: 1 })],
    ["Cboe · options", () => data.getOptions("AAPL")],
    ["FRED · macro", () => data.getMacro().then((m) => (Object.keys(m.series).length ? m : Promise.reject(new Error(m.gaps[0]))))],
  ]) {
    try {
      await fn();
      ok(name);
    } catch (error) {
      bad(`${name}: ${error.message}`);
    }
  }
  if (args.live && (key || cli)) {
    try {
      const backend = await backendFor(args);
      const t0 = Date.now();
      const r = await backend.call({ tier: "chat", system: "Reply tersely.", user: "Reply with the single word: ready", timeoutMs: 90_000 });
      (/ready/i.test(r.text) ? ok : bad)(`live ${backend.name} call · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (error) {
      bad(`live call: ${error.message}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.version) return out(VERSION);
  if (args.help) return out(help());
  const [cmd, ...rest] = args._;
  const sub = { ...args, _: rest };
  if (!cmd) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return out(help());
    const { App } = await import("../tui/app.mjs");
    const app = new App({ language: args.lang, engine: args.engine, models: modelsFrom(args) });
    await app.start();
    return undefined;
  }
  switch (cmd) {
    case "help": return out(help());
    case "compare": case "vs": return cmdCompare(sub);
    case "watch": return cmdWatch(sub);
    case "track": return cmdTrack(sub);
    case "ask": return cmdAsk(sub);
    case "history": case "runs": return cmdHistory(sub);
    case "show": return cmdShow(sub);
    case "export": return cmdExport(sub);
    case "doctor": return cmdDoctor(sub);
    case "mcp": return import("../mcp/server.mjs").then((m) => m.serve());
    case "demo": {
      // Offline, fictional company; `verdict demo --app` opens the full-screen app instead.
      if (sub.app && process.stdin.isTTY && process.stdout.isTTY) {
        const { App } = await import("../tui/app.mjs");
        const app = new App({ language: args.lang, engine: "demo" });
        setTimeout(() => app.submit("ACME"), 300);
        return app.start();
      }
      return cmdResearch({ ...sub, engine: "demo", fresh: true }, ["ACME", ...sub._]);
    }
    case "quote": case "snapshot": case "news": case "filings": case "options": case "lenses": case "macro":
      return cmdData(cmd, sub);
    default:
      return cmdResearch(args, args._);
  }
}

export { chip };
