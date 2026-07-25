import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer } from "../helpers/rpc-client.mjs";
import { RpcCode } from "../../mcp/lib/errors.mjs";

let dataDir;
after(() => removeDataDir(dataDir));

// Personas used to load lazily, so `initialize` succeeded against a missing persona set
// and the host believed the server was healthy. There is no fallback prompt text any
// more, so a silent success would mean shipping empty prompts to subagents.
test("a broken persona set fails the handshake with an actionable message", async () => {
  dataDir = makeDataDir();
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_PERSONAS_DIR: "/definitely-not-a-persona-dir" },
  });
  try {
    const init = await server.request("initialize", {});
    assert.equal(init.error?.code, RpcCode.INTERNAL_ERROR);
    assert.match(init.error.message, /cannot serve requests/);
    assert.match(init.error.message, /ALPHACOUNCIL_PERSONAS_DIR/);
  } finally {
    const { stderr } = await server.close();
    assert.match(stderr, /\[alphacouncil\] persona directory is unreadable/);
  }
});

test("the shipped persona set serves a normal handshake and tool list", async () => {
  const dir = makeDataDir();
  const server = startServer({ dataDir: dir });
  try {
    const init = await server.request("initialize", {});
    assert.ok(!init.error, JSON.stringify(init.error));

    const list = await server.request("tools/list", {});
    const analyze = list.result.tools.find((tool) => tool.name === "analyze_symbol");
    const tasks = analyze.inputSchema.properties.tasks.items.enum;
    assert.ok(tasks.includes("quant_factor"));
    assert.ok(!tasks.includes("_evidence_base"), "disabled shared preambles must not be selectable");

    const record = list.result.tools.find((tool) => tool.name === "record_visible_decision");
    assert.deepEqual(record.inputSchema.properties.role.enum, ["bull_researcher", "bear_researcher", "portfolio_manager"]);
  } finally {
    await server.close();
    removeDataDir(dir);
  }
});
