import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isolateHome } from "./helpers.mjs";

isolateHome();
const data = await import("../src/core/data.mjs");
const { computeTechnicals } = await import("../src/core/technicals.mjs");
const { setFetch } = await import("../src/core/http.mjs");
const { evaluateLenses } = await import("../src/core/lenses.mjs");

const fy = (start, end, val, form = "10-K", filed = end) => ({ start, end, val, form, filed });

function companyFacts() {
  return {
    entityName: "Fixture Inc",
    facts: {
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: "2025-07-20", val: 1050 }, { end: "2026-07-20", val: 1000 }] } } },
      "us-gaap": {
        Revenues: { units: { USD: [
          fy("2022-01-01", "2022-12-31", 800), fy("2023-01-01", "2023-12-31", 900), fy("2024-01-01", "2024-12-31", 1000), fy("2025-01-01", "2025-12-31", 1200),
          fy("2025-01-01", "2025-06-30", 550, "10-Q"), fy("2026-01-01", "2026-06-30", 700, "10-Q"),
        ] } },
        NetIncomeLoss: { units: { USD: [fy("2024-01-01", "2024-12-31", 100), fy("2025-01-01", "2025-12-31", 150)] } },
        GrossProfit: { units: { USD: [fy("2025-01-01", "2025-12-31", 600)] } },
        OperatingIncomeLoss: { units: { USD: [fy("2025-01-01", "2025-12-31", 240)] } },
        NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fy("2025-01-01", "2025-12-31", 200)] } },
        PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [fy("2025-01-01", "2025-12-31", 50)] } },
        StockholdersEquity: { units: { USD: [{ end: "2025-12-31", val: 500, form: "10-K", filed: "2026-02-01" }, { end: "2026-06-30", val: 600, form: "10-Q", filed: "2026-08-01" }] } },
        LongTermDebtNoncurrent: { units: { USD: [{ end: "2026-06-30", val: 200, form: "10-Q", filed: "2026-08-01" }] } },
        CashAndCashEquivalentsAtCarryingValue: { units: { USD: [{ end: "2026-06-30", val: 300, form: "10-Q", filed: "2026-08-01" }] } },
      },
    },
  };
}

test("company facts: TTM = FY + YTD - prior YTD, growth, margins and multiples", () => {
  const f = data.summarizeCompanyFacts(companyFacts(), { price: 30, currency: "USD" });
  assert.equal(f.metrics.revenue.value, 1200 + 700 - 550);
  assert.equal(f.metrics.revenue.as_of, "2026-06-30");
  assert.equal(f.ratios.revenue_growth_pct, 20);
  assert.equal(f.ratios.revenue_cagr_3y_pct, 14.5);
  assert.equal(f.metrics.equity.value, 600);
  assert.equal(f.metrics.free_cash_flow.value, 150);
  assert.equal(f.ratios.market_cap, 30000);
  assert.equal(f.ratios.enterprise_value, 30000 + 200 - 300);
  assert.equal(f.ratios.share_count_change_pct, -4.76);
  assert.equal(f.ratios.pe_ttm, 200);
  assert.ok(f.gaps.some((g) => g.startsWith("eps_diluted")));
});

test("company facts: non-USD quotes skip multiples and say why", () => {
  const f = data.summarizeCompanyFacts(companyFacts(), { price: 30, currency: "EUR" });
  assert.equal(f.ratios.pe_ttm, undefined);
  assert.ok(f.gaps.some((g) => /currency EUR/.test(g)));
});

test("technicals: returns, averages, RSI and drawdown from bars", () => {
  const bars = Array.from({ length: 300 }, (_, i) => ({ date: new Date(Date.UTC(2025, 0, 1) + i * 864e5).toISOString().slice(0, 10), close: 100 + i * 0.5 + (i % 5), volume: 1000 + i }));
  const t = computeTechnicals(bars);
  assert.equal(t.available, true);
  assert.ok(t.return_12m_pct > 50);
  assert.ok(t.pct_vs_sma200 > 0);
  assert.ok(t.rsi14 > 50 && t.rsi14 <= 100);
  assert.ok(t.max_drawdown_1y_pct <= 0);
  assert.equal(computeTechnicals([{ date: "2026-01-01", close: 1 }]).available, false);
});

