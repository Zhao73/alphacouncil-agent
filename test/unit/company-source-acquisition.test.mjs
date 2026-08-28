import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";

import {
  COMPANY_SOURCE_ACQUISITION_POLICY_ID,
  FAST_QUANT_MAX_QUERY_LOCATORS,
  FAST_QUANT_MAX_URL_LOCATORS,
  FAST_VALUATION_MAX_QUERY_LOCATORS,
  FAST_VALUATION_MAX_URL_LOCATORS,
  acquireCompanyStarterEvidence,
  buildCompanySourceAcquisitionPlan,
  canonicalizeCompanySourceAcquisitionPacket,
  companySourceAcquisitionIssues,
  discoverIssuerOfficialSources,
  discoverIssuerRootsFromFilings,
  secPrimaryDocumentEvidenceIssues,
  secPrimaryDocumentRepairPromptBlock,
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

test("starter evidence exposes a server-read raw SEC XML document instead of only its XSL alias", async () => {
  const feed = "<?xml version=\"1.0\"?><rss><channel></channel></rss>";
  const body = [
    "<?xml version=\"1.0\"?><ownershipDocument>",
    "<documentType>4</documentType><periodOfReport>2026-08-25</periodOfReport>",
    "<rptOwnerName>Example Officer</rptOwnerName><transactionShares><value>1439</value></transactionShares>",
    "<transactionPricePerShare><value>310.95</value></transactionPricePerShare>",
    "<sharesOwnedFollowingTransaction><value>37229</value></sharesOwnedFollowingTransaction>",
    "<aff10b5One>1</aff10b5One><dateOfPlanAdoption>2026-05-05</dateOfPlanAdoption>",
    "</ownershipDocument>",
  ].join("");
  let requested = null;
  const result = await acquireCompanyStarterEvidence({
    symbol: "ACIR",
    asOf: "2026-08-28",
    profile: {
      cik: "0001045810",
      name: "Alpha Circuit Corporation",
      recent_filings: [{
        form: "4",
        accession: "0001045810-26-000062",
        primary_document: "xslF345X06/form4.xml",
        primary_document_url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000062/xslF345X06/form4.xml",
        filing_date: "2026-08-27",
        report_date: "2026-08-25",
        accepted_at: "2026-08-27T18:30:30.000Z",
      }],
    },
  }, {
    fetchImpl: async (url) => ({ ok: true, status: 200, url, headers: { get: () => "application/rss+xml" }, text: async () => feed }),
    filingDocumentImpl: async (cik, accession, document) => {
      requested = { cik, accession, document };
      return {
        url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000062/form4.xml",
        text: body,
        cache_status: "miss",
      };
    },
    timeoutMs: 1_000,
  });

  assert.deepEqual(requested, {
    cik: "0001045810",
    accession: "0001045810-26-000062",
    document: "form4.xml",
  });
  const evidence = result.sec_primary_document_evidence;
  const document = evidence.documents[0];
  assert.equal(evidence.schema_version, "sec_primary_document_evidence_v1");
  assert.equal(evidence.attempts[0].status, "succeeded");
  assert.equal(evidence.attempts[0].requested_document, "xslF345X06/form4.xml");
  assert.equal(evidence.documents.length, 1);
  assert.match(document.raw_url, /\/form4\.xml$/u);
  assert.match(document.index_url, /0001045810-26-000062-index\.html$/u);
  assert.equal(document.persisted_text_byte_length, Buffer.byteLength(body, "utf8"));
  assert.equal(document.persisted_text_sha256, `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`);
  assert.equal(document.excerpt_byte_length, Buffer.byteLength(document.excerpt, "utf8"));
  assert.equal(document.excerpt_sha256, `sha256:${createHash("sha256").update(document.excerpt, "utf8").digest("hex")}`);
  assert.match(document.grounding_document_ref, /^sec-primary-document-v1:[a-f0-9]{64}$/u);
  assert.match(document.excerpt, /Example Officer.*1439.*310\.95.*37229.*2026-05-05/u);
});

test("a failed raw SEC XML prefetch remains an explicit attempt and creates no excerpt", async () => {
  const feed = "<?xml version=\"1.0\"?><rss><channel></channel></rss>";
  const result = await acquireCompanyStarterEvidence({
    symbol: "ACIR",
    asOf: "2026-08-28",
    profile: {
      cik: "0001045810",
      name: "Alpha Circuit Corporation",
      recent_filings: [{
        form: "4",
        accession: "0001045810-26-000062",
        primary_document: "xslF345X06/form4.xml",
        primary_document_url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000062/xslF345X06/form4.xml",
        filing_date: "2026-08-27",
        accepted_at: "2026-08-27T18:30:30.000Z",
      }],
    },
  }, {
    fetchImpl: async (url) => ({ ok: true, status: 200, url, headers: { get: () => "application/rss+xml" }, text: async () => feed }),
    filingDocumentImpl: async () => { throw new Error("HTTP 403 from SEC primary document"); },
    timeoutMs: 1_000,
  });

  assert.deepEqual(result.sec_primary_document_evidence.documents, []);
  assert.equal(result.sec_primary_document_evidence.attempts[0].status, "unreachable");
  assert.match(result.sec_primary_document_evidence.attempts[0].reason, /HTTP 403/u);
});

test("starter SEC evidence excludes post-cutoff filings before choosing the latest raw document", async () => {
  const feed = "<?xml version=\"1.0\"?><rss><channel></channel></rss>";
  const requested = [];
  const result = await acquireCompanyStarterEvidence({
    symbol: "ACIR",
    asOf: "2026-08-28",
    profile: {
      cik: "0001045810",
      name: "Alpha Circuit Corporation",
      recent_filings: [
        {
          form: "4", accession: "0001045810-26-000099", primary_document: "xslF345X06/future.xml",
          filing_date: "2026-08-29", accepted_at: "2026-08-29T00:00:01.000Z",
        },
        {
          form: "4", accession: "0001045810-26-000062", primary_document: "xslF345X06/form4.xml",
          filing_date: "2026-08-27", accepted_at: "2026-08-27T18:30:30.000Z",
        },
      ],
    },
  }, {
    fetchImpl: async (url) => ({ ok: true, status: 200, url, headers: { get: () => "application/rss+xml" }, text: async () => feed }),
    filingDocumentImpl: async (cik, accession, document) => {
      requested.push({ cik, accession, document });
      return {
        url: `https://www.sec.gov/Archives/edgar/data/1045810/${accession.replace(/-/gu, "")}/${document}`,
        text: "<ownershipDocument><rptOwnerName>Cutoff-safe officer</rptOwnerName></ownershipDocument>",
      };
    },
    timeoutMs: 1_000,
  });

  assert.deepEqual(requested, [{
    cik: "0001045810", accession: "0001045810-26-000062", document: "form4.xml",
  }]);
  assert.deepEqual(result.filings.map((filing) => filing.accession), ["0001045810-26-000062"]);
});

test("a slow SEC primary-document probe times out inside the starter-evidence budget", async () => {
  const feed = "<?xml version=\"1.0\"?><rss><channel></channel></rss>";
  const started = Date.now();
  const result = await acquireCompanyStarterEvidence({
    symbol: "ACIR",
    asOf: "2026-08-28",
    profile: {
      cik: "0001045810",
      recent_filings: [{
        form: "4", accession: "0001045810-26-000062", primary_document: "xslF345X06/form4.xml",
        filing_date: "2026-08-27", accepted_at: "2026-08-27T18:30:30.000Z",
      }],
    },
  }, {
    fetchImpl: async (url) => ({ ok: true, status: 200, url, headers: { get: () => "application/rss+xml" }, text: async () => feed }),
    filingDocumentImpl: async () => new Promise(() => {}),
    timeoutMs: 20,
  });

  assert.ok(Date.now() - started < 500);
  assert.equal(result.sec_primary_document_evidence.attempts[0].status, "unreachable");
  assert.match(result.sec_primary_document_evidence.attempts[0].reason, /timed out after 20ms/u);
});

test("an oversized SEC primary document is rejected instead of entering the analyst prompt", async () => {
  const feed = "<?xml version=\"1.0\"?><rss><channel></channel></rss>";
  const result = await acquireCompanyStarterEvidence({
    symbol: "ACIR",
    asOf: "2026-08-28",
    profile: {
      cik: "0001045810",
      recent_filings: [{
        form: "4", accession: "0001045810-26-000062", primary_document: "xslF345X06/form4.xml",
        filing_date: "2026-08-27", accepted_at: "2026-08-27T18:30:30.000Z",
      }],
    },
  }, {
    fetchImpl: async (url) => ({ ok: true, status: 200, url, headers: { get: () => "application/rss+xml" }, text: async () => feed }),
    filingDocumentImpl: async () => ({
      url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000062/form4.xml",
      text: `<ownershipDocument>${"x".repeat(512_001)}</ownershipDocument>`,
    }),
    timeoutMs: 1_000,
  });

  assert.deepEqual(result.sec_primary_document_evidence.documents, []);
  assert.match(result.sec_primary_document_evidence.attempts[0].reason, /starter-evidence limit/u);
});

test("a cited server-read SEC document rejects tampered ref, hash, URL, or accession", async () => {
  const feed = "<?xml version=\"1.0\"?><rss><channel></channel></rss>";
  const starter = await acquireCompanyStarterEvidence({
    symbol: "ACIR",
    asOf: "2026-08-28",
    profile: {
      cik: "0001045810",
      name: "Alpha Circuit Corporation",
      recent_filings: [{
        form: "4", accession: "0001045810-26-000062", primary_document: "xslF345X06/form4.xml",
        filing_date: "2026-08-27", accepted_at: "2026-08-27T18:30:30.000Z",
      }],
    },
  }, {
    fetchImpl: async (url) => ({ ok: true, status: 200, url, headers: { get: () => "application/rss+xml" }, text: async () => feed }),
    filingDocumentImpl: async () => ({
      url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000062/form4.xml",
      text: "<ownershipDocument><rptOwnerName>Example Officer</rptOwnerName></ownershipDocument>",
    }),
    timeoutMs: 1_000,
  });
  const frozen = starter.sec_primary_document_evidence.documents[0];
  const sourceId = "news_industry_management:S1";
  const packet = {
    task: "news_industry_management",
    sources: [{
      id: sourceId,
      title: "SEC Form 4",
      url: frozen.raw_url,
      published_at: frozen.filing_date,
      retrieved_at: frozen.retrieved_at,
      grounding_document_ref: frozen.grounding_document_ref,
      accession: frozen.accession,
      persisted_text_sha256: frozen.persisted_text_sha256,
      excerpt_sha256: frozen.excerpt_sha256,
    }],
    coverage_items: [{ id: "news.regulator_timeline", status: "covered", source_ids: [sourceId] }],
    acquisition_ledger: {
      items: [{
        coverage_id: "news.regulator_timeline",
        source_ids: [sourceId],
        attempts: [{ stage: "regulator_filing", result: "succeeded", source_ids: [sourceId] }],
      }],
    },
  };
  const grounding = { company_starter_evidence: starter };
  assert.deepEqual(secPrimaryDocumentEvidenceIssues(packet, grounding), []);

  const mutations = {
    grounding_document_ref: "sec-primary-document-v1:tampered",
    persisted_text_sha256: `sha256:${"0".repeat(64)}`,
    excerpt_sha256: `sha256:${"1".repeat(64)}`,
    url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000062/tampered.xml",
    accession: "0001045810-26-999999",
  };
  for (const [field, value] of Object.entries(mutations)) {
    const changed = structuredClone(packet);
    changed.sources[0][field] = value;
    assert.ok(secPrimaryDocumentEvidenceIssues(changed, grounding).some((issue) => issue.path.endsWith(`/${field}`)), field);
  }
  const rebound = structuredClone(packet);
  Object.assign(rebound.sources[0], mutations);
  assert.ok(secPrimaryDocumentEvidenceIssues(rebound, grounding).some((issue) => (
    issue.keyword === "frozen_binding" && /does not match any server-frozen/u.test(issue.message)
  )));

  const insiderWithoutBinding = structuredClone(packet);
  insiderWithoutBinding.task = "insider_sec";
  delete insiderWithoutBinding.sources[0].grounding_document_ref;
  delete insiderWithoutBinding.sources[0].accession;
  delete insiderWithoutBinding.sources[0].persisted_text_sha256;
  delete insiderWithoutBinding.sources[0].excerpt_sha256;
  const insiderIssues = secPrimaryDocumentEvidenceIssues(insiderWithoutBinding, grounding);
  assert.ok(insiderIssues.some((issue) => issue.path === "/sources/0/grounding_document_ref"));
  assert.ok(insiderIssues.some((issue) => issue.path === "/sources/0/accession"));

  const unavailableNewsWithoutBinding = structuredClone(insiderWithoutBinding);
  unavailableNewsWithoutBinding.task = "news_industry_management";
  unavailableNewsWithoutBinding.coverage_items[0].status = "unavailable";
  assert.ok(secPrimaryDocumentEvidenceIssues(unavailableNewsWithoutBinding, grounding).some((issue) => (
    issue.path === "/sources/0/persisted_text_sha256"
  )));

  const independentSecSource = {
    task: "insider_sec",
    sources: [{
      id: "insider_sec:S2",
      title: "Different SEC filing",
      url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000061/form3.xml",
      accession: "0001045810-26-000061",
      published_at: "2026-08-26",
    }],
  };
  assert.deepEqual(secPrimaryDocumentEvidenceIssues(independentSecSource, grounding), []);

  const repairContext = secPrimaryDocumentRepairPromptBlock(grounding);
  assert.match(repairContext, new RegExp(frozen.grounding_document_ref, "u"));
  assert.match(repairContext, new RegExp(frozen.accession, "u"));
  assert.match(repairContext, new RegExp(frozen.persisted_text_sha256, "u"));
  assert.doesNotMatch(repairContext, /Example Officer/u, "transport repair receives the binding, not source prose");
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

test("a prose acquisition attempts field reaches the typed repair gate instead of throwing", () => {
  const fixture = acquisitionFixture({
    task: "ib_event_analysis",
    targetId: "events.event_calendar",
    covered: false,
    item: (route) => exhaustiveUnavailable(route),
  });
  fixture.packet.acquisition_ledger.items[fixture.target].attempts = "Reviewed issuer filings and calendars.";

  assert.doesNotThrow(() => canonicalizeCompanySourceAcquisitionPacket(fixture.packet, fixture.run));
  const issues = companySourceAcquisitionIssues(fixture.packet, fixture.run);
  assert.ok(issues.some((issue) => (
    issue.path === `/acquisition_ledger/items/${fixture.target}/attempts`
      && issue.keyword === "type"
      && issue.message === "must be an array"
  )));
});

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

function fastQuantBoundFixture() {
  const sourceUrl = "https://cdn.cboe.com/api/global/delayed_quotes/options/AAPL.json";
  const observedAt = "2026-08-28T03:50:12.000Z";
  const retrievedAt = "2026-08-28T03:51:00.000Z";
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: "AAPL",
    asOf: "2026-08-28",
    profile: {
      ...profile({ cik: "0000320193", name: "Apple Inc." }),
      exchanges: ["NASDAQ"],
    },
  });
  const routes = plan.tasks.quant_factor;
  const items = routes.map((route) => ({
    coverage_id: route.coverage_id,
    outcome: "not_applicable",
    source_ids: [],
    attempts: [],
    reason: "Fixture route is outside this semantic assertion.",
  }));
  const coverageItems = routes.map((route) => ({
    id: route.coverage_id,
    status: "not_applicable",
    source_ids: [],
    note: "Fixture route is outside this semantic assertion.",
    attempted: "",
    attempted_urls: [],
    gap: "",
  }));
  const target = routes.findIndex((route) => route.coverage_id === "quant.options_iv_skew_expected_move");
  const targetRoute = routes[target];
  const sourceId = "quant_factor:S1";
  const locator = (stage) => {
    const entry = targetRoute.stages.find((row) => row.stage === stage);
    return entry.locators[0];
  };
  items[target] = {
    coverage_id: targetRoute.coverage_id,
    outcome: "recomputed_proxy",
    source_ids: [sourceId],
    attempts: [
      {
        stage: "local_observation",
        locator_type: locator("local_observation").locator_type,
        locator: locator("local_observation").locator,
        result: "succeeded",
        source_ids: [sourceId],
        note: "Consumed the frozen server option snapshot.",
      },
      {
        stage: "derived_proxy",
        locator_type: locator("derived_proxy").locator_type,
        locator: locator("derived_proxy").locator,
        result: "succeeded",
        source_ids: [],
        note: "Recomputed the one-standard-deviation ATM-IV move proxy.",
      },
    ],
    data: {
      formula: "spot * reference_atm_iv * sqrt(dte / 365)",
      inputs: [
        { name: "spot", value: 314.58, source_ids: [sourceId] },
        { name: "reference_atm_iv", value: 0.2302, source_ids: [sourceId] },
        { name: "dte", value: 7, source_ids: [sourceId] },
      ],
      observations: [{
        metric: "one_standard_deviation_atm_iv_move_proxy",
        value: 3.187924,
        unit: "% of spot",
        period: "2026-09-04 expiry",
        scope: "one-standard-deviation ATM-IV proxy",
      }],
    },
  };
  coverageItems[target] = {
    id: targetRoute.coverage_id,
    status: "covered",
    source_ids: [sourceId],
    note: "Frozen delayed CBOE snapshot and server recomputation.",
    attempted: "Consumed server snapshot and recomputed proxy.",
    attempted_urls: [sourceUrl],
    gap: "",
  };
  const packet = {
    task: "quant_factor",
    as_of: "2026-08-28",
    summary: "一标准差 ATM-IV 波幅代理为 3.187924%，不是方向预测。",
    claims: [{
      claim: "一标准差 ATM-IV 波幅代理为 3.187924%。",
      evidence: "由冻结 spot、ATM IV 与 7 日 DTE 复算。",
      source_ids: [sourceId],
    }],
    metrics: { one_standard_deviation_atm_iv_move_proxy_pct: 3.187924 },
    sources: [{
      id: sourceId,
      title: "CBOE delayed option-chain snapshot",
      url: sourceUrl,
      published_at: "unknown",
      retrieved_at: retrievedAt,
      observed_at: observedAt,
      source_kind: "dynamic_snapshot",
    }],
    open_questions: ["IV rank/percentile unavailable while like-for-like history builds (1/60)."],
    coverage_items: coverageItems,
    acquisition_ledger: {
      policy_id: COMPANY_SOURCE_ACQUISITION_POLICY_ID,
      task: "quant_factor",
      items,
    },
  };
  const run = {
    council_mode: "full",
    council_pace: "fast",
    dry_run: false,
    decision_requested: true,
    entry_tool: "analyze_symbol",
    as_of: "2026-08-28",
    grounding: {
      instrument: { research_model: "operating_company" },
      quote: { currency: "USD" },
      source_acquisition_plan: plan,
      options: {
        available: true,
        source_url: sourceUrl,
        retrieved_at: retrievedAt,
        chain_timestamp: observedAt,
        spot: 314.58,
        reference_expiry: { expiry: "2026-09-04", dte: 7, atm_iv: 0.2302 },
        iv_history: { status: "building_history", observation_count: 1, minimum_observations: 60, percentile: null },
      },
    },
  };
  return { packet, run, plan, routes, target, sourceId };
}

test("fast quant server gate binds frozen locators, limits, and official domains", () => {
  const valid = fastQuantBoundFixture();
  assert.deepEqual(companySourceAcquisitionIssues(valid.packet, valid.run), []);

  const invented = structuredClone(valid);
  invented.packet.acquisition_ledger.items[invented.target].attempts[0].locator = "local:AAPL:invented";
  assert.ok(companySourceAcquisitionIssues(invented.packet, invented.run).some((issue) => issue.keyword === "frozen_locator"));

  const repeated = structuredClone(valid);
  repeated.packet.acquisition_ledger.items[repeated.target].attempts.push(
    structuredClone(repeated.packet.acquisition_ledger.items[repeated.target].attempts[0]),
  );
  assert.ok(companySourceAcquisitionIssues(repeated.packet, repeated.run).some((issue) => issue.keyword === "unique"));

  const over = structuredClone(valid);
  for (const [routeIndex, route] of over.routes.entries()) {
    for (const entry of route.stages) {
      for (const frozen of entry.locators.filter((row) => row.locator_type === "query")) {
        over.packet.acquisition_ledger.items[routeIndex].attempts.push({
          stage: entry.stage,
          locator_type: "query",
          locator: frozen.locator,
          result: "not_found",
          source_ids: [],
          note: "bounded fixture query",
        });
      }
    }
  }
  const firstQuery = over.packet.acquisition_ledger.items.flatMap((item) => item.attempts)
    .find((attempt) => attempt.locator_type === "query");
  over.packet.acquisition_ledger.items[0].attempts.push(structuredClone(firstQuery));
  const overIssues = companySourceAcquisitionIssues(over.packet, over.run);
  assert.equal(FAST_QUANT_MAX_QUERY_LOCATORS, 8);
  assert.ok(overIssues.some((issue) => issue.keyword === "max_query_locators"));

  const unofficial = structuredClone(valid);
  unofficial.packet.sources.push({ id: "quant_factor:S2", url: "https://example.com/options" });
  const officialStage = unofficial.routes[0].stages.find((entry) => entry.stage === "market_official");
  unofficial.packet.acquisition_ledger.items[0].attempts.push({
    stage: "market_official",
    locator_type: officialStage.locators[0].locator_type,
    locator: officialStage.locators[0].locator,
    result: "succeeded",
    source_ids: ["quant_factor:S2"],
    note: "spoofed official result",
  });
  assert.ok(companySourceAcquisitionIssues(unofficial.packet, unofficial.run).some((issue) => issue.keyword === "official_domain"));

  const frozenUrls = valid.routes.flatMap((route) => route.stages)
    .flatMap((entry) => entry.locators.map((locator) => ({ ...locator, stage: entry.stage })))
    .filter((locator) => locator.locator_type === "url");
  assert.equal(frozenUrls.length, FAST_QUANT_MAX_URL_LOCATORS);
  assert.ok(frozenUrls.some((locator) => /finance\.yahoo\.com\/quote\/AAPL\/key-statistics/u.test(locator.locator)));

  const laundered = structuredClone(valid);
  laundered.packet.sources.push(
    { id: "quant_factor:S_GOOD", url: "https://www.nasdaqtrader.com/Trader.aspx?id=ShortInterest" },
    { id: "quant_factor:S_BAD", url: "https://example.com/invented-factor" },
  );
  const firstRoute = laundered.routes[0];
  const firstOfficial = firstRoute.stages.find((entry) => entry.stage === "market_official");
  laundered.packet.acquisition_ledger.items[0].attempts.push({
    stage: "market_official",
    locator_type: firstOfficial.locators[0].locator_type,
    locator: firstOfficial.locators[0].locator,
    result: "succeeded",
    source_ids: ["quant_factor:S_GOOD"],
    note: "authorised fixture source",
  });
  laundered.packet.acquisition_ledger.items[0].source_ids = ["quant_factor:S_BAD"];
  laundered.packet.acquisition_ledger.items[0].data = {
    inputs: [{ name: "invented_factor", value: 99, source_ids: ["quant_factor:S_BAD"] }],
  };
  laundered.packet.coverage_items[0].source_ids = ["quant_factor:S_BAD"];
  laundered.packet.claims.push({
    claim: "Invented factor claim.",
    evidence: "Laundered through another attempt.",
    source_ids: ["quant_factor:S_BAD"],
  });
  const launderingIssues = companySourceAcquisitionIssues(laundered.packet, laundered.run);
  assert.ok(launderingIssues.some((issue) => issue.keyword === "attempt_source_binding"));
  assert.ok(launderingIssues.some((issue) => issue.keyword === "authorised_source_binding"));

  const disconfirming = structuredClone(valid);
  const shortIndex = disconfirming.routes.findIndex((route) => route.coverage_id === "quant.short_interest_borrow");
  const disconfirmingStage = disconfirming.routes[shortIndex].stages.find((entry) => entry.stage === "disconfirming_search");
  assert.ok(disconfirmingStage.authorized_domains.includes("iborrowdesk.com"));
  disconfirming.packet.sources.push({ id: "quant_factor:S_IBD", url: "https://iborrowdesk.com/report/AAPL" });
  disconfirming.packet.acquisition_ledger.items[shortIndex].attempts.push({
    stage: "disconfirming_search",
    locator_type: disconfirmingStage.locators[0].locator_type,
    locator: disconfirmingStage.locators[0].locator,
    result: "not_disclosed",
    source_ids: ["quant_factor:S_IBD"],
    note: "Opened the frozen allowlisted result without a complete disclosed field.",
  });
  disconfirming.packet.acquisition_ledger.items[shortIndex].source_ids = ["quant_factor:S_IBD"];
  disconfirming.packet.coverage_items[shortIndex].source_ids = ["quant_factor:S_IBD"];
  disconfirming.packet.coverage_items[shortIndex].attempted_urls = ["https://iborrowdesk.com/report/AAPL"];
  assert.deepEqual(companySourceAcquisitionIssues(disconfirming.packet, disconfirming.run), []);

  const disconfirmingSpoof = structuredClone(disconfirming);
  const ibdSource = disconfirmingSpoof.packet.sources.find((source) => source.id === "quant_factor:S_IBD");
  ibdSource.url = "https://example.com/report/AAPL";
  disconfirmingSpoof.packet.coverage_items[shortIndex].attempted_urls = [ibdSource.url];
  assert.ok(companySourceAcquisitionIssues(disconfirmingSpoof.packet, disconfirmingSpoof.run)
    .some((issue) => issue.keyword === "official_domain"));

  const forgedAttemptUrl = structuredClone(valid);
  forgedAttemptUrl.packet.coverage_items[forgedAttemptUrl.target].attempted_urls.push("https://example.com/never-attempted");
  assert.ok(companySourceAcquisitionIssues(forgedAttemptUrl.packet, forgedAttemptUrl.run)
    .some((issue) => issue.keyword === "attempt_url_binding"));

  const singularSource = structuredClone(valid);
  singularSource.packet.metrics.invented_factor = {
    value: 99,
    unit: "score",
    source_id: singularSource.sourceId,
  };
  assert.ok(companySourceAcquisitionIssues(singularSource.packet, singularSource.run)
    .some((issue) => issue.keyword === "source_id_shape"));
});

function fastValuationBoundFixture() {
  const quoteUrl = "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d";
  const factsUrl = "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json";
  const plan = buildCompanySourceAcquisitionPlan({
    symbol: "AAPL",
    asOf: "2026-08-28",
    profile: {
      ...profile({ cik: "0000320193", name: "Apple Inc." }),
      exchanges: ["NASDAQ"],
    },
  });
  const routes = plan.tasks.valuation_long_short;
  const items = routes.map((route) => ({
    coverage_id: route.coverage_id,
    outcome: "not_applicable",
    source_ids: [],
    attempts: [],
    reason: "Fixture route is outside this binding assertion.",
  }));
  const coverageItems = routes.map((route) => ({
    id: route.coverage_id,
    status: "not_applicable",
    source_ids: [],
    note: "Fixture route is outside this binding assertion.",
    attempted: "",
    attempted_urls: [],
    gap: "",
  }));
  const target = routes.findIndex((route) => route.coverage_id === "valuation.dcf_reverse_dcf");
  const targetRoute = routes[target];
  const sourceIds = ["valuation_long_short:S1", "valuation_long_short:S2"];
  const calculationHash = "sha256:fixture-fast-valuation-grid";
  const requiredMetricsAck = {
    calculation_hash: calculationHash,
    current_price_to_owner_earnings_multiple: 40.678316,
    reverse_dcf_implied_growth: 0.073,
    scenario_value_per_share: { bear: 77.553655, base: 121.720593, bull: 182.625514 },
    scenario_implied_return_pct: { bear: -75.346921, base: -61.306951, bull: -41.946241 },
  };
  const bindServerRoute = (coverageId, outcome, data) => {
    const index = routes.findIndex((route) => route.coverage_id === coverageId);
    const route = routes[index];
    const derived = route.stages.find((stage) => stage.stage === "derived_proxy").locators[0];
    items[index] = {
      coverage_id: coverageId,
      outcome,
      source_ids: sourceIds,
      attempts: [
        {
          stage: "derived_proxy",
          locator_type: derived.locator_type,
          locator: derived.locator,
          result: "succeeded",
          source_ids: sourceIds,
          note: "Used the server-computed sensitivity grid.",
        },
      ],
      data: { ...data, calculation_hash: calculationHash },
    };
    coverageItems[index] = {
      id: coverageId,
      status: "covered",
      source_ids: sourceIds,
      note: "Server-modeled valuation sensitivity, not a forecast.",
      attempted: "Used the frozen server-derived projection route.",
      attempted_urls: [quoteUrl, factsUrl],
      gap: "",
    };
  };
  bindServerRoute("valuation.trading_multiples", "recomputed_proxy", {
    value: requiredMetricsAck.current_price_to_owner_earnings_multiple,
    unit: "price / estimated owner earnings per share",
    period: "2026-08-28 quote over FY2025 denominator",
    formula: "quote price / estimated owner earnings per aligned diluted share",
    inputs: [
      { name: "quote_price", value: 314.58, source_ids: sourceIds },
      { name: "owner_earnings", value: 116_036_700_000, source_ids: sourceIds },
    ],
  });
  bindServerRoute("valuation.dcf_reverse_dcf", "recomputed_proxy", {
    value: requiredMetricsAck.reverse_dcf_implied_growth,
    unit: "decimal annual growth",
    period: "five-year illustrative owner-earnings model",
    formula: "server bisection over the frozen owner-earnings DCF",
    inputs: [
      { name: "quote_price", value: 314.58, source_ids: sourceIds },
      { name: "owner_earnings", value: 116_036_700_000, source_ids: sourceIds },
    ],
  });
  bindServerRoute("valuation.bear_base_bull", "modeled_estimate", {
    range: {
      low: requiredMetricsAck.scenario_value_per_share.bear,
      base: requiredMetricsAck.scenario_value_per_share.base,
      high: requiredMetricsAck.scenario_value_per_share.bull,
    },
    unit: "USD per share",
    period: "five-year illustrative owner-earnings sensitivity",
    formula: "server-frozen owner-earnings DCF scenario grid",
    inputs: [
      { name: "bear_growth", value: 0 },
      { name: "base_growth", value: 0.04 },
      { name: "bull_growth", value: 0.07 },
    ],
    assumptions: ["Illustrative sensitivity, not issuer guidance or a target price."],
  });
  bindServerRoute("valuation.long_short_asymmetry", "modeled_estimate", {
    range: {
      low: requiredMetricsAck.scenario_implied_return_pct.bear,
      base: requiredMetricsAck.scenario_implied_return_pct.base,
      high: requiredMetricsAck.scenario_implied_return_pct.bull,
    },
    unit: "percent versus frozen quote",
    period: "five-year illustrative owner-earnings sensitivity",
    formula: "(scenario value per share / frozen quote - 1) * 100",
    inputs: [
      { name: "quote_price", value: 314.58 },
      { name: "bear_value", value: requiredMetricsAck.scenario_value_per_share.bear },
      { name: "base_value", value: requiredMetricsAck.scenario_value_per_share.base },
      { name: "bull_value", value: requiredMetricsAck.scenario_value_per_share.bull },
    ],
    assumptions: ["Illustrative model spread, not an expected or promised return."],
  });
  const requiredLedgerBindings = Object.fromEntries(items
    .filter((item) => [
      "valuation.trading_multiples",
      "valuation.dcf_reverse_dcf",
      "valuation.bear_base_bull",
      "valuation.long_short_asymmetry",
    ].includes(item.coverage_id))
    .map((item) => [item.coverage_id, {
      outcome: item.outcome,
      data: structuredClone(item.data),
    }]));
  const packet = {
    task: "valuation_long_short",
    as_of: "2026-08-28",
    summary: "Illustrative reverse DCF only; no point target or profit promise.",
    claims: [{
      claim: "The frozen illustrative model implies a five-year growth threshold.",
      evidence: "Server bisection uses the frozen quote and estimated owner earnings.",
      source_ids: sourceIds,
    }],
    metrics: {
      server_valuation_sensitivity_ack: structuredClone(requiredMetricsAck),
    },
    sources: [
      { id: sourceIds[0], title: "Delayed quote", url: quoteUrl },
      { id: sourceIds[1], title: "SEC Companyfacts", url: factsUrl },
    ],
    open_questions: [],
    coverage_items: coverageItems,
    acquisition_ledger: {
      policy_id: COMPANY_SOURCE_ACQUISITION_POLICY_ID,
      task: "valuation_long_short",
      items,
    },
  };
  const run = {
    council_mode: "full",
    council_pace: "fast",
    dry_run: false,
    decision_requested: true,
    entry_tool: "analyze_symbol",
    as_of: "2026-08-28",
    grounding: {
      instrument: { research_model: "operating_company" },
      quote: { price: 314.58, currency: "USD", source_url: quoteUrl },
      fundamentals: { cik: "0000320193" },
      filer: {
        cik: "0000320193",
        submissions_url: "https://data.sec.gov/submissions/CIK0000320193.json",
        recent_filings: [],
      },
      typed_fact_pack: { facts: [] },
      source_acquisition_plan: plan,
      fast_valuation_projection: {
        schema_version: 1,
        projection_id: "fast_valuation_grounding_v1",
        server_valuation_sensitivity: {
          status: "illustrative_server_model_not_forecast",
          calculation_hash: calculationHash,
          required_metrics_ack: structuredClone(requiredMetricsAck),
          required_ledger_bindings: requiredLedgerBindings,
        },
      },
    },
  };
  return { packet, run, plan, routes, target, targetRoute, sourceIds, calculationHash, requiredMetricsAck };
}

test("fast valuation binds frozen locators and sources instead of trusting the prompt ledger", () => {
  const valid = fastValuationBoundFixture();
  assert.deepEqual(companySourceAcquisitionIssues(valid.packet, valid.run), []);
  assert.equal(FAST_VALUATION_MAX_QUERY_LOCATORS, 12);
  assert.equal(FAST_VALUATION_MAX_URL_LOCATORS, 6);

  const invented = structuredClone(valid);
  invented.packet.acquisition_ledger.items[invented.target].attempts[0].locator = "derive:invented_valuation";
  assert.ok(companySourceAcquisitionIssues(invented.packet, invented.run).some((issue) => issue.keyword === "frozen_locator"));

  const laundered = structuredClone(valid);
  laundered.packet.sources[0].url = "https://example.com/invented-model";
  assert.ok(companySourceAcquisitionIssues(laundered.packet, laundered.run).some((issue) => issue.keyword === "frozen_source_binding"));

  const unofficial = structuredClone(valid);
  const regulator = unofficial.targetRoute.stages.find((stage) => stage.stage === "regulator_filing");
  const query = regulator.locators.find((locator) => locator.locator_type === "query");
  unofficial.packet.sources.push({ id: "valuation_long_short:S3", url: "https://example.com/not-a-regulator" });
  unofficial.packet.acquisition_ledger.items[unofficial.target].attempts.push({
    stage: "regulator_filing",
    locator_type: query.locator_type,
    locator: query.locator,
    result: "succeeded",
    source_ids: ["valuation_long_short:S3"],
    note: "Spoofed query result.",
  });
  assert.ok(companySourceAcquisitionIssues(unofficial.packet, unofficial.run).some((issue) => issue.keyword === "frozen_source_binding"));

  const over = structuredClone(valid);
  for (const [routeIndex, route] of over.routes.entries()) {
    for (const stage of route.stages) {
      for (const locator of stage.locators.filter((row) => row.locator_type === "query")) {
        over.packet.acquisition_ledger.items[routeIndex].attempts.push({
          stage: stage.stage,
          locator_type: locator.locator_type,
          locator: locator.locator,
          result: "not_found",
          source_ids: [],
          note: "Bounded query fixture.",
        });
      }
    }
  }
  assert.ok(companySourceAcquisitionIssues(over.packet, over.run).some((issue) => issue.keyword === "max_query_locators"));

  const overUrls = structuredClone(valid);
  const urlAttempts = [];
  for (const [routeIndex, route] of overUrls.routes.entries()) {
    const regulator = route.stages.find((stage) => stage.stage === "regulator_filing")?.locators
      .find((locator) => locator.locator_type === "url");
    if (regulator) urlAttempts.push({ routeIndex, stage: "regulator_filing", locator: regulator });
  }
  // Six distinct routes exhaust the cap. A repeated seventh frozen URL remains an attempt,
  // so it must trip both the per-route uniqueness gate and the global URL ceiling.
  if (urlAttempts[0]) urlAttempts.push(structuredClone(urlAttempts[0]));
  assert.equal(urlAttempts.length, 7);
  for (const attempt of urlAttempts) {
    overUrls.packet.acquisition_ledger.items[attempt.routeIndex].attempts.push({
      stage: attempt.stage,
      locator_type: attempt.locator.locator_type,
      locator: attempt.locator.locator,
      result: "not_found",
      source_ids: [],
      note: "Bounded URL-limit fixture.",
    });
  }
  assert.ok(companySourceAcquisitionIssues(overUrls.packet, overUrls.run).some((issue) => issue.keyword === "max_url_locators"));

  const tamperedAck = structuredClone(valid);
  tamperedAck.packet.metrics.server_valuation_sensitivity_ack.reverse_dcf_implied_growth = 0.99;
  assert.ok(companySourceAcquisitionIssues(tamperedAck.packet, tamperedAck.run)
    .some((issue) => issue.keyword === "server_valuation_ack_value"));

  const stringifiedNumbers = structuredClone(valid);
  stringifiedNumbers.packet.metrics.server_valuation_sensitivity_ack.reverse_dcf_implied_growth = "0.073";
  stringifiedNumbers.packet.acquisition_ledger.items[stringifiedNumbers.target].data.value = "0.073";
  const stringifiedIssues = companySourceAcquisitionIssues(stringifiedNumbers.packet, stringifiedNumbers.run);
  assert.ok(stringifiedIssues.some((issue) => issue.keyword === "server_valuation_ack_value"));
  assert.ok(stringifiedIssues.some((issue) => issue.keyword === "server_valuation_value_binding"));

  const tamperedGrid = structuredClone(valid);
  const scenarioIndex = tamperedGrid.routes.findIndex((route) => route.coverage_id === "valuation.bear_base_bull");
  tamperedGrid.packet.acquisition_ledger.items[scenarioIndex].data.range.base += 1;
  assert.ok(companySourceAcquisitionIssues(tamperedGrid.packet, tamperedGrid.run)
    .some((issue) => issue.keyword === "server_valuation_range_binding"));

  const tamperedHash = structuredClone(valid);
  tamperedHash.packet.acquisition_ledger.items[tamperedHash.target].data.calculation_hash = "sha256:wrong";
  assert.ok(companySourceAcquisitionIssues(tamperedHash.packet, tamperedHash.run)
    .some((issue) => issue.keyword === "server_valuation_hash_binding"));

  for (const [field, value] of [
    ["formula", "99 + prompt_injection"],
    ["period", "FY2099"],
    ["unit", "invented unit"],
  ]) {
    const changed = structuredClone(valid);
    changed.packet.acquisition_ledger.items[changed.target].data[field] = value;
    assert.ok(companySourceAcquisitionIssues(changed.packet, changed.run)
      .some((issue) => issue.keyword.startsWith("server_valuation_semantic")), field);
  }
  const changedInput = structuredClone(valid);
  changedInput.packet.acquisition_ledger.items[changedInput.target].data.inputs[0].value = 999;
  assert.ok(companySourceAcquisitionIssues(changedInput.packet, changedInput.run)
    .some((issue) => issue.keyword.startsWith("server_valuation_semantic")));

  const numericReaderClaim = structuredClone(valid);
  numericReaderClaim.packet.summary = "Bull value is 999 and implied growth is 99%.";
  numericReaderClaim.packet.claims[0].claim = "The bull case is 999.";
  assert.ok(companySourceAcquisitionIssues(numericReaderClaim.packet, numericReaderClaim.run)
    .some((issue) => issue.keyword === "server_valuation_reader_number"));

  for (const summary of [
    "Bull value is ９９９.",
    "Bull value is 9e2.",
    "Bull value is 0x3e7.",
  ]) {
    const encodedReaderClaim = structuredClone(valid);
    encodedReaderClaim.packet.summary = summary;
    assert.ok(companySourceAcquisitionIssues(encodedReaderClaim.packet, encodedReaderClaim.run)
      .some((issue) => issue.keyword === "server_valuation_reader_number"), summary);
  }

  const extraMetric = structuredClone(valid);
  extraMetric.packet.metrics.invented_bull_value = { value: 999 };
  assert.ok(companySourceAcquisitionIssues(extraMetric.packet, extraMetric.run)
    .some((issue) => issue.keyword === "server_valuation_extra_metric"));

  const unreadFiling = structuredClone(valid);
  const filingUrl = "https://www.sec.gov/Archives/edgar/data/320193/000032019326000079/aapl-20260926.htm";
  unreadFiling.run.grounding.filer.recent_filings = [{
    form: "10-K",
    filing_date: "2026-10-30",
    accession: "0000320193-26-000079",
    primary_document_url: filingUrl,
  }];
  unreadFiling.packet.sources.push({ id: "valuation_long_short:S3", title: "Unread filing locator", url: filingUrl });
  unreadFiling.packet.acquisition_ledger.items[unreadFiling.target].attempts[0].source_ids.push("valuation_long_short:S3");
  assert.ok(companySourceAcquisitionIssues(unreadFiling.packet, unreadFiling.run)
    .some((issue) => issue.keyword === "frozen_source_binding"));

  const launderedQueryFiling = structuredClone(valid);
  const queryRegulatorStage = launderedQueryFiling.targetRoute.stages.find((stage) => stage.stage === "regulator_filing");
  const regulatorQuery = queryRegulatorStage.locators.find((locator) => locator.locator_type === "query");
  const queryFilingUrl = "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm";
  launderedQueryFiling.packet.sources.push({
    id: "valuation_long_short:S3",
    title: "Worker-asserted unread filing",
    url: queryFilingUrl,
    published_at: "2025-10-31",
  });
  launderedQueryFiling.packet.acquisition_ledger.items[launderedQueryFiling.target].attempts.push({
    stage: "regulator_filing",
    locator_type: regulatorQuery.locator_type,
    locator: regulatorQuery.locator,
    result: "succeeded",
    source_ids: ["valuation_long_short:S3"],
    note: "Worker claimed the query opened this filing.",
  });
  assert.ok(companySourceAcquisitionIssues(launderedQueryFiling.packet, launderedQueryFiling.run)
    .some((issue) => issue.keyword === "frozen_source_binding"));

  const allUnavailable = fastValuationBoundFixture();
  allUnavailable.run.grounding.fast_valuation_projection.server_valuation_sensitivity = {
    status: "unavailable",
    reason: "fixture intentionally has no aligned server model",
  };
  allUnavailable.packet.claims = [];
  allUnavailable.packet.metrics = {};
  allUnavailable.packet.sources = [];
  allUnavailable.packet.open_questions = [];
  let attemptCount = 0;
  for (const [index, route] of allUnavailable.routes.entries()) {
    const attempts = route.required_terminal_stages.map((stageName) => {
      const stage = route.stages.find((candidate) => candidate.stage === stageName);
      const locator = stage.locators.find((candidate) => (
        stageName === "regulator_filing" ? candidate.locator_type === "url" : true
      ));
      return {
        stage: stageName,
        locator_type: locator.locator_type,
        locator: locator.locator,
        result: "not_found",
        source_ids: [],
        note: "Frozen bounded route returned no publishable field.",
      };
    });
    attemptCount += attempts.length;
    const reason = `${route.coverage_id} remained unavailable after every frozen terminal stage.`;
    allUnavailable.packet.acquisition_ledger.items[index] = {
      coverage_id: route.coverage_id,
      outcome: "unavailable",
      source_ids: [],
      attempts,
      reason,
    };
    allUnavailable.packet.coverage_items[index] = {
      id: route.coverage_id,
      status: "unavailable",
      source_ids: [],
      note: reason,
      attempted: "Executed all four frozen terminal stages.",
      attempted_urls: attempts.filter((attempt) => attempt.locator_type === "url").map((attempt) => attempt.locator),
      gap: reason,
    };
    allUnavailable.packet.open_questions.push(reason);
  }
  assert.equal(attemptCount, 24);
  assert.deepEqual(companySourceAcquisitionIssues(allUnavailable.packet, allUnavailable.run), []);
});

test("fast quant rejects invented IV rank and binds expected move across ledger, metrics, claims, source, and time", () => {
  const valid = fastQuantBoundFixture();
  assert.deepEqual(companySourceAcquisitionIssues(valid.packet, valid.run), []);

  const inventedIv = structuredClone(valid);
  inventedIv.packet.metrics.iv_rank = 99;
  inventedIv.packet.claims[0].claim = "IV rank 99, so volatility is expensive.";
  inventedIv.packet.acquisition_ledger.items[inventedIv.target].data.observations.push({
    metric: "iv_percentile",
    value: 99,
    unit: "%",
    period: "2026-09-04 expiry",
    scope: "single snapshot",
  });
  const ivIssues = companySourceAcquisitionIssues(inventedIv.packet, inventedIv.run);
  assert.ok(ivIssues.filter((issue) => issue.keyword === "iv_history_binding").length >= 3);

  const wrongValue = structuredClone(valid);
  wrongValue.packet.acquisition_ledger.items[wrongValue.target].data.observations[0].value = 99;
  wrongValue.packet.metrics.one_standard_deviation_atm_iv_move_proxy_pct = 99;
  wrongValue.packet.claims[0].claim = "一标准差 ATM-IV 波幅代理为 99%。";
  const valueIssues = companySourceAcquisitionIssues(wrongValue.packet, wrongValue.run);
  assert.ok(valueIssues.some((issue) => issue.keyword === "expected_move_value_binding"));
  assert.ok(valueIssues.some((issue) => issue.keyword === "expected_move_cross_field_binding"));

  const wrongSource = structuredClone(valid);
  wrongSource.packet.sources[0].url = "https://example.com/fake-options";
  wrongSource.packet.sources[0].observed_at = "2026-08-28T03:50:13.000Z";
  const sourceIssues = companySourceAcquisitionIssues(wrongSource.packet, wrongSource.run);
  assert.ok(sourceIssues.some((issue) => issue.keyword === "expected_move_source_binding"));

  const wrongFormulaAndInputs = structuredClone(valid);
  wrongFormulaAndInputs.packet.acquisition_ledger.items[wrongFormulaAndInputs.target].data.formula = "spot + reference_atm_iv + sqrt(dte / 365)";
  wrongFormulaAndInputs.packet.acquisition_ledger.items[wrongFormulaAndInputs.target].data.inputs = [
    { name: "spot", value: 999, source_ids: [wrongFormulaAndInputs.sourceId] },
    { name: "reference_atm_iv", value: 9.9, source_ids: [wrongFormulaAndInputs.sourceId] },
    { name: "dte", value: 99, source_ids: [wrongFormulaAndInputs.sourceId] },
  ];
  const formulaIssues = companySourceAcquisitionIssues(wrongFormulaAndInputs.packet, wrongFormulaAndInputs.run);
  assert.ok(formulaIssues.some((issue) => issue.keyword === "expected_move_formula_binding"));
  assert.ok(formulaIssues.filter((issue) => issue.keyword === "expected_move_input_binding").length >= 3);

  const nestedIv = structuredClone(valid);
  nestedIv.packet.metrics = { options: { iv_history: { percentile: 99 } } };
  assert.ok(companySourceAcquisitionIssues(nestedIv.packet, nestedIv.run)
    .some((issue) => issue.keyword === "iv_history_binding"));

  const japaneseIv = structuredClone(valid);
  japaneseIv.packet.claims[0].claim = "IVランクは99です。";
  assert.ok(companySourceAcquisitionIssues(japaneseIv.packet, japaneseIv.run)
    .some((issue) => issue.keyword === "iv_history_binding"));

  const percentWord = structuredClone(valid);
  percentWord.packet.metrics = { expected_move: { value: 99, unit: "percent" } };
  assert.ok(companySourceAcquisitionIssues(percentWord.packet, percentWord.run)
    .some((issue) => issue.keyword === "expected_move_cross_field_binding"));

  const noOptions = structuredClone(valid);
  noOptions.run.grounding.options = { available: false };
  noOptions.packet.metrics = {
    iv_rank: 99,
    expected_move: { value: 99, unit: "percent" },
  };
  const noOptionIssues = companySourceAcquisitionIssues(noOptions.packet, noOptions.run);
  assert.ok(noOptionIssues.some((issue) => issue.keyword === "iv_history_binding"));
  assert.ok(noOptionIssues.some((issue) => issue.keyword === "expected_move_binding"));

  const legacy = structuredClone(valid);
  const legacyData = legacy.packet.acquisition_ledger.items[legacy.target].data;
  legacy.packet.acquisition_ledger.items[legacy.target].data = {
    value: legacyData.observations[0].value,
    unit: legacyData.observations[0].unit,
    period: legacyData.observations[0].period,
    formula: legacyData.formula,
    inputs: legacyData.inputs,
  };
  assert.deepEqual(companySourceAcquisitionIssues(legacy.packet, legacy.run), []);

  const observationLocal = structuredClone(valid);
  const observationLocalData = observationLocal.packet.acquisition_ledger.items[observationLocal.target].data;
  observationLocalData.observations[0].formula = observationLocalData.formula;
  observationLocalData.observations[0].inputs = observationLocalData.inputs;
  delete observationLocalData.formula;
  delete observationLocalData.inputs;
  assert.deepEqual(companySourceAcquisitionIssues(observationLocal.packet, observationLocal.run), []);

  for (const mutate of [
    (fixture) => { fixture.packet.metrics.options = { history_note: "IV rank: 99" }; },
    (fixture) => { fixture.packet.acquisition_ledger.items[fixture.target].data.extra_note = "IV percentile is 99%"; },
    (fixture) => { fixture.packet.claims[0].claim = "IV percentile of 99"; },
  ]) {
    const stringIv = structuredClone(valid);
    mutate(stringIv);
    assert.ok(companySourceAcquisitionIssues(stringIv.packet, stringIv.run)
      .some((issue) => issue.keyword === "iv_history_binding"));
  }

  for (const mutate of [
    (fixture) => { fixture.packet.metrics.expected_move_note = "expected move 99 percent"; },
    (fixture) => { fixture.packet.acquisition_ledger.items[fixture.target].data.extra_note = "Expected move: 99%"; },
    (fixture) => { fixture.packet.claims[0].claim = "予想変動幅は99%です。"; },
    (fixture) => { fixture.packet.claims[0].claim = "期待変動幅は99%。"; },
    (fixture) => { fixture.packet.claims[0].claim = "예상 변동폭은 99%입니다."; },
  ]) {
    const stringMove = structuredClone(valid);
    mutate(stringMove);
    assert.ok(companySourceAcquisitionIssues(stringMove.packet, stringMove.run)
      .some((issue) => issue.keyword === "expected_move_cross_field_binding"));
  }

  for (const text of [
    "99 is the IV rank.",
    "99% IV percentile.",
    "The 99th percentile is the IV rank.",
    "IV 99th percentile.",
    "IV rank in the 99th percentile.",
    "IV rank unavailable, but likely 99.",
    "IV percentile cannot be computed; I estimate 99%.",
    "IV rank unavailable — likely 99.",
    "IV rank unavailable, estimated at 99.",
    "IV percentile unavailable though likely 99.",
    "IV rank unavailable, model output 99.",
    "IV rank unavailable (99 modeled).",
    "IV percentile unavailable, my guess 99.",
  ]) {
    const leadingIv = structuredClone(valid);
    leadingIv.packet.claims[0].claim = text;
    const leadingIvIssues = companySourceAcquisitionIssues(leadingIv.packet, leadingIv.run);
    assert.ok(leadingIvIssues.some((issue) => issue.keyword === "iv_history_binding"), text);
  }

  for (const text of [
    "99% expected move.",
    "A 99 percent expected move.",
    "expected 99% move.",
    "expected move comes to 99%.",
    "Expected move: roughly 99%.",
    "Expected move unavailable, but proxy is 99%.",
    "Expected move insufficient from frozen data; use 99% anyway.",
    "Expected move unavailable, estimated at 99%.",
    "Expected move unavailable — use 99% anyway.",
    "99%の予想変動幅です。",
    "99%의 예상 변동폭입니다.",
  ]) {
    const leadingMove = structuredClone(valid);
    leadingMove.packet.claims[0].claim = text;
    assert.ok(companySourceAcquisitionIssues(leadingMove.packet, leadingMove.run)
      .some((issue) => issue.keyword === "expected_move_cross_field_binding"));
  }

  for (const text of [
    "IV rank unavailable; only 1 of 60 observations have been saved.",
    "IV percentile cannot be computed until 60 observations exist.",
  ]) {
    const unavailableHistory = structuredClone(valid);
    unavailableHistory.packet.claims[0].claim = text;
    assert.ok(!companySourceAcquisitionIssues(unavailableHistory.packet, unavailableHistory.run)
      .some((issue) => issue.keyword === "iv_history_binding"));
  }

  const dteExplanation = structuredClone(valid);
  dteExplanation.packet.claims[0].evidence = "Expected move proxy uses 7 DTE and remains a volatility range, not direction.";
  assert.ok(!companySourceAcquisitionIssues(dteExplanation.packet, dteExplanation.run)
    .some((issue) => issue.keyword === "expected_move_unit_binding"));

  const unavailableDte = structuredClone(valid);
  unavailableDte.packet.claims[0].evidence = "Expected move unavailable without a complete snapshot; 7 DTE was requested.";
  assert.ok(!companySourceAcquisitionIssues(unavailableDte.packet, unavailableDte.run)
    .some((issue) => issue.keyword === "expected_move_unit_binding"));
});
