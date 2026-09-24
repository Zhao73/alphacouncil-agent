// `alpha` — AlphaCouncil in the terminal.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { selectBackend } from "../backends/index.mjs";
import { hasClaudeCli } from "../backends/claude.mjs";
import * as data from "../core/data.mjs";
import { detectLanguage, normalizeLanguage } from "../core/i18n.mjs";
import { ask, loadRun, recentRun, reportPath, research } from "../core/pipeline.mjs";
import { buildSnapshot } from "../core/snapshot.mjs";
import { listRuns, resolveRun, runsDir } from "../core/store.mjs";
import { snapshotCard, summaryCard } from "./cards.mjs";
import { ui } from "./labels.mjs";
import { createLive } from "./live.mjs";
import { c, page, renderMarkdown, truncate } from "./term.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const HELP = `${c.bold("alpha")} ${VERSION} — AI equity research in your terminal

  ${c.cyan("alpha NVDA")}                       deep research (≈3-5 min): live snapshot → 4 research desks
                                   in parallel → bull vs bear → portfolio-manager decision
  ${c.cyan('alpha AAPL "is it a buy now?"')}    add a question; the decision answers it
  ${c.cyan("alpha 0700.HK --fast")}             fast read (≈1-2 min): one research pass → decision
  ${c.cyan("alpha")}                            interactive

  after a report: type follow-up questions, /report for the full report, Enter to quit
  ${c.cyan("alpha ask [run|SYMBOL] <question>")} follow-up on a saved report
  ${c.cyan("alpha runs")} · ${c.cyan("alpha show [run|SYMBOL]")} (--raw)
  ${c.cyan("alpha quote|snapshot|news|filings|options|lenses NVDA")} · ${c.cyan("alpha macro")}   no model calls
  ${c.cyan("alpha doctor")} (--live)

options
  --fast                 fast read instead of deep research
  --lang <code>          report language (default: the language you type in, else $LANG)
  --engine api|claude    api = ANTHROPIC_API_KEY (fastest); claude = your Claude Code sign-in
                         (default: api when a key is set, else claude)
  --model <m>            model for every step; or --research-model / --debate-model / --decision-model
  --fresh                ignore a report from the last 6 hours
  --json                 print the finished run as JSON (no live view)
  --plain                line-by-line progress instead of the live view

