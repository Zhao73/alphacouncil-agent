/**
 * Turn a fund or index into typed-fact candidates, including look-through.
 *
 * A basket has no income statement, which is why twenty-five method seats used to abstain on
 * QQQ. But Buffett defined look-through earnings in the 1990 shareholder letter for exactly
 * this situation -- owning pieces of many businesses -- so aggregating the constituents'
 * ratios by weight is the method's own answer, not a workaround bolted onto it.
 *
 * The aggregation itself lives in `funds.mjs`, which refuses to express an absolute-currency
 * sum at all. This module's job is orchestration and honesty about coverage: every
 * look-through fact carries the weight it was computed over, because a portfolio ratio
 * measured across 8% of the basket is a different claim from one measured across 95%.
 */

import { LIMITS } from "./constants.mjs";
import {
  MIN_LOOK_THROUGH_COVERAGE,
  fetchFundHoldings,
  fetchFundMetadata,
  lookThroughAggregate,
  topHoldingsCoverage,
} from "./funds.mjs";
import { fetchIndexAggregate, INDEX_PROXIES, normalizeIndexSymbol } from "./index-aggregate.mjs";
import { fetchImpliedErp } from "./damodaran.mjs";
import { chartUrl, fetchBasketBreadth, parseDailyCloses } from "./breadth.mjs";
import { fetchText } from "./quotes.mjs";
import { deriveFundamentals } from "./fundamentals.mjs";
import { evaluateRules } from "./screen.mjs";
import { fetchCompanyFacts, fetchUniverse } from "./sec.mjs";

/**
 * How many constituents may be resolved for a look-through pass.
 *
 * Every constituent costs one filing fetch, and weights decay fast enough that the tail buys
 * coverage very slowly: on a cap-weighted basket the top forty names usually clear 60%.
 * ponytail: fixed cap, revisit if a genuinely equal-weighted basket needs the tail.
 */
export const LOOK_THROUGH_MAX_CONSTITUENTS = 40;
export const LOOK_THROUGH_TARGET_COVERAGE = 0.6;

/**
 * The operating-company facts a basket can supply by aggregating its constituents.
 *
 * Only ratios appear here. An absolute-currency look-through would be "ETF revenue", which is
 * a category error `funds.mjs` refuses to express at all.
 */
/**
 * Pack fact id -> the aggregation rule that governs it in `funds.mjs`.
 *
 * The two vocabularies differ on purpose: the aggregator is named for the SHAPE of a metric
 * (a price multiple aggregates harmonically, a margin arithmetically), while a pack asks for
 * the fact it reasons about. Keeping the translation explicit here means neither side has to
 * rename anything, and an unmapped fact simply produces no look-through value rather than a
 * silently mis-aggregated one.
 *
 * Only ratios appear. An absolute-currency look-through would be "ETF revenue", which is a
 * category error `funds.mjs` refuses to express at all.
 */
export const LOOK_THROUGH_FACT_RULES = Object.freeze({
  "financial.leverage": "leverage.debt_to_equity",
  "valuation.revenue_growth": "growth.revenue_growth",
  // Every one of these is a pure ratio that a weighted mean of constituents answers honestly,
  // and every one of them was already legal to aggregate -- it simply had no line here, which
  // is why eighteen seats stayed silent on a basket whose data was complete.
  "accounting.cash_conversion": "accounting.cash_conversion",
  "financial.gross_margin_5y": "profitability.gross_margin",
  "financial.net_margin_5y": "profitability.net_margin",
  "financial.return_on_equity_10y": "profitability.return_on_equity_10y",
  "financial.incremental_return_on_capital": "profitability.incremental_return_on_capital",
  "financial.interest_coverage": "coverage.interest_coverage",
});

/**
 * Facts a constituent publishes that are NOT aggregable, and why.
 *
 * Owner earnings, NCAV and the downside values are absolute currency amounts. Summing them
 * across a basket produces "the ETF's owner earnings", which is the exact category error the
 * whole look-through discipline exists to prevent. Turning them into a portfolio number needs
 * a per-constituent denominator -- market capitalisation -- so they become yields first. That
 * is real and worth doing; it is simply not this pass, and pretending otherwise by summing is
 * the failure mode, not the shortcut.
 */
