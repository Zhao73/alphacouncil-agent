import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer } from "../helpers/rpc-client.mjs";

test("server startup runs the bounded expired-selection cleanup", async () => {
  const dataDir = makeDataDir();
  const selectionId = "SEL-11111111-1111-4111-8111-111111111111";
  const selectionsDir = join(dataDir, "selections");
  const selectionFile = join(selectionsDir, `${selectionId}.json`);
  mkdirSync(join(selectionsDir, "receipts"), { recursive: true });
  writeFileSync(selectionFile, `${JSON.stringify({
    schema_version: 1,
    selection_id: selectionId,
    expires_at: "2000-01-01T00:00:00.000Z",
  })}\n`);

  const server = startServer({ dataDir });
  try {
    await server.request("initialize", {});
    assert.equal(existsSync(selectionFile), false);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
