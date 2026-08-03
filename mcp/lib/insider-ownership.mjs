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

import { fetchCompanyFacts, fetchFilingDocument, fetchFilingIndex } from "./sec.mjs";

/** Section 16 ownership forms. 3 is the initial statement, 4 a change, 5 an annual catch-up. */
const OWNERSHIP_FORMS = new Set(["3", "4", "5", "3/A", "4/A", "5/A"]);

/** A registrant with more insiders than this is not a governance question, it is a bad parse. */
const MAX_DISTINCT_OWNERS = 60;

/** Filings read per round. SEC's ~10 req/s guidance is enforced by the client's own throttle. */
const OWNERSHIP_BATCH = 8;

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
 * A Form 4 can carry both transaction rows and separate non-derivative holding rows for direct
 * stock, trusts, partnerships and LLCs. Transaction rows for the same ownership bucket are
 * chronological, so the last balance in that bucket wins; distinct holding buckets must be
 * SUMMED. Taking the last balance in the whole document drops every disclosed indirect holding.
 * Derivative holdings remain excluded: an unexercised option is not stock, and counting it would
 * inflate the register by shares that do not exist yet.
 */
export function parseOwnershipDocument(xml) {
  if (typeof xml !== "string" || !xml.includes("<ownershipDocument")) return null;
  const nonDerivative = tagText(xml, "nonDerivativeTable") || xml.split("<derivativeTable")[0];
  const rowBlocks = [
    ...allTagText(nonDerivative, "nonDerivativeTransaction"),
    ...allTagText(nonDerivative, "nonDerivativeHolding"),
  ];
  const byHoldingBucket = new Map();
  for (const row of rowBlocks) {
    const amountBlock = tagText(row, "sharesOwnedFollowingTransaction");
    const value = Number(String(tagText(amountBlock || "", "value") ?? amountBlock ?? "").replace(/,/gu, ""));
    if (!Number.isFinite(value)) continue;
    const ownershipBlock = tagText(row, "ownershipNature") || "";
    const natureBlock = tagText(ownershipBlock, "natureOfOwnership") || "";
    const footnotes = [...natureBlock.matchAll(/<footnoteId\s+id=["']([^"']+)["'][^>]*\/?\s*>/gu)]
      .map((match) => match[1])
      .sort()
      .join(",");
    const key = [
      tagText(tagText(row, "securityTitle") || "", "value") || "unknown_security",
      tagText(tagText(ownershipBlock, "directOrIndirectOwnership") || "", "value") || "unknown_ownership",
      tagText(natureBlock, "value") || "",
      footnotes,
    ].join("|");
    // Row order is preserved. Repeated transactions in one bucket overwrite the earlier
    // post-transaction balance; distinct direct/indirect entities retain separate keys.
    byHoldingBucket.set(key, value);
  }
  const holdings = [...byHoldingBucket.values()];
  const ownerCik = tagText(xml, "rptOwnerCik");
  if (!ownerCik || !holdings.length) return null;
  return {
    owner_cik: String(ownerCik).replace(/\D/gu, "").padStart(10, "0"),
    owner_name: tagText(xml, "rptOwnerName"),
    is_director: tagText(xml, "isDirector") === "1",
    is_officer: tagText(xml, "isOfficer") === "1",
    is_ten_percent_owner: tagText(xml, "isTenPercentOwner") === "1",
    shares_owned: holdings.reduce((total, value) => total + value, 0),
    holding_bucket_count: holdings.length,
    period_of_report: tagText(xml, "periodOfReport"),
  };
}

function gap(reason, extra = {}) {
  return Object.freeze({ value: null, unavailable: [reason], ...extra });
}

/** Cover-page/instant share concepts, in the required source-preference order. */
export const POINT_IN_TIME_SHARE_CONCEPTS = Object.freeze([
  Object.freeze({ taxonomy: "dei", tag: "EntityCommonStockSharesOutstanding" }),
  Object.freeze({ taxonomy: "us-gaap", tag: "CommonStockSharesOutstanding" }),
]);

/** Forms whose cover page or balance sheet establishes an issuer share count. */
const POINT_IN_TIME_SHARE_FORMS = new Set(["10-K", "10-K/A", "10-Q", "10-Q/A"]);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/u;

function cutoffTime(asOf) {
  if (asOf === null || asOf === undefined || asOf === "") return Number.POSITIVE_INFINITY;
  const text = String(asOf);
  return Date.parse(DATE_ONLY.test(text) ? `${text}T23:59:59.999Z` : text);
}

