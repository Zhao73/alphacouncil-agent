import { LIMITS } from "./constants.mjs";
import { parseFeed, applyRecencyGate } from "./feeds.mjs";

/**
 * Keyless social signal: retail positioning and technical-community discussion.
 *
 * The goal was an X hotspot layer. As of 2026-07-26 that is not obtainable without paying:
 * Nitter is dead (search returns nothing on every surviving instance), the X API bills per
 * post, xAI's x_search bills per call, StockTwits sits behind Cloudflare, and Bluesky's
 * searchPosts requires auth. All tested, none assumed.
 *
 * What IS free, and was verified working:
 *   - Reddit subreddit and search RSS (rate-limited; 429s under load, so it backs off)
 *   - Hacker News via the Algolia index
 *   - Bluesky getAuthorFeed for a named account, which needs no auth even though search does
 *   - X single-post verification by id via cdn.syndication.twimg.com
 *
 * The output says plainly what this is and is not. Reddit and HN are retail and engineer
 * opinion; they are NOT the professional FinTwit layer, and treating them as a proxy for it
 * is the mistake this module is written to prevent.
 */

const UA = "alphacouncil-agent/0.4 (open-source equity research; contact via repository issues)";

async function getText(url, { timeoutMs = LIMITS.QUOTE_FETCH_MS * 2, accept = "*/*" } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA, Accept: accept } });
    if (res.status === 429) return { ok: false, status: 429, reason: "rate limited" };
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    return { ok: true, status: res.status, text: await res.text() };
  } catch (error) {
    return { ok: false, status: 0, reason: String(error?.name === "AbortError" ? "timed out" : error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reddit answers 429 readily and recovers within seconds. One retry after a pause turns a
 * dead source into a working one; without it the layer reports "unavailable" for a source
 * that is merely busy, which understates coverage in a way nobody would notice.
 */
async function getTextWithBackoff(url, opts = {}) {
  const first = await getText(url, opts);
  if (first.ok || first.status !== 429) return first;
  await new Promise((r) => setTimeout(r, 2500));
  return getText(url, opts);
}

/** Subreddits whose subject matter is equities. Deliberately conservative and well-known. */
export const DEFAULT_SUBREDDITS = ["stocks", "investing", "SecurityAnalysis", "wallstreetbets", "options"];

export async function fetchReddit({ subreddits = DEFAULT_SUBREDDITS, query = null, days = 7, asOf = null } = {}) {
  const subs = (subreddits || DEFAULT_SUBREDDITS).slice(0, 6);
  // A site-wide search for a ticker name returns whatever Reddit happens to be discussing:
  // a live run for "Micron" came back with medical posts. Searching inside the equity
  // subreddits keeps the source on topic instead of quietly filling with noise.
  const specs = query
    ? [{
        source: `Reddit search in r/${subs.join("+")}`,
        url: `https://www.reddit.com/r/${subs.map(encodeURIComponent).join("+")}/search.rss`
          + `?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&t=month`,
      }]
    : subs.map((s) => ({ source: `r/${s}`, url: `https://www.reddit.com/r/${encodeURIComponent(s)}/.rss` }));

  const results = [];
  // Sequential on purpose: Reddit rate-limits aggressively and parallel requests trip it.
  for (const spec of specs) {
    const res = await getTextWithBackoff(spec.url, { accept: "application/atom+xml, application/xml" });
    results.push({
      ...spec,
      ok: res.ok,
      reason: res.reason,
      items: res.ok ? parseFeed(res.text, { source: spec.source }) : [],
    });
  }
  const gate = applyRecencyGate(results.flatMap((r) => r.items), { days, asOf });
  // Reddit search matches post bodies as well as titles, so a result whose title omits the
  // term is a legitimate hit, not noise -- filtering those out would silently drop real
  // matches. Marking where the term matched lets a reader see which ones need opening
  // instead of judging relevance from a title that was never the thing that matched.
  if (query) {
    const term = String(query).toLowerCase();
    gate.included = gate.included.map((item) => ({
      ...item,
      matched_in: String(item.title || "").toLowerCase().includes(term) ? "title" : "body (open the link to see the mention)",
    }));
  }
  return {
    platform: "reddit",
    what_this_is: "Retail investor discussion. Useful for crowding and for what a popular narrative sounds like. "
      + "It is not professional analysis and must never be cited as evidence about a business.",
    ...gate,
    feeds: results.map(({ source, ok, reason, items }) => ({ source, ok, reason, item_count: items.length })),
  };
}

export async function fetchHackerNews({ query, days = 7, asOf = null, hits = 30 } = {}) {
  if (!query) return { platform: "hackernews", ok: false, reason: "a query is required", included: [], excluded: [] };
  const now = asOf ? Date.parse(`${asOf}T23:59:59Z`) : Date.now();
  const since = Math.floor((now - days * 86400000) / 1000);
  // Algolia applies typo tolerance by default, which made "Micron" match "microkernels" and
  // "Microsoft" in a live run. Quoting the phrase and disabling typo tolerance is the fix;
  // without it the layer looks well-sourced while discussing a different subject entirely.
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(`"${query}"`)}`
    + `&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=${Math.min(hits, 50)}`
    + "&typoTolerance=false&advancedSyntax=true";
  const res = await getText(url, { accept: "application/json" });
  if (!res.ok) return { platform: "hackernews", ok: false, reason: res.reason, included: [], excluded: [] };
  let json;
  try { json = JSON.parse(res.text); } catch { return { platform: "hackernews", ok: false, reason: "unparsable response", included: [], excluded: [] }; }
  const included = (json.hits || []).map((h) => ({
    title: h.title || h.story_title,
    link: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    published_at: h.created_at,
    source: "Hacker News",
    points: h.points ?? 0,
    comments: h.num_comments ?? 0,
    discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
  })).filter((h) => h.title);
  const term = String(query).toLowerCase();
  const onTopic = included.filter((h) => h.title.toLowerCase().includes(term));
  const offTopic = included.length - onTopic.length;
  return {
    platform: "hackernews",
    ok: true,
    what_this_is: "Engineer and technical-community discussion. Its value is the comment thread, where people "
      + "who build the thing being discussed correct the article. Weak on financials, occasionally very strong "
      + "on whether a technical claim is real.",
    total_matching: json.nbHits ?? included.length,
    included: onTopic,
    // Belt and braces: the service can still return a near-match, and a near-match on a
    // ticker name is a different company.
    dropped_off_topic: offTopic,
    excluded: [],
  };
}

/**
 * Bluesky, by account only.
 *
 * searchPosts returns 403 without auth, so cashtag discovery is not possible. getAuthorFeed
 * is public, which makes a curated account list workable -- and a curated list was the right
 * design anyway: cashtag search is where the promotional accounts live.
 */
export async function fetchBluesky({ handles = [], days = 7, asOf = null, limit = 20 } = {}) {
  if (!handles.length) {
    return {
      platform: "bluesky", ok: true, configured: false, included: [], excluded: [],
      note: "No handles configured. Bluesky search requires authentication, but reading a named account does not, "
        + "so this source activates as soon as handles are supplied. Add them under social_handles.",
    };
  }
  const out = [];
  const failed = [];
  for (const handle of handles.slice(0, 12)) {
    const url = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"
      + `?actor=${encodeURIComponent(handle)}&limit=${Math.min(limit, 50)}`;
    const res = await getText(url, { accept: "application/json" });
    if (!res.ok) { failed.push({ handle, reason: res.reason }); continue; }
    let json;
    try { json = JSON.parse(res.text); } catch { failed.push({ handle, reason: "unparsable response" }); continue; }
    for (const entry of json.feed || []) {
      const post = entry.post;
      if (!post?.record?.text) continue;
      out.push({
        title: post.record.text.slice(0, 280),
        link: `https://bsky.app/profile/${handle}`,
        published_at: post.record.createdAt || null,
        source: `bluesky:${handle}`,
        likes: post.likeCount ?? null,
        reposts: post.repostCount ?? null,
        replies: post.replyCount ?? null,
      });
    }
  }
  const gate = applyRecencyGate(out, { days, asOf });
  return {
    platform: "bluesky", ok: true, configured: true,
    what_this_is: "Named accounts only, because search needs auth. Whatever these accounts are worth is what "
      + "this source is worth -- the curation is the signal, and it is the user's, not this tool's.",
    ...gate,
    handles_failed: failed,
  };
}