Saved to ${runsDir()}`;

function parseArgs(argv) {
  const out = { _: [] };
  const flags = new Set(["fast", "fresh", "json", "plain", "raw", "live", "help", "version", "deep"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h") out.help = true;
    else if (a === "-v") out.version = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      out[k] = flags.has(k) ? true : v ?? argv[++i];
    } else out._.push(a);
  }
  return out;
}

function modelsFrom(args) {
  const m = {};
  if (args.model) Object.assign(m, { research: args.model, debate: args.model, decision: args.model, chat: args.model });
  for (const k of ["research", "debate", "decision"]) if (args[`${k}-model`]) m[k] = args[`${k}-model`];
  return m;
}

const TICKER = /^\^?[A-Za-z0-9]{1,6}(?:[.-][A-Za-z0-9]{1,4})?$/;

/** Split free text into a symbol and the user's question. */
export async function resolveTarget(words, { search = data.searchSymbol } = {}) {
  const text = words.join(" ").trim();
  const tokens = text.split(/[\s,，。？?！!]+/).filter(Boolean);
  const ascii = tokens.filter((tk) => TICKER.test(tk) && /[A-Za-z]|[.^]/.test(tk));
  const pick = ascii.find((tk) => tk === tk.toUpperCase() && /[A-Z]/.test(tk)) || ascii.find((tk) => /[.^]/.test(tk)) || (ascii.length === 1 && tokens.length <= 6 ? ascii[0] : null);
  if (pick) return { symbol: data.normalizeSymbol(pick), question: text.replace(pick, "").trim() };
  const found = await search(text).catch(() => null) || (tokens[0] ? await search(tokens[0]).catch(() => null) : null);
  return found ? { symbol: found.symbol, question: text } : null;
}

function ageText(ms, language) {
  const m = Math.round(ms / 60000);
  const zh = language === "zh-CN";
  if (m < 60) return zh ? `${m} 分钟` : `${m} min`;
  return zh ? `${Math.round(m / 60)} 小时` : `${Math.round(m / 60)} h`;
}

async function streamAnswer(runId, question, backend) {
  let started = false;
  const r = await ask({
    runId,
    question,
    backend,
    onActivity: (text) => {
      if (!started) process.stdout.write(c.gray(`  · ${text}\n`));
    },
    onText: (delta) => {
      started = true;
      process.stdout.write(delta);
    },
  });
  if (!started) process.stdout.write(r.text);
  process.stdout.write("\n");
}

async function followUps(run, backendPromise) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const U = ui(run.language);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const q = (await rl.question(`\n${c.gray(U.follow)}\n${c.cyan("›")} `)).trim();
      if (!q) return;
      if (q === "/report") {
        page(renderMarkdown(readFileSync(reportPath(run.run_id), "utf8")));
        continue;
      }
      try {
        await streamAnswer(run.run_id, q, await backendPromise());
      } catch (error) {
        process.stdout.write(c.red(`${error.message}\n`));
      }
    }
  } finally {
    rl.close();
  }
}

async function cmdResearch(args, words) {
  let target = words.length ? await resolveTarget(words) : null;
  let language = args.lang ? normalizeLanguage(args.lang) : null;
  if (!target) {
    if (words.length || !process.stdin.isTTY) throw new Error(ui(language || detectLanguage(words.join(" "))).noTicker);
    const U0 = ui(language || detectLanguage());
    process.stdout.write(`${c.bold(c.cyan("◆ AlphaCouncil"))} ${c.gray(VERSION)}\n${c.gray(U0.hint)}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`${c.bold(U0.prompt)} ${c.cyan("›")} `)).trim();
    rl.close();
    if (!answer) return;
    target = await resolveTarget([answer]);
    if (!target) throw new Error(U0.noTicker);
  }
  language ||= detectLanguage(target.question || words.join(" "));
  const mode = args.fast ? "fast" : "deep";
  const U = ui(language);
  let backend = null;
  const getBackend = async () => (backend ||= await selectBackend({ engine: args.engine, models: modelsFrom(args) }));

  const recent = !args.fresh && !target.question ? recentRun({ symbol: target.symbol, mode, language }) : null;
  if (recent) {
    const run = loadRun(recent.run_id);
    if (args.json) return void process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    process.stdout.write(`${c.gray(U.reused.replace("{age}", ageText(Date.now() - Date.parse(run.created_at), language)))}\n`);
    process.stdout.write(`${summaryCard(run, { reportFile: reportPath(run.run_id) })}\n`);
    return followUps(run, getBackend);
  }

  await getBackend();
  const quiet = Boolean(args.json);
  const tty = process.stdout.isTTY && !args.plain;
  if (!quiet) process.stdout.write(`${c.bold(c.cyan("◆ AlphaCouncil"))} ${c.gray(`${mode === "fast" ? U.fast : U.deep} · ${U.engine} ${backend.name} (${backend.models.research}/${backend.models.decision}) · ${language}`)}\n`);
  const live = quiet ? { event() {}, stop() {} } : createLive({ language, mode, tty });
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    controller.abort(new Error("stopped by user"));
  };
  process.on("SIGINT", onSigint);
  let run;
  try {
    run = await research({ symbol: target.symbol, mode, language, question: target.question, backend, signal: controller.signal, onEvent: (e) => live.event(e) });
  } finally {
    live.stop();
    process.off("SIGINT", onSigint);
  }
  if (quiet) return void process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  process.stdout.write(`\n${summaryCard(run, { reportFile: reportPath(run.run_id) })}\n`);
  if (run.decision) await followUps(run, getBackend);
  if (run.state === "incomplete") process.exitCode = 2;
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
  if (!question) throw new Error("usage: alpha ask [run|SYMBOL] <question>");
  const backend = await selectBackend({ engine: args.engine, models: modelsFrom(args) });
  await streamAnswer(runId, question, backend);
}

