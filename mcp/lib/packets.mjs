import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIMITS, MASTER_STANCES, RATINGS } from "./constants.mjs";
// A worker returning a malformed packet is a client contract violation, not a server bug:
// these three checks used to raise -32603 while the equivalent checks in the orchestrator
// correctly raised -32602.
import { invalidParams } from "./errors.mjs";
import { isChineseLanguage, languageKey, localized } from "./lang.mjs";
import {
  composeVoiceStatement,
  FIRST_PERSON_DISCLOSURE_ACK,
  FIRST_PERSON_VOICE_MODE,
  hasAnyFirstPersonMarker,
  intentsForStance,
  isIntentAllowed,
  VOICE_FIELDS,
  voiceDisclaimer,
} from "./voice.mjs";
import { cleanLog, clip } from "./text.mjs";
import { scopedSourceId, sourceManifest } from "./gates.mjs";
import { runPath } from "./run-store.mjs";
import { packetSummary } from "./markdown.mjs";
import { parseJsonTransport, parseJsonTransportCandidates } from "./bounded-json.mjs";
import { assertRuntimeWorkerPayload } from "./runtime-validation.mjs";
import { canonicalJson } from "./personas-v3/canonical.mjs";

export function rawRecordText(packet) {
  if (typeof packet?.raw_text === "string" && packet.raw_text.trim()) return packet.raw_text;
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) return JSON.stringify(packet || {}, null, 2);
  const { raw_text, ...withoutRawText } = packet;
  return JSON.stringify(withoutRawText, null, 2);
}

export function extractJson(text) {
  return parseJsonTransport(text).value;
}

export function extractWorkerJson(text, kind) {
  return assertRuntimeWorkerPayload(kind, extractJson(text));
}

/**
 * A parse-only repair worker may accidentally append a diagnostic JSON object to the repaired
 * packet. Accept a result only when runtime-schema validation leaves exactly one distinct
 * contract-valid value; two different valid packets and any truncated extra root stay
 * ambiguous and fail closed. Initial workers never use this arbiter.
 */
export function extractRepairedWorkerJson(text, kind) {
  try {
    return extractWorkerJson(text, kind);
  } catch (error) {
    if (error?.data?.reason !== "WORKER_JSON_MULTIPLE_VALUES") throw error;
    let candidates;
    try {
      candidates = parseJsonTransportCandidates(text);
    } catch {
      throw error;
    }
    const valid = [];
    for (const candidate of candidates) {
      try {
        valid.push(assertRuntimeWorkerPayload(kind, candidate));
      } catch (candidateError) {
        if (candidateError?.data?.reason !== "WORKER_OUTPUT_SCHEMA_MISMATCH") {
          throw candidateError;
        }
        // A non-contract JSON diagnostic is transport noise, not a competing packet.
      }
    }
    const distinct = new Map(valid.map((candidate) => [canonicalJson(candidate), candidate]));
    if (distinct.size === 1) return distinct.values().next().value;
    throw error;
  }
}

function sourceIdList(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
}

const NEWS_TASK = "news_industry_management";
const OFFICIAL_SOURCE_COVERAGE_SCHEMA_ID = "news-official-source-coverage-v1";
const COVERAGE_STATUSES = new Set(["complete", "incomplete"]);
const NEWS_CLAIM_TYPES = new Set(["event_or_observation", "absence_no_event"]);
const NO_EVENT_CONCLUSION_PATTERNS = [
  /\b(?:there\s+(?:is|are|was|were)|we\s+(?:found|identified))\s+no\b.{0,48}\b(?:news|event|filing|announcement|executive|management|change|update)s?\b/iu,
  /\bno\s+(?:recent|new|material|official)?\s*(?:news|event|filing|announcement|executive|management|change|update)s?\b/iu,
  /(?:没有|未发现|并无|不存在|无)(?:任何|近期|新的|重大|官方)?(?:新闻|事件|公告|申报|高管变动|管理层变化|更新)/u,
  /(?:最近|新たな|重大な)?(?:ニュース|発表|提出|経営陣の変更|更新).{0,16}(?:ない|なし|見当たらない)/u,
  /(?:최근|새로운|중대한|공식)?(?:뉴스|발표|공시|경영진 변경|업데이트).{0,16}(?:없|않)/u,
];

function looksLikeNoEventConclusion(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return Boolean(text) && NO_EVENT_CONCLUSION_PATTERNS.some((pattern) => pattern.test(text));
}

function normalizedNewsClaimType(claim) {
  // Obvious absence language wins over a worker-supplied label. The model cannot bypass an
  // incomplete official-source gate by calling "no recent official news" an observation.
  if (looksLikeNoEventConclusion(claim?.claim)) return "absence_no_event";
  return NEWS_CLAIM_TYPES.has(claim?.claim_type) ? claim.claim_type : claim?.claim_type;
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mappedCoverageSourceId(value, task, sourceIdMap) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw ? (sourceIdMap.get(raw) || scopedSourceId(task, raw)) : "";
}

function normalizeCoverageItem(value, task, sourceIdMap) {
  if (!objectRecord(value)) return value;
  return {
    title: typeof value.title === "string" ? value.title.trim() : value.title,
    published_at: typeof value.published_at === "string" ? value.published_at.trim() : value.published_at,
    url: typeof value.url === "string" ? value.url.trim() : value.url,
    source_id: mappedCoverageSourceId(value.source_id, task, sourceIdMap),
    ...(value.record_id !== undefined
      ? { record_id: typeof value.record_id === "string" ? value.record_id.trim() : value.record_id }
      : {}),
  };
}

function normalizeCoverageSurface(value, task, sourceIdMap) {
  if (!objectRecord(value)) return value;
  return {
    status: typeof value.status === "string" ? value.status.trim() : value.status,
    entry_url: typeof value.entry_url === "string" ? value.entry_url.trim() : value.entry_url ?? null,
    checked_through: typeof value.checked_through === "string" ? value.checked_through.trim() : value.checked_through ?? null,
    latest_dated_item: value.latest_dated_item == null
      ? null
      : normalizeCoverageItem(value.latest_dated_item, task, sourceIdMap),
    dated_items_checked: Array.isArray(value.dated_items_checked)
      ? value.dated_items_checked.map((item) => normalizeCoverageItem(item, task, sourceIdMap))
      : value.dated_items_checked,
    gap: typeof value.gap === "string" ? value.gap.trim() : value.gap ?? null,
  };
}

function normalizeOfficialSourceCoverage(value, task, sourceIdMap) {
  if (!objectRecord(value)) return value;
  return {
    status: typeof value.status === "string" ? value.status.trim() : value.status,
    regulator: normalizeCoverageSurface(value.regulator, task, sourceIdMap),
    issuer: normalizeCoverageSurface(value.issuer, task, sourceIdMap),
  };
}

function coverageGapQuestions(coverage) {
  if (!objectRecord(coverage)) return [];
  return [coverage.regulator, coverage.issuer]
    .filter((surface) => objectRecord(surface) && surface.status === "incomplete")
    .map((surface) => typeof surface.gap === "string" ? surface.gap.trim() : "")
    .filter(Boolean);
}

function coverageSourceIds(coverage) {
  if (!objectRecord(coverage)) return [];
  return sourceIdList([coverage.regulator, coverage.issuer].flatMap((surface) => {
    if (!objectRecord(surface)) return [];
    return [
      surface.latest_dated_item?.source_id,
      ...(Array.isArray(surface.dated_items_checked)
        ? surface.dated_items_checked.map((item) => item?.source_id)
        : []),
    ];
  }));
}

/**
 * Bind the US regulator surface to the SEC feed already fetched deterministically during
 * grounding. A model should not have to rediscover or copy this URL inventory perfectly, and a
 * parse-only repair cannot invent a missing primary-document source. The issuer surface remains
 * wholly worker-supplied and fail-closed; this adapter only materializes facts the server already
 * fetched before the worker started.
 */
