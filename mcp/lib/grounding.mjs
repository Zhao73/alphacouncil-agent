import { fetchQuote } from "./quotes.mjs";
import { invalidParams } from "./errors.mjs";
import { getMacroSnapshot } from "./macro.mjs";
import { fetchMacroSeries } from "./fred.mjs";
import { fetchFundamentals } from "./fundamentals.mjs";
import { fetchInsiderOwnership } from "./insider-ownership.mjs";
import { INDEX_PROXIES, normalizeIndexSymbol } from "./index-aggregate.mjs";
import { SECTOR_SPDRS, fetchCrossMarket, fetchSectorDispersion } from "./cross-market.mjs";
import { fetchBasketNews } from "./basket-news.mjs";
import { gatherInstrumentFacts, LOOK_THROUGH_FACT_IDS } from "./instrument-facts.mjs";

/** The index a US company is measured against when a method asks what the market costs. */
const BROAD_MARKET_INDEX = "^GSPC";

/**
 * Facts that describe the market rather than the subject.
 *
 * Everything else the index block produces -- leverage, growth, breadth of a basket -- is about
 * a portfolio the company is not, and forwarding it would answer a different question in the
 * subject's name.
 */
const MARKET_LEVEL_FACTS = new Set([
  "index.aggregate_pe_ttm",
  "index.aggregate_pe_forward",
  "index.aggregate_earnings_yield",
  "index.dividend_yield",
  "valuation.implied_erp",
  "cycle.valuation_percentile",
]);
import { fetchOptionsChain } from "./options.mjs";
import { screenTicker } from "./screen.mjs";
import { resolveIndustry, industryCoverage } from "./industry.mjs";
import { fetchSubmissions, fetchUniverse } from "./sec.mjs";
import { fetchMarketFinancials, coverageFor, marketFor } from "./markets.mjs";
import { inclusiveCutoffTime } from "./personas-v3/source-anchor.mjs";
import { adaptGroundingToTypedFacts } from "./personas-v3/grounding-adapter.mjs";
import { classifyInstrument, instrumentResearchChecklist, isFundOrIndex } from "./instruments.mjs";
import { fetchEquityMarketHistory } from "./equity-history.mjs";
import {
  acquireCompanyStarterEvidence,
  buildCompanySourceAcquisitionPlan,
  discoverIssuerOfficialSources,
} from "./company-source-acquisition.mjs";
import { companyObservationHistory } from "./company-observations.mjs";
// Aliased: this module already has a private `localized(label, chinese)` for metric labels.
import { localized as localizedText } from "./lang.mjs";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * Current quote, option, macro and unversioned industry feeds cannot reconstruct a past
 * information set. A date-only cutoff includes that whole UTC day; an exact timestamp is
 * allowed only while it has not already passed. Historical runs must use an archived fact
 * pack instead of relabelling today's snapshot with an old date.
 */
export function liveSnapshotPolicy(asOf, { now = new Date() } = {}) {
  if (asOf === null || asOf === undefined || asOf === "") {
    return { allowed: true, reason: "current_run_without_cutoff", cutoff_time: null };
  }
  const cutoff = inclusiveCutoffTime(asOf);
  if (!Number.isFinite(cutoff)) {
    throw invalidParams(`as_of must be YYYY-MM-DD or a zoned timestamp, got ${JSON.stringify(asOf)}`);
  }
  const nowTime = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(nowTime)) throw new Error("grounding now must be a valid timestamp");
  const allowed = cutoff >= nowTime;
  return {
    allowed,
    reason: allowed
      ? (DATE_ONLY.test(asOf) ? "cutoff_includes_current_utc_day" : "cutoff_not_yet_passed")
      : "historical_cutoff_requires_archived_fact_pack",
    cutoff_time: new Date(cutoff).toISOString(),
  };
}

/**
 * Hard facts, assembled before any analyst starts searching.
 *
 * The gap this closes: the tools already knew Micron's filed cash flow and the current
 * 10-year yield, and the analysts did not. Each one went off and searched from nothing,
 * free to report a number from a news summary that contradicts the filing without anyone
 * noticing. Grounding puts the deterministic facts in the prompt first and changes what
 * the search is FOR -- from producing numbers to explaining and challenging numbers that
 * are already established.
 *
 * The discipline that makes this work rather than just adding context: a searched number
 * never silently overwrites a filed one. A contradiction is reported as a contradiction.
 */

async function safely(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    // A gap stays a visible gap. Grounding that silently omits a failed source would be
    // worse than no grounding, because the prompt would look complete.
    return { ok: false, error: `${label}: ${String(error?.message || error)}` };
  }
}

/**
 * @param {object} options
 * @param {string} [options.symbol]   exchange ticker, for the quote
 * @param {string} [options.cik]      SEC CIK, for filings and the screen
 * @param {string} [options.industry] industry query, for the chain map
 * @param {boolean} [options.macro]   include the macro snapshot
 * @param {boolean} [options.options] include the delayed CBOE option-chain digest for US listings
 * @param {string} [options.asOf]     only use filings filed by this date
 */
/** The tracking ETF whose listed chain stands in for a cash index. */
function indexProxyEtf(symbol) {
  return INDEX_PROXIES[normalizeIndexSymbol(symbol)]?.etf || null;
}

