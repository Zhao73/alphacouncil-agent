import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  COMPANY_SOURCE_ACQUISITION_POLICY_ID,
  acquireCompanyStarterEvidence,
  buildCompanySourceAcquisitionPlan,
  canonicalizeCompanySourceAcquisitionPacket,
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
  const reportingDate = beta.tasks.forward_expectations.find((row) => (
    row.coverage_id === "expectations.next_reporting_date"
  ));
  assert.deepEqual(reportingDate.required_terminal_stages, [
    "issuer_ir", "public_consensus", "local_observation",
  ]);
  assert.equal(reportingDate.recovery.mode, "reported_actual");
  assert.match(reportingDate.recovery.formula, /public-calendar estimate/u);

  const transcript = alpha.tasks.earnings_deep_dive.find((row) => (
    row.coverage_id === "financials.earnings_call_qna"
  ));
  assert.deepEqual(transcript.required_terminal_stages, [
    "issuer_ir", "regulator_filing", "public_market_data", "disconfirming_search",
  ]);
  assert.match(JSON.stringify(transcript), /stockanalysis\.com\/stocks\/acir\/transcripts/u);

  const shortInterest = alpha.tasks.quant_factor.find((row) => (
    row.coverage_id === "quant.short_interest_borrow"
  ));
  assert.deepEqual(shortInterest.required_terminal_stages, [
    "market_official", "local_observation", "public_market_data", "disconfirming_search", "derived_proxy",
  ]);
  assert.match(JSON.stringify(shortInterest), /site:marketbeat\.com OR site:chartexchange\.com/u);
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

test("issuer discovery pins public DNS and blocks a cross-site redirect before the second request", async () => {
  const calls = [];
  const requestImpl = (url, options, onResponse) => {
    calls.push(url);
    const request = new EventEmitter();
    request.end = () => {
      options.lookup("issuer.example", {}, (error, address, family) => {
        if (error) return request.emit("error", error);
        assert.equal(address, "93.184.216.34");
        assert.equal(family, 4);
        const response = new PassThrough();
        response.statusCode = 302;
        response.headers = { location: "https://outside.example/redirected" };
        onResponse(response);
        queueMicrotask(() => response.end());
      });
    };
    request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
    return request;
  };
  const result = await discoverIssuerOfficialSources({
    website: "https://issuer.example/",
  }, {
    lookupImpl: async () => [{ address: "93.184.216.34", family: 4 }],
    requestImpl,
    timeoutMs: 1_000,
  });
  assert.equal(calls.length, 1);
  assert.equal(result.attempts[0].status, "blocked");
  assert.match(result.attempts[0].reason, /redirect rejected/iu);
});

test("issuer discovery prioritizes current earnings detail pages over early navigation links", async () => {
  const calls = [];
  const navigation = [
    "governance-overview", "board-of-directors", "committee-composition", "investor-faqs",
    "annual-reports", "sec-filings", "news-releases", "events-presentations",
    "quarterly-results", "stock-information", "contact-us",
  ].map((path) => `<a href="https://ir.example.com/${path}">${path}</a>`);
  const earnings = '<a href="https://ir.example.com/news-release-details/example-reports-second-quarter-2026-results">Q2 results</a>';
  const fetchImpl = async (url) => {
    calls.push(url);
    const root = url === "https://ir.example.com/";
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => "text/html" },
      text: async () => root ? [...navigation, earnings].join("") : `<html><title>${url}</title><body>dated issuer evidence</body></html>`,
    };
  };
  const result = await discoverIssuerOfficialSources({
    investor_website: "https://ir.example.com/",
  }, {
    asOf: "2026-08-05",
    fetchImpl,
    timeoutMs: 1_000,
    filingIndexImpl: async () => ({ filings: [] }),
  });
  assert.equal(result.status, "succeeded");
  assert.ok(calls.includes("https://ir.example.com/news-release-details/example-reports-second-quarter-2026-results"));
  assert.ok(result.documents.some((document) => /second-quarter-2026-results/u.test(document.url)));
  assert.ok(calls.length <= 1 + 10, "the bounded detail-page limit must remain enforced");
});

