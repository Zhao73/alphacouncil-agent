/**
 * Minimal Markdown heading parser.
 *
 * The report quality gate used to lowercase the whole document and ask
 * `haystack.includes("risk")`, so any report that happened to contain the word "risk"
 * anywhere passed the "Risks section" check. Structure has to be parsed to be checked.
 */

const ATX = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^(\s*)(```|~~~)/;

/**
 * @returns {{level:number,title:string,body:string,line:number}[]}
 * `body` runs from just after the heading to the next heading of the same or higher
 * level (i.e. a subsection stays inside its parent's body).
 */
export function parseHeadings(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const found = [];
  let fence = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[2];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue; // A '#' inside a code fence is not a heading.
    const match = ATX.exec(line);
    if (!match || !match[2]) continue;
    found.push({ level: match[1].length, title: match[2], line: i + 1, start: i + 1 });
  }

  return found.map((heading, index) => {
    let end = lines.length;
    for (let j = index + 1; j < found.length; j += 1) {
      if (found[j].level <= heading.level) {
        end = found[j].start - 1;
        break;
      }
    }
    const { start, ...rest } = heading;
    return { ...rest, body: lines.slice(start, end).join("\n").trim() };
  });
}

/**
 * Fold a heading or alias into a comparable form: lowercase, punctuation and digits
 * collapsed to spaces, CJK left intact (CJK has no word boundaries to preserve).
 */
export function normalizeHeading(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Non-whitespace character count, the only length measure that survives CJK. */
export function denseLength(text) {
  return String(text || "").replace(/\s+/g, "").length;
}
