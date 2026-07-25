/**
 * Persona file format: a `---json` fenced frontmatter block, then a body split into
 * language sections by `<!-- lang:xx -->` markers.
 *
 * JSON rather than YAML because this repo has no dependencies and a hand-rolled YAML
 * subset parser mis-parses things like `description: Buy: or Sell` silently, producing a
 * wrong prompt with no error. JSON.parse is exact and fails loudly with a position.
 * Persona files are source data; the generator emits real YAML frontmatter for the host
 * surfaces, and serializing a known key set is safe in a way parsing arbitrary YAML is not.
 *
 * `<!-- lang:xx -->` rather than `## zh` because persona bodies legitimately contain `##`
 * headings, an HTML comment can never collide, and GitHub renders it as nothing.
 */

const FRONTMATTER = /^---json\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const LANG_MARKER = /^<!--\s*lang:\s*([a-z]{2}(?:-[a-z]{2})?)\s*-->\s*$/i;

export function parsePersonaFile(text, file = "<persona>") {
  const match = FRONTMATTER.exec(String(text ?? ""));
  if (!match) throw new Error(`${file}: missing ---json frontmatter block`);

  let meta;
  try {
    meta = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`${file}: frontmatter is not valid JSON: ${error.message}`);
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error(`${file}: frontmatter must be a JSON object`);
  }

  const bodies = {};
  let current = null;
  let sawMarker = false;
  const preamble = [];
  for (const line of String(text).slice(match[0].length).split(/\r?\n/)) {
    const marker = LANG_MARKER.exec(line);
    if (marker) {
      sawMarker = true;
      current = marker[1].toLowerCase();
      if (!bodies[current]) bodies[current] = [];
      continue;
    }
    if (current) bodies[current].push(line);
    else preamble.push(line);
  }
  if (!sawMarker) throw new Error(`${file}: body has no <!-- lang:xx --> section`);
  if (preamble.join("").trim()) {
    throw new Error(`${file}: text before the first <!-- lang:xx --> marker would be silently dropped`);
  }

  return {
    meta,
    bodies: Object.fromEntries(Object.entries(bodies).map(([lang, lines]) => [lang, lines.join("\n").trim()])),
  };
}

/** Serialize a fixed, known key set to YAML frontmatter for generated host files. */
export function toYamlFrontmatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}: ${value.map(yamlScalar).join(", ")}`);
      continue;
    }
    lines.push(`${key}: ${yamlScalar(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

function yamlScalar(value) {
  const text = String(value);
  // Quote anything a YAML reader could misinterpret. Cheap and always safe.
  return /^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/.test(text) && !/:\s/.test(text)
    ? text
    : JSON.stringify(text);
}
