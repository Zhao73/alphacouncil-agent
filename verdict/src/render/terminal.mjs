// Terminal primitives without dependencies: color, display width (CJK/emoji aware),
// markdown rendering for reports, and a pager.

import { spawnSync } from "node:child_process";
import { colorMode, paint } from "../tui/theme.mjs";

export const useColor = colorMode !== "none";
// Kept small and semantic; every color comes from the Verdict theme.
export const c = {
  bold: (s) => paint(s, { fg: "ink", bold: true }),
  dim: (s) => paint(s, "dim"),
  italic: (s) => paint(s, { fg: "text", italic: true }),
  under: (s) => paint(s, { underline: true }),
  accent: (s) => paint(s, "accent"),
  red: (s) => paint(s, "bear"),
  green: (s) => paint(s, "bull"),
  yellow: (s) => paint(s, "hold"),
  cyan: (s) => paint(s, "info"),
  blue: (s) => paint(s, "info"),
  gray: (s) => paint(s, "dim"),
  faint: (s) => paint(s, "faint"),
};

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
export const stripAnsi = (s) => String(s).replace(ANSI, "");

function charWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks
  if (cp === 0x200b || cp === 0xfe0f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

export function width(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Truncate to a display width (ANSI-free input). */
export function truncate(s, max) {
  s = String(s ?? "");
  if (width(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

export function pad(s, n) {
  const w = width(s);
  return w >= n ? s : s + " ".repeat(n - w);
}

/** Word-wrap plain text to a display width, keeping CJK breakable anywhere. */
export function wrapText(text, max) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    let lw = 0;
    const tokens = para.match(/[⺀-꓏가-힣＀-￯]|[^\s⺀-꓏가-힣＀-￯]+|\s+/g) || [""];
    for (const tok of tokens) {
      const tw = width(tok);
      if (/^\s+$/.test(tok)) {
        if (lw > 0 && lw + 1 <= max) {
          line += " ";
          lw += 1;
        }
        continue;
      }
      if (lw + tw > max && lw > 0) {
        out.push(line.trimEnd());
        line = "";
        lw = 0;
      }
      if (tw > max) {
        for (const ch of tok) {
          const cw = width(ch);
          if (lw + cw > max) {
            out.push(line);
            line = "";
            lw = 0;
          }
          line += ch;
          lw += cw;
        }
      } else {
        line += tok;
        lw += tw;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function inline(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, (_, x) => c.bold(x))
    .replace(/`([^`]+)`/g, (_, x) => c.faint(x))
    .replace(/(^|[\s(])_(.+?)_(?=[\s).,;:]|$)/g, (_, a, x) => a + c.italic(x))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => `${t} ${c.faint(u)}`)
    .replace(/ \[([a-z_]+:[A-Za-z0-9_]+(?:, [a-z_]+:[A-Za-z0-9_]+)*)\]/g, (_, ids) => ` ${c.faint(`[${ids}]`)}`);
}

function renderTable(rows, cols) {
  const cells = rows.map((r) => r.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((x) => stripAnsi(inline(x.trim().replace(/\\\|/g, "|")))));
  const header = cells[0];
  const body = cells.slice(2);
  const all = [header, ...body];
  const widths = header.map((_, i) => Math.max(1, ...all.map((r) => width(r[i] || ""))));
  // Shrink the widest column until the table fits; cells then wrap inside their column.
  const total = () => widths.reduce((a, b) => a + b + 3, 1);
  while (total() > cols) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 8) break;
    widths[i] -= 1;
  }
  const row = (r, style = (x) => x) => {
    const wrapped = widths.map((w, i) => wrapText(r[i] || "", w));
    const height = Math.max(...wrapped.map((x) => x.length));
    const out = [];
    for (let k = 0; k < height; k += 1) out.push(`${c.faint("│")} ${wrapped.map((x, i) => pad(style(x[k] || ""), widths[i])).join(` ${c.faint("│")} `)} ${c.faint("│")}`);
    return out;
  };
  const sep = (l, m, r) => c.faint(`${l}${widths.map((w) => "─".repeat(w + 2)).join(m)}${r}`);
  const blank = header.every((x) => !x.trim());
  return [sep("╭", "┬", "╮"), ...(blank ? [] : [...row(header, c.bold), sep("├", "┼", "┤")]), ...body.flatMap((r) => row(r)), sep("╰", "┴", "╯")];
}

/** Render report markdown for a terminal of `cols` columns. */
export function renderMarkdown(md, cols = process.stdout.columns || 100) {
  const cw = Math.max(40, Math.min(cols, 120));
  const lines = String(md).split("\n");
  const out = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(c.gray(`  ${l}`));
      continue;
    }
    if (/^\|.*\|\s*$/.test(l)) {
      const block = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
      i -= 1;
      out.push(...renderTable(block, cw));
      continue;
    }
    let m;
    if ((m = l.match(/^# (.*)/))) out.push("", paint(` ${m[1]} `, { fg: "ink", bold: true }), c.accent("━".repeat(Math.min(cw, width(m[1]) + 2))));
    else if ((m = l.match(/^## (.*)/))) out.push("", `${c.accent("▍")}${paint(m[1], { fg: "ink", bold: true })}`);
    else if ((m = l.match(/^### (.*)/))) out.push(paint(m[1], { fg: "accent", bold: true }));
    else if ((m = l.match(/^> (.*)/))) out.push(`${c.accent("┃")} ${c.dim(stripAnsi(inline(m[1])))}`);
    else if (/^---\s*$/.test(l)) out.push(c.faint("┄".repeat(cw)));
    else if ((m = l.match(/^(\s*)- (.*)/))) {
      const ind = m[1].length + 2;
      const wrapped = wrapText(m[2], cw - ind - 2);
      out.push(`${" ".repeat(m[1].length)}${c.accent(m[1].length ? "◦" : "•")} ${inline(wrapped[0])}`);
      for (const w of wrapped.slice(1)) out.push(`${" ".repeat(ind)}${inline(w)}`);
    } else if (!l.trim()) out.push("");
    else for (const w of wrapText(l, cw)) out.push(inline(w));
  }
  return out.join("\n");
}

/** Show text through `less -R` when interactive, else print. */
export function page(text) {
  if (process.stdout.isTTY && !process.env.ALPHACOUNCIL_NO_PAGER) {
    const pager = process.env.PAGER || "less -R -F -X";
    const r = spawnSync(pager, { shell: true, input: text, stdio: ["pipe", "inherit", "inherit"] });
    if (!r.error && r.status === 0) return;
  }
  process.stdout.write(`${text}\n`);
}
