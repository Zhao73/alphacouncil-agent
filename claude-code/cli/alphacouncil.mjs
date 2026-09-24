#!/usr/bin/env node
// AlphaCouncil terminal client. Same council, agents and state machine as the Claude Code
// plugin; each seat runs as a headless `claude -p` worker that this process supervises.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { councilStatus, gatherGrounding, planCouncil, startCouncil } from "../lib/council.mjs";
import * as data from "../lib/data.mjs";
import { evaluateLenses, LENS_IDS, LENSES, lensName } from "../lib/lenses.mjs";
import { PACES, VERSION } from "../lib/spec.mjs";
import { listRuns, resolveRunId, runDir, runsDir } from "../lib/store.mjs";
import { startDashboard } from "./dashboard.mjs";
import { createView, DEFAULT_MODELS, runCouncil } from "./orchestrate.mjs";
import { c, page, renderMarkdown, truncate } from "./term.mjs";
import { claudeBin } from "./worker.mjs";

const HELP = `${c.bold("alphacouncil")} ${VERSION} — equity research council in your terminal

${c.bold("Research")}
  alphacouncil                       interactive: ticker → mode → pace → lenses → confirm
  alphacouncil <TICKER> [options]    full council (8 analysts, lenses, 3 Bull/Bear rounds, PM)
    --quick                          quick council (4 analysts, 1 round, ≤10 min)
    --pace fast|normal|slow          full-mode depth: 15 / 30 / 60 minute ceiling (default normal)
    --lang <code>                    report language, e.g. en, zh-CN, ja (default from $LANG)
    --lenses <ids|all>               comma-separated lens IDs (default all)
    --question "<text>"              your research question
    --model <m>                      model for every seat (aliases: sonnet, opus, haiku)
    --evidence-model/--debate-model/--pm-model <m>   per stage (default sonnet/sonnet/opus)
    --concurrency <n>                parallel workers (default 8)
    --worker-budget-usd <n>          spend cap per worker (API-key billing only)
    --yes                            skip the confirmation
    --plain                          no full-screen dashboard
  alphacouncil resume <run|latest>   continue an unfinished run (from the terminal or Claude Code)

${c.bold("Runs")}
  alphacouncil runs                  list saved runs
  alphacouncil show <run|latest>     read the report (--raw markdown, --transcript all packets)
  alphacouncil status <run|latest>   seat-by-seat state

${c.bold("Data (keyless, no model calls)")}
  alphacouncil quote|news|filings|options|lenses <TICKER>
  alphacouncil macro
  alphacouncil doctor [--live]       check Claude Code, data sources and storage

Runs are saved in ${runsDir()}`;

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const [k, inline] = a.slice(2).split("=", 2);
    const bool = ["quick", "yes", "plain", "raw", "transcript", "live", "help", "version"].includes(k);
    out[k] = bool ? true : inline ?? argv[++i];
  }
  return out;
}

function defaultLanguage() {
  const env = `${process.env.LC_ALL || ""} ${process.env.LANG || ""}`;
  if (/zh/i.test(env)) return "zh-CN";
  if (/\bja/i.test(env)) return "ja";
  return "en";
}

function modelsFrom(args) {
  return {
    evidence: args["evidence-model"] || args.model || process.env.ALPHACOUNCIL_EVIDENCE_MODEL || DEFAULT_MODELS.evidence,
    debate: args["debate-model"] || args.model || process.env.ALPHACOUNCIL_DEBATE_MODEL || DEFAULT_MODELS.debate,
    pm: args["pm-model"] || args.model || process.env.ALPHACOUNCIL_PM_MODEL || DEFAULT_MODELS.pm,
  };
}

// ---------------------------------------------------------------- wizard

async function ask(rl, q, fallback = "") {
  const a = (await rl.question(q)).trim();
  return a || fallback;
}

async function choose(rl, title, options, def = 0) {
  process.stdout.write(`\n${c.bold(title)}\n`);
  options.forEach((o, i) => process.stdout.write(`  ${c.cyan(String(i + 1))}. ${o.label}${i === def ? c.gray("  (default)") : ""}\n`));
  for (;;) {
    const a = await ask(rl, c.gray("› "), String(def + 1));
    const n = Number(a);
    if (n >= 1 && n <= options.length) return options[n - 1].value;
    process.stdout.write(c.yellow(`  enter 1-${options.length}\n`));
  }
}

