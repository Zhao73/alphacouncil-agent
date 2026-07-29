/**
 * News for something that is not a company.
 *
 * `SOX` has no press office, files nothing, and returns nothing from a ticker news feed. Asked
 * for "recent semiconductor news" the pipeline had no way to turn the symbol into that subject,
 * so a basket run carried market-wide headlines and no industry at all.
 *
 * A basket's news identity comes from what it holds, not from a table someone maintains:
 *
 *   - **The industry** is the modal SIC group of its largest holdings. SOXX resolves to
 *     semiconductors because its holdings are semiconductor registrants, and XLE resolves to
 *     energy for the same reason. A hand-written map would drift the first time an index
 *     rebalanced; this cannot.
 *   - **The constituents** supply their own dated company news and their own 8-K filings,
 *     weighted by how much of the basket each one is. A headline about 8% of the fund is worth
 *     more than one about 0.3% of it, and the weight travels with the item so a reader can see
 *     which it was.
 *
 * What this deliberately does NOT do is let a headline reach a seat's arithmetic. A frozen
 * deterministic stance stays frozen; news informs what a seat SAYS about a stance it already
 * reached, and supplies counts that are themselves dated facts. Anything else would make the
 * same symbol answer differently depending on what was published that morning, which is the
 * property this whole runtime exists to avoid.
 */

import { applyRecencyGate, fetchFeed, filingsFeed, queryNewsFeed, tickerNewsFeed } from "./feeds.mjs";
import { sicGroupFor } from "./industry.mjs";
import { fetchSubmissions, fetchUniverse } from "./sec.mjs";

/** How many of the largest holdings are read for news. Weight decays; attention should too. */
export const NEWS_CONSTITUENT_LIMIT = 10;

/** Recency gate for a basket, in days. Wider than a single company's because a sector moves slower. */
export const BASKET_NEWS_DAYS = 14;

const finite = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The industry a basket is, derived from the registrants it holds.
 *
 * Weighted rather than counted: an index with forty small biotech names and two enormous
 * semiconductor ones is a semiconductor bet, and a headcount would say otherwise.
 */
export function dominantIndustry(sicByTicker, holdings) {
  return industryMix(sicByTicker, holdings)[0] || null;
}

/**
 * The industries a basket actually is, largest first, until they account for most of it.
 *
 * A single label is right for SOXX, where semiconductors are half the fund, and wrong for a
 * broad industrial basket whose largest group is eleven percent of it -- calling that one
 * "electronics" would query the wrong news and state it with more confidence than the holdings
 * support. Taking groups until they cover half the read weight gives an industrial fund its
 * aerospace, machinery and transport news instead of one misleading query.
 */
export function industryMix(sicByTicker, holdings, { cover = 0.5, max = 3 } = {}) {
  const weightByGroup = new Map();
  for (const holding of holdings || []) {
    const ticker = String(holding?.ticker || "").toUpperCase();
    const sic = sicByTicker?.get?.(ticker);
    const group = sic ? sicGroupFor(sic) : null;
    if (!group || !finite(holding?.weight)) continue;
    const current = weightByGroup.get(group.id) || { group, weight: 0, members: 0 };
    weightByGroup.set(group.id, { group, weight: current.weight + holding.weight, members: current.members + 1 });
  }
  if (!weightByGroup.size) return [];
  const ranked = [...weightByGroup.values()].sort((left, right) => right.weight - left.weight);
  const chosen = [];
  let cumulative = 0;
  for (const entry of ranked) {
    if (chosen.length >= max || (chosen.length && cumulative >= cover)) break;
    chosen.push({
      id: entry.group.id,
      title: entry.group.title,
      weight: Number(entry.weight.toFixed(6)),
      members: entry.members,
      // A basket whose largest industry is a third of it is not "a semiconductor fund", and
      // the share is reported so a reader can judge rather than being told a single label.
      is_concentrated: entry.weight >= 0.5,
    });
    cumulative += entry.weight;
  }
  return chosen;
}

/**
 * Industry and constituent news for a basket, every item carrying its own publication date.
 *
 * `asOf` is honoured by the recency gate, so a historical run cannot pick up items published
 * after the date it claims to be reasoning at.
 */