export function applyGroundedRegulatorCoverage(packet, {
  task = packet?.task,
  asOfDate = packet?.as_of,
  grounding = null,
} = {}) {
  if (task !== NEWS_TASK || !objectRecord(packet?.official_source_coverage)) return packet;
  const coverage = packet.official_source_coverage;
  if (!objectRecord(coverage.regulator) || !objectRecord(coverage.issuer)) return packet;
  const filer = grounding?.filer;
  const expected = filer?.latest_filing;
  const entryUrl = normalizedHttpUrl(filer?.submissions_url);
  const itemUrl = normalizedHttpUrl(expected?.primary_document_url);
  const publishedAt = typeof expected?.filing_date === "string" ? expected.filing_date : null;
  if (!entryUrl || !itemUrl || !exactIsoDay(publishedAt) || !exactIsoDay(asOfDate)) return packet;
  // Real grounding always records gathered_at. Synthetic/dry-run fixtures predating that
  // field are bounded by their declared as_of; they cannot bypass the separate councilAsOf
  // future-date rejection at the execution boundary.
  const retrievedThrough = grounding?.gathered_at ? isoDay(grounding.gathered_at) : asOfDate;

  packet.sources = Array.isArray(packet.sources) ? packet.sources : [];
  let source = packet.sources.find((candidate) => (
    normalizedHttpUrl(candidate?.url) === itemUrl && isoDay(candidate?.published_at) === publishedAt
  ));
  if (!source) {
    const baseId = scopedSourceId(task, "GROUNDED_REGULATOR_LATEST");
    let sourceId = baseId;
    let suffix = 2;
    const used = new Set(packet.sources.map((candidate) => candidate?.id));
    while (used.has(sourceId)) {
      sourceId = `${baseId}_${suffix}`;
      suffix += 1;
    }
    source = {
      id: sourceId,
      title: `SEC ${expected.form || "filing"} ${expected.accession || publishedAt}`,
      url: expected.primary_document_url,
      published_at: publishedAt,
      retrieved_at: grounding?.gathered_at || asOfDate,
    };
    packet.sources.push(source);
  }
  const item = {
    title: source.title,
    published_at: publishedAt,
    url: expected.primary_document_url,
    source_id: source.id,
    ...(expected.accession ? { record_id: expected.accession } : {}),
  };
  const priorGap = typeof coverage.regulator.gap === "string" ? coverage.regulator.gap.trim() : "";
  if (!retrievedThrough || asOfDate > retrievedThrough) {
    const gap = retrievedThrough
      ? `SEC official surface was retrieved through ${retrievedThrough} and cannot certify the future cutoff ${asOfDate}`
      : `SEC official surface has no valid retrieval timestamp and cannot certify cutoff ${asOfDate}`;
    coverage.regulator = {
      status: "incomplete",
      entry_url: filer.submissions_url,
      checked_through: retrievedThrough,
      latest_dated_item: item,
      dated_items_checked: [item],
      gap,
    };
    coverage.status = "incomplete";
    packet.open_questions = Array.isArray(packet.open_questions) ? packet.open_questions : [];
    if (!packet.open_questions.includes(gap)) packet.open_questions.push(gap);
    return packet;
  }
  coverage.regulator = {
    status: "complete",
    entry_url: filer.submissions_url,
    checked_through: asOfDate,
    latest_dated_item: item,
    dated_items_checked: [item],
    gap: null,
  };
  coverage.status = coverage.issuer.status === "complete" ? "complete" : "incomplete";
  if (priorGap && Array.isArray(packet.open_questions)) {
    packet.open_questions = packet.open_questions.filter((question) => question !== priorGap);
  }
  return packet;
}

function parsedInstant(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().toLowerCase() === "unknown") return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

function isoDay(value) {
  const instant = parsedInstant(value);
  return instant === null ? null : new Date(instant).toISOString().slice(0, 10);
}

function exactIsoDay(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && isoDay(value) === value;
}

function normalizedHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) return null;
    parsed.hash = "";
    return parsed.href.replace(/\/$/u, "");
  } catch {
    return null;
  }
}

function hostname(value) {
  const normalized = normalizedHttpUrl(value);
  return normalized ? new URL(normalized).hostname.toLowerCase() : null;
}

