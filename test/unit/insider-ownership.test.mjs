import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchInsiderOwnership,
  parseOwnershipDocument,
  selectPointInTimeCommonSharesOutstanding,
} from "../../mcp/lib/insider-ownership.mjs";

/** A Form 4 with two non-derivative transactions and one derivative holding. */
function form4({ ownerCik = "0001780525", derivativeShares = "9000000" } = {}) {
  return `<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <periodOfReport>2026-06-15</periodOfReport>
  <issuer><issuerCik>0000320193</issuerCik><issuerTradingSymbol>AAPL</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>${ownerCik}</rptOwnerCik><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>120000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>95500</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>${derivativeShares}</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>`;
}

test("the holding kept is the one after the last non-derivative transaction", () => {
  const parsed = parseOwnershipDocument(form4());
  assert.equal(parsed.shares_owned, 95500);
  assert.equal(parsed.holding_bucket_count, 1);
  assert.equal(parsed.owner_cik, "0001780525");
  assert.equal(parsed.owner_name, "DOE JANE");
  assert.equal(parsed.is_officer, true);
  assert.equal(parsed.is_director, false);
  assert.equal(parsed.is_ten_percent_owner, false);
});

test("distinct direct, trust and LLC balances are summed without counting derivatives", () => {
  const indirect = `
    <nonDerivativeHolding>
      <securityTitle><value>Common Stock</value></securityTitle>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>468131547</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By Trust</value><footnoteId id="F3"/></natureOfOwnership></ownershipNature>
    </nonDerivativeHolding>
    <nonDerivativeHolding>
      <securityTitle><value>Common Stock</value></securityTitle>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>31421011</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By Irrevocable Trust</value><footnoteId id="F4"/></natureOfOwnership></ownershipNature>
    </nonDerivativeHolding>
    <nonDerivativeHolding>
      <securityTitle><value>Common Stock</value></securityTitle>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>109040602</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By Remainder Trust</value><footnoteId id="F5"/></natureOfOwnership></ownershipNature>
    </nonDerivativeHolding>
    <nonDerivativeHolding>
      <securityTitle><value>Common Stock</value></securityTitle>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>6632667</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By LLC</value><footnoteId id="F6"/></natureOfOwnership></ownershipNature>
    </nonDerivativeHolding>
    <nonDerivativeHolding>
      <securityTitle><value>Common Stock</value></securityTitle>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>6632667</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By LLC</value><footnoteId id="F7"/></natureOfOwnership></ownershipNature>
    </nonDerivativeHolding>
    ${["F8", "F9", "F10", "F11"].map((id) => `
      <nonDerivativeHolding>
        <securityTitle><value>Common Stock</value></securityTitle>
        <postTransactionAmounts><sharesOwnedFollowingTransaction><value>30000000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
        <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By LLC</value><footnoteId id="${id}"/></natureOfOwnership></ownershipNature>
      </nonDerivativeHolding>`).join("")}`;
  const xml = form4({ derivativeShares: "9000000" })
    .replace("<value>95500</value>", "<value>70146252</value>")
    .replace("</nonDerivativeTable>", `${indirect}</nonDerivativeTable>`);
  const parsed = parseOwnershipDocument(xml);
  assert.equal(parsed.shares_owned, 812_004_746);
  assert.equal(parsed.holding_bucket_count, 10);
});

test("an unexercised option is not stock and never reaches the register", () => {
  // The derivative block is deliberately far larger than the real holding: if it leaked in,
  // the sum would be off by two orders of magnitude rather than by a rounding error.
  const parsed = parseOwnershipDocument(form4({ derivativeShares: "9000000" }));
  assert.equal(parsed.shares_owned, 95500);
  assert.notEqual(parsed.shares_owned, 9_000_000);
});

test("the rendered HTML view is refused rather than half-parsed", () => {
  const rendered = "<!DOCTYPE html><html><head><title>SEC FORM 4</title></head><body>95,500</body></html>";
  assert.equal(parseOwnershipDocument(rendered), null);
});

test("a document with an owner but no reported holding produces nothing", () => {
  const noHolding = form4().replace(/<nonDerivativeTable>[\s\S]*?<\/nonDerivativeTable>/u, "");
  assert.equal(parseOwnershipDocument(noHolding), null);
});

