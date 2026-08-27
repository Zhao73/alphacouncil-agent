#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { SERVER_NAME, VERSION } from "../mcp/lib/constants.mjs";
import { dispatchRequest, initializeRuntime, tools } from "../mcp/lib/rpc.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MCP_PATH = "/mcp";

// Visible-host recorders require a host that can create and supervise real subagents.
// collect_evidence is synchronous. ChatGPT Work instead gets the durable background
// analyze_symbol -> read_run path, which returns promptly and survives HTTP turn limits.
const WORK_HIDDEN_TOOLS = new Set([
  "plan_visible_run",
  "record_visible_packet",
  "finalize_visible_run",
  "record_visible_decision",
  "collect_evidence",
  "record_master_opinion",
  "record_verifier_verdict",
  "record_verifier_batch",
]);

export function workTools() {
  return tools().filter((entry) => !WORK_HIDDEN_TOOLS.has(entry.name));
}

function parsePort(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ALPHACOUNCIL_WORK_PORT must be an integer from 0 to 65535; received ${String(value)}`);
  }
  return port;
}

function parseAllowedHosts(value) {
  if (!value) return undefined;
  const hosts = String(value).split(",").map((host) => host.trim()).filter(Boolean);
  return hosts.length ? hosts : undefined;
}

function createProtocolServer() {
  const server = new Server(
    { name: `${SERVER_NAME}-chatgpt-work`, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Use begin_council_selection, show the returned method catalog, and confirm_master_selection before analyze_symbol. "
        + "Real analysis starts in the background; poll read_run with the same run_id until it reaches a terminal status. "
        + "Method seats are provisional public-method simulations, not quotations or profit guarantees.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: workTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    if (WORK_HIDDEN_TOOLS.has(name) || !workTools().some((entry) => entry.name === name)) {
      throw new McpError(-32601, `Tool is not available in ChatGPT Work: ${name}`);
    }
    if (name === "analyze_symbol" && request.params.arguments?.wait_for_completion === true) {
      throw new McpError(
        -32602,
        "ChatGPT Work requires analyze_symbol to run in the background. Omit wait_for_completion or set it to false, then poll read_run.",
      );
    }
    const rpc = await dispatchRequest({
      jsonrpc: "2.0",
      id: `work-${randomUUID()}`,
      method: "tools/call",
      params: request.params,
    });
    if (!rpc) throw new McpError(-32603, `AlphaCouncil returned no response for ${name}`);
    if (rpc.error) throw new McpError(rpc.error.code, rpc.error.message, rpc.error.data);
    return rpc.result;
  });
  return server;
}

function methodNotAllowed(res) {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
}

export async function startGateway(options = {}) {
  initializeRuntime();
  const host = options.host ?? process.env.ALPHACOUNCIL_WORK_HOST ?? DEFAULT_HOST;
  const port = parsePort(options.port ?? process.env.ALPHACOUNCIL_WORK_PORT);
  const allowedHosts = options.allowedHosts ?? parseAllowedHosts(process.env.ALPHACOUNCIL_WORK_ALLOWED_HOSTS);
  const app = createMcpExpressApp({ host, ...(allowedHosts ? { allowedHosts } : {}) });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: `${SERVER_NAME}-chatgpt-work`, version: VERSION, tools: workTools().length });
  });
  app.post(MCP_PATH, async (req, res) => {
    const server = createProtocolServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      process.stderr.write(`[alphacouncil-work] request failed: ${error?.stack || error}\n`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
  app.get(MCP_PATH, (_req, res) => methodNotAllowed(res));
  app.delete(MCP_PATH, (_req, res) => methodNotAllowed(res));

  const httpServer = await new Promise((resolveServer, reject) => {
    const listening = app.listen(port, host, () => resolveServer(listening));
    listening.once("error", reject);
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    app,
    httpServer,
    host,
    port: actualPort,
    mcpUrl: new URL(`http://${host}:${actualPort}${MCP_PATH}`),
    close: () => new Promise((resolveClose, reject) => {
      httpServer.close((error) => error ? reject(error) : resolveClose());
    }),
  };
}

function realPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && realPath(process.argv[1]) === realPath(fileURLToPath(import.meta.url))) {
  const gateway = await startGateway();
  process.stderr.write(`[alphacouncil-work] listening at ${gateway.mcpUrl.href}\n`);
  const shutdown = async () => {
    await gateway.close().catch(() => {});
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