test("RSS parsing keeps dated items and decodes entities", () => {
  const xml = `<rss><channel><item><title><![CDATA[Acme &amp; Co beats]]></title><link>https://x.test/a</link><pubDate>Tue, 22 Sep 2026 10:00:00 GMT</pubDate><source url="https://x.test">Wire</source></item><item><title>No date</title><link>https://x.test/b</link></item></channel></rss>`;
  const items = data.parseRss(xml);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { title: "Acme & Co beats", url: "https://x.test/a", publisher: "Wire", date: "2026-09-22" });
  assert.equal(items[1].date, null);
});

test("options summary: OCC parsing, put/call ratios, ATM IV term structure", () => {
  const doc = { data: { current_price: 100, options: [
    { option: "ABC261016C00100000", iv: 0.30, open_interest: 100, volume: 10, delta: 0.5 },
    { option: "ABC261016P00100000", iv: 0.34, open_interest: 150, volume: 20, delta: -0.5 },
    { option: "ABC261016C00110000", iv: 0.28, open_interest: 50, volume: 5, delta: 0.25 },
    { option: "ABC261016P00090000", iv: 0.38, open_interest: 50, volume: 5, delta: -0.25 },
  ] } };
  assert.deepEqual(data.parseOcc("ABC261016P00090000"), { root: "ABC", expiry: "2026-10-16", type: "put", strike: 90 });
  const o = data.summarizeOptions(doc, "2026-09-24");
  assert.equal(o.put_call_oi_ratio, 1.33);
  assert.equal(o.term_structure[0].atm_iv_pct, 32);
  assert.equal(o.term_structure[0].skew_25d_pct, 10);
});

test("FRED CSV parsing drops missing values", () => {
  assert.deepEqual(data.parseFredCsv("DATE,DGS10\n2026-09-01,4.1\n2026-09-02,.\n"), [{ date: "2026-09-01", value: 4.1 }]);
});

test("instrument routing: ETF goes to fund look-through; SEC outage is not called non-US", async () => {
  const restore = setFetch(async (url) => {
    if (String(url).includes("/search")) return new Response(JSON.stringify({ quotes: [{ symbol: "SPY", quoteType: "ETF", shortname: "SPDR S&P 500" }] }));
    return new Response("denied", { status: 403 });
  });
  data.resetSecTickerCache();
  try {
    const etf = await data.resolveInstrument("spy");
    assert.equal(etf.route, "fund_lookthrough");
    const f = await data.getFundamentals("SPY", { instrument: etf });
    assert.equal(f.available, false);
    assert.match(f.reason, /fund_lookthrough/);
    const eq = { symbol: "MSFT", type: "equity", route: "operating_company", cik: null, sec_error: "HTTP 403 from www.sec.gov" };
    await assert.rejects(data.getFundamentals("MSFT", { instrument: eq }), /SEC EDGAR unreachable/);
  } finally {
    restore();
  }
});

test("symbols are validated before any request", () => {
  assert.equal(data.normalizeSymbol(" $brk-b "), "BRK-B");
  assert.equal(data.normalizeSymbol("0700.hk"), "0700.HK");
  assert.throws(() => data.normalizeSymbol("../etc/passwd"));
});

test("lenses: funds and indices abstain on company screens; thin data abstains", () => {
  const fund = evaluateLenses({ instrument: { route: "fund_lookthrough" }, technicals: { available: true, pct_vs_sma200: 5, sma50: 10, sma200: 9, momentum_12_1_pct: 3, pct_from_52w_high: -2 } });
  assert.equal(fund.find((l) => l.id === "deep_value").stance, "out_of_scope");
  assert.equal(fund.find((l) => l.id === "trend_momentum").stance, "supportive");
  const thin = evaluateLenses({ instrument: { route: "operating_company" }, fundamentals: { ratios: { pe_ttm: 10 } } }, ["deep_value"]);
  assert.equal(thin[0].stance, "out_of_scope");
  assert.match(thin[0].rationale, /missing/);
});