function commonSiteHost(first, second) {
  const left = hostname(first);
  const right = hostname(second);
  if (!left || !right) return false;
  if (left === right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`)) return true;
  const siteKey = (host) => {
    const parts = host.split(".");
    const commonSecondLevel = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);
    const length = parts.at(-1)?.length === 2 && commonSecondLevel.has(parts.at(-2)) ? 3 : 2;
    return parts.length >= length ? parts.slice(-length).join(".") : host;
  };
  return siteKey(left) === siteKey(right);
}

function coverageIssue(errors, path, keyword, message, missingProperty) {
  errors.push({
    path,
    keyword,
    message,
    ...(missingProperty ? { missing_property: missingProperty } : {}),
  });
}

function validateCoverageItem(item, path, context, errors) {
  if (!objectRecord(item)) {
    coverageIssue(errors, path, "type", "must be an object");
    return null;
  }
  for (const field of ["title", "published_at", "url", "source_id"]) {
    if (typeof item[field] !== "string" || !item[field].trim()) {
      coverageIssue(errors, path, "required", `${field} must be a non-empty string`, field);
    }
  }
  const published = parsedInstant(item.published_at);
  if (published === null) coverageIssue(errors, `${path}/published_at`, "format", "must be a dated value, never unknown");
  else if (published > context.asOfEnd) coverageIssue(errors, `${path}/published_at`, "point_in_time", "must not be after as_of");
  const itemUrl = normalizedHttpUrl(item.url);
  if (!itemUrl) coverageIssue(errors, `${path}/url`, "format", "must be an absolute http(s) URL");
  else if (context.entryUrl && !commonSiteHost(context.entryUrl, item.url)) {
    coverageIssue(errors, `${path}/url`, "official_host", "must be on the same official site as entry_url");
  }
  const source = context.sourceById.get(item.source_id);
  if (!source) {
    coverageIssue(errors, `${path}/source_id`, "source_resolution", "must resolve to packet.sources");
  } else {
    const sourceUrl = normalizedHttpUrl(source.url);
    if (itemUrl && sourceUrl !== itemUrl) {
      coverageIssue(errors, `${path}/url`, "source_alignment", "must equal the resolved source URL");
    }
    if (isoDay(source.published_at) !== isoDay(item.published_at)) {
      coverageIssue(errors, `${path}/published_at`, "source_alignment", "must match the resolved source publication date");
    }
  }
  return published;
}

function validateCoverageSurface(name, surface, context, errors) {
  const path = `/official_source_coverage/${name}`;
  if (!objectRecord(surface)) {
    coverageIssue(errors, path, "required", "must be an object", name);
    return;
  }
  if (!COVERAGE_STATUSES.has(surface.status)) {
    coverageIssue(errors, `${path}/status`, "enum", "must be complete or incomplete");
  }
  const entryUrl = normalizedHttpUrl(surface.entry_url);
  if (surface.status === "complete" && !entryUrl) {
    coverageIssue(errors, `${path}/entry_url`, "format", "complete coverage requires an absolute http(s) entry URL");
  } else if (surface.entry_url != null && !entryUrl) {
    coverageIssue(errors, `${path}/entry_url`, "format", "must be null or an absolute http(s) URL");
  }
  if (surface.status === "complete" && surface.checked_through !== context.asOfDate) {
    coverageIssue(errors, `${path}/checked_through`, "coverage_cutoff", "complete coverage must be checked through as_of exactly");
  } else if (surface.checked_through != null) {
    if (!exactIsoDay(surface.checked_through)) {
      coverageIssue(errors, `${path}/checked_through`, "format", "must be a valid YYYY-MM-DD date or null");
    } else if (surface.checked_through > context.asOfDate) {
      coverageIssue(errors, `${path}/checked_through`, "point_in_time", "must not be after as_of");
    }
  }
  if (surface.status === "complete" && (!context.retrievedThroughDay || surface.checked_through > context.retrievedThroughDay)) {
    coverageIssue(
      errors,
      `${path}/checked_through`,
      "retrieval_cutoff",
      context.retrievedThroughDay
        ? `complete coverage cannot extend beyond actual retrieval day ${context.retrievedThroughDay}`
        : "complete coverage requires a valid grounding retrieval timestamp",
    );
  }
  if (surface.status === "incomplete" && (typeof surface.gap !== "string" || !surface.gap.trim())) {
    coverageIssue(errors, `${path}/gap`, "required", "incomplete coverage requires a non-empty gap", "gap");
  }
  if (surface.status === "complete" && typeof surface.gap === "string" && surface.gap.trim()) {
    coverageIssue(errors, `${path}/gap`, "consistency", "complete coverage cannot also declare a gap");
  }
  if (!Array.isArray(surface.dated_items_checked)) {
    coverageIssue(errors, `${path}/dated_items_checked`, "type", "must be an array");
    return;
  }
  if (surface.status === "complete" && surface.dated_items_checked.length === 0) {
    coverageIssue(errors, `${path}/dated_items_checked`, "minItems", "complete coverage requires at least one dated official item");
  }
  const itemContext = { ...context, entryUrl };
  const dated = surface.dated_items_checked.map((item, index) => ({
    item,
    instant: validateCoverageItem(item, `${path}/dated_items_checked/${index}`, itemContext, errors),
  }));
  if (surface.latest_dated_item == null) {
    if (surface.status === "complete") {
      coverageIssue(errors, `${path}/latest_dated_item`, "required", "complete coverage requires the latest dated item", "latest_dated_item");
    }
    return;
  }
  const latestInstant = validateCoverageItem(surface.latest_dated_item, `${path}/latest_dated_item`, itemContext, errors);
  const latestDay = isoDay(surface.latest_dated_item.published_at);
  const observedDays = dated.map(({ item }) => isoDay(item?.published_at)).filter(Boolean).sort();
  const maxObservedDay = observedDays.at(-1) || null;
  if (latestDay && maxObservedDay && latestDay !== maxObservedDay) {
    coverageIssue(errors, `${path}/latest_dated_item/published_at`, "latest_item", "must equal the latest publication date in dated_items_checked");
  }
  const officialSourceDays = [...context.sourceById.values()]
    .filter((source) => entryUrl && commonSiteHost(entryUrl, source?.url))
    .map((source) => isoDay(source?.published_at))
    .filter((day) => day && day <= context.asOfDate)
    .sort();
  const maxOfficialSourceDay = officialSourceDays.at(-1) || null;
  if (latestDay && maxOfficialSourceDay && latestDay !== maxOfficialSourceDay) {
    coverageIssue(errors, `${path}/latest_dated_item/published_at`, "source_inventory_latest", "must equal the latest dated packet source on the official site");
  }
  const latestAppearsInChecked = dated.some(({ item }) => objectRecord(item)
    && item.source_id === surface.latest_dated_item.source_id
    && normalizedHttpUrl(item.url) === normalizedHttpUrl(surface.latest_dated_item.url)
    && isoDay(item.published_at) === latestDay);
  if (!latestAppearsInChecked) {
    coverageIssue(errors, `${path}/latest_dated_item`, "containment", "must also appear in dated_items_checked");
  }
  if (latestInstant !== null && latestInstant > context.asOfEnd) {
    coverageIssue(errors, `${path}/latest_dated_item/published_at`, "point_in_time", "must not be after as_of");
  }
}

/**
 * Fail closed when the news seat has not materialized both official surfaces.
 *
 * The model may describe an official-source search in prose, but only this source-linked,
 * cutoff-checked record is allowed to establish that the regulator and issuer newsroom were
 * actually covered. An inaccessible surface is still recorded as an explicit gap, but the
 * packet is rejected before it can influence a rating. This deliberately fails closed: no
 * finite prose classifier can prove that a worker did not disguise an absence conclusion as
 * a positive observation.
 */
export function assertOfficialSourceCoverage(packet, {
  task = packet?.task,
  asOfDate = packet?.as_of,
  grounding = null,
} = {}) {
  if (task !== NEWS_TASK) return packet;
  const errors = [];
  const coverage = packet?.official_source_coverage;
  if (!objectRecord(coverage)) {
    coverageIssue(errors, "/official_source_coverage", "required", "news evidence requires structured official-source coverage", "official_source_coverage");
  }
  if (!exactIsoDay(asOfDate)) {
    coverageIssue(errors, "/as_of", "format", "must be a valid YYYY-MM-DD date");
  }
  const asOfEnd = exactIsoDay(asOfDate) ? Date.parse(`${asOfDate}T23:59:59.999Z`) : Number.NEGATIVE_INFINITY;
  const context = {
    asOfDate,
    asOfEnd,
    retrievedThroughDay: grounding?.gathered_at ? isoDay(grounding.gathered_at) : asOfDate,
    sourceById: new Map((packet?.sources || []).map((source) => [source?.id, source])),
  };
  if (objectRecord(coverage)) {
    if (!COVERAGE_STATUSES.has(coverage.status)) {
      coverageIssue(errors, "/official_source_coverage/status", "enum", "must be complete or incomplete");
    }
    validateCoverageSurface("regulator", coverage.regulator, context, errors);
    validateCoverageSurface("issuer", coverage.issuer, context, errors);
    const derivedStatus = coverage.regulator?.status === "complete" && coverage.issuer?.status === "complete"
      ? "complete"
      : "incomplete";
    if (coverage.status !== derivedStatus) {
      coverageIssue(errors, "/official_source_coverage/status", "consistency", `must be ${derivedStatus} for the two surface statuses`);
    }
    for (const surface of [coverage.regulator, coverage.issuer]) {
      if (surface?.status === "incomplete" && !packet.open_questions?.includes(surface.gap)) {
        coverageIssue(errors, "/open_questions", "explicit_gap", "must include every incomplete official-source coverage gap");
      }
    }
    if (derivedStatus === "incomplete") {
      coverageIssue(
        errors,
        "/official_source_coverage/status",
        "official_coverage_incomplete",
        "both regulator and issuer-official surfaces must be complete before news evidence can enter the council",
      );
    }
    for (const [index, claim] of (packet?.claims || []).entries()) {
      if (!NEWS_CLAIM_TYPES.has(claim?.claim_type)) {
        coverageIssue(errors, `/claims/${index}/claim_type`, "enum", "must be event_or_observation or absence_no_event");
      }
      const absenceConclusion = claim?.claim_type === "absence_no_event"
        || looksLikeNoEventConclusion(claim?.claim);
      if (derivedStatus === "incomplete" && absenceConclusion) {
        coverageIssue(
          errors,
          `/claims/${index}/claim`,
          "absence_claim_requires_complete_coverage",
          "an absence/no-event conclusion requires complete regulator and issuer-official coverage through as_of",
        );
      }
    }
    if (derivedStatus === "incomplete" && looksLikeNoEventConclusion(packet?.summary)) {
      coverageIssue(
        errors,
        "/summary",
        "absence_claim_requires_complete_coverage",
        "a summary absence/no-event conclusion requires complete regulator and issuer-official coverage through as_of",
      );
    }
    const expected = grounding?.filer?.latest_filing;
    if (coverage.regulator?.status === "complete" && objectRecord(expected)) {
      const actual = coverage.regulator.latest_dated_item;
      if (expected.filing_date && isoDay(actual?.published_at) !== isoDay(expected.filing_date)) {
        coverageIssue(errors, "/official_source_coverage/regulator/latest_dated_item/published_at", "grounding_alignment", "must match grounding.filer.latest_filing.filing_date");
      }
      if (expected.accession && actual?.record_id !== expected.accession) {
        coverageIssue(errors, "/official_source_coverage/regulator/latest_dated_item/record_id", "grounding_alignment", "must match grounding.filer.latest_filing.accession");
      }
      if (expected.primary_document_url
        && normalizedHttpUrl(actual?.url) !== normalizedHttpUrl(expected.primary_document_url)) {
        coverageIssue(errors, "/official_source_coverage/regulator/latest_dated_item/url", "grounding_alignment", "must match grounding.filer.latest_filing.primary_document_url");
      }
      if (grounding?.filer?.submissions_url
        && normalizedHttpUrl(coverage.regulator.entry_url) !== normalizedHttpUrl(grounding.filer.submissions_url)) {
        coverageIssue(errors, "/official_source_coverage/regulator/entry_url", "grounding_alignment", "must match grounding.filer.submissions_url");
      }
    }
  }
  if (errors.length) {
    throw invalidParams("news evidence failed the official-source coverage gate", {
      reason: "OFFICIAL_SOURCE_COVERAGE_INVALID",
      schema_id: OFFICIAL_SOURCE_COVERAGE_SCHEMA_ID,
      errors: errors.slice(0, 12),
    });
  }
  return packet;
}

/** Every downstream citation must resolve inside its explicit manifest source domain. */
export function assertSourceIdsResolve(run, sourceIds, owner, {
  allowEmpty = false,
  domain = "evidence",
} = {}) {
  const ids = sourceIdList(sourceIds);
  // Use the same materialized view that is written to source_manifest.json. Reconstructing a
  // second partial manifest here caused valid PersonaPack provenance to fail at runtime even
  // while the saved artifact told a different story.
  const known = new Set(sourceManifest(run).sources
    .filter((source) => source.provenance_domain === domain)
    .map((source) => source.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw invalidParams(`${owner} cited source IDs absent from the ${domain} domain of source_manifest.json: ${unknown.join(", ")}`, {
      reason: "SOURCE_PROVENANCE_MISMATCH",
      owner,
      source_domain: domain,
      unknown_source_ids: unknown,
    });
  }
  if (!allowEmpty && ids.length === 0) {
    throw invalidParams(`${owner} must cite at least one ${domain} source_manifest.json ID; missing evidence must be an explicit gap or out_of_scope result.`, {
      reason: "SOURCE_PROVENANCE_REQUIRED",
      owner,
      source_domain: domain,
    });
  }
  return ids;
}

function boundedPacketSourceIds(packet, claimLimit, sourceLimit) {
  const claims = (packet?.claims || []).slice(0, claimLimit);
  const sourceById = new Map((packet?.sources || []).map((source) => [source?.id, source]));
  const selected = [...new Set(claims.flatMap((claim) => claim?.source_ids || []))]
    .filter((id) => sourceById.has(id))
    .slice(0, sourceLimit);
  for (const source of packet?.sources || []) {
    if (selected.length >= sourceLimit) break;
    if (source?.id && !selected.includes(source.id)) selected.push(source.id);
  }
  return selected;
}

/** Evidence IDs actually exposed to a dedicated method voice, plus frozen fact lineage. */
export function methodVoiceAllowedSourceIds(run, frozenOpinion) {
  const quick = run?.council_mode === "quick";
  const packetIds = (run?.packets || []).flatMap((packet) => boundedPacketSourceIds(
    packet,
    quick ? 4 : 8,
    quick ? 6 : 12,
  ));
  const frozenEvidenceIds = frozenOpinion?.evidence_source_ids || frozenOpinion?.source_ids || [];
  const allowed = sourceIdList([...packetIds, ...frozenEvidenceIds]);
  assertSourceIdsResolve(run, allowed, `${frozenOpinion?.master || "method voice"} allowed evidence`, {
    allowEmpty: frozenOpinion?.stance === "out_of_scope",
    domain: "evidence",
  });
  return allowed;
}

export function normalizePacket(packet, task, symbol, asOfDate, raw = "") {
  const sourceIdMap = new Map();
  const sources = Array.isArray(packet?.sources) ? packet.sources.map((source, index) => {
    const original = String(source?.id || `S${index + 1}`);
    const id = scopedSourceId(task, original, index);
    sourceIdMap.set(original, id);
    return { ...(source && typeof source === "object" ? source : {}), id };
  }) : [];
  const claims = Array.isArray(packet?.claims) ? packet.claims.map((claim) => {
    const normalized = {
      ...(claim && typeof claim === "object" ? claim : {}),
      source_ids: Array.isArray(claim?.source_ids)
        ? claim.source_ids.map((id) => sourceIdMap.get(String(id)) || scopedSourceId(task, id)).filter(Boolean)
        : [],
    };
    return task === NEWS_TASK
      ? { ...normalized, claim_type: normalizedNewsClaimType(claim) }
      : normalized;
  }) : [];
  const officialSourceCoverage = task === NEWS_TASK && Object.hasOwn(packet || {}, "official_source_coverage")
    ? normalizeOfficialSourceCoverage(packet.official_source_coverage, task, sourceIdMap)
    : undefined;
  const openQuestions = Array.isArray(packet?.open_questions) ? [...packet.open_questions] : [];
  for (const gap of coverageGapQuestions(officialSourceCoverage)) {
    if (!openQuestions.includes(gap)) openQuestions.push(gap);
  }
  return {
    task,
    symbol,
    as_of: asOfDate,
    summary: typeof packet?.summary === "string" ? packet.summary : raw.slice(0, LIMITS.CLEAN_LOG_BYTES),
    claims,
    metrics: packet?.metrics && typeof packet.metrics === "object" ? packet.metrics : {},
    sources,
    open_questions: openQuestions,
    ...(officialSourceCoverage !== undefined ? { official_source_coverage: officialSourceCoverage } : {}),
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low",
    // How much material this task actually had. Deliberately separate from confidence:
    // a rich-but-contradictory task can be A/low, a sparse-but-decisive one C/high.
    information_richness: ["A", "B", "C"].includes(packet?.information_richness) ? packet.information_richness : "unrated",
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    thread_title: typeof packet?.thread_title === "string" ? packet.thread_title : undefined,
    execution_mode: typeof packet?.execution_mode === "string" ? packet.execution_mode : undefined,
    raw_text: raw,
  };
}

export function normalizeDebate(packet, role, run, raw = "") {
  const decisionAvailable = packet?.decision_available !== false;
  return {
    role,
    symbol: run.symbol,
    as_of: run.as_of,
    verdict: typeof packet?.verdict === "string" ? packet.verdict : "",
    decision_available: decisionAvailable,
    rating: decisionAvailable ? (RATINGS.includes(packet?.rating) ? packet.rating : "Hold") : null,
    winner: ["bull", "bear", "balanced", "unknown"].includes(packet?.winner) ? packet.winner : "unknown",
    summary: typeof packet?.summary === "string" ? packet.summary : raw.slice(0, LIMITS.CLEAN_LOG_BYTES),
    long_thesis: Array.isArray(packet?.long_thesis) ? packet.long_thesis : [],
    short_thesis: Array.isArray(packet?.short_thesis) ? packet.short_thesis : [],
    valuation_range: typeof packet?.valuation_range === "string" ? packet.valuation_range : "",
    catalysts: Array.isArray(packet?.catalysts) ? packet.catalysts : [],
    risks: Array.isArray(packet?.risks) ? packet.risks : [],
    position: typeof packet?.position === "string" ? packet.position : "",
    invalidation: Array.isArray(packet?.invalidation) ? packet.invalidation : [],
    source_ids: Array.isArray(packet?.source_ids) ? packet.source_ids : [],
    // An unavailable decision has no decision confidence. Persist `low` as the conservative
    // machine-readable value; renderers may display it as unavailable, but must never expose
    // high confidence beside NEEDS_MANAGER_REVIEW.
    confidence: decisionAvailable && ["high", "medium", "low"].includes(packet?.confidence)
      ? packet.confidence
      : "low",
    questions: Array.isArray(packet?.questions) ? packet.questions : [],
    questions_answered: Array.isArray(packet?.questions_answered) ? packet.questions_answered : [],
    debate_rounds: Array.isArray(packet?.debate_rounds) ? packet.debate_rounds : [],
    // Optional compact full-PM fields. Headless full renders these deterministically after the
    // small decision packet validates; quick and visible contracts may simply leave them empty.
    price_levels: Array.isArray(packet?.price_levels) ? packet.price_levels : [],
    horizon_views: packet?.horizon_views && typeof packet.horizon_views === "object" && !Array.isArray(packet.horizon_views)
      ? packet.horizon_views
      : {},
    data_gaps: Array.isArray(packet?.data_gaps) ? packet.data_gaps : [],
    report_markdown: typeof packet?.report_markdown === "string" ? packet.report_markdown : "",
    failure_kind: typeof packet?.failure_kind === "string" ? packet.failure_kind : undefined,
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    thread_title: typeof packet?.thread_title === "string" ? packet.thread_title : undefined,
    execution_mode: typeof packet?.execution_mode === "string" ? packet.execution_mode : undefined,
    raw_text: raw,
  };
}

export function debateFailurePacket(role, run, failureKind) {
  const kind = ["global_deadline", "timeout", "exit", "parse_failed", "reader_language_mismatch", "unexpected_error"]
    .includes(failureKind)
    ? failureKind
    : "unexpected_error";
  const copy = localized(run.language, {
    en: {
      global_deadline: `${role} did not complete before the council's global deadline.`,
      timeout: `${role} timed out and produced no usable debate statement.`,
      exit: `${role} exited unsuccessfully and produced no usable debate statement.`,
      parse_failed: `${role} returned output that violated the debate JSON contract.`,
      reader_language_mismatch: `${role} returned reader-facing content in the wrong language.`,
      unexpected_error: `${role} failed unexpectedly and produced no usable debate statement.`,
    },
    zh: {
      global_deadline: `${role} 未能在委员会全局截止时间前完成。`,
      timeout: `${role} 执行超时，未生成可用的辩论发言。`,
      exit: `${role} 异常退出，未生成可用的辩论发言。`,
      parse_failed: `${role} 的输出违反辩论 JSON 契约。`,
      reader_language_mismatch: `${role} 返回了错误语言的读者内容。`,
      unexpected_error: `${role} 意外失败，未生成可用的辩论发言。`,
    },
    ja: {
      global_deadline: `${role} は委員会全体の期限までに完了しませんでした。`,
      timeout: `${role} はタイムアウトし、利用可能な討論発言を生成しませんでした。`,
      exit: `${role} は異常終了し、利用可能な討論発言を生成しませんでした。`,
      parse_failed: `${role} の出力は討論 JSON 契約に違反しています。`,
      reader_language_mismatch: `${role} は指定と異なる言語の読者向け内容を返しました。`,
      unexpected_error: `${role} は予期せず失敗し、利用可能な討論発言を生成しませんでした。`,
    },
    ko: {
      global_deadline: `${role}이 위원회 전체 마감 시간 전에 완료되지 않았습니다.`,
      timeout: `${role}이 시간 초과되어 사용할 수 있는 토론 발언을 생성하지 못했습니다.`,
      exit: `${role}이 비정상 종료되어 사용할 수 있는 토론 발언을 생성하지 못했습니다.`,
      parse_failed: `${role}의 출력이 토론 JSON 계약을 위반했습니다.`,
      reader_language_mismatch: `${role}이 지정과 다른 언어의 독자용 내용을 반환했습니다.`,
      unexpected_error: `${role}이 예기치 않게 실패해 사용할 수 있는 토론 발언을 생성하지 못했습니다.`,
    },
  });
  return normalizeDebate({
    verdict: "FAILED",
    decision_available: false,
    rating: null,
    winner: "unknown",
    summary: copy[kind],
    confidence: "low",
    report_markdown: "",
    failure_kind: kind,
  }, role, run, "");
}

