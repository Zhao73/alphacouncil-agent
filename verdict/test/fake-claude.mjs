#!/usr/bin/env node
// Stand-in for `claude -p`: reads the prompt from stdin and emits stream-json.
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("9.9.9 (Fake Claude)");
  process.exit(0);
}
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const prompt = Buffer.concat(chunks).toString("utf8").split("\n\nKeep research focused")[0];
if (process.env.FAKE_CLAUDE_HANG) setInterval(() => {}, 1000);
else {
  const emit = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  emit({ type: "system", subtype: "init" });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "acme" } }] } });
  const schema = args.includes("--json-schema");
  if (!schema) emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: `you said ${prompt}` } } });
  emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.05, result: schema ? "" : `you said ${prompt}`, ...(schema ? { structured_output: { echo: prompt } } : {}) });
}