export async function fetchBasketNews(holdings, { asOf = null, days = BASKET_NEWS_DAYS, signal, limit = NEWS_CONSTITUENT_LIMIT } = {}) {
  const unavailable = [];
  const ranked = [...(holdings || [])]
    .filter((holding) => holding?.ticker && finite(holding?.weight))
    .sort((left, right) => right.weight - left.weight)
    .slice(0, limit);
  if (!ranked.length) return { available: false, unavailable: ["basket news: the basket published no weighted holdings"] };

  let universe = null;
  try {
    universe = new Map((await fetchUniverse({ signal })).map((row) => [String(row.ticker).toUpperCase(), row.cik]));
  } catch (error) {
    unavailable.push(`basket news: SEC ticker universe unavailable (${String(error?.message || error)})`);
  }

  // One submissions call per constituent buys its SIC, which is what the industry is derived
  // from and what a filings feed needs anyway.
  const sicByTicker = new Map();
  const cikByTicker = new Map();
  for (const holding of ranked) {
    const ticker = String(holding.ticker).toUpperCase();
    const cik = universe?.get(ticker);
    if (!cik) { unavailable.push(`basket news ${ticker}: no SEC registrant`); continue; }
    cikByTicker.set(ticker, cik);
    try {
      const profile = await fetchSubmissions(cik, { signal });
      if (profile?.sic) sicByTicker.set(ticker, profile.sic);
    } catch (error) {
      unavailable.push(`basket news ${ticker}: ${String(error?.message || error)}`);
    }
  }

  const industries = industryMix(sicByTicker, ranked);
  const industry = industries[0] || null;
  const specs = [];
  if (industries.length) {
    // Each industry's own name is a query. Deriving them from holdings rather than from a map
    // is what makes this survive a rebalance.
    for (const group of industries) {
      specs.push({ ...queryNewsFeed(`${group.title.en} industry`), kind: "industry", scope: "industry", industry: group.id });
    }
  } else {
    unavailable.push("basket news: no holding resolved to a SIC group, so no industry could be named");
  }
  for (const holding of ranked) {
    const ticker = String(holding.ticker).toUpperCase();
    specs.push({ ...tickerNewsFeed(ticker), kind: "company", scope: "constituent", ticker, weight: holding.weight });
    const cik = cikByTicker.get(ticker);
    if (cik) specs.push({ ...filingsFeed(cik, "8-K"), kind: "filing", scope: "constituent", ticker, weight: holding.weight });
  }

  // Fetched per spec rather than through `fetchFeeds`, which returns a merged item list. The
  // whole point here is that an item keeps which constituent it belongs to and how much of the
  // basket that constituent is; a merged list has already thrown that away.
  const fetched = await Promise.all(specs.map((spec) => fetchFeed(spec.url, { source: spec.source })));
  const items = [];
  fetched.forEach((feed, index) => {
    const spec = specs[index];
    if (!feed?.ok) { unavailable.push(`basket news ${spec.source}: ${feed?.reason || "unreachable"}`); return; }
    for (const item of feed.items || []) {
      items.push({ ...item, source: feed.source, kind: spec.kind, scope: spec.scope, ticker: spec.ticker || null, weight: spec.weight ?? null, industry: spec.industry || null });
    }
  });
  const { included: dated } = applyRecencyGate(items, { days, asOf });

  // How much of the basket actually generated dated news, and how many filed. Both are counts
  // with a window, which is what makes them usable as facts rather than as impressions.
  const covered = new Set(dated.filter((item) => item.ticker).map((item) => item.ticker));
  const coverageWeight = ranked
    .filter((holding) => covered.has(String(holding.ticker).toUpperCase()))
    .reduce((sum, holding) => sum + holding.weight, 0);
  const filers = new Set(dated.filter((item) => item.kind === "filing" && item.ticker).map((item) => item.ticker));

  return {
    available: dated.length > 0,
    industry,
    industries,
    items: dated,
    window_days: days,
    constituents_read: ranked.length,
    coverage_weight: Number(coverageWeight.toFixed(6)),
    filing_event_count: filers.size,
    filing_event_weight: Number(ranked
      .filter((holding) => filers.has(String(holding.ticker).toUpperCase()))
      .reduce((sum, holding) => sum + holding.weight, 0)
      .toFixed(6)),
    unavailable,
  };
}
