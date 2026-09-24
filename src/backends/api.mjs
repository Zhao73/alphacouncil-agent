// Anthropic API backend (official SDK). Research calls use server-side web search/fetch and
// return their JSON through a strict `submit` tool (structured output is incompatible with
// the citations web search produces). Debate/decision calls use structured output directly.

import Anthropic from "@anthropic-ai/sdk";

export const API_MODELS = { research: "claude-sonnet-5", debate: "claude-sonnet-5", decision: "claude-opus-5", chat: "claude-sonnet-5" };

// USD per million tokens [input, output]; web search $10 per 1,000. An estimate for display.
const PRICES = {
  "claude-fable-5-1": [10, 50], "claude-fable-5": [10, 50], "claude-opus-5-5": [4, 20], "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25], "claude-sonnet-5": [2, 10], "claude-sonnet-4-6": [3, 15], "claude-haiku-4-5": [1, 5],
};

export function estimateCost(model, usage = {}) {
  const [inp, out] = PRICES[model] || [5, 25];
  const tokens = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  return (tokens * inp + (usage.output_tokens || 0) * out) / 1e6 + searches * 0.01;
}

export function hasApiCredentials(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

function withTimeout(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
  const onAbort = () => controller.abort(signal.reason);
  signal?.addEventListener?.("abort", onAbort, { once: true });
  return { signal: controller.signal, done: () => { clearTimeout(timer); signal?.removeEventListener?.("abort", onAbort); } };
}

function describeServerTool(block) {
  const input = block.input || {};
  if (block.name === "web_search") return `search: ${input.query || ""}`;
  if (block.name === "web_fetch") return `read: ${String(input.url || "").replace(/^https?:\/\//, "").slice(0, 70)}`;
  return block.name;
}

export function createApiBackend({ client = null, models = {} } = {}) {
  const anthropic = client || new Anthropic();
  const resolved = { ...API_MODELS, ...models };

  /** One streamed request; reports server tool activity and text deltas as they happen. */
  async function streamOnce(params, { signal, onActivity, onText, useFallbacks }) {
    const body = useFallbacks ? { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : params;
    const api = useFallbacks ? anthropic.beta.messages : anthropic.messages;
    const stream = api.stream(body, { signal });
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use") onActivity?.(describeServerTool(block));
    });
    if (onText) stream.on("text", (delta) => onText(delta));
    return stream.finalMessage();
  }

  async function send(params, opts) {
    const useFallbacks = /^claude-(opus-5$|fable-5)/.test(params.model);
    try {
      return await streamOnce(params, { ...opts, useFallbacks });
    } catch (error) {
      // Server-side refusal fallbacks are a beta; if an account or proxy rejects it, run plain.
      if (useFallbacks && error?.status === 400 && /fallback|beta/i.test(String(error.message))) return streamOnce(params, { ...opts, useFallbacks: false });
      throw error;
    }
  }

  function checkStop(msg) {
    if (msg.stop_reason === "refusal") throw new Error(`the model declined this request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ""}`);
  }

  /**
   * @param {{tier:string, system:string, user:string, schema?:object, web?:boolean, effort?:string,
   *          maxSearches?:number, timeoutMs?:number, signal?:AbortSignal,
   *          onActivity?:(s:string)=>void, onText?:(s:string)=>void}} req
   */
  async function call(req) {
    const model = resolved[req.tier] || resolved.research;
    const t = withTimeout(req.signal, req.timeoutMs || 240_000);
    let cost = 0;
    try {
      if (req.web && req.schema) {
        const tools = [
          { type: "web_search_20260209", name: "web_search", max_uses: req.maxSearches || 6 },
          { type: "web_fetch_20260209", name: "web_fetch", max_uses: Math.max(3, Math.round((req.maxSearches || 6) * 0.7)) },
          { name: "submit", description: "Submit your final result. Call it exactly once, after your research.", input_schema: req.schema, strict: true },
        ];
        const messages = [{ role: "user", content: `${req.user}\n\nWhen your research is done, call the submit tool with your result.` }];
        for (let turn = 0; turn < 8; turn += 1) {
          const msg = await send({ model, max_tokens: 16000, system: req.system, messages, tools, output_config: { effort: req.effort || "medium" } }, { signal: t.signal, onActivity: req.onActivity });
          cost += estimateCost(model, msg.usage);
          checkStop(msg);
          const submit = msg.content.find((b) => b.type === "tool_use" && b.name === "submit");
          if (submit) return { data: submit.input, costUsd: cost, model };
          messages.push({ role: "assistant", content: msg.content });
          // pause_turn: resend as-is and the server resumes its own tool loop.
          if (msg.stop_reason !== "pause_turn") messages.push({ role: "user", content: "Stop researching now and call the submit tool with your result." });
        }
        throw new Error("no result after 8 turns");
      }
      const params = { model, max_tokens: req.schema ? 12000 : 8000, system: req.system, messages: [{ role: "user", content: req.user }], output_config: { effort: req.effort || "medium", ...(req.schema ? { format: { type: "json_schema", schema: req.schema } } : {}) } };
      if (req.web) params.tools = [{ type: "web_search_20260209", name: "web_search", max_uses: req.maxSearches || 3 }];
      const msg = await send(params, { signal: t.signal, onActivity: req.onActivity, onText: req.onText });
      cost += estimateCost(model, msg.usage);
      checkStop(msg);
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (!req.schema) return { text, costUsd: cost, model };
      if (msg.stop_reason === "max_tokens") throw new Error("output was cut off (max_tokens)");
      return { data: JSON.parse(text), costUsd: cost, model };
    } finally {
      t.done();
    }
  }

  return { name: "api", models: resolved, call };
}