export function dryPacket(task, symbol, asOfDate, prompt, language = "English") {
  const chinese = isChineseLanguage(language);
  return normalizePacket({
    summary: chinese ? `已计划 ${symbol} 的 ${task} 子代理。` : `Planned ${task} subagent for ${symbol}.`,
    claims: [{
      claim: chinese ? "仅 dry run；没有执行外部研究。" : "Dry run only; no external research executed.",
      evidence: chinese ? "生成的 prompt 已保存在 raw_text。" : "The generated prompt is stored in raw_text.",
      confidence: "low",
      source_ids: [],
    }],
    open_questions: [chinese ? "不要传 dry_run，或传 dry_run=false，即可执行 Codex 子代理。" : "Run again without dry_run, or with dry_run=false, to execute Codex subagents."],
    confidence: "low",
  }, task, symbol, asOfDate, prompt);
}

export function dryDebate(role, run, prompt) {
  const chinese = isChineseLanguage(run.language);
  return normalizeDebate({
    verdict: "DRY_RUN",
    rating: "Hold",
    winner: "unknown",
    summary: chinese ? `已计划 ${run.symbol} 的 ${role} 综合。` : `Planned ${role} synthesis for ${run.symbol}.`,
    confidence: "low",
    report_markdown: chinese ? `# ${run.symbol} ${role}\n\n仅 dry run。\n` : `# ${run.symbol} ${role}\n\nDry run only.\n`,
  }, role, run, prompt);
}

export function compactEvidence(run) {
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    context_contract: "bounded_full_v1",
    packets: (run.packets || []).map((packet) => {
      const claims = (packet.claims || []).slice(0, 8);
      const sourceById = new Map((packet.sources || []).map((source) => [source?.id, source]));
      const referenced = [...new Set([
        ...claims.flatMap((claim) => claim?.source_ids || []),
        ...coverageSourceIds(packet.official_source_coverage),
      ])];
      const selectedIds = referenced.filter((id) => sourceById.has(id)).slice(0, 12);
      for (const source of packet.sources || []) {
        if (selectedIds.length >= 12) break;
        if (source?.id && !selectedIds.includes(source.id)) selectedIds.push(source.id);
      }
      const included = new Set(selectedIds);
      return {
        task: packet.task,
        artifact_ref: packetArtifactRef(run, packet),
        summary: clip(packet.summary || "", 1_800),
        claims: claims.map((claim) => ({
          claim: clip(claim?.claim || "", 700),
          evidence: clip(claim?.evidence || "", 700),
          confidence: claim?.confidence || "low",
          source_ids: (claim?.source_ids || []).filter((id) => included.has(id)),
        })),
        metrics: compactValue(packet.metrics || {}),
        ...(packet.official_source_coverage
          ? { official_source_coverage: compactValue(packet.official_source_coverage) }
          : {}),
        sources: selectedIds.map((id) => sourceById.get(id)).filter(Boolean).map((source) => ({
          id: source?.id,
          title: clip(source?.title || "", 260),
          url: source?.url || "",
          published_at: source?.published_at || "unknown",
          retrieved_at: source?.retrieved_at || run.as_of,
        })),
        omitted_claim_count: Math.max(0, (packet.claims || []).length - claims.length),
        omitted_source_count: Math.max(0, (packet.sources || []).length - selectedIds.length),
        open_questions: (packet.open_questions || []).slice(0, 8).map((item) => clip(item, 650)),
        confidence: packet.confidence,
        information_richness: packet.information_richness,
      };
    }),
  };
}