test("issuer discovery follows a bounded newsroom index to dated announcement details", async () => {
  const calls = [];
  const root = "https://www.example.com/";
  const newsroom = "https://www.example.com/en-us/about/news-and-events/home/";
  const announcement = "https://www.example.com/en-us/about/news-and-events/corporate-news/2026/example-launches-current-product/";
  const fetchImpl = async (url) => {
    calls.push(url);
    const body = url === root
      ? `<a href="${newsroom}">Newsroom</a>`
      : url === newsroom
        ? `<a href="${announcement}">Current announcement</a>`
        : "<html><title>Current issuer announcement</title><script type=\"application/ld+json\">{\"datePublished\":\"2026/08/05 09:30:00\"}</script><body>August 5, 2026 dated issuer evidence</body></html>";
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => "text/html" },
      text: async () => body,
    };
  };
  const result = await discoverIssuerOfficialSources({ website: root }, {
    asOf: "2026-08-05",
    fetchImpl,
    timeoutMs: 1_000,
    filingIndexImpl: async () => ({ filings: [] }),
  });
  assert.ok(calls.includes(newsroom));
  assert.ok(calls.includes(announcement));
  assert.ok(result.documents.some((document) => document.url === announcement && document.published_at === "2026-08-05"));
  assert.ok(calls.length <= 1 + 10, "both hops must share the fixed detail-page budget");
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

test("starter evidence preserves an older management event and resolves its issuer original", async () => {
  const recentItems = Array.from({ length: 90 }, (_, index) => [
    "<item>",
    `<title>Alpha Circuit operating update ${index + 1}</title>`,
    `<link>https://press.example.com/alpha-circuit-update-${index + 1}</link>`,
    `<pubDate>Tue, 04 Aug 2026 ${String(index % 24).padStart(2, "0")}:00:00 GMT</pubDate>`,
    "</item>",
  ].join("")).join("");
  const managementItem = [
    "<item>",
    "<title>Alpha Circuit Appoints Jane Doe as Chief Procurement Officer - PR Newswire</title>",
    "<link>https://news.google.com/rss/articles/management-lead</link>",
    "<pubDate>Tue, 05 May 2026 07:00:00 GMT</pubDate>",
    "</item>",
  ].join("");
  const targetPath = "/en-us/about/news-and-events/corporate-news/2026/alpha-circuit-appoints-jane-doe-as-chief-procurement-officer/";
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "www.alpha-circuit.example" && parsed.pathname === targetPath) {
      const html = [
        "<html><title>Alpha Circuit Appoints Jane Doe as Chief Procurement Officer</title>",
        '<script type="application/ld+json">{"datePublished":"2026-05-05"}</script>',
        "<body>Alpha Circuit appointed Jane Doe as chief procurement officer.</body></html>",
      ].join("");
      return {
        ok: true,
        status: 200,
        url,
        headers: { get: () => "text/html" },
        text: async () => html,
      };
    }
    const query = parsed.searchParams.get("q") || "";
    const body = query.includes("appoints OR appointed")
      ? `<?xml version="1.0"?><rss><channel>${managementItem}</channel></rss>`
      : query.includes("earnings OR guidance")
        ? `<?xml version="1.0"?><rss><channel>${recentItems}</channel></rss>`
        : "<?xml version=\"1.0\"?><rss><channel></channel></rss>";
    return {
      ok: true,
      status: 200,
      url,
      headers: { get: () => "application/rss+xml" },
      text: async () => body,
    };
  };
  const result = await acquireCompanyStarterEvidence({
    symbol: "ACIR",
    asOf: "2026-08-05",
    profile: { name: "Alpha Circuit Corporation" },
    issuerIndex: {
      pages: ["https://www.alpha-circuit.example/en-us/about/news-and-events/corporate-news/2026/alpha-circuit-launches-product/"],
      documents: [],
    },
  }, { fetchImpl, timeoutMs: 1_000 });
  assert.equal(result.window_days, 120);
  assert.ok(result.feed_attempts.some((attempt) => attempt.topic === "management_changes" && attempt.ok));
  assert.ok(result.news.some((item) => item.topic === "management_changes" && /Jane Doe/u.test(item.title)));
  assert.ok(result.issuer_documents.some((document) => (
    document.url === `https://www.alpha-circuit.example${targetPath}`
      && document.published_at === "2026-05-05"
      && document.discovery_topic === "management_changes"
  )));
  assert.ok(result.official_lead_attempts.some((attempt) => attempt.url.endsWith(targetPath) && attempt.matched));
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

