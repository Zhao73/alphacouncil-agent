import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../mcp/lib/constants.mjs";
import { codexCommand } from "../mcp/lib/codex.mjs";

const sessionSecrets = new Map();
const SERVICE = "io.github.Zhao73.alphacouncil.terminal";
const PROVIDERS = new Set(["codex", "openai", "anthropic", "compatible"]);
const DEFAULT_URLS = { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com/v1" };
export const DEFAULT_CONNECTION_BUDGET = Object.freeze({ max_requests: 160, max_output_tokens: 600_000, worker_output_tokens: 8192, manager_output_tokens: 32_768 });
const profileRoot = (options = {}) => join(options.dataDir || DATA_DIR, "terminal");
const configFile = (options) => join(profileRoot(options), "connections.json");

export function normalizeConnection(input) {
  if (!input || !PROVIDERS.has(input.provider)) throw new Error("Unsupported model provider");
  const id = input.id || randomUUID();
  if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(id)) throw new Error("Invalid connection ID");
  const model = String(input.model || "").trim();
  if (input.provider !== "codex" && !model) throw new Error("A model ID is required");
  if (model.length > 128 || /[\x00-\x20\x7f]/u.test(model)) throw new Error("Invalid model ID");
  const name = String(input.name || input.provider).trim();
  if (!name || name.length > 100 || /[\x00-\x1f\x7f]/u.test(name)) throw new Error("Invalid connection name");
  const profile = { id, name, provider: input.provider, model: model || null };
  if (input.provider !== "codex") {
    const url = new URL(input.base_url || DEFAULT_URLS[input.provider]);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("API Base URL must use HTTPS without credentials, query or fragment");
    }
    if (input.provider !== "compatible" && url.href.replace(/\/$/u, "") !== DEFAULT_URLS[input.provider]) {
      throw new Error("Use the compatible provider for a custom Base URL");
    }
    profile.base_url = url.href.replace(/\/$/u, "");
    if (input.provider === "compatible") profile.routing_policy = url.hostname === "openrouter.ai"
      ? { mode: "platform_managed", request_fallbacks: false, require_parameters: true }
      : { mode: "endpoint_managed" };
    profile.budget = { ...DEFAULT_CONNECTION_BUDGET };
    for (const [field, maximum] of Object.entries({ max_requests: 1000, max_output_tokens: 5_000_000, worker_output_tokens: 32_768, manager_output_tokens: 65_536 })) {
      const value = input.budget?.[field] ?? DEFAULT_CONNECTION_BUDGET[field];
      if (!Number.isSafeInteger(value) || value < (field === "max_requests" ? 1 : 512) || value > maximum) throw new Error(`Invalid connection budget: ${field}`);
      profile.budget[field] = value;
    }
    if (profile.budget.max_output_tokens < Math.max(profile.budget.worker_output_tokens, profile.budget.manager_output_tokens)) throw new Error("Run output-token budget must cover at least one complete worker/manager request");
  }
  return profile;
}

export function listConnections(options = {}) {
  const file = configFile(options);
  if (!existsSync(file)) return [];
  const entries = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(entries)) throw new Error("Invalid connection configuration");
  return entries.map((row) => ({ ...normalizeConnection(row), storage: row.storage, secret_ref: row.secret_ref }));
}

export function getConnection(id, options = {}) {
  const profile = listConnections(options).find((entry) => entry.id === id);
  if (!profile) throw new Error("Model connection not found");
  return profile;
}

function writeProfiles(profiles, options) {
  const dir = profileRoot(options);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = configFile(options);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}