async function pickLenses(rl, language) {
  const selected = new Set(LENS_IDS);
  for (;;) {
    process.stdout.write(`\n${c.bold("Method lenses")} ${c.gray("(deterministic screens, no model calls)")}\n`);
    LENSES.forEach((l, i) => process.stdout.write(`  ${selected.has(l.id) ? c.green("[x]") : "[ ]"} ${c.cyan(String(i + 1))}. ${lensName(l, language)} ${c.gray(`— ${l.question}`)}\n`));
    const a = await ask(rl, c.gray("toggle numbers (e.g. 1 3-4), a = all, n = none, Enter = done › "));
    if (!a) {
      if (selected.size) return [...selected];
      process.stdout.write(c.yellow("  select at least one lens\n"));
      continue;
    }
    if (a === "a") LENS_IDS.forEach((id) => selected.add(id));
    else if (a === "n") selected.clear();
    else {
      for (const part of a.split(/[\s,]+/)) {
        const [x, y] = part.split("-").map(Number);
        for (let i = x; i <= (y || x); i += 1) {
          const id = LENS_IDS[i - 1];
          if (id) (selected.has(id) ? selected.delete(id) : selected.add(id));
        }
      }
    }
  }
}

async function wizard() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`${c.bold(c.cyan("◆ AlphaCouncil"))} ${c.gray(VERSION)} — research council for stocks, ETFs and indices\n`);
    let symbol;
    for (;;) {
      try {
        symbol = data.normalizeSymbol(await ask(rl, `\n${c.bold("Ticker")} ${c.gray("(e.g. AAPL, 0700.HK, 7203.T, SPY)")} › `));
        break;
      } catch (error) {
        process.stdout.write(c.yellow(`  ${error.message}\n`));
      }
    }
    const question = await ask(rl, `${c.bold("Question")} ${c.gray("(optional, Enter to skip)")} › `);
    const mode = await choose(rl, "Mode", [
      { label: `Full council ${c.gray("— 8 analysts, 3 Bull/Bear rounds, PM")}`, value: "full" },
      { label: `Quick council ${c.gray("— 4 analysts, 1 round, ≤10 min")}`, value: "quick" },
    ]);
    const pace = mode === "full"
      ? await choose(rl, "Depth", Object.entries(PACES).map(([k, p]) => ({ label: `${k} ${c.gray(`— ${p.total_ms / 60e3} min ceiling`)}`, value: k })), 1)
      : null;
    const lang = await ask(rl, `\n${c.bold("Language")} ${c.gray(`(en, zh-CN, ja, … default ${defaultLanguage()})`)} › `, defaultLanguage());
    const lenses = await pickLenses(rl, lang);
    return { symbol, question, mode, pace: pace || "normal", lang, lenses, rl };
  } catch (error) {
    rl.close();
    throw error;
  }
}

function printPlan(plan, models) {
  process.stdout.write(`\n${c.bold("Plan")}\n`);
  process.stdout.write(`  ${plan.symbol} · ${plan.mode}${plan.pace ? ` · ${plan.pace}` : ""} · ${plan.language}\n`);
  for (const s of plan.stages) process.stdout.write(`  • ${s}\n`);
  process.stdout.write(`  ${c.gray(`${plan.model_calls} model workers · models ${models.evidence}/${models.debate}/${models.pm} · hard ceiling ${plan.ceiling_minutes} min`)}\n`);
  process.stdout.write(`  ${c.gray(`lenses: ${plan.lenses.join(", ")}`)}\n`);
}

// ---------------------------------------------------------------- run

