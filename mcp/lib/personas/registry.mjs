import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { DEBATE_ROLES, DEFAULT_TASKS } from "../constants.mjs";
import { parsePersonaFile } from "./frontmatter.mjs";

export const PERSONA_KINDS = ["analyst", "debate", "master", "verifier"];
const OUTPUT_CONTRACTS = ["evidence_packet", "debate_packet", "master_opinion", "verifier_verdict", "none"];
const ID_PATTERN = /^[a-z0-9_]{2,48}$/;

/** Resolved from import.meta.url. Hosts launch the server from arbitrary cwds. */
export function defaultPersonaDir() {
  return process.env.ALPHACOUNCIL_PERSONAS_DIR
    || fileURLToPath(new URL("../../../personas/", import.meta.url));
}

/** Node 18 has no readdirSync({recursive:true}); ten lines beats a version floor bump. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".md")) out.push(path);
  }
  return out;
}

function validate(meta, bodies, file, errors) {
  const fail = (message) => errors.push(`${file}: ${message}`);

  if (meta.schema_version !== 1) fail(`schema_version must be 1, got ${JSON.stringify(meta.schema_version)}`);
  if (typeof meta.id !== "string" || !ID_PATTERN.test(meta.id)) {
    fail(`id must match ${ID_PATTERN}, got ${JSON.stringify(meta.id)}`);
  }
  if (!PERSONA_KINDS.includes(meta.kind)) fail(`kind must be one of ${PERSONA_KINDS.join("|")}, got ${JSON.stringify(meta.kind)}`);
  if (!Number.isFinite(meta.order)) fail("order must be a finite number");
  if (typeof meta.enabled !== "boolean") fail("enabled must be a boolean");
  if (!Array.isArray(meta.rosters) || meta.rosters.some((r) => typeof r !== "string")) {
    fail("rosters must be an array of strings");
  }
  if (!Array.isArray(meta.langs) || meta.langs.length === 0) fail("langs must be a non-empty array");
  else {
    for (const lang of meta.langs) {
      // A declared language with no body is the drift this format exists to prevent.
      if (!bodies[lang] || !bodies[lang].trim()) fail(`declares langs "${lang}" but has no non-empty <!-- lang:${lang} --> section`);
    }
    for (const lang of Object.keys(bodies)) {
      if (!meta.langs.includes(lang)) fail(`has a <!-- lang:${lang} --> section that is not declared in langs`);
    }
    if (!meta.langs.includes(meta.default_lang)) fail(`default_lang ${JSON.stringify(meta.default_lang)} is not in langs`);
  }
  if (meta.output_contract !== undefined && !OUTPUT_CONTRACTS.includes(meta.output_contract)) {
    fail(`output_contract must be one of ${OUTPUT_CONTRACTS.join("|")}, got ${JSON.stringify(meta.output_contract)}`);
  }
  if (meta.kind === "master") {
    // A master persona is a point of view with an explicit failure condition. Without
    // disqualifiers it degrades into generic commentary that agrees with everything.
    if (!Array.isArray(meta.philosophy_tags) || meta.philosophy_tags.length === 0) {
      fail("a master persona must declare philosophy_tags");
    }
    if (!Array.isArray(meta.disqualifiers) || meta.disqualifiers.length === 0) {
      fail("a master persona must declare disqualifiers: what would make this master walk away");
    }
    if (typeof meta.era !== "string" || !meta.era) fail("a master persona must declare era");
    if (typeof meta.holding_period !== "string" || !meta.holding_period) fail("a master persona must declare holding_period");
  }

  if (meta.source !== undefined && meta.source !== null) {
    const s = meta.source;
    if (typeof s !== "object" || !s.name || !s.license) {
      fail("source must be null or an object with at least { name, license } -- adapted content must carry its attribution");
    }
  }
}

/**
 * Load every persona under `dir` into a frozen registry.
 *
 * Collects ALL errors and throws once, so a malformed set is fixed in one pass rather
 * than one file per run. Deliberately does not degrade: once the inline prompt literals
 * are gone there is no fallback text, and a "graceful" degrade would silently ship empty
 * prompts -- exactly the class of bug this layer exists to remove.
 */