export async function gatherGrounding({
  symbol,
  cik,
  industry,
  macro = true,
  options = true,
  asOf = null,
  now = new Date(),
  language = "English",
  signal,
  budgetMs = null,
} = {}) {
  const snapshotPolicy = liveSnapshotPolicy(asOf, { now });
  const gatheredAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const out = {
    as_of: asOf,
    gathered_at: gatheredAt,
    point_in_time_policy: snapshotPolicy,
    unavailable: [],
    not_applicable: [],
  };
  const jobs = [];
  let quoteJob = null;

  if (symbol && snapshotPolicy.allowed) {
    quoteJob = safely("quote", () => fetchQuote(symbol, { signal })).then((r) => {
      if (r.ok && !r.value?.error) out.quote = r.value;
      else out.unavailable.push(r.ok ? `quote: ${r.value.error}` : r.error);
    });
    jobs.push(quoteJob);
  } else if (symbol) {
    out.unavailable.push("quote: historical cutoff requires an archived point-in-time price; current snapshot was not fetched");
  }

  if (macro && snapshotPolicy.allowed) {
    jobs.push(safely("macro", () => getMacroSnapshot({ blocks: ["rates", "dollar_liquidity", "commodities"], signal })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      out.macro = {
        derived: r.value.derived.filter((d) => d.available).map((d) => ({ id: d.id, label: d.label, value: d.value })),
        unavailable: r.value.unavailable,
      };
    }));
    // Dated official series, fetched alongside the market block rather than instead of it.
    // The block prices the present; these carry the history a regime or an impulse needs, and
    // each observation publishes its own date, so they are the only macro input that can
    // reach the typed-fact pack with real lineage.
    jobs.push(safely("macro series", () => fetchMacroSeries({ asOf, signal })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      out.macro_series = r.value;
      out.unavailable.push(...r.value.unavailable);
    }));
  } else if (macro) {
    out.unavailable.push("macro: historical cutoff requires archived observations; current market snapshots were not fetched");
  }

  // Classification is a routing decision, so wait for the already-started quote metadata
  // before choosing SEC/company versus fund/index paths. Macro continues in parallel.
  if (quoteJob) await quoteJob;
  out.instrument = classifyInstrument({ symbol, quote: out.quote });

  // Without this, a caller that has a ticker but not a CIK gets no filer profile and no
  // mechanical screen -- the filings half of "established facts" disappears and nothing
  // in the output says it was skipped. Fund registrants still get their submissions profile,
  // but never an operating-company Company Facts screen.
  const symbolMarket = marketFor(symbol);
  const secRegistrantCandidate = symbolMarket?.id === "US"
    && !["index", "future", "fx", "crypto"].includes(out.instrument.asset_type);
  if (!cik && symbol && secRegistrantCandidate && snapshotPolicy.allowed) {
    const mapping = await safely("SEC ticker mapping", () => fetchUniverse({ signal }));
    if (mapping.ok) {
      const match = mapping.value.find((row) => String(row.ticker).toUpperCase() === String(symbol).toUpperCase());
      cik = match?.cik;
      if (match) {
        out.sec_ticker_match = { cik: match.cik, ticker: match.ticker, title: match.title };
        out.instrument = classifyInstrument({ symbol, quote: out.quote, filer: { title: match.title } });
      }
    } else {
      out.unavailable.push(mapping.error);
    }
  } else if (!cik && symbol && secRegistrantCandidate) {
    out.unavailable.push("SEC ticker mapping: historical cutoff requires an explicit point-in-time CIK; today's ticker universe was not fetched");
  }

  // Persona methods must receive the same shape the options calculator actually returns.
  // Do not manufacture realised volatility, a friction-adjusted edge, or event coverage:
  // the delayed CBOE snapshot does not contain any of them. Its explicit `unavailable`
  // entries remain attached to the grounding so downstream policies see gaps as gaps.
  if (symbol && options && symbolMarket?.id === "US" && !out.instrument.index_like && snapshotPolicy.allowed) {
    jobs.push(safely("options chain", () => fetchOptionsChain(symbol, { asOf, signal })).then((r) => {
      if (r.ok && r.value?.available) out.options = r.value;
      else out.unavailable.push(r.ok ? `options chain: ${r.value?.reason || "unavailable"}` : r.error);
    }));
  } else if (symbol && options && symbolMarket?.id === "US" && !out.instrument.index_like) {
    out.unavailable.push("options chain: historical cutoff requires an archived chain; current CBOE snapshot was not fetched");
  } else if (symbol && options && out.instrument.index_like && indexProxyEtf(symbol) && snapshotPolicy.allowed) {
    // A cash index has no chain of its own on this adapter, and its tracking ETF does. The
    // holdings path already answers "the index itself is licensed, so read the tracker and say
    // so"; a volatility surface is the same problem and gets the same answer. What must not
    // happen is the substitution going unlabelled -- an ETF's implied volatility is not the
    // index's, and a reader comparing them needs to know which one this is.
    const proxy = indexProxyEtf(symbol);
    jobs.push(safely("options chain", () => fetchOptionsChain(proxy, { asOf, signal })).then((r) => {
      if (r.ok && r.value?.available) {
        out.options = { ...r.value, proxy_for: normalizeIndexSymbol(symbol), is_proxy: true,
          proxy_note: `${proxy} option chain used as an explicit proxy; the cash index has no chain on this adapter` };
      } else {
        out.unavailable.push(r.ok ? `options chain via ${proxy}: ${r.value?.reason || "unavailable"}` : r.error);
      }
    }));
  } else if (symbol && options && out.instrument.index_like) {
    out.not_applicable.push(localizedText(language, {
      en: "CBOE equity/ETF option-chain adapter: direct cash-index symbol is not supported; use the appropriate listed derivative or ETF proxy explicitly",
      zh: "CBOE 股票/ETF 期权链适配器：不支持直接的现金指数代码；请显式使用对应的上市衍生品或 ETF 代理。",
      ja: "CBOE の株式/ETF オプションチェーン・アダプタ：現物指数シンボルには非対応です。対応する上場デリバティブまたは ETF 代理を明示的に使用してください。",
      ko: "CBOE 주식/ETF 옵션 체인 어댑터: 현물 지수 심볼은 지원하지 않습니다. 해당 상장 파생상품 또는 ETF 프록시를 명시적으로 사용하십시오.",
    }));
  }

  // What else is this a bet on. Only for baskets: a single company's correlation to KOSPI is a
  // fact about its sector, not about the company, and the seats that reason about crowding and
  // position size are asking about the basket.
  if (symbol && isFundOrIndex(out.instrument)) {
    jobs.push(safely("cross-market", () => fetchCrossMarket(symbol, { signal })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      if (r.value.facts.length) out.cross_market = r.value.facts;
      out.unavailable.push(...r.value.unavailable);
    }));
    jobs.push(safely("sector dispersion", () => fetchSectorDispersion(SECTOR_SPDRS, { signal })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      if (r.value.available) out.sector_dispersion = r.value;
      out.unavailable.push(...(r.value.unavailable || []));
    }));
  }

  if (cik) {
    if (snapshotPolicy.allowed) {
      // Resolve the registrant before deciding whether Company Facts applies. Scheduling
      // both in parallel recreated the QQQ bug when quote metadata was unavailable: the
      // screen started under an equity fallback before the fund name arrived.
      const filer = await safely("filer profile", () => fetchSubmissions(cik, { signal }));
      if (filer.ok) {
        out.filer = filer.value;
        out.instrument = classifyInstrument({ symbol, quote: out.quote, filer: out.filer });
        if (out.instrument.research_model === "operating_company") {
          jobs.push(safely("adaptive company source acquisition", async () => {
            const issuerIndex = await discoverIssuerOfficialSources(out.filer, {
              asOf: asOf || gatheredAt.slice(0, 10),
              signal,
            });
            const starterEvidence = await acquireCompanyStarterEvidence({
              symbol,
              asOf: asOf || gatheredAt.slice(0, 10),
              profile: out.filer,
              issuerIndex,
            }, { signal });
            return { issuerIndex, starterEvidence };
          })
            .then((result) => {
              if (!result.ok) { out.unavailable.push(result.error); return; }
              out.issuer_source_index = result.value.issuerIndex;
              out.company_starter_evidence = result.value.starterEvidence;
              if (result.value.issuerIndex.status !== "succeeded") {
                out.unavailable.push(`issuer official source index: ${result.value.issuerIndex.reason || result.value.issuerIndex.status}`);
              }
              if (result.value.starterEvidence.source_status !== "succeeded") {
                out.unavailable.push("adaptive company starter evidence: every keyless feed and issuer document probe was unreachable");
              }
            }));
        }
      } else out.unavailable.push(filer.error);
    } else {
      out.unavailable.push("filer profile: SEC submissions metadata is current, not point-in-time versioned; it was excluded from the historical information set");
    }
    // The mechanical screen answers "is this worth research time"; the derived fundamentals
    // answer "what do the method seats need". Both read the same Company Facts document, so
    // they share one classification gate and run together.
    if (out.instrument.sec_companyfacts_applicable && snapshotPolicy.allowed) {
      const fundamentalsJob = safely("fundamentals", () => fetchFundamentals({ cik, ticker: symbol, asOf, signal })).then((r) => {
        if (!r.ok) { out.unavailable.push(r.error); return; }
        out.fundamentals = r.value;
        out.unavailable.push(...(r.value.unavailable || []).map((gap) => (
          typeof gap === "string" ? gap : `fundamentals ${gap.metric}: ${gap.code}${gap.detail ? ` (${gap.detail})` : ""}`
        )));
      });
      jobs.push(fundamentalsJob);
      // Insider ownership must use an instant register count from CompanyFacts, never the
      // annual weighted-average diluted EPS denominator exposed by fundamentals. The ownership
      // adapter fetches and records that point-in-time denominator itself, so both jobs can run
      // independently and an unavailable denominator skips the ratio rather than miscomputing it.
      jobs.push((async () => {
        const owned = await safely("insider ownership", () => fetchInsiderOwnership(cik, { asOf, signal }));
        if (!owned.ok) { out.unavailable.push(owned.error); return; }
        out.unavailable.push(...(owned.value.unavailable || []));
        if (!Number.isFinite(owned.value.value)) return;
        out.insider_ownership = owned.value;
      })());
    }
    if (out.instrument.sec_companyfacts_applicable) jobs.push(safely("screen", () => screenTicker({ cik, ticker: symbol, asOf, signal })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      const s = r.value;
      const metricSourceIds = (metric) => (metric.source_records || []).map((source) => (
        `sec:companyfacts:${s.cik}:${source.tag}:${source.accession || source.filed}:${source.period_end}`
      ));
      const metrics = s.rules.filter((x) => !x.skipped).map((x) => ({
        rule: x.id,
        label: x.label,
        value: x.value,
        unit: x.unit,
        threshold: x.threshold,
        direction: x.direction,
        passed: x.passed,
        period_start: x.period_start || null,
        period_end: x.period_end || null,
        span_days: Number.isFinite(x.span_days) ? x.span_days : null,
        span_years: Number.isFinite(x.span_years) ? x.span_years : null,
        observation_count: Number.isInteger(x.observation_count) ? x.observation_count : null,
        fiscal_year: x.fiscal_year || null,
        public_at: x.public_at || null,
        source_ids: metricSourceIds(x),
      }));
      out.screen = {
        cik: s.cik,
        verdict: s.verdict,
        rules_computed: s.evaluated_count,
        rules_total: s.rules.length,
        // Only the computed rules: a skipped rule is not a fact about the company.
        metrics,
        public_at: metrics.map((metric) => metric.public_at).filter(Boolean).sort().at(-1) || null,
        failures: s.failures.map((f) => ({ rule: f.id, value: f.value, unit: f.unit, threshold: f.threshold })),
        exemptions: s.exemptions,
        skipped: s.rules.filter((x) => x.skipped).map((x) => ({ rule: x.id, label: x.label })),
      };
    }));
    else if (out.instrument.asset_type === "unknown") {
      // Not the same thing as "not applicable": we could not classify the security at all,
      // so withholding the screen is a gap the report must show, not a settled routing call.
      out.unavailable.push(localizedText(language, {
        en: "SEC Company Facts screen: instrument type unresolved (no exchange metadata and no registrant match), so the operating-company screen was withheld rather than assumed",
        zh: "SEC Company Facts 筛选：证券类型未能判定（既无交易所元数据也无注册人匹配），因此不做经营公司假设，直接跳过该筛选。",
        ja: "SEC Company Facts スクリーン：銘柄種別を判定できず（取引所メタデータも登録人一致もなし）、事業会社と仮定せずスクリーンを見送りました。",
        ko: "SEC Company Facts 스크린: 증권 유형을 확정하지 못해(거래소 메타데이터·등록인 일치 모두 없음) 사업회사로 가정하지 않고 스크린을 보류했습니다.",
      }));
    } else out.not_applicable.push(localizedText(language, {
      en: `operating-company SEC Company Facts screen: not applicable to ${out.instrument.asset_type}`,
      zh: `经营公司 SEC Company Facts 筛选：不适用于 ${out.instrument.asset_type}。`,
      ja: `事業会社向け SEC Company Facts スクリーン：${out.instrument.asset_type} には適用されません。`,
      ko: `사업회사용 SEC Company Facts 스크린: ${out.instrument.asset_type}에는 적용되지 않습니다.`,
    }));
  }

  // A listed operating company without a SEC CIK still gets real company-specific source
  // acquisition. This covers non-US listings and US names missing from the current SEC ticker
  // map without requiring a customer key or an extra package. The issuer name comes from the
  // quote metadata; regulator and market-official routes are selected later from the suffix.
  if (!cik && symbol && out.instrument?.research_model === "operating_company" && snapshotPolicy.allowed) {
    const fallbackProfile = {
      name: out.quote?.long_name || out.quote?.short_name || symbol,
      tickers: [symbol],
      exchanges: out.quote?.exchange ? [out.quote.exchange] : [],
      market_id: symbolMarket?.id || null,
      regulator: symbolMarket?.regulator || null,
      recent_filings: [],
    };
    jobs.push(safely("adaptive company starter evidence", () => acquireCompanyStarterEvidence({
      symbol,
      asOf: asOf || gatheredAt.slice(0, 10),
      profile: fallbackProfile,
    }, { signal })).then((result) => {
      if (!result.ok) { out.unavailable.push(result.error); return; }
      out.company_starter_evidence = result.value;
      if (result.value.source_status !== "succeeded") {
        out.unavailable.push("adaptive company starter evidence: every keyless company feed was unreachable");
      }
    }));
  }

  // A quote snapshot cannot answer volume versus average, realised volatility, or aligned
  // relative performance. Fetch one year of keyless daily history once and share the same
  // deterministic calculations with every analyst and method seat. The sector proxy is chosen
  // from SEC SIC when available (for example a semiconductor issuer maps to SMH), while SPY is
  // always the broad US benchmark.
  if (symbol && symbolMarket?.id === "US" && !isFundOrIndex(out.instrument) && snapshotPolicy.allowed) {
    jobs.push(safely("market history", () => fetchEquityMarketHistory(symbol, {
      asOf,
      sic: out.filer?.sic,
      signal,
    })).then((result) => {
      if (!result.ok) { out.unavailable.push(result.error); return; }
      if (!result.value.available) {
        out.unavailable.push(...(result.value.unavailable || []).map((gap) => `market history: ${gap}`));
        return;
      }
      out.market_history = result.value;
      out.unavailable.push(...(result.value.unavailable || []).map((gap) => `market history partial: ${gap}`));
    }));
  } else if (symbol && symbolMarket?.id === "US" && !isFundOrIndex(out.instrument)) {
    out.unavailable.push("market history: historical cutoff requires an archived daily-price snapshot; current Yahoo history was not fetched");
  }

  // Non-US symbols never reach the SEC path, so without this they arrived at the analyst
  // with nothing but a price.
  if (symbol && symbolMarket && symbolMarket.id !== "US" && !isFundOrIndex(out.instrument) && snapshotPolicy.allowed) {
    jobs.push(safely("market financials", () => fetchMarketFinancials(symbol, { signal })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      out.market = r.value;
      if (!r.value.financials) out.unavailable.push(`structured financials for ${symbol}: ${r.value.guidance}`);
    }));
  } else if (symbol && symbolMarket && symbolMarket.id !== "US" && !isFundOrIndex(out.instrument)) {
    out.unavailable.push(`structured financials for ${symbol}: this adapter is not point-in-time versioned; current data was not fetched for a historical cutoff`);
  }

  // The market's own valuation, for every US subject rather than only for baskets.
  //
  // Three seats require `index.aggregate_earnings_yield` and reported it missing on every
  // single-company run this product has ever done. They were right to ask: the market's
  // aggregate earnings yield is not a property of the subject, it is the yardstick the subject
  // is measured against. Damodaran's implied premium needs it, Asness's Fed-model critique IS
  // about it, and Marks reads it as where the cycle stands. The subject decides whose holdings
  // get read; it does not decide whether the market has a price-earnings ratio.
  if (symbol && !isFundOrIndex(out.instrument) && symbolMarket?.id === "US" && snapshotPolicy.allowed) {
    jobs.push(safely("market valuation", () => gatherInstrumentFacts({
      symbol: BROAD_MARKET_INDEX, instrument: { research_model: "index_aggregate", index_like: true },
      asOf, signal, lookThroughFactIds: [],
    })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      // Only the market-level block. A company's own leverage and growth come from its filings,
      // and taking them from the index would be silently answering a different question.
      const marketFacts = (r.value.facts || []).filter((fact) => MARKET_LEVEL_FACTS.has(fact.fact_id));
      if (marketFacts.length) { out.market_valuation = { ...r.value, facts: marketFacts }; return; }
      // A fetch that succeeds but yields no market-level fact used to vanish here. Downstream,
      // Marks and Damodaran declined with `unmet: index.aggregate_earnings_yield` and the reader
      // was never told why the yardstick was missing -- an unexplained abstention reads as a
      // verdict. Record it as the data gap it is.
      out.unavailable.push(
        `market valuation for ${BROAD_MARKET_INDEX}: fetched, but none of ${[...MARKET_LEVEL_FACTS].join(", ")} was derivable`
        + " (seats that measure a company against the market will decline for lack of grounding, not for lack of a view)",
      );
    }));
  } else if (symbol && !isFundOrIndex(out.instrument) && symbolMarket?.id === "US") {
    // Every other block on this path names the cutoff it could not serve; this one used to
    // skip in silence, so a historical run lost the yardstick with nothing said about it and
    // Marks and Damodaran again declined for a reason the reader could not see.
    out.unavailable.push(
      `market valuation for ${BROAD_MARKET_INDEX}: the index aggregate is published only as a current snapshot`
      + " with no point-in-time archive, so it was not fetched for a historical cutoff"
      + " (seats that measure a company against the market will decline for lack of grounding, not for lack of a view)",
    );
  }

  // A fund or index has no issuer financials, so this is where its evidence comes from
  // instead: published holdings, index-level valuation and the look-through aggregates that
  // let an operating-company method run against a basket at all.
  if (symbol && isFundOrIndex(out.instrument) && snapshotPolicy.allowed) {
    const instrumentJob = safely("instrument aggregate", () => gatherInstrumentFacts({
      symbol, instrument: out.instrument, asOf, signal,
      // The operating-company facts a basket can supply at all: everything the method seats
      // ask of a company, aggregated by weight across the constituents that publish it.
      lookThroughFactIds: LOOK_THROUGH_FACT_IDS,
    })).then((r) => {
      if (!r.ok) { out.unavailable.push(r.error); return; }
      out.instrument_aggregate = r.value;
      out.unavailable.push(...(r.value.unavailable || []));
    });
    jobs.push(instrumentJob);
    // A basket has no press office and files nothing, so its news comes from what it holds.
    // Chained after the instrument pass rather than run beside it, because the holdings are
    // what name the industry -- fetching them twice to avoid the wait would cost more than it
    // saves.
    jobs.push((async () => {
      await instrumentJob;
      const holdings = out.instrument_aggregate?.holdings;
      if (!holdings?.length) return;
      const news = await safely("basket news", () => fetchBasketNews(holdings, { asOf, signal }));
      if (!news.ok) { out.unavailable.push(news.error); return; }
      if (news.value.available) out.basket_news = news.value;
      out.unavailable.push(...(news.value.unavailable || []));
    })());
  } else if (symbol && isFundOrIndex(out.instrument)) {
    // The same silence as the market-valuation block above, and worse here: a basket's
    // holdings, look-through aggregates and news are the whole of its evidence, so a
    // historical cutoff left the seats with a price and nothing to explain the emptiness.
    out.unavailable.push(
      `holdings, look-through aggregates and basket news for ${symbol}: issuer holdings and index`
      + " aggregates are published only as current snapshots with no point-in-time archive,"
      + " so they were not fetched for a historical cutoff",
    );
  }

  if (symbol && isFundOrIndex(out.instrument)) {
    out.not_applicable.push(localizedText(language, {
      en: `operating-company structured financials: not applicable to ${out.instrument.asset_type}; use look-through or aggregate index evidence`,
      zh: `经营公司结构化财报：不适用于 ${out.instrument.asset_type}；请使用持仓穿透或指数聚合证据。`,
      ja: `事業会社の構造化財務データ：${out.instrument.asset_type} には適用されません。ルックスルーまたは指数集計エビデンスを使用してください。`,
      ko: `사업회사 구조화 재무데이터: ${out.instrument.asset_type}에는 적용되지 않습니다. 룩스루 또는 지수 집계 증거를 사용하십시오.`,
    }));
  }

  if (industry && snapshotPolicy.allowed) {
    const curated = resolveIndustry(industry);
    out.industry = {
      query: industry,
      coverage: industryCoverage(industry),
      ...(curated
        ? {
          id: curated.id,
          title: curated.title,
          participants: curated.layers.flatMap((l) => l.participants.map((p) => ({ ...p, layer: l.layer }))),
          demand_drivers: curated.demand_drivers,
          key_questions: curated.key_questions,
          cyclicality: curated.cyclicality,
        }
        : {}),
    };
  } else if (industry) {
    out.unavailable.push("industry map: the curated map is not publication-versioned and was excluded from the historical information set");
  }

  // Return what arrived, not nothing.
  //
  // A caller that raced this whole function against a timer threw away a completed quote, a
  // completed screen and a completed filing set because one slow feed had not landed -- and the
  // analysts downstream, handed an empty object, reported "no ticker was provided". The symbol
  // had been provided; the fetch had not finished. Settling at the budget keeps everything that
  // did arrive and names what did not.
  if (Number.isFinite(budgetMs) && budgetMs > 0) {
    let settled = false;
    const all = Promise.all(jobs).then(() => { settled = true; });
    let timer;
    await Promise.race([
      all,
      new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); }),
    ]);
    clearTimeout(timer);
    if (!settled) {
      out.partial = true;
      out.unavailable.push(
        `grounding budget of ${Math.round(budgetMs)}ms elapsed before every source answered;`
        + " this run carries what arrived by then and names the rest as gaps rather than discarding it",
      );
    }
  } else {
    await Promise.all(jobs);
  }

  // Coverage across every symbol in play, so a report cannot quietly become US-only.
  const inPlay = [symbol, ...(out.industry?.participants || []).map((p) => p.symbol)].filter(Boolean);
  if (inPlay.length && !isFundOrIndex(out.instrument)) out.coverage = coverageFor([...new Set(inPlay)]);
  else if (symbol && isFundOrIndex(out.instrument)) {
    out.coverage = {
      rows: [{
        symbol,
        market: symbolMarket?.id || "market",
        structured_financials: localizedText(language, {
          en: "not applicable", zh: "不适用", ja: "適用外", ko: "해당 없음",
        }),
        reason: localizedText(language, {
          en: `${out.instrument.asset_type} requires holdings/index look-through rather than issuer financial statements`,
          zh: `${out.instrument.asset_type} 需要持仓/指数穿透，而不是发行人财务报表。`,
          ja: `${out.instrument.asset_type} は発行体の財務諸表ではなく、保有銘柄・指数のルックスルーが必要です。`,
          ko: `${out.instrument.asset_type}는 발행인 재무제표가 아니라 보유종목·지수 룩스루가 필요합니다.`,
        }),
      }],
      summary: { full: 0, summary_only: 0, none: 0, not_applicable: 1 },
      note: localizedText(language, {
        en: "Fund/index research uses dated holdings, methodology and aggregate or look-through evidence.",
        zh: "基金/指数研究使用带日期的持仓、方法论，以及聚合或穿透证据。",
        ja: "ファンド/指数のリサーチは、日付入りの保有銘柄・方法論・集計またはルックスルーのエビデンスを使用します。",
        ko: "펀드/지수 리서치는 일자가 명시된 보유종목, 방법론, 집계 또는 룩스루 증거를 사용합니다.",
      }),
    };
  }
  if (out.instrument?.research_model === "operating_company") {
    try {
      out.company_observation_history = companyObservationHistory(symbol, {
        asOf: asOf || gatheredAt.slice(0, 10),
      });
    } catch (error) {
      out.unavailable.push(`company observation history: ${String(error?.message || error)}`);
    }
    const sourceProfile = out.filer || {
      ...(out.sec_ticker_match || {}),
      name: out.market?.financials?.company_name
        || out.quote?.long_name
        || out.quote?.short_name
        || out.sec_ticker_match?.title
        || symbol,
      tickers: [symbol],
      exchanges: out.quote?.exchange ? [out.quote.exchange] : [],
      market_id: symbolMarket?.id || null,
      regulator: symbolMarket?.regulator || null,
    };
    out.source_acquisition_plan = buildCompanySourceAcquisitionPlan({
      symbol,
      asOf: asOf || gatheredAt.slice(0, 10),
      profile: sourceProfile,
      issuerIndex: out.issuer_source_index,
    });
  }
  const typed = adaptGroundingToTypedFacts(out, {
    asOf: asOf || gatheredAt,
    knowledgeAsOf: asOf || gatheredAt,
  });
  out.typed_fact_pack = typed.fact_pack;
  out.typed_fact_sources = typed.sources;
  out.typed_fact_diagnostics = typed.diagnostics;
  return out;
}

