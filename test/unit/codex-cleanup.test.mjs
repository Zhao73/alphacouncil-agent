import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  symlinkSync,
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
  disabledSkillsConfig,
  discoverNonSystemCodexSkills,
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
  assert.equal(result.timing.outcome, "timed_out");
  assert.equal(result.timing.timed_out, true);
  assert.equal(result.timing.forced_settle, true);
  assert.equal(result.timing.pid, 424242);
  assert.equal(
    Date.parse(result.timing.finished_at) - Date.parse(result.timing.started_at),
    result.timing.elapsed_ms,
  );
  assert.deepEqual(stops, ["TERM", "KILL"]);
  assert.ok(Date.now() - started < 250, "forced settlement must not wait for a close event");
});

test("runCodex re-clamps its timer after spawn so settlement fits an absolute deadline", async (t) => {
  class NeverClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 424244;
      this.stdin = { on() {}, end() {} };
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
  }
  let startPayload;
  const stops = [];
  const timers = [];
  let clockMs = Date.now();
  t.mock.method(Date, "now", () => clockMs);
  // Capture the timeout callback directly instead of depending on the experimental MockTimers
  // API, whose argument shape differs across the supported Node 18-26 range.
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const timer = { callback, delay };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", () => {});
  const killGraceMs = 20;
  const absoluteDeadlineMs = clockMs + 80;
  const resultPromise = runCodex("fixture", 1_000, (payload) => {
    startPayload = payload;
  }, () => {}, {
    spawn: () => new NeverClosingChild(),
    stopChild: (_child, force = false) => stops.push(force ? "KILL" : "TERM"),
    sigkillGraceMs: killGraceMs,
    absoluteDeadlineMs,
  });
  assert.equal(timers.length, 1);
  assert.ok(timers[0].delay <= 60);
  // Invoking the timeout only at the absolute boundary models an event-loop callback that
  // wakes late. It must force-settle immediately instead of allocating a second grace window.
  clockMs = absoluteDeadlineMs;
  timers.shift().callback();
  assert.deepEqual(stops, ["TERM", "KILL"]);
  assert.equal(timers.length, 0);
  const result = await resultPromise;
  assert.ok(startPayload.worker_timeout_ms <= absoluteDeadlineMs - Date.parse(startPayload.started_at) - killGraceMs);
  assert.equal(startPayload.settlement_grace_ms, killGraceMs);
  assert.equal(result.timing.worker_timeout_ms, startPayload.worker_timeout_ms);
  assert.equal(result.timing.settlement_grace_ms, startPayload.settlement_grace_ms);
  assert.equal(result.timedOut, true);
  assert.equal(result.forced_settle, true);
});

test("runCodex adds no grace when synchronous spawn has already consumed the absolute deadline", async () => {
  class NeverClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 424245;
      this.stdin = { on() {}, end() {} };
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
  }
  const stops = [];
  const absoluteDeadlineMs = Date.now() + 20;
  let spawnReturnedAt = null;
  let startPayload;
  const result = await runCodex("fixture", 1_000, (payload) => {
    startPayload = payload;
  }, () => {}, {
    spawn: () => {
      while (Date.now() <= absoluteDeadlineMs + 10) {
        // Model a synchronous spawn implementation that returns after the lifecycle expired.
      }
      spawnReturnedAt = Date.now();
      return new NeverClosingChild();
    },
    stopChild: (_child, force = false) => stops.push(force ? "KILL" : "TERM"),
    sigkillGraceMs: 100,
    absoluteDeadlineMs,
  });

  assert.equal(startPayload.worker_timeout_ms, 0);
  assert.equal(startPayload.settlement_grace_ms, 0);
  assert.equal(result.timing.settlement_grace_ms, 0);
  assert.equal(result.timedOut, true);
  assert.equal(result.forced_settle, true);
  assert.deepEqual(stops, ["TERM", "KILL"]);
  assert.ok(Date.now() - spawnReturnedAt < 50, "expired startup must settle without a new grace wait");
});

