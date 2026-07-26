import { LIMITS } from "./constants.mjs";

/**
 * Korea (DART) and Japan (EDINET) adapters.
 *
 * Both regulators publish full filings and both require a free key, so these activate the
 * moment the key is present and stay inert otherwise. Written and error-handled against
 * the real endpoints -- the failure shapes below were captured from live calls, not
 * guessed, which is why an unregistered key produces a message naming the fix rather than
 * a generic HTTP error.
 *
 *   DART:   {"status":"010","message":"등록되지 않은 인증키입니다."}   (unregistered key)
 *   EDINET: {"StatusCode":401,"message":"Access denied due to invalid subscription key..."}
 */

const timeout = () => LIMITS.QUOTE_FETCH_MS * 3;

async function getJson(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout());
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json", ...headers } });
    const text = await res.text();
    if (text.trimStart().startsWith("<")) throw new Error(`expected JSON, got HTML (HTTP ${res.status})`);
    return { status: res.status, body: JSON.parse(text) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Korea: DART ----------------------------------------------------------

/** DART status codes that mean "your key is the problem", not "no data". */
const DART_KEY_ERRORS = {
  "010": "the key is not registered",
  "011": "the key is suspended",
  "012": "access denied for this IP",
  "020": "the daily request quota is exhausted",
  "021": "the request rate limit was exceeded",
};

const DART_REPORTS = { Q1: "11013", H1: "11012", Q3: "11014", FY: "11011" };

/**
 * Annual or quarterly statements for one Korean issuer.
 * @param {string} corpCode DART's 8-digit corp_code, not the exchange ticker.
 */
export async function fetchDartFinancials({ corpCode, year, report = "FY", key = process.env.ALPHACOUNCIL_DART_KEY }) {
  if (!key) {
    return {
      available: false,
      reason: "ALPHACOUNCIL_DART_KEY is not set. Register free at opendart.fss.or.kr and export the key.",
    };
  }
  const reprt = DART_REPORTS[report] || DART_REPORTS.FY;
  const url = `https://opendart.fss.or.kr/api/fnlttSinglAcnt.json?crtfc_key=${encodeURIComponent(key)}`
    + `&corp_code=${encodeURIComponent(corpCode)}&bsns_year=${encodeURIComponent(year)}&reprt_code=${reprt}`;

  const { body } = await getJson(url);
  if (body.status && body.status !== "000") {
    const keyProblem = DART_KEY_ERRORS[body.status];
    return {
      available: false,
      dart_status: body.status,
      reason: keyProblem
        ? `DART rejected the key: ${keyProblem}. (${body.message})`
        // 013 is "no data", which is a legitimate answer and not a configuration fault.
        : `DART returned status ${body.status}: ${body.message}`,
      is_key_problem: Boolean(keyProblem),
    };
  }

  const rows = Array.isArray(body.list) ? body.list : [];
  const num = (v) => {
    const n = Number(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  // Consolidated statements (CFS) where present, otherwise separate (OFS).
  const pick = (accountName, sj) => {
    const match = rows.find((r) => r.account_nm === accountName && r.sj_div === sj && r.fs_div === "CFS")
      || rows.find((r) => r.account_nm === accountName && r.sj_div === sj);
    return match ? num(match.thstrm_amount) : null;
  };

  return {
    available: true,
    market: "KR",
    source: "DART fnlttSinglAcnt",
    corp_code: corpCode,
    period: { year, report },
    currency: "KRW",
    unit: "as filed",
    revenue: pick("매출액", "IS") ?? pick("수익(매출액)", "IS"),
    operating_income: pick("영업이익", "IS"),
    net_income: pick("당기순이익", "IS"),
    assets: pick("자산총계", "BS"),
    equity: pick("자본총계", "BS"),
    liabilities: pick("부채총계", "BS"),
    raw_row_count: rows.length,
    note: "DART reports Korean account names; consolidated (CFS) is preferred over separate (OFS) where both exist.",
  };
}

/** Resolve an exchange ticker such as 000660.KS to DART's corp_code. */
export async function resolveDartCorpCode(ticker, key = process.env.ALPHACOUNCIL_DART_KEY) {
  if (!key) return { available: false, reason: "ALPHACOUNCIL_DART_KEY is not set." };
  const stockCode = String(ticker).toUpperCase().replace(/\.(KS|KQ)$/, "");
  // corpCode.xml ships as a zip, which needs an unzip step this repo has no dependency
  // for. Rather than pull one in, callers pass corp_code directly; this documents why.
  return {
    available: false,
    reason: `DART maps tickers via corpCode.xml, distributed as a ZIP. Look up ${stockCode} at `
      + "opendart.fss.or.kr and pass corp_code directly. (Samsung Electronics is 00126380, SK hynix 00164779.)",
    stock_code: stockCode,
  };
}

// ---- Japan: EDINET --------------------------------------------------------

/**
 * Recent filings for a Japanese issuer.
 *
 * EDINET indexes by submission date rather than by company, so this scans a window of
 * days and filters. That is the API's shape, not a workaround.
 */
export async function fetchEdinetFilings({ secCode, days = 90, key = process.env.ALPHACOUNCIL_EDINET_KEY }) {
  if (!key) {
    return {
      available: false,
      reason: "ALPHACOUNCIL_EDINET_KEY is not set. Register free at the EDINET portal and export the subscription key.",
    };
  }
  const code = String(secCode).toUpperCase().replace(/\.T$/, "");
  const wanted = code.length === 4 ? `${code}0` : code; // EDINET secCode is 5 digits

  const found = [];
  const today = new Date();
  // One request per day is the API's granularity; cap the window so a caller cannot
  // accidentally issue hundreds of requests.
  const window = Math.max(1, Math.min(120, days));
  for (let i = 0; i < window; i += 1) {
    const day = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    let result;
    try {
      result = await getJson(`https://api.edinet-fsa.go.jp/api/v2/documents.json?date=${day}&type=2&Subscription-Key=${encodeURIComponent(key)}`);
    } catch {
      continue; // one bad day must not abort the scan
    }
    if (result.body?.StatusCode === 401) {
      return { available: false, reason: `EDINET rejected the key: ${result.body.message}`, is_key_problem: true };
    }
    for (const doc of result.body?.results || []) {
      if (doc.secCode === wanted) {
        found.push({
          doc_id: doc.docID,
          submitted: doc.submitDateTime,
          filer: doc.filerName,
          description: doc.docDescription,
          period_end: doc.periodEnd,
          // The document itself is a ZIP of XBRL; fetching it needs an unzip step this
          // repo deliberately has no dependency for.
          document_url: `https://api.edinet-fsa.go.jp/api/v2/documents/${doc.docID}?type=2`,
        });
      }
    }
    if (found.length >= 8) break;
  }

  return {
    available: true,
    market: "JP",
    source: "EDINET v2 documents index",
    sec_code: wanted,
    filings: found,
    note: found.length
      ? "Filing metadata only. The documents are XBRL inside a ZIP, so extracting figures needs WebFetch on the "
        + "document URL or the company's own IR page -- and those figures must be cited as read from a document."
      : `No filings found for ${wanted} in the last ${window} days. Widen the window or check the 5-digit secCode.`,
  };
}