test("server-owned bindings and structured reported actuals survive real worker-shaped data", () => {
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: "VSH",
    asOf: "2026-08-05",
    profile: profile({ cik: "0000103730", name: "Vishay Intertechnology, Inc." }),
  });
  const task = "earnings_deep_dive";
  const routes = plan.tasks[task];
  const items = routes.map(exhaustiveUnavailable);
  const coverageItems = routes.map((route) => ({
    id: route.coverage_id,
    status: "unavailable",
    source_ids: [],
  }));
  const target = routes.findIndex((route) => route.coverage_id === "financials.customer_supplier_concentration");
  coverageItems[target] = {
    id: routes[target].coverage_id,
    status: "covered",
    source_ids: [`${task}:S1`],
  };
  items[target] = {
    coverage_id: routes[target].coverage_id,
    outcome: "reported_actual",
    // Ledger-only repair output may echo the worker-local spelling after packet sources have
    // already been scoped. The server must bind it to the existing source, never invent one.
    source_ids: ["S1"],
    attempts: [{
      stage: "regulator_filing",
      locator_type: "url",
      locator: "https://www.sec.gov/Archives/edgar/data/103730/form10k.htm",
      result: "succeeded",
      source_ids: ["S1"],
      note: "customer concentration disclosure",
    }],
    data: {
      period: "FY2025",
      top_30_customer_revenue_share_pct: 74,
      largest_single_customer_share: "below 10%",
    },
  };
  const packet = {
    task,
    as_of: "2026-08-05",
    sources: [{ id: `${task}:S1`, url: "https://www.sec.gov/Archives/edgar/data/103730/form10k.htm" }],
    coverage_items: coverageItems,
    acquisition_ledger: { policy_id: "worker_chosen_policy", task: "wrong_task", items },
  };
  const run = {
    council_mode: "full",
    dry_run: false,
    decision_requested: true,
    entry_tool: "analyze_symbol",
    as_of: "2026-08-05",
    grounding: { instrument: { research_model: "operating_company" }, source_acquisition_plan: plan },
  };
  canonicalizeCompanySourceAcquisitionPacket(packet, run);
  assert.equal(packet.acquisition_ledger.policy_id, COMPANY_SOURCE_ACQUISITION_POLICY_ID);
  assert.equal(packet.acquisition_ledger.task, task);
  assert.deepEqual(packet.acquisition_ledger.items[target].source_ids, [`${task}:S1`]);
  assert.deepEqual(packet.acquisition_ledger.items[target].attempts[0].source_ids, [`${task}:S1`]);
  const observations = packet.acquisition_ledger.items[target].data.observations;
  assert.equal(observations.length, 2);
  assert.equal(observations[0].period, "FY2025");
  assert.equal(observations[0].scope, routes[target].coverage_id);
  assert.ok(observations.some((row) => row.unit === "%" && row.value === 74));
  assert.deepEqual(companySourceAcquisitionIssues(packet, run), []);
});