const fmt = (value, unit) => {
  if (value === null || value === undefined) return "n/a";
  if (unit === "%") return `${value}%`;
  if (unit === "USD") return Math.abs(value) >= 1e9 ? `$${(value / 1e9).toFixed(2)}bn` : `$${value.toLocaleString("en-US")}`;
  return unit ? `${value} ${unit}` : String(value);
};

/**
 * Render grounding as a prompt block.
 *
 * The instructions are the substance here. Facts alone would just be more context for a
 * model to paraphrase; what changes behaviour is telling it what these facts are FOR and
 * what it may not do with them.
 */
/**
 * A skipped rule arrives either as a bare id or as {rule, label}. Handling only the object
 * form silently rendered an empty list -- which reads as "nothing was skipped", the exact
 * opposite of what the line exists to say.
 */
const skippedName = (entry, chinese) =>
  (typeof entry === "string" ? entry : localized(entry?.label, chinese) || entry?.rule) || String(entry ?? "");

/** Render a bilingual label. Every {en, zh} value must pass through here before display. */
const localized = (label, chinese) => {
  if (label == null) return "";
  if (typeof label === "string") return label;
  return (chinese ? label.zh : label.en) ?? label.en ?? label.zh ?? "";
};

const quoteStatusLabel = (status, chinese) => ({
  real_time: chinese ? "实时（提供方标记）" : "real-time (provider flagged)",
  regular_session_delayed: chinese ? "常规交易时段延迟行情" : "regular-session delayed observation",
  regular_close: chinese ? "常规交易时段收盘价" : "regular-session close",
  end_of_day_close: chinese ? "日终收盘价" : "end-of-day close",
  last_regular_trade: chinese ? "最近常规交易价" : "last regular trade",
}[status] || (chinese ? "新鲜度未核实" : "freshness unverified"));

