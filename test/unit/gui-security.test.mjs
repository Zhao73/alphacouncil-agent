import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
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
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      // Use a raw TCP request so Node's client-side Host validation, proxy settings and
      // version-specific parser behavior cannot reject the forged Host before our server sees it.
      socket.end(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    socket.on("data", (chunk) => { raw += chunk; });
    socket.on("error", rejectPromise);
    socket.on("end", () => {
      const boundary = raw.indexOf("\r\n\r\n");
      if (boundary < 0) return rejectPromise(new Error("raw HTTP response is missing a header boundary"));
      const headers = raw.slice(0, boundary);
      const status = Number(headers.match(/^HTTP\/1\.\d\s+(\d{3})/u)?.[1]);
      let body = raw.slice(boundary + 4);
      if (/^transfer-encoding:\s*chunked\s*$/imu.test(headers)) {
        let cursor = 0;
        let decoded = "";
        while (cursor < body.length) {
          const sizeEnd = body.indexOf("\r\n", cursor);
          if (sizeEnd < 0) return rejectPromise(new Error("invalid chunked response size"));
          const size = Number.parseInt(body.slice(cursor, sizeEnd).split(";", 1)[0], 16);
          if (!Number.isSafeInteger(size) || size < 0) return rejectPromise(new Error("invalid chunk size"));
          cursor = sizeEnd + 2;
          if (size === 0) break;
          decoded += body.slice(cursor, cursor + size);
          cursor += size + 2;
        }
        body = decoded;
      }
      return resolvePromise({ status, body });
    });
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