function cmdRuns() {
  const runs = listRuns();
  if (!runs.length) return void process.stdout.write(`no saved research yet — try ${c.cyan("alpha NVDA")}\n`);
  for (const r of runs.slice(0, 30)) {
    const col = r.state === "complete" ? c.green : r.state === "degraded" ? c.yellow : r.state === "running" ? c.cyan : c.red;
    process.stdout.write(`${c.gray(r.created_at.slice(0, 16).replace("T", " "))}  ${c.bold(r.symbol.padEnd(9))} ${r.mode.padEnd(5)} ${col(r.state.padEnd(10))} ${(r.rating || "").padEnd(11)} ${c.gray(truncate(r.name || "", 24))}  ${c.gray(r.run_id)}\n`);
  }
}

function cmdShow(args) {
  const runId = resolveRun(args._[0]);
  const md = readFileSync(reportPath(runId), "utf8");
  if (args.raw) process.stdout.write(md);
  else page(renderMarkdown(md));
}

const n = (x) => (x === null || x === undefined ? c.gray("n/a") : String(x));

async function cmdData(cmd, args) {
  if (cmd === "macro") {
    const m = await data.getMacro();
    for (const [id, s] of Object.entries(m.series)) process.stdout.write(`  ${c.bold(id.padEnd(14))} ${String(n(s.value)).padStart(9)}  ${c.gray(`${s.label}${s.date ? ` · ${s.date}` : ""}${s.change_12m !== undefined && s.change_12m !== null ? ` · 12m Δ ${s.change_12m}` : ""}${s.yoy_pct ? ` · YoY ${s.yoy_pct}%` : ""}`)}\n`);
    if (m.gaps.length) process.stdout.write(c.yellow(`gaps: ${m.gaps.join("; ")}\n`));
    return;
  }
  const target = await resolveTarget(args._);
  if (!target) throw new Error(`usage: alpha ${cmd} <TICKER>`);
  const symbol = target.symbol;
  if (cmd === "snapshot") {
    process.stdout.write(`${snapshotCard(await buildSnapshot(symbol), args.lang ? normalizeLanguage(args.lang) : detectLanguage())}\n`);
  } else if (cmd === "quote") {
    const q = await data.getQuote(symbol);
    process.stdout.write(`${c.bold(symbol)} ${c.bold(`${q.price} ${q.currency}`)} ${q.change_pct >= 0 ? c.green(`+${q.change_pct}%`) : c.red(`${q.change_pct}%`)}  ${c.gray(`52w ${q.low_52w}–${q.high_52w} · div ${n(q.dividend_yield_pct)}% · ${q.exchange} · ${q.market_time} (delayed)`)}\n`);
  } else if (cmd === "news") {
    const inst = await data.resolveInstrument(symbol).catch(() => ({}));
    const r = await data.getNews(inst.name ? `"${inst.name}" OR ${symbol}` : symbol, { days: Number(args.days) || 30 });
    for (const i of r.items) process.stdout.write(`  ${c.gray(i.date)}  ${i.title}${i.publisher ? c.gray(` — ${i.publisher}`) : ""}\n`);
    if (!r.items.length) process.stdout.write(c.yellow("  no dated headlines in the window\n"));
  } else if (cmd === "filings") {
    const r = await data.getFilings(symbol, { limit: Number(args.limit) || 20 });
    if (!r.available) process.stdout.write(c.yellow(`${r.reason}\n`));
    else for (const f of r.filings) process.stdout.write(`  ${c.gray(f.filed)}  ${c.bold(f.form.padEnd(8))} ${truncate(f.description || "", 40)}  ${c.gray(f.url)}\n`);
  } else if (cmd === "options") {
    const o = await data.getOptions(symbol);
    if (!o.available) return void process.stdout.write(c.yellow(`${o.reason}\n`));
    process.stdout.write(`${c.bold(symbol)} spot ${o.spot} · put/call OI ${o.put_call_oi_ratio} · volume ${o.put_call_volume_ratio}\n`);
    for (const x of o.term_structure) process.stdout.write(`  ${x.expiry} ${String(x.days).padStart(4)}d  ATM IV ${String(x.atm_iv_pct).padStart(5)}%  ${x.skew_25d_pct !== null ? c.gray(`25Δ skew ${x.skew_25d_pct}`) : ""}\n`);
  } else if (cmd === "lenses") {
    const s = await buildSnapshot(symbol, { news: false, options: false });
    for (const l of s.lenses) {
      const col = l.stance === "supportive" ? c.green : l.stance === "opposed" ? c.red : l.stance === "neutral" ? c.yellow : c.gray;
      process.stdout.write(`  ${col(l.stance.padEnd(12))} ${c.bold(l.name)}\n  ${" ".repeat(12)} ${c.gray(l.checks.map((x) => `${x.label} ${x.display}${x.pass === null ? "" : x.pass ? " ✓" : " ✗"}`).join(" · ") || l.rationale)}\n`);
    }
    if (s.gaps.length) process.stdout.write(c.yellow(`gaps: ${s.gaps.join("; ")}\n`));
  }
}

