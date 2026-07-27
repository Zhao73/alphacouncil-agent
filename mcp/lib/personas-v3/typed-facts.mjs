import { canonicalValue, sha256 } from "./canonical.mjs";
import { inclusiveCutoffTime } from "./source-anchor.mjs";

const FACT_ID = /^[a-z0-9_.:-]{3,160}$/;
const VALUE_KINDS = new Set(["monetary", "ratio", "count", "scalar", "boolean", "text", "date"]);
const DERIVATIONS = new Set(["reported", "rederived", "estimated", "qualitative_extraction"]);
const HASH = /^sha256:[a-f0-9]{64}$/;
const FACT_FIELDS = new Set([
  "schema_version", "fact_id", "value_kind", "value", "unit", "currency", "scale",
  "ratio_denominator", "period_start", "period_end", "fiscal_year", "as_of", "public_at",
  "source_ids", "derivation", "confidence", "restatement_policy", "lineage",
]);
const REQUIRED_FIELDS = [
  "schema_version", "fact_id", "value_kind", "value", "unit", "currency", "scale",
  "period_start", "period_end", "fiscal_year", "as_of", "public_at", "source_ids",
  "derivation", "confidence", "restatement_policy", "lineage",
];
const LINEAGE_FIELDS = new Set(["input_fact_ids", "tool_id", "tool_version", "calculation_hash"]);

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
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

export function validateTypedFact(fact, { file = "fact", expectedAsOf, knowledgeAsOf } = {}) {
  const errors = [];
  const fail = (message) => errors.push(`${file}: ${message}`);
  if (!fact || typeof fact !== "object" || Array.isArray(fact)) return [`${file}: typed fact must be an object`];
  for (const key of Object.keys(fact)) if (!FACT_FIELDS.has(key)) fail(`unknown field ${JSON.stringify(key)}`);
  for (const key of REQUIRED_FIELDS) if (!Object.hasOwn(fact, key)) fail(`missing required field ${key}`);
  if (fact.schema_version !== 1) fail(`schema_version must be 1, got ${JSON.stringify(fact.schema_version)}`);
  if (!FACT_ID.test(fact.fact_id || "")) fail(`fact_id is invalid: ${JSON.stringify(fact.fact_id)}`);
  if (!VALUE_KINDS.has(fact.value_kind)) fail(`value_kind is invalid: ${JSON.stringify(fact.value_kind)}`);
  if (!DERIVATIONS.has(fact.derivation)) fail(`derivation is invalid: ${JSON.stringify(fact.derivation)}`);
  if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1) fail("confidence must be between 0 and 1");
  if (!fact.restatement_policy?.trim()) fail("restatement_policy is required");
  if (!Array.isArray(fact.source_ids) || !fact.source_ids.length || fact.source_ids.some((id) => typeof id !== "string" || !id)) {
    fail("source_ids must be a non-empty array of strings");
  } else if (new Set(fact.source_ids).size !== fact.source_ids.length) fail("source_ids contains duplicates");

  const asOf = inclusiveCutoffTime(fact.as_of);
  if (!Number.isFinite(asOf)) fail("as_of must be a valid date or zoned timestamp");
  const publicAt = instant(fact.public_at, "public_at", errors);
  const periodStart = fact.period_start === null ? null : instant(fact.period_start, "period_start", errors);
  const periodEnd = fact.period_end === null ? null : instant(fact.period_end, "period_end", errors);
  if (Number.isFinite(asOf) && publicAt !== null && publicAt > asOf) fail("public_at must be <= as_of");
  if (periodStart !== null && periodEnd !== null && periodStart > periodEnd) fail("period_start must be <= period_end");
  if (expectedAsOf && fact.as_of !== expectedAsOf) fail(`as_of must equal frozen pack as_of ${JSON.stringify(expectedAsOf)}`);
  const knowledgeCutoff = knowledgeAsOf === undefined ? null : inclusiveCutoffTime(knowledgeAsOf);
  if (knowledgeAsOf !== undefined && !Number.isFinite(knowledgeCutoff)) fail("knowledge_as_of must be a valid date or zoned timestamp");
  if (Number.isFinite(knowledgeCutoff) && publicAt !== null && publicAt > knowledgeCutoff) fail("public_at must be <= knowledge_as_of");

  if (fact.value_kind === "monetary") {
    if (typeof fact.value !== "number" || !Number.isFinite(fact.value)) fail("monetary value must be a finite number");
    if (!/^[A-Z]{3}$/.test(fact.currency || "")) fail("monetary facts require an ISO-4217 currency");
    if (!fact.unit?.trim()) fail("monetary facts require a unit");
    if (!Number.isFinite(fact.scale) || fact.scale <= 0) fail("monetary facts require a positive scale");
  }
  if (fact.value_kind === "ratio") {
    if (typeof fact.value !== "number" || !Number.isFinite(fact.value)) fail("ratio value must be a finite number");
    if (!fact.unit?.trim()) fail("ratio facts require a unit such as decimal, percent or points");
    if (!fact.ratio_denominator?.trim()) fail("ratio facts require ratio_denominator");
  }
  if (["count", "scalar"].includes(fact.value_kind)) {
    if (typeof fact.value !== "number" || !Number.isFinite(fact.value)) fail(`${fact.value_kind} value must be a finite number`);
    if (!fact.unit?.trim()) fail(`${fact.value_kind} facts require a unit`);
  }
  if (fact.value_kind === "boolean" && typeof fact.value !== "boolean") fail("boolean value must be boolean");
  if (["text", "date"].includes(fact.value_kind) && typeof fact.value !== "string") fail(`${fact.value_kind} value must be a string`);

  const lineage = fact.lineage;
  if (!lineage || typeof lineage !== "object" || Array.isArray(lineage)) {
    fail("lineage is required");
  } else {
    for (const key of Object.keys(lineage)) if (!LINEAGE_FIELDS.has(key)) fail(`lineage has unknown field ${JSON.stringify(key)}`);
    if (!Array.isArray(lineage.input_fact_ids) || lineage.input_fact_ids.some((id) => typeof id !== "string")) {
      fail("lineage.input_fact_ids must be an array of strings");
    }
    if (fact.derivation !== "reported") {
      if (!lineage.tool_id?.trim()) fail("derived facts require lineage.tool_id");
      if (!lineage.tool_version?.trim()) fail("derived facts require lineage.tool_version");
      if (!HASH.test(lineage.calculation_hash || "")) fail("derived facts require a sha256 calculation_hash");
    }
  }
  return errors;
}