function command(commandName, args, { input = "", signal, onOutput, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Operation cancelled")); return; }
    const child = spawn(commandName, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      error ? reject(error) : resolve(value);
    };
    const cancel = () => { child.kill(); finish(new Error("Operation cancelled")); };
    const timer = setTimeout(cancel, timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    child.on("error", () => finish(new Error("Secure storage or official runtime is unavailable")));
    child.on("close", (code) => finish(null, { code, output }));
    child.stdout.on("data", (data) => { output = (output + data.toString()).slice(0, 32_768); onOutput?.(data.toString()); });
    child.stderr.on("data", (data) => { if (onOutput) onOutput(data.toString()); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function secureSecret(action, profile, value, options = {}) {
  const platform = options.platform || process.platform;
  const execute = options.command || command;
  const encoded = value === undefined ? "" : Buffer.from(value).toString("base64");
  let result;
  if (platform === "darwin") {
    if (action === "set") {
      result = await execute("/usr/bin/security", ["-i"], {
        input: `add-generic-password -U -a ${profile.id} -s ${SERVICE} -w ${encoded}\n`,
      });
      if (result.code === 0 && await secureSecret("get", profile, undefined, options) !== value) {
        throw new Error("System secure storage did not confirm the key was saved; select session storage");
      }
    } else {
      result = await execute("/usr/bin/security", [action === "get" ? "find-generic-password" : "delete-generic-password", "-a", profile.id, "-s", SERVICE, ...(action === "get" ? ["-w"] : [])]);
    }
  } else if (platform === "linux") {
    const args = action === "set" ? ["store", "--label=AlphaCouncil model key"] : [action === "get" ? "lookup" : "clear"];
    result = await execute("secret-tool", [...args, "service", SERVICE, "account", profile.id], { input: encoded });
  } else if (platform === "win32") {
    const file = join(profileRoot(options), `${profile.id}.dpapi`);
    if (action === "delete") { rmSync(file, { force: true }); return; }
    const method = action === "set" ? "Protect" : "Unprotect";
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s.Trim()); $r=[Security.Cryptography.ProtectedData]::${method}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      input: action === "set" ? encoded : readFileSync(file, "utf8"),
    });
    if (result.code === 0 && action === "set") {
      mkdirSync(profileRoot(options), { recursive: true, mode: 0o700 });
      writeFileSync(file, result.output.trim(), { mode: 0o600 });
    }
  } else throw new Error("System secure storage is unavailable; select session storage");
  if (result.code !== 0) throw new Error("System secure storage is unavailable or access was denied; select session storage");
  if (action === "get") return Buffer.from(result.output.trim(), "base64").toString("utf8");
}

export async function saveConnection(input, options = {}) {
  const profiles = listConnections(options);
  const previous = profiles.find((entry) => entry.id === input.id);
  const profile = normalizeConnection({ ...input, budget: input.budget || previous?.budget });
  if (profile.provider !== "codex") {
    const storage = input.storage || previous?.storage || (process.platform === "linux" ? "session" : "system");
    if (!["session", "system"].includes(storage)) throw new Error("Invalid credential storage choice");
    const apiKey = input.apiKey === undefined ? await getConnectionSecret(previous, options) : String(input.apiKey).trim();
    if (!apiKey || apiKey.length > 16_384) throw new Error("A valid API key is required");
    if (storage === "session") sessionSecrets.set(profile.id, apiKey);
    else await secureSecret("set", profile, apiKey, options);
    profile.storage = storage;
    profile.secret_ref = `${storage}:${profile.id}`;
    if (previous?.storage === "system" && storage === "session") await secureSecret("delete", previous, undefined, options);
    if (storage === "system") sessionSecrets.delete(profile.id);
  } else if (previous) {
    if (previous.storage === "system") await secureSecret("delete", previous, undefined, options);
    sessionSecrets.delete(profile.id);
  }
  writeProfiles([...profiles.filter((entry) => entry.id !== profile.id), profile], options);
  return profile;
}

export async function getConnectionSecret(profile, options = {}) {
  if (!profile || profile.provider === "codex") return undefined;
  const checked = normalizeConnection(profile);
  if (profile.secret_ref !== `${profile.storage}:${checked.id}`) throw new Error("Invalid credential reference");
  const value = profile.storage === "session" ? sessionSecrets.get(profile.id)
    : profile.storage === "system" ? await secureSecret("get", checked, undefined, options) : undefined;
  if (!value) throw new Error("Session key is unavailable; reconnect this model");
  return value;
}

export async function deleteConnection(id, options = {}) {
  const profile = getConnection(id, options);
  if (profile.storage === "system") await secureSecret("delete", profile, undefined, options);
  sessionSecrets.delete(id);
  writeProfiles(listConnections(options).filter((entry) => entry.id !== id), options);
}

function officialCommand(args) {
  const executable = codexCommand();
  return /\.[cm]?js$/iu.test(executable) ? [process.execPath, [executable, ...args]] : [executable, args];
}

export async function loginCodex({ device = false, signal, onOutput } = {}) {
  const [executable, args] = officialCommand(["login", ...(device ? ["--device-auth"] : [])]);
  const result = await command(executable, args, { signal, onOutput, timeoutMs: 300_000 });
  return { ok: result.code === 0, method: "official_codex_cli" };
}

export async function logoutCodex({ signal } = {}) {
  const [executable, args] = officialCommand(["logout"]);
  const result = await command(executable, args, { signal });
  return { ok: result.code === 0, method: "official_codex_cli" };
}

export async function getCodexLoginStatus({ signal } = {}) {
  const [executable, args] = officialCommand(["login", "status"]);
  try {
    let authMode = "unknown";
    const result = await command(executable, args, { signal, onOutput(text) {
      if (/using ChatGPT/iu.test(text)) authMode = "chatgpt";
      else if (/using an API key/iu.test(text)) authMode = "api_key";
    } });
    return { authenticated: result.code === 0, auth_mode: authMode, method: "official_codex_cli", detail: result.code === 0 ? "Official Codex login available" : "Official Codex login required" };
  } catch { return { authenticated: false, method: "official_codex_cli", detail: "Official Codex runtime unavailable" }; }
}