async function runWithDashboard(runId, args) {
  const view = createView(runId);
  const dash = startDashboard({ interactive: process.stdout.isTTY && !args.plain });
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts > 1) {
      dash.stop();
      process.exit(130);
    }
    controller.abort();
  };
  process.on("SIGINT", onSigint);
  let fin;
  try {
    fin = await runCouncil(runId, {
      models: modelsFrom(args),
      concurrency: Number(args.concurrency) || 8,
      budgetUsd: args["worker-budget-usd"] ? Number(args["worker-budget-usd"]) : null,
      signal: controller.signal,
      view,
      onUpdate: (v) => dash.update(v),
    });
  } finally {
    dash.stop();
    process.off("SIGINT", onSigint);
  }
  const color = fin.state === "complete" ? c.green : fin.state === "degraded" ? c.yellow : c.red;
  process.stdout.write(`\n${color(c.bold(`● ${fin.state.toUpperCase()}`))}${view.costUsd ? c.gray(`  · model spend $${view.costUsd.toFixed(2)}`) : ""}\n`);
  process.stdout.write(`${renderMarkdown(fin.handoff_markdown)}\n`);
  return fin;
}

async function cmdResearch(args) {
  let symbol = args._[0];
  let rl = null;
  let opts = { mode: args.quick ? "quick" : "full", pace: args.pace || "normal", lang: args.lang || defaultLanguage(), lenses: args.lenses || "all", question: args.question || "" };
  if (!symbol) {
    const w = await wizard();
    rl = w.rl;
    symbol = w.symbol;
    opts = { mode: w.mode, pace: w.pace, lang: w.lang, lenses: w.lenses, question: w.question };
  }
  const plan = planCouncil({ symbol, mode: opts.mode, pace: opts.pace, language: opts.lang, lenses: opts.lenses });
  const models = modelsFrom(args);
  printPlan(plan, models);
  if (!args.yes) {
    if (!process.stdin.isTTY) throw new Error("confirmation needed: rerun with --yes to start without a terminal prompt");
    rl ||= createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(`\n${c.bold("Start?")} [Y/n] `)).trim().toLowerCase();
    if (a && !a.startsWith("y")) {
      rl.close();
      process.stdout.write("cancelled\n");
      return;
    }
  }
  rl?.close();
  checkClaude();
  process.stdout.write(c.gray("\nFreezing price, fundamentals and lenses…\n"));
  const { run, grounding } = await startCouncil({ symbol: plan.symbol, mode: plan.mode, pace: opts.pace, language: plan.language, lenses: plan.lenses, question: opts.question, executor: "terminal", enforceDeadline: true });
  if (grounding.gaps.length) process.stdout.write(c.yellow(`grounding gaps: ${grounding.gaps.join("; ")}\n`));
  process.stdout.write(c.gray(`run ${run.run_id}\n`));
  const fin = await runWithDashboard(run.run_id, args);
  await offerReport(fin);
}

async function offerReport(fin) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`\n${c.bold("Open the full report?")} [Y/n] `)).trim().toLowerCase();
  rl.close();
  if (!a || a.startsWith("y")) page(renderMarkdown(readFileSync(fin.files.report, "utf8")));
}

function checkClaude() {
  const bin = claudeBin();
  const r = /\.(c|m)?js$/.test(bin) ? spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" }) : spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) throw new Error(`Claude Code CLI not found (\`${claudeBin()}\`). Install it (npm i -g @anthropic-ai/claude-code) and sign in, or set ANTHROPIC_API_KEY.`);
  return r.stdout.trim();
}

async function cmdResume(args) {
  const runId = resolveRunId(args._[0]);
  const st = councilStatus(runId);
  if (st.state !== "running") {
    process.stdout.write(`run ${runId} is already ${st.state}\n`);
    return;
  }
  checkClaude();
  const fin = await runWithDashboard(runId, args);
  await offerReport(fin);
}

// ---------------------------------------------------------------- runs

function cmdRuns() {
  const runs = listRuns();
  if (!runs.length) {
    process.stdout.write(`no runs yet — try ${c.cyan("alphacouncil AAPL")}\n`);
    return;
  }
  for (const r of runs.slice(0, 40)) {
    const color = r.status === "complete" ? c.green : r.status === "running" ? c.cyan : r.status === "degraded" ? c.yellow : c.red;
    process.stdout.write(`${c.gray(r.created_at.slice(0, 16).replace("T", " "))}  ${c.bold(r.symbol.padEnd(9))} ${r.mode.padEnd(6)} ${color(r.status.padEnd(10))} ${(r.rating || "").padEnd(11)} ${c.gray(r.run_id)}\n`);
  }
}