async function cmdDoctor(args) {
  const ok = (m) => process.stdout.write(`  ${c.green("✓")} ${m}\n`);
  const bad = (m) => process.stdout.write(`  ${c.red("✗")} ${m}\n`);
  const info = (m) => process.stdout.write(`  ${c.gray("·")} ${m}\n`);
  const major = Number(process.versions.node.split(".")[0]);
  (major >= 20 ? ok : bad)(`Node ${process.versions.node} (needs 20+)`);
  const key = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  (key ? ok : info)(`API engine: ${key ? "ANTHROPIC_API_KEY set" : "no ANTHROPIC_API_KEY (optional; fastest engine)"}`);
  const cli = hasClaudeCli();
  (cli ? ok : info)(`Claude Code engine: ${cli || "claude not found (optional)"}`);
  if (!key && !cli) bad("no engine available: set ANTHROPIC_API_KEY or install Claude Code");
  const probes = [
    ["Yahoo Finance (quotes, history, search)", () => data.getQuote("AAPL")],
    ["SEC EDGAR (fundamentals, filings)", () => data.lookupCik("AAPL")],
    ["Google News", () => data.getNews("Apple", { days: 7, limit: 1 })],
    ["Cboe options", () => data.getOptions("AAPL")],
    ["FRED macro", () => data.getMacro().then((m) => (Object.keys(m.series).length ? m : Promise.reject(new Error(m.gaps[0]))))],
  ];
  for (const [name, fn] of probes) {
    try {
      await fn();
      ok(name);
    } catch (error) {
      bad(`${name}: ${error.message}`);
    }
  }
  if (args.live && (key || cli)) {
    try {
      const backend = await selectBackend({ engine: args.engine });
      const t0 = Date.now();
      const r = await backend.call({ tier: "chat", system: "Reply tersely.", user: "Reply with the single word: ready", timeoutMs: 90_000 });
      (/ready/i.test(r.text) ? ok : bad)(`live ${backend.name} call: ${r.text.trim().slice(0, 40)} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (error) {
      bad(`live call: ${error.message}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.version) return void process.stdout.write(`${VERSION}\n`);
  if (args.help) return void process.stdout.write(`${HELP}\n`);
  const [cmd, ...rest] = args._;
  const sub = { ...args, _: rest };
  switch (cmd) {
    case "help": return void process.stdout.write(`${HELP}\n`);
    case "runs": return cmdRuns();
    case "show": return cmdShow(sub);
    case "ask": return cmdAsk(sub);
    case "doctor": return cmdDoctor(sub);
    case "quote": case "snapshot": case "news": case "filings": case "options": case "lenses": case "macro":
      return cmdData(cmd, sub);
    default:
      return cmdResearch(args, args._);
  }
}
