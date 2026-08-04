import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  truncateSync,
  writeFileSync,
  writeSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer } from "../helpers/rpc-client.mjs";
import {
  MAX_WORKER_OUTPUT_BYTES,
  mapLimit,
  readWorkerOutputBounded,
  runCodex,
} from "../../mcp/lib/codex.mjs";

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

test("runCodex force-settles after kill grace even if a broken child never closes", async () => {
  class NeverClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 424242;
      this.stdin = { on() {}, end() {} };
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
  }
  const stops = [];
  const started = Date.now();
  const result = await runCodex("fixture", 10, () => {}, () => {}, {
    spawn: () => new NeverClosingChild(),
    stopChild: (_child, force = false) => stops.push(force ? "KILL" : "TERM"),
    sigkillGraceMs: 15,
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.forced_settle, true);
  assert.deepEqual(stops, ["TERM", "KILL"]);
  assert.ok(Date.now() - started < 250, "forced settlement must not wait for a close event");
});

test("runCodex rejects and removes an output beyond the UTF-8-safe character envelope", async () => {
  const dir = makeDataDir();
  class ClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 434343;
      this.stdin = { on() {}, end() {} };
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
  }
  try {
    let outFile;
    const result = await runCodex("fixture", 1000, ({ output }) => { outFile = output; }, () => {}, {
      dataDir: dir,
      spawn: () => {
        const child = new ClosingChild();
        queueMicrotask(() => {
          writeFileSync(outFile, Buffer.alloc(MAX_WORKER_OUTPUT_BYTES + 1, 0x78));
          child.emit("close", 0);
        });
        return child;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.output_too_large, true);
    assert.equal(result.output_bytes, MAX_WORKER_OUTPUT_BYTES + 1);
    assert.equal(result.text, "");
    assert.match(result.output_fingerprint_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(result.output_hash_scope, "byte_count_plus_prefix_tail");
    assert.match(result.stderr, new RegExp(`worker output exceeded ${MAX_WORKER_OUTPUT_BYTES} bytes`, "u"));
    assert.ok(!existsSync(result.outFile), "rejected worker output must still be removed");
  } finally {
    removeDataDir(dir);
  }
});

test("runCodex does not reject valid CJK text merely because UTF-8 uses more bytes", async () => {
  const dir = makeDataDir();
  class ClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 444444;
      this.stdin = { on() {}, end() {} };
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
  }
  const payload = JSON.stringify({ summary: "中".repeat(200_000) });
  assert.ok(payload.length < 512_000);
  assert.ok(Buffer.byteLength(payload) > 512_000);
  try {
    let outFile;
    const result = await runCodex("fixture", 1000, ({ output }) => { outFile = output; }, () => {}, {
      dataDir: dir,
      spawn: () => {
        const child = new ClosingChild();
        queueMicrotask(() => {
          writeFileSync(outFile, payload);
          child.emit("close", 0);
        });
        return child;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.output_too_large, false);
    assert.equal(result.text, payload);
    assert.ok(!existsSync(result.outFile));
  } finally {
    removeDataDir(dir);
  }
});

test("leaf workers isolate nested plugin data from the parent run and remove the temp directory", async () => {
  const dir = makeDataDir();
  class ClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 454545;
      this.stdin = { on() {}, end() {} };
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
  }
  let outFile;
  let leafRuntimeDir;
  try {
    const result = await runCodex("fixture", 1000, ({ output }) => { outFile = output; }, () => {}, {
      dataDir: dir,
      spawn: (_command, _args, options) => {
        leafRuntimeDir = options.env.ALPHACOUNCIL_AGENT_DATA_DIR;
        assert.notEqual(leafRuntimeDir, dir);
        assert.equal(existsSync(leafRuntimeDir), true);
        const child = new ClosingChild();
        queueMicrotask(() => {
          writeFileSync(outFile, JSON.stringify({ ok: true }));
          child.emit("close", 0);
        });
        return child;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(existsSync(leafRuntimeDir), false, "owned leaf plugin data must be removed after settlement");
  } finally {
    removeDataDir(dir);
  }
});

test("a synchronous worker spawn failure does not leak the isolated plugin directory", async () => {
  const dir = makeDataDir();
  try {
    await assert.rejects(
      runCodex("fixture", 1000, () => {}, () => {}, {
        dataDir: dir,
        leafRuntimeRoot: dir,
        spawn: () => { throw new Error("spawn fixture failed"); },
      }),
      /spawn fixture failed/u,
    );
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.startsWith("alphacouncil-leaf-")),
      [],
      "failed spawn must remove the owned leaf plugin data directory",
    );
  } finally {
    removeDataDir(dir);
  }
});

test("bounded output reader diagnoses a sparse 50 MiB file with bounded samples", () => {
  const dir = makeDataDir();
  const path = join(dir, "huge-worker.txt");
  const bytes = 50 * 1024 * 1024;
  try {
    writeFileSync(path, "");
    truncateSync(path, bytes);
    const fd = openSync(path, "r+");
    try {
      writeSync(fd, Buffer.from("PREFIX"), 0, 6, 0);
      writeSync(fd, Buffer.from("TAIL"), 0, 4, bytes - 4);
    } finally {
      closeSync(fd);
    }
    const result = readWorkerOutputBounded(path, { maxBytes: 512_000, diagnosticBytes: 32 });
    assert.equal(result.output_too_large, true);
    assert.equal(result.output_bytes, bytes);
    assert.equal(result.text, "");
    assert.equal(Buffer.byteLength(result.output_prefix), 32);
    assert.equal(Buffer.byteLength(result.output_tail), 32);
    assert.ok(result.output_prefix.startsWith("PREFIX"));
    assert.ok(result.output_tail.endsWith("TAIL"));
  } finally {
    removeDataDir(dir);
  }
});

test("mapLimit can isolate an unexpected seat rejection without cancelling siblings", async () => {
  const results = await mapLimit(
    [1, 2, 3],
    3,
    async (value) => {
      if (value === 2) throw new Error("seat exploded");
      return value * 10;
    },
    async (error, value) => ({ value, error: error.message }),
  );
  assert.deepEqual(results, [10, { value: 2, error: "seat exploded" }, 30]);
});