const ARTIFACT_REF_CACHE = new Map();

function fileArtifactRef(path) {
  if (!existsSync(path)) return { path, hash: null, bytes: null };
  const stat = statSync(path);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = ARTIFACT_REF_CACHE.get(path);
  if (cached?.signature === signature) return cached.ref;
  const body = readFileSync(path);
  const ref = {
    path,
    hash: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    bytes: body.byteLength,
  };
  ARTIFACT_REF_CACHE.set(path, { signature, ref });
  return ref;
}

function packetArtifactRef(run, packet) {
  const task = String(packet?.task || "unknown");
  const recordedJson = run?.task_status?.[task]?.output;
  const jsonPath = typeof recordedJson === "string" && recordedJson
    ? recordedJson
    : join(runPath(run.run_id), `${task}.json`);
  const dir = dirname(jsonPath);
  return {
    json: fileArtifactRef(jsonPath),
    markdown: fileArtifactRef(join(dir, `${task}.md`)),
  };
}

function compactValue(value, depth = 0) {
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return clip(value, depth === 0 ? 600 : 320);
  if (depth >= 3) return Array.isArray(value) ? `[${value.length} items]` : "[nested object]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => compactValue(item, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 20)
      .map(([key, item]) => [key, compactValue(item, depth + 1)]));
  }
  return String(value);
}

/**
 * Bounded evidence context for the quick council.
 *
 * The full RKLB evidence file was 340 KB and the old PM prompt reached roughly 384 KB.
 * Raw transcripts never belonged in cross-seat context; this keeps the facts a short memo
 * needs while retaining source IDs, URLs, dates, confidence and explicit gaps.
 */
export function compactQuickEvidence(run) {
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    council_mode: "quick",
    packets: (run.packets || []).map((packet) => {
      const allClaims = packet.claims || [];
      const selectedClaims = allClaims.slice(0, 4);
      const sourceById = new Map((packet.sources || []).map((source) => [source?.id, source]));
      const referencedIds = [...new Set([
        ...selectedClaims.flatMap((claim) => claim?.source_ids || []),
        ...coverageSourceIds(packet.official_source_coverage),
      ])];
      const selectedIds = referencedIds.filter((id) => sourceById.has(id)).slice(0, 6);
      for (const source of packet.sources || []) {
        if (selectedIds.length >= 6) break;
        if (source?.id && !selectedIds.includes(source.id)) selectedIds.push(source.id);
      }
      const includedIds = new Set(selectedIds);
      const omittedReferencedIds = referencedIds.filter((id) => !includedIds.has(id));
      return {
        task: packet.task,
        summary: clip(packet.summary || "", 1_200),
        claims: selectedClaims.map((claim) => ({
          claim: clip(claim?.claim || "", 500),
          evidence: clip(claim?.evidence || "", 500),
          confidence: claim?.confidence || "low",
          source_ids: (claim?.source_ids || []).filter((id) => includedIds.has(id)),
        })),
        metrics: compactValue(packet.metrics || {}),
        ...(packet.official_source_coverage
          ? { official_source_coverage: compactValue(packet.official_source_coverage) }
          : {}),
        sources: selectedIds.map((id) => sourceById.get(id)).filter(Boolean).map((source) => ({
          id: source?.id,
          title: clip(source?.title || "", 240),
          url: source?.url || "",
          published_at: source?.published_at || "unknown",
          retrieved_at: source?.retrieved_at || run.as_of,
        })),
        omitted_claim_count: Math.max(0, allClaims.length - selectedClaims.length),
        omitted_source_count: Math.max(0, (packet.sources || []).length - selectedIds.length),
        omitted_claim_source_ids: omittedReferencedIds,
        open_questions: (packet.open_questions || []).slice(0, 5).map((item) => clip(item, 500)),
        confidence: packet.confidence,
        information_richness: packet.information_richness,
      };
    }),
  };
}

/** Remove artifact-only payloads before a debate packet is sent to another model call. */
export function compactDebateContext(packet) {
  if (!packet) return null;
  return {
    role: packet.role,
    verdict: clip(packet.verdict || "", 1_200),
    rating: packet.rating,
    winner: packet.winner,
    summary: clip(packet.summary || "", 1_200),
    long_thesis: (packet.long_thesis || []).slice(0, 8).map((item) => clip(item, 600)),
    short_thesis: (packet.short_thesis || []).slice(0, 8).map((item) => clip(item, 600)),
    valuation_range: clip(packet.valuation_range || "", 1_000),
    catalysts: (packet.catalysts || []).slice(0, 6).map((item) => clip(item, 500)),
    risks: (packet.risks || []).slice(0, 6).map((item) => clip(item, 500)),
    position: clip(packet.position || "", 800),
    invalidation: (packet.invalidation || []).slice(0, 6).map((item) => clip(item, 500)),
    source_ids: (packet.source_ids || []).slice(0, 20),
    confidence: packet.confidence,
    questions: (packet.questions || []).slice(0, 3).map((item) => clip(item, 600)),
    questions_answered: (packet.questions_answered || []).slice(0, 3).map((item) => ({
      question: clip(item?.question || "", 600),
      answer: clip(item?.answer || "", 900),
    })),
    debate_rounds: (packet.debate_rounds || []).slice(0, 3).map((round) => ({
      round: round?.round,
      summary: clip(round?.summary || "", 900),
      long_thesis: (round?.long_thesis || []).slice(0, 5).map((item) => clip(item, 500)),
      short_thesis: (round?.short_thesis || []).slice(0, 5).map((item) => clip(item, 500)),
      questions: (round?.questions || []).slice(0, 3).map((item) => clip(item, 600)),
      questions_answered: (round?.questions_answered || []).slice(0, 3).map((item) => ({
        question: clip(item?.question || "", 600),
        answer: clip(item?.answer || "", 900),
      })),
    })),
  };
}

export function debateFromCodex(result, role, run, fallbackPrompt, {
  managerDecisionOnly = false,
  repairedTransport = false,
} = {}) {
  if (!result.ok) {
    const failureKind = result.deadline_exhausted
      ? "global_deadline"
      : result.timedOut
        ? "timeout"
        : Number.isInteger(result.code)
          ? "exit"
          : "unexpected_error";
    return debateFailurePacket(role, run, failureKind);
  }
  try {
    // Visible PM submissions and quick PM workers still carry authored report_markdown. Full
    // headless PM workers have a dedicated compact contract; the trusted orchestrator attaches
    // a deterministic complete report only after every structured field and source ID validates.
    const kind = role === "portfolio_manager"
      ? (managerDecisionOnly ? "headless_portfolio_manager_decision" : "portfolio_manager")
      : "debate";
    const parsed = repairedTransport
      ? extractRepairedWorkerJson(result.text, kind)
      : extractWorkerJson(result.text, kind);
    const source_ids = assertSourceIdsResolve(run, parsed.source_ids, role);
    return normalizeDebate({ ...parsed, source_ids }, role, run, result.text);
  } catch (error) {
    const failure = debateFailurePacket(role, run, "parse_failed");
    const schemaErrors = Array.isArray(error?.data?.errors) ? error.data.errors.slice(0, 12) : [];
    const reason = String(error?.data?.reason || "WORKER_OUTPUT_REJECTED");
    const safeReason = /^[A-Z0-9_]{1,96}$/u.test(reason) ? reason : "WORKER_OUTPUT_REJECTED";
    const outputContractDiagnostic = {
      reason: safeReason,
      ...(typeof error?.data?.schema_id === "string"
        ? { schema_id: cleanLog(error.data.schema_id, 160) }
        : {}),
      ...(typeof error?.data?.kind === "string"
        ? { schema_kind: cleanLog(error.data.kind, 80) }
        : {}),
      ...(schemaErrors.length ? {
        schema_error_count: error.data.errors.length,
        schema_errors: schemaErrors,
      } : {}),
    };
    return {
      ...failure,
      ...(schemaErrors.length ? { schema_errors: schemaErrors } : {}),
      output_contract_diagnostic: outputContractDiagnostic,
    };
  }
}

