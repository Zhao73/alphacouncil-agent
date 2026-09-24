// Read a string field out of JSON that is still being streamed, so the UI can show the
// portfolio manager's conclusion while it is written.

const ESC = { n: "\n", t: "\t", r: "", b: "", f: "", '"': '"', "\\": "\\", "/": "/" };

/** Value of `"field": "…` in partial JSON text; null if the field has not started. */
export function partialString(text, field) {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(text);
  if (!m) return null;
  let out = "";
  for (let i = m.index + m[0].length; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') return { value: out, done: true };
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next === "u") {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
    } else {
      out += ESC[next] ?? next;
      i += 1;
    }
  }
  return { value: out, done: false };
}
