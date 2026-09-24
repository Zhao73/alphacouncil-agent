#!/usr/bin/env node
// AlphaCouncil MCP server: newline-delimited JSON-RPC 2.0 over stdio, zero dependencies.
// Exposes keyless market-data tools and the council state machine.

import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS, callTool } from "../lib/tools.mjs";
import { VERSION } from "../lib/spec.mjs";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_TEXT = 200_000;

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function toText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated]` : text;
}

export async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: "alphacouncil", version: VERSION },
        instructions: "Equity research council. Data tools are keyless and cost no model calls. For a council run: council_plan -> user confirms -> council_start -> loop council_next (launch every task as a parallel subagent) -> council_finalize.",
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: ALL_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case "tools/call": {
      try {
        const result = await callTool(params?.name, params?.arguments || {});
        const isError = result && typeof result === "object" && result.ok === false;
        return { content: [{ type: "text", text: toText(result) }], ...(isError ? { isError: true } : {}) };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined; // notification
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
  }
}

function main() {
  const rl = createInterface({ input: process.stdin });
  const inflight = new Set();
  rl.on("line", (line) => {
    const job = onLine(line).finally(() => inflight.delete(job));
    inflight.add(job);
  });
  // Let in-flight calls answer before exiting when the host closes stdin.
  rl.on("close", () => Promise.allSettled([...inflight]).then(() => process.exit(0)));
}

async function onLine(line) {
  {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    try {
      const result = await handle(msg);
      if (msg.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (error) {
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: error.code || -32603, message: error.message } });
    }
  }
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (isMain) main();
