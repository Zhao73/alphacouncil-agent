/**
 * Convert only timestamped, mechanically observable grounding fields into PersonaPack v3
 * typed facts. Missing lineage stays missing: this adapter never assigns the run's `as_of`
 * date to a value merely because the source omitted its own observation/retrieval time.
 */

import { buildFactPack } from "./typed-facts.mjs";
import { canonicalValue, sha256 } from "./canonical.mjs";
import { inclusiveCutoffTime } from "./source-anchor.mjs";

const ADAPTER_ID = "grounding_to_typed_facts";
const ADAPTER_VERSION = "1.0.0";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function timestampAtOrBefore(value, cutoff) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return Date.parse(value) <= cutoff ? value : null;
}

function sourceId(...parts) {
  return parts.map((part) => String(part ?? "unknown").trim().replace(/\s+/gu, "_"))
    .join(":").slice(0, 300);
}

function quoteSourceUrl(quote) {
  if (/^https?:\/\//u.test(quote?.source_url || "")) return quote.source_url;
  const symbol = quote?.symbol || quote?.query;
  if (!symbol) return null;
  if (quote.source === "yahoo") {
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  }
  if (quote.source === "stooq") {
    return `https://stooq.com/q/l/?s=${encodeURIComponent(String(symbol).toLowerCase())}&f=sd2t2ohlcv&h&e=csv`;
  }
  return null;
}

function registerSource(context, record) {
  if (!record?.source_id || !/^https?:\/\//u.test(record.url || "")) {
    context.diagnostics.push({ code: "missing_exact_source_url", source_id: record?.source_id || null });
    return false;
  }
  const canonical = canonicalValue(record);
  const existing = context.sourceRecords.get(record.source_id);
  if (existing && sha256(existing) !== sha256(canonical)) {
    context.diagnostics.push({ code: "source_id_collision", source_id: record.source_id });
    return false;
  }
  context.sourceRecords.set(record.source_id, canonical);
  return true;
}

function reportedLineage() {
  return { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null };
}

function derivedLineage(input, toolId = ADAPTER_ID) {
  return {
    input_fact_ids: [],
    tool_id: toolId,
    tool_version: ADAPTER_VERSION,
    calculation_hash: sha256({ tool_id: toolId, tool_version: ADAPTER_VERSION, input }),
  };
}

function secCompanyFactsIdentity(id) {
  const [namespace, feed, cik, tag, filingReference, periodEnd, ...extra] = String(id).split(":");
  if (namespace !== "sec" || feed !== "companyfacts" || !cik || !tag || !filingReference || !periodEnd || extra.length) {
    return { title: "SEC Company Facts record", locator: { source_id: id } };
  }
  const filingLocator = /^\d{10}-\d{2}-\d{6}$/u.test(filingReference)
    ? { accession: filingReference }
    : { filed_at: filingReference };
  return {
    title: `SEC Company Facts record for ${tag}`,
    locator: { cik, tag, ...filingLocator, period_end: periodEnd },
  };
}

function baseFact({
  factId,
  valueKind,
  value,
  unit,
  currency = null,
  scale = null,
  periodStart = null,
  periodEnd = null,
  fiscalYear = null,
  asOf,
  publicAt,
  sources,
  confidence,
  derivation = "reported",
  ratioDenominator,
  derivationToolId = ADAPTER_ID,
  derivationInput = null,
}) {
  return {
    schema_version: 1,
    fact_id: factId,
    value_kind: valueKind,
    value,
    unit,
    currency,
    scale,
    ...(ratioDenominator ? { ratio_denominator: ratioDenominator } : {}),
    period_start: periodStart,
    period_end: periodEnd,
    fiscal_year: fiscalYear,
    as_of: asOf,
    public_at: publicAt,
    source_ids: sources,
    derivation,
    confidence,
    restatement_policy: "immutable run snapshot; later observations never overwrite this fact pack",
    lineage: derivation === "reported"
      ? reportedLineage()
      : derivedLineage({ factId, value, sources, ...(derivationInput ? { derivationInput } : {}) }, derivationToolId),
  };
}

const SCREEN_FACTS = Object.freeze({
  roe_10y: { fact_id: "financial.return_on_equity_10y", kind: "percent", denominator: "average_positive_book_equity" },
  fcf_5y: { fact_id: "financial.free_cash_flow_5y", kind: "usd" },
  interest_cover: { fact_id: "financial.interest_coverage", kind: "multiple", denominator: "interest_expense" },
  gross_margin: { fact_id: "financial.gross_margin_5y", kind: "percent", denominator: "revenue" },
  ocf_over_ni: { fact_id: "accounting.cash_conversion", kind: "multiple", denominator: "net_income" },
  net_margin: { fact_id: "financial.net_margin_5y", kind: "percent", denominator: "revenue" },
  dilution: { fact_id: "capital_allocation.share_count_change_5y", kind: "percent", denominator: "starting_share_count" },
});

function screenFacts(grounding, context) {
  const metrics = grounding?.screen?.metrics;
  if (!Array.isArray(metrics)) return;
  for (const metric of metrics) {
    const mapping = SCREEN_FACTS[metric?.rule];
    if (!mapping || !finite(metric.value)) continue;
    const publicAt = timestampAtOrBefore(metric.public_at, context.cutoff);
    const sources = Array.isArray(metric.source_ids)
      ? metric.source_ids.filter((id) => typeof id === "string" && id.length)
      : [];
    if (!publicAt || !sources.length) {
      context.diagnostics.push({ code: "missing_source_lineage", source: `screen.${metric.rule}`, action: "not_converted" });
      continue;
    }
    const cik = grounding.screen?.cik;
    const digits = String(cik || "").replace(/\D/gu, "");
    const companyFactsUrl = digits
      ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${digits.padStart(10, "0")}.json`
      : null;
    const registered = sources.every((id) => {
      const identity = secCompanyFactsIdentity(id);
      return registerSource(context, {
        source_id: id,
        source_kind: "regulatory_filing_data",
        title: identity.title,
        url: companyFactsUrl,
        public_at: publicAt,
        retrieved_at: grounding.gathered_at || context.asOf,
        locator: identity.locator,
      });
    });
    if (!registered) continue;
    const common = {
      factId: mapping.fact_id,
      asOf: context.asOf,
      publicAt,
      sources,
      confidence: 0.95,
      derivation: "rederived",
      periodStart: metric.period_start || null,
      periodEnd: metric.period_end || null,
      fiscalYear: Number.isInteger(metric.fiscal_year) ? metric.fiscal_year : null,
      derivationToolId: `${ADAPTER_ID}:screen:${metric.rule}`,
      derivationInput: { metric_rule: metric.rule },
    };
    if (mapping.kind === "usd") {
      addUnique(context.facts, context.diagnostics, baseFact({
        ...common,
        valueKind: "monetary",
        value: metric.value,
        unit: "currency_units",
        currency: "USD",
        scale: 1,
      }));
    } else {
      addUnique(context.facts, context.diagnostics, baseFact({
        ...common,
        valueKind: "ratio",
        value: mapping.kind === "percent" ? metric.value / 100 : metric.value,
        unit: mapping.kind === "percent" ? "decimal" : "multiple",
        ratioDenominator: mapping.denominator,
      }));
    }
  }
}

function addUnique(facts, diagnostics, fact) {
  if (facts.some((candidate) => candidate.fact_id === fact.fact_id)) {
    diagnostics.push({ code: "duplicate_fact_id_skipped", fact_id: fact.fact_id });
    return;
  }
  facts.push(fact);
}

function quoteFacts(grounding, context) {
  const quote = grounding?.quote;
  if (!quote || !finite(quote.price)) return;
  const publicAt = timestampAtOrBefore(quote.quote_time, context.cutoff)
    || timestampAtOrBefore(grounding.gathered_at, context.cutoff);
  if (!publicAt) {
    context.diagnostics.push({ code: "missing_public_at", source: "quote", skipped_fact_ids: ["market.price", "market.change_pct"] });
    return;
  }
  const sources = [sourceId("quote", quote.source, quote.symbol, publicAt)];
  if (!registerSource(context, {
    source_id: sources[0],
    source_kind: "market_snapshot",
    title: `${quote.source || "market"} quote for ${quote.symbol || "unknown"}`,
    url: quoteSourceUrl(quote),
    public_at: publicAt,
    retrieved_at: grounding.gathered_at || publicAt,
    locator: { symbol: quote.symbol || null, observation_time: quote.quote_time || publicAt },
  })) return;
  const currency = /^[A-Z]{3}$/u.test(quote.currency || "") ? quote.currency : null;
  const price = baseFact({
    factId: "market.price",
    valueKind: currency ? "monetary" : "scalar",
    value: quote.price,
    unit: currency ? "currency_units" : "source_currency_units",
    asOf: context.asOf,
    publicAt,
    sources,
    confidence: quote.source === "yahoo" ? 0.85 : 0.75,
  });
  if (currency) {
    price.currency = currency;
    price.scale = 1;
  }
  addUnique(context.facts, context.diagnostics, price);
  if (finite(quote.change_pct)) {
    addUnique(context.facts, context.diagnostics, baseFact({
      factId: "market.change_pct",
      valueKind: "ratio",
      value: quote.change_pct / 100,
      unit: "decimal",
      ratioDenominator: "previous_close",
      asOf: context.asOf,
      publicAt,
      sources,
      confidence: 0.8,
      derivation: "rederived",
    }));
  }
}

function optionsFacts(grounding, context) {
  const options = grounding?.options;
  if (!options || options.available === false) return;
  const publicAt = timestampAtOrBefore(options.retrieved_at, context.cutoff)
    || timestampAtOrBefore(grounding.gathered_at, context.cutoff);
  if (!publicAt) {
    context.diagnostics.push({
      code: "missing_public_at",
      source: "options",
      skipped_fact_ids: ["options.implied_volatility", "options.skew_25d", "execution.bid_ask"],
    });
    return;
  }
  const reference = options.reference_expiry || {};
  const implied = finite(reference.atm_iv) ? reference.atm_iv
    : finite(options.atm_iv_12d) ? options.atm_iv_12d : null;
  const skew = finite(options.skew_25delta?.put_minus_call)
    ? options.skew_25delta.put_minus_call
    : finite(options.skew_25d_put_minus_call) ? options.skew_25d_put_minus_call : null;
  const sources = [sourceId("options", options.source || "unknown", options.symbol || grounding.quote?.symbol, publicAt)];
  const optionSymbol = options.symbol || grounding.quote?.symbol || "unknown";
  const optionUrl = /^https?:\/\//u.test(options.source_url || "")
    ? options.source_url
    : optionSymbol !== "unknown"
      ? `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(optionSymbol)}.json`
      : null;
  if (!registerSource(context, {
    source_id: sources[0],
    source_kind: "market_snapshot",
    title: `${options.source || "CBOE"} option chain for ${optionSymbol}`,
    url: optionUrl,
    public_at: publicAt,
    retrieved_at: grounding.gathered_at || publicAt,
    locator: { symbol: optionSymbol, reference_expiry: reference.expiry || null },
  })) return;
  if (finite(implied)) {
    addUnique(context.facts, context.diagnostics, baseFact({
      factId: "options.implied_volatility",
      valueKind: "ratio",
      value: implied,
      unit: "decimal_annualized_volatility",
      ratioDenominator: "underlying_annualized_volatility",
      asOf: context.asOf,
      publicAt,
      sources,
      confidence: options.delayed === false ? 0.9 : 0.8,
      derivation: "rederived",
    }));
  }
  if (finite(skew)) {
    addUnique(context.facts, context.diagnostics, baseFact({
      factId: "options.skew_25d",
      valueKind: "ratio",
      value: skew,
      unit: "decimal_volatility_difference",
      ratioDenominator: "25delta_put_iv_minus_call_iv",
      asOf: context.asOf,
      publicAt,
      sources,
      confidence: 0.8,
      derivation: "rederived",
    }));
  }
  if (finite(options.atm_spread_pct_of_mid)) {
    addUnique(context.facts, context.diagnostics, baseFact({
      factId: "execution.bid_ask",
      valueKind: "ratio",
      value: options.atm_spread_pct_of_mid / 100,
      unit: "decimal_of_mid",
      ratioDenominator: "option_mid_price",
      asOf: context.asOf,
      publicAt,
      sources,
      confidence: 0.75,
      derivation: "rederived",
    }));
  }
  if (Array.isArray(options.term_structure) && options.term_structure.length) {
    addUnique(context.facts, context.diagnostics, baseFact({
      factId: "options.term_structure",
      valueKind: "text",
      value: JSON.stringify(canonicalValue(options.term_structure)),
      unit: null,
      asOf: context.asOf,
      publicAt,
      sources,
      confidence: 0.8,
      derivation: "rederived",
    }));
  }
}

/** Return both the immutable pack and an explicit list of fields skipped for missing lineage. */
export function adaptGroundingToTypedFacts(grounding, { asOf, knowledgeAsOf = asOf } = {}) {
  const resolvedAsOf = asOf || grounding?.as_of || grounding?.gathered_at;
  const cutoff = inclusiveCutoffTime(resolvedAsOf);
  if (!Number.isFinite(cutoff)) throw new Error(`cannot adapt grounding without a valid as_of: ${JSON.stringify(resolvedAsOf)}`);
  const context = {
    asOf: resolvedAsOf,
    cutoff,
    facts: [],
    diagnostics: [],
    sourceRecords: new Map(),
  };
  quoteFacts(grounding, context);
  optionsFacts(grounding, context);
  screenFacts(grounding, context);
  for (const family of ["screen", "macro", "market"]) {
    if (grounding?.[family] && !grounding[family].public_at) {
      if (family === "screen" && context.diagnostics.some((item) => String(item.source || "").startsWith("screen."))) continue;
      context.diagnostics.push({ code: "missing_source_lineage", source: family, action: "not_converted" });
    }
  }
  return Object.freeze({
    fact_pack: buildFactPack(context.facts, { asOf: resolvedAsOf, knowledgeAsOf }),
    sources: Object.freeze([...context.sourceRecords.values()]
      .sort((left, right) => left.source_id.localeCompare(right.source_id))
      .map((item) => Object.freeze(item))),
    diagnostics: Object.freeze(context.diagnostics.map((item) => Object.freeze(canonicalValue(item)))),
  });
}

export function typedFactPackFromGrounding(grounding, options = {}) {
  return adaptGroundingToTypedFacts(grounding, options).fact_pack;
}
