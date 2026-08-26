import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { createGuiServer, guiDirectory, isAllowedHost } from "../../gui/server.mjs";

const GUI_HTML = fileURLToPath(new URL("../../gui/index.html", import.meta.url));

function renderer() {
  const source = readFileSync(GUI_HTML, "utf8");
  const start = source.indexOf("const esc =");
  const end = source.indexOf("function renderMd");
  assert.ok(start >= 0 && end > start, "inline renderer source must remain discoverable");
  const context = { URL };
  vm.runInNewContext(
    `${source.slice(start, end)}\nthis.renderer = { esc, safeHref, inline };`,
    context,
  );
  return context.renderer;
}

function guiRequest(server, host) {
  const address = server.address();
  return new Promise((resolvePromise, rejectPromise) => {
    const req = request({
      host: "127.0.0.1",
      port: address.port,
      path: "/",
      headers: { Host: host },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolvePromise({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", rejectPromise);
    req.end();
  });
}

test("GUI inline rendering escapes quotes and emits only validated HTTP(S) links", () => {
  const { esc, inline, safeHref } = renderer();
  assert.equal(esc("<&\"'`"), "&lt;&amp;&quot;&#39;`");

  const valid = inline("[OpenAI](https://openai.com/?a=1&b=2)");
  assert.equal(
    valid,
    '<a href="https://openai.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">OpenAI</a>',
  );
  assert.equal(
    inline("**[OpenAI](https://openai.com/)**"),
    '<strong><a href="https://openai.com/" target="_blank" rel="noopener noreferrer">OpenAI</a></strong>',
  );

  for (const href of [
    "javascript:alert(1)",
    "data:text/html,boom",
    "vbscript:msgbox(1)",
    "//example.com/path",
  ]) {
    const rendered = inline(`[unsafe](${href})`);
    assert.doesNotMatch(rendered, /<a\b/iu);
    assert.match(rendered, /\[unsafe\]/u);
    assert.equal(safeHref(href), null);
  }

  const injected = inline('[x](https://a"onmouseover=alert(1))');
  assert.doesNotMatch(injected, /<a\b/iu);
  assert.match(injected, /&quot;onmouseover/u);
});

test("GUI Host allowlist accepts only loopback names with an optional valid port", () => {
  for (const host of [
    "localhost",
    "LOCALHOST:7999",
    "127.0.0.1",
    "127.0.0.1:65535",
    "[::1]",
    "[::1]:443",
  ]) assert.equal(isAllowedHost(host), true, host);

  for (const host of [
    "",
    "localhost.",
    "localhost:0",
    "localhost:65536",
    "127.0.0.2",
    "::1",
    "[::1",
    "evil.example",
    "localhost@evil.example",
    "localhost/path",
  ]) assert.equal(isAllowedHost(host), false, host);
  assert.equal(isAllowedHost(undefined), false);
});

test("GUI server rejects an untrusted Host before serving local content", async (t) => {
  const server = createGuiServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));

  const denied = await guiRequest(server, "attacker.example");
  assert.equal(denied.status, 403);
  assert.deepEqual(JSON.parse(denied.body), { error: "forbidden host" });

  const allowed = await guiRequest(server, "127.0.0.1:7999");
  assert.equal(allowed.status, 200);
  assert.match(allowed.body, /<title>AlphaCouncil Runs<\/title>/u);
});

test("GUI directory resolution decodes file URLs through fileURLToPath", () => {
  const fixture = new URL("../fixtures/gui%20space/server.mjs", import.meta.url).href;
  assert.equal(guiDirectory(fixture), dirname(fileURLToPath(fixture)));
});