test("all-scope supplemental analysts do not own synthetic 52-item acquisition routes", () => {
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: "VSH",
    asOf: "2026-08-05",
    profile: profile({ cik: "0000103730", name: "Vishay Intertechnology, Inc." }),
  });
  const run = {
    council_mode: "full",
    dry_run: false,
    decision_requested: true,
    entry_tool: "analyze_symbol",
    grounding: { instrument: { research_model: "operating_company" }, source_acquisition_plan: plan },
  };
  for (const task of ["macro_regime", "market_narrative", "social_pulse"]) {
    const packet = {
      task,
      acquisition_ledger: { policy_id: "wrong", task: "wrong", items: [{ malformed: true }] },
    };
    assert.deepEqual(companySourceAcquisitionIssues(packet, run), []);
    assert.equal(Object.hasOwn(packet, "acquisition_ledger"), false);
    assert.equal(sourceAcquisitionPromptBlock(plan, task, "中文"), "");
  }
});

test("canonicalization never invents an unknown numeric unit or substitutes as_of for period", () => {
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: "VSH",
    asOf: "2026-08-05",
    profile: profile({ cik: "0000103730", name: "Vishay Intertechnology, Inc." }),
  });
  const task = "earnings_deep_dive";
  const routes = plan.tasks[task];
  const items = routes.map(exhaustiveUnavailable);
  const target = 0;
  items[target] = {
    coverage_id: routes[target].coverage_id,
    outcome: "reported_actual",
    source_ids: ["S1"],
    attempts: [{
      stage: routes[target].required_terminal_stages.find((stage) => ["regulator_filing", "issuer_ir"].includes(stage)),
      locator_type: "url",
      locator: "https://www.sec.gov/Archives/edgar/data/103730/form10k.htm",
      result: "succeeded",
      source_ids: ["S1"],
    }],
    data: { unexplained_numeric: 123 },
  };
  const packet = {
    task,
    as_of: "2026-08-05",
    sources: [{ id: `${task}:S1`, url: "https://www.sec.gov/Archives/edgar/data/103730/form10k.htm" }],
    coverage_items: routes.map((route, index) => ({
      id: route.coverage_id,
      status: index === target ? "covered" : "unavailable",
      source_ids: index === target ? [`${task}:S1`] : [],
    })),
    acquisition_ledger: { items },
  };
  const run = {
    council_mode: "full",
    dry_run: false,
    decision_requested: true,
    entry_tool: "analyze_symbol",
    as_of: "2026-08-05",
    grounding: { instrument: { research_model: "operating_company" }, source_acquisition_plan: plan },
  };
  canonicalizeCompanySourceAcquisitionPacket(packet, run);
  const observation = packet.acquisition_ledger.items[target].data.observations[0];
  assert.equal(observation.unit, null);
  assert.equal(observation.period, null);
  assert.equal(packet.acquisition_ledger.items[target].proposed_outcome, "reported_actual");
  assert.equal(packet.acquisition_ledger.items[target].outcome, "unavailable");
  assert.match(packet.acquisition_ledger.items[target].reason, /not publishable/u);
  const issues = companySourceAcquisitionIssues(packet, run);
  assert.ok(issues.some((issue) => issue.keyword === "exhaustive"));
  assert.ok(!issues.some((issue) => issue.path.endsWith("/unit") || issue.path.endsWith("/period")));
});

function acquisitionFixture({ task, targetId, item, covered = true }) {
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: "VSH",
    asOf: "2026-08-05",
    profile: profile({ cik: "0000103730", name: "Vishay Intertechnology, Inc." }),
  });
  const routes = plan.tasks[task];
  const target = routes.findIndex((route) => route.coverage_id === targetId);
  assert.notEqual(target, -1, `missing fixture route ${targetId}`);
  const sourceId = `${task}:S1`;
  const items = routes.map(exhaustiveUnavailable);
  items[target] = typeof item === "function" ? item(routes[target], sourceId) : item;
  const packet = {
    task,
    as_of: "2026-08-05",
    sources: [{ id: sourceId, url: "https://example.com/dated-source" }],
    coverage_items: routes.map((route, index) => ({
      id: route.coverage_id,
      status: index === target && covered ? "covered" : "unavailable",
      source_ids: index === target && covered ? [sourceId] : [],
    })),
    acquisition_ledger: { items },
  };
  const run = {
    council_mode: "full",
    dry_run: false,
    decision_requested: true,
    entry_tool: "analyze_symbol",
    as_of: "2026-08-05",
    grounding: { instrument: { research_model: "operating_company" }, source_acquisition_plan: plan },
  };
  return { packet, plan, route: routes[target], run, sourceId, target };
}

