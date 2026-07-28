/**
 * Classify the security before choosing a research contract.
 *
 * Yahoo's chart metadata already distinguishes ETF, INDEX and EQUITY, but the quote
 * adapter used to discard that field. As a result QQQ was sent through an operating-
 * company Company Facts screen and a predictable HTTP 404 was reported as a research
 * failure. Keep this module deterministic and deliberately small: it classifies the
 * instrument; it does not pretend to provide holdings, index earnings or fund flows.
 */

export const ASSET_TYPES = Object.freeze([
  "equity",
  "etf",
  "index",
  "mutual_fund",
  "future",
  "fx",
  "crypto",
  "unknown",
]);

const YAHOO_TYPES = Object.freeze({
  EQUITY: "equity",
  ETF: "etf",
  INDEX: "index",
  MUTUALFUND: "mutual_fund",
  FUTURE: "future",
  CURRENCY: "fx",
  CRYPTOCURRENCY: "crypto",
});

function normalizedRawType(value) {
  return String(value || "").trim().toUpperCase().replace(/[\s-]+/gu, "_");
}

function symbolHeuristic(symbol) {
  const text = String(symbol || "").trim().toUpperCase();
  if (!text) return null;
  if (text.startsWith("^")) return "index";
  if (text.endsWith("=F")) return "future";
  if (text.endsWith("=X")) return "fx";
  if (/^[A-Z0-9]+-USD$/u.test(text)) return "crypto";
  return null;
}

function nameHeuristic(quote, filer) {
  const name = `${quote?.short_name || ""} ${quote?.long_name || ""} ${filer?.name || filer?.title || ""}`.toLowerCase();
  if (!name.trim()) return null;
  if (/\b(etf|exchange[ -]traded fund)\b/u.test(name) || /\btrust,?\s+(series|units?)\b/u.test(name)) return "etf";
  if (/\b(index)\b/u.test(name)) return "index";
  if (/\b(mutual fund|investment fund|index fund)\b/u.test(name)) return "mutual_fund";
  return null;
}

export function classifyInstrument({ symbol, quote, filer } = {}) {
  const rawType = normalizedRawType(quote?.instrument_type || quote?.quote_type);
  let assetType = YAHOO_TYPES[rawType]
    || symbolHeuristic(symbol || quote?.symbol)
    || nameHeuristic(quote, filer);
  let classificationSource = YAHOO_TYPES[rawType]
    ? "yahoo_chart_metadata"
    : symbolHeuristic(symbol || quote?.symbol)
      ? "symbol_convention"
      : nameHeuristic(quote, filer)
        ? (filer?.name || filer?.title ? "sec_registrant_name_heuristic" : "quote_name_heuristic")
        : "unresolved";

  // A filed SIC is positive evidence that the SEC registrant is an operating company.
  // Absence of a SIC is not enough to call something a fund, so unresolved stays unknown.
  if (!assetType && filer?.sic) {
    assetType = "equity";
    classificationSource = "sec_filer_sic";
  }
  if (!assetType && /^[A-Z0-9.\-]{1,10}$/u.test(String(symbol || quote?.symbol || "").trim().toUpperCase())) {
    assetType = "equity";
    classificationSource = "plain_us_ticker_fallback";
  }
  assetType ||= "unknown";

  const fundLike = assetType === "etf" || assetType === "mutual_fund";
  const indexLike = assetType === "index";
  const operatingCompany = assetType === "equity";
  const researchModel = fundLike
    ? "fund_lookthrough"
    : indexLike
      ? "index_aggregate"
      : operatingCompany
        ? "operating_company"
        : "market_instrument";

  return Object.freeze({
    symbol: String(symbol || quote?.symbol || "").trim(),
    asset_type: assetType,
    raw_instrument_type: rawType || null,
    classification_source: classificationSource,
    research_model: researchModel,
    operating_company: operatingCompany,
    fund_like: fundLike,
    index_like: indexLike,
    sec_companyfacts_applicable: operatingCompany,
  });
}

export function isFundOrIndex(instrument) {
  return instrument?.fund_like === true || instrument?.index_like === true
    || ["etf", "mutual_fund", "index"].includes(instrument?.asset_type);
}

export function instrumentResearchChecklist(instrument, language = "English") {
  if (!isFundOrIndex(instrument)) return "";
  const chinese = /\bzh\b|中文|chinese/iu.test(String(language));
  if (instrument.asset_type === "index") {
    return chinese
      ? [
        "## 指数专用研究合同",
        "- 这不是经营公司：不得寻找指数自身营收、EPS、管理层指引、Form 4 或公司式现金流。",
        "- 必查：指数方法、成分与权重时点、集中度、行业/因子暴露、聚合盈利与估值口径、广度、再平衡、宏观敏感度，以及可用的期货/期权定位。",
        "- 指数聚合盈利、P/E或目标区间必须给出同日口径和覆盖方法；取不到就列为数据缺口。不得把少数成分股相加成指数财报。",
      ].join("\n")
      : [
        "## Index-specific research contract",
        "- This is not an operating company. Do not look for index revenue, EPS, management guidance, Form 4 filings or company cash flow.",
        "- Required: methodology, dated constituents and weights, concentration, sector/factor exposures, aggregate earnings and valuation methodology, breadth, rebalances, macro sensitivity, and futures/options positioning when available.",
        "- Any aggregate EPS, P/E or price range needs a same-date methodology and coverage statement. If unavailable, record the gap; never add a few constituents together as index financials.",
      ].join("\n");
  }
  return chinese
    ? [
      "## ETF/基金专用研究合同",
      "- 这不是经营公司：不得寻找基金自身营收、公司EPS、管理层经营指引或把成分股Form 4写成基金内部人交易。",
      "- 必查：跟踪指数与方法、持仓/权重时点、前十大与行业集中度、费用率、规模、流动性、溢折价/跟踪差、资金流、证券出借/借款/衍生品、再平衡和税务结构。",
      "- 基本面必须做持仓穿透：明确样本覆盖权重，分开报告发行人结果，绝不可相加成ETF营收或EPS。聚合估值必须披露同日口径和覆盖方法。",
    ].join("\n")
    : [
      "## ETF/fund-specific research contract",
      "- This is not an operating company. Do not seek fund revenue, company EPS or operating guidance, and do not label constituent Form 4 activity as fund insider trading.",
      "- Required: tracked index and methodology, dated holdings/weights, top-ten and sector concentration, fee, AUM, liquidity, premium/discount or tracking difference, flows, securities lending/borrowings/derivatives, rebalances and tax structure.",
      "- Fundamentals require look-through analysis: state the sample weight, keep issuer results separate, and never add them into ETF revenue or EPS. Aggregate valuation needs a same-date methodology and coverage statement.",
    ].join("\n");
}
