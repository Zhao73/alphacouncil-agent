import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listModels, runApiWorker, probeConnection, withConnection } from "../providers.mjs";
import { runWorker, workerExecutionConfig } from "../../mcp/lib/worker-execution.mjs";
import { groundingForHeadlessRun } from "../../mcp/lib/orchestrator.mjs";

const key = "synthetic-provider-key";
const profile = (provider) => ({ id: `fixture-${provider}`, name: provider, provider, model: "fixture/reasoner", base_url: provider === "openai" ? "https://api.openai.com/v1" : provider === "anthropic" ? "https://api.anthropic.com/v1" : "https://fixture.example/v1" });
const response = (provider, name, args, extra = {}) => new Response(JSON.stringify(provider === "openai"
  ? { status: "completed", model: "fixture/reasoner", output: [{ type: "function_call", call_id: "call-1", name, arguments: JSON.stringify(args) }], usage: { input_tokens: 20, output_tokens: 10 }, ...extra }
  : provider === "anthropic" ? { stop_reason: "tool_use", model: "fixture/reasoner", content: [{ type: "tool_use", id: "call-1", name, input: args }], usage: { input_tokens: 20, output_tokens: 10 }, ...extra }
    : { model: "fixture/reasoner", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 20, completion_tokens: 10 }, ...extra }), { headers: { "content-type": "application/json" } });

function lastToolResult(provider, request) {
  return JSON.parse(provider === "openai" ? request.input.at(-1).output
    : provider === "anthropic" ? request.messages.at(-1).content[0].content : request.messages.at(-1).content);
}

