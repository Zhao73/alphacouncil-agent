import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fetchFilingDocument } from "../../mcp/lib/sec.mjs";

/**
 * Every SEC JSON endpoint retried a rate-limited response while the filing-document path threw
 * on the first 429, so the documents carrying the actual disclosure -- a Form 4's transaction
 * table, an 8-K's item text -- were the easiest evidence in a run to lose. `www.sec.gov/Archives`
 * is throttled harder than `data.sec.gov`, which made the least protected path the most likely
 * to be limited. On one real run eight consecutive attempts returned 429 and the seat read no
 * original filing at all.
 */

const CIK = "0001373715";
const ACCESSION = "0001373715-26-000042";
const DOCUMENT = "primary.htm";

function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers || {} });
    const next = responses.shift();
    if (!next) throw new Error("stub exhausted");
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body ?? "",
    };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("a rate-limited filing document is retried rather than lost", async () => {
  const stub = stubFetch([
    { status: 429 },
    { status: 429 },
    { status: 200, body: "<html>Form 4 transaction table</html>" },
  ]);
  try {
    const result = await fetchFilingDocument(CIK, ACCESSION, DOCUMENT, { cache: false });
    assert.match(result.text, /transaction table/);
    assert.equal(stub.calls.length, 3, "the first two 429s must be retried");
    assert.equal(
      result.url,
      `https://www.sec.gov/Archives/edgar/data/1373715/000137371526000042/${DOCUMENT}`,
      "the archive path drops leading CIK zeros and accession dashes",
    );
    // SEC's rules are stricter than the published guidance: a request without a descriptive
    // User-Agent is what earns the 429 in the first place.
    for (const call of stub.calls) {
      assert.ok(call.headers["User-Agent"], "every attempt must identify the client");
    }
  } finally {
    stub.restore();
  }
});

