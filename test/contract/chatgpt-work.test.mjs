import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { repoFile } from "../helpers/paths.mjs";

const rootPackage = JSON.parse(readFileSync(repoFile("package.json"), "utf8"));
const workPackage = JSON.parse(readFileSync(repoFile("work/package.json"), "utf8"));
const gateway = readFileSync(repoFile("work/server.mjs"), "utf8");
const guide = readFileSync(repoFile("work/README.md"), "utf8");

test("ChatGPT Work gateway is isolated from the dependency-free stdio runtime", () => {
  assert.equal(workPackage.version, rootPackage.version);
  assert.equal(workPackage.private, true);
  assert.deepEqual(workPackage.engines, { node: ">=18.14.1" });
  assert.deepEqual(workPackage.dependencies, {
    "@modelcontextprotocol/sdk": "1.30.0",
    zod: "4.4.3",
  });
  assert.deepEqual(workPackage.overrides, { "@hono/node-server": "1.19.17" });
  assert.ok(!rootPackage.dependencies || Object.keys(rootPackage.dependencies).length === 0);
  for (const required of [
    "work/README.md",
    "work/package.json",
    "work/package-lock.json",
    "work/server.mjs",
    "work/test/gateway.test.mjs",
  ]) {
    assert.ok(rootPackage.files.includes(required), `package.files must include ${required}`);
  }
  assert.ok(!rootPackage.files.includes("work/"));
});

test("Work gateway uses official stateless Streamable HTTP and a bounded chat surface", () => {
  assert.match(gateway, /@modelcontextprotocol\/sdk\/server\/streamableHttp\.js/u);
  assert.match(gateway, /sessionIdGenerator:\s*undefined/u);
  assert.match(gateway, /analyze_symbol/u);
  assert.match(gateway, /wait_for_completion/u);
  assert.match(gateway, /read_run/u);
  assert.match(gateway, /WORK_HIDDEN_TOOLS/u);
  assert.match(guide, /26 chat-safe tools/u);
  assert.match(guide, /not the 26\s+provisional method seats/u);
  assert.match(guide, /OAuth 2\.1\/PKCE/u);
  assert.match(guide, /not suitable for publication/u);
  assert.match(guide, /share one\s+`CODEX_HOME`/u);
  assert.match(guide, /never copied or forked/u);
  assert.match(guide, /not user\s+authentication or tenant isolation for a public service/u);
});
