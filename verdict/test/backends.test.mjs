import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { isolateHome } from "./helpers.mjs";

isolateHome();
const { createApiBackend, estimateCost } = await import("../src/models/api.mjs");
const { createClaudeBackend, claudeArgs } = await import("../src/models/claude.mjs");
const { selectBackend } = await import("../src/models/index.mjs");
const { DESK_SCHEMA } = await import("../src/engine/schemas.mjs");

function fakeStream(message, blocks = message.content) {
  const handlers = {};
  return {
    on(ev, cb) {
      handlers[ev] = cb;
      return this;
    },
    async finalMessage() {
      for (const b of blocks) handlers.contentBlock?.(b);
      for (const b of blocks) if (b.type === "text") handlers.text?.(b.text);
      return message;
    },
  };
}

function mockClient(script) {
  const requests = [];
  const make = (beta) => ({
    stream(params) {
      requests.push({ beta, params: structuredClone(params) });
      const next = script.shift();
      if (next instanceof Error) throw next;
      return fakeStream(next);
    },
  });
  return { requests, messages: make(false), beta: { messages: make(true) } };
}

const usage = { input_tokens: 1000, output_tokens: 500, server_tool_use: { web_search_requests: 2 } };

test("api: research resumes pause_turn, reports searches, returns the submit tool input", async () => {
  const client = mockClient([
    { stop_reason: "pause_turn", usage, content: [{ type: "server_tool_use", name: "web_search", input: { query: "acme guidance" } }] },
    { stop_reason: "tool_use", usage, content: [{ type: "server_tool_use", name: "web_fetch", input: { url: "https://acme.test/ir" } }, { type: "tool_use", name: "submit", input: { summary: "ok" } }] },
  ]);
  const activity = [];
  const backend = createApiBackend({ client });
  const r = await backend.call({ tier: "research", system: "s", user: "u", schema: DESK_SCHEMA, web: true, maxSearches: 5, onActivity: (a) => activity.push(a) });
  assert.deepEqual(r.data, { summary: "ok" });
  assert.deepEqual(activity, ["search: acme guidance", "read: acme.test/ir"]);
  const first = client.requests[0].params;
  assert.equal(first.model, "claude-sonnet-5");
  assert.deepEqual(first.tools.map((x) => x.type || x.name), ["web_search_20260209", "web_fetch_20260209", "submit"]);
  assert.equal(first.tools[2].strict, true);
  // pause_turn: the paused assistant turn is resent without an extra user nudge.
  const second = client.requests[1].params.messages;
  assert.equal(second.length, 2);
  assert.equal(second[1].role, "assistant");
  assert.ok(r.costUsd > 0);
});

test("api: decision uses structured output on opus with refusal fallbacks, and retries plain if rejected", async () => {
  const bad = Object.assign(new Error("fallbacks: unsupported beta"), { status: 400 });
  const client = mockClient([bad, { stop_reason: "end_turn", usage, content: [{ type: "text", text: '{"rating":"Hold"}' }] }]);
  const r = await createApiBackend({ client }).call({ tier: "decision", system: "s", user: "u", schema: { type: "object" } });
  assert.deepEqual(r.data, { rating: "Hold" });
  assert.equal(client.requests[0].beta, true);
  assert.equal(client.requests[0].params.fallbacks, "default");
  assert.equal(client.requests[1].beta, false);
  assert.equal(client.requests[1].params.output_config.format.type, "json_schema");
});

test("api: refusals surface as errors", async () => {
  const client = mockClient([{ stop_reason: "refusal", stop_details: { category: "cyber" }, usage, content: [] }]);
  await assert.rejects(createApiBackend({ client }).call({ tier: "debate", system: "s", user: "u", schema: { type: "object" } }), /declined/);
});

test("api: cost estimate", () => {
  assert.equal(estimateCost("claude-sonnet-5", { input_tokens: 1e6, output_tokens: 1e5 }), 3);
});

const fakeClaude = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));

test("claude: args carry the schema and tools; stdin prompt; structured output and activity", async () => {
  const args = claudeArgs({ system: "sys", web: true, schema: { type: "object" }, effort: "low" }, "sonnet");
  const val = (f) => args[args.indexOf(f) + 1];
  assert.equal(val("--tools"), "WebSearch,WebFetch");
  assert.equal(val("--permission-mode"), "dontAsk");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(val("--json-schema"), '{"type":"object"}');
  assert.ok(!args.includes("u"), "prompt is not on the command line");

  const activity = [];
  const b = createClaudeBackend({ bin: fakeClaude });
  const r = await b.call({ tier: "research", system: "s", user: "PROMPT-XYZ", schema: { type: "object" }, web: true, onActivity: (a) => activity.push(a) });
  assert.equal(r.data.echo, "PROMPT-XYZ");
  assert.equal(r.costUsd, 0.05);
  assert.deepEqual(activity, ["search: acme"]);
  const t = await b.call({ tier: "chat", system: "s", user: "hello", onText: () => {} });
  assert.match(t.text, /hello/);
});

test("claude: timeout kills the worker", async () => {
  process.env.FAKE_CLAUDE_HANG = "1";
  try {
    await assert.rejects(createClaudeBackend({ bin: fakeClaude }).call({ tier: "research", system: "s", user: "u", timeoutMs: 800 }), /timed out/);
  } finally {
    delete process.env.FAKE_CLAUDE_HANG;
  }
});

test("engine selection: api with a key, claude without, clear error with neither", async () => {
  assert.equal((await selectBackend({ env: { ANTHROPIC_API_KEY: "sk-test" } })).name, "api");
  assert.equal((await selectBackend({ env: { VERDICT_CLAUDE_BIN: fakeClaude } })).name, "claude");
  await assert.rejects(selectBackend({ env: { VERDICT_CLAUDE_BIN: "/nonexistent/claude" } }), /No engine available/);
  await assert.rejects(selectBackend({ engine: "api", env: {} }), /ANTHROPIC_API_KEY/);
});
