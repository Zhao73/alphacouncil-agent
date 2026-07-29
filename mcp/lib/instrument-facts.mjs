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
import { fetchFundHoldings, fetchFundMetadata, lookThroughAggregate, topHoldingsCoverage } from "./funds.mjs";
import { fetchIndexAggregate, INDEX_PROXIES, normalizeIndexSymbol } from "./index-aggregate.mjs";
import { fetchImpliedErp } from "./damodaran.mjs";
import { fetchBasketBreadth } from "./breadth.mjs";
import { fetchFundamentals } from "./fundamentals.mjs";
import { fetchUniverse } from "./sec.mjs";

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
export const LOOK_THROUGH_BLOCKED = Object.freeze({
  "financial.owner_earnings": "absolute currency; needs a per-constituent market capitalisation to become a yield",
  "financial.net_current_asset_value": "absolute currency; needs a per-constituent market capitalisation to become a ratio",
  "valuation.downside_asset_value": "absolute currency; needs a per-constituent market capitalisation to become a ratio",
  "valuation.downside_floor": "absolute currency; needs a per-constituent market capitalisation to become a ratio",
  "capital_allocation.share_count": "a count, not a rate; it has no portfolio-level meaning",
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
  const unavailable = [];
  const ranked = [...holdings]
    .sort((left, right) => (right.weight || 0) - (left.weight || 0))
    .slice(0, LOOK_THROUGH_MAX_CONSTITUENTS);
  if (!ranked.length) return { perHolding, perHoldingPeriods, unavailable, attempted: 0 };

  let universe = null;
  try {
    universe = new Map((await fetchUniverse({ signal }))
      .map((row) => [String(row.ticker).toUpperCase(), row.cik]));
  } catch (error) {
    return {
      perHolding,
      perHoldingPeriods,
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
        const derived = await fetchFundamentals({ cik, ticker, asOf, signal });
        const facts = {};
        const periods = {};
        for (const [factId, metric] of Object.entries(derived.metrics || {})) {
          if (!metric || !Number.isFinite(metric.value)) continue;
          facts[factId] = metric.value;
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
  return { perHolding, perHoldingPeriods, unavailable, attempted: ranked.length };
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
 * The interval a basket-level aggregate covers: the widest span its contributing constituents
 * reported. Stating a narrower one would claim coverage the inputs do not have, and stating
 * none at all leaves the fact unusable by any duration contract.
 */
function aggregatePeriod(perHoldingPeriods, factId, tickers) {
  let start = null;
  let end = null;
  for (const ticker of tickers) {
    const span = perHoldingPeriods?.get(ticker)?.[factId];
    if (!span?.start || !span?.end) continue;
    if (!start || span.start < start) start = span.start;
    if (!end || span.end > end) end = span.end;
  }
  return start && end ? { period_start: start, period_end: end } : {};
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
      unit: "decimal",
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
  if (holdings?.holdings?.length) {
    facts.push(...structureFacts(holdings, metadata));
    // Breadth is computed from the basket rather than bought: every free screener that
    // publishes it forbids the query, and the holdings are already in hand.
    const breadth = await fetchBasketBreadth(holdings.holdings, { signal })
      .catch((error) => ({ available: false, unavailable: [`breadth: ${String(error?.message || error)}`] }));
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
    if (!resolved) {
      const constituents = await resolveConstituentFacts(holdings.holdings, { signal, asOf });
      resolved = constituents.perHolding;
      resolvedPeriods = constituents.perHoldingPeriods;
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