export function loadPersonas({ dir = defaultPersonaDir() } = {}) {
  let files;
  try {
    files = walk(dir).sort();
  } catch (error) {
    throw new Error(`persona directory is unreadable: ${dir} (${error.code || error.message}). Set ALPHACOUNCIL_PERSONAS_DIR to override.`);
  }
  if (files.length === 0) throw new Error(`no persona files found under ${dir}`);

  const errors = [];
  const byId = new Map();
  for (const file of files) {
    const label = relative(dir, file);
    let parsed;
    try {
      parsed = parsePersonaFile(readFileSync(file, "utf8"), label);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    validate(parsed.meta, parsed.bodies, label, errors);
    const id = parsed.meta.id;
    if (typeof id === "string") {
      if (byId.has(id)) errors.push(`${label}: duplicate persona id "${id}" (also in ${byId.get(id).file})`);
      else byId.set(id, { ...parsed.meta, bodies: parsed.bodies, file: label });
    }
  }

  // Closure check: the task and role lists the server ships must all resolve.
  for (const task of DEFAULT_TASKS) {
    const persona = byId.get(task);
    if (!persona) errors.push(`DEFAULT_TASKS includes "${task}" but no persona defines it`);
    else if (persona.kind !== "analyst") errors.push(`"${task}" is a default task but its persona kind is "${persona.kind}"`);
  }
  for (const role of DEBATE_ROLES) {
    const persona = byId.get(role);
    if (!persona) errors.push(`DEBATE_ROLES includes "${role}" but no persona defines it`);
    else if (persona.kind !== "debate") errors.push(`"${role}" is a debate role but its persona kind is "${persona.kind}"`);
  }

  if (errors.length) {
    throw new Error(`invalid persona set in ${dir}:\n- ${errors.join("\n- ")}`);
  }

  return Object.freeze({
    dir,
    personas: byId,
    get: (id) => byId.get(id),
    all: () => [...byId.values()],
    ids: (kind) => [...byId.values()]
      .filter((p) => (kind ? p.kind === kind : true) && p.enabled)
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .map((p) => p.id),
  });
}

let cached = null;

/** Loaded once per server process; personas are static and hosts restart the server. */
export function registry() {
  if (!cached) cached = loadPersonas();
  return cached;
}

/** Tests only. */
export function resetRegistry() {
  cached = null;
}

export function selectRoster(reg, { kind, roster, ids } = {}) {
  let list = reg.all();
  if (ids?.length) {
    const wanted = new Set(ids);
    list = list.filter((p) => wanted.has(p.id));
    const missing = ids.filter((id) => !reg.get(id));
    if (missing.length) throw new Error(`unknown persona id(s): ${missing.join(", ")}`);
  } else {
    list = list.filter((p) => p.enabled);
    if (kind) list = list.filter((p) => p.kind === kind);
    if (roster) list = list.filter((p) => p.rosters.includes(roster));
  }
  return list.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * The prompt body for a persona in the requested language.
 *
 * Falls back to the persona's default_lang, then to any body it has, so a persona that
 * has not been translated yet still produces a usable prompt instead of an empty one.
 */
export function personaPrompt(persona, lang) {
  if (!persona) return "";
  const key = personaLangKey(persona, lang);
  return persona.bodies[key] || "";
}

/** Map a resolved display language ("中文", "English", ...) onto a persona body key. */
export function personaLangKey(persona, lang) {
  const text = String(lang || "");
  const wanted = /中文|chinese|zh/i.test(text) ? "zh"
    : /日本語|japanese|ja/i.test(text) ? "ja"
      : /한국어|korean|ko/i.test(text) ? "ko"
        : "en";
  if (persona.bodies[wanted]) return wanted;
  if (persona.bodies[persona.default_lang]) return persona.default_lang;
  return Object.keys(persona.bodies)[0];
}

/** Localized title, falling back through the same chain as the body. */
export function personaTitle(persona, lang) {
  if (!persona) return "";
  const title = persona.title;
  if (typeof title === "string") return title;
  if (!title || typeof title !== "object") return persona.id;
  return title[personaLangKey(persona, lang)] || title[persona.default_lang] || persona.id;
}
