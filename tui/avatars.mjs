/**
 * Parametric pixel avatars for the terminal council.
 *
 * Hand-drawing 27 portraits would rot the moment a seat is added, so avatars are
 * composed from a 12x12 pixel grid by a handful of parameters -- hair, glasses,
 * beard, tie -- with one spec line per master. An unknown id still gets a face:
 * its features derive deterministically from the id hash, so a new seat renders
 * before anyone draws anything.
 *
 * Rendering uses the upper-half-block trick: one character cell carries two
 * vertically stacked pixels (foreground = top, background = bottom), so a 12x12
 * grid becomes 6 terminal rows of 24-bit color.
 */

const SKIN = { light: "#e8b88a", tan: "#c98d5a", deep: "#8a5a33" };
const HAIR = {
  white: "#e6e2da", gray: "#9aa0a3", silver: "#c2c8cc", dark: "#2e2a26",
  brown: "#5d4630", blond: "#cbb26a", red: "#a35b2f",
};
const SUIT = "#2c3440";
const SHIRT = "#dde3e8";

/** spec: { skin, hair, style, glasses, beard, tie, extra } */
const SPECS = {
  master_buffett: { skin: "light", hair: "white", style: "side", glasses: true, tie: "#b03a2e" },
  master_munger: { skin: "light", hair: "gray", style: "bald", glasses: "big", tie: "#34495e" },
  master_graham: { skin: "light", hair: "dark", style: "slick", tie: "#5d6d7e" },
  master_fisher: { skin: "light", hair: "gray", style: "slick", glasses: true, tie: "#7d6608" },
  master_lynch: { skin: "light", hair: "white", style: "curly", tie: "#1e8449" },
  master_marks: { skin: "light", hair: "gray", style: "bald", tie: "#2874a6" },
  master_klarman: { skin: "light", hair: "silver", style: "side", glasses: true, tie: "#6c3483" },
  master_soros: { skin: "light", hair: "gray", style: "side", glasses: true, tie: "#1a5276" },
  master_druckenmiller: { skin: "light", hair: "silver", style: "side", tie: "#117864" },
  master_dalio: { skin: "light", hair: "gray", style: "side", tie: "#21618c" },
  master_burry: { skin: "light", hair: "brown", style: "short", tie: "#484f56" },
  master_forensic_short: { skin: "light", hair: "dark", style: "hood", tie: "#17202a" },
  master_simons: { skin: "light", hair: "white", style: "bald", beard: "white", tie: "#7b241c" },
  master_asness: { skin: "light", hair: "dark", style: "bald", beard: "dark", glasses: true, tie: "#1f618d" },
  master_thorp: { skin: "light", hair: "white", style: "side", glasses: true, tie: "#186a3b" },
  master_taleb: { skin: "tan", hair: "gray", style: "bald", beard: "gray", tie: "#6e2c00" },
  master_natenberg: { skin: "light", hair: "gray", style: "short", glasses: true, tie: "#4a235a" },
  master_sinclair: { skin: "light", hair: "brown", style: "short", tie: "#0e6251" },
  master_aschenbrenner: { skin: "light", hair: "blond", style: "short", tie: "#1a5276" },
  master_damodaran: { skin: "deep", hair: "dark", style: "bald", glasses: true, tie: "#7d6608" },
  master_ackman: { skin: "light", hair: "silver", style: "short", tie: "#922b21" },
  master_cathie_wood: { skin: "light", hair: "blond", style: "long", tie: "#7d3c98" },
  master_pabrai: { skin: "deep", hair: "dark", style: "bald", glasses: true, tie: "#b9770e" },
  master_jhunjhunwala: { skin: "deep", hair: "dark", style: "side", glasses: true, tie: "#943126" },
  master_bogle: { skin: "light", hair: "white", style: "side", tie: "#1c2833" },
  master_duan_yongping: { skin: "tan", hair: "dark", style: "short", tie: "#212f3c" },
  master_li_lu: { skin: "tan", hair: "dark", style: "short", glasses: true, tie: "#1b4f72" },
  bull_researcher: { skin: "light", hair: "dark", style: "horns", tie: "#1e8449", suit: "#14432a" },
  bear_researcher: { skin: "tan", hair: "brown", style: "ears", tie: "#922b21", suit: "#4a2c17" },
  portfolio_manager: { skin: "light", hair: "dark", style: "slick", glasses: true, tie: "#b7950b" },
};

const hashOf = (s) => [...String(s)].reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);

function specFor(id) {
  if (SPECS[id]) return SPECS[id];
  const h = hashOf(id);
  const styles = ["side", "short", "slick", "curly", "bald"];
  const hairs = Object.keys(HAIR);
  const skins = Object.keys(SKIN);
  return {
    skin: skins[h % skins.length],
    hair: hairs[(h >> 3) % hairs.length],
    style: styles[(h >> 6) % styles.length],
    glasses: Boolean(h & 4),
    tie: `#${((h >>> 8) & 0xffffff).toString(16).padStart(6, "0")}`,
  };
}