test("a service-unavailable filing document is retried on the same terms", async () => {
  const stub = stubFetch([{ status: 503 }, { status: 200, body: "8-K item 4.02 text" }]);
  try {
    const result = await fetchFilingDocument(CIK, ACCESSION, DOCUMENT, { cache: false });
    assert.match(result.text, /4\.02/);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("an XSL-rendered ownership path resolves to the machine-readable SEC sibling", async () => {
  const stub = stubFetch([{ status: 200, body: "<ownershipDocument><documentType>4</documentType></ownershipDocument>" }]);
  try {
    const result = await fetchFilingDocument(
      CIK,
      ACCESSION,
      "xslF345X06/form4.xml",
      { cache: false },
    );
    assert.equal(stub.calls.length, 1);
    assert.equal(
      result.url,
      "https://www.sec.gov/Archives/edgar/data/1373715/000137371526000042/form4.xml",
    );
    assert.match(result.text, /ownershipDocument/u);
  } finally {
    stub.restore();
  }
});

test("concurrent callers for one canonical filing URL share a single SEC request", async () => {
  const stub = stubFetch([{ status: 200, body: "<ownershipDocument><rptOwnerName>Shared</rptOwnerName></ownershipDocument>" }]);
  try {
    const [first, second] = await Promise.all([
      fetchFilingDocument(CIK, ACCESSION, "xslF345X06/form4.xml", { cache: false }),
      fetchFilingDocument(CIK, ACCESSION, "form4.xml", { cache: false }),
    ]);
    assert.equal(stub.calls.length, 1);
    assert.equal(first.url, second.url);
    assert.equal(first.text, second.text);
  } finally {
    stub.restore();
  }
});

test("one caller can abort its wait without cancelling another caller on the shared filing", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  let entered;
  let release;
  const fetchEntered = new Promise((resolve) => { entered = resolve; });
  const fetchReleased = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    calls += 1;
    entered();
    await fetchReleased;
    return { ok: true, status: 200, text: async () => "<ownershipDocument>shared</ownershipDocument>" };
  };
  try {
    const first = fetchFilingDocument(CIK, ACCESSION, "xslF345X06/form4.xml", {
      cache: false,
      signal: controller.signal,
    });
    const second = fetchFilingDocument(CIK, ACCESSION, "form4.xml", { cache: false });
    await fetchEntered;
    controller.abort();
    await assert.rejects(first, /aborted/u);
    release();
    assert.match((await second).text, /shared/u);
    assert.equal(calls, 1);
  } finally {
    release?.();
    globalThis.fetch = original;
  }
});

test("the last cancelled waiter aborts the shared transport and a later caller starts fresh", async () => {
  const original = globalThis.fetch;
  const firstController = new AbortController();
  const secondController = new AbortController();
  let calls = 0;
  let transportAborts = 0;
  let entered;
  const fetchEntered = new Promise((resolve) => { entered = resolve; });
  globalThis.fetch = async (_url, { signal } = {}) => {
    calls += 1;
    if (calls > 1) {
      return { ok: true, status: 200, text: async () => "<ownershipDocument>fresh</ownershipDocument>" };
    }
    entered();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        transportAborts += 1;
        reject(signal?.reason || new Error("transport aborted"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  };
  try {
    const first = fetchFilingDocument(CIK, ACCESSION, "xslF345X06/form5.xml", {
      cache: false,
      signal: firstController.signal,
    });
    const second = fetchFilingDocument(CIK, ACCESSION, "form5.xml", {
      cache: false,
      signal: secondController.signal,
    });
    await fetchEntered;
    firstController.abort();
    secondController.abort();
    await Promise.all([
      assert.rejects(first, /abort/iu),
      assert.rejects(second, /abort/iu),
    ]);
    assert.equal(transportAborts, 1, "the shared transport is cancelled when its waiter count reaches zero");

    const fresh = await fetchFilingDocument(CIK, ACCESSION, "form5.xml", { cache: false });
    assert.match(fresh.text, /fresh/u);
    assert.equal(calls, 2, "the cancelled flight is removed so a later caller can retry");
  } finally {
    globalThis.fetch = original;
  }
});

test("an already-cancelled caller never starts an orphan SEC request", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let calls = 0;
  controller.abort();
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => "unreachable" };
  };
  try {
    await assert.rejects(
      () => fetchFilingDocument(CIK, ACCESSION, "cancelled.xml", { cache: false, signal: controller.signal }),
      /abort/iu,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("an oversized legacy cache entry fails closed before its bytes are read", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "alphacouncil-sec-cache-limit-"));
  const document = "oversized.xml";
  const url = `https://www.sec.gov/Archives/edgar/data/1373715/000137371526000042/${document}`;
  const digest = createHash("sha256").update(url).digest("hex");
  const cachePath = join(cacheDir, digest.slice(0, 2), `${digest}.txt`);
  const original = globalThis.fetch;
  let calls = 0;
  mkdirSync(join(cacheDir, digest.slice(0, 2)), { recursive: true });
  writeFileSync(cachePath, Buffer.alloc(10_000_001, 0x78));
  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => "unreachable" };
  };
  try {
    await assert.rejects(
      () => fetchFilingDocument(CIK, ACCESSION, document, { cache: true, cacheDir }),
      /cached SEC filing document exceeds the 10000000-byte text limit/u,
    );
    assert.equal(calls, 0, "an oversized cache entry is not silently converted into a network miss");
  } finally {
    globalThis.fetch = original;
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a persistently limited document fails with the status rather than pretending to be absent", async () => {
  // Bounded on purpose: a caller genuinely over budget must be told, not stalled. The failure
  // has to name the rate limit, because "429" and "this filing does not exist" are the same
  // thing in a report unless the status survives.
  const stub = stubFetch([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 200, body: "never reached" }]);
  try {
    await assert.rejects(
      () => fetchFilingDocument(CIK, ACCESSION, DOCUMENT, { cache: false }),
      /HTTP 429/,
    );
    assert.equal(stub.calls.length, 3, "the backoff stays bounded at three attempts");
  } finally {
    stub.restore();
  }
});

test("a genuine 404 is not retried, because a missing document will not appear", async () => {
  const stub = stubFetch([{ status: 404 }, { status: 200, body: "never reached" }]);
  try {
    await assert.rejects(() => fetchFilingDocument(CIK, ACCESSION, DOCUMENT, { cache: false }), /HTTP 404/);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});
