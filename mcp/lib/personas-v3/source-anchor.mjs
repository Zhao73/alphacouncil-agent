const SOURCE_KINDS = new Set([
  "primary_text",
  "primary_behavior",
  "derived_proxy",
  "empirical_calibration",
  "editorial_choice",
]);
const GRADES = new Set(["A", "B", "C", "D", "E"]);
const SOURCE_ID = /^[a-z0-9_:-]{3,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const SOURCE_FIELDS = new Set([
  "schema_version", "source_id", "source_kind", "grade", "author", "title", "url",
  "published_at", "public_at", "known_at", "retrieved_at", "locator", "summary", "excerpt",
  "content_hash", "supports", "adjudication",
]);
const LOCATOR_FIELDS = new Set(["page", "chapter", "section", "timestamp", "filing_item"]);
const ADJUDICATION_FIELDS = new Set(["status", "reviewer_ids", "reviewed_at", "notes"]);
const REQUIRED_FIELDS = [
  "schema_version", "source_id", "source_kind", "grade", "author", "title", "url",
  "published_at", "public_at", "retrieved_at", "locator", "summary", "content_hash", "adjudication",
];
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ZONED_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

/**
 * Parse an inclusive knowledge cutoff deterministically across hosts.
 *
 * A date-only cutoff means "through the end of that UTC calendar day". A timestamp is an
 * exact instant and therefore must carry Z or an explicit offset; local-time parsing would
 * otherwise make the same pack admit different sources on different machines.
 */
export function inclusiveCutoffTime(value) {
  if (typeof value !== "string") return Number.NaN;
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) {
    const start = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== value) return Number.NaN;
    return start + 86_400_000 - 1;
  }
  if (!ZONED_DATE_TIME.test(value)) return Number.NaN;
  return Date.parse(value);
}

function instant(value, field, errors) {
  if (typeof value !== "string" || value.length < 10) {
    errors.push(`${field} must be a dated string`);
    return null;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) errors.push(`${field} is not a valid date: ${JSON.stringify(value)}`);
  return Number.isFinite(time) ? time : null;
}

function normalizedReviewerId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  return normalized || null;
}

export function validateSourceAnchor(anchor, { file = "source" } = {}) {
  const errors = [];
  const fail = (message) => errors.push(`${file}: ${message}`);
  if (!anchor || typeof anchor !== "object" || Array.isArray(anchor)) return [`${file}: source anchor must be an object`];
  for (const key of Object.keys(anchor)) if (!SOURCE_FIELDS.has(key)) fail(`unknown field ${JSON.stringify(key)}`);
  for (const key of REQUIRED_FIELDS) if (!Object.hasOwn(anchor, key)) fail(`missing required field ${key}`);
  if (anchor.schema_version !== 1) fail(`schema_version must be 1, got ${JSON.stringify(anchor.schema_version)}`);
  if (!SOURCE_ID.test(anchor.source_id || "")) fail(`source_id is invalid: ${JSON.stringify(anchor.source_id)}`);
  if (!SOURCE_KINDS.has(anchor.source_kind)) fail(`source_kind is invalid: ${JSON.stringify(anchor.source_kind)}`);
  if (!GRADES.has(anchor.grade)) fail(`grade is invalid: ${JSON.stringify(anchor.grade)}`);
  if (!anchor.author?.trim()) fail("author is required");
  if (!anchor.title?.trim()) fail("title is required");
  if (!/^https?:\/\//.test(anchor.url || "")) fail("url must be an absolute http(s) URL");
  if (!anchor.locator || typeof anchor.locator !== "object" || Array.isArray(anchor.locator) || !Object.keys(anchor.locator).length) {
    fail("locator must identify a page, chapter, section, timestamp or filing item");
  } else for (const key of Object.keys(anchor.locator)) if (!LOCATOR_FIELDS.has(key)) fail(`locator has unknown field ${JSON.stringify(key)}`);
  if (typeof anchor.summary !== "string" || anchor.summary.trim().length < 8) fail("summary must contain at least 8 characters");
  if (anchor.excerpt !== undefined && (typeof anchor.excerpt !== "string" || anchor.excerpt.length > 400)) {
    fail("excerpt must be a string no longer than 400 characters");
  }
  if (!HASH.test(anchor.content_hash || "")) fail("content_hash must be sha256:<64 lowercase hex>");

  const published = instant(anchor.published_at, "published_at", errors);
  const publicAt = instant(anchor.public_at, "public_at", errors);
  instant(anchor.retrieved_at, "retrieved_at", errors);
  if (anchor.known_at !== undefined && anchor.known_at !== null) instant(anchor.known_at, "known_at", errors);
  if (published !== null && publicAt !== null && publicAt < published) fail("public_at cannot precede published_at");

  const adjudication = anchor.adjudication;
  if (!adjudication || typeof adjudication !== "object" || Array.isArray(adjudication)) {
    fail("adjudication is required");
  } else {
    for (const key of Object.keys(adjudication)) if (!ADJUDICATION_FIELDS.has(key)) fail(`adjudication has unknown field ${JSON.stringify(key)}`);
    if (!["pending", "approved", "rejected"].includes(adjudication.status)) fail("adjudication.status is invalid");
    if (!Array.isArray(adjudication.reviewer_ids)) {
      fail("adjudication.reviewer_ids must be an array");
    } else {
      const normalizedReviewers = [];
      for (const [index, value] of adjudication.reviewer_ids.entries()) {
        const reviewerId = normalizedReviewerId(value);
        if (!reviewerId) fail(`adjudication.reviewer_ids[${index}] must be a non-empty string`);
        else normalizedReviewers.push(reviewerId);
      }
      if (new Set(normalizedReviewers).size !== normalizedReviewers.length) {
        fail("adjudication.reviewer_ids contains duplicates after normalization");
      }
    }
    if (adjudication.status === "approved") {
      if (!adjudication.reviewer_ids?.length) fail("an approved source needs a human reviewer");
      instant(adjudication.reviewed_at, "adjudication.reviewed_at", errors);
    }
  }
  return errors;
}

export function sourceVisibleAt(anchor, { asOf, knowledgeAsOf = asOf } = {}) {
  const errors = validateSourceAnchor(anchor);
  if (errors.length) return false;
  const publicAt = Date.parse(anchor.public_at);
  const knownAt = anchor.known_at ? Date.parse(anchor.known_at) : publicAt;
  return publicAt <= inclusiveCutoffTime(asOf) && knownAt <= inclusiveCutoffTime(knowledgeAsOf);
}

/** Only independently reviewed primary material may define a named method rule. */
export function canDefineMethodRule(anchor, { minimumReviewers = 2 } = {}) {
  if (validateSourceAnchor(anchor).length) return false;
  const reviewers = new Set((anchor.adjudication?.reviewer_ids || [])
    .map(normalizedReviewerId)
    .filter(Boolean));
  return ["A", "B"].includes(anchor.grade)
    && ["primary_text", "primary_behavior"].includes(anchor.source_kind)
    && anchor.adjudication?.status === "approved"
    && reviewers.size >= minimumReviewers;
}
