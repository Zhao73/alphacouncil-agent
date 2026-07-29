/**
 * Insider and ten-percent-holder ownership, from Section 16 filings.
 *
 * The US has no "promoter" as a filing concept. What it does have is Section 16: officers,
 * directors and holders of more than ten percent must file Forms 3, 4 and 5, and each filing
 * states how many shares that person holds afterwards. Summing the newest filing per reporting
 * owner gives the share of the company held by the people who run it — the closest thing US
 * disclosure offers to the promoter shareholding record an Indian-method seat reads.
 *
 * It is a proxy, and the differences are real and are recorded on the fact rather than papered
 * over: Section 16 covers only insiders who cross the reporting threshold, holdings through
 * trusts and family partnerships are reported inconsistently, and a person who has not
 * transacted since their Form 3 is carried at that number. This is why the fact is labelled
 * `estimated` rather than `reported`.
 *
 * Cost is bounded by construction. Filings are read newest-first and an owner is taken once,
 * so the work is one fetch per distinct insider — roughly fifteen to thirty — not one per
 * filing, of which a large registrant has hundreds.
 */

import { fetchFilingDocument, fetchFilingIndex } from "./sec.mjs";

/** Section 16 ownership forms. 3 is the initial statement, 4 a change, 5 an annual catch-up. */
const OWNERSHIP_FORMS = new Set(["3", "4", "5", "3/A", "4/A", "5/A"]);

/** A registrant with more insiders than this is not a governance question, it is a bad parse. */
const MAX_DISTINCT_OWNERS = 60;

/** Below this share of the register the aggregate says nothing, so it refuses instead. */
export const MIN_OWNER_COVERAGE = 1;

function tagText(xml, tag) {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "u").exec(xml);
  return match ? match[1].trim() : null;
}

function allTagText(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gu"))].map((m) => m[1].trim());
}

/**
 * Shares held after the last transaction in one ownership document.
 *
 * A Form 4 carries one `<postTransactionAmounts>` block per non-derivative transaction, in
 * chronological order, so the LAST one is the holding to keep. Derivative holdings are
 * deliberately excluded: an unexercised option is not stock, and counting it would inflate the
 * register by shares that do not exist yet.
 */
export function parseOwnershipDocument(xml) {
  if (typeof xml !== "string" || !xml.includes("<ownershipDocument")) return null;
  const nonDerivative = xml.split("<derivativeTable")[0];
  const holdings = allTagText(nonDerivative, "sharesOwnedFollowingTransaction")
    .map((block) => {
      const value = Number(String(tagText(block, "value") ?? block).replace(/,/gu, ""));
      return Number.isFinite(value) ? value : null;
    })
    .filter((value) => value !== null);
  const ownerCik = tagText(xml, "rptOwnerCik");
  if (!ownerCik || !holdings.length) return null;
  return {
    owner_cik: String(ownerCik).replace(/\D/gu, "").padStart(10, "0"),
    owner_name: tagText(xml, "rptOwnerName"),
    is_director: tagText(xml, "isDirector") === "1",
    is_officer: tagText(xml, "isOfficer") === "1",
    is_ten_percent_owner: tagText(xml, "isTenPercentOwner") === "1",
    shares_owned: holdings.at(-1),
    period_of_report: tagText(xml, "periodOfReport"),
  };
}

function gap(reason, extra = {}) {
  return Object.freeze({ value: null, unavailable: [reason], ...extra });
}

/**
 * The share of the register held by Section 16 insiders.
 *
 * `sharesOutstanding` is supplied by the caller rather than fetched again, because the seat
 * that reads this already has a share count and two different counts would make the ratio
 * mean nothing.
 */
export async function fetchInsiderOwnership(cik, { sharesOutstanding, asOf = null, signal } = {}) {
  if (!Number.isFinite(sharesOutstanding) || sharesOutstanding <= 0) {
    return gap("insider ownership needs a positive share count to be a ratio; none was supplied");
  }
  let index;
  try {
    index = await fetchFilingIndex(cik, { signal });
  } catch (error) {
    return gap(`insider ownership: filing index unavailable (${String(error?.message || error)})`);
  }
  const cutoff = asOf ? Date.parse(`${asOf}T23:59:59.999Z`) : Number.POSITIVE_INFINITY;
  const ownershipFilings = index.filings
    .filter((row) => OWNERSHIP_FORMS.has(row.form))
    .filter((row) => Date.parse(`${row.filing_date}T00:00:00.000Z`) <= cutoff)
    .filter((row) => /\.xml$/iu.test(row.primary_document || ""))
    // EDGAR names the XSL-RENDERED view as the primary document (`xslF345X06/form4.xml`),
    // which is HTML. The machine-readable source sits beside it in the same folder under the
    // same leaf name, so the stylesheet directory is what has to go.
    .map((row) => ({ ...row, primary_document: row.primary_document.replace(/^xsl[^/]*\//u, "") }));
  if (!ownershipFilings.length) {
    return gap(`insider ownership: ${index.name || cik} has filed no Section 16 ownership document`);
  }

  const byOwner = new Map();
  const sources = [];
  let newestFiling = null;
  for (const filing of ownershipFilings) {
    if (byOwner.size >= MAX_DISTINCT_OWNERS) break;
    let document;
    try {
      document = await fetchFilingDocument(index.cik, filing.accession, filing.primary_document, { signal });
    } catch {
      continue;
    }
    const parsed = parseOwnershipDocument(document.text);
    if (!parsed || byOwner.has(parsed.owner_cik)) continue;
    byOwner.set(parsed.owner_cik, { ...parsed, filing_date: filing.filing_date, url: document.url });
    sources.push(`sec:ownership:${index.cik}:${filing.accession}`);
    if (!newestFiling || filing.filing_date > newestFiling) newestFiling = filing.filing_date;
  }
  if (byOwner.size < MIN_OWNER_COVERAGE) {
    return gap(`insider ownership: no Section 16 document for ${index.name || cik} could be parsed`);
  }

  const shares = [...byOwner.values()].reduce((total, owner) => total + owner.shares_owned, 0);
  const value = shares / sharesOutstanding;
  // A ratio above one is not a concentrated register, it is a share count from a different
  // basis than the holdings — a stale count, or an ADR ratio. Refusing beats reporting 340%.
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    return gap("insider ownership: summed insider holdings do not reconcile against the supplied share count", {
      insider_shares: shares,
      shares_outstanding: sharesOutstanding,
    });
  }
  return Object.freeze({
    value,
    insider_shares: shares,
    shares_outstanding: sharesOutstanding,
    owner_count: byOwner.size,
    ten_percent_owner_count: [...byOwner.values()].filter((owner) => owner.is_ten_percent_owner).length,
    as_of: newestFiling,
    public_at: newestFiling,
    source_ids: sources,
    source_url: `https://data.sec.gov/submissions/CIK${index.cik}.json`,
    method: "sum of the newest Section 16 holding per reporting owner, over shares outstanding",
    unavailable: [],
  });
}