test("an unavailable field treats an opened cited page as not_disclosed rather than data success", () => {
  const { packet, run, target, sourceId } = acquisitionFixture({
    task: "earnings_deep_dive",
    targetId: "financials.customer_supplier_concentration",
    covered: false,
    item: (route, citedSourceId) => {
      const item = exhaustiveUnavailable(route);
      item.attempts[0] = {
        ...item.attempts[0],
        result: "succeeded",
        source_ids: [citedSourceId],
        note: "The cited filing opened but did not disclose the requested scalar.",
      };
      return item;
    },
  });
  canonicalizeCompanySourceAcquisitionPacket(packet, run);
  assert.equal(packet.acquisition_ledger.items[target].attempts[0].result, "not_disclosed");
  assert.equal(packet.acquisition_ledger.items[target].attempts[0].proposed_result, "succeeded");
  assert.deepEqual(companySourceAcquisitionIssues(packet, run), []);
});

test("route-appropriate public and local observations can publish cited direct actuals", () => {
  const fixtures = [
    {
      task: "market_data",
      targetId: "market.quote_snapshot",
      stage: "local_observation",
      metric: "close_price",
      unit: "USD per share",
    },
    {
      task: "forward_expectations",
      targetId: "expectations.consensus_revenue_eps",
      stage: "public_consensus",
      metric: "public_sample_revenue",
      unit: "USD million",
    },
  ];
  for (const fixture of fixtures) {
    const { packet, run, sourceId } = acquisitionFixture({
      task: fixture.task,
      targetId: fixture.targetId,
      item: (route, sourceId) => ({
        coverage_id: route.coverage_id,
        outcome: "reported_actual",
        source_ids: [sourceId],
        attempts: [{
          stage: fixture.stage,
          locator_type: fixture.stage === "local_observation" ? "local" : "url",
          locator: fixture.stage === "local_observation" ? "snapshot:2026-08-05" : "https://example.com/consensus",
          result: "succeeded",
          source_ids: [sourceId],
        }],
        data: {
          observations: [{
            metric: fixture.metric,
            value: 123.45,
            unit: fixture.unit,
            period: "2026-08-05 close",
            scope: route.coverage_id,
          }],
        },
      }),
    });
    canonicalizeCompanySourceAcquisitionPacket(packet, run);
    assert.equal(packet.acquisition_ledger.items.find((row) => row.coverage_id === fixture.targetId).outcome, "reported_actual");
    assert.deepEqual(companySourceAcquisitionIssues(packet, run), []);
  }
});

test("public market-data stage aliases normalize without posing as an official source", () => {
  for (const proposedStage of ["market_data_provider", "market_data", "public_market_data"]) {
    const fixture = acquisitionFixture({
      task: "market_data",
      targetId: "market.quote_snapshot",
      item: (route, sourceId) => ({
        coverage_id: route.coverage_id,
        outcome: "reported_actual",
        source_ids: [sourceId],
        attempts: [
          ...exhaustiveUnavailable(route).attempts,
          {
            stage: proposedStage,
            locator_type: "url",
            locator: "https://stockanalysis.com/stocks/vsh/history/",
            result: "succeeded",
            source_ids: [sourceId],
          },
        ],
        data: {
          observations: [{
            metric: "close_price",
            value: 38.85,
            unit: "USD per share",
            period: "2026-08-04 close",
            scope: "VSH regular-session close",
          }],
        },
      }),
    });
    canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run);
    const row = fixture.packet.acquisition_ledger.items[fixture.target];
    const supplemental = row.attempts.at(-1);
    assert.equal(supplemental.stage, "public_market_data");
    assert.equal(supplemental.proposed_stage, proposedStage === "public_market_data" ? undefined : proposedStage);
    assert.equal(row.outcome, "reported_actual");
    assert.deepEqual(companySourceAcquisitionIssues(fixture.packet, fixture.run), []);
  }
});