const publicInstant = (filed) => {
  const time = Date.parse(`${filed}T00:00:00.000Z`);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const paddedCik = (value) => {
  const digits = String(value ?? "").replace(/\D/gu, "");
  return digits ? digits.padStart(10, "0") : null;
};

/**
 * Newest SEC CompanyFacts point-in-time common-share count visible at `asOf`.
 *
 * This is intentionally separate from the annual weighted-average diluted count used for EPS.
 * An ownership register needs the cover-page stock actually outstanding at one date. DEI is
 * preferred because that is exactly what its cover concept means; the us-gaap instant is used
 * only when no unambiguous eligible DEI observation exists.
 */
export function selectPointInTimeCommonSharesOutstanding(companyFacts, { asOf = null, cik = null } = {}) {
  const cutoff = cutoffTime(asOf);
  if (!companyFacts || typeof companyFacts !== "object" || !Number.isFinite(cutoff)) {
    return gap("point-in-time common shares outstanding: invalid CompanyFacts or as_of input");
  }
  const resolvedCik = paddedCik(cik || companyFacts.cik);
  const rejected = [];

  for (const concept of POINT_IN_TIME_SHARE_CONCEPTS) {
    const rows = companyFacts?.facts?.[concept.taxonomy]?.[concept.tag]?.units?.shares;
    if (!Array.isArray(rows)) {
      rejected.push(`${concept.taxonomy}:${concept.tag} absent`);
      continue;
    }
    const eligible = rows.filter((entry) => (
      POINT_IN_TIME_SHARE_FORMS.has(entry.form)
      && !entry.start
      && typeof entry.end === "string"
      && Date.parse(`${entry.end}T00:00:00.000Z`) <= cutoff
      && typeof entry.filed === "string"
      && Date.parse(`${entry.filed}T00:00:00.000Z`) <= cutoff
      && Number.isFinite(entry.val)
      && entry.val > 0
    )).sort((left, right) => (
      Date.parse(right.end) - Date.parse(left.end)
      || Date.parse(right.filed) - Date.parse(left.filed)
    ));
    if (!eligible.length) {
      rejected.push(`${concept.taxonomy}:${concept.tag} has no eligible 10-K/10-Q instant filed by as_of`);
      continue;
    }

    const newest = eligible[0];
    const sameObservation = eligible.filter((entry) => (
      entry.end === newest.end && entry.filed === newest.filed
    ));
    const values = new Set(sameObservation.map((entry) => entry.val));
    if (values.size !== 1) {
      // CompanyFacts removes XBRL dimensions. Different values on the same observation date
      // may be distinct share classes, but they may also be duplicate contexts; summing or
      // choosing either one would manufacture a denominator.
      rejected.push(`${concept.taxonomy}:${concept.tag} is ambiguous at ${newest.end} (${values.size} values)`);
      continue;
    }
    const filedAt = publicInstant(newest.filed);
    if (!filedAt) {
      rejected.push(`${concept.taxonomy}:${concept.tag} has an invalid filed date`);
      continue;
    }
    const sourceId = `sec:companyfacts:${resolvedCik || "unknown"}:${concept.tag}:${newest.accn || newest.filed}:${newest.end}`;
    return Object.freeze({
      value: newest.val,
      unit: "shares",
      measurement: "point_in_time_common_shares_outstanding",
      taxonomy: concept.taxonomy,
      tag: concept.tag,
      form: newest.form,
      accession: newest.accn || null,
      period_end: newest.end,
      filed: newest.filed,
      public_at: filedAt,
      as_of: asOf || null,
      source_id: sourceId,
      source_url: resolvedCik
        ? `https://data.sec.gov/api/xbrl/companyfacts/CIK${resolvedCik}.json`
        : null,
      method: `${concept.taxonomy}:${concept.tag} instant from the newest eligible 10-K/10-Q filed by as_of`,
      unavailable: [],
    });
  }

  return gap(
    `point-in-time common shares outstanding unavailable (${rejected.join("; ")})`,
    { measurement: "point_in_time_common_shares_outstanding", concepts_tried: POINT_IN_TIME_SHARE_CONCEPTS },
  );
}

export async function fetchPointInTimeCommonSharesOutstanding(cik, { asOf = null, signal, companyFacts = null } = {}) {
  let facts = companyFacts;
  if (!facts) {
    try {
      facts = await fetchCompanyFacts(cik, { signal });
    } catch (error) {
      return gap(`point-in-time common shares outstanding: CompanyFacts unavailable (${String(error?.message || error)})`);
    }
  }
  return selectPointInTimeCommonSharesOutstanding(facts, { asOf, cik });
}

/**
 * The share of the register held by Section 16 insiders.
 *
 * The denominator is fetched from SEC CompanyFacts here and must be a point-in-time common
 * share count. The annual weighted-average diluted count is an EPS period measure and is never
 * accepted as an ownership-register denominator.
 */
export async function fetchInsiderOwnership(cik, { asOf = null, signal, companyFacts = null } = {}) {
  const denominator = await fetchPointInTimeCommonSharesOutstanding(cik, { asOf, signal, companyFacts });
  if (!Number.isFinite(denominator.value) || denominator.value <= 0) {
    return gap(`insider ownership skipped: ${denominator.unavailable?.[0] || "point-in-time common shares outstanding unavailable"}`, {
      denominator,
    });
  }
  const sharesOutstanding = denominator.value;
  let index;
  try {
    index = await fetchFilingIndex(cik, { signal });
  } catch (error) {
    return gap(`insider ownership: filing index unavailable (${String(error?.message || error)})`);
  }
  const cutoff = cutoffTime(asOf);
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
  const numeratorSources = [];
  const unresolvedDocuments = [];
  let attemptedDocumentCount = 0;
  let newestFiling = null;
  // Read in bounded concurrent batches rather than one filing at a time. Sequentially this was
  // up to sixty throttled round trips on the critical path of every company run, which is what
  // pushed grounding past its budget -- and a budget overrun used to discard the whole run's
  // evidence. Newest-first order is preserved across batches, so an owner is still taken from
  // their most recent filing.
  const candidates = ownershipFilings.slice(0, MAX_DISTINCT_OWNERS * 3);
  for (let offset = 0; offset < candidates.length && byOwner.size < MAX_DISTINCT_OWNERS; offset += OWNERSHIP_BATCH) {
    const batch = candidates.slice(offset, offset + OWNERSHIP_BATCH);
    const documents = await Promise.all(batch.map((filing) => (
      fetchFilingDocument(index.cik, filing.accession, filing.primary_document, { signal })
        .then((document) => ({ filing, document }))
        .catch(() => ({ filing, failure_kind: "fetch_failed" }))
    )));
    for (const entry of documents) {
      attemptedDocumentCount += 1;
      if (entry.failure_kind) {
        unresolvedDocuments.push({ accession: entry.filing.accession, failure_kind: entry.failure_kind });
        continue;
      }
      const parsed = parseOwnershipDocument(entry.document.text);
      if (!parsed) {
        unresolvedDocuments.push({ accession: entry.filing.accession, failure_kind: "parse_failed" });
        continue;
      }
      if (byOwner.has(parsed.owner_cik)) continue;
      byOwner.set(parsed.owner_cik, { ...parsed, filing_date: entry.filing.filing_date, url: entry.document.url });
      numeratorSources.push(Object.freeze({
        source_id: `sec:ownership:${index.cik}:${entry.filing.accession}`,
        accession: entry.filing.accession,
        form: entry.filing.form,
        filing_date: entry.filing.filing_date,
        report_date: entry.filing.report_date || parsed.period_of_report || null,
        owner_cik: parsed.owner_cik,
        url: entry.document.url,
      }));
      if (!newestFiling || entry.filing.filing_date > newestFiling) newestFiling = entry.filing.filing_date;
    }
  }
  if (unresolvedDocuments.length) {
    return gap(`insider ownership: ${unresolvedDocuments.length} Section 16 candidate document(s) could not be resolved, so the numerator is incomplete`, {
      denominator,
      coverage: Object.freeze({
        candidate_count: candidates.length,
        attempted_document_count: attemptedDocumentCount,
        resolved_owner_count: byOwner.size,
        unresolved_documents: Object.freeze(unresolvedDocuments),
      }),
    });
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
      denominator,
    });
  }
  const ownershipPublicAt = publicInstant(newestFiling);
  const ratioPublicAt = [ownershipPublicAt, denominator.public_at]
    .filter(Boolean)
    .sort((left, right) => Date.parse(left) - Date.parse(right))
    .at(-1) || null;
  const numeratorSourceIds = Object.freeze(numeratorSources.map((source) => source.source_id));
  const denominatorSourceIds = Object.freeze([denominator.source_id]);
  const reportDates = [...byOwner.values()]
    .map((owner) => owner.period_of_report || owner.filing_date)
    .filter((date) => DATE_ONLY.test(String(date || "")))
    .sort();
  return Object.freeze({
    value,
    insider_shares: shares,
    shares_outstanding: sharesOutstanding,
    shares_outstanding_measurement: denominator.measurement,
    owner_count: byOwner.size,
    ten_percent_owner_count: [...byOwner.values()].filter((owner) => owner.is_ten_percent_owner).length,
    as_of: newestFiling,
    public_at: ratioPublicAt,
    owner_report_date_min: reportDates[0] || null,
    owner_report_date_max: reportDates.at(-1) || null,
    numerator_sources: Object.freeze(numeratorSources),
    numerator_source_ids: numeratorSourceIds,
    denominator_source_ids: denominatorSourceIds,
    source_ids: Object.freeze([...numeratorSourceIds, ...denominatorSourceIds]),
    source_url: `https://data.sec.gov/submissions/CIK${index.cik}.json`,
    source_urls: Object.freeze({
      numerator_index: `https://data.sec.gov/submissions/CIK${index.cik}.json`,
      numerator_documents: Object.freeze(numeratorSources.map((source) => source.url)),
      denominator: denominator.source_url,
    }),
    coverage: Object.freeze({
      candidate_count: candidates.length,
      attempted_document_count: attemptedDocumentCount,
      resolved_owner_count: byOwner.size,
      unresolved_document_count: 0,
      candidate_window_truncated: ownershipFilings.length > candidates.length,
    }),
    denominator,
    method: "sum of every distinct non-derivative holding bucket in the newest Section 16 document per reporting owner, divided by SEC CompanyFacts point-in-time common shares outstanding",
    unavailable: [],
  });
}