function managerFallbackStatus(run, failurePacket = null) {
  const agentStatus = Array.isArray(run?.agent_status)
    ? run.agent_status.find((item) => item?.role === "portfolio_manager")
    : run?.agent_status?.portfolio_manager;
  const failureKind = failurePacket?.failure_kind || agentStatus?.failure_kind || agentStatus?.error || "";
  const attempts = Math.max(1, Number(failurePacket?.attempts || agentStatus?.attempts) || 1);
  if (failureKind === "parse_failed") {
    if (attempts >= 2) {
      return localized(run.language, {
        zh: "portfolio_manager 已执行 2 次，但两次输出均违反 JSON/报告契约；未产出可用决策。",
        en: "portfolio_manager ran twice, but both outputs violated the JSON/report contract; no usable decision was produced.",
        ja: "portfolio_manager は2回実行されましたが、2回とも JSON／レポート契約に違反し、利用可能な判断を生成できませんでした。正式な投資判断はありません。",
        ko: "portfolio_manager를 두 번 실행했지만 두 출력 모두 JSON/보고서 계약을 위반해 사용 가능한 결정을 생성하지 못했습니다. 공식 투자 판단을 제공할 수 없습니다.",
      });
    }
    return localized(run.language, {
      zh: "portfolio_manager 输出违反 JSON/报告契约；未产出可用决策。",
      en: "portfolio_manager output violated the JSON/report contract; no usable decision was produced.",
      ja: "portfolio_manager の出力が JSON／レポート契約に違反し、利用可能な判断を生成できませんでした。正式な投資判断はありません。",
      ko: "portfolio_manager 출력이 JSON/보고서 계약을 위반해 사용 가능한 결정을 생성하지 못했습니다. 공식 투자 판단을 제공할 수 없습니다.",
    });
  }
  if (failureKind) {
    return localized(run.language, {
      zh: "portfolio_manager 执行失败，未产出可用决策。",
      en: "portfolio_manager failed and produced no usable decision.",
      ja: "portfolio_manager が失敗し、利用可能な判断を生成できませんでした。正式な投資判断はありません。",
      ko: "portfolio_manager 실행이 실패해 사용 가능한 결정을 생성하지 못했습니다. 공식 투자 판단을 제공할 수 없습니다.",
    });
  }
  return localized(run.language, {
    zh: "portfolio_manager 未完成，未产出可用决策。",
    en: "portfolio_manager did not complete; no usable decision was produced.",
    ja: "portfolio_manager が完了しておらず、利用可能な判断は生成されていません。正式な投資判断はありません。",
    ko: "portfolio_manager가 완료되지 않아 사용 가능한 결정이 생성되지 않았습니다. 공식 투자 판단을 제공할 수 없습니다.",
  });
}

function asianManagerFallback(run, summary, managerStatus) {
  const key = languageKey(run.language);
  if (!new Set(["ja", "ko"]).has(key)) return null;
  const c = localized(run.language, {
    ja: {
      title: "投資委員会ドラフト", conclusion: "結論", analyst: "アナリスト作業記録", debate: "強気・弱気討論記録", masters: "メソッド席", long: "強気論点", short: "弱気論点", market: "市場期待と織り込み条件", rating: "アナリスト評価と目標株価の変更", call: "決算説明会の経営シグナル", quant: "定量・ファクター視点", news: "ニュースと企業・業界シグナル", borrow: "空売り・貸株・オプション情報", transaction: "戦略取引・銀行イベント", valuation: "企業価値評価レンジ", price: "価格条件", catalysts: "主要カタリスト", risks: "主要リスク", position: "ポジション提案", shortTerm: "短期1–4週間の見通し", mediumTerm: "中期3–6か月の見通し", longTerm: "長期12か月の見通し", gaps: "データ欠落・利用不可データ", invalidation: "無効化条件", confidence: "信頼度", sources: "出典表",
      unavailable: "今回の実行では同じ言語で確認できる情報を取得できませんでした。", managerMissing: managerStatus, draftOnly: "この文書はドラフトであり、正式なポジションを示しません。", noPackets: "証拠パケットは生成されませんでした。", noMaster: "完了したメソッド席はありません。", keyFindings: "主要所見", dataGaps: "データ欠落", packetSummary: "要約", packetConfidence: "信頼度", sourceCount: "出典数",
    },
    ko: {
      title: "투자위원회 초안", conclusion: "결론", analyst: "분석가 작업 기록", debate: "강세·약세 토론 기록", masters: "방법론 좌석", long: "강세 논거", short: "약세 논거", market: "시장 기대와 내재 조건", rating: "애널리스트 등급 및 목표가 변경", call: "실적 발표 콜 경영진 신호", quant: "정량·팩터 관점", news: "뉴스 및 기업·산업 신호", borrow: "공매도·대차·옵션 정보", transaction: "전략적 거래·금융 이벤트", valuation: "가치평가 범위", price: "가격 조건", catalysts: "핵심 촉매", risks: "주요 위험", position: "포지션 제안", shortTerm: "단기 1–4주 전망", mediumTerm: "중기 3–6개월 전망", longTerm: "장기 12개월 전망", gaps: "데이터 공백·사용 불가 데이터", invalidation: "무효화 조건", confidence: "신뢰도", sources: "출처 표",
      unavailable: "이번 실행에서는 같은 언어로 확인 가능한 정보를 확보하지 못했습니다.", managerMissing: managerStatus, draftOnly: "이 문서는 초안이며 공식 포지션을 제시하지 않습니다.", noPackets: "증거 패킷이 생성되지 않았습니다.", noMaster: "완료된 방법론 좌석이 없습니다.", keyFindings: "핵심 발견", dataGaps: "데이터 공백", packetSummary: "요약", packetConfidence: "신뢰도", sourceCount: "출처 수",
    },
  });
  const analystLog = run.packets.length
    ? run.packets.map((packet) => {
      const claims = (packet.claims || []).slice(0, 5).map((claim) => `  - ${claim.claim}`).join("\n");
      const gaps = (packet.open_questions || []).slice(0, 3).map((item) => `  - ${item}`).join("\n");
      return `### ${packet.task}\n- ${c.packetConfidence}: ${packet.confidence || "unknown"}\n- ${c.packetSummary}: ${packet.summary || c.unavailable}\n${claims ? `- ${c.keyFindings}:\n${claims}\n` : ""}${gaps ? `- ${c.dataGaps}:\n${gaps}\n` : ""}`;
    }).join("\n\n")
    : c.noPackets;
  const masterLog = (run.master_opinions || []).length
    ? run.master_opinions.map((opinion) => `- ${opinion.master}: ${opinion.stance} - ${opinion.summary || opinion.verdict || c.unavailable}`).join("\n")
    : `- ${c.noMaster}`;
  const long = summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => `- ${claim.claim}`).join("\n") || `- ${c.unavailable}`;
  const short = summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || `- ${c.unavailable}`;
  const gaps = summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : `- ${c.unavailable}`;
  const report = `# ${run.symbol} ${c.title}\n\n## ${c.conclusion}\n${summary.final_decision} — ${c.managerMissing}\n\n## ${c.analyst}\n${analystLog}\n\n## ${c.debate}\n${c.managerMissing}\n\n## ${c.masters}\n${masterLog}\n\n## ${c.long}\n${long}\n\n## ${c.short}\n${short}\n\n## ${c.market}\n${c.unavailable}\n\n## ${c.rating}\n${c.unavailable}\n\n## ${c.call}\n${c.unavailable}\n\n## ${c.quant}\n${c.unavailable}\n\n## ${c.news}\n${c.unavailable}\n\n## ${c.borrow}\n${c.unavailable}\n\n## ${c.transaction}\n${c.unavailable}\n\n## ${c.valuation}\n${c.unavailable}\n\n## ${c.price}\n${c.managerMissing} ${c.unavailable}\n\n## ${c.catalysts}\n${c.managerMissing}\n\n## ${c.risks}\n${short}\n\n## ${c.position}\n${c.draftOnly}\n\n## ${c.shortTerm}\n${c.managerMissing}\n\n## ${c.mediumTerm}\n${c.managerMissing}\n\n## ${c.longTerm}\n${c.managerMissing}\n\n## ${c.gaps}\n${gaps}\n\n## ${c.invalidation}\n${c.managerMissing} ${c.draftOnly}\n\n## ${c.confidence}\n${summary.confidence}\n\n## ${c.sources}\n- ${c.sourceCount}: ${summary.source_count}\n`;
  return { copy: c, analystLog, masterLog, report };
}

export function mergeDebateRounds(rounds) {
  const list = (rounds || []).filter(Boolean);
  if (list.length === 0) return null;
  const base = list[list.length - 1];
  const debate_rounds = list.map((packet, index) => ({
    round: index + 1,
    summary: packet.summary || "",
    long_thesis: packet.long_thesis || [],
    short_thesis: packet.short_thesis || [],
    questions: packet.questions || [],
    questions_answered: packet.questions_answered || [],
    raw_text: packet.raw_text || "",
  }));
  return { ...base, debate_rounds };
}

function threeNonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length === 3
    && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function threeBoundAnswers(value, expectedQuestions) {
  return threeNonEmptyStrings(expectedQuestions)
    && Array.isArray(value)
    && value.length === 3
    && value.every((item, index) => (
      item
      && typeof item === "object"
      && !Array.isArray(item)
      && item.question === expectedQuestions[index]
      && typeof item.answer === "string"
      && item.answer.trim().length > 0
    ));
}

/** Fail closed when the advertised Q&A round did not actually exchange questions. */
export function debateQnaGate({ bullR2, bearR2, bullR3, bearR3 } = {}) {
  const errors = [];
  if (!threeNonEmptyStrings(bullR2?.questions)) {
    errors.push("bull_researcher round 2 must ask exactly 3 opponent questions");
  }
  if (!threeNonEmptyStrings(bearR2?.questions)) {
    errors.push("bear_researcher round 2 must ask exactly 3 opponent questions");
  }
  if (!threeBoundAnswers(bullR3?.questions_answered, bearR2?.questions)) {
    errors.push("bull_researcher round 3 must answer exactly 3 opponent questions with exact question bindings");
  }
  if (!threeBoundAnswers(bearR3?.questions_answered, bullR2?.questions)) {
    errors.push("bear_researcher round 3 must answer exactly 3 opponent questions with exact question bindings");
  }
  if (threeNonEmptyStrings(bullR2?.questions)
    && JSON.stringify(bullR3?.questions) !== JSON.stringify(bullR2.questions)) {
    errors.push("bull_researcher round 3 must preserve its round 2 questions");
  }
  if (threeNonEmptyStrings(bearR2?.questions)
    && JSON.stringify(bearR3?.questions) !== JSON.stringify(bearR2.questions)) {
    errors.push("bear_researcher round 3 must preserve its round 2 questions");
  }
  return { status: errors.length ? "failed" : "passed", errors };
}

