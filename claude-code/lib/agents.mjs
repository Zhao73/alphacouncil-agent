// Read agents/<name>.md: the same files Claude Code loads as plugin subagents are the terminal
// client's worker system prompts, so role expertise has exactly one source.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AGENTS_DIR = fileURLToPath(new URL("../agents/", import.meta.url));

export function parseAgent(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(text).trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
  }
  return { meta, body: m[2].trim() };
}

export function loadAgent(name) {
  if (!/^[a-z-]+$/.test(name)) throw new Error(`invalid agent name: ${name}`);
  return parseAgent(readFileSync(`${AGENTS_DIR}${name}.md`, "utf8"));
}