function cmdShow(args) {
  const runId = resolveRunId(args._[0]);
  const file = join(runDir(runId), args.transcript ? "transcript.md" : "final_report.md");
  if (!existsSync(file)) {
    process.stdout.write(`${runId} has no report yet (state: ${councilStatus(runId).state}). Use ${c.cyan(`alphacouncil resume ${runId}`)}.\n`);
    return;
  }
  const md = readFileSync(file, "utf8");
  if (args.raw) process.stdout.write(md);
  else page(renderMarkdown(md));
}

function cmdStatus(args) {
  const st = councilStatus(resolveRunId(args._[0]));
  process.stdout.write(`${c.bold(st.symbol)} ${st.mode} · ${st.state}${st.rating ? ` · ${st.rating}` : ""} · ${c.gray(st.dir)}\n`);
  for (const s of st.slots) {
    const icon = s.status === "done" ? c.green("✓") : s.status === "failed" ? c.red("✗") : s.status === "issued" ? c.cyan("…") : c.gray("·");
    process.stdout.write(`  ${icon} ${s.slot.padEnd(34)} ${c.gray(`attempts ${s.attempts}`)}${s.last_error ? c.yellow(`  ${truncate(s.last_error, 70)}`) : ""}\n`);
  }
}

// ---------------------------------------------------------------- data commands

const n = (x, d = 2) => (x === null || x === undefined ? c.gray("n/a") : typeof x === "number" ? (Math.abs(x) >= 1e9 ? `${(x / 1e9).toFixed(1)}B` : String(Math.round(x * 10 ** d) / 10 ** d)) : String(x));

async function cmdData(cmd, args) {
  if (cmd === "macro") {
    const m = await data.getMacro();
    for (const [id, s] of Object.entries(m.series)) process.stdout.write(`  ${c.bold(id.padEnd(14))} ${String(n(s.value, 3)).padStart(9)}  ${c.gray(`${s.label}${s.date ? ` · ${s.date}` : ""}${s.change_12m !== undefined && s.change_12m !== null ? ` · 12m Δ ${n(s.change_12m, 2)}` : ""}${s.yoy_pct ? ` · YoY ${s.yoy_pct}%` : ""}`)}\n`);
    if (m.gaps.length) process.stdout.write(c.yellow(`gaps: ${m.gaps.join("; ")}\n`));
    return;
  }
  const symbol = data.normalizeSymbol(args._[0] || "");
  if (cmd === "quote") {
    const q = await data.getQuote(symbol);
    const chg = q.change_pct >= 0 ? c.green(`+${q.change_pct}%`) : c.red(`${q.change_pct}%`);
    process.stdout.write(`${c.bold(symbol)} ${c.bold(`${q.price} ${q.currency}`)} ${chg}  ${c.gray(`52w ${q.low_52w}–${q.high_52w} · div ${n(q.dividend_yield_pct)}% · ${q.exchange} · ${q.market_time} (delayed)`)}\n`);
  } else if (cmd === "news") {
    const inst = await data.resolveInstrument(symbol).catch(() => ({}));
    const r = await data.getNews(`${inst.name || ""} ${symbol}`.trim(), { days: Number(args.days) || 30 });
    for (const i of r.items) process.stdout.write(`  ${c.gray(i.date)}  ${i.title}${i.publisher ? c.gray(` — ${i.publisher}`) : ""}\n`);
    if (!r.items.length) process.stdout.write(c.yellow("  no dated headlines in the window\n"));
  } else if (cmd === "filings") {
    const r = await data.getFilings(symbol, { limit: Number(args.limit) || 20 });
    if (!r.available) process.stdout.write(c.yellow(`${r.reason}\n`));
    else for (const f of r.filings) process.stdout.write(`  ${c.gray(f.filed)}  ${c.bold(f.form.padEnd(8))} ${truncate(f.description || "", 40)}  ${c.gray(f.url)}\n`);
  } else if (cmd === "options") {
    const o = await data.getOptions(symbol);
    if (!o.available) {
      process.stdout.write(c.yellow(`${o.reason}\n`));
      return;
    }
    process.stdout.write(`${c.bold(symbol)} spot ${o.spot} · put/call OI ${o.put_call_oi_ratio} · volume ${o.put_call_volume_ratio}\n`);
    for (const t of o.term_structure) process.stdout.write(`  ${t.expiry} ${String(t.days).padStart(4)}d  ATM IV ${String(t.atm_iv_pct).padStart(5)}%  ${t.skew_25d_pct !== null ? c.gray(`25Δ skew ${t.skew_25d_pct}`) : ""}\n`);
  } else if (cmd === "lenses") {
    const lang = args.lang || defaultLanguage();
    const g = await gatherGrounding(symbol, { deep: false });
    for (const l of evaluateLenses(g, LENS_IDS, lang)) {
      const color = l.stance === "supportive" ? c.green : l.stance === "opposed" ? c.red : l.stance === "neutral" ? c.yellow : c.gray;
      process.stdout.write(`  ${color(l.stance.padEnd(12))} ${c.bold(l.name)}\n`);
      process.stdout.write(`  ${" ".repeat(12)} ${c.gray(l.checks.length ? l.checks.map((x) => `${x.label} ${x.display}${x.pass === null ? "" : x.pass ? " ✓" : " ✗"}`).join(" · ") : l.rationale)}\n`);
    }
    if (g.gaps.length) process.stdout.write(c.yellow(`gaps: ${g.gaps.join("; ")}\n`));
  }
}