test("a public speaker-labelled transcript can cover only the earnings-call Q&A route", () => {
  const fixture = acquisitionFixture({
    task: "earnings_deep_dive",
    targetId: "financials.earnings_call_qna",
    item: (route, sourceId) => ({
      coverage_id: route.coverage_id,
      outcome: "reported_actual",
      source_ids: [sourceId],
      attempts: route.required_terminal_stages.map((stage) => ({
        stage,
        locator_type: stage === "public_market_data" ? "url" : "query",
        locator: stage === "public_market_data"
          ? "https://stockanalysis.com/stocks/acir/transcripts/123-q2-2026/"
          : `${stage}:${route.coverage_id}`,
        result: stage === "public_market_data" ? "succeeded" : "not_disclosed",
        source_ids: stage === "public_market_data" ? [sourceId] : [],
      })),
      data: {
        observations: [{
          metric: "speaker_labelled_q_and_a",
          value: true,
          unit: "boolean",
          period: "2026Q2",
          scope: "secondary public transcript; not issuer-authored",
        }],
      },
    }),
  });
  canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run);
  const row = fixture.packet.acquisition_ledger.items[fixture.target];
  assert.equal(row.outcome, "reported_actual");
  assert.deepEqual(companySourceAcquisitionIssues(fixture.packet, fixture.run), []);
});

test("a public market page cannot bypass the frozen terminal ladder", () => {
  const actual = acquisitionFixture({
    task: "market_data",
    targetId: "market.quote_snapshot",
    item: (route, sourceId) => ({
      coverage_id: route.coverage_id,
      outcome: "reported_actual",
      source_ids: [sourceId],
      attempts: [{
        stage: "market_data_provider",
        locator_type: "url",
        locator: "https://stockanalysis.com/stocks/vsh/history/",
        result: "succeeded",
        source_ids: [sourceId],
      }],
      data: {
        observations: [{
          metric: "close_price",
          value: 38.85,
          unit: "USD per share",
          period: "2026-08-04 close",
          scope: "VSH regular-session close",
        }],
      },
    }),
  });
  canonicalizeCompanySourceAcquisitionPacket(actual.packet, actual.run);
  const actualRow = actual.packet.acquisition_ledger.items[actual.target];
  assert.equal(actualRow.outcome, "unavailable");
  assert.equal(actualRow.proposed_outcome, "reported_actual");
  assert.ok(companySourceAcquisitionIssues(actual.packet, actual.run).some((issue) => issue.keyword === "exhaustive"));

  const proxy = acquisitionFixture({
    task: "market_data",
    targetId: "market.technical_levels",
    item: (route, sourceId) => ({
      coverage_id: route.coverage_id,
      outcome: "recomputed_proxy",
      source_ids: [sourceId],
      attempts: [
        {
          stage: "market_data",
          locator_type: "url",
          locator: "https://stockanalysis.com/stocks/vsh/statistics/",
          result: "succeeded",
          source_ids: [sourceId],
        },
        {
          stage: "derived_proxy",
          locator_type: "local",
          locator: "derive:price_vs_50dma",
          result: "succeeded",
          source_ids: [],
        },
      ],
      data: {
        observations: [{
          metric: "price_vs_50dma",
          value: -20.71,
          unit: "percent",
          period: "2026-08-04",
          scope: "VSH close relative to 50-day moving average",
          formula: "(close / ma_50 - 1) * 100",
          inputs: [{ name: "close", value: 38.85, source_ids: [sourceId] }],
        }],
      },
    }),
  });
  canonicalizeCompanySourceAcquisitionPacket(proxy.packet, proxy.run);
  const proxyRow = proxy.packet.acquisition_ledger.items[proxy.target];
  assert.equal(proxyRow.outcome, "unavailable");
  assert.equal(proxyRow.proposed_outcome, "recomputed_proxy");
  assert.ok(companySourceAcquisitionIssues(proxy.packet, proxy.run).some((issue) => issue.keyword === "exhaustive"));
});

