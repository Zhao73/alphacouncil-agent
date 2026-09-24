// A cell buffer for the full-screen app. Text may contain ANSI SGR styles; wide (CJK) glyphs
// take two cells. `diff` emits only the rows that changed since the previous frame.

import { width as strWidth } from "../render/terminal.mjs";
import { sgr } from "./theme.mjs";

const SGR = /\x1b\[([0-9;]*)m/y;

function charWidth(ch) {
  return strWidth(ch);
}

export class Frame {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.chars = Array.from({ length: h }, () => new Array(w).fill(" "));
    this.styles = Array.from({ length: h }, () => new Array(w).fill(""));
  }

  set(x, y, ch, style) {
    if (y < 0 || y >= this.h || x < 0 || x >= this.w) return;
    this.chars[y][x] = ch;
    this.styles[y][x] = style;
  }

  /** Fill a rectangle with a background style. */
  fill(x, y, w, h, style = "", ch = " ") {
    for (let r = y; r < y + h; r += 1) for (let col = x; col < x + w; col += 1) this.set(col, r, ch, style);
  }

  /**
   * Write text at (x, y), clipped to maxW cells. `base` is an SGR string applied under any
   * inline ANSI styles. Returns the number of cells written.
   */
  text(x, y, str, base = "", maxW = this.w - x) {
    let style = base;
    let col = 0;
    const s = String(str ?? "");
    for (let i = 0; i < s.length;) {
      if (s[i] === "\x1b") {
        SGR.lastIndex = i;
        const m = SGR.exec(s);
        if (m) {
          const code = m[1];
          style = code === "" || code === "0" ? base : [base, code].filter(Boolean).join(";");
          i = SGR.lastIndex;
          continue;
        }
      }
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      i += ch.length;
      if (ch === "\n") break;
      const w = charWidth(ch);
      if (w === 0) continue;
      if (col + w > maxW) break;
      this.set(x + col, y, ch, style);
      if (w === 2) this.set(x + col + 1, y, "", style);
      col += w;
    }
    return col;
  }

  /** Rounded box with an optional title; `active` brightens the border. */
  box(x, y, w, h, { title = "", active = false } = {}) {
    const st = sgr({ fg: active ? "accent" : "line" });
    this.set(x, y, "╭", st);
    this.set(x + w - 1, y, "╮", st);
    this.set(x, y + h - 1, "╰", st);
    this.set(x + w - 1, y + h - 1, "╯", st);
    for (let c = x + 1; c < x + w - 1; c += 1) {
      this.set(c, y, "─", st);
      this.set(c, y + h - 1, "─", st);
    }
    for (let r = y + 1; r < y + h - 1; r += 1) {
      this.set(x, r, "│", st);
      this.set(x + w - 1, r, "│", st);
    }
    if (title) this.text(x + 2, y, ` ${title} `, sgr({ fg: active ? "accent" : "dim", bold: active }), w - 4);
  }

  rowString(y) {
    let out = "";
    let cur = null;
    for (let x = 0; x < this.w; x += 1) {
      const ch = this.chars[y][x];
      if (ch === "") continue;
      const st = this.styles[y][x];
      if (st !== cur) {
        out += `\x1b[0m${st ? `\x1b[${st}m` : ""}`;
        cur = st;
      }
      out += ch;
    }
    return `${out}\x1b[0m`;
  }

  /** Plain text of the frame (tests, screenshots). */
  plain() {
    return this.chars.map((row) => row.join("").replace(/\s+$/, "")).join("\n");
  }

  /** Escape sequences that turn `prev` into this frame. */
  diff(prev) {
    let out = "";
    for (let y = 0; y < this.h; y += 1) {
      const row = this.rowString(y);
      if (!prev || prev.w !== this.w || prev.h !== this.h || prev.rowString(y) !== row) out += `\x1b[${y + 1};1H${row}`;
    }
    return out;
  }
}