/**
 * Verify one X post really exists and says what it was quoted as saying.
 *
 * The endpoint is undocumented and unsupported, so it is used only for verification, never
 * as a data source. It closes a specific hole: a decoded snowflake timestamp proves nothing,
 * because any made-up 19-digit id decodes to a plausible date. Existence has to be checked.
 */
export async function verifyXPost(id) {
  const clean = String(id || "").trim();
  if (!/^\d{1,20}$/.test(clean)) return { id, exists: false, reason: "not a numeric post id" };
  const res = await getText(`https://cdn.syndication.twimg.com/tweet-result?id=${clean}&lang=en&token=a`, { accept: "application/json" });
  if (!res.ok) {
    // A 404 here is the meaningful answer: the id does not exist.
    return { id: clean, exists: false, reason: res.status === 404 ? "no such post" : res.reason, checked: true };
  }
  let json;
  try { json = JSON.parse(res.text); } catch { return { id: clean, exists: false, reason: "unparsable response", checked: true }; }
  if (!json?.text) return { id: clean, exists: false, reason: "response carries no post text", checked: true };
  return {
    id: clean,
    exists: true,
    text: json.text,
    created_at: json.created_at ?? null,
    author: json.user?.screen_name ?? null,
    favorite_count: json.favorite_count ?? null,
    note: "Verified against an undocumented endpoint. Use to confirm a quoted post, not as a data feed.",
  };
}

