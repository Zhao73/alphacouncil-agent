import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMPANY_SOURCE_ACQUISITION_POLICY_ID,
  acquireCompanyStarterEvidence,
  buildCompanySourceAcquisitionPlan,
  companySourceAcquisitionIssues,
  discoverIssuerOfficialSources,
  discoverIssuerRootsFromFilings,
  sourceAcquisitionPromptBlock,
} from "../../mcp/lib/company-source-acquisition.mjs";

function profile({ cik, name, investorWebsite, website, sic = "3571" }) {
  return {
    cik,
    name,
    investor_website: investorWebsite,
    website,
    sic,
    sic_description: "Electronic Computers",
    submissions_url: `https://data.sec.gov/submissions/CIK${cik}.json`,
  };
}

test("company source plans are issuer-driven rather than ticker-specific", () => {
  const alpha = buildCompanySourceAcquisitionPlan({
    symbol: "ACIR",
    asOf: "2026-08-05",
    profile: profile({
      cik: "0001045810",
      name: "Alpha Circuit Corporation",
      investorWebsite: "https://investor.alpha-circuit.example/",
      website: "https://www.alpha-circuit.example/",
    }),
  });
  const beta = buildCompanySourceAcquisitionPlan({
    symbol: "BETA",
    asOf: "2026-08-05",
    profile: profile({
      cik: "0001652044",
      name: "Beta Search Holdings",
      investorWebsite: "https://beta-search.example/investor/",
      website: "https://beta-search.example/",
    }),
  });
  const ids = (plan) => Object.values(plan.tasks).flat().map((row) => row.coverage_id).sort();
  assert.equal(alpha.policy_id, COMPANY_SOURCE_ACQUISITION_POLICY_ID);
  assert.equal(ids(alpha).length, 52);
  assert.deepEqual(ids(alpha), ids(beta));
  assert.match(JSON.stringify(alpha), /investor\.alpha-circuit\.example/u);
  assert.match(JSON.stringify(beta), /beta-search\.example\/investor/u);
  assert.doesNotMatch(JSON.stringify(beta), /alpha-circuit/iu);
  const gapRoute = beta.tasks.news_industry_management.find((row) => row.coverage_id === "news.customers_suppliers_partners");
  assert.deepEqual(gapRoute.required_terminal_stages, [
    "customer_official", "supplier_official", "issuer_ir", "regulator_filing", "derived_proxy",
  ]);
  assert.equal(gapRoute.recovery.mode, "modeled_estimate");
});

test("non-US companies receive their own regulator and market routes", () => {
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: "7203.T",
    asOf: "2026-08-05",
    profile: {
      name: "Example Motors",
      tickers: ["7203.T"],
      market_id: "JP",
    },
  });
  assert.match(plan.regulator_entry_url, /edinet-fsa\.go\.jp/u);
  const financials = plan.tasks.earnings_deep_dive.find((row) => row.coverage_id === "financials.historical_statements");
  const regulator = financials.stages.find((stage) => stage.stage === "regulator_filing");
  assert.match(JSON.stringify(regulator), /site:edinet-fsa\.go\.jp/u);
  assert.doesNotMatch(JSON.stringify(regulator), /site:sec\.gov/u);
  const market = plan.tasks.market_data[0].stages.find((stage) => stage.stage === "market_official");
  assert.match(JSON.stringify(market), /site:jpx\.co\.jp/u);
});

test("issuer discovery keeps same-site official links and rejects unrelated links", async () => {
  const html = [
    '<a href="/investor/earnings/2026-q2">earnings</a>',
    '<a href="https://news.example.com/press/product-x">press</a>',
    '<a href="https://unrelated.example.net/news/leak">external</a>',
    '<a href="/careers">careers</a>',
  ].join("");
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    url,
    headers: { get: () => "text/html" },
    text: async () => html,
  });
  const result = await discoverIssuerOfficialSources({
    investor_website: "https://investor.example.com/",
    website: "https://www.example.com/",
  }, { fetchImpl, timeoutMs: 1_000 });
  assert.equal(result.status, "succeeded");
  assert.ok(result.pages.some((url) => /investor\/earnings/u.test(url)));
  assert.ok(result.pages.some((url) => /news\.example\.com\/press/u.test(url)));
  assert.ok(result.pages.every((url) => !/unrelated\.example\.net/u.test(url)));
  assert.ok(result.pages.every((url) => !/\/careers$/u.test(url)));
  assert.ok(result.documents.every((document) => document.excerpt));
});

