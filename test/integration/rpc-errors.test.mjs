import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer } from "../helpers/rpc-client.mjs";
import { RpcCode } from "../../mcp/lib/errors.mjs";

// handleRequest used to map every thrown value to INVALID_PARAMS, so a missing run
// directory was reported to the host as "you passed bad parameters".

let dataDir;
let server;

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });
  await server.request("initialize", {});
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

test("an unknown tool is METHOD_NOT_FOUND, not INVALID_PARAMS", async () => {
  const response = await server.callTool("no_such_tool", {});
  assert.equal(response.error?.code, RpcCode.METHOD_NOT_FOUND);
});

test("a malformed symbol is INVALID_PARAMS", async () => {
  const response = await server.callTool("analyze_symbol", { symbol: "not a ticker!!", dry_run: true });
  assert.equal(response.error?.code, RpcCode.INVALID_PARAMS);
  assert.match(response.error.message, /ticker-safe/);
});

test("an unknown role on a visible run is INVALID_PARAMS", async () => {
  await server.callTool("plan_visible_run", { symbol: "NOK", run_id: "ERRTEST-ROLE", tasks: ["market_data"] });
  const response = await server.callTool("record_visible_decision", {
    run_id: "ERRTEST-ROLE",
    role: "chief_astrologer",
    packet: {},
  });
  assert.equal(response.error?.code, RpcCode.INVALID_PARAMS);
  assert.match(response.error.message, /Unknown decision role/);
});

test("reading a run that does not exist is INVALID_PARAMS with a useful message", async () => {
  const response = await server.callTool("read_run", { run_id: "NOPE-DOES-NOT-EXIST" });
  assert.equal(response.error?.code, RpcCode.INVALID_PARAMS);
  assert.match(response.error.message, /not found/);
});

test("an invalid run_id shape is rejected before touching the filesystem", async () => {
  const response = await server.callTool("read_run", { run_id: "../../etc/passwd" });
  assert.equal(response.error?.code, RpcCode.INVALID_PARAMS);
  assert.match(response.error.message, /run_id is invalid/);
});

test("a malformed JSON frame gets a PARSE_ERROR reply instead of silence", async () => {
  const parseErrors = [];
  const onLine = new Promise((resolve) => {
    const check = setInterval(() => {
      const hit = server.responses.find((m) => m.error?.code === RpcCode.PARSE_ERROR);
      if (hit) {
        clearInterval(check);
        parseErrors.push(hit);
        resolve();
      }
    }, 25);
    if (typeof check.unref === "function") check.unref();
  });
  server.child.stdin.write("{ this is not json\n");
  await onLine;
  assert.equal(parseErrors[0].error.code, RpcCode.PARSE_ERROR);
  assert.equal(parseErrors[0].id, null);
});
