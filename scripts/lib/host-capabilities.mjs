import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { catalogSnapshot } from "../../mcp/lib/council-selection.mjs";
import { registry } from "../../mcp/lib/personas/registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOST_REPO_ROOT = resolve(HERE, "../..");
const CONTRACT_FILE = join(HOST_REPO_ROOT, "data/host-capabilities.v1.json");
const EXPECTED_HOSTS = ["claude_code", "codex", "opencode", "grok"];
const PROTOCOL_STEPS = [
  "begin_council_selection",
  "display_complete_returned_catalog",
  "collect_one_user_submission",
  "confirm_master_selection_display_ack_true",
  "consume_one_run_selection_receipt",
];
const SELECTOR_FIELDS = ["index", "id", "identity", "method", "best_for", "maturity", "pack_hash"];
const NUMBERED_INPUTS = ["single_index", "multiple_indexes", "inclusive_range", "stable_id", "all"];
const PLAIN_PROTOCOL_MARKERS = [
  /begin_council_selection/,
  /show \*\*every returned master individually/i,
  /stable\s+(?:number|IDs?)/i,
  /confirm_master_selection/,
  /catalog_hash/,
  /display_ack:\s*true/,
  /one-use `selection_receipt`/i,
  /missing, expired, stale or consumed/i,
];

function sha256(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function exactKeys(value, keys, path, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const missing = keys.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (missing.length) errors.push(`${path} missing: ${missing.join(", ")}`);
  if (extra.length) errors.push(`${path} unsupported: ${extra.join(", ")}`);
}

function safeRepoPath(root, rel, path, errors, { directory = false } = {}) {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) {
    errors.push(`${path} is unsafe: ${JSON.stringify(rel)}`);
    return null;
  }
  const target = resolve(root, rel);
  const back = relative(root, target);
  if (!back || back === ".." || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    errors.push(`${path} leaves the repository: ${rel}`);
    return null;
  }
  if (!existsSync(target)) {
    errors.push(`${path} does not exist: ${rel}`);
    return null;
  }
  if (!directory) {
    try { readFileSync(target); } catch { errors.push(`${path} is not a readable file: ${rel}`); return null; }
  }
  return target;
}

