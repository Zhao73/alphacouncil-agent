import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { safeUrl } from "../../mcp/lib/company-source-acquisition.mjs";
import {
  PublicHttpError,
  resolvePublicHttpDestination,
  retrievePublicHttpText,
} from "../../mcp/lib/public-http.mjs";

function requestHarness(steps) {
  const state = { calls: [], pins: [] };
  const requestImpl = (url, options, onResponse) => {
    const step = steps[state.calls.length];
    state.calls.push({ url, options });
    const request = new EventEmitter();
    request.end = () => {
      options.lookup(new URL(url).hostname, {}, (error, address, family) => {
        if (error) {
          request.emit("error", error);
          return;
        }
        state.pins.push({ url, address, family });
        const response = new PassThrough();
        response.statusCode = step?.status ?? 200;
        response.headers = step?.headers || {};
        onResponse(response);
        queueMicrotask(() => response.end(step?.body || ""));
      });
    };
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    return request;
  };
  return { requestImpl, state };
}

test("company URLs reject private, encoded, mapped, local and credentialed destinations", () => {
  for (const url of [
    "http://0.0.0.0/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fc00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://localhost/",
    "http://service.internal/",
    "https://user:secret@example.com/",
  ]) assert.equal(safeUrl(url), null, url);

  assert.equal(safeUrl("https://example.com/path#fragment"), "https://example.com/path");
});

test("DNS validation fails closed when any answer is private or lookup fails", async () => {
  await assert.rejects(
    resolvePublicHttpDestination("https://mixed.example/", {
      lookupImpl: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    }),
    (error) => error instanceof PublicHttpError && error.code === "UNSAFE_DESTINATION",
  );

  await assert.rejects(
    resolvePublicHttpDestination("https://missing.example/", {
      lookupImpl: async () => {
        const error = new Error("resolver unavailable");
        error.code = "EAI_AGAIN";
        throw error;
      },
    }),
    (error) => error instanceof PublicHttpError
      && error.code === "DNS_LOOKUP_FAILED"
      && /EAI_AGAIN/u.test(error.message),
  );
});

test("HTTP connection uses the vetted address even if a later DNS answer changes", async () => {
  let lookupCalls = 0;
  const lookupImpl = async () => {
    lookupCalls += 1;
    return lookupCalls === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "127.0.0.1", family: 4 }];
  };
  const { requestImpl, state } = requestHarness([{
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "pinned response",
  }]);

  const result = await retrievePublicHttpText("https://example.test/source", {
    lookupImpl,
    requestImpl,
    timeoutMs: 1_000,
  });
  assert.equal(result.text, "pinned response");
  assert.equal(lookupCalls, 1, "the transport lookup callback must not resolve DNS again");
  assert.deepEqual(state.pins, [{
    url: "https://example.test/source",
    address: "93.184.216.34",
    family: 4,
  }]);
  assert.deepEqual(result.network_trace.map(({ hostname, address, family }) => ({
    hostname, address, family,
  })), [{
    hostname: "example.test",
    address: "93.184.216.34",
    family: 4,
  }]);
});

test("every redirect hop is revalidated and unsafe destinations are never requested", async () => {
  const unsafeHarness = requestHarness([{
    status: 302,
    headers: { location: "http://internal.test/admin" },
  }]);
  await assert.rejects(
    retrievePublicHttpText("https://public.test/start", {
      lookupImpl: async (hostname) => hostname === "public.test"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }],
      requestImpl: unsafeHarness.requestImpl,
      timeoutMs: 1_000,
    }),
    (error) => error instanceof PublicHttpError && error.code === "UNSAFE_DESTINATION",
  );
  assert.equal(unsafeHarness.state.calls.length, 1);

  const safeHarness = requestHarness([
    { status: 302, headers: { location: "https://cdn.public.test/final" } },
    { status: 200, headers: { "content-type": "text/plain" }, body: "redirected" },
  ]);
  const safe = await retrievePublicHttpText("https://public.test/start", {
    lookupImpl: async (hostname) => [{
      address: hostname === "public.test" ? "93.184.216.34" : "93.184.216.35",
      family: 4,
    }],
    requestImpl: safeHarness.requestImpl,
    timeoutMs: 1_000,
  });
  assert.equal(safe.text, "redirected");
  assert.deepEqual(safe.redirect_chain, [
    "https://public.test/start",
    "https://cdn.public.test/final",
  ]);
  assert.equal(safeHarness.state.calls.length, 2);
});

test("caller redirect policy blocks a public cross-site hop before connection", async () => {
  const harness = requestHarness([{
    status: 301,
    headers: { location: "https://other.example/final" },
  }]);
  await assert.rejects(
    retrievePublicHttpText("https://issuer.example/start", {
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: harness.requestImpl,
      redirectPolicy: ({ to }) => new URL(to).hostname.endsWith(".issuer.example"),
      timeoutMs: 1_000,
    }),
    (error) => error instanceof PublicHttpError && error.code === "REDIRECT_BLOCKED",
  );
  assert.equal(harness.state.calls.length, 1);
});

test("redirect traversal stops at five hops and never requests a seventh URL", async () => {
  const steps = Array.from({ length: 6 }, (_, index) => ({
    status: 302,
    headers: { location: `https://public.test/hop-${index + 1}` },
  }));
  const harness = requestHarness(steps);
  await assert.rejects(
    retrievePublicHttpText("https://public.test/start", {
      lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
      requestImpl: harness.requestImpl,
      timeoutMs: 1_000,
    }),
    (error) => error instanceof PublicHttpError && error.code === "TOO_MANY_REDIRECTS",
  );
  assert.equal(harness.state.calls.length, 6);
});