/**
 * Absolute company figures a fund owns a real, computable dollar share of.
 *
 * `LOOK_THROUGH_BLOCKED` refuses the naive version of this and is right to: summing every
 * constituent's owner earnings produces "the ETF's owner earnings" as though the fund owned
 * each business outright, which it does not. What the fund does own is a stake — its position
 * value over the company's market capitalisation — and that stake's claim on the figure is
 * ordinary look-through accounting:
 *
 *     fund's claim = AUM x SUM over i of ( weight_i / market_cap_i ) x figure_i
 *
 * The result is in dollars and is the fund's, not the index's. Because the fund's own market
 * capitalisation is its AUM, every seat that divides one of these by market capitalisation
 * gets the weighted look-through yield without a single change to its method.
 */
export const LOOK_THROUGH_CLAIM_FACTS = Object.freeze([
  "financial.owner_earnings",
  "financial.free_cash_flow_5y",
  "financial.net_current_asset_value",
  "valuation.downside_asset_value",
  "valuation.downside_floor",
]);

export const LOOK_THROUGH_BLOCKED = Object.freeze({
  "financial.owner_earnings": "absolute currency; needs a per-constituent market capitalisation to become a yield",
  "financial.net_current_asset_value": "absolute currency; needs a per-constituent market capitalisation to become a ratio",
  "valuation.downside_asset_value": "absolute currency; needs a per-constituent market capitalisation to become a ratio",
  "valuation.downside_floor": "absolute currency; needs a per-constituent market capitalisation to become a ratio",
  "capital_allocation.share_count": "a count, not a rate; it has no portfolio-level meaning",
});

/**
 * Mechanical-screen rule id -> the pack fact id it supplies, mirroring the grounding adapter's
 * own map. Percent rules publish 15 for 15%, and every pack ratio is a decimal.
 */
const SCREEN_RULE_FACTS = Object.freeze({
  roe_10y: "financial.return_on_equity_10y",
  interest_cover: "financial.interest_coverage",
  gross_margin: "financial.gross_margin_5y",
  ocf_over_ni: "accounting.cash_conversion",
  net_margin: "financial.net_margin_5y",
  // An absolute, and the only one the screen carries. It is not aggregated as a ratio -- it
  // feeds the ownership-claim pass, where dollars are the right unit.
  fcf_5y: "financial.free_cash_flow_5y",
});
const SCREEN_PERCENT_RULES = new Set(["roe_10y", "gross_margin", "net_margin"]);

/**
 * The unit a look-through fact must carry.
 *
 * The aggregate of a quantity IS that quantity, so it has to arrive under the same contract the
 * single-company path declares. Emitting every aggregate as a bare `decimal` made the executor
 * reject coverage and cash conversion, which are multiples -- the fact was present and unusable,
 * which reads exactly like the fact being absent.
 */
const LOOK_THROUGH_UNITS = Object.freeze({
  "financial.interest_coverage": "multiple",
  "accounting.cash_conversion": "multiple",
});

export const LOOK_THROUGH_FACT_IDS = Object.freeze(Object.keys(LOOK_THROUGH_FACT_RULES));

const finite = (value) => typeof value === "number" && Number.isFinite(value);

/**
 * The index whose published valuation describes a fund's portfolio.
 *
 * A cap-weighted tracker holds the index, so the index's aggregate P/E is the honest
 * valuation of the fund's book -- and it is the only same-basis aggregate available for free.
 * Derived by inverting the proxy map so the two directions cannot drift apart: whichever ETF
 * stands in for an index is also the ETF that borrows that index's valuation.
 */
const VALUATION_INDEX_BY_FUND = Object.freeze(Object.fromEntries(
  Object.entries(INDEX_PROXIES).flatMap(([index, proxy]) => (
    [proxy.etf, ...(proxy.alternates || [])].map((etf) => [etf, index])
  )),
));

export function valuationIndexFor(symbol) {
  return VALUATION_INDEX_BY_FUND[String(symbol || "").trim().toUpperCase()] || null;
}

/**
 * Facts an index publishes about itself. Each carries its basis, because index P/E is quoted
 * on incompatible bases and a fact that does not name its own is unusable.
 */