test("public market data cannot masquerade as expectations consensus", () => {
  const fixture = acquisitionFixture({
    task: "forward_expectations",
    targetId: "expectations.consensus_revenue_eps",
    item: (route, sourceId) => ({
      coverage_id: route.coverage_id,
      outcome: "reported_actual",
      source_ids: [sourceId],
      attempts: [
        ...exhaustiveUnavailable(route).attempts,
        {
          stage: "public_market_data",
          locator_type: "url",
          locator: "https://stockanalysis.com/stocks/vsh/forecast/",
          result: "succeeded",
          source_ids: [sourceId],
        },
      ],
      data: {
        observations: [{
          metric: "consensus_revenue",
          value: 960,
          unit: "USD million",
          period: "2026Q3",
          scope: "public sample",
        }],
      },
    }),
  });
  canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run);
  const row = fixture.packet.acquisition_ledger.items[fixture.target];
  assert.equal(row.outcome, "unavailable");
  assert.equal(row.proposed_outcome, "reported_actual");
  assert.deepEqual(companySourceAcquisitionIssues(fixture.packet, fixture.run), []);
});

test("sourced partial coverage remains covered while an exact scalar stays unavailable", () => {
  const fixture = acquisitionFixture({
    task: "market_data",
    targetId: "market.price_history_range",
    item: (route, sourceId) => ({
      coverage_id: route.coverage_id,
      outcome: "unavailable",
      source_ids: [sourceId],
      attempts: route.required_terminal_stages.map((stage, index) => ({
        stage,
        locator_type: stage === "local_observation" || stage === "derived_proxy" ? "local" : "query",
        locator: `${stage}:${route.coverage_id}`,
        result: index === 0 ? "succeeded" : "not_disclosed",
        source_ids: index === 0 ? [sourceId] : [],
      })),
      reason: "The cited source covers the price-history domain, but the exact requested range was not disclosed in a publishable shape.",
    }),
  });
  canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run);
  assert.deepEqual(companySourceAcquisitionIssues(fixture.packet, fixture.run), []);
});

test("server binds covered-domain sources to an exhaustively unavailable ledger row", () => {
  const fixture = acquisitionFixture({
    task: "quant_factor",
    targetId: "quant.relative_strength_factors",
    item: (route) => exhaustiveUnavailable(route),
  });
  canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run);
  const row = fixture.packet.acquisition_ledger.items[fixture.target];
  assert.equal(row.outcome, "unavailable");
  assert.deepEqual(row.source_ids, [fixture.sourceId]);
  assert.ok(row.attempts.every((attempt) => attempt.result !== "succeeded"));
  assert.deepEqual(companySourceAcquisitionIssues(fixture.packet, fixture.run), []);
});

test("object inputs normalize into cited rows for a recomputed proxy", () => {
  const fixture = acquisitionFixture({
    task: "quant_factor",
    targetId: "quant.options_iv_skew_expected_move",
    item: (route, sourceId) => ({
      coverage_id: route.coverage_id,
      outcome: "recomputed_proxy",
      source_ids: [sourceId],
      attempts: [
        {
          stage: "market_official", locator_type: "url", locator: "https://example.com/options",
          result: "succeeded", source_ids: [sourceId],
        },
        {
          stage: "derived_proxy", locator_type: "local", locator: "derive:expected-move",
          result: "succeeded", source_ids: [],
        },
      ],
      data: {
        value: 4.2,
        unit: "% of spot",
        period: "next listed expiry as of 2026-08-05",
        formula: "at-the-money straddle divided by spot",
        inputs: {
          option_snapshot: { value: "dated chain", source_ids: [sourceId] },
          spot: 123.45,
        },
      },
    }),
  });
  canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run);
  const row = fixture.packet.acquisition_ledger.items[fixture.target];
  assert.ok(Array.isArray(row.data.inputs));
  assert.deepEqual(row.data.inputs[0].source_ids, [fixture.sourceId]);
  assert.deepEqual(companySourceAcquisitionIssues(fixture.packet, fixture.run), []);
});

