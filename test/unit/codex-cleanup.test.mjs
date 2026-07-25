import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer } from "../helpers/rpc-client.mjs";

// runCodex used to write codex-<ts>-<rand>.txt into DATA_DIR and never delete it, so
// every analyst of every run leaked one file permanently. These tests cover the sweep
// half (the unlink-on-finish half needs a real Codex child, which CI does not have).

test("sweepStaleOutputs removes old codex temp files and keeps fresh ones", async () => {
  const dir = makeDataDir();
  try {
    const stale = join(dir, "codex-1700000000000-abc123.txt");
    const fresh = join(dir, "codex-1700000000001-def456.txt");
    const unrelated = join(dir, "notes.txt");
    for (const p of [stale, fresh, unrelated]) writeFileSync(p, "x");

    // Backdate the stale one two days.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    // codex.mjs binds DATA_DIR at import time, so the sweep is driven through a fresh
    // server process rather than by calling it in this one.
    const server = startServer({ dataDir: dir });
    await server.request("initialize", {});
    await server.close();

    assert.ok(!existsSync(stale), "a 2-day-old codex temp file must be swept at startup");
    assert.ok(existsSync(fresh), "a fresh codex temp file must survive");
    assert.ok(existsSync(unrelated), "unrelated files must never be touched");
  } finally {
    removeDataDir(dir);
  }
});

test("a dry run leaves no codex temp files in the data dir", async () => {
  const dir = makeDataDir();
  try {
    const server = startServer({ dataDir: dir });
    await server.request("initialize", {});
    await server.callTool("analyze_symbol", { symbol: "AAPL", dry_run: true, tasks: ["market_data"] });
    await server.close();

    const leaked = readdirSync(dir).filter((f) => /^codex-/.test(f));
    assert.deepEqual(leaked, [], "no codex temp files may remain");
  } finally {
    removeDataDir(dir);
  }
});
