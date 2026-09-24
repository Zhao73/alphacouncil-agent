// Raw terminal input → key events. Handles arrows, paging, shift-tab, bracketed paste and
// SGR mouse-wheel reports; everything else printable arrives as text (IME input included).

const CSI = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Z: "shift-tab",
  "1~": "home", "4~": "end", "7~": "home", "8~": "end", "3~": "delete", "5~": "pageup", "6~": "pagedown",
};
const CTRL = { "\x01": "ctrl-a", "\x03": "ctrl-c", "\x04": "ctrl-d", "\x05": "ctrl-e", "\x0b": "ctrl-k", "\x0c": "ctrl-l", "\x15": "ctrl-u", "\x17": "ctrl-w" };

export function parseKeys(input) {
  const keys = [];
  let s = String(input);
  let text = "";
  const flush = () => {
    if (text) keys.push({ name: "text", text });
    text = "";
  };
  while (s.length) {
    if (s.startsWith("\x1b[200~")) {
      flush();
      const end = s.indexOf("\x1b[201~");
      const body = end >= 0 ? s.slice(6, end) : s.slice(6);
      keys.push({ name: "text", text: body.replace(/\r?\n/g, " ") });
      s = end >= 0 ? s.slice(end + 6) : "";
      continue;
    }
    let m;
    if ((m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s))) {
      flush();
      const b = Number(m[1]);
      if (b === 64) keys.push({ name: "wheel-up" });
      else if (b === 65) keys.push({ name: "wheel-down" });
      else if (m[4] === "M" && (b & 3) === 0 && b < 32) keys.push({ name: "click", x: Number(m[2]) - 1, y: Number(m[3]) - 1 });
      s = s.slice(m[0].length);
      continue;
    }
    if ((m = /^\x1b\[(\d*~|[A-DHFZ])/.exec(s)) || (m = /^\x1bO([A-DHF])/.exec(s))) {
      flush();
      keys.push({ name: CSI[m[1]] || "unknown" });
      s = s.slice(m[0].length);
      continue;
    }
    if (/^\x1b\[1;\d[A-D]/.test(s)) {
      flush();
      keys.push({ name: CSI[s[5]] });
      s = s.slice(6);
      continue;
    }
    const ch = s[0];
    if (ch === "\x1b") {
      flush();
      keys.push({ name: "escape" });
      s = s.slice(1);
    } else if (ch === "\r" || ch === "\n") {
      flush();
      keys.push({ name: "enter" });
      s = s.slice(1);
    } else if (ch === "\t") {
      flush();
      keys.push({ name: "tab" });
      s = s.slice(1);
    } else if (ch === "\x7f" || ch === "\b") {
      flush();
      keys.push({ name: "backspace" });
      s = s.slice(1);
    } else if (CTRL[ch]) {
      flush();
      keys.push({ name: CTRL[ch] });
      s = s.slice(1);
    } else if (ch < " ") {
      s = s.slice(1);
    } else {
      const cp = s.codePointAt(0);
      const c = String.fromCodePoint(cp);
      text += c;
      s = s.slice(c.length);
    }
  }
  flush();
  return keys;
}

/** A single-line editor with a cursor. */
export class LineEditor {
  constructor() {
    this.value = "";
    this.cursor = 0;
  }

  set(v) {
    this.value = v;
    this.cursor = [...v].length;
  }

  handle(key) {
    const chars = [...this.value];
    switch (key.name) {
      case "text":
        chars.splice(this.cursor, 0, ...key.text);
        this.cursor += [...key.text].length;
        break;
      case "backspace":
        if (this.cursor > 0) chars.splice(--this.cursor, 1);
        break;
      case "delete":
        chars.splice(this.cursor, 1);
        break;
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "right":
        this.cursor = Math.min(chars.length, this.cursor + 1);
        break;
      case "home":
      case "ctrl-a":
        this.cursor = 0;
        break;
      case "end":
      case "ctrl-e":
        this.cursor = chars.length;
        break;
      case "ctrl-u":
        chars.splice(0, this.cursor);
        this.cursor = 0;
        break;
      case "ctrl-k":
        chars.splice(this.cursor);
        break;
      case "ctrl-w": {
        let i = this.cursor;
        while (i > 0 && chars[i - 1] === " ") i -= 1;
        while (i > 0 && chars[i - 1] !== " ") i -= 1;
        chars.splice(i, this.cursor - i);
        this.cursor = i;
        break;
      }
      default:
        return false;
    }
    this.value = chars.join("");
    return true;
  }
}
