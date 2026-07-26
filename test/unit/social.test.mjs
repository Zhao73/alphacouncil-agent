import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SUBREDDITS, fetchBluesky, verifyXPost } from "../../mcp/lib/social.mjs";

// Bluesky search returns 403 without auth while getAuthorFeed does not, so the source is
// account-only. With no accounts it must report itself unconfigured rather than failed --
// those are different states, and conflating them makes a working source look broken.
test("bluesky with no handles is unconfigured, not failed", async () => {
  const r = await fetchBluesky({ handles: [] });
  assert.equal(r.ok, true);
  assert.equal(r.configured, false);
  assert.deepEqual(r.included, []);
  assert.match(r.note, /search requires authentication/);
});

// Any invented 19-digit id decodes to a plausible snowflake timestamp, so a decoded date
// proves nothing about whether a post exists. These reject before any network call.
test("verify_x_post rejects a non-numeric id without calling out", async () => {
  for (const bad of ["", "abc", "https://x.com/a/status/20", null]) {
    const r = await verifyXPost(bad);
    assert.equal(r.exists, false);
    assert.equal(r.reason, "not a numeric post id");
    assert.ok(!r.checked, "a malformed id must not reach the network");
  }
});

test("the default subreddits are equity forums, not a general-interest grab bag", () => {
  assert.ok(DEFAULT_SUBREDDITS.length >= 4);
  for (const s of DEFAULT_SUBREDDITS) assert.match(s, /^[A-Za-z]+$/, `${s} must be a bare subreddit name`);
  assert.ok(DEFAULT_SUBREDDITS.includes("stocks"));
  assert.ok(DEFAULT_SUBREDDITS.includes("investing"));
});

// The whole module exists because free X data does not. If that stops being stated in the
// payload, a reader sees Reddit counts and reasonably assumes FinTwit was covered.
test("the coverage limits name the X gap in the payload, not only in a persona", async () => {
  const { getSocialPulse } = await import("../../mcp/lib/social.mjs");
  const text = getSocialPulse.toString();
  assert.match(text, /no free discovery channel/i, "the X gap must be stated in the returned payload");
  assert.match(text, /not evidence about a business/i, "retail opinion must be marked as not evidence");
});
