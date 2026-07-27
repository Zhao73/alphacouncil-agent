import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer } from "../helpers/rpc-client.mjs";

// Hosts launch this server from wherever they happen to be: codex.mcp.json says `"cwd": "."`,
// and Claude Code resolves ${CLAUDE_PLUGIN_ROOT}. Any intra-repo path that goes through
// process.cwd() instead of import.meta.url breaks here and nowhere else.

let dataDir;
after(() => removeDataDir(dataDir));

test("the server initializes and lists tools when started from a foreign cwd", async () => {
  dataDir = makeDataDir();
  const server = startServer({ dataDir, cwd: tmpdir() });
  try {
    const init = await server.request("initialize", {});
    assert.ok(!init.error, `initialize failed: ${JSON.stringify(init.error)}`);
    assert.equal(init.result?.serverInfo?.name, "alphacouncil-agent");
    assert.ok(init.result?.serverInfo?.version, "serverInfo must carry a version");

    const list = await server.request("tools/list", {});
    assert.ok(!list.error, `tools/list failed: ${JSON.stringify(list.error)}`);
    assert.ok((list.result?.tools || []).length > 0, "tools must be listed from any cwd");
  } finally {
    await server.close();
  }
});
