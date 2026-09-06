export const CONNECTION_PRESETS = Object.freeze([
  { id: "codex", name: "Codex / ChatGPT", provider: "codex", base_url: null, docs_url: "https://developers.openai.com/codex/auth/" },
  { id: "anthropic", name: "Claude API", provider: "anthropic", base_url: "https://api.anthropic.com/v1", docs_url: "https://platform.claude.com/docs/en/api/overview" },
  { id: "openai", name: "OpenAI API", provider: "openai", base_url: "https://api.openai.com/v1", docs_url: "https://developers.openai.com/api/reference/overview" },
  { id: "deepseek", name: "DeepSeek", provider: "compatible", base_url: "https://api.deepseek.com", docs_url: "https://api-docs.deepseek.com/", api_format: "chat" },
  { id: "kimi-international", name: "Kimi International", provider: "compatible", base_url: "https://api.moonshot.ai/v1", docs_url: "https://platform.kimi.ai/docs/overview", api_format: "chat" },
  { id: "kimi-china", name: "Kimi China", provider: "compatible", base_url: "https://api.moonshot.cn/v1", docs_url: "https://platform.kimi.com/docs/get-api-key", api_format: "chat" },
  { id: "glm-international", name: "GLM / Z.AI International", provider: "compatible", base_url: "https://api.z.ai/api/paas/v4", docs_url: "https://docs.z.ai/guides/overview/quick-start", api_format: "chat" },
  { id: "glm-china", name: "GLM / BigModel China", provider: "compatible", base_url: "https://open.bigmodel.cn/api/paas/v4", docs_url: "https://docs.bigmodel.cn/cn/guide/start/quick-start", api_format: "chat" },
  { id: "openrouter", name: "OpenRouter", provider: "compatible", base_url: "https://openrouter.ai/api/v1", docs_url: "https://openrouter.ai/docs/api-reference/overview", api_format: "chat" },
  { id: "opencode-zen", name: "OpenCode Zen", provider: "compatible", base_url: "https://opencode.ai/zen/v1", docs_url: "https://opencode.ai/docs/zen/" },
  { id: "opencode-go", name: "OpenCode Go", provider: "compatible", base_url: "https://opencode.ai/zen/go/v1", docs_url: "https://opencode.ai/docs/go/", notice_key: "opencodeGoNotice" },
  { id: "kimi-code", name: "Kimi Code", provider: "compatible", base_url: null, docs_url: "https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html", info_only: true, notice_key: "kimiCodeNotice" },
  { id: "glm-coding", name: "GLM Coding Plan", provider: "compatible", base_url: null, docs_url: "https://docs.z.ai/devpack/usage-policy", info_only: true, notice_key: "glmCodingNotice" },
  { id: "compatible", name: "Compatible API", provider: "compatible", base_url: null, docs_url: "https://github.com/Zhao73/alphacouncil-agent/blob/main/terminal/README.md", api_format: "chat" },
].map(Object.freeze));

// Exact protocol assignments from the official endpoint tables, checked 2026-09-06.
// Zen and Go differ for the same model; new IDs remain unselectable until documented.
const OPENCODE_PROTOCOLS = Object.freeze({
  "https://opencode.ai/zen/v1": Object.fromEntries([
    ..."gpt-6-astra gpt-5.6-sol gpt-5.6-terra gpt-5.6-luna gpt-5.5 gpt-5.5-pro gpt-5.4 gpt-5.4-pro gpt-5.4-mini gpt-5.4-nano gpt-5.3-codex gpt-5.3-codex-spark gpt-5.2 gpt-5.2-codex gpt-5.1 gpt-5.1-codex gpt-5.1-codex-max gpt-5.1-codex-mini gpt-5 gpt-5-codex gpt-5-nano grok-4.6 grok-4.5 grok-build-0.1 muse-spark-1.3 muse-spark-1.2 muse-spark-1.3-contributor-free".split(" ").map((id) => [id, "responses"]),
    ..."claude-fable-5-1 claude-fable-5 claude-opus-5 claude-opus-4-8 claude-opus-4-7 claude-opus-4-6 claude-opus-4-5 claude-sonnet-5 claude-sonnet-4-6 claude-sonnet-4-5 claude-haiku-4-5 qwen3.7-max qwen3.7-plus qwen3.6-plus qwen3.5-plus".split(" ").map((id) => [id, "messages"]),
    ..."deepseek-v4-pro deepseek-v4-flash deepseek-v4-flash-vision-exp minimax-m3 minimax-m2.7 minimax-m2.5 glm-5.3-flash glm-5.3 glm-5.2 glm-5.1 glm-5 kimi-k2.5 kimi-k2.6 kimi-k2.7-code kimi-k3 big-pickle mimo-v2.5-free ling-3.0-flash-fin-free nemotron-3-ultra-free nemotron-3.5-lightning-free".split(" ").map((id) => [id, "chat"]),
  ]),
  "https://opencode.ai/zen/go/v1": Object.fromEntries([
    ..."grok-4.6 gpt-5.6-luna muse-spark-1.3-contributor muse-spark-1.2-contributor".split(" ").map((id) => [id, "responses"]),
    ..."minimax-m3 minimax-m2.7 minimax-m2.5 qwen3.8-max qwen3.8-flash qwen3.7-max qwen3.7-plus qwen3.6-plus".split(" ").map((id) => [id, "messages"]),
    ..."glm-5.3-flash glm-5.3 glm-5.2 glm-5.1 kimi-k3 kimi-k2.7-code kimi-k2.6 longcat-2.0 deepseek-v4-pro deepseek-v4-flash deepseek-v4-flash-vision-exp mimo-v2.5 mimo-v2.5-pro hy4-preview hy3 omen-alpha".split(" ").map((id) => [id, "chat"]),
  ]),
});

export function isOpenCodeGo(baseUrl) { return baseUrl === "https://opencode.ai/zen/go/v1"; }

export function modelProtocol(baseUrl, id, defaultFormat) {
  if (!Object.hasOwn(OPENCODE_PROTOCOLS, baseUrl)) return defaultFormat;
  return Object.hasOwn(OPENCODE_PROTOCOLS[baseUrl], id) ? OPENCODE_PROTOCOLS[baseUrl][id] : null;
}

export function documentedModels(baseUrl) {
  // These are documentation candidates, never an authenticated account entitlement list.
  const rows = baseUrl === "https://api.z.ai/api/paas/v4" ? [
    ["glm-5.3", "https://docs.z.ai/guides/llm/glm-5.3"],
    ["glm-5", "https://docs.z.ai/guides/llm/glm-5"],
    ["glm-4.7", "https://docs.z.ai/guides/llm/glm-4.7"],
  ] : baseUrl === "https://open.bigmodel.cn/api/paas/v4" ? [
    ["glm-5.2", "https://docs.bigmodel.cn/api-reference/模型-api/对话补全"],
    ["glm-5", "https://docs.bigmodel.cn/cn/guide/models/text/glm-5"],
    ["glm-4.7", "https://docs.bigmodel.cn/api-reference/模型-api/对话补全"],
  ] : null;
  return rows?.map(([id, docs_url]) => ({ id, name: id, api_format: "chat", catalog_source: "documentation", selectable: true, requires_probe: true, docs_url })) || null;
}
