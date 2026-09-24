// Claude Code backend: each call is one headless `claude -p` process using the user's own
// Claude Code sign-in. Structured results come back through --json-schema; web research uses
// Claude Code's WebSearch/WebFetch. No MCP servers are started, which keeps start-up fast.

import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

export const CLAUDE_MODELS = { research: "sonnet", debate: "sonnet", decision: "opus", chat: "sonnet" };

export function claudeBin(env = process.env) {
  return env.ALPHA_CLAUDE_BIN || "claude";
}

function launch(bin, args, opts) {
  // A path to Claude Code's cli.js (e.g. an npm install on Windows) runs through node.
  return /\.(c|m)?js$/.test(bin) ? spawn(process.execPath, [bin, ...args], opts) : spawn(bin, args, opts);
}

export function hasClaudeCli(env = process.env) {
  const bin = claudeBin(env);
  const r = /\.(c|m)?js$/.test(bin) ? spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" }) : spawnSync(bin, ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0 ? r.stdout.trim() : null;
}

function describeTool(block) {
  const input = block.input || {};
  if (block.name === "WebSearch") return `search: ${input.query || ""}`;
  if (block.name === "WebFetch") return `read: ${String(input.url || "").replace(/^https?:\/\//, "").slice(0, 70)}`;
  return block.name;
}

export function claudeArgs(req, model) {
  const tools = req.web ? "WebSearch,WebFetch" : "";
  const args = [
    "-p",
    "--output-format", "stream-json", "--verbose",
    "--system-prompt", req.system,
    "--model", model,
    "--tools", tools,
    "--allowedTools", tools,
    "--permission-mode", "dontAsk",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--disable-slash-commands",
  ];
  if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));
  if (req.effort) args.push("--effort", req.effort);
  if (req.onText) args.push("--include-partial-messages");
  return args;
}

export function createClaudeBackend({ models = {}, bin = claudeBin() } = {}) {
  const resolved = { ...CLAUDE_MODELS, ...models };

  function call(req) {
    const model = resolved[req.tier] || resolved.research;
    const budget = req.web ? `\n\nKeep research focused: about ${req.maxSearches || 6} web searches, then answer.` : "";
    return new Promise((resolve, reject) => {
      const child = launch(bin, claudeArgs(req, model), { cwd: tmpdir(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      let buf = "";
      let stderr = "";
      let result = null;
      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener?.("abort", onAbort);
        fn();
      };
      const kill = (why) => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        finish(() => reject(new Error(why)));
      };
      const timer = setTimeout(() => kill(`timed out after ${Math.round((req.timeoutMs || 240_000) / 1000)}s`), req.timeoutMs || 240_000);
      const onAbort = () => kill("stopped");
      req.signal?.addEventListener?.("abort", onAbort, { once: true });

      child.stdin.on("error", () => {});
      child.stdin.end(`${req.user}${budget}`);
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === "assistant") {
            for (const b of ev.message?.content || []) if (b.type === "tool_use") req.onActivity?.(describeTool(b));
          } else if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") {
            req.onText?.(ev.event.delta.text);
          } else if (ev.type === "result") {
            result = ev;
          }
        }
      });
      child.stderr.on("data", (c) => {
        stderr = (stderr + c).slice(-1500);
      });
      child.on("error", (error) => finish(() => reject(new Error(error.code === "ENOENT" ? `Claude Code (\`${bin}\`) not found` : error.message))));
      child.on("close", (code) => finish(() => {
        if (!result) return reject(new Error(`claude exited ${code}${stderr ? `: ${stderr.trim().split("\n").pop()}` : ""}`));
        if (result.is_error || result.subtype !== "success") return reject(new Error(`claude: ${result.subtype}${result.result ? ` — ${String(result.result).slice(0, 200)}` : ""}`));
        const costUsd = result.total_cost_usd || 0;
        if (!req.schema) return resolve({ text: String(result.result || ""), costUsd, model });
        let data = result.structured_output;
        if (!data) {
          try {
            data = JSON.parse(String(result.result).replace(/^```(?:json)?\s*|```\s*$/g, ""));
          } catch {
            return reject(new Error("claude returned no structured output"));
          }
        }
        return resolve({ data, costUsd, model });
      }));
    });
  }

  return { name: "claude", models: resolved, call };
}
