/**
 * Classify the security before choosing a research contract.
 *
 * Yahoo's chart metadata already distinguishes ETF, INDEX and EQUITY, but the quote
 * adapter used to discard that field. As a result QQQ was sent through an operating-
 * company Company Facts screen and a predictable HTTP 404 was reported as a research
 * failure. Keep this module deterministic and deliberately small: it classifies the
 * instrument; it does not pretend to provide holdings, index earnings or fund flows.
 */

import { localized } from "./lang.mjs";
import { FUND_REGISTRY } from "./funds.mjs";

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

/**
 * Cash indices people type without the caret.
 *
 * `^SOX` classified as an index and `SOX` did not, so a run on the name everyone actually uses
 * produced no basket facts at all and every seat abstained for want of data it was never going
 * to get. These are index names, not listed tickers -- deliberately a short curated set rather
 * than the whole alias table, because an alias that collides with a real ticker would route a
 * tradable security into the index path, which is the mirror image of the same defect.
 */
const BARE_INDEX_SYMBOLS = new Set([
  "SOX", "SPX", "NDX", "DJIA", "DJI", "RUT", "VIX", "IXIC", "GSPC", "COMPQ", "NYA", "OEX", "XAX",
]);

function symbolHeuristic(symbol) {
  const text = String(symbol || "").trim().toUpperCase();
  if (!text) return null;
  if (text.startsWith("^")) return "index";
  if (BARE_INDEX_SYMBOLS.has(text)) return "index";
  if (text.endsWith("=F")) return "future";
  if (text.endsWith("=X")) return "fx";
  if (/^[A-Z0-9]+-USD$/u.test(text)) return "crypto";
  return null;
}

// A fund vehicle word anywhere in the name means the security is a pooled vehicle, not the
// cash index it tracks. Without this, "Vanguard Index Funds" matched the bare `index` token
// and VOO -- one of the most liquid optionable ETFs -- was routed as a cash index, which
// silently disables the option chain.
const FUND_VEHICLE = /\b(fund|funds|trust|etf|shares|portfolio|admiral|investor)\b/u;

function nameHeuristic(quote, filer) {
  const name = `${quote?.short_name || ""} ${quote?.long_name || ""} ${filer?.name || filer?.title || ""}`.toLowerCase();
  if (!name.trim()) return null;
  if (/\b(etf|exchange[ -]traded fund)\b/u.test(name) || /\btrust,?\s+(series|units?)\b/u.test(name)) return "etf";
  // Ordered before the bare `index` token on purpose: "index fund(s)" is a vehicle name.
  if (/\b(mutual|investment|index)\s+funds?\b/u.test(name)) return "mutual_fund";
  if (/\bindex\b/u.test(name) && !FUND_VEHICLE.test(name)) return "index";
  return null;
}

// SEC Standard Industrial Classification codes filed by pooled investment vehicles. ETF and
// closed-end-fund registrants file 6722/6726, so a filed SIC is NOT positive evidence of an
// operating company -- the previous comment here asserted the opposite and sent the whole
// iShares family (registrant "iShares Trust", SIC 6726) through Company Facts.
// 6798 (REITs) is deliberately absent: a REIT is an operating company with real filings.
const FUND_SIC = Object.freeze(new Set(["6722", "6726", "6770"]));

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

  if (!assetType && filer?.sic) {
    const sic = String(filer.sic).replace(/\D/gu, "").padStart(4, "0");
    if (FUND_SIC.has(sic)) {
      // This branch only fires when exchange metadata was unavailable, which in practice
      // means the symbol came through the exchange-traded fallback feed; open-end mutual
      // funds are not quoted there. Both map to fund_lookthrough regardless of the label.
      assetType = "etf";
      classificationSource = "sec_filer_sic_fund";
    } else {
      assetType = "equity";
      classificationSource = "sec_filer_sic";
    }
  }
  // A basket we hold an issuer holdings endpoint for is a basket, whatever a quote feed did or
  // did not say. This is a lookup of something this repository states, not a guess from ticker
  // shape, and it runs only after real evidence has had its turn so genuine metadata still
  // wins and still reports its own provenance. It strengthens the fail-closed rule below
  // rather than weakening it: the outcome is a fund, which is the one thing that can never be
  // sent through an operating-company screen.
  if (!assetType && Object.hasOwn(FUND_REGISTRY, String(symbol || quote?.symbol || "").trim().toUpperCase())) {
    assetType = "etf";
    classificationSource = "registered_fund_holdings_source";
  }
  // Deliberately fail closed. A bare ticker shape tells us nothing: SPY, QQQ and VOO all
  // match it, and the previous `equity` fallback sent them into an operating-company Company
  // Facts screen whenever Yahoo metadata was missing -- the exact QQQ defect 0.9.5 set out to
  // fix, reachable through the Stooq quote path which returns instrument_type: null.
  // `unknown` withholds the screen instead of asserting a company that may not exist.
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
  const pack = instrument.asset_type === "index" ? INDEX_CHECKLIST : FUND_CHECKLIST;
  return localized(language, pack);
}