/** Return the actual failed round, not merely the final round in the role's sequence. */
export function firstFailedDebateResult(steps = []) {
  return steps.find((step) => step?.result?.ok !== true)?.result || null;
}

export function confidenceScore(value) {
  return ({ high: 3, medium: 2, low: 1 })[value] || 1;
}

export function summarizeRun(run, userPrompt = "") {
  const claims = run.packets.flatMap((packet) =>
    packet.claims.map((claim) => ({ ...claim, task: packet.task, packet_confidence: packet.confidence }))
  );
  const avg = run.packets.reduce((sum, packet) => sum + confidenceScore(packet.confidence), 0) / Math.max(1, run.packets.length);
  const confidence = avg >= 2.5 ? "high" : avg >= 1.7 ? "medium" : "low";
  return {
    run_id: run.run_id,
    symbol: run.symbol,
    as_of: run.as_of,
    objective: userPrompt,
    final_decision: run.dry_run ? "DRY_RUN" : "NEEDS_MANAGER_REVIEW",
    confidence,
    thesis: claims.slice(0, 12),
    open_questions: [...new Set(run.packets.flatMap((packet) => packet.open_questions || []))],
    source_count: run.packets.reduce((sum, packet) => sum + (packet.sources?.length || 0), 0),
    evidence_path: join(runPath(run.run_id), "evidence.json"),
  };
}

export function managerFallback(run, userPrompt = "", failurePacket = null) {
  // Evidence confidence is not decision confidence. A fallback has no usable PM decision,
  // so its own confidence is always low even when every underlying packet is high-confidence.
  const summary = { ...summarizeRun(run, userPrompt), confidence: "low" };
  const managerStatus = managerFallbackStatus(run, failurePacket);
  const asian = asianManagerFallback(run, summary, managerStatus);
  if (asian) {
    return normalizeDebate({
      verdict: summary.final_decision,
      decision_available: false,
      rating: null,
      winner: "unknown",
      summary: asian.copy.managerMissing,
      long_thesis: summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => claim.claim),
      short_thesis: summary.open_questions.slice(0, 6),
      confidence: summary.confidence,
      report_markdown: asian.report,
    }, "portfolio_manager", run);
  }
  const chinese = isChineseLanguage(run.language);
  const analystLog = run.packets.length
    ? run.packets.map((packet) => {
        const claims = (packet.claims || []).slice(0, 5).map((claim) => `  - ${claim.claim}`).join("\n");
        const gaps = (packet.open_questions || []).slice(0, 3).map((item) => `  - ${item}`).join("\n");
        return `### ${packet.task}\n- Confidence: ${packet.confidence || "unknown"}\n- Summary: ${packet.summary || "None"}\n${claims ? `- Key findings:\n${claims}\n` : ""}${gaps ? `- Data gaps:\n${gaps}\n` : ""}`;
      }).join("\n\n")
    : (chinese ? "未生成 evidence packets。" : "No evidence packets were generated.");
  const debateRecord = chinese
    ? `${managerStatus} 已完成的多空材料仅作为降级初稿保留。`
    : `${managerStatus} Completed bull/bear material is retained only as a degraded draft.`;
  const masterLog = (run.master_opinions || []).length
    ? run.master_opinions.map((opinion) => `- ${opinion.master}: ${opinion.stance} - ${opinion.summary || opinion.verdict || "no summary"}`).join("\n")
    : (chinese ? "- 本轮没有已完成的大师意见。" : "- No completed master opinion is available in this run.");
  return normalizeDebate({
    verdict: summary.final_decision,
    decision_available: false,
    rating: null,
    winner: "unknown",
    summary: managerStatus,
    long_thesis: summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => claim.claim),
    short_thesis: summary.open_questions.slice(0, 6),
    confidence: summary.confidence,
    report_markdown: chinese
      ? `# ${run.symbol} 投资委员会初稿\n\n## 结论\n${summary.final_decision}\n\n## 分析师工作记录\n${analystLog}\n\n## 多空辩论记录\n${debateRecord}\n\n## 大师席意见\n${masterLog}\n\n## 多头观点\n${summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => `- ${claim.claim}`).join("\n") || "- 本轮没有可用多头论点。"}\n\n## 空头观点\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- 本轮没有可用空头论点。"}\n\n## 市场预期与隐含门槛\n${clip(packetSummary(run, "forward_expectations"), 900) || "- 本轮没有前瞻预期证据。"}\n\n## 分析师评级/目标价变化\n${clip(packetSummary(run, "forward_expectations"), 900) || "- 本轮没有卖方修正证据。"}\n\n## 电话会管理层信号\n${clip(packetSummary(run, "earnings_deep_dive"), 900) || "- 本轮没有电话会证据。"}\n\n## 量化/因子视角\n${clip(packetSummary(run, "quant_factor"), 900) || "- 本轮没有量化因子证据。"}\n\n## 新闻和公司/行业人物发言信号\n${clip([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join("\n"), 1200) || "- 本轮没有新闻或人物发言证据。"}\n\n## short interest / borrow / options 信息\n${clip(packetSummary(run, "quant_factor"), 700) || "- 本轮没有 short interest / borrow / options 数据。"}\n\n## 战略交易 / 银行事件\n${clip(packetSummary(run, "ib_event_analysis"), 900) || "- 本轮没有交易事件证据。"}\n\n## 估值区间\n${clip(packetSummary(run, "valuation_long_short"), 900) || "- 本轮没有估值证据。"}\n\n## 价位参考\n- 经理综合未完成，无法给出价格条件表。需要：估值区间、最差年份盈利、历史估值分位。\n\n## 关键催化剂\n- 等待 portfolio_manager 完整综合。\n\n## 主要风险\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- 暂未发现额外风险。"}\n\n## 仓位建议\n- 经理综合未完成前仅作为初稿，不给正式仓位。\n\n## 短线 1-4 周判断\n- 需等待完整经理综合。\n\n## 中期 3-6 个月判断\n- 需等待完整经理综合。\n\n## 长期 12 个月判断\n- 需等待完整经理综合。\n\n## 数据缺口/未覆盖项\n${summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : "- 未发现关键数据缺口。"}\n\n## 反证条件\n- 若证据来源缺失或完整经理综合失败，本初稿不能作为正式结论。\n\n## 置信度\n${summary.confidence}\n\n## 来源表\n- 来源数量: ${summary.source_count}\n`
      : `# ${run.symbol} Investment Committee Draft\n\n## Conclusion\n${summary.final_decision}\n\n## Analyst Work Log\n${analystLog}\n\n## Bull/Bear Debate Record\n${debateRecord}\n\n## Master Bench\n${masterLog}\n\n## Long Thesis\n${summary.thesis.filter((claim) => claim.confidence !== "low").slice(0, 6).map((claim) => `- ${claim.claim}`).join("\n") || "- No usable long thesis yet."}\n\n## Short Thesis\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- No usable short thesis yet."}\n\n## Market Expectations and Implied Thresholds\n${clip(packetSummary(run, "forward_expectations"), 900) || "- No forward-expectations evidence in this run."}\n\n## Analyst Rating and Target-Price Revisions\n${clip(packetSummary(run, "forward_expectations"), 900) || "- No sell-side revision evidence in this run."}\n\n## Earnings Call Management Signals\n${clip(packetSummary(run, "earnings_deep_dive"), 900) || "- No earnings-call evidence in this run."}\n\n## Quant Factor / Technical Risk View\n${clip(packetSummary(run, "quant_factor"), 900) || "- No quant-factor evidence in this run."}\n\n## News and Company / Industry Voice Signals\n${clip([packetSummary(run, "news_industry_management"), packetSummary(run, "management_industry_voices")].filter(Boolean).join("\n"), 1200) || "- No news or voice evidence in this run."}\n\n## Short Interest / Borrow / Options Information\n${clip(packetSummary(run, "quant_factor"), 700) || "- No short interest / borrow / options data in this run."}\n\n## Strategic Transaction or Banking Event\n${clip(packetSummary(run, "ib_event_analysis"), 900) || "- No transaction evidence in this run."}\n\n## Valuation Range\n${clip(packetSummary(run, "valuation_long_short"), 900) || "- No valuation evidence in this run."}\n\n## Price Levels\n- Manager synthesis did not complete, so no price-condition table can be given. Needed: a valuation range, worst-year earnings, and the historical valuation percentile.\n\n## Key Catalysts\n- Wait for completed portfolio-manager synthesis.\n\n## Major Risks\n${summary.open_questions.slice(0, 6).map((item) => `- ${item}`).join("\n") || "- No additional risks surfaced yet."}\n\n## Position Recommendation\n- Draft only; no formal position before completed manager synthesis.\n\n## Short-Term 1-4 Week View\n- Requires completed manager synthesis.\n\n## Medium-Term 3-6 Month View\n- Requires completed manager synthesis.\n\n## Long-Term 12 Month View\n- Requires completed manager synthesis.\n\n## Data Gaps / Unavailable Data\n${summary.open_questions.length ? summary.open_questions.map((item) => `- ${item}`).join("\n") : "- No critical data gaps were found."}\n\n## Invalidation Conditions\n- If evidence sources are missing or manager synthesis fails, this draft cannot stand as the final decision.\n\n## Confidence\n${summary.confidence}\n\n## Source Table\n- Source count: ${summary.source_count}\n`,
  }, "portfolio_manager", run);
}