function valuationFacts(aggregate) {
  const valuation = aggregate?.valuation;
  if (!valuation || !finite(valuation.pe_trailing)) return [];
  const facts = [];
  const shared = {
    source_kind: "market_snapshot",
    source_url: valuation.source_url,
    public_at: valuation.public_at,
    observation_date: valuation.trade_date,
    basis: valuation.basis,
    title: `${valuation.name} valuation (${valuation.basis})`,
    confidence: 0.8,
  };
  facts.push({
    ...shared,
    fact_id: "index.aggregate_pe_ttm",
    value: valuation.pe_trailing,
    value_kind: "ratio",
    unit: "multiple",
    ratio_denominator: "trailing_twelve_month_earnings",
    method: valuation.basis,
  });
  // The reciprocal is what a valuation method actually compares against a bond yield, so it
  // is published as its own fact rather than left for each seat to recompute differently.
  facts.push({
    ...shared,
    fact_id: "index.aggregate_earnings_yield",
    value: Number((1 / valuation.pe_trailing).toFixed(6)),
    value_kind: "ratio",
    unit: "decimal",
    ratio_denominator: "price",
    method: `reciprocal_of_${valuation.basis}_trailing_pe`,
  });
  if (finite(valuation.pe_forward)) {
    facts.push({
      ...shared,
      fact_id: "index.aggregate_pe_forward",
      value: valuation.pe_forward,
      value_kind: "ratio",
      unit: "multiple",
      ratio_denominator: "forward_twelve_month_earnings",
      method: `${valuation.basis}_forward`,
    });
  }
  if (finite(valuation.dividend_yield)) {
    facts.push({
      ...shared,
      fact_id: "index.dividend_yield",
      // Declared as percent by the source; the typed-fact contract is decimal.
      value: valuation.dividend_yield / 100,
      value_kind: "ratio",
      unit: "decimal",
      ratio_denominator: "price",
      method: valuation.basis,
    });
  }
  return facts;
}

/** Concentration and cost, which are properties of the wrapper rather than of the businesses. */
function structureFacts(holdings, metadata) {
  const facts = [];
  if (!holdings?.holdings?.length) return facts;
  const shared = {
    source_kind: "issuer_disclosure",
    source_url: holdings.source_url,
    public_at: holdings.public_at,
    observation_date: holdings.as_of,
    confidence: 0.9,
    derivation: "rederived",
  };
  const sorted = [...holdings.holdings].sort((left, right) => (right.weight || 0) - (left.weight || 0));
  const topTen = sorted.slice(0, 10).reduce((sum, row) => sum + (row.weight || 0), 0);
  facts.push({
    ...shared,
    fact_id: "fund.top_ten_weight",
    value: Number(topTen.toFixed(6)),
    value_kind: "ratio",
    unit: "decimal",
    ratio_denominator: "portfolio_weight",
    method: "sum_of_ten_largest_published_weights",
    title: `${holdings.symbol} top-ten concentration`,
  });
  // Herfindahl over published weights: one number that separates "a basket" from "three
  // positions and some rounding".
  const hhi = sorted.reduce((sum, row) => sum + ((row.weight || 0) ** 2), 0);
  facts.push({
    ...shared,
    fact_id: "fund.concentration_hhi",
    value: Number(hhi.toFixed(6)),
    value_kind: "ratio",
    unit: "decimal",
    ratio_denominator: "sum_of_squared_weights",
    method: "herfindahl_over_published_weights",
    title: `${holdings.symbol} concentration index`,
  });
  if (finite(metadata?.expense_ratio)) {
    // Issuers publish the fee as a percent; the typed-fact contract is a decimal fraction.
    // Passing it through unconverted is a hundredfold error that looks entirely plausible.
    const asDecimal = metadata.expense_ratio_unit === "percent"
      ? metadata.expense_ratio / 100
      : metadata.expense_ratio;
    facts.push({
      ...shared,
      fact_id: "fund.expense_ratio",
      value: Number(asDecimal.toFixed(6)),
      value_kind: "ratio",
      unit: "decimal",
      ratio_denominator: "net_assets",
      derivation: "reported",
      source_url: metadata.source_url || holdings.source_url,
      public_at: metadata.public_at || holdings.public_at,
      method: "issuer_published",
      title: `${holdings.symbol} expense ratio`,
    });
  }
  return facts;
}

/**
 * Resolve constituent fundamentals for a look-through pass.
 *
 * One filing fetch per constituent, bounded twice over: by `LOOK_THROUGH_MAX_CONSTITUENTS`
 * and by stopping as soon as the target coverage weight is reached. A constituent that cannot
 * be resolved -- a foreign filer, a share class the ticker map does not carry -- is skipped
 * rather than substituted, and its weight simply does not count toward coverage. That keeps
 * the coverage number honest, which is the only thing that makes the aggregate meaningful.
 */