const hex = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

export function buildGrid(id) {
  const s = specFor(id);
  const skin = SKIN[s.skin] || SKIN.light;
  const hair = HAIR[s.hair] || HAIR.dark;
  const suit = s.suit || SUIT;
  const g = Array.from({ length: 12 }, () => Array(12).fill(null));
  const set = (x, y, c) => { if (x >= 0 && x < 12 && y >= 0 && y < 12 && c) g[y][x] = c; };
  const rect = (x0, y0, x1, y1, c) => { for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) set(x, y, c); };

  // shoulders, shirt, tie
  rect(1, 9, 10, 11, suit);
  rect(5, 9, 6, 10, SHIRT);
  const tie = s.tie || "#7f8c8d";
  set(5, 10, tie); set(6, 10, tie); set(5, 11, tie); set(6, 11, tie);
  // head
  rect(3, 2, 8, 8, skin);
  // hair styles
  const st = s.style;
  if (st === "side") { rect(3, 1, 8, 1, hair); set(3, 2, hair); set(8, 2, hair); set(3, 3, hair); set(8, 3, hair); }
  if (st === "short" || st === "horns" || st === "ears") { rect(3, 1, 8, 1, hair); set(3, 2, hair); set(8, 2, hair); }
  if (st === "slick") { rect(3, 1, 8, 2, hair); }
  if (st === "curly") { rect(2, 1, 9, 2, hair); set(2, 3, hair); set(9, 3, hair); }
  if (st === "long") { rect(2, 1, 9, 2, hair); rect(2, 3, 2, 8, hair); rect(9, 3, 9, 8, hair); set(3, 2, hair); set(8, 2, hair); }
  if (st === "bald") { set(3, 2, hair); set(8, 2, hair); }
  if (st === "hood") { rect(2, 1, 9, 3, "#17202a"); rect(2, 4, 2, 8, "#17202a"); rect(9, 4, 9, 8, "#17202a"); }
  if (st === "horns") { set(2, 1, "#d5dbdb"); set(9, 1, "#d5dbdb"); set(2, 0, "#d5dbdb"); set(9, 0, "#d5dbdb"); }
  if (st === "ears") { rect(2, 0, 3, 1, hair); rect(8, 0, 9, 1, hair); }
  // eyes / glasses
  const eyeY = 4;
  if (s.glasses) {
    const frame = s.glasses === "big" ? "#1b2631" : "#2c3e50";
    set(4, eyeY, frame); set(7, eyeY, frame); set(5, eyeY, "#aab7b8"); set(6, eyeY, "#aab7b8");
    if (s.glasses === "big") { set(4, eyeY + 1, frame); set(7, eyeY + 1, frame); }
  } else { set(4, eyeY, "#1b2631"); set(7, eyeY, "#1b2631"); }
  // nose + mouth
  set(5, 5, s.skin === "deep" ? "#6e4526" : "#c99b6f"); // ponytail: one shading pixel is the whole nose
  set(5, 7, "#8d5b3f"); set(6, 7, "#8d5b3f");
  // beard
  if (s.beard) {
    const b = s.beard === "white" ? HAIR.white : s.beard === "gray" ? HAIR.gray : HAIR.dark;
    rect(3, 7, 8, 8, b); set(5, 7, b); set(6, 7, b); set(5, 8, "#8d5b3f"); set(6, 8, "#8d5b3f");
  }
  return g;
}

import { PORTRAITS } from "./portraits.mjs";

const B36 = "0123456789abcdefghijklmnopqrstuv";

/** A generated 40x40 likeness when one exists, else the parametric 12x12 face. */
export function renderAvatar(id) {
  const p = PORTRAITS[id];
  if (p) {
    const g = p.rows.map((row) => [...row].map((c) => p.palette[B36.indexOf(c)]));
    return renderGrid(g, p.rows[0].length, p.rows.length);
  }
  return renderGrid(buildGrid(id), 12, 12);
}

function renderGrid(g, w, h) {
  const rows = [];
  for (let y = 0; y < h; y += 2) {
    let line = "";
    for (let x = 0; x < w; x += 1) {
      const top = g[y][x];
      const bot = g[y + 1]?.[x] || null;
      if (!top && !bot) { line += "\x1b[0m "; continue; }
      if (top && bot) {
        const [tr, tg, tb] = hex(top); const [br, bg, bb] = hex(bot);
        line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀`;
      } else if (top) {
        const [tr, tg, tb] = hex(top);
        line += `\x1b[0m\x1b[38;2;${tr};${tg};${tb}m▀`;
      } else {
        const [br, bg, bb] = hex(bot);
        line += `\x1b[0m\x1b[38;2;${br};${bg};${bb}m▄`;
      }
    }
    rows.push(`${line}\x1b[0m`);
  }
  return rows;
}

/** "master_cathie_wood" -> "Cathie Wood" */
export function displayName(id) {
  const base = String(id).replace(/^master_/, "").replace(/_/g, " ");
  return base.replace(/\b\w/g, (c) => c.toUpperCase());
}