export function buildFactPack(facts, { asOf, knowledgeAsOf = asOf } = {}) {
  if (!Array.isArray(facts)) throw new Error("facts must be an array");
  if (!asOf || !Number.isFinite(inclusiveCutoffTime(asOf))) throw new Error(`asOf is invalid: ${JSON.stringify(asOf)}`);
  if (!knowledgeAsOf || !Number.isFinite(inclusiveCutoffTime(knowledgeAsOf))) throw new Error(`knowledgeAsOf is invalid: ${JSON.stringify(knowledgeAsOf)}`);
  // Snapshot first so validation and hashing observe the same values even for programmatic
  // callers that pass getters, proxies or objects another task still owns. structuredClone
  // also rejects functions/proxies instead of letting non-JSON behavior leak into the pack.
  const snapshotFacts = canonicalValue(structuredClone(facts));
  const errors = [];
  const byId = new Map();
  snapshotFacts.forEach((fact, index) => {
    errors.push(...validateTypedFact(fact, { file: `facts[${index}]`, expectedAsOf: asOf, knowledgeAsOf }));
    if (byId.has(fact?.fact_id)) errors.push(`facts[${index}]: duplicate fact_id ${JSON.stringify(fact.fact_id)}`);
    else if (fact?.fact_id) byId.set(fact.fact_id, fact);
  });
  if (errors.length) throw new Error(`invalid typed fact pack:\n- ${errors.join("\n- ")}`);
  const ordered = [...byId.values()].sort((a, b) => a.fact_id.localeCompare(b.fact_id));
  // Canonicalize the full envelope after stable fact-id ordering, then freeze exactly the
  // snapshot that produced fact_pack_hash.
  const payload = canonicalValue({
    schema_version: 1,
    as_of: asOf,
    knowledge_as_of: knowledgeAsOf,
    facts: ordered,
  });
  return deepFreeze({ ...payload, fact_pack_hash: sha256(payload) });
}