/**
 * True when a diagnostic names a fact the pack ended up producing anyway. Matching is by the
 * fact id appearing in the note, so a note that names no fact is always kept.
 */
function factsProducedFor(note, facts) {
  const produced = new Set(facts.map((fact) => fact.fact_id));
  return [...produced].some((factId) => String(note).includes(factId))
    || (/implied equity risk premium/iu.test(note) && produced.has("valuation.implied_erp"))
    || (/valuation percentile/iu.test(note) && produced.has("cycle.valuation_percentile"));
}

export async function resolveConstituentFacts(holdings, { signal, asOf = null, concurrency = 6 } = {}) {
  const perHolding = new Map();
  // The aggregate inherits whatever span its inputs covered; without carrying it the basket
  // fact arrives as a bare number that no duration contract can accept.
  const perHoldingPeriods = new Map();
  // A share count is not aggregable and is not aggregated. It is kept because a market
  // capitalisation -- shares times price -- is what turns an absolute figure into the fund's
  // own dollar claim on it.
  const shareCounts = new Map();
  const unavailable = [];
  const ranked = [...holdings]
    .sort((left, right) => (right.weight || 0) - (left.weight || 0))
    .slice(0, LOOK_THROUGH_MAX_CONSTITUENTS);
  if (!ranked.length) return { perHolding, perHoldingPeriods, shareCounts, unavailable, attempted: 0 };

  let universe = null;
  try {
    universe = new Map((await fetchUniverse({ signal }))
      .map((row) => [String(row.ticker).toUpperCase(), row.cik]));
  } catch (error) {
    return {
      perHolding,
      perHoldingPeriods,
      shareCounts,
      unavailable: [`look-through: SEC ticker universe unavailable (${String(error?.message || error)})`],
      attempted: 0,
    };
  }

  const queue = [...ranked];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const ticker = String(next.ticker || "").toUpperCase();
      const cik = universe.get(ticker);
      if (!cik) { unavailable.push(`look-through ${ticker}: no SEC registrant for this ticker`); continue; }
      try {
        // One document, both readers. The derived fundamentals and the mechanical screen read
        // the same Company Facts filing, and fetching it twice per constituent would double
        // the cost of a look-through for metrics that were already on disk. The screen is
        // where the margins, cash conversion, ten-year ROE and interest coverage live -- which
        // is why wiring only the fundamentals path left those aggregates permanently empty.
        const companyFacts = await fetchCompanyFacts(cik, { signal });
        const derived = deriveFundamentals({ companyFacts, asOf });
        const screened = evaluateRules(companyFacts, { asOf });
        const facts = {};
        const periods = {};
        for (const rule of screened.rules || []) {
          const factId = SCREEN_RULE_FACTS[rule?.id];
          if (!factId || rule.skipped || !Number.isFinite(rule.value)) continue;
          // The screen publishes percentages as 15 for 15%; every pack ratio is a decimal.
          facts[factId] = SCREEN_PERCENT_RULES.has(rule.id) ? rule.value / 100 : rule.value;
          if (rule.period_start && rule.period_end) {
            periods[factId] = { start: rule.period_start, end: rule.period_end };
          }
        }
        for (const [factId, metric] of Object.entries(derived.metrics || {})) {
          if (!metric || !Number.isFinite(metric.value)) continue;
          facts[factId] = metric.value;
          if (factId === "capital_allocation.share_count") shareCounts.set(ticker, metric.value);
          if (metric.period_start && metric.period_end) {
            periods[factId] = { start: metric.period_start, end: metric.period_end };
          }
        }
        if (Object.keys(facts).length) perHolding.set(ticker, facts);
        if (Object.keys(periods).length) perHoldingPeriods.set(ticker, periods);
      } catch (error) {
        unavailable.push(`look-through ${ticker}: ${String(error?.message || error)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ranked.length) }, worker));
  return { perHolding, perHoldingPeriods, shareCounts, unavailable, attempted: ranked.length };
}

/**
 * Aggregate constituent ratios into portfolio-level operating-company facts.
 *
 * `perHoldingFacts` is supplied by the caller rather than fetched here: resolving it means one
 * filing per constituent, and the caller owns the budget for that. Passing an empty map is a
 * valid, cheap run -- it yields no look-through facts and one explicit gap, which is the
 * correct outcome and not a failure.
 */
/**
 * The interval a basket-level aggregate covers.
 *
 * The outer envelope -- earliest start to latest end -- is the wrong answer. Constituents keep
 * different fiscal calendars, so the union of forty five-year spans is five years plus a year
 * of calendar edges, and a fact that genuinely covers five years then fails a five-year
 * contract for a reason that has nothing to do with its coverage.
 *
 * The median end date and the median span describe what the aggregate actually covers: a
 * typical constituent's reporting window, which is the window the number was averaged over.
 */
function aggregatePeriod(perHoldingPeriods, factId, tickers) {
  const spans = [];
  for (const ticker of tickers) {
    const span = perHoldingPeriods?.get(ticker)?.[factId];
    if (!span?.start || !span?.end) continue;
    const start = Date.parse(span.start);
    const end = Date.parse(span.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    spans.push({ end, days: (end - start) / 86_400_000 });
  }
  if (!spans.length) return {};
  const median = (values) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const end = median(spans.map((span) => span.end));
  const days = median(spans.map((span) => span.days));
  return {
    period_start: new Date(end - days * 86_400_000).toISOString().slice(0, 10),
    period_end: new Date(end).toISOString().slice(0, 10),
  };
}

/**
 * The dollar claim a fund has on an absolute company figure, summed across constituents.
 *
 * Requires a market capitalisation per constituent, which is its own filed share count times
 * its last close — both already in hand from the fundamentals pass and the breadth pass. A
 * constituent missing either is excluded and costs coverage rather than being assumed.
 */
/**
 * A share count for a fund whose issuer publishes none.
 *
 * Two of the four issuers disclose shares outstanding and two do not, and the seats that need
 * a market capitalisation do not care which. The assets implied by the disclosed positions,
 * divided by what the fund itself trades at, reconstructs the count. The product of the two is
 * the size we already had, so this adds no new claim -- it puts a number the seats can use
 * where a filed one is absent, and says in `method` that it is not a filed one.
 */
async function impliedFundShares(symbol, netAssets, metadata, signal) {
  if (finite(metadata?.nav) && metadata.nav > 0 && finite(netAssets)) {
    return { value: netAssets / metadata.nav, how: "assets_from_disclosed_positions_over_nav" };
  }
  if (!finite(netAssets) || netAssets <= 0) return null;
  try {
    const closes = parseDailyCloses(JSON.parse(await fetchText(chartUrl(symbol), LIMITS.QUOTE_FETCH_MS, signal)));
    const close = closes?.at(-1);
    if (!finite(close) || close <= 0) return null;
    return { value: netAssets / close, how: "assets_from_disclosed_positions_over_market_price" };
  } catch {
    return null;
  }
}

export function lookThroughClaims({ holdings, perHoldingFacts, perHoldingPeriods, shareCounts, closes, netAssets, holdingsMeta }) {
  const facts = [];
  const unavailable = [];
  if (!finite(netAssets) || netAssets <= 0) {
    unavailable.push("look-through claims: the fund's own size is unknown, so a dollar claim cannot be scaled");
    return { facts, unavailable };
  }
  const priced = new Map();
  for (const holding of holdings || []) {
    const ticker = String(holding?.ticker || "").toUpperCase();
    const shares = shareCounts?.get?.(ticker);
    const close = closes?.[ticker];
    if (!finite(holding?.weight) || !finite(shares) || shares <= 0 || !finite(close) || close <= 0) continue;
    priced.set(ticker, { weight: holding.weight, marketCap: shares * close });
  }
  if (!priced.size) {
    unavailable.push("look-through claims: no constituent supplied both a share count and a price");
    return { facts, unavailable };
  }
  for (const factId of LOOK_THROUGH_CLAIM_FACTS) {
    let claim = 0;
    let covered = 0;
    for (const [ticker, { weight, marketCap }] of priced) {
      const value = perHoldingFacts?.get?.(ticker)?.[factId];
      if (!finite(value)) continue;
      claim += (weight / marketCap) * value;
      covered += weight;
    }
    if (covered < MIN_LOOK_THROUGH_COVERAGE) {
      unavailable.push(
        `look-through claim ${factId}: ${(covered * 100).toFixed(1)}% of the basket by weight supplied it,`
        + ` below the ${(MIN_LOOK_THROUGH_COVERAGE * 100).toFixed(0)}% floor`,
      );
      continue;
    }
    facts.push({
      fact_id: factId,
      value: Number((claim * netAssets).toFixed(2)),
      // A claim on a one-year figure covers a year and a claim on a five-year total covers
      // five. It inherits the window its inputs reported, for the same reason the ratio
      // aggregates do.
      ...aggregatePeriod(perHoldingPeriods, factId, [...priced.keys()]),
      value_kind: "monetary",
      unit: "currency_units",
      currency: "USD",
      scale: 1,
      source_kind: "issuer_disclosure",
      source_url: holdingsMeta?.source_url,
      public_at: holdingsMeta?.public_at,
      observation_date: holdingsMeta?.as_of,
      confidence: 0.65,
      derivation: "rederived",
      method: "fund_ownership_share_of_constituent_figure",
      coverage_weight: Number(covered.toFixed(6)),
      title: `${holdingsMeta?.symbol || "fund"} look-through claim on ${factId}`,
    });
  }
  return { facts, unavailable };
}

export function lookThroughFacts({ holdings, perHoldingFacts, perHoldingPeriods, factIds, holdingsMeta }) {
  const facts = [];
  const unavailable = [];
  if (!holdings?.length) return { facts, unavailable };
  const coverage = topHoldingsCoverage(holdings, { minWeight: LOOK_THROUGH_TARGET_COVERAGE });
  for (const factId of factIds) {
    const rule = LOOK_THROUGH_FACT_RULES[factId];
    if (!rule) {
      unavailable.push(`look-through ${factId}: ${LOOK_THROUGH_BLOCKED[factId] || "no aggregation rule is defined for this fact"}`);
      continue;
    }
    // The aggregator reads one number per ticker; the rule name selects how it is combined.
    const byTicker = new Map([...perHoldingFacts]
      .filter(([, facts]) => Number.isFinite(facts?.[factId]))
      .map(([ticker, facts]) => [ticker, facts[factId]]));
    const aggregate = lookThroughAggregate({
      holdings: coverage.holdings,
      perHoldingFacts: byTicker,
      factId: rule,
      coverageWeight: coverage.coverage_weight,
    });
    if (!aggregate || !finite(aggregate.value)) {
      unavailable.push(`look-through ${factId}: ${aggregate?.unavailable?.join("; ") || "no constituent supplied this fact"}`);
      continue;
    }
    facts.push({
      fact_id: factId,
      value: aggregate.value,
      value_kind: "ratio",
      unit: LOOK_THROUGH_UNITS[factId] || "decimal",
      ratio_denominator: `weight_${aggregate.method}`,
      source_kind: "issuer_disclosure",
      source_url: holdingsMeta?.source_url,
      public_at: holdingsMeta?.public_at,
      observation_date: holdingsMeta?.as_of,
      ...aggregatePeriod(perHoldingPeriods, factId, [...byTicker.keys()]),
      confidence: 0.7,
      derivation: "rederived",
      method: aggregate.method,
      coverage_weight: aggregate.coverage_weight,
      title: `look-through ${factId} over ${aggregate.constituent_count} constituents`,
    });
  }
  return { facts, unavailable };
}

/**
 * Compose everything a fund or index instrument can contribute.
 *
 * An index has no issuer to publish holdings, so it borrows its tracking ETF's -- labelled a
 * proxy in the returned provenance, because the constituents themselves are a licensed asset
 * and presenting borrowed weights as the index would be both a licensing and an accuracy
 * claim this project has no basis for.
 */
export async function gatherInstrumentFacts({
  symbol,
  instrument,
  perHoldingFacts = null,
  lookThroughFactIds = [],
  signal,
  asOf = null,
} = {}) {
  const facts = [];
  const unavailable = [];
  const provenance = {};
  const normalized = normalizeIndexSymbol(symbol);
  const proxy = INDEX_PROXIES[normalized];
  const holdingsSymbol = instrument?.index_like ? proxy?.etf : symbol;
  // A tracker has no valuation of its own to publish, so it reads the index it holds. Without
  // this a fund run reported "WSJ publishes only three indices" as a gap while the very index
  // it tracks was one of the three.
  const valuationSymbol = instrument?.index_like ? normalized : (valuationIndexFor(symbol) || normalized);
  if (!instrument?.index_like && valuationSymbol !== normalized) {
    provenance.valuation_source = {
      kind: "tracked_index_valuation",
      index: valuationSymbol,
      why: "a cap-weighted tracker holds the index, so the index aggregate describes the fund's book on the same basis",
    };
  }

  if (instrument?.index_like) {
    provenance.constituent_source = proxy
      ? { kind: "tracking_etf_proxy", etf: proxy.etf, licensor: proxy.licensor, why: proxy.why }
      : { kind: "unavailable", why: "no tracking-ETF proxy is registered for this index" };
  }

  // Fee and size come from the issuer, not from the index: an index has no expense ratio.
  // This was previously read off the index aggregate, which never carries one, so the fee
  // fact was unreachable code that silently produced nothing.
  const [aggregate, holdings, metadata, erp] = await Promise.all([
    fetchIndexAggregate({ symbol: valuationSymbol, signal, asOf })
      .catch((error) => ({ unavailable: [`index aggregate: ${String(error?.message || error)}`] })),
    holdingsSymbol
      ? fetchFundHoldings(holdingsSymbol, { signal })
        .catch((error) => ({ unavailable: [`fund holdings: ${String(error?.message || error)}`] }))
      : Promise.resolve(null),
    holdingsSymbol
      ? fetchFundMetadata(holdingsSymbol, { signal })
        .catch((error) => ({ unavailable: [`fund metadata: ${String(error?.message || error)}`] }))
      : Promise.resolve(null),
    fetchImpliedErp({ signal, asOf })
      .catch((error) => ({ unavailable: [`implied equity risk premium: ${String(error?.message || error)}`] })),
  ]);

  facts.push(...valuationFacts(aggregate));
  if (erp && finite(erp.latest)) {
    // The premium the market is actually pricing, with where it sits in its own history. A
    // level alone cannot say whether the market is paying up; the percentile is the claim.
    facts.push({
      fact_id: "valuation.implied_erp",
      value: erp.latest,
      value_kind: "ratio",
      unit: "decimal",
      ratio_denominator: "equity_over_riskfree",
      source_kind: "published_dataset",
      source_url: erp.source_url,
      public_at: erp.public_at,
      observation_date: erp.observation_date,
      confidence: 0.85,
      derivation: "reported",
      method: erp.basis,
      title: "Damodaran implied equity risk premium",
    });
    if (erp.percentile) {
      facts.push({
        fact_id: "cycle.valuation_percentile",
        value: erp.percentile.percentile,
        value_kind: "ratio",
        unit: "decimal",
        ratio_denominator: `rank_within_${erp.percentile.sample_size}_published_months`,
        source_kind: "published_dataset",
        source_url: erp.source_url,
        public_at: erp.public_at,
        observation_date: erp.observation_date,
        confidence: 0.8,
        derivation: "rederived",
        method: `percentile_of_${erp.basis}_since_${erp.percentile.sample_start}`,
        title: "implied equity risk premium percentile",
      });
    }
  }
  unavailable.push(...(erp?.unavailable || []));
  unavailable.push(...(aggregate?.unavailable || []));
  let breadthResult = null;
  if (holdings?.holdings?.length) {
    facts.push(...structureFacts(holdings, metadata));
    // Breadth is computed from the basket rather than bought: every free screener that
    // publishes it forbids the query, and the holdings are already in hand.
    breadthResult = await fetchBasketBreadth(holdings.holdings, { signal })
      .catch((error) => ({ available: false, unavailable: [`breadth: ${String(error?.message || error)}`] }));
    const breadth = breadthResult;
    unavailable.push(...(breadth.unavailable || []));
    if (breadth.available) {
      const shared = {
        source_kind: "market_snapshot",
        source_url: holdings.source_url,
        public_at: holdings.public_at,
        observation_date: holdings.as_of,
        value_kind: "ratio",
        unit: "decimal",
        derivation: "rederived",
        confidence: 0.8,
        coverage_weight: breadth.coverage_weight,
        method: breadth.method,
      };
      facts.push({
        ...shared,
        fact_id: "index.breadth_above_200dma",
        value: breadth.weighted_above,
        ratio_denominator: "measured_basket_weight",
        title: "share of basket weight above its 200-day average",
      });
      if (finite(breadth.net_assets) && !finite(metadata?.aum)) {
        facts.push({
          ...shared,
          fact_id: "fund.aum",
          value: breadth.net_assets,
          value_kind: "monetary",
          unit: "currency_units",
          currency: "USD",
          scale: 1,
          ratio_denominator: undefined,
          method: "sum_of_disclosed_units_at_last_close",
          title: `${holdings.symbol} assets from disclosed positions`,
        });
      }
      // The fund's own shares outstanding. This is the fund as an issuer, not an aggregate of
      // anything -- and it is what lets a seat build the fund's market capitalisation with the
      // same arithmetic it uses on a company, which is why ten seats could not read a basket.
      const fundShares = finite(holdings.shares_outstanding)
        ? { value: holdings.shares_outstanding, how: "issuer_disclosed_shares_outstanding" }
        : await impliedFundShares(holdings.symbol, breadth.net_assets, metadata, signal);
      if (fundShares) {
        facts.push({
          ...shared,
          fact_id: "capital_allocation.share_count",
          value: Number(fundShares.value.toFixed(2)),
          value_kind: "count",
          unit: "shares",
          ratio_denominator: undefined,
          derivation: fundShares.how === "issuer_disclosed_shares_outstanding" ? "reported" : "rederived",
          method: fundShares.how,
          title: `${holdings.symbol} shares outstanding`,
        });
      }
      // The gap between weighted and counted breadth IS the concentration story: a
      // cap-weighted basket can be above its average on weight while most members are below.
      facts.push({
        ...shared,
        fact_id: "index.breadth_counted_above_200dma",
        value: breadth.counted_above,
        ratio_denominator: "measured_constituent_count",
        title: "share of measured constituents above their 200-day average",
      });
    }
    provenance.holdings_as_of = holdings.as_of;
    provenance.holdings_count = holdings.holdings.length;
  }
  unavailable.push(...(holdings?.unavailable || []));
  unavailable.push(...(metadata?.unavailable || []));

  if (holdings?.holdings?.length && lookThroughFactIds.length) {
    let resolved = perHoldingFacts;
    let resolvedPeriods = null;
    let resolvedShareCounts = null;
    if (!resolved) {
      const constituents = await resolveConstituentFacts(holdings.holdings, { signal, asOf });
      resolved = constituents.perHolding;
      resolvedPeriods = constituents.perHoldingPeriods;
      resolvedShareCounts = constituents.shareCounts;
      unavailable.push(...constituents.unavailable);
      provenance.look_through = {
        constituents_attempted: constituents.attempted,
        constituents_resolved: resolved.size,
      };
    }
    const through = lookThroughFacts({
      holdings: holdings.holdings,
      perHoldingFacts: resolved,
      perHoldingPeriods: resolvedPeriods,
      factIds: lookThroughFactIds,
      holdingsMeta: holdings,
    });
    facts.push(...through.facts);
    unavailable.push(...through.unavailable);

    // The fund's own size is what scales a per-dollar claim back into dollars. Prefer the
    // issuer's published figure and fall back to the assets implied by the disclosed
    // positions, which is the same number the size fact above is built from.
    const netAssets = finite(metadata?.aum) ? metadata.aum : breadthResult?.net_assets;
    const claims = lookThroughClaims({
      holdings: holdings.holdings,
      perHoldingFacts: resolved,
      perHoldingPeriods: resolvedPeriods,
      shareCounts: resolvedShareCounts,
      closes: breadthResult?.closes,
      netAssets,
      holdingsMeta: holdings,
    });
    facts.push(...claims.facts);
    unavailable.push(...claims.unavailable);
  }

  return {
    symbol,
    research_model: instrument?.research_model || "market_instrument",
    provenance,
    facts,
    // Several facts have more than one route -- the implied ERP and the valuation percentile
    // are computed from the published workbook when the index feed cannot supply them -- and
    // each route reports its own failure. Keeping a note about a fact the pack actually
    // produced reads as a gap that is filled, which is worse than saying nothing: it invites
    // a reader to go and solve a problem that is already solved.
    unavailable: unavailable.filter((note) => !factsProducedFor(note, facts)),
    limits: {
      max_constituents: LOOK_THROUGH_MAX_CONSTITUENTS,
      target_coverage: LOOK_THROUGH_TARGET_COVERAGE,
      fetch_timeout_ms: LIMITS.QUOTE_FETCH_MS,
    },
  };
}
