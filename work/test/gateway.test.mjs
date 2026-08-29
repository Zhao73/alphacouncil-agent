import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startGateway, workTools } from "../server.mjs";

async function withClient(run) {
  const gateway = await startGateway({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "alphacouncil-work-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(gateway.mcpUrl);
  try {
    await client.connect(transport);
    return await run({ gateway, client });
  } finally {
    await client.close().catch(() => {});
    await gateway.close().catch(() => {});
  }
}

test("Work surface exposes 26 chat-safe tools with complete metadata", async () => {
  await withClient(async ({ gateway, client }) => {
    const health = await fetch(new URL("/healthz", gateway.mcpUrl));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      service: "alphacouncil-agent-chatgpt-work",
      version: "1.6.0",
      tools: 26,
    });

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 26);
    assert.deepEqual(listed.tools.map((tool) => tool.name), workTools().map((tool) => tool.name));
    for (const tool of listed.tools) {
      assert.ok(tool.title, `${tool.name} needs a human-readable title`);
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} needs an input schema`);
      assert.equal(tool.outputSchema?.type, "object", `${tool.name} needs an output schema`);
      for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        assert.equal(typeof tool.annotations?.[key], "boolean", `${tool.name} needs ${key}`);
      }
    }
    for (const hidden of [
      "plan_visible_run", "record_visible_packet", "finalize_visible_run", "record_visible_decision",
      "collect_evidence", "record_master_opinion", "record_verifier_verdict", "record_verifier_batch",
    ]) {
      assert.ok(!listed.tools.some((tool) => tool.name === hidden), `${hidden} must stay off the Work surface`);
    }
  });
});

test("official Streamable HTTP client receives real council catalog content", async () => {
  await withClient(async ({ client }) => {
    const response = await client.callTool({ name: "list_council_options", arguments: { language: "en" } });
    assert.equal(response.isError, undefined);
    assert.ok(response.content.some((part) => part.type === "text" && /browse-only/i.test(part.text)));
    assert.equal(response.structuredContent?.masters?.length, 26);
  });
});

test("Work rejects synchronous council execution before it can time out", async () => {
  await withClient(async ({ client }) => {
    await assert.rejects(
      client.callTool({ name: "analyze_symbol", arguments: { symbol: "AAPL", selection_receipt: "invalid", wait_for_completion: true } }),
      /requires analyze_symbol to run in the background/u,
    );
  });
});

test("localhost gateway rejects a forged Host header", async () => {
  const gateway = await startGateway({ host: "127.0.0.1", port: 0 });
  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.get({
        hostname: gateway.host,
        port: gateway.port,
        path: "/healthz",
        headers: { Host: "attacker.example" },
      }, resolve);
      request.once("error", reject);
    });
    response.resume();
    assert.equal(response.statusCode, 403);
  } finally {
    await gateway.close().catch(() => {});
  }
});

test("concurrent HTTP clients keep tool responses isolated", async () => {
  const gateway = await startGateway({ host: "127.0.0.1", port: 0 });
  const clients = ["one", "two"].map((name) => ({
    client: new Client({ name, version: "1.0.0" }),
    transport: new StreamableHTTPClientTransport(gateway.mcpUrl),
  }));
  try {
    await Promise.all(clients.map(({ client, transport }) => client.connect(transport)));
    const [options, modes] = await Promise.all([
      clients[0].client.callTool({ name: "list_council_options", arguments: { language: "en" } }),
      clients[1].client.callTool({ name: "compare_summary_modes", arguments: { language: "en" } }),
    ]);
    assert.equal(options.structuredContent?.masters?.length, 26);
    assert.ok(Array.isArray(modes.structuredContent?.modes));
    assert.notDeepEqual(options.structuredContent, modes.structuredContent);
  } finally {
    await Promise.all(clients.map(({ client }) => client.close().catch(() => {})));
    await gateway.close().catch(() => {});
  }
});