function arraysEqual(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function validateCommandText(text, label, errors) {
  for (const marker of PLAIN_PROTOCOL_MARKERS) {
    if (!marker.test(text)) errors.push(`${label} is missing selection protocol marker ${marker}`);
  }
  for (const field of ["identity", "method", "best_for", "maturity"]) {
    if (!text.includes(`\`${field}\``)) errors.push(`${label} does not require selector field ${field}`);
  }
  for (const grammar of ["1..N", "1-4", "1..4", "stable IDs", "`all`"]) {
    if (!text.includes(grammar)) errors.push(`${label} does not document numbered fallback grammar ${grammar}`);
  }
}

function parseJsonFile(root, rel, errors) {
  try {
    return JSON.parse(readFileSync(join(root, rel), "utf8"));
  } catch (error) {
    errors.push(`${rel} is not valid JSON: ${error.message}`);
    return null;
  }
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadHostCapabilities(file = CONTRACT_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function validateHostCapabilities(contract = loadHostCapabilities(), { root = HOST_REPO_ROOT } = {}) {
  const errors = [];
  exactKeys(contract, ["schema_version", "contract_id", "evidence_scope", "live_e2e_overall", "shared_selection_protocol", "hosts"], "contract", errors);
  if (contract.schema_version !== 1) errors.push("schema_version must be 1");
  if (contract.contract_id !== "alphacouncil-host-capabilities-v1") errors.push("contract_id is invalid");
  if (contract.evidence_scope !== "repository_static_contract_only") errors.push("evidence_scope must remain repository_static_contract_only");
  if (contract.live_e2e_overall !== "not_run") errors.push("live E2E may only change with a real external execution artifact");

  const protocol = contract.shared_selection_protocol || {};
  exactKeys(protocol, ["steps", "required_selector_fields", "numbered_inputs", "catalog_hash_semantics", "pack_hash_semantics", "receipt_semantics", "native_chooser_requirement", "numbered_fallback_requirement"], "shared_selection_protocol", errors);
  if (!arraysEqual(protocol.steps, PROTOCOL_STEPS)) errors.push("shared protocol steps changed");
  if (!arraysEqual(protocol.required_selector_fields, SELECTOR_FIELDS)) errors.push("required selector fields changed");
  if (!arraysEqual(protocol.numbered_inputs, NUMBERED_INPUTS)) errors.push("numbered input grammar changed");
  if (protocol.catalog_hash_semantics !== "sha256_of_frozen_language_catalog_snapshot") errors.push("catalog hash semantics changed");
  if (protocol.pack_hash_semantics !== "non_null_per_seat_hash_bound_into_selection_receipt") errors.push("pack hash semantics changed");
  if (protocol.receipt_semantics !== "short_lived_one_run_symbol_intent_catalog_and_selected_pack_hash_binding") errors.push("receipt semantics changed");
  if (protocol.native_chooser_requirement !== "optional_ui_sugar_only" || protocol.numbered_fallback_requirement !== "mandatory") errors.push("chooser/fallback requirements changed");

  const hosts = Array.isArray(contract.hosts) ? contract.hosts : [];
  if (!arraysEqual(hosts.map((host) => host?.host_id), EXPECTED_HOSTS)) errors.push("hosts must be Claude Code, Codex, OpenCode and Grok in canonical order");
  const canonicalPath = safeRepoPath(root, "commands/alpha.md", "canonical command", errors);
  const canonicalText = canonicalPath ? readFileSync(canonicalPath, "utf8") : "";
  if (canonicalText) validateCommandText(canonicalText, "commands/alpha.md", errors);

  for (const host of hosts) {
    const id = host?.host_id || "unknown";
    exactKeys(host, ["host_id", "display_name", "static_contract_status", "config_paths", "command_surface", "chooser", "visible_subagents", "parallelism", "model_mapping", "permissions", "resume", "degradation", "live_e2e"], id, errors);
    if (host.static_contract_status !== "shipped_not_live_verified") errors.push(`${id} overclaims static verification`);
    if (!Array.isArray(host.config_paths) || !host.config_paths.length) errors.push(`${id} has no config path`);
    for (const [index, config] of (host.config_paths || []).entries()) safeRepoPath(root, config, `${id}.config_paths[${index}]`, errors);

    const command = host.command_surface || {};
    exactKeys(command, ["canonical_source", "repository_adapters", "installation_scope", "freshness_contract"], `${id}.command_surface`, errors);
    if (command.canonical_source !== "commands/alpha.md") errors.push(`${id} does not share the canonical command source`);
    if (!Array.isArray(command.repository_adapters)) errors.push(`${id}.repository_adapters must be an array`);
    for (const [index, adapter] of (command.repository_adapters || []).entries()) {
      const adapterPath = safeRepoPath(root, adapter, `${id}.repository_adapters[${index}]`, errors);
      if (!adapterPath || !canonicalText) continue;
      const text = readFileSync(adapterPath, "utf8");
      if (text !== canonicalText) errors.push(`${id} adapter ${adapter} is stale`);
      validateCommandText(text, adapter, errors);
    }
    if (id === "codex") {
      if (command.repository_adapters.length !== 0 || command.freshness_contract !== "compare_if_installed") errors.push("Codex command must remain a user-scoped copy, not a fake repository adapter");
    } else if (!command.repository_adapters.length || command.freshness_contract !== "exact_copy") {
      errors.push(`${id} must ship an exact repository command adapter`);
    }

    exactKeys(host.chooser, ["native", "numbered_fallback"], `${id}.chooser`, errors);
    if (host.chooser?.native !== "optional_not_required_not_live_verified" || host.chooser?.numbered_fallback !== "required_shipped") errors.push(`${id} chooser record overclaims capability or weakens fallback`);
    exactKeys(host.visible_subagents, ["support", "definition_surface", "live_status"], `${id}.visible_subagents`, errors);
    if (host.visible_subagents?.live_status !== "not_run") errors.push(`${id} visible subagents falsely claim live execution`);
    if (host.visible_subagents?.definition_surface) safeRepoPath(root, host.visible_subagents.definition_surface, `${id}.visible_subagents.definition_surface`, errors, { directory: true });
    exactKeys(host.parallelism, ["support", "configured_limit", "live_status"], `${id}.parallelism`, errors);
    if (host.parallelism?.support !== "host_managed_best_effort" || host.parallelism?.configured_limit !== null || host.parallelism?.live_status !== "not_run") errors.push(`${id} parallelism must remain unmeasured host-managed best effort`);
    exactKeys(host.model_mapping, ["policy", "fast", "standard", "deep"], `${id}.model_mapping`, errors);
    exactKeys(host.permissions, ["policy", "network", "edit", "shell"], `${id}.permissions`, errors);
    exactKeys(host.resume, ["saved_run_artifacts", "host_session_resume", "live_status"], `${id}.resume`, errors);
    if (host.resume?.saved_run_artifacts !== "server_supported" || host.resume?.host_session_resume !== "not_live_verified" || host.resume?.live_status !== "not_run") errors.push(`${id} resume record overclaims a host session test`);
    if (!Array.isArray(host.degradation) || host.degradation.length < 3) errors.push(`${id} must declare at least three degradation paths`);
    exactKeys(host.live_e2e, ["status", "artifact"], `${id}.live_e2e`, errors);
    if (host.live_e2e?.status !== "not_run" || host.live_e2e?.artifact !== null) errors.push(`${id} live E2E must remain not_run with no fabricated artifact`);
  }

  const byId = new Map(hosts.map((host) => [host.host_id, host]));
  const expectedModels = {
    claude_code: { policy: "generated_per_tier", fast: "haiku", standard: "sonnet", deep: "opus" },
    codex: { policy: "host_default", fast: null, standard: null, deep: null },
    opencode: { policy: "generated_per_tier", fast: "anthropic/claude-haiku-4-5-20251001", standard: "anthropic/claude-sonnet-4-5", deep: "anthropic/claude-opus-4-5" },
    grok: { policy: "host_default", fast: null, standard: null, deep: null },
  };
  for (const [id, expected] of Object.entries(expectedModels)) {
    if (JSON.stringify(byId.get(id)?.model_mapping) !== JSON.stringify(expected)) errors.push(`${id} model mapping differs from shipped generator behavior`);
  }

  const claudePlugin = parseJsonFile(root, ".claude-plugin/plugin.json", errors);
  const claudeServer = claudePlugin?.mcpServers?.["alphacouncil-agent"];
  if (claudePlugin?.commands !== "./commands/" || claudeServer?.command !== "node" || JSON.stringify(claudeServer?.args) !== JSON.stringify(["${CLAUDE_PLUGIN_ROOT}/mcp/server.mjs"])) errors.push("Claude Code plugin command or MCP adapter shape changed");
  const codexPlugin = parseJsonFile(root, ".codex-plugin/plugin.json", errors);
  const inlineCodexServer = codexPlugin?.mcpServers?.["alphacouncil-agent"];
  if (inlineCodexServer?.command !== "node"
    || JSON.stringify(inlineCodexServer?.args) !== JSON.stringify(["./mcp/server.mjs"])
    || inlineCodexServer?.cwd !== ".") {
    errors.push("Codex plugin no longer carries the canonical inline MCP server entry");
  }
  const codexMcp = parseJsonFile(root, "codex.mcp.json", errors);
  const codexServer = codexMcp?.mcpServers?.["alphacouncil-agent"];
  if (codexServer?.command !== "node" || JSON.stringify(codexServer?.args) !== JSON.stringify(["./mcp/server.mjs"]) || codexServer?.cwd !== ".") errors.push("codex.mcp.json does not resolve the canonical Node server entry");
  if (existsSync(join(root, ".mcp.json"))) errors.push("root .mcp.json must remain absent because OpenCode compatibility loaders auto-import it as a duplicate server");
  const opencode = parseJsonFile(root, "opencode.json", errors);
  const openServer = opencode?.mcp?.["alphacouncil-agent"];
  if (openServer?.type !== "local" || openServer?.enabled !== true || JSON.stringify(openServer?.command) !== JSON.stringify(["node", "./mcp/server.mjs"])) errors.push("OpenCode MCP adapter shape changed");
  const grokConfig = readFileSync(join(root, ".grok/config.toml"), "utf8");
  for (const marker of ["[mcp_servers.alphacouncil-agent]", 'command = "node"', 'args = ["./mcp/server.mjs"]', "enabled = true"]) {
    if (!grokConfig.includes(marker)) errors.push(`Grok MCP adapter lacks ${marker}`);
  }

  const reg = registry();
  for (const personaId of [...reg.ids("analyst"), ...reg.ids("debate")]) {
    const persona = reg.get(personaId);
    const claudeAgentPath = safeRepoPath(root, `.claude/agents/alphacouncil-${personaId}.md`, `${personaId}.claude_agent`, errors);
    if (claudeAgentPath) {
      const text = readFileSync(claudeAgentPath, "utf8");
      const model = byId.get("claude_code")?.model_mapping?.[persona.model_tier];
      if (!new RegExp(`^model: ${regexEscape(model)}$`, "m").test(text)) errors.push(`${personaId} Claude model mapping is stale`);
      if (/^tools:.*(?:Bash|Edit|Write)/m.test(text)) errors.push(`${personaId} Claude agent grants mutation tools`);
    }
    const openAgentPath = safeRepoPath(root, `.opencode/agent/alphacouncil-${personaId}.md`, `${personaId}.opencode_agent`, errors);
    if (openAgentPath) {
      const text = readFileSync(openAgentPath, "utf8");
      const model = byId.get("opencode")?.model_mapping?.[persona.model_tier];
      if (!new RegExp(`^model: ${regexEscape(model)}$`, "m").test(text)) errors.push(`${personaId} OpenCode model mapping is stale`);
      if (!/^  edit: deny$/m.test(text) || !/^  bash: deny$/m.test(text)) errors.push(`${personaId} OpenCode mutation permissions are not denied`);
      const expectedWeb = persona.tools_hint?.includes("websearch") ? "allow" : "deny";
      if (!new RegExp(`^  websearch: ${expectedWeb}$`, "m").test(text)) errors.push(`${personaId} OpenCode web permission differs from persona policy`);
    }
    const grokAgentPath = safeRepoPath(root, `.grok/agents/alphacouncil-${personaId}.md`, `${personaId}.grok_agent`, errors);
    if (grokAgentPath && !/^permission_mode: plan$/m.test(readFileSync(grokAgentPath, "utf8"))) errors.push(`${personaId} Grok agent is not in plan mode`);
  }

  const catalog = catalogSnapshot("English");
  if (catalog.count !== CANONICAL_MASTER_COUNT || !arraysEqual(catalog.all_master_ids, registry().ids("master"))) errors.push(`runtime selector catalog is not the canonical ${CANONICAL_MASTER_COUNT}-seat registry order`);
  if (!/^[a-f0-9]{64}$/.test(catalog.catalog_hash)) errors.push("runtime catalog hash is not sha256 hex");
  for (const [index, seat] of catalog.masters.entries()) {
    if (seat.index !== index + 1 || seat.id !== catalog.all_master_ids[index]) errors.push(`runtime selector index/id drift at ${index + 1}`);
    for (const field of SELECTOR_FIELDS) if (seat[field] === null || seat[field] === undefined || seat[field] === "") errors.push(`${seat.id} lacks selector field ${field}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(seat.pack_hash)) errors.push(`${seat.id} pack_hash is not a canonical sha256 digest`);
  }

  return { valid: errors.length === 0, errors, catalog_hash: catalog.catalog_hash, selector_ids: catalog.all_master_ids };
}

export function codexPromptDirectory() {
  return process.env.ALPHACOUNCIL_CODEX_PROMPTS_DIR || join(os.homedir(), ".codex", "prompts");
}

export function auditHostAdapterFreshness({ root = HOST_REPO_ROOT, codexPromptsDir = codexPromptDirectory() } = {}) {
  const contract = loadHostCapabilities(join(root, "data/host-capabilities.v1.json"));
  const canonicalPath = join(root, "commands/alpha.md");
  const canonical = existsSync(canonicalPath) ? readFileSync(canonicalPath, "utf8") : null;
  const adapters = [];
  for (const host of contract.hosts) {
    for (const rel of host.command_surface.repository_adapters) {
      const path = join(root, rel);
      const content = existsSync(path) ? readFileSync(path, "utf8") : null;
      adapters.push({ host_id: host.host_id, path: rel, status: content === null ? "missing" : content === canonical ? "current" : "stale" });
    }
  }
  const codexPath = join(codexPromptsDir, "alpha.md");
  const codexContent = existsSync(codexPath) ? readFileSync(codexPath, "utf8") : null;
  const codexUserPrompt = {
    host_id: "codex",
    path: codexPath,
    status: codexContent === null ? "not_installed" : codexContent === canonical ? "current" : "stale",
  };
  return {
    canonical_path: "commands/alpha.md",
    canonical_hash: canonical === null ? null : sha256(canonical),
    adapters,
    codex_user_prompt: codexUserPrompt,
    stale: adapters.filter((adapter) => adapter.status !== "current"),
    live_e2e: Object.fromEntries(contract.hosts.map((host) => [host.host_id, host.live_e2e.status])),
  };
}

export function hostCapabilityReport(contract = loadHostCapabilities()) {
  const validation = validateHostCapabilities(contract);
  const freshness = auditHostAdapterFreshness();
  return {
    schema_version: 1,
    contract_id: contract.contract_id,
    evidence_scope: contract.evidence_scope,
    valid: validation.valid,
    errors: validation.errors,
    selector_count: validation.selector_ids.length,
    selector_ids: validation.selector_ids,
    catalog_hash: validation.catalog_hash,
    command_hash: freshness.canonical_hash,
    repository_adapters: freshness.adapters,
    codex_user_prompt: freshness.codex_user_prompt,
    live_e2e: freshness.live_e2e,
    hosts: contract.hosts.map((host) => ({
      host_id: host.host_id,
      display_name: host.display_name,
      chooser: host.chooser,
      visible_subagents: host.visible_subagents.support,
      parallelism: host.parallelism.support,
      model_mapping: host.model_mapping.policy,
      permissions: host.permissions.policy,
      resume: host.resume.host_session_resume,
      degradation_count: host.degradation.length,
      live_e2e: host.live_e2e.status,
    })),
  };
}
