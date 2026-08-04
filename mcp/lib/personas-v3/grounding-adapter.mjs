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

function latestTimestampAtOrBefore(values, cutoff) {
  const visible = values.map((value) => timestampAtOrBefore(value, cutoff));
  if (!visible.length || visible.some((value) => value === null)) return null;
  return visible.reduce((latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest));
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

/**
 * Keep an interval only when the value genuinely covers a span. A single-ended interval is not
 * a shorter interval -- it is an observation date wearing the wrong field.
 */
function pointInTimeOrInterval(periodStart, periodEnd) {
  if (!periodStart) return { period_start: null, period_end: null };
  return { period_start: periodStart, period_end: periodEnd };
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
    // `period_start`/`period_end` describe the span a value COVERS, not when it was observed --
    // that is what `as_of` and `public_at` are for. A point-in-time observation with only an end
    // date satisfies neither contract basis: the executor rejects it as an instant because the
    // interval is non-null, and as a duration because a window needs both ends. Facts in that
    // shape were unusable by any tool, which is most of what kept live seats silent.
    ...pointInTimeOrInterval(periodStart, periodEnd),
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
      derivationInput: {
        metric_rule: metric.rule,
        ...(Number.isFinite(metric.span_days) ? { span_days: metric.span_days } : {}),
        ...(Number.isFinite(metric.span_years) ? { span_years: metric.span_years } : {}),
        ...(Number.isInteger(metric.observation_count) ? { observation_count: metric.observation_count } : {}),
      },
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

/**
 * A derived fact cannot exist before every source it cites was public.  Keep this as a final
 * adapter-wide invariant rather than trusting each converter to remember the rule.  A bad
 * fact is omitted and diagnosed; it never enters the immutable pack.
 */
export function enforceTypedFactSourceVisibility(facts, sourceRecords, diagnostics = []) {
  const records = sourceRecords instanceof Map
    ? sourceRecords
    : new Map((sourceRecords || []).map((record) => [record.source_id, record]));
  return facts.filter((fact) => {
    const factTime = Date.parse(fact?.public_at);
    const missing = (fact?.source_ids || []).filter((id) => !records.has(id));
    if (missing.length) {
      diagnostics.push({
        code: "missing_typed_fact_source",
        fact_id: fact?.fact_id || null,
        source_ids: missing,
        action: "not_converted",
      });
      return false;
    }
    const invalid = [];
    const later = [];
    for (const id of fact?.source_ids || []) {
      const source = records.get(id);
      const sourceTime = Date.parse(source?.public_at);
      if (!Number.isFinite(sourceTime)) invalid.push(id);
      else if (!Number.isFinite(factTime) || sourceTime > factTime) later.push(id);
    }
    if (invalid.length || later.length) {
      const cited = [...invalid, ...later].map((id) => ({
        source_id: id,
        source_public_at: records.get(id)?.public_at || null,
      }));
      diagnostics.push({
        code: invalid.length ? "invalid_typed_fact_source_public_at" : "fact_public_at_precedes_source",
        fact_id: fact?.fact_id || null,
        fact_public_at: fact?.public_at || null,
        sources: cited,
        action: "not_converted",
      });
      return false;
    }
    return true;
  });
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
  // CBOE's `quote_time` is normalized from data.last_trade_time: it timestamps the
  // underlying price, not the option rows used to derive IV, skew, spreads and the surface.
  // Chain facts become public with the chain observation itself.  Keep the underlying-price
  // timestamp only as separate locator metadata so it can never backdate chain metrics.
  const publicAt = timestampAtOrBefore(options.observation_time, context.cutoff)
    || timestampAtOrBefore(options.chain_timestamp, context.cutoff)
    || timestampAtOrBefore(options.retrieved_at, context.cutoff)
    || timestampAtOrBefore(grounding.gathered_at, context.cutoff);
  const underlyingPriceObservationTime = timestampAtOrBefore(options.quote_time, context.cutoff)
    || timestampAtOrBefore(options.last_trade_time, context.cutoff);
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
    retrieved_at: options.retrieved_at || grounding.gathered_at || publicAt,
    locator: {
      symbol: optionSymbol,
      reference_expiry: reference.expiry || null,
      observation_time: publicAt,
      underlying_price_observation_time: underlyingPriceObservationTime,
    },
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

function marketHistoryFacts(grounding, context) {
  const history = grounding?.market_history;
  const subject = history?.subject;
  const source = (history?.source_records || []).find((record) => record?.id?.startsWith(`market_history:${history.symbol}:`));
  if (!history?.available || !subject || !source) return;
  const publicAt = timestampAtOrBefore(source.observed_at, context.cutoff)
    || timestampAtOrBefore(source.retrieved_at, context.cutoff)
    || timestampAtOrBefore(grounding.gathered_at, context.cutoff);
  if (!publicAt) {
    context.diagnostics.push({
      code: "missing_public_at",
      source: "market_history",
      skipped_fact_ids: ["options.realized_volatility", "market.volume_ratio_20d", "market.relative_return_63d_broad"],
    });
    return;
  }
  const sources = [sourceId("market_history", history.symbol, subject.latest_date, publicAt)];
  if (!registerSource(context, {
    source_id: sources[0],
    source_kind: "market_history_snapshot",
    title: source.title,
    url: source.url,
    public_at: publicAt,
    retrieved_at: source.retrieved_at || publicAt,
    locator: {
      symbol: history.symbol,
      first_session: subject.first_date,
      latest_session: subject.latest_date,
      session_count: subject.session_count,
    },
  })) return;
  const addRatio = (factId, value, denominator, derivationInput) => {
    if (!finite(value)) return;
    addUnique(context.facts, context.diagnostics, baseFact({
      factId,
      valueKind: "ratio",
      value,
      unit: "decimal",
      ratioDenominator: denominator,
      asOf: context.asOf,
      publicAt,
      sources,
      confidence: 0.8,
      derivation: "rederived",
      derivationToolId: `${ADAPTER_ID}:market_history`,
      derivationInput,
    }));
  };
  const vol20 = subject.realized_volatility?.["20d_annualized"];
  const vol63 = subject.realized_volatility?.["63d_annualized"];
  addRatio("options.realized_volatility", vol20, "20_session_log_return_standard_deviation_annualized", {
    sessions: 20, annualization: 252, source_field: "market_history.subject.realized_volatility.20d_annualized",
  });
  addRatio("market.realized_volatility_20d", vol20, "20_session_log_return_standard_deviation_annualized", {
    sessions: 20, annualization: 252,
  });
  addRatio("market.realized_volatility_63d", vol63, "63_session_log_return_standard_deviation_annualized", {
    sessions: 63, annualization: 252,
  });
  for (const sessions of [5, 21, 63, 126, 252]) {
    addRatio(`market.return_${sessions}d`, subject.returns?.[`${sessions}d`], `${sessions}_session_total_return`, {
      sessions, adjusted_close: true,
    });
  }
  for (const sessions of [20, 63]) {
    addRatio(`market.volume_ratio_${sessions}d`, subject.volume?.ratios?.[`latest_to_${sessions}d`], `latest_volume_over_${sessions}_session_average`, {
      sessions,
    });
  }
  const broad = history.benchmark_plan?.broad;
  const sector = history.benchmark_plan?.sector;
  for (const sessions of [21, 63, 252]) {
    addRatio(`market.relative_return_${sessions}d_broad`, history.relative_performance?.[broad]?.windows?.[`${sessions}d`]?.excess_return, `subject_return_minus_${broad || "broad"}_return`, {
      sessions, benchmark: broad,
    });
    if (sector) {
      addRatio(`market.relative_return_${sessions}d_sector`, history.relative_performance?.[sector]?.windows?.[`${sessions}d`]?.excess_return, `subject_return_minus_${sector}_return`, {
        sessions, benchmark: sector, benchmark_basis: history.benchmark_plan?.sector_basis,
      });
    }
  }
}

/**
 * FRED observations carry their own publication date, so unlike the market snapshot they can
 * be converted without stamping the run time onto them. That is the whole reason the macro
 * block could not be converted before: it had readings but no lineage.
 */
function macroSeriesFacts(grounding, context) {
  const macro = grounding?.macro_series;
  if (!macro?.series) return;
  for (const [id, series] of Object.entries(macro.series)) {
    if (!series?.fact || !finite(series.latest)) continue;
    const publicAt = timestampAtOrBefore(series.public_at, context.cutoff);
    if (!publicAt) {
      context.diagnostics.push({ code: "missing_public_at", source: `fred.${id}`, action: "not_converted" });
      continue;
    }
    const sourceIdValue = sourceId("fred", id, series.observation_date);
    if (!registerSource(context, {
      source_id: sourceIdValue,
      source_kind: "official_statistic",
      title: `FRED ${id}: ${series.label}`,
      url: series.source_url,
      public_at: publicAt,
      retrieved_at: grounding.gathered_at || publicAt,
      locator: { series_id: id, observation_date: series.observation_date },
    })) continue;
    // Every FRED series mapped here is quoted in percent; the typed-fact contract is decimal.
    addUnique(context.facts, context.diagnostics, baseFact({
      factId: series.fact,
      valueKind: "ratio",
      value: series.latest / 100,
      unit: "decimal",
      ratioDenominator: "annualized_rate",
      periodEnd: series.observation_date,
      asOf: context.asOf,
      publicAt,
      sources: [sourceIdValue],
      confidence: 0.95,
    }));
  }

  const impulse = macro.liquidity_impulse;
  const liquidity = macro.net_liquidity;
  if (impulse && finite(impulse.value) && liquidity) {
    const derivedFrom = liquidity.derived_from || [];
    const inputSeries = derivedFrom.map((id) => macro.series?.[id]).filter(Boolean);
    const publicAt = inputSeries.length === derivedFrom.length
      ? latestTimestampAtOrBefore(inputSeries.map((series) => series.public_at), context.cutoff)
      : null;
    const inputIds = derivedFrom.map((id) => sourceId("fred", id, macro.series?.[id]?.observation_date));
    const registered = publicAt && derivedFrom.every((id) => {
      const series = macro.series?.[id];
      return series && registerSource(context, {
        source_id: sourceId("fred", id, series.observation_date),
        source_kind: "official_statistic",
        title: `FRED ${id}: ${series.label}`,
        url: series.source_url,
        public_at: series.public_at,
        retrieved_at: grounding.gathered_at || series.public_at,
        locator: { series_id: id, observation_date: series.observation_date },
      });
    });
    if (registered) {
      addUnique(context.facts, context.diagnostics, baseFact({
        factId: "macro.liquidity_impulse",
        valueKind: "ratio",
        value: impulse.value,
        unit: "decimal",
        ratioDenominator: `net_liquidity_change_over_${impulse.window_days}_days`,
        periodStart: impulse.from_date,
        periodEnd: impulse.to_date,
        asOf: context.asOf,
        publicAt,
        sources: inputIds,
        confidence: 0.8,
        derivation: "rederived",
        derivationToolId: `${ADAPTER_ID}:macro:net_liquidity_impulse`,
        derivationInput: {
          window_days: impulse.window_days,
          from: { date: impulse.from_date, value: impulse.from_value },
          to: { date: impulse.to_date, value: impulse.to_value },
          construction: "WALCL - RRPONTSYD*1000 - WTREGEN, in usd_millions",
        },
      }));
    } else {
      context.diagnostics.push({ code: "missing_source_lineage", source: "fred.net_liquidity", action: "not_converted" });
    }
  }

  const regime = macro.regime;
  if (regime?.state) {
    const slope = macro.series?.T10Y3M;
    const breakeven = macro.series?.T5YIE;
    const publicAt = slope && breakeven
      ? latestTimestampAtOrBefore([slope.public_at, breakeven.public_at], context.cutoff)
      : null;
    const sources = [slope, breakeven].filter(Boolean).map((series) => sourceId("fred", series.id, series.observation_date));
    if (publicAt && sources.length === 2) {
      addUnique(context.facts, context.diagnostics, baseFact({
        factId: "macro.growth_regime",
        valueKind: "text",
        value: regime.state,
        unit: null,
        periodEnd: slope.observation_date,
        asOf: context.asOf,
        publicAt,
        sources,
        confidence: 0.7,
        derivation: "rederived",
        derivationToolId: `${ADAPTER_ID}:macro:growth_inflation_quadrant`,
        derivationInput: {
          window_days: regime.window_days,
          growth_axis: regime.growth_axis,
          inflation_axis: regime.inflation_axis,
        },
      }));
    } else {
      context.diagnostics.push({ code: "missing_source_lineage", source: "fred.regime", action: "not_converted" });
    }
  }
}

/**
 * Company fundamentals derived from XBRL, already shaped as typed-fact candidates.
 *
 * `deriveFundamentals` computes the period, the filing date and the source records, so this
 * function's only job is registration and unit passthrough. It deliberately does not repair
 * anything: a metric that arrives null arrived null for a reason the deriver already named.
 */
function fundamentalFacts(grounding, context) {
  const metrics = grounding?.fundamentals?.metrics;
  if (!metrics || typeof metrics !== "object") return;
  const cik = grounding.fundamentals.cik || grounding.screen?.cik;
  const digits = String(cik || "").replace(/\D/gu, "");
  const companyFactsUrl = digits
    ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${digits.padStart(10, "0")}.json`
    : null;
  for (const [factId, metric] of Object.entries(metrics)) {
    if (!metric || !finite(metric.value)) continue;
    const publicAt = timestampAtOrBefore(metric.public_at, context.cutoff);
    const sources = Array.isArray(metric.source_ids) ? metric.source_ids.filter(Boolean) : [];
    if (!publicAt || !sources.length) {
      context.diagnostics.push({ code: "missing_source_lineage", source: `fundamentals.${factId}`, action: "not_converted" });
      continue;
    }
    // Register each filing record from ITS OWN filing date, not from the date of whichever
    // metric happens to consume it. Several metrics legitimately share one XBRL record, and
    // stamping the consumer's period onto the shared source made the second registration
    // collide with the first -- which silently dropped the fact rather than the duplicate.
    // Match on the identity the id already encodes rather than rebuilding the id, so a change
    // in CIK zero-padding cannot quietly break the lookup and reintroduce the collision.
    const recordFor = (id) => {
      const [, , , tag, accession, periodEnd] = String(id).split(":");
      return (metric.source_records || []).find((record) => (
        record?.tag === tag && record?.accession === accession && record?.period_end === periodEnd
      ));
    };
    const registered = sources.every((id) => {
      // The mechanical screen reads the same filings and may already have registered this
      // record. First registration wins: both paths describe the same SEC document, and
      // re-asserting it under a second consumer's period is what produced the collision that
      // silently dropped every fundamentals fact sharing a record with the screen.
      if (context.sourceRecords.has(id)) return true;
      const identity = secCompanyFactsIdentity(id);
      const record = recordFor(id);
      const filedAt = record?.filed ? `${record.filed}T00:00:00.000Z` : publicAt;
      return registerSource(context, {
        source_id: id,
        source_kind: "regulatory_filing_data",
        title: identity.title,
        url: companyFactsUrl,
        public_at: filedAt,
        retrieved_at: grounding.gathered_at || context.asOf,
        locator: identity.locator,
      });
    });
    if (!registered) continue;
    addUnique(context.facts, context.diagnostics, baseFact({
      factId,
      valueKind: metric.value_kind,
      value: metric.value,
      unit: metric.unit,
      currency: metric.currency ?? null,
      scale: metric.scale ?? null,
      ratioDenominator: metric.ratio_denominator,
      periodStart: metric.period_start || null,
      periodEnd: metric.period_end || null,
      fiscalYear: Number.isInteger(metric.fiscal_year) ? metric.fiscal_year : null,
      asOf: context.asOf,
      publicAt,
      sources,
      confidence: finite(metric.confidence) ? metric.confidence : 0.85,
      derivation: metric.derivation || "rederived",
      derivationToolId: `${ADAPTER_ID}:fundamentals:${factId}`,
      // The maintenance-capex split is an assumption, so it travels with the fact rather
      // than living only in a comment nobody reads at decision time.
      derivationInput: metric.assumptions?.length ? { assumptions: metric.assumptions } : null,
    }));
  }
}

/**
 * Fund and index aggregates, including the look-through metrics that let an operating-company
 * method run against a basket. Coverage weight is carried on every look-through fact: a
 * portfolio number computed over 8% of the weights is not the same claim as one over 95%.
 */
/**
 * Section 16 insider ownership as one typed fact.
 *
 * The value is `estimated` rather than `reported`: no filing states this number: it is summed
 * across the newest ownership document per reporting owner, and the coverage limits of Section
 * 16 are real. Labelling it reported would claim a document that does not exist.
 */
/**
 * What else a basket is a bet on, as typed facts.
 *
 * Correlation to the broad market decides how much diversification a position actually buys,
 * which is the input Dalio's authored policy already asks for and could never get. Correlation
 * to Korea is the semiconductor cycle read from outside the United States. Sector dispersion is
 * whether one factor or many are repricing the market.
 */
/**
 * News as counts, never as content.
 *
 * A headline cannot reach a seat's arithmetic: the same symbol would answer differently
 * depending on what was published that morning, and a frozen deterministic stance would stop
 * being reproducible. What IS a fact is how much of the basket generated dated news in a stated
 * window, and how many constituents filed an 8-K in it. Both are counts with a date, and both
 * are the kind of thing an event-driven method legitimately asks for.
 *
 * The headlines themselves stay in the grounding for the report and for the voice worker that
 * explains a stance the seat already reached.
 */
function basketNewsFacts(grounding, context) {
  const news = grounding?.basket_news;
  if (!news?.available) return;
  const publicAt = timestampAtOrBefore(grounding?.gathered_at || context.asOf, context.cutoff);
  if (!publicAt) return;
  const sourceIdValue = sourceId("news", "basket_window", news.window_days, publicAt.slice(0, 10));
  if (!registerSource(context, {
    source_id: sourceIdValue,
    source_kind: "news_aggregate",
    title: `dated items for the basket's largest holdings over ${news.window_days} days`,
    url: "https://news.google.com/rss",
    public_at: publicAt,
    retrieved_at: grounding.gathered_at || publicAt,
    locator: { window_days: news.window_days, constituents_read: news.constituents_read, industry: news.industry?.id || null },
  })) return;
  const shared = {
    asOf: context.asOf,
    publicAt,
    sources: [sourceIdValue],
    confidence: 0.6,
    derivation: "rederived",
  };
  addUnique(context.facts, context.diagnostics, baseFact({
    ...shared,
    factId: "news.covered_weight",
    valueKind: "ratio",
    value: news.coverage_weight,
    unit: "decimal",
    ratioDenominator: `weight_of_${news.constituents_read}_largest_holdings`,
    derivationToolId: `${ADAPTER_ID}:news:covered_weight`,
    derivationInput: { window_days: news.window_days },
  }));
  addUnique(context.facts, context.diagnostics, baseFact({
    ...shared,
    factId: "news.filing_event_weight",
    valueKind: "ratio",
    value: news.filing_event_weight,
    unit: "decimal",
    ratioDenominator: `weight_of_${news.constituents_read}_largest_holdings`,
    derivationToolId: `${ADAPTER_ID}:news:filing_event_weight`,
    derivationInput: { window_days: news.window_days, filers: news.filing_event_count },
  }));
}