export async function getSocialPulse({ query = null, symbol = null, subreddits, handles = [], days = 7, asOf = null } = {}) {
  const term = query || symbol;
  const [reddit, hn, bsky] = await Promise.all([
    fetchReddit({ subreddits, query: term, days, asOf }).catch((e) => ({ platform: "reddit", ok: false, reason: String(e?.message || e), included: [] })),
    term ? fetchHackerNews({ query: term, days, asOf }) : Promise.resolve({ platform: "hackernews", ok: true, skipped: "no query given", included: [] }),
    fetchBluesky({ handles, days, asOf }).catch((e) => ({ platform: "bluesky", ok: false, reason: String(e?.message || e), included: [] })),
  ]);

  const counts = {
    reddit: reddit.included?.length ?? 0,
    hackernews: hn.included?.length ?? 0,
    bluesky: bsky.included?.length ?? 0,
  };

  return {
    as_of: asOf || new Date().toISOString().slice(0, 10),
    window_days: days,
    query: term,
    platforms: { reddit, hackernews: hn, bluesky: bsky },
    counts,
    total: counts.reddit + counts.hackernews + counts.bluesky,
    // Stated in the payload, not only in a persona, because the payload is what gets quoted.
    coverage_limits: [
      "X / Twitter has no free discovery channel as of 2026-07. Nitter search is dead on every "
      + "surviving instance, the X API bills per post retrieved, and xAI's x_search bills per call. "
      + "This layer therefore does NOT cover professional FinTwit, which is where most of the "
      + "genuinely early equity discussion happens. Treating Reddit as a substitute for it is wrong.",
      "StockTwits is behind Cloudflare and Bluesky search requires authentication; neither is "
      + "reachable without credentials, so neither is used.",
      "Reddit and Hacker News are retail and engineer opinion. They evidence what a narrative "
      + "sounds like and how crowded it is. They are not evidence about a business.",
      "Engagement counts are unavailable on Reddit RSS. Where a count is absent it is reported "
      + "absent rather than estimated.",
    ],
    how_to_use: [
      "Look for CONTRADICTION, not agreement. A view held loudly here that the filings do not support "
      + "is a crowding signal; agreement with the filings adds nothing you did not have.",
      "A claim from this layer may never enter the conclusion on its own. It is a lead, to be "
      + "confirmed against a filing or a dated source, or else recorded in open_questions.",
      "Volume of mentions measures attention, not correctness, and the loudest posts are the most "
      + "emotional ones. Do not rank by engagement and then read the top as representative.",
    ],
  };
}
