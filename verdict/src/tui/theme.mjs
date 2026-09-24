// Verdict's terminal palette: warm amber accent on neutral ink, green/red for bull/bear.
// Truecolor when the terminal says so, 256-color otherwise, plain text with NO_COLOR.

const env = process.env;
const plainOutput = env.NO_COLOR || env.TERM === "dumb" || (!process.stdout.isTTY && !env.FORCE_COLOR);
export const colorMode = plainOutput ? "none" : /truecolor|24bit/i.test(env.COLORTERM || "") || env.VERDICT_TRUECOLOR ? "truecolor" : "256";

const PALETTE = {
  accent: ["#f5a524", 214],
  accentDim: ["#8a5d12", 136],
  ink: ["#e8e4da", 254],
  text: ["#c9c5bb", 251],
  dim: ["#8b8780", 245],
  faint: ["#4d525c", 239],
  line: ["#343944", 237],
  select: ["#2b2f38", 236],
  panel: ["#1b1e24", 234],
  bull: ["#3fb950", 71],
  bear: ["#f85149", 203],
  hold: ["#d29922", 178],
  info: ["#58a6ff", 75],
  onAccent: ["#1b1400", 16],
};

function hex(h) {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function fgCode(name) {
  const [h, n] = PALETTE[name];
  return colorMode === "truecolor" ? `38;2;${hex(h).join(";")}` : `38;5;${n}`;
}

function bgCode(name) {
  const [h, n] = PALETTE[name];
  return colorMode === "truecolor" ? `48;2;${hex(h).join(";")}` : `48;5;${n}`;
}

/** SGR parameter string for a style: sgr({fg:"accent", bold:true, bg:"select"}). */
export function sgr({ fg, bg, bold, dim, italic, underline, inverse } = {}) {
  if (colorMode === "none") return [bold && "1", underline && "4", inverse && "7"].filter(Boolean).join(";");
  return [fg && fgCode(fg), bg && bgCode(bg), bold && "1", dim && "2", italic && "3", underline && "4", inverse && "7"].filter(Boolean).join(";");
}

/** Wrap text in a style; resets to default afterwards. */
export function paint(text, style) {
  const code = typeof style === "string" ? sgr({ fg: style }) : sgr(style);
  return code ? `\x1b[${code}m${text}\x1b[0m` : String(text);
}

export const tone = {
  accent: (s) => paint(s, "accent"),
  ink: (s) => paint(s, "ink"),
  text: (s) => paint(s, "text"),
  dim: (s) => paint(s, "dim"),
  faint: (s) => paint(s, "faint"),
  bull: (s) => paint(s, "bull"),
  bear: (s) => paint(s, "bear"),
  hold: (s) => paint(s, "hold"),
  info: (s) => paint(s, "info"),
  bold: (s) => paint(s, { bold: true }),
  strong: (s) => paint(s, { fg: "ink", bold: true }),
  italic: (s) => paint(s, { fg: "text", italic: true }),
};

export function ratingTone(rating) {
  if (/Buy|Overweight/i.test(rating || "")) return "bull";
  if (/Sell|Underweight/i.test(rating || "")) return "bear";
  if (/Hold/i.test(rating || "")) return "hold";
  return "dim";
}

export function stanceTone(stance) {
  if (/bull|supportive/.test(stance || "")) return "bull";
  if (/bear|opposed/.test(stance || "")) return "bear";
  if (/mixed|neutral/.test(stance || "")) return "hold";
  return "dim";
}

/** A rating chip: " OVERWEIGHT ▲ " on a tinted background. */
export function chip(rating) {
  const t = ratingTone(rating);
  const arrow = t === "bull" ? " ▲" : t === "bear" ? " ▼" : t === "hold" ? " ◆" : "";
  return paint(` ${String(rating || "—").toUpperCase()}${arrow} `, colorMode === "none" ? { inverse: true } : { fg: "onAccent", bg: t === "dim" ? "faint" : t, bold: true });
}

export const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
