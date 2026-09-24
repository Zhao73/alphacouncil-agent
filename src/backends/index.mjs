// Engine selection: API key first (fastest), Claude Code sign-in second.

import { createClaudeBackend, hasClaudeCli } from "./claude.mjs";

export async function selectBackend({ engine = process.env.ALPHA_ENGINE || "auto", models = {}, env = process.env } = {}) {
  // A module path exporting createBackend() — used by the test suite to script model output.
  if (env.ALPHA_BACKEND_MODULE) return (await import(env.ALPHA_BACKEND_MODULE)).createBackend({ models });
  const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  if (engine === "api" || (engine === "auto" && hasKey)) {
    if (!hasKey) throw new Error("engine api needs ANTHROPIC_API_KEY");
    const { createApiBackend } = await import("./api.mjs");
    return createApiBackend({ models });
  }
  if (engine === "claude" || engine === "auto") {
    if (!hasClaudeCli(env)) {
      throw new Error(engine === "claude"
        ? "Claude Code not found: install it (npm i -g @anthropic-ai/claude-code) and sign in"
        : "No engine available: set ANTHROPIC_API_KEY, or install and sign in to Claude Code (npm i -g @anthropic-ai/claude-code)");
    }
    return createClaudeBackend({ models });
  }
  throw new Error(`unknown engine: ${engine} (use auto, api or claude)`);
}
