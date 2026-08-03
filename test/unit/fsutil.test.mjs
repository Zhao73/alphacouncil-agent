import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import {
  __test__ as fsutilTest,
  jsonlEntryHash,
  readJson,
  readJsonl,
  writeJson,
  writeTextAtomic,
} from "../../mcp/lib/fsutil.mjs";
import { RpcCode } from "../../mcp/lib/errors.mjs";

const dir = makeDataDir();
after(() => removeDataDir(dir));

test("writeJson leaves no .tmp file behind", () => {
  const path = join(dir, "atomic.json");
  writeJson(path, { a: 1 });
  assert.deepEqual(readJson(path), { a: 1 });
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
});

function childAtomicWrite(path, body) {
  const moduleUrl = pathToFileURL(join(process.cwd(), "mcp/lib/fsutil.mjs")).href;
  const source = `import { writeTextAtomic } from ${JSON.stringify(moduleUrl)}; writeTextAtomic(process.argv[1], process.argv[2]);`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, path, body], { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
  });
}

test("concurrent atomic writers use unique temp files and publish one complete value", async () => {
  const path = join(dir, "concurrent.md");
  const bodies = Array.from({ length: 8 }, (_, index) => `writer-${index}|${String(index).repeat(32_000)}`);
  await Promise.all(bodies.map((body) => childAtomicWrite(path, body)));
  assert.ok(bodies.includes(readFileSync(path, "utf8")), "the winner must be one complete writer payload");
  assert.equal(readdirSync(dir).filter((file) => file.includes("concurrent.md") && file.endsWith(".tmp")).length, 0);
});

test("Windows atomic rename retries transient replacement contention", () => {
  const calls = [];
  const waits = [];
  fsutilTest.renameAtomicSync("staged.tmp", "published.md", {
    platform: "win32",
    rename: (source, destination) => {
      calls.push([source, destination]);
      if (calls.length < 3) {
        const error = new Error("replacement is momentarily busy");
        error.code = "EPERM";
        throw error;
      }
    },
    wait: (delayMs) => waits.push(delayMs),
  });
  assert.deepEqual(calls, [
    ["staged.tmp", "published.md"],
    ["staged.tmp", "published.md"],
    ["staged.tmp", "published.md"],
  ]);
  assert.deepEqual(waits, [1, 2]);
});

test("atomic text writes preserve an existing mode and ignore an unrelated half-written temp", () => {
  const path = join(dir, "half-write.md");
  writeTextAtomic(path, "old-complete", { mode: 0o640 });
  writeFileSync(join(dir, ".half-write.md.crashed.tmp"), "half");
  writeTextAtomic(path, "new-complete");
  assert.equal(readFileSync(path, "utf8"), "new-complete");
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o640);
});

test("readJson reports a missing file as INVALID_PARAMS, not a raw ENOENT", () => {
  try {
    readJson(join(dir, "does-not-exist.json"));
    assert.fail("expected a throw");
  } catch (error) {
    assert.equal(error.code, RpcCode.INVALID_PARAMS);
    assert.match(error.message, /not found/);
  }
});

test("readJson reports corrupt JSON as INTERNAL_ERROR", () => {
  const path = join(dir, "corrupt.json");
  writeFileSync(path, "{ not json");
  try {
    readJson(path);
    assert.fail("expected a throw");
  } catch (error) {
    assert.equal(error.code, RpcCode.INTERNAL_ERROR);
    assert.match(error.message, /corrupt JSON/);
  }
});

test("readJsonl survives a truncated trailing line instead of losing the whole log", () => {
  const path = join(dir, "events.jsonl");
  writeJson(join(dir, "_touch.json"), {});
  writeFileSync(path, "");
  appendFileSync(path, `${JSON.stringify({ type: "run_started" })}\n`);
  appendFileSync(path, `${JSON.stringify({ type: "run_complete" })}\n`);
  appendFileSync(path, '{"type":"trunc');

  const { entries, parse_errors } = readJsonl(path);
  assert.equal(entries.length, 2, "the two intact events must still be readable");
  assert.equal(parse_errors, 1);
  assert.deepEqual(entries.map((e) => e.type), ["run_started", "run_complete"]);
});

test("readJsonl treats a missing file as an empty log", () => {
  assert.deepEqual(readJsonl(join(dir, "no-such.jsonl")), { entries: [], parse_errors: 0 });
});

test("readJsonl rejects malformed middle lines instead of silently skipping audit evidence", () => {
  const path = join(dir, "middle-corrupt.jsonl");
  writeFileSync(path, '{"type":"first"}\n{"type":bad}\n{"type":"third"}\n');
  assert.throws(() => readJsonl(path), /corrupt JSONL.*:2: invalid JSON/u);
});

test("readJsonl rejects non-object JSON entries with the corruption contract", () => {
  for (const [index, value] of [null, "event", 42, ["event"]].entries()) {
    const path = join(dir, `non-object-${index}.jsonl`);
    writeFileSync(path, `${JSON.stringify(value)}\n`);
    try {
      readJsonl(path);
      assert.fail("expected a corruption error");
    } catch (error) {
      assert.equal(error.code, RpcCode.INTERNAL_ERROR);
      assert.match(error.message, /corrupt JSONL.*entry must be a JSON object/u);
    }
  }
});

test("readJsonl rejects a tampered hash-chain event", () => {
  const path = join(dir, "tampered-chain.jsonl");
  const first = { schema_version: 1, seq: 1, prev_hash: null, at: "2026-08-03T00:00:00.000Z", type: "first" };
  first.event_hash = jsonlEntryHash(first);
  const second = { schema_version: 1, seq: 2, prev_hash: first.event_hash, at: "2026-08-03T00:00:01.000Z", type: "second" };
  second.event_hash = jsonlEntryHash(second);
  writeFileSync(path, `${JSON.stringify(first)}\n${JSON.stringify({ ...second, type: "tampered" })}\n`);
  assert.throws(() => readJsonl(path), /event_hash does not match event content/u);
});

test("a JSON file written by writeJson round-trips exactly", () => {
  const path = join(dir, "roundtrip.json");
  const value = { nested: { list: [1, 2, 3], zh: "中文", nul: null } };
  writeJson(path, value);
  assert.deepEqual(readJson(path), value);
  assert.ok(readFileSync(path, "utf8").endsWith("\n"), "files end with a newline");
});