test("SEC filing text discovers issuer-owned roots without a ticker exception", async () => {
  const filingIndexImpl = async () => ({
    filings: [{
      form: "10-K",
      accession: "0000000001-26-000001",
      primary_document: "annual.htm",
      filing_date: "2026-07-30",
      accepted_at: "2026-07-30T12:00:00Z",
    }],
  });
  const filingDocumentImpl = async () => ({
    url: "https://www.sec.gov/Archives/example.htm",
    text: [
      "<html><body>Our investor relations website is located at investor.alpha-circuit.example/investors.",
      "Follow us at linkedin.com/company/alpha-circuit.",
      "A vendor document is available at investor.unrelated-vendor.example.</body></html>",
    ].join(" "),
  });
  const result = await discoverIssuerRootsFromFilings({
    cik: "0000000001",
    name: "Alpha Circuit Corporation",
    tickers: ["ACIR"],
  }, {
    asOf: "2026-08-05",
    filingIndexImpl,
    filingDocumentImpl,
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.roots, ["https://investor.alpha-circuit.example/investors"]);
});

test("adaptive starter evidence retrieves dated cross-topic content without an API key", async () => {
  const rss = [
    "<?xml version=\"1.0\"?><rss><channel><item>",
    "<title>Alphabet announces a dated operating update</title>",
    "<link>https://example.com/alphabet-update</link>",
    "<pubDate>Tue, 04 Aug 2026 12:00:00 GMT</pubDate>",
    "</item><item>",
    "<title>An unrelated market roundup</title>",
    "<link>https://example.com/unrelated</link>",
    "<pubDate>Tue, 04 Aug 2026 11:00:00 GMT</pubDate>",
    "</item></channel></rss>",
  ].join("");
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    url,
    text: async () => rss,
  });
  const result = await acquireCompanyStarterEvidence({
    symbol: "GOOGL",
    asOf: "2026-08-05",
    profile: {
      name: "Alphabet Inc.",
      recent_filings: [{
        form: "8-K",
        filing_date: "2026-08-01",
        accepted_at: "2026-08-01T12:00:00Z",
        primary_document_url: "https://www.sec.gov/Archives/edgar/data/1652044/example.htm",
      }],
    },
  }, { fetchImpl, timeoutMs: 1_000, days: 45 });
  assert.equal(result.source_status, "succeeded");
  assert.equal(result.filings.length, 1);
  assert.equal(result.news.length, 1);
  assert.equal(result.news[0].topic, "ticker_news");
  assert.ok(result.excluded_irrelevant >= result.feed_attempts.length);
  assert.ok(result.feed_attempts.length >= 6);
  assert.ok(result.feed_attempts.every((attempt) => attempt.ok));
});

function exhaustiveUnavailable(route) {
  return {
    coverage_id: route.coverage_id,
    outcome: "unavailable",
    source_ids: [],
    attempts: route.required_terminal_stages.map((stage) => ({
      stage,
      locator_type: stage === "derived_proxy" || stage === "local_observation" ? "local" : "query",
      locator: `${stage}:${route.coverage_id}`,
      result: "not_disclosed",
      source_ids: [],
      note: "fixture attempted the frozen route",
    })),
    reason: "Every frozen route was attempted; no actual or defensible proxy input was disclosed.",
  };
}

test("the acquisition gate rejects a lazy gap and accepts an audited modeled range", () => {
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: "GOOGL",
    asOf: "2026-08-05",
    profile: profile({ cik: "0001652044", name: "Alphabet Inc." }),
  });
  const task = "earnings_deep_dive";
  const routes = plan.tasks[task];
  const coverageItems = routes.map((route) => ({
    id: route.coverage_id,
    status: "unavailable",
    source_ids: [],
  }));
  const items = routes.map(exhaustiveUnavailable);
  const targetIndex = routes.findIndex((route) => route.coverage_id === "financials.customer_supplier_concentration");
  coverageItems[targetIndex] = {
    id: routes[targetIndex].coverage_id,
    status: "covered",
    source_ids: [`${task}:S1`],
  };
  items[targetIndex] = {
    coverage_id: routes[targetIndex].coverage_id,
    outcome: "modeled_estimate",
    source_ids: [`${task}:S1`],
    attempts: [
      {
        stage: "regulator_filing", locator_type: "url", locator: "https://sec.example/filing",
        result: "succeeded", source_ids: [`${task}:S1`], note: "official filing input",
      },
      {
        stage: "derived_proxy", locator_type: "local", locator: "derive:concentration",
        result: "succeeded", source_ids: [], note: "bounded scenario",
      },
    ],
    data: {
      range: { low: 20, base: 30, high: 45 },
      unit: "% of revenue exposed",
      period: "FY2026",
      formula: "triangulate disclosed concentration and customer capex",
      assumptions: ["anonymous customers are not assigned a name"],
    },
  };
  const packet = {
    task,
    sources: [{ id: `${task}:S1`, url: "https://sec.example/filing" }],
    coverage_items: coverageItems,
    acquisition_ledger: { policy_id: COMPANY_SOURCE_ACQUISITION_POLICY_ID, task, items },
  };
  const run = {
    council_mode: "full",
    dry_run: false,
    decision_requested: true,
    entry_tool: "analyze_symbol",
    grounding: { instrument: { research_model: "operating_company" }, source_acquisition_plan: plan },
  };
  assert.deepEqual(companySourceAcquisitionIssues(packet, run), []);

  const lazy = structuredClone(packet);
  lazy.acquisition_ledger.items[0].attempts.pop();
  assert.ok(companySourceAcquisitionIssues(lazy, run).some((issue) => issue.keyword === "exhaustive"));
});

test("the prompt contract requires actual, proxy, model, or an exhausted ladder", () => {
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: "ACME",
    asOf: "2026-08-05",
    profile: profile({ cik: "0000000001", name: "Acme Corporation" }),
  });
  const prompt = sourceAcquisitionPromptBlock(plan, "quant_factor", "中文");
  assert.match(prompt, /reported_actual/u);
  assert.match(prompt, /recomputed_proxy/u);
  assert.match(prompt, /modeled_estimate/u);
  assert.match(prompt, /required_terminal_stages/u);
});
