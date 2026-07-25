import { test, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { readJson, readJsonl, writeJson } from "../../mcp/lib/fsutil.mjs";
import { RpcCode } from "../../mcp/lib/errors.mjs";

const dir = makeDataDir();
after(() => removeDataDir(dir));

test("writeJson leaves no .tmp file behind", () => {
  const path = join(dir, "atomic.json");
  writeJson(path, { a: 1 });
  assert.deepEqual(readJson(path), { a: 1 });
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".tmp")).length, 0);
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

test("a JSON file written by writeJson round-trips exactly", () => {
  const path = join(dir, "roundtrip.json");
  const value = { nested: { list: [1, 2, 3], zh: "中文", nul: null } };
  writeJson(path, value);
  assert.deepEqual(readJson(path), value);
  assert.ok(readFileSync(path, "utf8").endsWith("\n"), "files end with a newline");
});
