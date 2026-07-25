import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { registry, selectRoster } from "./personas/registry.mjs";

/**
 * Network-permission preflight.
 *
 * The failure this exists for: background subagents cannot raise an interactive
 * permission prompt. If WebSearch is not allowed, their searches are blocked silently and
 * the agent falls back on training knowledge -- while still filling in every section of
 * the report template. The output looks complete and is entirely unsourced, and nothing
 * in the run signals it.
 *
 * The check is deliberately three-valued, and the bar for "blocked" is high:
 *
 *   blocked  the host explicitly denies the tool. Definitive.
 *   ok       bypassPermissions is set, or the tool is on an allowlist.
 *   unknown  no persistent grant found. A foreground session prompts and works; a
 *            background fan-out does not. This is a warning, not a stop.
 *
 * An earlier version treated "an allowlist exists but omits the tool" as blocked. That
 * was wrong and fired on ordinary setups: an allowlist full of Bash entries says nothing
 * about network access, and a machine with defaultMode bypassPermissions -- where
 * everything is in fact granted -- was reported as blocked.
 */

/** Host config files that can carry a tool permission allowlist. */
export function permissionSources({ cwd = process.cwd(), home = os.homedir() } = {}) {
  return [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(home, ".claude", "settings.local.json"),
    join(home, ".claude", "settings.json"),
    join(cwd, "opencode.json"),
    join(home, ".config", "opencode", "opencode.json"),
  ];
}

/** Normalize the tool names the two hosts use so one allowlist check covers both. */
export function canonicalTool(name) {
  const text = String(name || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  if (text.startsWith("websearch")) return "websearch";
  if (text.startsWith("webfetch")) return "webfetch";
  if (text.startsWith("getquote")) return "get_quote";
  return String(name || "").trim().toLowerCase();
}

function readPermissions(path) {
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { path, unreadable: error.message };
  }
  // Claude Code: { permissions: { allow: [...], deny: [...] } }
  // OpenCode:    { permission: { websearch: "allow" | "ask" | "deny", ... } }
  const claude = parsed?.permissions;
  const opencode = parsed?.permission || parsed?.permissions;
  const allow = new Set();
  const deny = new Set();
  let declared = false;
  // bypassPermissions grants everything without prompting, including in background
  // subagents. Ignoring it made this check report "blocked" on a fully permissive setup.
  const bypass = claude?.defaultMode === "bypassPermissions";

  if (Array.isArray(claude?.allow)) {
    declared = true;
    for (const entry of claude.allow) allow.add(canonicalTool(entry));
  }
  if (Array.isArray(claude?.deny)) {
    declared = true;
    for (const entry of claude.deny) deny.add(canonicalTool(entry));
  }
  if (opencode && !Array.isArray(opencode) && typeof opencode === "object") {
    for (const [key, value] of Object.entries(opencode)) {
      if (typeof value !== "string") continue;
      declared = true;
      if (value === "allow") allow.add(canonicalTool(key));
      else if (value === "deny") deny.add(canonicalTool(key));
    }
  }
  return { path, allow, deny, declared, bypass };
}

/** Every tool the personas in a roster say they need. */
export function requiredTools({ reg = registry(), roster = "default", kind = "analyst" } = {}) {
  const personas = selectRoster(reg, { kind, roster });
  const tools = new Set();
  for (const persona of personas) {
    for (const tool of persona.tools_hint || []) tools.add(canonicalTool(tool));
  }
  // get_quote is served by this MCP server itself; it never needs a host allowlist entry.
  tools.delete("get_quote");
  return [...tools].sort();
}

const REMEDY = {
  claude: 'Add the tools to permissions.allow in .claude/settings.local.json, e.g. {"permissions":{"allow":["WebSearch","WebFetch"]}}',
  opencode: 'Set them to "allow" in opencode.json, e.g. {"permission":{"websearch":"allow","webfetch":"allow"}}. Note OpenCode gates websearch behind its own provider or OPENCODE_ENABLE_EXA=1.',
};

/**
 * @returns {{status:"ok"|"blocked"|"unknown", required:string[], missing:string[],
 *            denied:string[], checked:object[], remedy:string, message:string}}
 */
export function preflightNetworkPermissions(options = {}) {
  const required = options.required || requiredTools(options);
  const sources = permissionSources(options).map(readPermissions).filter(Boolean);
  const allow = new Set();
  const deny = new Set();
  let bypass = false;
  for (const source of sources) {
    if (source.bypass) bypass = true;
    for (const tool of source.allow || []) allow.add(tool);
    for (const tool of source.deny || []) deny.add(tool);
  }

  const denied = required.filter((tool) => deny.has(tool));
  // Only an explicit denial is "blocked". An allowlist that happens to exist for other
  // tools says nothing about network access: a foreground session still prompts and
  // works. Treating that as blocked was a false positive on ordinary setups.
  const ungranted = required.filter((tool) => !deny.has(tool) && !allow.has(tool));

  const checked = sources.map((s) => ({
    path: s.path,
    declares_permissions: Boolean(s.declared),
    ...(s.unreadable ? { unreadable: s.unreadable } : {}),
  }));

  if (denied.length) {
    return {
      status: "blocked",
      required,
      missing: ungranted,
      denied,
      checked,
      remedy: REMEDY.claude,
      message: `The host explicitly denies ${denied.join(", ")}. Evidence agents cannot search, and a background subagent cannot prompt to ask. Do not run the council until this is changed: it will produce a complete-looking report with no sources behind it.`,
    };
  }
  if (bypass) {
    return {
      status: "ok",
      required,
      missing: [],
      denied: [],
      checked,
      remedy: "",
      message: `Permission mode is bypassPermissions, so all required tools (${required.join(", ") || "none"}) are granted without prompting.`,
    };
  }
  if (ungranted.length === 0 && required.length > 0) {
    return {
      status: "ok",
      required,
      missing: [],
      denied: [],
      checked,
      remedy: "",
      message: `All required network tools are on the allowlist: ${required.join(", ")}.`,
    };
  }
  return {
    status: "unknown",
    required,
    missing: ungranted,
    denied: [],
    checked,
    remedy: REMEDY.claude,
    message: `${ungranted.join(", ") || "The required tools"} are not on any persistent allowlist. A FOREGROUND session will prompt you and work normally. BACKGROUND subagents cannot prompt: their searches are blocked silently and they will answer from training knowledge while still filling in every report section. Allowlist them before a background fan-out, or run the evidence agents in the foreground.`,
  };
}