const INDEX_CHECKLIST = Object.freeze({
  en: [
    "## Index-specific research contract",
    "- This is not an operating company. Do not look for index revenue, EPS, management guidance, Form 4 filings or company cash flow.",
    "- Required: methodology, dated constituents and weights, concentration, sector/factor exposures, aggregate earnings and valuation methodology, breadth, rebalances, macro sensitivity, and futures/options positioning when available.",
    "- Any aggregate EPS, P/E or price range needs a same-date methodology and coverage statement. If unavailable, record the gap; never add a few constituents together as index financials.",
  ].join("\n"),
  zh: [
    "## 指数专用研究合同",
    "- 这不是经营公司：不得寻找指数自身营收、EPS、管理层指引、Form 4 或公司式现金流。",
    "- 必查：指数方法、成分与权重时点、集中度、行业/因子暴露、聚合盈利与估值口径、广度、再平衡、宏观敏感度，以及可用的期货/期权定位。",
    "- 指数聚合盈利、P/E或目标区间必须给出同日口径和覆盖方法；取不到就列为数据缺口。不得把少数成分股相加成指数财报。",
  ].join("\n"),
  ja: [
    "## 指数専用リサーチ契約",
    "- これは事業会社ではありません。指数自体の売上・EPS・経営陣ガイダンス・Form 4・企業型キャッシュフローを探さないでください。",
    "- 必須項目：指数methodology、日付入り構成銘柄とウエイト、集中度、セクター/ファクター・エクスポージャー、集計利益と評価基準、市場の広がり、リバランス、マクロ感応度、および入手可能な先物・オプションのポジショニング。",
    "- 集計 EPS・PER・価格レンジには必ず同日基準とカバレッジの説明を付けてください。入手できない場合はギャップとして記録し、少数の構成銘柄を合算して指数の財務データを作ってはいけません。",
  ].join("\n"),
  ko: [
    "## 지수 전용 리서치 계약",
    "- 이것은 사업회사가 아닙니다. 지수 자체의 매출, EPS, 경영진 가이던스, Form 4, 기업형 현금흐름을 찾지 마십시오.",
    "- 필수 항목: 지수 산출 방법론, 일자가 명시된 구성종목과 비중, 집중도, 섹터/팩터 익스포저, 집계 이익과 밸류에이션 기준, 시장 폭, 리밸런싱, 매크로 민감도, 이용 가능한 선물·옵션 포지셔닝.",
    "- 집계 EPS·PER·가격 범위에는 반드시 동일 일자 기준과 커버리지 설명을 붙이십시오. 확보하지 못하면 갭으로 기록하고, 소수 구성종목을 합산해 지수 재무데이터를 만들지 마십시오.",
  ].join("\n"),
});

const FUND_CHECKLIST = Object.freeze({
  en: [
    "## ETF/fund-specific research contract",
    "- This is not an operating company. Do not seek fund revenue, company EPS or operating guidance, and do not label constituent Form 4 activity as fund insider trading.",
    "- Required: tracked index and methodology, dated holdings/weights, top-ten and sector concentration, fee, AUM, liquidity, premium/discount or tracking difference, flows, securities lending/borrowings/derivatives, rebalances and tax structure.",
    "- Fundamentals require look-through analysis: state the sample weight, keep issuer results separate, and never add them into ETF revenue or EPS. Aggregate valuation needs a same-date methodology and coverage statement.",
  ].join("\n"),
  zh: [
    "## ETF/基金专用研究合同",
    "- 这不是经营公司：不得寻找基金自身营收、公司EPS、管理层经营指引或把成分股Form 4写成基金内部人交易。",
    "- 必查：跟踪指数与方法、持仓/权重时点、前十大与行业集中度、费用率、规模、流动性、溢折价/跟踪差、资金流、证券出借/借款/衍生品、再平衡和税务结构。",
    "- 基本面必须做持仓穿透：明确样本覆盖权重，分开报告发行人结果，绝不可相加成ETF营收或EPS。聚合估值必须披露同日口径和覆盖方法。",
  ].join("\n"),
  ja: [
    "## ETF/ファンド専用リサーチ契約",
    "- これは事業会社ではありません。ファンド自体の売上・企業 EPS・経営ガイダンスを探さず、構成銘柄の Form 4 をファンドのインサイダー取引として扱わないでください。",
    "- 必須項目：連動指数と算出方法、日付入り保有銘柄とウエイト、上位10銘柄・セクター集中度、信託報酬、純資産総額、流動性、プレミアム/ディスカウントまたはトラッキング差、資金フロー、証券貸借・借入・デリバティブ、リバランス、税制上の構造。",
    "- ファンダメンタルズはルックスルー分析が必須です。サンプルのウエイトを明示し、発行体ごとの結果を分けて報告し、ETF の売上や EPS として合算してはいけません。集計バリュエーションには同日基準とカバレッジの説明が必要です。",
  ].join("\n"),
  ko: [
    "## ETF/펀드 전용 리서치 계약",
    "- 이것은 사업회사가 아닙니다. 펀드 자체의 매출, 기업 EPS, 경영 가이던스를 찾지 말고, 구성종목의 Form 4를 펀드 내부자 거래로 표기하지 마십시오.",
    "- 필수 항목: 추종 지수와 방법론, 일자가 명시된 보유종목과 비중, 상위 10종목·섹터 집중도, 보수율, 순자산, 유동성, 프리미엄/디스카운트 또는 추적오차, 자금흐름, 증권대차·차입·파생상품, 리밸런싱, 세제 구조.",
    "- 펀더멘털은 룩스루 분석이 필수입니다. 샘플 비중을 명시하고 발행인별 결과를 분리해 보고하며, ETF 매출이나 EPS로 합산하지 마십시오. 집계 밸류에이션에는 동일 일자 기준과 커버리지 설명이 필요합니다.",
  ].join("\n"),
});
