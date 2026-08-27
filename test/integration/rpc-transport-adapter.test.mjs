import assert from "node:assert/strict";
import test from "node:test";

import { dispatchRequest } from "../../mcp/lib/rpc.mjs";

test("request-scoped transport capture keeps concurrent non-stdio responses isolated", async () => {
  const [options, modes] = await Promise.all([
    dispatchRequest({
      jsonrpc: "2.0",
      id: "options",
      method: "tools/call",
      params: { name: "list_council_options", arguments: { language: "en" } },
    }),
    dispatchRequest({
      jsonrpc: "2.0",
      id: "modes",
      method: "tools/call",
      params: { name: "compare_summary_modes", arguments: { language: "en" } },
    }),
  ]);
  assert.equal(options.id, "options");
  assert.equal(options.result?.structuredContent?.masters?.length, 26);
  assert.equal(modes.id, "modes");
  assert.ok(Array.isArray(modes.result?.structuredContent?.modes));
});