test("runCodex exposes one process-boundary clock shared byte-for-byte with onStart", async () => {
  const dir = makeDataDir();
  class ClosingChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 424243;
      this.stdin = { on() {}, end() {} };
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
  }
  let startPayload;
  let outFile;
  try {
    const result = await runCodex("fixture", 1000, (payload) => {
      startPayload = payload;
      outFile = payload.output;
    }, () => {}, {
      dataDir: dir,
      spawn: () => {
        const child = new ClosingChild();
        setTimeout(() => {
          writeFileSync(outFile, JSON.stringify({ ok: true }));
          child.emit("close", 0);
        }, 15);
        return child;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.timing.outcome, "completed");
    assert.equal(result.timing.pid, 424243);
    assert.equal(result.timing.started_at, startPayload.started_at);
    assert.equal(result.timing.timed_out, false);
    assert.equal(result.timing.forced_settle, false);
    assert.equal(
      Date.parse(result.timing.finished_at) - Date.parse(result.timing.started_at),
      result.timing.elapsed_ms,
    );
    assert.ok(result.timing.elapsed_ms >= 5, "the 15 ms fixture must retain a non-zero interval");
    assert.ok(result.timing.elapsed_ms < 500, "the real-clock assertion keeps over 3x headroom");
    assert.equal(result.timing.duration_scope, "local_child_spawn_to_settlement_wall_time");
  } finally {
    removeDataDir(dir);
  }
});

test("an asynchronous child error after spawn is spawn_failed and retains its real interval", async () => {
  const dir = makeDataDir();
  class ErroringChild extends EventEmitter {
    constructor() {
      super();
      this.pid = undefined;
      this.stdin = { on() {}, end() {} };
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
  }
  const starts = [];
  try {
    const result = await runCodex("fixture", 1000, (payload) => starts.push(payload), () => {}, {
      dataDir: dir,
      spawn: () => {
        const child = new ErroringChild();
        setTimeout(() => {
          child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }));
          child.emit("close", -2);
        }, 15);
        return child;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.timing.outcome, "spawn_failed");
    assert.equal(result.timing.pid, null);
    assert.equal(starts.length, 1);
    assert.equal(result.timing.started_at, starts[0].started_at);
    assert.ok(result.timing.elapsed_ms >= 5, "an async ENOENT is observed after process timing starts");
    assert.ok(result.timing.elapsed_ms < 500, "the real-clock assertion keeps over 3x headroom");
  } finally {
    removeDataDir(dir);
  }
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

test("leaf workers share one auth home while isolating plugin data and user skills", async () => {
  const dir = makeDataDir();
  const sourceCodexHome = join(dir, "source-codex-home");
  const authFixture = JSON.stringify({ auth_mode: "fixture-only-shared" });
  mkdirSync(sourceCodexHome, { recursive: true });
  writeFileSync(join(sourceCodexHome, "auth.json"), authFixture);
  const disabledSkillPath = join(sourceCodexHome, "skills", "fixture", "SKILL.md");
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
  let leafUserHome;
  try {
    const result = await runCodex("fixture", 1000, ({ output }) => { outFile = output; }, () => {}, {
      dataDir: dir,
      sourceCodexHome,
      disabledSkillPaths: [disabledSkillPath],
      spawn: (_command, args, options) => {
        leafRuntimeDir = options.env.ALPHACOUNCIL_AGENT_DATA_DIR;
        leafUserHome = options.env.HOME;
        assert.notEqual(leafRuntimeDir, dir);
        assert.equal(existsSync(leafRuntimeDir), true);
        assert.equal(options.env.CODEX_HOME, sourceCodexHome);
        assert.equal(leafUserHome, join(leafRuntimeDir, "home"));
        assert.equal(options.env.USERPROFILE, leafUserHome);
        assert.equal(existsSync(join(leafRuntimeDir, "codex-home")), false);
        assert.equal(readFileSync(join(sourceCodexHome, "auth.json"), "utf8"), authFixture);
        if (process.platform === "win32") {
          const commandLine = args[3];
          for (const feature of ["plugins", "apps", "tool_suggest", "multi_agent"]) {
            assert.match(commandLine, new RegExp(`--disable ${feature}(?: |$)`, "u"));
          }
          assert.match(commandLine, /skills\.config=/u);
          assert.match(commandLine, /enabled=false/u);
          assert.match(commandLine, /SKILL\.md/u);
        } else {
          assert.deepEqual(args.slice(args.indexOf("--disable"), args.indexOf("exec")), [
            "--disable", "plugins",
            "--disable", "apps",
            "--disable", "tool_suggest",
            "--disable", "multi_agent",
            "-c", `skills.config=[{path=${JSON.stringify(disabledSkillPath)},enabled=false}]`,
          ]);
        }
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
    assert.equal(existsSync(leafUserHome), false, "temporary skill-discovery home must be removed after settlement");
    assert.equal(
      readFileSync(join(sourceCodexHome, "auth.json"), "utf8"),
      authFixture,
      "shared credentials must remain in the owner's Codex home",
    );
  } finally {
    removeDataDir(dir);
  }
});

test("leaf skill isolation disables personal skills but preserves Codex system skills", () => {
  const dir = makeDataDir();
  const codexHome = join(dir, "codex-home");
  const personalSkill = join(codexHome, "skills", "personal", "SKILL.md");
  const systemSkill = join(codexHome, "skills", ".system", "builtin", "SKILL.md");
  try {
    mkdirSync(join(codexHome, "skills", "personal"), { recursive: true });
    mkdirSync(join(codexHome, "skills", ".system", "builtin"), { recursive: true });
    writeFileSync(personalSkill, "personal");
    writeFileSync(systemSkill, "system");

    const canonicalPersonalSkill = realpathSync(personalSkill);
    assert.deepEqual(discoverNonSystemCodexSkills(codexHome), [canonicalPersonalSkill]);
    assert.equal(
      disabledSkillsConfig([canonicalPersonalSkill]),
      `skills.config=[{path=${JSON.stringify(canonicalPersonalSkill)},enabled=false}]`,
    );
    assert.throws(
      () => disabledSkillsConfig(Array.from({ length: 129 }, (_, index) => `/tmp/s${index}/SKILL.md`)),
      /maximum is 128/u,
    );
  } finally {
    removeDataDir(dir);
  }
});

test("leaf skill discovery fails closed at depth, directory and skill-count limits", () => {
  const dir = makeDataDir();
  const codexHome = join(dir, "codex-home");
  const root = join(codexHome, "skills");
  try {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "SKILL.md"), "a");
    writeFileSync(join(root, "a", "b", "SKILL.md"), "b");
    assert.throws(
      () => discoverNonSystemCodexSkills(codexHome, { maxDepth: 1 }),
      /maximum depth 1/u,
    );
    assert.throws(
      () => discoverNonSystemCodexSkills(codexHome, { maxDirectories: 2 }),
      /maximum directory count 2/u,
    );
    assert.throws(
      () => discoverNonSystemCodexSkills(codexHome, { maxSkills: 1 }),
      /more than 1 user skills/u,
    );
  } finally {
    removeDataDir(dir);
  }
});

test("leaf skill discovery reports an existing unreadable directory shape", () => {
  const dir = makeDataDir();
  const codexHome = join(dir, "codex-home");
  try {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "skills"), "not a directory");
    assert.throws(
      () => discoverNonSystemCodexSkills(codexHome),
      /skill directory could not be read/u,
    );
  } finally {
    removeDataDir(dir);
  }
});

test("leaf skill discovery resolves symlinks, skips system aliases and breaks cycles", {
  skip: process.platform === "win32",
}, () => {
  const dir = makeDataDir();
  const codexHome = join(dir, "codex-home");
  const root = join(codexHome, "skills");
  const personal = join(root, "personal");
  const system = join(root, ".system", "builtin");
  try {
    mkdirSync(personal, { recursive: true });
    mkdirSync(system, { recursive: true });
    writeFileSync(join(personal, "SKILL.md"), "personal");
    writeFileSync(join(system, "SKILL.md"), "system");
    symlinkSync(root, join(personal, "cycle"), "dir");
    symlinkSync(join(root, ".system"), join(root, "system-alias"), "dir");
    assert.deepEqual(discoverNonSystemCodexSkills(codexHome), [realpathSync(join(personal, "SKILL.md"))]);
  } finally {
    removeDataDir(dir);
  }
});

test("leaf skill discovery rejects a dangling user-skill symlink", {
  skip: process.platform === "win32",
}, () => {
  const dir = makeDataDir();
  const codexHome = join(dir, "codex-home");
  const root = join(codexHome, "skills");
  try {
    mkdirSync(root, { recursive: true });
    symlinkSync(join(dir, "missing"), join(root, "dangling"), "dir");
    assert.throws(
      () => discoverNonSystemCodexSkills(codexHome),
      /skill symlink could not be inspected/u,
    );
  } finally {
    removeDataDir(dir);
  }
});

test("leaf skill discovery rejects a .system symlink to the skills root", {
  skip: process.platform === "win32",
}, () => {
  const dir = makeDataDir();
  const codexHome = join(dir, "codex-home");
  const root = join(codexHome, "skills");
  try {
    mkdirSync(join(root, "personal"), { recursive: true });
    writeFileSync(join(root, "personal", "SKILL.md"), "personal");
    symlinkSync(root, join(root, ".system"), "dir");
    assert.throws(
      () => discoverNonSystemCodexSkills(codexHome),
      /\.system entry must be a real directory/u,
    );
  } finally {
    removeDataDir(dir);
  }
});

test("leaf skill discovery rejects a .system symlink to a personal subtree", {
  skip: process.platform === "win32",
}, () => {
  const dir = makeDataDir();
  const codexHome = join(dir, "codex-home");
  const root = join(codexHome, "skills");
  const personal = join(root, "personal");
  try {
    mkdirSync(personal, { recursive: true });
    writeFileSync(join(personal, "SKILL.md"), "personal");
    symlinkSync(personal, join(root, ".system"), "dir");
    assert.throws(
      () => discoverNonSystemCodexSkills(codexHome),
      /\.system entry must be a real directory/u,
    );
  } finally {
    removeDataDir(dir);
  }
});

test("leaf skill discovery rejects a .system symlink to the parent", {
  skip: process.platform === "win32",
}, () => {
  const dir = makeDataDir();
  const codexHome = join(dir, "codex-home");
  const root = join(codexHome, "skills");
  try {
    mkdirSync(root, { recursive: true });
    symlinkSync(codexHome, join(root, ".system"), "dir");
    assert.throws(
      () => discoverNonSystemCodexSkills(codexHome),
      /\.system entry must be a real directory/u,
    );
  } finally {
    removeDataDir(dir);
  }
});

test("a synchronous worker spawn throw is not_started, emits no start, and leaks no leaf directory", async () => {
  const dir = makeDataDir();
  const starts = [];
  try {
    const result = await runCodex("fixture", 1000, (payload) => starts.push(payload), () => {}, {
      dataDir: dir,
      leafRuntimeRoot: dir,
      spawn: () => { throw new Error("spawn fixture failed"); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.timing.outcome, "not_started");
    assert.equal(result.timing.started_at, null);
    assert.equal(result.timing.finished_at, null);
    assert.equal(result.timing.elapsed_ms, 0);
    assert.equal(result.timing.pid, null);
    assert.equal(starts.length, 0, "a synchronous throw must not create a worker event pair");
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
