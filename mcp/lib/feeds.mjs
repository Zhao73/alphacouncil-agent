import { LIMITS } from "./constants.mjs";
import { secUserAgent } from "./sec.mjs";

/**
 * Minimal RSS/Atom reading, zero dependencies.
 *
 * The rule that makes this layer worth having is the recency gate: every item must carry a
 * timestamp that parses and falls inside the requested window, or it is reported as
 * excluded rather than quietly included. Without it a "latest news" section fills with
 * three-year-old articles that read exactly like today's, and no reader can tell.
 */

const tag = (xml, name) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return m ? decode(m[1]) : null;
};

/** Atom links carry the URL in an attribute rather than in the element body. */
const atomLink = (xml) => {
  const m = /<link[^>]*href=["']([^"']+)["'][^>]*>/i.exec(xml);
  return m ? decode(m[1]) : null;
};

function decode(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parse RSS <item> and Atom <entry> into one shape. */
export function parseFeed(xml, { source = null } = {}) {
  const text = String(xml || "");
  const blocks = text.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  return blocks.map((block) => {
    const published = tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || null;
    const at = published ? Date.parse(published) : NaN;
    return {
      title: tag(block, "title"),
      link: tag(block, "link") || atomLink(block),
      published_raw: published,
      published_at: Number.isFinite(at) ? new Date(at).toISOString() : null,
      source,
    };
  }).filter((item) => item.title);
}

/**
 * Split items by whether their timestamp is inside the window.
 *
 * Undated items go to excluded, not to included. A headline with no date cannot be shown
 * as recent, and guessing its date from position in the feed is how stale news gets
 * presented as current.
 */
export function applyRecencyGate(items, { days = 14, asOf = null } = {}) {
  const now = asOf ? Date.parse(`${asOf}T23:59:59Z`) : Date.now();
  const floor = now - days * 86400000;
  const included = [];
  const excluded = [];
  for (const item of items) {
    const at = item.published_at ? Date.parse(item.published_at) : NaN;
    if (!Number.isFinite(at)) excluded.push({ ...item, excluded_because: "no parsable timestamp" });
    else if (at < floor) excluded.push({ ...item, excluded_because: `older than ${days}d` });
    else if (at > now + 86400000) excluded.push({ ...item, excluded_because: "timestamp in the future" });
    else included.push(item);
  }
  included.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return { included, excluded };
}

export async function fetchFeed(url, { source = null, timeoutMs = LIMITS.QUOTE_FETCH_MS * 2 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      // SEC requires a contact in the UA and returns 403 HTML without one; harmless elsewhere.
      headers: { "User-Agent": secUserAgent(), Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) return { url, source, ok: false, reason: `HTTP ${res.status}`, items: [] };
    return { url, source, ok: true, items: parseFeed(await res.text(), { source }) };
  } catch (error) {
    return { url, source, ok: false, reason: String(error?.name === "AbortError" ? "timed out" : error?.message || error), items: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch several feeds concurrently; a dead feed is reported, never silently dropped. */
export async function fetchFeeds(specs, { days = 14, asOf = null } = {}) {
  const results = await Promise.all(specs.map((s) => fetchFeed(s.url, { source: s.source })));
  const all = results.flatMap((r) => r.items);
  const { included, excluded } = applyRecencyGate(all, { days, asOf });
  return {
    items: included,
    feeds: results.map(({ url, source, ok, reason, items }) => ({ source, url, ok, reason, item_count: items.length })),
    excluded_outside_window: excluded.length,
    excluded_sample: excluded.slice(0, 5).map((e) => ({ title: e.title, published_at: e.published_at, why: e.excluded_because })),
    unreachable: results.filter((r) => !r.ok).map((r) => ({ source: r.source, reason: r.reason })),
  };
}

// ---- named feeds ----------------------------------------------------------

export const tickerNewsFeed = (symbol) => ({
  source: "Yahoo Finance RSS",
  url: `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
});

export const queryNewsFeed = (query) => ({
  source: "Google News RSS",
  url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`,
});

/** A company's own filings, which are the one news source that cannot be spun. */
export const filingsFeed = (cik, forms = "8-K") => ({
  source: `SEC EDGAR ${forms}`,
  url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany"
    + `&CIK=${encodeURIComponent(String(cik).padStart(10, "0"))}`
    + `&type=${encodeURIComponent(forms)}&dateb=&owner=include&count=40&output=atom`,
});

/**
 * Broad feeds used to read what the market is talking about rather than what one company
 * did. Deliberately mixes a regulator, a central bank and general market press: a theme
 * that only appears in press is a story, one that also appears at the Fed is a policy fact.
 */
export const MARKET_FEEDS = [
  { source: "Federal Reserve press", url: "https://www.federalreserve.gov/feeds/press_all.xml", kind: "policy" },
  { source: "SEC press", url: "https://www.sec.gov/news/pressreleases.rss", kind: "policy" },
  { source: "WSJ Markets", url: "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", kind: "press" },
  { source: "WSJ World News", url: "https://feeds.a.dj.com/rss/RSSWorldNews.xml", kind: "press" },
  { source: "CNBC Finance", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", kind: "press" },
  { source: "Yahoo Finance", url: "https://finance.yahoo.com/news/rssindex", kind: "press" },
];