// ---------------------------------------------------------------- doctor

async function cmdDoctor(args) {
  const ok = (m) => process.stdout.write(`  ${c.green("✓")} ${m}\n`);
  const bad = (m) => process.stdout.write(`  ${c.red("✗")} ${m}\n`);
  const [major] = process.versions.node.split(".").map(Number);
  (major >= 18 ? ok : bad)(`Node ${process.versions.node} (needs ≥ 18)`);
  try {
    ok(`Claude Code ${checkClaude()}`);
  } catch (error) {
    bad(error.message);
  }
  try {
    const { mkdirSync, accessSync, constants } = await import("node:fs");
    mkdirSync(runsDir(), { recursive: true });
    accessSync(runsDir(), constants.W_OK);
    ok(`run storage ${runsDir()}`);
  } catch (error) {
    bad(`run storage: ${error.message}`);
  }
  const probes = [
    ["Yahoo Finance (quotes, history)", () => data.getQuote("AAPL")],
    ["SEC EDGAR (fundamentals, filings)", () => data.lookupCik("AAPL")],
    ["Google News RSS", () => data.getNews("Apple", { days: 7, limit: 1 })],
    ["Cboe delayed options", () => data.getOptions("AAPL")],
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
  if (args.live) {
    const r = spawnSync(claudeBin(), ["-p", "Reply with the single word: ready", "--max-turns", "1", "--no-session-persistence"], { encoding: "utf8", timeout: 120000 });
    (/ready/i.test(r.stdout || "") ? ok : bad)(`live model call: ${(r.stdout || r.stderr || String(r.error || "")).trim().slice(0, 80)}`);
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) return void process.stdout.write(`${VERSION}\n`);
  const [cmd] = args._;
  if (args.help || cmd === "help") return void process.stdout.write(`${HELP}\n`);
  if (!cmd && !process.stdin.isTTY) return void process.stdout.write(`${HELP}\n`);
  const rest = { ...args, _: args._.slice(1) };
  switch (cmd) {
    case "runs": return cmdRuns();
    case "show": return cmdShow(rest);
    case "status": return cmdStatus(rest);
    case "resume": return cmdResume(rest);
    case "doctor": return cmdDoctor(rest);
    case "quote": case "news": case "filings": case "options": case "lenses": case "macro":
      return cmdData(cmd, rest);
    case "run": return cmdResearch(rest);
    default: return cmdResearch(args);
  }
}

main().catch((error) => {
  process.stdout.write("\x1b[?25h");
  process.stderr.write(`${c.red("error:")} ${error.message}\n`);
  process.exit(1);
});

