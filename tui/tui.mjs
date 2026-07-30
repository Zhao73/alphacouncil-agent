#!/usr/bin/env node
/**
 * AlphaCouncil terminal client -- watch a council deliberate, in the terminal.
 *
 * Live mode tails a running council; replay mode animates a finished run in
 * completion order. Either way, each speaking seat appears as a pixel avatar
 * with its statement typed into a speech bubble -- the reader watches the
 * committee argue instead of scrolling a markdown file.
 *
 * Zero dependencies, read-only: the MCP server owns the run directory.
 *   node tui/tui.mjs [run_id] [--replay] [--speed 1..9] [--demo N]
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { renderAvatar, displayName } from "./avatars.mjs";

const DATA_DIR = process.env.ALPHACOUNCIL_AGENT_DATA_DIR || join(homedir(), ".alphacouncil-agent");
const RUNS_DIR = join(DATA_DIR, "runs");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SPEED = Math.max(1, Math.min(9, Number(opt("speed", 3))));
const DEMO_FRAMES = Number(opt("demo", 0));
const runArg = args.find((a) => !a.startsWith("--") && a !== opt("speed", null) && a !== opt("demo", null));

/* ------------------------------------------------------------------ data -- */

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

function pickRun() {
  if (runArg) return runArg;
  const runs = readdirSync(RUNS_DIR)
    .filter((n) => !n.startsWith(".") && !n.startsWith("SELFTEST"))
    .filter((n) => existsSync(join(RUNS_DIR, n, "status.json")))
    .map((n) => ({ n, m: statSync(join(RUNS_DIR, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!runs.length) { console.error(`no runs under ${RUNS_DIR}`); process.exit(1); }
  return runs[0].n;
}

const RUN_ID = pickRun();
const RUN_DIR = join(RUNS_DIR, RUN_ID);
if (!existsSync(RUN_DIR)) { console.error(`no such run: ${RUN_ID}`); process.exit(1); }

const EVIDENCE_SHORT = {
  market_data: "market", earnings_deep_dive: "earnings", forward_expectations: "forward",
  quant_factor: "quant", valuation_long_short: "valuation", news_industry_management: "news",
  insider_sec: "insider", ib_event_analysis: "ib_event", macro_regime: "macro",
  market_narrative: "narrative", social_pulse: "social",
};

/** UI chrome only -- the statements themselves are run artifacts in the run's language. */
const L10N = {
  en: {
    replay: "replay", evidence: "evidence", bench: (d, t) => `bench ${d}/${t} spoke`,
    debate: { done: "verdict in", running: "debate running", idle: "debate pending" },
    waiting: "(waiting for a speaker…)", spoken: "── already spoke ──", full: "full text",
    keys: "q quit · space pause · → finish typing · n next speaker", speaking: "speaking",
    stances: { constructive: "BULLISH", cautious: "CAUTIOUS", opposed: "BEARISH", out_of_scope: "ABSTAIN", bull: "BULL", bear: "BEAR", pm: "VERDICT" },
    voice: { what_i_see: "What I see", how_my_method_reads_it: "My standard", would_i_act: "Would I act", what_changes_my_mind: "What changes my mind", where_i_disagree: "Where I disagree" },
    bullName: "Bull", bearName: "Bear",
    pm: { rating: "Final rating", conf: "confidence", position: "Position", invalidation: "Invalidation" },
    pick: "Language / 语言 / 言語 / 언어:",
  },
  zh: {
    replay: "重放", evidence: "证据席", bench: (d, t) => `方法席 ${d}/${t} 已发言`,
    debate: { done: "已裁决", running: "辩论进行中", idle: "辩论未开始" },
    waiting: "（等待发言…）", spoken: "── 已发言 ──", full: "全文",
    keys: "q 退出 · 空格 暂停 · → 跳过打字 · n 下一位", speaking: "发言中",
    stances: { constructive: "看多", cautious: "谨慎", opposed: "看空", out_of_scope: "弃权", bull: "多方", bear: "空方", pm: "决策" },
    voice: { what_i_see: "我看到的", how_my_method_reads_it: "用我的标准", would_i_act: "我会不会动手", what_changes_my_mind: "什么会让我改主意", where_i_disagree: "我的分歧" },
    bullName: "多方 Bull", bearName: "空方 Bear",
    pm: { rating: "最终评级", conf: "置信度", position: "仓位", invalidation: "失效条件" },
  },
  ja: {
    replay: "リプレイ", evidence: "証拠席", bench: (d, t) => `メソッド席 ${d}/${t} 発言済み`,
    debate: { done: "裁定済み", running: "討論進行中", idle: "討論未開始" },
    waiting: "（発言待ち…）", spoken: "── 発言済み ──", full: "全文",
    keys: "q 終了 · スペース 一時停止 · → 表示を完了 · n 次へ", speaking: "発言中",
    stances: { constructive: "強気", cautious: "慎重", opposed: "弱気", out_of_scope: "棄権", bull: "強気側", bear: "弱気側", pm: "裁定" },
    voice: { what_i_see: "私が見ているもの", how_my_method_reads_it: "私の基準では", would_i_act: "私なら動くか", what_changes_my_mind: "考えを変える条件", where_i_disagree: "意見の相違" },
    bullName: "Bull 強気", bearName: "Bear 弱気",
    pm: { rating: "最終評価", conf: "信頼度", position: "ポジション", invalidation: "無効化条件" },
  },
  ko: {
    replay: "리플레이", evidence: "증거석", bench: (d, t) => `방법석 ${d}/${t} 발언 완료`,
    debate: { done: "판정 완료", running: "토론 진행 중", idle: "토론 대기" },
    waiting: "(발언 대기 중…)", spoken: "── 발언 완료 ──", full: "전문",
    keys: "q 종료 · 스페이스 일시정지 · → 타이핑 건너뛰기 · n 다음", speaking: "발언 중",
    stances: { constructive: "강세", cautious: "신중", opposed: "약세", out_of_scope: "기권", bull: "강세측", bear: "약세측", pm: "판정" },
    voice: { what_i_see: "내가 보는 것", how_my_method_reads_it: "내 기준으로는", would_i_act: "나라면 움직이는가", what_changes_my_mind: "생각을 바꾸는 조건", where_i_disagree: "의견 차이" },
    bullName: "Bull 강세", bearName: "Bear 약세",
    pm: { rating: "최종 평가", conf: "신뢰도", position: "포지션", invalidation: "무효화 조건" },
  },
};
let T = L10N.en;

const STANCE_COLOR = {
  constructive: [53, 184, 145], cautious: [201, 162, 39], opposed: [212, 115, 106],
  out_of_scope: [128, 140, 135], bull: [53, 184, 145], bear: [212, 115, 106], pm: [201, 162, 39],
};
const styleFor = (stance) => ({ color: STANCE_COLOR[stance] || STANCE_COLOR.out_of_scope, label: T.stances[stance] || stance });

const asText = (v) => Array.isArray(v) ? v.filter(Boolean).join(" ") : typeof v === "string" ? v : "";

function speechText(m) {
  if (m.voice && typeof m.voice === "object") {
    return Object.entries(T.voice)
      .map(([k, l]) => (m.voice[k] ? `${l}: ${m.voice[k]}` : ""))
      .filter(Boolean).join("\n");
  }
  return m.voice_statement || m.summary || m.verdict || "";
}

/** Everything speakable in this run, ordered by when it actually completed. */
function collectSpeeches() {
  const speeches = [];
  const status = readJson(join(RUN_DIR, "status.json")) || {};
  const doneAt = new Map((status.agents || []).map((a) => [a.role, Date.parse(a.completed_at || a.updated_at || 0) || 0]));
  const when = (role, file) => doneAt.get(role) || (existsSync(file) ? statSync(file).mtimeMs : 0);

  for (const f of readdirSync(RUN_DIR)) {
    const match = f.match(/^(master_[a-z_]+)\.(json|md)$/);
    if (!match) continue;
    const id = match[1];
    if (speeches.some((s) => s.id === id)) continue;
    let stance = "out_of_scope", text = "";
    const m = readJson(join(RUN_DIR, `${id}.json`));
    if (m) { stance = m.stance || stance; text = speechText(m); }
    if (!text && existsSync(join(RUN_DIR, `${id}.md`))) {
      // A seat with no packet still has its markdown: the statement is the first
      // ### section, and the stance sits on the "- 立场/Stance: x" meta line.
      const md = readFileSync(join(RUN_DIR, `${id}.md`), "utf8");
      stance = md.match(/^- (?:立场|Stance|スタンス|입장): *(\w+)/mu)?.[1] || stance;
      const section = md.split(/^### .*$/mu)[1] || "";
      text = section.trim().replace(/\n{2,}/g, "\n");
    }
    speeches.push({
      id, name: displayName(id), stance, text,
      when: when(id, join(RUN_DIR, existsSync(join(RUN_DIR, `${id}.json`)) ? `${id}.json` : `${id}.md`)),
      file: `${id}.md`,
    });
  }
  for (const [role, key, stance] of [["bull_researcher", "long_thesis", "bull"], ["bear_researcher", "short_thesis", "bear"]]) {
    const p = join(RUN_DIR, `${role}.json`);
    const d = readJson(p);
    if (d) speeches.push({ id: role, name: stance === "bull" ? T.bullName : T.bearName, stance, text: asText(d[key]) || asText(d.long_thesis), when: when(role, p), file: `${role}.md` });
  }
  const pm = readJson(join(RUN_DIR, "decision.json"));
  if (pm) {
    const p = join(RUN_DIR, "decision.json");
    const parts = [
      pm.rating ? `${T.pm.rating}: ${pm.rating} (${T.pm.conf} ${pm.confidence || "?"})` : "",
      asText(pm.position) ? `${T.pm.position}: ${asText(pm.position)}` : "",
      asText(pm.invalidation) ? `${T.pm.invalidation}: ${asText(pm.invalidation)}` : "",
    ].filter(Boolean).join("\n");
    speeches.push({ id: "portfolio_manager", name: "Portfolio Manager", stance: "pm", text: parts, when: when("portfolio_manager", p) + 1, file: "portfolio_manager.md" });
  }
  return speeches.sort((a, b) => a.when - b.when).filter((s) => s.text);
}

/* ------------------------------------------------------------ rendering -- */

const rgb = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;
const DIM = "\x1b[38;2;128;140;135m";
const ACCENT = rgb([53, 184, 145]);
const GOLD = rgb([201, 162, 39]);
const RESET = "\x1b[0m";

const wide = (ch) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦　-〿]/.test(ch) ? 2 : 1;
const visWidth = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].reduce((a, c) => a + wide(c), 0);

function wrap(text, width) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "", w = 0;
    for (const ch of para) {
      const cw = wide(ch);
      if (w + cw > width) { out.push(line); line = ch === " " ? "" : ch; w = visWidth(line); continue; }
      line += ch; w += cw;
    }
    out.push(line);
  }
  return out;
}

function padTo(s, width) {
  const w = visWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

function statusDot(state) {
  if (state === "completed" || state === "complete") return `${ACCENT}●${RESET}`;
  if (state === "failed" || state === "timed_out") return `${rgb([212, 115, 106])}✗${RESET}`;
  if (!state || state === "pending" || state === "queued") return `${DIM}○${RESET}`;
  return `${GOLD}◐${RESET}`; // anything in flight
}

function frame(state) {
  const cols = Math.max(84, process.stdout.columns || 100);
  const status = state.status || {};
  const lines = [];
  const elapsedMs = status.completed_at && status.started_at
    ? Date.parse(status.completed_at) - Date.parse(status.started_at)
    : status.started_at ? Date.now() - Date.parse(status.started_at) : 0;
  const mm = String(Math.floor(elapsedMs / 60000)).padStart(2, "0");
  const ss = String(Math.floor(elapsedMs / 1000) % 60).padStart(2, "0");

  lines.push(`${ACCENT}▌ALPHACOUNCIL▐${RESET} ${status.symbol || RUN_ID}  ${DIM}${status.council_mode || "?"}${status.council_pace ? " · " + status.council_pace : ""} · ${status.status || "?"} · ${mm}:${ss}${state.mode === "replay" ? " · " + T.replay : ""}${RESET}`);

  const agents = status.agents || [];
  const evidence = agents.filter((a) => EVIDENCE_SHORT[a.role]);
  if (evidence.length) {
    lines.push(`${DIM}${T.evidence}${RESET} ` + evidence.map((a) => `${statusDot(a.status)}${DIM}${EVIDENCE_SHORT[a.role]}${RESET}`).join("  "));
  }
  const benchTotal = state.speeches.filter((s) => s.id.startsWith("master_")).length;
  const benchDone = Math.min(state.cursor + 1, benchTotal);
  const debate = agents.some((a) => a.role === "portfolio_manager" && a.status === "completed") ? T.debate.done
    : agents.some((a) => a.role === "bull_researcher") ? T.debate.running : T.debate.idle;
  lines.push(`${DIM}${T.bench(benchDone, benchTotal)} · ${debate}${RESET}`);
  lines.push("");

  const speech = state.speeches[state.cursor];
  if (speech) {
    const style = styleFor(speech.stance);
    const avatar = renderAvatar(speech.id);
    const avatarW = Math.max(...avatar.map(visWidth));
    const bubbleW = Math.max(30, Math.min(cols - avatarW - 8, 78));
    const shown = [...speech.text].slice(0, state.chars).join("");
    const body = wrap(shown, bubbleW - 4).slice(-Math.max(6, avatar.length - 2));
    const top = `╭${"─".repeat(bubbleW - 2)}╮`;
    const bottom = `╰${"─".repeat(bubbleW - 2)}╯`;
    const bubble = [top, ...body.map((l) => `│ ${padTo(l, bubbleW - 4)} │`), bottom];
    const header = `${rgb(style.color)}◉ ${speech.name}${RESET} ${rgb(style.color)}〔${style.label}〕${RESET}${state.chars >= speech.len ? `  ${DIM}(${T.full}: ${speech.file})${RESET}` : ""}`;
    lines.push(`  ${" ".repeat(avatarW + 2)}${header}`);
    // bubble is vertically centered against the tall portrait; the tail points at the face
    const rows = Math.max(avatar.length, bubble.length);
    const bubbleTopAt = Math.max(0, Math.floor((avatar.length - bubble.length) / 2));
    const tailRow = bubbleTopAt + 1;
    for (let i = 0; i < rows; i += 1) {
      const a = i < avatar.length ? avatar[i] : " ".repeat(avatarW);
      const b = i >= bubbleTopAt && i - bubbleTopAt < bubble.length ? bubble[i - bubbleTopAt] : "";
      const tail = i === tailRow && b ? `${DIM}─▷${RESET}` : "  ";
      lines.push(`  ${padTo(a, avatarW)}${tail}${b}`);
    }
  } else {
    lines.push(`${DIM}  ${T.waiting}${RESET}`);
  }

  lines.push("");
  const recent = state.speeches.slice(Math.max(0, state.cursor - 4), state.cursor).reverse();
  if (recent.length) {
    lines.push(`${DIM}${T.spoken}${RESET}`);
    for (const s of recent) {
      const st = styleFor(s.stance);
      const first = [...s.text.replace(/\n/g, " ")].slice(0, 46).join("");
      lines.push(` ${rgb(st.color)}▪${RESET} ${padTo(s.name, 20)} ${rgb(st.color)}${st.label}${RESET}  ${DIM}${first}…${RESET}`);
    }
  }
  lines.push("");
  lines.push(`${DIM} ${T.keys}${RESET}`);
  return lines.map((l) => padTo(l, cols)).join("\n");
}

/* ----------------------------------------------------------------- loop -- */

// Language is chosen before anything is collected: bull/bear display names and the
// five voice-field labels bake into the speech texts. Statements themselves stay in
// the run's own language -- they are recorded artifacts, not UI copy.
async function pickLang() {
  const cli = String(opt("lang", "")).toLowerCase();
  if (L10N[cli]) return cli;
  if (!process.stdin.isTTY || DEMO_FRAMES > 0) return "en";
  process.stdout.write(`\n  ${L10N.en.pick}\n  1) English (default)   2) 中文   3) 日本語   4) 한국어\n  > `);
  process.stdin.setRawMode(true);
  const key = await new Promise((resolve) => process.stdin.once("data", (b) => resolve(b.toString())));
  process.stdin.setRawMode(false);
  if (key === "\x03") process.exit(0);
  return { 1: "en", 2: "zh", 3: "ja", 4: "ko" }[key.trim()] || "en";
}
T = L10N[await pickLang()];

const state = {
  status: readJson(join(RUN_DIR, "status.json")) || {},
  speeches: collectSpeeches(),
  cursor: 0, chars: 0, holdUntil: 0, paused: false,
  mode: null,
};
const terminal = ["complete", "completed", "incomplete", "failed", "needs_revision", "degraded"].includes(state.status.status);
state.mode = flag("replay") || (terminal && !flag("live")) ? "replay" : "live";
if (state.mode === "live") state.speeches = [];
for (const s of state.speeches) s.len = [...s.text].length;

function tick() {
  if (state.mode === "live") {
    state.status = readJson(join(RUN_DIR, "status.json")) || state.status;
    const fresh = collectSpeeches();
    for (const s of fresh) {
      if (!state.speeches.some((x) => x.id === s.id)) { s.len = [...s.text].length; state.speeches.push(s); }
    }
  }
  const speech = state.speeches[state.cursor];
  if (speech && !state.paused) {
    if (state.chars < speech.len) state.chars = Math.min(speech.len, state.chars + SPEED * 2);
    else if (!state.holdUntil) state.holdUntil = Date.now() + 1600;
    else if (Date.now() > state.holdUntil && state.cursor < state.speeches.length - 1) {
      state.cursor += 1; state.chars = 0; state.holdUntil = 0;
    }
  }
}

if (DEMO_FRAMES > 0) {
  for (let i = 0; i < DEMO_FRAMES; i += 1) { for (let j = 0; j < 30; j += 1) tick(); }
  console.log(frame(state));
  process.exit(0);
}

process.stdout.write("\x1b[?1049h\x1b[?25l");
const cleanup = () => { process.stdout.write("\x1b[?1049l\x1b[?25h"); process.exit(0); };
process.on("SIGINT", cleanup);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (b) => {
    const k = b.toString();
    if (k === "q" || k === "\x03") cleanup();
    if (k === " ") state.paused = !state.paused;
    if (k === "\x1b[C") { const s = state.speeches[state.cursor]; if (s) state.chars = s.len; }
    if (k === "n") { if (state.cursor < state.speeches.length - 1) { state.cursor += 1; state.chars = 0; state.holdUntil = 0; } }
  });
}
setInterval(tick, 90);
setInterval(() => process.stdout.write(`\x1b[H\x1b[2J${frame(state)}`), 120);
