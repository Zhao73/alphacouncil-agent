// Terminal primitives without dependencies: color, display width (CJK/emoji aware),
// markdown rendering for reports, and a pager.

import { spawnSync } from "node:child_process";

export const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const wrap = (open, close) => (s) => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  under: wrap(4, 24),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
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
    .replace(/`([^`]+)`/g, (_, x) => c.cyan(x))
    .replace(/(^|[\s(])_(.+?)_(?=[\s).,;:]|$)/g, (_, a, x) => a + c.italic(x))
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, (_, t, u) => `${t} ${c.gray(`<${u}>`)}`);
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
    for (let k = 0; k < height; k += 1) out.push(`│ ${wrapped.map((x, i) => pad(style(x[k] || ""), widths[i])).join(" │ ")} │`);
    return out;
  };
  const sep = (l, m, r) => c.gray(`${l}${widths.map((w) => "─".repeat(w + 2)).join(m)}${r}`);
  return [sep("┌", "┬", "┐"), ...row(header, c.bold), sep("├", "┼", "┤"), ...body.flatMap((r) => row(r)), sep("└", "┴", "┘")];
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
    if ((m = l.match(/^# (.*)/))) out.push("", c.bold(c.cyan(m[1])), c.cyan("═".repeat(Math.min(cw, width(m[1]) + 2))));
    else if ((m = l.match(/^## (.*)/))) out.push("", c.bold(c.yellow(`■ ${m[1]}`)));
    else if ((m = l.match(/^### (.*)/))) out.push(c.bold(m[1]));
    else if ((m = l.match(/^> (.*)/))) out.push(c.dim(`│ ${inline(m[1])}`));
    else if (/^---\s*$/.test(l)) out.push(c.gray("─".repeat(cw)));
    else if ((m = l.match(/^(\s*)- (.*)/))) {
      const ind = m[1].length + 2;
      const wrapped = wrapText(m[2], cw - ind - 2);
      out.push(`${" ".repeat(m[1].length)}• ${inline(wrapped[0])}`);
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