function crossMarketFacts(grounding, context) {
  const rows = grounding?.cross_market;
  const stamp = grounding?.gathered_at || context.asOf;
  const publicAt = timestampAtOrBefore(stamp, context.cutoff);
  if (Array.isArray(rows) && publicAt) {
    for (const row of rows) {
      if (!finite(row?.correlation)) continue;
      const factId = CROSS_MARKET_FACTS[row.reference];
      if (!factId) continue;
      const sourceIdValue = sourceId("market", "cross_correlation", row.reference, row.to);
      if (!registerSource(context, {
        source_id: sourceIdValue,
        source_kind: "market_snapshot",
        title: `daily closes for ${row.label}`,
        url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(row.reference)}?range=1y&interval=1d`,
        public_at: publicAt,
        retrieved_at: stamp,
        locator: { reference: row.reference, from: row.from, to: row.to, sessions: row.sessions },
      })) continue;
      addUnique(context.facts, context.diagnostics, baseFact({
        factId,
        valueKind: "ratio",
        value: row.correlation,
        unit: "decimal",
        ratioDenominator: `pearson_over_${row.sessions}_paired_sessions`,
        asOf: context.asOf,
        publicAt,
        sources: [sourceIdValue],
        confidence: 0.8,
        derivation: "rederived",
        derivationToolId: `${ADAPTER_ID}:cross_market:${row.reference}`,
        derivationInput: { reference: row.reference, from: row.from, to: row.to, relative_return: row.relative_return },
      }));
    }
  }
  const dispersion = grounding?.sector_dispersion;
  if (dispersion?.available && finite(dispersion.dispersion) && publicAt) {
    const sourceIdValue = sourceId("market", "sector_dispersion", dispersion.to);
    if (registerSource(context, {
      source_id: sourceIdValue,
      source_kind: "market_snapshot",
      title: "Select Sector SPDR daily closes",
      url: "https://query1.finance.yahoo.com/v8/finance/chart/XLK?range=1y&interval=1d",
      public_at: publicAt,
      retrieved_at: stamp,
      locator: { sectors: dispersion.measured, from: dispersion.from, to: dispersion.to },
    })) {
      addUnique(context.facts, context.diagnostics, baseFact({
        factId: "market.sector_dispersion",
        valueKind: "ratio",
        value: dispersion.dispersion,
        unit: "decimal",
        ratioDenominator: `stdev_of_${dispersion.measured}_sector_total_returns`,
        asOf: context.asOf,
        publicAt,
        sources: [sourceIdValue],
        confidence: 0.8,
        derivation: "rederived",
        derivationToolId: `${ADAPTER_ID}:sector_dispersion`,
        derivationInput: { leader: dispersion.leader?.symbol, laggard: dispersion.laggard?.symbol, from: dispersion.from, to: dispersion.to },
      }));
    }
  }
}

/** Reference market -> the fact id its correlation is published under. */
const CROSS_MARKET_FACTS = Object.freeze({
  "^GSPC": "market.correlation_to_broad_market",
  "^KS11": "market.correlation_to_kospi",
  "^KQ11": "market.correlation_to_kosdaq",
  "^SOX": "market.correlation_to_semiconductors",
});

function insiderOwnershipFacts(grounding, context) {
  const owned = grounding?.insider_ownership;
  if (!owned || !finite(owned.value)) return;
  const publicAt = timestampAtOrBefore(owned.public_at, context.cutoff);
  const numeratorSourceIds = Array.isArray(owned.numerator_source_ids) ? owned.numerator_source_ids : [];
  const numeratorSources = Array.isArray(owned.numerator_sources) ? owned.numerator_sources : [];
  const denominator = owned.denominator;
  if (!publicAt || !numeratorSourceIds.length || numeratorSources.length !== numeratorSourceIds.length
      || !denominator?.source_id || !denominator?.source_url || !denominator?.public_at
      || denominator.measurement !== "point_in_time_common_shares_outstanding") {
    context.diagnostics.push({ code: "missing_source_lineage", source: "insider_ownership", action: "not_converted" });
    return;
  }
  for (const source of numeratorSources) {
    if (!numeratorSourceIds.includes(source?.source_id)
        || !source?.accession || !source?.url || !source?.filing_date) {
      context.diagnostics.push({ code: "missing_source_lineage", source: "insider_ownership.numerator", action: "not_converted" });
      return;
    }
    const sourcePublicAt = timestampAtOrBefore(source.filing_date, context.cutoff);
    if (!sourcePublicAt || !registerSource(context, {
      source_id: source.source_id,
      source_kind: "regulatory_filing_data",
      title: `SEC Form ${source.form || "3/4/5"} ownership filing ${source.accession}`,
      url: source.url,
      public_at: sourcePublicAt,
      retrieved_at: grounding.gathered_at || publicAt,
      locator: {
        accession: source.accession,
        form: source.form || null,
        owner_cik: source.owner_cik || null,
        report_date: source.report_date || null,
      },
    })) return;
  }
  const denominatorPublicAt = timestampAtOrBefore(denominator.public_at, context.cutoff);
  if (!denominatorPublicAt) {
    context.diagnostics.push({ code: "future_source", source: "insider_ownership.denominator", action: "not_converted" });
    return;
  }
  const denominatorIdentity = secCompanyFactsIdentity(denominator.source_id);
  if (!registerSource(context, {
    source_id: denominator.source_id,
    source_kind: "regulatory_filing_data",
    title: denominatorIdentity.title,
    url: denominator.source_url,
    public_at: denominatorPublicAt,
    retrieved_at: grounding.gathered_at || publicAt,
    locator: {
      ...denominatorIdentity.locator,
      taxonomy: denominator.taxonomy,
      form: denominator.form,
      measurement: denominator.measurement,
    },
  })) return;
  addUnique(context.facts, context.diagnostics, baseFact({
    factId: "governance.insider_ownership",
    valueKind: "ratio",
    value: owned.value,
    unit: "decimal",
    ratioDenominator: "point_in_time_common_shares_outstanding",
    asOf: context.asOf,
    publicAt,
    sources: [...numeratorSourceIds, denominator.source_id],
    confidence: 0.7,
    derivation: "estimated",
    derivationToolId: `${ADAPTER_ID}:section16:insider_ownership`,
    derivationInput: {
      method: owned.method,
      reporting_owners: owned.owner_count,
      owner_report_date_min: owned.owner_report_date_min || null,
      owner_report_date_max: owned.owner_report_date_max || null,
      coverage: owned.coverage || null,
      denominator: {
        measurement: denominator.measurement,
        taxonomy: denominator.taxonomy,
        tag: denominator.tag,
        form: denominator.form,
        period_end: denominator.period_end,
        value: denominator.value,
      },
    },
  }));
}

function instrumentAggregateFacts(grounding, context) {
  const aggregates = grounding?.instrument_aggregate?.facts;
  if (!Array.isArray(aggregates)) return;
  for (const entry of aggregates) {
    if (!entry?.fact_id || !finite(entry.value)) continue;
    const publicAt = timestampAtOrBefore(entry.public_at, context.cutoff);
    if (!publicAt || !/^https?:\/\//u.test(entry.source_url || "")) {
      context.diagnostics.push({ code: "missing_source_lineage", source: `instrument.${entry.fact_id}`, action: "not_converted" });
      continue;
    }
    const sourceIdValue = sourceId(entry.source_kind || "instrument", entry.fact_id, entry.observation_date || publicAt.slice(0, 10));
    if (!registerSource(context, {
      source_id: sourceIdValue,
      source_kind: entry.source_kind || "market_snapshot",
      title: entry.title || `instrument aggregate ${entry.fact_id}`,
      url: entry.source_url,
      public_at: publicAt,
      retrieved_at: grounding.gathered_at || publicAt,
      locator: entry.locator || { fact_id: entry.fact_id },
    })) continue;
    addUnique(context.facts, context.diagnostics, baseFact({
      factId: entry.fact_id,
      valueKind: entry.value_kind || "ratio",
      value: entry.value,
      unit: entry.unit || "decimal",
      // A monetary fact carries a currency and a scale; forwarding only the ratio fields
      // rejected the whole pack the moment a basket published its size in dollars.
      currency: entry.currency ?? null,
      scale: entry.scale ?? null,
      ratioDenominator: entry.ratio_denominator,
      periodStart: entry.period_start || null,
      periodEnd: entry.period_end || entry.observation_date || null,
      asOf: context.asOf,
      publicAt,
      sources: [sourceIdValue],
      confidence: finite(entry.confidence) ? entry.confidence : 0.75,
      derivation: entry.derivation || "rederived",
      derivationToolId: `${ADAPTER_ID}:instrument:${entry.fact_id}`,
      derivationInput: entry.method
        ? { method: entry.method, coverage_weight: entry.coverage_weight ?? null, basis: entry.basis ?? null }
        : null,
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
  marketHistoryFacts(grounding, context);
  screenFacts(grounding, context);
  macroSeriesFacts(grounding, context);
  fundamentalFacts(grounding, context);
  instrumentAggregateFacts(grounding, context);
  // The same converter, over the market-level block a company run now carries. Reusing it
  // rather than writing a second one keeps one set of lineage and unit rules for facts that
  // are the same facts, whoever the subject is.
  instrumentAggregateFacts({ instrument_aggregate: grounding?.market_valuation, gathered_at: grounding?.gathered_at }, context);
  insiderOwnershipFacts(grounding, context);
  crossMarketFacts(grounding, context);
  basketNewsFacts(grounding, context);
  for (const family of ["screen", "macro", "market"]) {
    if (grounding?.[family] && !grounding[family].public_at) {
      if (family === "screen" && context.diagnostics.some((item) => String(item.source || "").startsWith("screen."))) continue;
      // The market-priced macro block still has no lineage of its own, but the dated FRED
      // series now cover the same ground; reporting both would read as a gap that is filled.
      if (family === "macro" && grounding.macro_series?.series) continue;
      context.diagnostics.push({ code: "missing_source_lineage", source: family, action: "not_converted" });
    }
  }
  context.facts = enforceTypedFactSourceVisibility(context.facts, context.sourceRecords, context.diagnostics);
  const usedSourceIds = new Set(context.facts.flatMap((fact) => fact.source_ids || []));
  for (const id of context.sourceRecords.keys()) {
    if (!usedSourceIds.has(id)) context.sourceRecords.delete(id);
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