for (const provider of ["openai", "anthropic", "compatible"]) test(`${provider} performs a source-fetch roundtrip before returning the schema tool`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "alpha-api-schema-"));
  const schema = { type: "object", properties: { fact: { type: "string" } }, required: ["fact"], additionalProperties: false };
  const schemaFile = join(dir, "output.json");
  writeFileSync(schemaFile, JSON.stringify(schema));
  let requests = 0;
  let retrieved = 0;
  try {
    const result = await runApiWorker(profile(provider), key, "Read the primary source and return the fact.", 5000, undefined, undefined, { outputSchema: schemaFile }, {
      fetch: async (url, init) => {
        assert.equal(url, `${profile(provider).base_url}/${provider === "openai" ? "responses" : provider === "anthropic" ? "messages" : "chat/completions"}`);
        assert.equal(init.redirect, "error");
        assert.equal(provider === "anthropic" ? init.headers["x-api-key"] : init.headers.authorization, provider === "anthropic" ? key : `Bearer ${key}`);
        const body = JSON.parse(init.body);
        const final = body.tools.find((row) => (row.name || row.function?.name) === "finish_research");
        assert.deepEqual(final.parameters || final.input_schema || final.function.parameters, schema);
        assert.equal(body.tools.some((row) => row.type === "web_search" || row.name === "web_search"), false);
        if (++requests === 1) return response(provider, "fetch_url", { url: "https://www.sec.gov/fixture" });
        assert.equal(lastToolResult(provider, body).content, "PRIMARY FIXTURE FACT");
        return response(provider, "finish_research", { fact: "PRIMARY FIXTURE FACT" });
      },
      retrieve: async (url, options) => {
        retrieved += 1;
        assert.equal(url, "https://www.sec.gov/fixture");
        assert.equal(options.maxBytes, 500_000);
        assert.ok(options.signal);
        return { status: 200, final_url: url, headers: { "content-type": "text/plain" }, text: "PRIMARY FIXTURE FACT" };
      },
    });
    assert.equal(result.ok, true, result.stderr);
    assert.equal(requests, 2);
    assert.equal(retrieved, 1);
    assert.equal(result.usage.input_tokens, 40);
    assert.equal(result.activity_summary.web_search_count, 0);
    assert.equal(result.activity_summary.trace_format, "alphacouncil_api_tools_v1");
    assert.equal(result.tool_trace.filter((row) => row.type === "tool_result")[0].result.url, "https://www.sec.gov/fixture");
    assert.equal(JSON.stringify(result).includes(key), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("compatible capability probe proves the function roundtrip but never invents native search", async () => {
  let requests = 0;
  const result = await probeConnection(profile("compatible"), { apiKey: key, fetch: async (_, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.max_tokens, 32_768, "preflight must exercise the declared PM output limit");
    assert.equal(body.tools.find((row) => row.function.name === "research_schema_acceptance_check").function.parameters.properties.transport.const, "segmented_evidence_v1");
    if (++requests === 1) return response("compatible", "capability_check", {});
    return response("compatible", "finish_research", { nonce: lastToolResult("compatible", body).nonce });
  } });
  assert.equal(result.ok, true);
  assert.equal(result.capabilities.tool_calls, true);
  assert.equal(result.capabilities.structured_output, true);
  assert.equal(result.capabilities.web_search, false);
  assert.equal(requests, 2);
});

test("model list supports an unselected model draft and never substitutes a guessed list", async () => {
  const listed = await listModels({ provider: "anthropic" }, { apiKey: key, fetch: async (url, init) => {
    assert.equal(url, "https://api.anthropic.com/v1/models");
    assert.equal(init.headers["x-api-key"], key);
    return new Response(JSON.stringify({ data: [{ id: "fixture-model", display_name: "Fixture" }], has_more: true }));
  } });
  assert.deepEqual(listed.models, [{ id: "fixture-model", name: "Fixture" }]);
  assert.equal(listed.has_more, true);
  const unsupported = await listModels({ provider: "compatible", base_url: "https://fixture.example/v1" }, { apiKey: key, fetch: async () => new Response("missing", { status: 404 }) });
  assert.deepEqual(unsupported.models, []);
  assert.match(unsupported.error, /404/u);
});

test("unsupported real schema or PM output limit fails during connection probe", async () => {
  let requests = 0;
  const result = await probeConnection(profile("openai"), { apiKey: key, fetch: async (_, init) => {
    requests += 1;
    const body = JSON.parse(init.body);
    assert.equal(body.max_output_tokens, 32_768);
    assert.ok(body.tools.some((tool) => tool.name === "research_schema_acceptance_check"));
    return new Response("output or schema unsupported", { status: 400 });
  } });
  assert.equal(result.ok, false);
  assert.equal(result.capabilities.web_search, false);
  assert.match(result.error, /request_or_schema_rejected/u);
  assert.equal(requests, 1);
});

test("run request budget reserves across concurrent workers before any HTTP fanout", async () => {
  let release;
  let requests = 0;
  await withConnection({ ...profile("compatible"), budget: { max_requests: 1 } }, async () => {
    const first = runWorker("fixture one", 5000, undefined, undefined, {});
    const second = await runWorker("fixture two", 5000, undefined, undefined, {});
    assert.equal(second.ok, false);
    assert.match(second.stderr, /Run request budget/u);
    assert.equal(requests, 1);
    release(response("compatible", "finish_research", { done: true }));
    const result = await first;
    assert.equal(result.ok, true);
    assert.equal(result.run_budget.requests, 1);
    assert.equal(result.run_budget.reported_output_tokens, 10);
    assert.equal(result.run_budget.reserved_output_tokens, 0);
  }, { apiKey: key, fetch: async () => { requests += 1; return new Promise((resolve) => { release = resolve; }); } });
});

test("output budget preserves an unknown billed reservation and does not retry it away", async () => {
  let requests = 0;
  const connection = { ...profile("compatible"), budget: { max_requests: 10, max_output_tokens: 512, worker_output_tokens: 512, manager_output_tokens: 512 } };
  await withConnection(connection, async () => {
    const first = await runWorker("fixture one", 5000, undefined, undefined, {});
    assert.equal(first.ok, true);
    assert.equal(first.run_budget.reserved_output_tokens, 512);
    assert.equal(first.run_budget.usage_complete, false);
    const second = await runWorker("fixture two", 5000, undefined, undefined, {});
    assert.equal(second.ok, false);
    assert.match(second.stderr, /output-token budget/u);
    assert.equal(requests, 1);
  }, { apiKey: key, fetch: async () => { requests += 1; return response("compatible", "finish_research", { done: true }, { usage: null }); } });
});

test("OpenRouter records its platform-managed routing and actual upstream per response", async () => {
  const connection = { ...profile("compatible"), base_url: "https://openrouter.ai/api/v1" };
  await withConnection(connection, async () => {
    assert.equal(workerExecutionConfig().routing_policy.mode, "platform_managed");
    const result = await runWorker("fixture", 5000, undefined, undefined, {});
    assert.equal(result.ok, true);
    assert.deepEqual(result.actual_upstreams, ["Fixture Upstream"]);
    assert.deepEqual(result.run_budget.observed_upstreams, ["Fixture Upstream"]);
    assert.equal(result.tool_trace.find((row) => row.type === "model_response").actual_upstream, "Fixture Upstream");
  }, { apiKey: key, fetch: async (_, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.provider, { allow_fallbacks: false, require_parameters: true });
    return response("compatible", "finish_research", { done: true }, { provider: "Fixture Upstream" });
  } });
});