test("an explicit noSecuritiesOwned Form 3 is a valid zero balance, not a parse failure", () => {
  const noSecurities = form4()
    .replace("<documentType>4</documentType>", "<documentType>3</documentType><noSecuritiesOwned>1</noSecuritiesOwned>")
    .replace(/<nonDerivativeTable>[\s\S]*?<\/nonDerivativeTable>/u, "");
  const parsed = parseOwnershipDocument(noSecurities);
  assert.equal(parsed.owner_cik, "0001780525");
  assert.equal(parsed.shares_owned, 0);
  assert.equal(parsed.holding_bucket_count, 0);
  assert.equal(parsed.explicitly_no_securities_owned, true);
});

test("a final no-longer-subject Form 4 supersedes stale holdings with a valid zero balance", () => {
  const finalForm = form4()
    .replace("<periodOfReport>", "<notSubjectToSection16>1</notSubjectToSection16><periodOfReport>")
    .replace(/<nonDerivativeTable>[\s\S]*?<\/nonDerivativeTable>/u, "");
  const parsed = parseOwnershipDocument(finalForm);
  assert.equal(parsed.owner_cik, "0001780525");
  assert.equal(parsed.shares_owned, 0);
  assert.equal(parsed.holding_bucket_count, 0);
  assert.equal(parsed.no_longer_subject_to_section16, true);
});

test("non-string and empty input never throw", () => {
  for (const input of [null, undefined, 42, "", "<ownershipDocument>"]) {
    assert.equal(parseOwnershipDocument(input), null);
  }
});

const shareFact = ({
  end = "2026-05-15",
  val = 1_000_000,
  filed = "2026-05-20",
  form = "10-Q",
  accn = "0000320193-26-000052",
} = {}) => ({ end, val, filed, form, accn, fy: 2027, fp: "Q1" });

function companyFacts({ dei = [], usGaap = [], weightedAverage = [] } = {}) {
  return {
    cik: 320193,
    entityName: "TEST ISSUER",
    facts: {
      dei: {
        EntityCommonStockSharesOutstanding: { units: { shares: dei } },
      },
      "us-gaap": {
        CommonStockSharesOutstanding: { units: { shares: usGaap } },
        WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: weightedAverage } },
      },
    },
  };
}

test("point-in-time shares prefer the latest eligible DEI cover fact filed by as_of", () => {
  const selected = selectPointInTimeCommonSharesOutstanding(companyFacts({
    dei: [
      shareFact(),
      shareFact({ end: "2026-07-31", val: 900_000, filed: "2026-08-20" }),
      shareFact({ end: "2026-07-20", val: 777_777, filed: "2026-07-21", form: "8-K" }),
    ],
    usGaap: [shareFact({ end: "2026-06-30", val: 1_100_000, filed: "2026-07-10" })],
  }), { asOf: "2026-08-03" });

  assert.equal(selected.value, 1_000_000);
  assert.equal(selected.measurement, "point_in_time_common_shares_outstanding");
  assert.equal(selected.taxonomy, "dei");
  assert.equal(selected.tag, "EntityCommonStockSharesOutstanding");
  assert.equal(selected.form, "10-Q");
  assert.equal(selected.period_end, "2026-05-15");
  assert.equal(selected.public_at, "2026-05-20T00:00:00.000Z");
  assert.match(selected.source_id, /EntityCommonStockSharesOutstanding/);
  assert.match(selected.source_url, /CIK0000320193\.json$/u);
});

test("us-gaap instant is the fallback, while annual weighted-average diluted shares are never eligible", () => {
  const fallback = selectPointInTimeCommonSharesOutstanding(companyFacts({
    dei: [shareFact({ val: 5_000_000, form: "8-K" })],
    usGaap: [shareFact({ val: 1_250_000, accn: "0000320193-26-000021", form: "10-K" })],
    weightedAverage: [shareFact({ val: 9_999_999, form: "10-K" })],
  }), { asOf: "2026-08-03" });
  assert.equal(fallback.value, 1_250_000);
  assert.equal(fallback.taxonomy, "us-gaap");
  assert.equal(fallback.tag, "CommonStockSharesOutstanding");

  const weightedOnly = selectPointInTimeCommonSharesOutstanding(companyFacts({
    weightedAverage: [shareFact({ val: 9_999_999, form: "10-K" })],
  }), { asOf: "2026-08-03" });
  assert.equal(weightedOnly.value, null);
  assert.match(weightedOnly.unavailable[0], /point-in-time common shares outstanding unavailable/u);
});