test("an incomplete modeled range is preserved as a proposal but fails closed to unavailable", () => {
  const fixture = acquisitionFixture({
    task: "earnings_deep_dive",
    targetId: "financials.customer_supplier_concentration",
    item: (route, sourceId) => ({
      coverage_id: route.coverage_id,
      outcome: "modeled_estimate",
      source_ids: [sourceId],
      attempts: route.required_terminal_stages.map((stage) => ({
        stage,
        locator_type: stage === "derived_proxy" ? "local" : "query",
        locator: `${stage}:${route.coverage_id}`,
        result: stage === "regulator_filing" || stage === "derived_proxy" ? "succeeded" : "not_disclosed",
        source_ids: stage === "regulator_filing" ? [sourceId] : [],
      })),
      data: {
        range: { low: 0, base: null, high: null },
        unit: "% of revenue",
        period: "FY2026 scenario",
        formula: "bound from disclosed concentration",
        assumptions: ["No anonymous customer is assigned a name."],
      },
    }),
  });
  canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run);
  const row = fixture.packet.acquisition_ledger.items[fixture.target];
  assert.equal(row.outcome, "unavailable");
  assert.equal(row.proposed_outcome, "modeled_estimate");
  assert.equal(row.data.range.base, null);
  assert.deepEqual(companySourceAcquisitionIssues(fixture.packet, fixture.run), []);
});

test("an external page-open success without a source id is normalized to not_disclosed", () => {
  const fixture = acquisitionFixture({
    task: "ib_event_analysis",
    targetId: "events.mna_strategic_transactions",
    covered: false,
    item: (route) => ({
      ...exhaustiveUnavailable(route),
      attempts: route.required_terminal_stages.map((stage, index) => ({
        stage,
        locator_type: stage === "derived_proxy" ? "local" : "query",
        locator: `${stage}:${route.coverage_id}`,
        result: index === 0 ? "succeeded" : "not_disclosed",
        source_ids: [],
      })),
    }),
  });
  canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run);
  const attempt = fixture.packet.acquisition_ledger.items[fixture.target].attempts[0];
  assert.equal(attempt.result, "not_disclosed");
  assert.equal(attempt.proposed_result, "succeeded");
  assert.deepEqual(companySourceAcquisitionIssues(fixture.packet, fixture.run), []);
});

test("known extra acquisition stages are auditable but unknown stages are rejected", () => {
  const fixture = acquisitionFixture({
    task: "market_data",
    targetId: "market.quote_snapshot",
    covered: false,
    item: (route) => ({
      ...exhaustiveUnavailable(route),
      attempts: [
        ...exhaustiveUnavailable(route).attempts,
        {
          stage: "court_record", locator_type: "query", locator: "court_record:extra-check",
          result: "not_disclosed", source_ids: [],
        },
      ],
    }),
  });
  canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run);
  assert.deepEqual(companySourceAcquisitionIssues(fixture.packet, fixture.run), []);
  const unknown = structuredClone(fixture.packet);
  unknown.acquisition_ledger.items[fixture.target].attempts.at(-1).stage = "invented_worker_stage";
  assert.ok(companySourceAcquisitionIssues(unknown, fixture.run).some((issue) => issue.keyword === "enum"));
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
  assert.match(prompt, /company_source_acquisition_v1/u);
  assert.match(prompt, /task:"quant_factor"/u);
  assert.match(prompt, /observations/u);
});
