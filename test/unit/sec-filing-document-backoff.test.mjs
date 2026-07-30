import { test } from "node:test";
import assert from "node:assert/strict";

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
    const result = await fetchFilingDocument(CIK, ACCESSION, DOCUMENT);
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
    const result = await fetchFilingDocument(CIK, ACCESSION, DOCUMENT);
    assert.match(result.text, /4\.02/);
    assert.equal(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("a persistently limited document fails with the status rather than pretending to be absent", async () => {
  // Bounded on purpose: a caller genuinely over budget must be told, not stalled. The failure
  // has to name the rate limit, because "429" and "this filing does not exist" are the same
  // thing in a report unless the status survives.
  const stub = stubFetch([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 200, body: "never reached" }]);
  try {
    await assert.rejects(
      () => fetchFilingDocument(CIK, ACCESSION, DOCUMENT),
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
    await assert.rejects(() => fetchFilingDocument(CIK, ACCESSION, DOCUMENT), /HTTP 404/);
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});