test("OpenAI search capability requires an actual completed native result with source URLs", async () => {
  let requests = 0;
  const result = await probeConnection(profile("openai"), { apiKey: key, fetch: async (_, init) => {
    const body = JSON.parse(init.body);
    requests += 1;
    if (requests === 1) return response("openai", "capability_check", {});
    if (requests === 2) return response("openai", "finish_research", { nonce: lastToolResult("openai", body).nonce });
    assert.deepEqual(body.include, ["reasoning.encrypted_content", "web_search_call.action.sources"]);
    assert.equal(body.max_tool_calls, 4);
    return response("openai", "finish_research", {}, { output: [
      { type: "web_search_call", id: "search-1", status: "completed", action: { type: "search", query: "SEC EDGAR", sources: [{ url: "https://www.sec.gov/edgar", title: "EDGAR" }] } },
      { type: "function_call", call_id: "final-1", name: "finish_research", arguments: '{"checked":true}' },
    ] });
  } });
  assert.equal(result.ok, true);
  assert.equal(result.capabilities.web_search, true);
  assert.equal(result.search_verification, "live_native_search_result");
  assert.equal(requests, 3);
});

test("Anthropic HTTP 200 search error does not pass native search capability", async () => {
  let requests = 0;
  const result = await probeConnection(profile("anthropic"), { apiKey: key, fetch: async (_, init) => {
    const body = JSON.parse(init.body);
    requests += 1;
    if (requests === 1) return response("anthropic", "capability_check", {});
    if (requests === 2) return response("anthropic", "finish_research", { nonce: lastToolResult("anthropic", body).nonce });
    return response("anthropic", "finish_research", {}, { content: [
      { type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "SEC EDGAR" } },
      { type: "web_search_tool_result", tool_use_id: "search-1", content: { type: "web_search_tool_result_error", error_code: "rate_limit_error" } },
      { type: "tool_use", id: "final-1", name: "finish_research", input: { checked: true } },
    ] });
  } });
  assert.equal(result.ok, true);
  assert.equal(result.capabilities.web_search, false);
  assert.equal(result.search_verification, "unavailable_or_unverified");
});

test("native search continuation retains required encrypted state without publishing private reasoning", async () => {
  for (const provider of ["anthropic", "openai"]) {
    let requests = 0;
    const result = await runApiWorker({ ...profile(provider), capabilities: { web_search: true } }, key, "Search then return the result.", 5000, undefined, undefined, {}, { fetch: async (_, init) => {
      const body = JSON.parse(init.body);
      if (++requests === 1) return response(provider, "finish_research", {}, provider === "anthropic" ? {
        stop_reason: "end_turn", content: [
          { type: "server_tool_use", id: "search-1", name: "web_search", input: { query: "fixture" } },
          { type: "web_search_tool_result", tool_use_id: "search-1", content: [{ type: "web_search_result", url: "https://www.sec.gov/", title: "SEC", encrypted_content: "OPAQUE_SEARCH_STATE" }] },
          { type: "thinking", thinking: "PRIVATE_REASONING_MARKER", signature: "OPAQUE_SIGNATURE" },
        ],
      } : { output: [
        { type: "web_search_call", id: "search-1", status: "completed", action: { query: "fixture", sources: [{ url: "https://www.sec.gov/", title: "SEC" }] } },
        { type: "reasoning", id: "reason-1", encrypted_content: "OPAQUE_REASONING_STATE", summary: [{ type: "summary_text", text: "PRIVATE_REASONING_MARKER" }] },
      ] });
      if (provider === "anthropic") assert.match(JSON.stringify(body.messages), /OPAQUE_SEARCH_STATE/u);
      else {
        assert.ok(body.include.includes("reasoning.encrypted_content"));
        assert.match(JSON.stringify(body.input), /OPAQUE_REASONING_STATE/u);
      }
      return response(provider, "finish_research", { checked: true });
    } });
    assert.equal(result.ok, true, result.stderr);
    assert.equal(requests, 2);
    assert.equal(result.activity_summary.web_search_count, 1);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REASONING_MARKER|OPAQUE_/u);
  }
});