/**
 * Common ways a caller says a stance that is not one of the four we store.
 *
 * Mapping these is not politeness. An unmapped value used to fall through to "cautious",
 * which is a real stance carrying real weight -- so a caller writing "avoid" got a seat
 * that looked deliberate and voted. Ten such seats render as unanimity that no master
 * produced.
 */
const STANCE_SYNONYMS = new Map([
  ["long", "constructive"], ["bullish", "constructive"], ["buy", "constructive"],
  ["positive", "constructive"], ["overweight", "constructive"],
  ["neutral", "cautious"], ["hold", "cautious"], ["mixed", "cautious"], ["wait", "cautious"],
  ["short", "opposed"], ["bearish", "opposed"], ["sell", "opposed"], ["avoid", "opposed"],
  ["negative", "opposed"], ["underweight", "opposed"],
  ["n/a", "out_of_scope"], ["na", "out_of_scope"], ["skip", "out_of_scope"],
  ["abstain", "out_of_scope"], ["unknown", "out_of_scope"],
]);

/**
 * Never silently invent a stance.
 *
 * Anything we cannot map becomes `out_of_scope`, which weights.mjs already treats as
 * carrying zero weight. Guessing "cautious" for an unrecognised value manufactures a
 * confident-looking seat out of a caller's typo; declining to score it does not.
 */
export function coerceStance(value, masterId = "") {
  if (MASTER_STANCES.includes(value)) return value;
  if (typeof value === "string") {
    const mapped = STANCE_SYNONYMS.get(value.trim().toLowerCase());
    if (mapped) return mapped;
  }
  if (value !== undefined && value !== null && value !== "") {
    process.emitWarning(
      `alphacouncil: unrecognised master stance ${JSON.stringify(value)}`
      + `${masterId ? ` from ${masterId}` : ""}; recorded as out_of_scope (zero weight). `
      + `Allowed: ${MASTER_STANCES.join(", ")}.`
    );
  }
  return "out_of_scope";
}

/**
 * A master's opinion. Deliberately NOT a debate packet: a master issues no rating and
 * declares no winner. out_of_scope is a first-class stance -- "by my method this name is
 * outside what I can judge" is a conclusion, not an abstention.
 */
export function normalizeMasterOpinion(packet, masterId, run, raw = "") {
  const list = (value) => (Array.isArray(value) ? value.filter((x) => typeof x === "string") : []);
  const stance = coerceStance(packet?.stance, masterId);
  const source_ids = assertSourceIdsResolve(run, list(packet?.source_ids), masterId, {
    allowEmpty: stance === "out_of_scope",
  });
  return {
    master: masterId,
    symbol: run.symbol,
    as_of: run.as_of,
    verdict: typeof packet?.verdict === "string" ? packet.verdict : "",
    stance,
    summary: typeof packet?.summary === "string" ? packet.summary : raw.slice(0, LIMITS.CLEAN_LOG_BYTES),
    key_findings: list(packet?.key_findings),
    disagreements: list(packet?.disagreements),
    disqualifiers_triggered: list(packet?.disqualifiers_triggered),
    what_would_change_my_mind: list(packet?.what_would_change_my_mind),
    source_ids,
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : "low",
    thread_id: typeof packet?.thread_id === "string" ? packet.thread_id : undefined,
    raw_text: raw,
  };
}

/**
 * A dedicated v3 method worker explains an already frozen decision; it never gets to
 * choose or rewrite the stance. Keeping this packet separate from normalizeMasterOpinion
 * makes a persuasive narrative incapable of overriding deterministic policy output.
 */
/**
 * A worker statement is prose that gets interpolated into a system-owned report section.
 * Left raw, a statement containing a line such as `## Conclusion` emits a real level-2
 * heading inside that section; heading assignment keeps the richest body, so the injected
 * block becomes the section the quality gate validates and the genuine PM conclusion drops
 * out of the gate's view entirely. Escape structural markdown at the trust boundary rather
 * than at each render site, so a new renderer cannot reintroduce the hole.
 */
export function sanitizeStatementMarkdown(value) {
  return String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line
      .replace(/^(\s*)(#{1,6})(\s)/u, "$1\\$2$3")
      .replace(/^(\s*)(={3,}|-{3,}|\*{3,}|_{3,})\s*$/u, "$1\\$2"))
    .join("\n")
    .replace(/\n{2,}/gu, "\n")
    .trim();
}

export function normalizeMasterVoice(packet, masterId, run, frozenOpinion, raw = "") {
  // Every one of these is rendered into the system-owned bench, so all of them are escaped.
  const list = (value) => (Array.isArray(value)
    ? value.map(sanitizeStatementMarkdown).filter(Boolean)
    : []);
  if (packet?.master !== masterId) throw invalidParams(`dedicated method worker returned the wrong master id for ${masterId}`);
  if (packet?.acknowledged_stance !== frozenOpinion?.stance) {
    throw invalidParams(`dedicated method worker attempted to change frozen stance for ${masterId}`);
  }
  if (packet?.voice_mode !== FIRST_PERSON_VOICE_MODE) {
    throw invalidParams(`dedicated method worker did not use the required first-person voice mode for ${masterId}`);
  }
  if (packet?.disclosure_ack !== FIRST_PERSON_DISCLOSURE_ACK) {
    throw invalidParams(`dedicated method worker did not acknowledge the fixed identity disclosure for ${masterId}`);
  }
  const voice = Object.fromEntries(VOICE_FIELDS
    .map((field) => [field, sanitizeStatementMarkdown(packet?.voice?.[field])])
    .filter(([, text]) => text));
  const missingVoiceFields = VOICE_FIELDS.filter((field) => !voice[field]);
  if (missingVoiceFields.length) {
    throw invalidParams(`dedicated method worker omitted required first-person voice fields for ${masterId}: ${missingVoiceFields.join(", ")}`);
  }
  // Target-language validation runs immediately after normalization. This gate asks the
  // orthogonal question: did the worker use first person at all? Keeping the checks separate
  // means an English "I" in a Chinese run is reported as a language mismatch, not parse failure.
  const thirdPersonFields = VOICE_FIELDS.filter((field) => !hasAnyFirstPersonMarker(voice[field]));
  if (thirdPersonFields.length) {
    throw invalidParams(`dedicated method worker returned non-first-person method prose for ${masterId}: ${thirdPersonFields.join(", ")}`);
  }
  const statement = composeVoiceStatement(voice, run.language);

  // Intent narrows the frozen stance; it never reopens it. Rejected the same way a changed
  // stance is, so a worker cannot turn `opposed` into `would_buy` by choosing a label.
  const requested = packet?.position_intent;
  if (requested === undefined) {
    throw invalidParams(`dedicated method worker omitted position_intent for ${masterId}`);
  }
  if (!isIntentAllowed(requested, frozenOpinion.stance)) {
    throw invalidParams(
      `dedicated method worker returned an intent outside the frozen stance for ${masterId}: `
      + `${JSON.stringify(requested)} is not one of ${intentsForStance(frozenOpinion.stance).join(", ")}`,
    );
  }

  const workerSourceIds = list(packet?.source_ids);
  const frozenEvidenceSourceIds = sourceIdList(
    frozenOpinion?.evidence_source_ids || frozenOpinion?.source_ids || [],
  );
  const methodSourceIds = sourceIdList(frozenOpinion?.method_source_ids || []);
  assertSourceIdsResolve(run, methodSourceIds, `${masterId} method provenance`, {
    allowEmpty: true,
    domain: "method_provenance",
  });
  assertSourceIdsResolve(run, frozenEvidenceSourceIds, `${masterId} frozen evidence`, {
    allowEmpty: frozenOpinion.stance === "out_of_scope",
    domain: "evidence",
  });
  assertSourceIdsResolve(
    run,
    workerSourceIds,
    `${masterId} worker evidence`,
    { allowEmpty: frozenOpinion.stance === "out_of_scope", domain: "evidence" },
  );
  const allowedSourceIds = methodVoiceAllowedSourceIds(run, frozenOpinion);
  const allowed = new Set(allowedSourceIds);
  const outsideAllowed = workerSourceIds.filter((id) => !allowed.has(id));
  if (outsideAllowed.length) {
    throw invalidParams(`${masterId} cited evidence IDs outside its bounded method-voice context: ${outsideAllowed.join(", ")}`, {
      reason: "METHOD_VOICE_SOURCE_SCOPE_MISMATCH",
      owner: masterId,
      unknown_source_ids: outsideAllowed,
      allowed_source_ids: allowedSourceIds,
    });
  }

  return {
    master: masterId,
    symbol: run.symbol,
    as_of: run.as_of,
    acknowledged_stance: frozenOpinion.stance,
    voice_mode: FIRST_PERSON_VOICE_MODE,
    disclosure_ack: FIRST_PERSON_DISCLOSURE_ACK,
    disclosure: voiceDisclaimer(run.language),
    position_intent: requested,
    voice: Object.keys(voice).length ? voice : null,
    statement,
    key_findings: list(packet?.key_findings),
    disagreements: list(packet?.disagreements),
    what_would_change_my_mind: list(packet?.what_would_change_my_mind),
    source_ids: workerSourceIds,
    confidence: ["high", "medium", "low"].includes(packet?.confidence) ? packet.confidence : frozenOpinion.confidence || "low",
    language: run.language,
    raw_text: raw,
  };
}

/** Compact master opinions for injection into the debate prompt. */
export function compactMasterOpinions(run) {
  return (run.master_opinions || []).map((opinion) => ({
    master: opinion.master,
    stance: opinion.stance,
    verdict: opinion.verdict,
    key_findings: opinion.key_findings,
    disagreements: opinion.disagreements,
    disqualifiers_triggered: opinion.disqualifiers_triggered,
    confidence: opinion.confidence,
  }));
}