test("ambiguous same-date DEI contexts fail over rather than being summed or arbitrarily chosen", () => {
  const selected = selectPointInTimeCommonSharesOutstanding(companyFacts({
    dei: [shareFact({ val: 600_000 }), shareFact({ val: 400_000 })],
    usGaap: [shareFact({ val: 1_000_000, form: "10-K" })],
  }), { asOf: "2026-08-03" });
  assert.equal(selected.value, 1_000_000);
  assert.equal(selected.taxonomy, "us-gaap");
});

test("fetchInsiderOwnership divides by its CompanyFacts instant and exposes both numerator and denominator lineage", async () => {
  const originalFetch = globalThis.fetch;
  const submissions = {
    name: "TEST ISSUER",
    filings: {
      recent: {
        form: ["4"],
        accessionNumber: ["0000320193-26-000099"],
        primaryDocument: ["xslF345X06/form4.xml"],
        filingDate: ["2026-06-16"],
        reportDate: ["2026-06-15"],
        acceptanceDateTime: ["2026-06-16T16:00:00.000Z"],
      },
    },
  };
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      text: async () => String(url).includes("submissions/CIK") ? JSON.stringify(submissions) : form4(),
    };
  };
  try {
    const owned = await fetchInsiderOwnership("0000320193", {
      asOf: "2026-08-03",
      companyFacts: companyFacts({ dei: [shareFact()] }),
      documentCache: false,
    });
    assert.equal(owned.value, 0.0955);
    assert.equal(owned.shares_outstanding, 1_000_000);
    assert.equal(owned.shares_outstanding_measurement, "point_in_time_common_shares_outstanding");
    assert.equal(owned.denominator.tag, "EntityCommonStockSharesOutstanding");
    assert.equal(owned.public_at, "2026-06-16T00:00:00.000Z");
    assert.equal(owned.numerator_source_ids.length, 1);
    assert.equal(owned.numerator_sources.length, 1);
    assert.equal(owned.numerator_sources[0].accession, "0000320193-26-000099");
    assert.match(owned.numerator_sources[0].url, /000032019326000099\/form4\.xml$/u);
    assert.equal(owned.denominator_source_ids.length, 1);
    assert.deepEqual(owned.source_ids, [...owned.numerator_source_ids, ...owned.denominator_source_ids]);
    assert.equal(calls.length, 2, "one submissions index and one ownership XML; CompanyFacts was injected");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a partial Section 16 fetch failure withholds the canonical ownership ratio", async () => {
  const originalFetch = globalThis.fetch;
  const submissions = {
    name: "TEST ISSUER",
    filings: { recent: {
      form: ["4", "4"],
      accessionNumber: ["0000320193-26-000100", "0000320193-26-000099"],
      primaryDocument: ["form4.xml", "form4.xml"],
      filingDate: ["2026-06-17", "2026-06-16"],
      reportDate: ["2026-06-16", "2026-06-15"],
      acceptanceDateTime: ["2026-06-17T16:00:00.000Z", "2026-06-16T16:00:00.000Z"],
    } },
  };
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value.includes("submissions/CIK")) {
      return { ok: true, status: 200, text: async () => JSON.stringify(submissions) };
    }
    if (value.includes("000032019326000100")) {
      return { ok: false, status: 404, text: async () => "missing" };
    }
    return { ok: true, status: 200, text: async () => form4() };
  };
  try {
    const owned = await fetchInsiderOwnership("0000320193", {
      asOf: "2026-08-03",
      companyFacts: companyFacts({ dei: [shareFact()] }),
      documentCache: false,
    });
    assert.equal(owned.value, null);
    assert.match(owned.unavailable[0], /numerator is incomplete/u);
    assert.equal(owned.coverage.attempted_document_count, 2);
    assert.deepEqual(owned.coverage.unresolved_documents, [{
      accession: "0000320193-26-000100",
      failure_kind: "not_found",
      error: "HTTP 404 for https://www.sec.gov/Archives/edgar/data/320193/000032019326000100/form4.xml",
    }]);
    assert.equal(owned.insider_shares_lower_bound, 95_500);
    assert.equal(owned.ownership_ratio_lower_bound, 0.0955);
    assert.equal(owned.measurement, "partial_section16_lower_bound_not_canonical");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unavailable point-in-time denominator skips ownership before fetching Section 16 documents", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("should not fetch"); };
  try {
    const owned = await fetchInsiderOwnership("0000320193", {
      asOf: "2026-08-03",
      companyFacts: companyFacts({ weightedAverage: [shareFact({ val: 9_999_999, form: "10-K" })] }),
    });
    assert.equal(owned.value, null);
    assert.match(owned.unavailable[0], /skipped/u);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