test("plain text and auth errors fail closed without exposing response bodies or credentials", async () => {
  const plain = await runApiWorker(profile("compatible"), key, "fixture", 1000, undefined, undefined, {}, { fetch: async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"fabricated":true}' } }] })) });
  assert.equal(plain.ok, false);
  assert.match(plain.stderr, /structured tool output/u);
  const rejected = await runApiWorker(profile("openai"), key, "fixture", 1000, undefined, undefined, {}, { fetch: async () => new Response(`Echoed secret ${key}`, { status: 401 }) });
  assert.equal(rejected.ok, false);
  assert.match(rejected.stderr, /authentication_or_model_access/u);
  assert.equal(JSON.stringify(rejected).includes(key), false);
});

test("a provider echoing its credential cannot leak it through results or tool traces", async () => {
  const events = [];
  const result = await runApiWorker(profile("compatible"), key, "fixture", 1000, undefined, undefined, {}, {
    fetch: async () => response("compatible", "finish_research", { fact: key }, { model: key, provider: key }),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(JSON.stringify(events).includes(key), false);
  assert.equal(result.actual_model, "[redacted]");
  assert.equal(JSON.parse(result.text).fact, "[redacted]");
});

test("worker enforces request ceiling and cancellation stops the in-flight request", async () => {
  let requests = 0;
  const limited = await runApiWorker(profile("compatible"), key, "fixture", 5000, undefined, undefined, {}, {
    maxRequests: 99,
    fetch: async () => { requests += 1; return response("compatible", "fetch_url", { url: "http://127.0.0.1/private" }); },
  });
  assert.equal(limited.ok, false);
  assert.equal(requests, 12);
  assert.match(limited.stderr, /request limit/u);
  assert.match(limited.tool_trace.find((row) => row.type === "tool_result").result.error, /public|private|reserved|loopback/iu);
  const controller = new AbortController();
  let cancelledRequests = 0;
  const cancelled = await runApiWorker(profile("openai"), key, "fixture", 5000, undefined, undefined, { signal: controller.signal }, { fetch: async () => { cancelledRequests += 1; controller.abort(); return new Promise(() => {}); } });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.timedOut, true);
  assert.equal(cancelledRequests, 1);
});

test("frozen API config accepts arbitrary model IDs and Codex keeps pace policy", async () => {
  await withConnection({ ...profile("compatible"), capabilities: { tool_calls: true } }, async () => {
    const config = workerExecutionConfig({ councilPace: "fast" });
    assert.equal(config.provider, "compatible");
    assert.equal(config.model, "fixture/reasoner");
  }, { apiKey: key });
  await withConnection({ provider: "codex", model: "gpt-5.6-sol" }, async () => {
    const config = workerExecutionConfig({ councilPace: "fast" });
    assert.equal(config.provider, "codex_cli");
    assert.equal(config.stage_reasoning.evidence.reasoning_effort, "low");
    assert.equal(config.stage_reasoning.portfolio_manager.reasoning_effort, "medium");
  });
});

test("cancelling grounding propagates the signal and rejects before model stages", async () => {
  const controller = new AbortController();
  let signal;
  await assert.rejects(withConnection(profile("compatible"), () => groundingForHeadlessRun({ symbol: "TEST", asOf: "2026-09-06", timeoutMs: 20_000 }, async (args) => {
    signal = args.signal;
    controller.abort(new Error("user_cancelled"));
    return new Promise(() => {});
  }), { apiKey: key, signal: controller.signal }), /user_cancelled/u);
  assert.equal(signal.aborted, true);
});