const countText = (value) => (Number.isFinite(value)
  ? value.toLocaleString("en-US")
  : value ?? "n/a");

export function groundingBlock(grounding, language = "English") {
  const chinese = /中文|chinese|zh/i.test(String(language));
  if (!grounding || (!grounding.instrument && !grounding.filer && !grounding.quote && !grounding.screen && !grounding.options && !grounding.macro && !grounding.industry)) return "";

  const lines = [];
  const head = chinese
    ? "## 已确立的事实（来自申报原文与交易所数据，不是你的记忆）"
    : "## Established facts (from filings and exchange data, not from your memory)";
  lines.push(head);

  if (grounding.instrument) {
    const i = grounding.instrument;
    lines.push(chinese
      ? `- 资产类型：${i.asset_type}｜研究模型 ${i.research_model}｜识别来源 ${i.classification_source}`
      : `- Instrument: ${i.asset_type} | research model ${i.research_model} | classified by ${i.classification_source}`);
  }

  if (grounding.filer) {
    const filer = grounding.filer;
    const exchanges = Array.isArray(filer.exchanges) ? filer.exchanges : [];
    lines.push(chinese
      ? `- 主体：${filer.name}｜SIC ${filer.sic ?? "未知"}（${filer.sic_description ?? "-"}）｜交易所 ${exchanges.join(", ") || "未知"}`
      : `- Filer: ${filer.name} | SIC ${filer.sic ?? "unknown"} (${filer.sic_description ?? "-"}) | exchange ${exchanges.join(", ") || "unknown"}`);
    if (filer.submissions_url) {
      const exposed = Array.isArray(filer.recent_filings) ? filer.recent_filings.length : 0;
      lines.push(chinese
        ? `  - SEC submissions 官方 feed：共 ${filer.recent_filings_count ?? "未知"} 条 recent 记录，本次结构化提供 ${exposed} 条｜检索 ${filer.submissions_retrieved_at || "未知"}｜${filer.submissions_url}`
        : `  - Authoritative SEC submissions feed: ${filer.recent_filings_count ?? "unknown"} recent rows; ${exposed} exposed in this structured window | retrieved ${filer.submissions_retrieved_at || "unknown"} | ${filer.submissions_url}`);
    }
    if (filer.latest_filing) {
      const latest = filer.latest_filing;
      lines.push(chinese
        ? `  - SEC feed 最新申报（按受理/提交时间排序，不是搜索结果）：${latest.filing_date || "未知"} ${latest.form || "未知表格"}｜受理 ${latest.accepted_at || "未知"}｜accession ${latest.accession || "未知"}｜${latest.primary_document_url || "原文链接不可用"}`
        : `  - Latest SEC filing by accepted/filed order (not search recency): ${latest.filing_date || "unknown"} ${latest.form || "unknown form"} | accepted ${latest.accepted_at || "unknown"} | accession ${latest.accession || "unknown"} | ${latest.primary_document_url || "primary document unavailable"}`);
    }
    if (filer.investor_website || filer.website) {
      lines.push(chinese
        ? `  - SEC 主体资料给出的官方入口：IR ${filer.investor_website || "未披露"}｜官网 ${filer.website || "未披露"}`
        : `  - Official issuer entries from the SEC profile: IR ${filer.investor_website || "not disclosed"} | website ${filer.website || "not disclosed"}`);
    }
  }
  if (grounding.issuer_source_index) {
    const index = grounding.issuer_source_index;
    lines.push(chinese
      ? `- 发行人官方来源索引：${index.status}｜入口 ${(index.roots || []).length}｜发现候选页面 ${(index.pages || []).length}｜采集 ${index.observed_at || "未知"}`
      : `- Issuer official-source index: ${index.status} | roots ${(index.roots || []).length} | candidate pages ${(index.pages || []).length} | observed ${index.observed_at || "unknown"}`);
  }
  if (grounding.company_starter_evidence) {
    const starter = grounding.company_starter_evidence;
    lines.push(chinese
      ? `- 跨源主动预取：SEC 申报 ${(starter.filings || []).length} 条｜发行人正文摘要 ${(starter.issuer_documents || []).length} 页｜${starter.window_days} 日内主题新闻 ${(starter.news || []).length} 条｜feed 成功 ${(starter.feed_attempts || []).filter((row) => row.ok).length}/${(starter.feed_attempts || []).length}`
      : `- Adaptive starter evidence: ${(starter.filings || []).length} SEC filings | ${(starter.issuer_documents || []).length} issuer-document excerpts | ${(starter.news || []).length} thematic news items within ${starter.window_days}d | feeds ${(starter.feed_attempts || []).filter((row) => row.ok).length}/${(starter.feed_attempts || []).length} succeeded`);
    const filingRows = starter.filings || [];
    if (filingRows.length) {
      lines.push(chinese ? "  - 本次冻结 starter pack 的全部 SEC 申报索引：" : "  - Complete SEC filing index in this frozen starter pack:");
      for (const filing of filingRows) {
        lines.push(`    - ${filing.filing_date || "unknown"} | ${filing.form || "unknown"} | ${filing.accession || "unknown accession"} | ${filing.primary_document_url || "no document URL"}`);
      }
    }
    const newsRows = starter.news || [];
    if (newsRows.length) {
      lines.push(chinese ? "  - 本次冻结 starter pack 的全部带日期线索（仍须打开原文核实）：" : "  - Complete dated-lead set in this frozen starter pack (open originals before relying on them):");
      for (const item of newsRows) {
        lines.push(`    - ${item.published_at || "unknown"} | ${item.topic || "company"} | ${item.title} | ${item.link || item.feed_url}`);
      }
    }
    const issuerDocuments = (starter.issuer_documents || []).filter((doc) => doc.excerpt);
    if (issuerDocuments.length) {
      lines.push(chinese ? "  - 本次冻结 starter pack 的全部发行人官网正文摘要：" : "  - Complete issuer-site excerpt set in this frozen starter pack:");
      for (const doc of issuerDocuments) {
        lines.push(`    - ${doc.title || "official issuer page"} | ${doc.url} | ${doc.content_hash || "hash unavailable"} | ${doc.excerpt}`);
      }
    }
  }
  if (grounding.company_observation_history?.status === "available") {
    const history = grounding.company_observation_history;
    const revisionSeries = (history.series || []).filter((row) => row.change_90d_status === "available").length;
    lines.push(chinese
      ? `- 本地同口径公司数据历史：${history.observation_count} 条观测｜${revisionSeries} 组已可计算 90 日变化；其余继续积累，不把不同期间/单位混成修正序列。`
      : `- Local like-for-like company history: ${history.observation_count} observations | ${revisionSeries} series have a valid 90-day change; others keep building and never mix periods or units.`);
  }
  if (grounding.quote) {
    const q = grounding.quote;
    const observedAt = q.quote_time || "unknown";
    const gatheredAt = q.gathered_at || grounding.gathered_at || "unknown";
    const age = Number.isFinite(q.stale_age_hours)
      ? (chinese ? `${q.stale_age_hours} 小时` : `${q.stale_age_hours}h`)
      : (chinese ? "未知" : "unknown");
    const status = quoteStatusLabel(q.quote_status, chinese);
    lines.push(chinese
      ? `- 行情（${status}，${q.source || "来源未知"}）：${q.symbol} ${q.price}${q.currency ? " " + q.currency : ""}${q.change_pct != null ? `，${q.change_pct > 0 ? "+" : ""}${q.change_pct}%` : ""}｜报价 ${observedAt} → 采集 ${gatheredAt}｜实际陈旧 ${age}`
      : `- Quote (${status}, ${q.source || "unknown source"}): ${q.symbol} ${q.price}${q.currency ? " " + q.currency : ""}${q.change_pct != null ? `, ${q.change_pct > 0 ? "+" : ""}${q.change_pct}%` : ""} | observed ${observedAt} -> gathered ${gatheredAt} | measured age ${age}`);
  }
  if (grounding.screen) {
    const s = grounding.screen;
    lines.push(chinese
      ? `- 硬指标筛选：${s.verdict === "survives" ? "通过" : "淘汰"}（${s.rules_computed}/${s.rules_total} 条可算）`
      : `- Mechanical screen: ${s.verdict} (${s.rules_computed} of ${s.rules_total} rules computable)`);
    for (const m of s.metrics) {
      lines.push(`  - ${localized(m.label, chinese)}: ${fmt(m.value, m.unit)} (${m.direction === "max" ? "max" : "min"} ${m.threshold}) ${m.passed ? "pass" : "FAIL"}`);
    }
    if (s.skipped.length) {
      lines.push(chinese
        ? `  - 无法从申报计算，未按通过处理：${s.skipped.map((x) => skippedName(x, chinese)).join("、")}`
        : `  - Not computable from filings and NOT treated as passes: ${s.skipped.map((x) => skippedName(x, chinese)).join(", ")}`);
    }
  }
  if (grounding.options?.available) {
    const o = grounding.options;
    const reference = o.reference_expiry;
    const skew = o.skew_25delta;
    const atm = Number.isFinite(reference?.atm_iv) ? `${(reference.atm_iv * 100).toFixed(1)}%` : "n/a";
    const skewPoints = Number.isFinite(skew?.put_minus_call) ? (skew.put_minus_call * 100).toFixed(2) : "n/a";
    lines.push(chinese
      ? `- 期权链（延迟，${o.source || "CBOE"}）：参考到期 ${reference?.expiry || "n/a"}｜ATM IV ${atm}｜25-delta put-call skew ${skewPoints} 波动率点`
      : `- Options chain (delayed, ${o.source || "CBOE"}): reference expiry ${reference?.expiry || "n/a"} | ATM IV ${atm} | 25-delta put-minus-call skew ${skewPoints} vol points`);
    if (o.open_interest) {
      const oi = o.open_interest;
      lines.push(chinese
        ? `  - 未平仓量：calls ${countText(oi.calls)}｜puts ${countText(oi.puts)}｜put/call OI ratio ${oi.put_call_ratio ?? "n/a"}`
        : `  - Open interest: calls ${countText(oi.calls)} | puts ${countText(oi.puts)} | put/call OI ratio ${oi.put_call_ratio ?? "n/a"}`);
    }
    if (Array.isArray(o.largest_open_interest_strikes) && o.largest_open_interest_strikes.length) {
      const strikes = o.largest_open_interest_strikes.slice(0, 6).map((row) => (
        `${row.strike ?? "n/a"} (OI ${countText(row.open_interest)}, ${row.vs_spot_pct == null ? "n/a" : `${row.vs_spot_pct}% vs spot`})`
      ));
      lines.push(chinese
        ? `  - 最大 OI 执行价及集中量：${strikes.join("；")}`
        : `  - Largest-OI strikes and concentrations: ${strikes.join("; ")}`);
    }
    if (o.unavailable?.length) {
      lines.push(chinese
        ? `  - 此快照无法提供：${o.unavailable.join("；")}`
        : `  - Not supplied by this snapshot: ${o.unavailable.join("; ")}`);
    }
  }
  if (grounding.macro?.derived?.length) {
    lines.push(chinese ? "- 宏观读数：" : "- Macro readings:");
    // Derived labels are {en, zh}; interpolating the object printed "[object Object]"
    // next to a real number, which reads as a broken field rather than a missing one.
    for (const d of grounding.macro.derived) {
      const name = localized(d.label, chinese) || d.id;
      lines.push(`  - ${name}: ${d.value}`);
    }
  }
  if (grounding.market?.financials) {
    const f = grounding.market.financials;
    lines.push(chinese
      ? `- ${f.source} 申报（${f.gregorian_year ?? f.period.year}Q${f.period.quarter}，${f.currency} ${f.unit}）：营收 ${f.revenue?.toLocaleString() ?? "n/a"}｜毛利 ${f.gross_profit?.toLocaleString() ?? "n/a"}｜营业利益 ${f.operating_income?.toLocaleString() ?? "n/a"}｜EPS ${f.eps ?? "n/a"}`
      : `- ${f.source} filing (${f.gregorian_year ?? f.period.year}Q${f.period.quarter}, ${f.currency} ${f.unit}): revenue ${f.revenue?.toLocaleString() ?? "n/a"} | gross profit ${f.gross_profit?.toLocaleString() ?? "n/a"} | operating income ${f.operating_income?.toLocaleString() ?? "n/a"} | EPS ${f.eps ?? "n/a"}`);
  }
  if (grounding.coverage?.rows?.length) {
    const none = grounding.coverage.rows.filter((r) => r.structured_financials === "no").map((r) => r.symbol);
    if (none.length) {
      lines.push(chinese
        ? `- 以下标的没有结构化财务源，任何关于它们的财务数字必须来自你读到的原始文件并注明出处：${none.join("、")}`
        : `- No structured financial feed for: ${none.join(", ")}. Any financial figure for these must come from a primary document you actually read, and be cited as such.`);
    }
  }
  if (grounding.industry?.participants?.length) {
    const names = grounding.industry.participants.map((p) => `${p.name}${p.symbol ? ` (${p.symbol})` : " (unlisted)"}`);
    lines.push(chinese
      ? `- 产业链参与者（含非美，名单为人工维护）：${names.join("、")}`
      : `- Value-chain participants (includes non-US; list is hand-maintained): ${names.join(", ")}`);
  }
  if (grounding.unavailable?.length) {
    lines.push(chinese ? `- 确定性预取尚未取得（必须继续执行下方来源梯，禁止用记忆补）：${grounding.unavailable.join("；")}`
      : `- Deterministic prefetch did not obtain these; continue through the source ladder below and never fill them from memory: ${grounding.unavailable.join("; ")}`);
  }
  if (grounding.not_applicable?.length) {
    lines.push(chinese ? `- 明确不适用（不是数据抓取错误）：${grounding.not_applicable.join("；")}`
      : `- Explicitly not applicable (not a retrieval failure): ${grounding.not_applicable.join("; ")}`);
  }

  const instrumentChecklist = instrumentResearchChecklist(grounding.instrument, language);
  if (instrumentChecklist) lines.push("", instrumentChecklist);

  lines.push("");
  lines.push(chinese
    ? [
      "**这些事实改变你搜索的目的。** 它们已经确立，不需要你再去找一遍。你联网搜索是为了：",
      "1. **解释**这些数字为什么是这样——是什么业务变化导致的？",
      "2. **补上**它们没覆盖的：最新一季、指引、管理层表态、竞争与监管动向、非美同业。",
      "3. **挑战**它们：有没有公开信息说明这些数字会在下一期发生方向性变化？",
      "",
      "铁律：",
      "- **搜到的数字不得覆盖申报数字。** 两者冲突时，两个都写出来、都给来源、明确指出这是冲突，并说明可能的口径差异（期间、GAAP/non-GAAP、币种、是否含一次性项）。让读者看到分歧，不要替读者选。",
      "- 上面标为「无法计算」或「取不到」的是确定性预取结果，不是允许立即交付的缺口。先执行本席位冻结来源梯；实际披露仍无结果时，按契约给出可复算代理值或模型区间。只有来源梯穷尽后才能进入 open_questions。",
      "- 引用上面的事实时注明来自申报/交易所，与你搜到的来源分开标注。",
    ].join("\n")
    : [
      "**These facts change what your search is for.** They are already established; do not go and re-find them. Search in order to:",
      "1. **Explain** why the numbers look like this -- what change in the business produced them?",
      "2. **Extend** what they do not cover: the latest quarter, guidance, management commentary, competitive and regulatory developments, non-US peers.",
      "3. **Challenge** them: is there public information indicating these figures change direction next period?",
      "",
      "Hard rules:",
      "- **A searched number never overwrites a filed number.** Where they conflict, report BOTH with their sources, say plainly that they conflict, and identify the likely reason (different period, GAAP vs non-GAAP, currency, inclusion of one-off items). Show the reader the disagreement rather than resolving it for them.",
      "- Not-computable or not-retrieved above describes deterministic prefetch, not permission to stop. Execute the frozen source ladder, then produce a reproducible proxy or modeled range when an actual remains undisclosed. Only an exhausted ladder may enter open_questions.",
      "- When you cite a fact from above, mark it as filing or exchange data, distinct from sources you found by searching.",
    ].join("\n"));

  return lines.join("\n");
}
