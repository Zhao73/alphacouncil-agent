import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSubmissionProfile } from "../../mcp/lib/sec.mjs";

const SUBMISSIONS = {
  name: "EXAMPLE CORP",
  tickers: ["EXM"],
  exchanges: ["Nasdaq"],
  sic: "3674",
  sicDescription: "Semiconductors & Related Devices",
  filings: {
    recent: {
      form: ["8-K", "SCHEDULE 13G"],
      accessionNumber: ["0001234567-26-000060", "0001234567-26-000062"],
      primaryDocument: ["event-20260628.htm", "xslSCHEDULE_13G_X01/primary_doc.xml"],
      filingDate: ["2026-07-02", "2026-07-20"],
      reportDate: ["2026-06-28", ""],
      acceptanceDateTime: ["2026-07-02T16:31:04.000Z", "2026-07-20T21:00:07.000Z"],
    },
  },
};

test("SEC submissions profile retains and sorts the authoritative recent filing records", () => {
  const profile = parseSubmissionProfile(SUBMISSIONS, "1234567", {
    retrievedAt: "2026-08-03T08:50:27.762Z",
  });

  assert.equal(profile.submissions_url, "https://data.sec.gov/submissions/CIK0001234567.json");
  assert.equal(profile.submissions_retrieved_at, "2026-08-03T08:50:27.762Z");
  assert.equal(profile.recent_filings_count, 2);
  assert.equal(profile.latest_filing.form, "SCHEDULE 13G");
  assert.equal(profile.latest_filing.filing_date, "2026-07-20");
  assert.equal(profile.latest_filing.accession, "0001234567-26-000062");
  assert.equal(
    profile.latest_filing.primary_document_url,
    "https://www.sec.gov/Archives/edgar/data/1234567/000123456726000062/xslSCHEDULE_13G_X01/primary_doc.xml",
  );
  assert.deepEqual(profile.recent_filings.map((filing) => filing.form), ["SCHEDULE 13G", "8-K"]);
});

test("SEC submissions profile bounds the prompt-facing recent slice without losing total coverage", () => {
  const profile = parseSubmissionProfile(SUBMISSIONS, "0001234567", { limit: 1 });

  assert.equal(profile.recent_filings_count, 2);
  assert.equal(profile.recent_filings.length, 1);
  assert.equal(profile.latest_filing.filing_date, "2026-07-20");
});
