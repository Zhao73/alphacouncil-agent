import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson, canonicalValue, sha256 } from "./canonical.mjs";

const CATALOG_FILE = fileURLToPath(new URL("../../../data/typed-fact-producers.v1.json", import.meta.url));
const ACKNOWLEDGEMENT_FILE = fileURLToPath(new URL("../../../data/typed-fact-no-producer-acknowledged.v1.json", import.meta.url));

const HASH = /^sha256:[a-f0-9]{64}$/u;
const FACT_ID = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/u;
const MASTER_ID = /^master_[a-z0-9_]+$/u;
const PRODUCER_ID = /^[a-z0-9_]+:(quote|options|market_history|screen|macro_series|fundamentals|instrument_aggregate|insider_ownership|cross_market|basket_news):[a-z0-9_]+(\.[a-z0-9_]+)+$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const FACT_PRODUCER_SECTIONS = Object.freeze([
  "quote",
  "options",
  "market_history",
  "screen",
  "macro_series",
  "fundamentals",
  "instrument_aggregate",
  "insider_ownership",
  "cross_market",
  "basket_news",
]);

const SECTION_SET = new Set(FACT_PRODUCER_SECTIONS);
const ROLE_ORDER = Object.freeze(["required", "optional", "eligibility", "veto", "scoring", "tool_input"]);
const ROLE_SET = new Set(ROLE_ORDER);
const VALUE_KINDS = new Set(["monetary", "ratio", "count", "scalar", "boolean", "text", "date"]);
const DERIVATIONS = new Set(["reported", "rederived", "estimated"]);
const PRODUCER_KINDS = new Set(["direct_fetch", "normalized_source_field", "deterministic_derived"]);
const STATUSES = new Set(["produced", "conditional", "no_producer"]);
const CONTRACT_STATUSES = new Set(["match", "mismatch", "not_checked"]);
const INSTRUMENT_CLASSES = new Set(["equity", "etf", "mutual_fund", "index", "option"]);
const DATA_SOURCES = new Set([
  "options_chain",
  "sec_companyfacts",
  "sec_insider",
  "cross_market_reference",
]);
const ACK_REASONS = new Set([
  "no_public_keyless_source",
  "requires_model_judgement",
  "requires_derivative_payoff_model",
]);
const SOURCE_IDENTITIES = Object.freeze([
  ["mcp/lib/fred.mjs", "FRED_SERIES"],
  ["mcp/lib/fundamentals.mjs", "FUNDAMENTAL_FACT_IDS"],
  ["mcp/lib/instrument-facts.mjs", "LOOK_THROUGH_FACT_IDS"],
  ["mcp/lib/personas-v3/grounding-adapter.mjs", "CROSS_MARKET_FACTS"],
  ["mcp/lib/personas-v3/grounding-adapter.mjs", "SCREEN_FACTS"],
]);

export class FactProducerCatalogError extends Error {
  constructor(code, message, { path = null, rule = null } = {}) {
    super(message);
    this.name = "FactProducerCatalogError";
    this.code = code;
    this.path = path;
    this.rule = rule;
  }
}

function fail(code, message, detail) {
  throw new FactProducerCatalogError(code, message, detail);
}

function schema(path, rule, message = `${path}: ${rule}`) {
  fail("SCHEMA_VIOLATION", message, { path, rule });
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) schema(path, "type_object");
  return value;
}

function exactKeys(value, keys, path) {
  object(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    schema(path, "required_and_additional_properties", `${path}: expected keys ${expected.join(",")}; found ${actual.join(",")}`);
  }
}

function array(value, path, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min) schema(path, `array_min_${min}`);
  return value;
}

function unique(value, path) {
  const encoded = value.map((item) => canonicalJson(item));
  if (new Set(encoded).size !== encoded.length) schema(path, "uniqueItems");
}

function matches(value, pattern, path, rule = "pattern") {
  if (typeof value !== "string" || !pattern.test(value)) schema(path, rule);
}

function oneOf(value, allowed, path) {
  if (!allowed.has(value)) schema(path, `enum:${[...allowed].join("|")}`);
}

function boolean(value, path) {
  if (typeof value !== "boolean") schema(path, "type_boolean");
}

function nullableString(value, path) {
  if (value !== null && typeof value !== "string") schema(path, "type_string_or_null");
}

function validateContract(value, path) {
  exactKeys(value, ["value_kind", "unit", "period_basis"], path);
  oneOf(value.value_kind, VALUE_KINDS, `${path}.value_kind`);
  nullableString(value.unit, `${path}.unit`);
  oneOf(value.period_basis, new Set(["instant", "duration"]), `${path}.period_basis`);
}

function validateCondition(value, path) {
  object(value, path);
  if (value.kind === "instrument_class") {
    exactKeys(value, ["kind", "any_of"], path);
    array(value.any_of, `${path}.any_of`, { min: 1 });
    unique(value.any_of, `${path}.any_of`);
    for (const [index, item] of value.any_of.entries()) oneOf(item, INSTRUMENT_CLASSES, `${path}.any_of[${index}]`);
    return;
  }
  if (value.kind === "data_source") {
    exactKeys(value, ["kind", "id"], path);
    oneOf(value.id, DATA_SOURCES, `${path}.id`);
    return;
  }
  schema(`${path}.kind`, "condition_kind");
}

function validateGenerator(value) {
  exactKeys(value, [
    "script",
    "adapter_id",
    "adapter_version",
    "as_of",
    "fixture_hashes",
    "precedence_inferred_by_call_order",
  ], "$.generator");
  if (value.script !== "scripts/build-fact-producer-catalog.mjs") schema("$.generator.script", "const");
  if (value.adapter_id !== "grounding_to_typed_facts") schema("$.generator.adapter_id", "const");
  if (value.adapter_version !== "1.0.0") schema("$.generator.adapter_version", "const");
  matches(value.as_of, ISO_INSTANT, "$.generator.as_of");
  exactKeys(value.fixture_hashes, ["maximal", "section", "conditional"], "$.generator.fixture_hashes");
  matches(value.fixture_hashes.maximal, HASH, "$.generator.fixture_hashes.maximal");
  exactKeys(value.fixture_hashes.section, FACT_PRODUCER_SECTIONS, "$.generator.fixture_hashes.section");
  for (const section of FACT_PRODUCER_SECTIONS) {
    matches(value.fixture_hashes.section[section], HASH, `$.generator.fixture_hashes.section.${section}`);
  }
  const conditionalKeys = ["equity_us", "equity_non_us", "fund", "index", "options_absent", "cross_market_absent"];
  exactKeys(value.fixture_hashes.conditional, conditionalKeys, "$.generator.fixture_hashes.conditional");
  for (const key of conditionalKeys) {
    matches(value.fixture_hashes.conditional[key], HASH, `$.generator.fixture_hashes.conditional.${key}`);
  }
  array(value.precedence_inferred_by_call_order, "$.generator.precedence_inferred_by_call_order");
  unique(value.precedence_inferred_by_call_order, "$.generator.precedence_inferred_by_call_order");
  value.precedence_inferred_by_call_order.forEach((factId, index) => (
    matches(factId, FACT_ID, `$.generator.precedence_inferred_by_call_order[${index}]`)
  ));
}

function validateSources(values) {
  array(values, "$.sources", { min: 5 });
  if (values.length !== 5) schema("$.sources", "exactly_five_sources");
  unique(values, "$.sources");
  for (const [index, source] of values.entries()) {
    const path = `$.sources[${index}]`;
    exactKeys(source, ["source_module", "export_name", "export_hash", "fact_ids"], path);
    if (typeof source.source_module !== "string" || !/^mcp\/lib\/.+\.mjs$/u.test(source.source_module)) schema(`${path}.source_module`, "pattern");
    if (typeof source.export_name !== "string") schema(`${path}.export_name`, "type_string");
    matches(source.export_hash, HASH, `${path}.export_hash`);
    array(source.fact_ids, `${path}.fact_ids`);
    unique(source.fact_ids, `${path}.fact_ids`);
    source.fact_ids.forEach((factId, factIndex) => matches(factId, FACT_ID, `${path}.fact_ids[${factIndex}]`));
  }
}

function validateProducer(value, index) {
  const path = `$.producers[${index}]`;
  exactKeys(value, [
    "fact_id",
    "producer_id",
    "section",
    "kind",
    "conditions",
    "observed",
    "declared_in",
    "observed_in_section_runs",
    "maximal_precedence",
  ], path);
  matches(value.fact_id, FACT_ID, `${path}.fact_id`);
  matches(value.producer_id, PRODUCER_ID, `${path}.producer_id`);
  oneOf(value.section, SECTION_SET, `${path}.section`);
  oneOf(value.kind, PRODUCER_KINDS, `${path}.kind`);
  array(value.conditions, `${path}.conditions`);
  unique(value.conditions, `${path}.conditions`);
  value.conditions.forEach((condition, conditionIndex) => validateCondition(condition, `${path}.conditions[${conditionIndex}]`));
  exactKeys(value.observed, ["value_kind", "unit", "period_basis", "derivation", "lineage_tool_id", "confidence"], `${path}.observed`);
  oneOf(value.observed.value_kind, VALUE_KINDS, `${path}.observed.value_kind`);
  nullableString(value.observed.unit, `${path}.observed.unit`);
  oneOf(value.observed.period_basis, new Set(["instant", "duration"]), `${path}.observed.period_basis`);
  oneOf(value.observed.derivation, DERIVATIONS, `${path}.observed.derivation`);
  nullableString(value.observed.lineage_tool_id, `${path}.observed.lineage_tool_id`);
  if (typeof value.observed.confidence !== "number" || value.observed.confidence < 0 || value.observed.confidence > 1) {
    schema(`${path}.observed.confidence`, "number_0_to_1");
  }
  if (value.declared_in !== null) {
    exactKeys(value.declared_in, ["source_module", "export_name", "key"], `${path}.declared_in`);
    for (const key of ["source_module", "export_name", "key"]) {
      if (typeof value.declared_in[key] !== "string") schema(`${path}.declared_in.${key}`, "type_string");
    }
  }
  array(value.observed_in_section_runs, `${path}.observed_in_section_runs`, { min: 1 });
  unique(value.observed_in_section_runs, `${path}.observed_in_section_runs`);
  value.observed_in_section_runs.forEach((section, sectionIndex) => (
    oneOf(section, SECTION_SET, `${path}.observed_in_section_runs[${sectionIndex}]`)
  ));
  boolean(value.maximal_precedence, `${path}.maximal_precedence`);
}

function validateCoverage(value, index) {
  const path = `$.pack_fact_coverage[${index}]`;
  exactKeys(value, [
    "master_id",
    "fact_id",
    "roles",
    "critical",
    "declared_optional_but_critical",
    "producer_ids",
    "status",
    "contract_status",
    "contract_detail",
  ], path);
  matches(value.master_id, MASTER_ID, `${path}.master_id`);
  matches(value.fact_id, FACT_ID, `${path}.fact_id`);
  array(value.roles, `${path}.roles`, { min: 1 });
  unique(value.roles, `${path}.roles`);
  value.roles.forEach((role, roleIndex) => oneOf(role, ROLE_SET, `${path}.roles[${roleIndex}]`));
  boolean(value.critical, `${path}.critical`);
  boolean(value.declared_optional_but_critical, `${path}.declared_optional_but_critical`);
  array(value.producer_ids, `${path}.producer_ids`);
  unique(value.producer_ids, `${path}.producer_ids`);
  value.producer_ids.forEach((producerId, producerIndex) => matches(producerId, PRODUCER_ID, `${path}.producer_ids[${producerIndex}]`));
  oneOf(value.status, STATUSES, `${path}.status`);
  oneOf(value.contract_status, CONTRACT_STATUSES, `${path}.contract_status`);
  if (value.contract_detail !== null) {
    exactKeys(value.contract_detail, ["expected", "observed"], `${path}.contract_detail`);
    validateContract(value.contract_detail.expected, `${path}.contract_detail.expected`);
    validateContract(value.contract_detail.observed, `${path}.contract_detail.observed`);
  }
}

function validateNoProducer(value, index) {
  const path = `$.no_producer[${index}]`;
  exactKeys(value, ["fact_id", "master_ids", "critical", "roles"], path);
  matches(value.fact_id, FACT_ID, `${path}.fact_id`);
  array(value.master_ids, `${path}.master_ids`, { min: 1 });
  unique(value.master_ids, `${path}.master_ids`);
  value.master_ids.forEach((masterId, masterIndex) => matches(masterId, MASTER_ID, `${path}.master_ids[${masterIndex}]`));
  boolean(value.critical, `${path}.critical`);
  array(value.roles, `${path}.roles`, { min: 1 });
  unique(value.roles, `${path}.roles`);
  value.roles.forEach((role, roleIndex) => oneOf(role, ROLE_SET, `${path}.roles[${roleIndex}]`));
}

function validateAcknowledgementShape(value) {
  exactKeys(value, ["schema_version", "entries"], "$ack");
  if (value.schema_version !== 1) schema("$ack.schema_version", "const_1");
  array(value.entries, "$ack.entries");
  unique(value.entries, "$ack.entries");
  for (const [index, entry] of value.entries.entries()) {
    const path = `$ack.entries[${index}]`;
    exactKeys(entry, ["fact_id", "master_ids", "critical", "reason_code", "note"], path);
    matches(entry.fact_id, FACT_ID, `${path}.fact_id`);
    array(entry.master_ids, `${path}.master_ids`, { min: 1 });
    unique(entry.master_ids, `${path}.master_ids`);
    entry.master_ids.forEach((masterId, masterIndex) => matches(masterId, MASTER_ID, `${path}.master_ids[${masterIndex}]`));
    if (entry.critical !== true) schema(`${path}.critical`, "const_true");
    oneOf(entry.reason_code, ACK_REASONS, `${path}.reason_code`);
    if (typeof entry.note !== "string" || entry.note.length < 1 || entry.note.length > 300) schema(`${path}.note`, "string_1_to_300");
  }
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSorted(values, compare, path) {
  const sorted = [...values].sort(compare);
  if (JSON.stringify(values) !== JSON.stringify(sorted)) fail("NOT_CANONICAL", `${path}: array is not in canonical order`);
}

function assertCanonicalOrder(catalog, acknowledgement = null) {
  assertSorted(catalog.sources, (left, right) => stableCompare(
    `${left.source_module}\0${left.export_name}`,
    `${right.source_module}\0${right.export_name}`,
  ), "$.sources");
  assertSorted(catalog.producers, (left, right) => stableCompare(
    `${left.fact_id}\0${left.producer_id}`,
    `${right.fact_id}\0${right.producer_id}`,
  ), "$.producers");
  assertSorted(catalog.pack_fact_coverage, (left, right) => stableCompare(
    `${left.master_id}\0${left.fact_id}`,
    `${right.master_id}\0${right.fact_id}`,
  ), "$.pack_fact_coverage");
  assertSorted(catalog.no_producer, (left, right) => stableCompare(left.fact_id, right.fact_id), "$.no_producer");
  assertSorted(catalog.generator.precedence_inferred_by_call_order, stableCompare, "$.generator.precedence_inferred_by_call_order");
  for (const [index, source] of catalog.sources.entries()) {
    assertSorted(source.fact_ids, stableCompare, `$.sources[${index}].fact_ids`);
  }
  for (const [index, producer] of catalog.producers.entries()) {
    if (producer.observed_in_section_runs.length !== 1
      || producer.observed_in_section_runs[0] !== producer.section) {
      fail("NOT_CANONICAL", `$.producers[${index}].observed_in_section_runs: expected the isolated producer section`);
    }
    for (const [conditionIndex, condition] of producer.conditions.entries()) {
      if (condition.kind === "instrument_class") {
        assertSorted(condition.any_of, stableCompare, `$.producers[${index}].conditions[${conditionIndex}].any_of`);
      }
    }
  }
  if (acknowledgement) {
    assertSorted(acknowledgement.entries, (left, right) => stableCompare(left.fact_id, right.fact_id), "$ack.entries");
  }
  for (const [index, entry] of catalog.pack_fact_coverage.entries()) {
    const orderedRoles = [...entry.roles].sort((left, right) => ROLE_ORDER.indexOf(left) - ROLE_ORDER.indexOf(right));
    if (JSON.stringify(entry.roles) !== JSON.stringify(orderedRoles)) fail("NOT_CANONICAL", `$.pack_fact_coverage[${index}].roles: roles are not ordered`);
    assertSorted(entry.producer_ids, stableCompare, `$.pack_fact_coverage[${index}].producer_ids`);
  }
  for (const [index, entry] of catalog.no_producer.entries()) {
    assertSorted(entry.master_ids, stableCompare, `$.no_producer[${index}].master_ids`);
    const orderedRoles = ROLE_ORDER.filter((role) => entry.roles.includes(role));
    if (JSON.stringify(entry.roles) !== JSON.stringify(orderedRoles)) {
      fail("NOT_CANONICAL", `$.no_producer[${index}].roles: roles are not ordered`);
    }
  }
  if (acknowledgement) {
    for (const [index, entry] of acknowledgement.entries.entries()) {
      assertSorted(entry.master_ids, stableCompare, `$ack.entries[${index}].master_ids`);
    }
  }
}

function catalogHashSubject(catalog) {
  return {
    hash_domain: catalog.hash_domain,
    schema_version: catalog.schema_version,
    generator: catalog.generator,
    sources: catalog.sources,
    producers: catalog.producers,
    pack_fact_coverage: catalog.pack_fact_coverage,
    no_producer: catalog.no_producer,
  };
}

function acknowledgementIdentity(entry) {
  return `${entry.fact_id}\0${entry.master_ids.join("\0")}`;
}

function acknowledgementCrossReferenceErrors(catalog, acknowledgement) {
  const required = new Set(catalog.no_producer.filter((entry) => entry.critical).map(acknowledgementIdentity));
  const actual = new Set(acknowledgement.entries.map(acknowledgementIdentity));
  const missing = [...required].filter((identity) => !actual.has(identity));
  const stale = [...actual].filter((identity) => !required.has(identity));
  return [
    ...(missing.length ? [new FactProducerCatalogError(
      "UNACKNOWLEDGED_CRITICAL_NO_PRODUCER",
      `missing acknowledgements: ${missing.join(", ")}`,
    )] : []),
    ...(stale.length ? [new FactProducerCatalogError(
      "STALE_ACKNOWLEDGEMENT",
      `stale acknowledgements: ${stale.join(", ")}`,
    )] : []),
  ];
}

function validateCrossReferences(catalog, acknowledgement = null) {
  const uniqueIdentity = (values, identity, label) => {
    const identities = values.map(identity);
    if (new Set(identities).size !== identities.length) {
      fail("STATUS_INCONSISTENT", `${label}: duplicate identity`);
    }
  };
  uniqueIdentity(catalog.producers, (producer) => producer.producer_id, "$.producers");
  uniqueIdentity(catalog.pack_fact_coverage, (entry) => `${entry.master_id}\0${entry.fact_id}`, "$.pack_fact_coverage");
  uniqueIdentity(catalog.no_producer, (entry) => entry.fact_id, "$.no_producer");
  const producerIds = new Set(catalog.producers.map((producer) => producer.producer_id));
  const producerFacts = new Set(catalog.producers.map((producer) => producer.fact_id));
  for (const entry of catalog.pack_fact_coverage) {
    for (const producerId of entry.producer_ids) {
      if (!producerIds.has(producerId)) fail("DANGLING_PRODUCER_ID", `${entry.master_id}/${entry.fact_id}: ${producerId}`);
    }
    const producers = catalog.producers.filter((producer) => entry.producer_ids.includes(producer.producer_id));
    if (producers.some((producer) => producer.fact_id !== entry.fact_id)) {
      fail("STATUS_INCONSISTENT", `${entry.master_id}/${entry.fact_id}: producer fact id does not match coverage`);
    }
    const expectedStatus = producers.length === 0 ? "no_producer"
      : producers.some((producer) => producer.conditions.length === 0) ? "produced" : "conditional";
    if (entry.status !== expectedStatus) fail("STATUS_INCONSISTENT", `${entry.master_id}/${entry.fact_id}: expected ${expectedStatus}, found ${entry.status}`);
    if (entry.contract_status === "mismatch" && entry.contract_detail === null) {
      fail("STATUS_INCONSISTENT", `${entry.master_id}/${entry.fact_id}: mismatch requires contract_detail`);
    }
    if (entry.contract_status !== "mismatch" && entry.contract_detail !== null) {
      fail("STATUS_INCONSISTENT", `${entry.master_id}/${entry.fact_id}: contract_detail is allowed only for mismatch`);
    }
    const expectedCritical = entry.roles.some((role) => ["required", "eligibility", "veto", "tool_input"].includes(role));
    if (entry.critical !== expectedCritical) fail("STATUS_INCONSISTENT", `${entry.master_id}/${entry.fact_id}: critical flag drifted`);
    const expectedOptionalCritical = entry.roles.includes("optional") && entry.critical && !entry.roles.includes("required");
    if (entry.declared_optional_but_critical !== expectedOptionalCritical) {
      fail("STATUS_INCONSISTENT", `${entry.master_id}/${entry.fact_id}: optional-critical flag drifted`);
    }
  }

  for (const source of catalog.sources) {
    for (const factId of source.fact_ids) {
      if (!producerFacts.has(factId)) fail("DECLARED_NOT_OBSERVED", `${source.export_name}: ${factId}`);
    }
  }
  const sourceIdentity = catalog.sources.map((source) => [source.source_module, source.export_name]);
  if (JSON.stringify(sourceIdentity) !== JSON.stringify(SOURCE_IDENTITIES)) {
    schema("$.sources", "sources_set", "$.sources: the five runtime declaration exports must be exact");
  }

  const byFact = new Map();
  const sourceByIdentity = new Map(catalog.sources.map((source) => [
    `${source.source_module}\0${source.export_name}`,
    source,
  ]));
  for (const producer of catalog.producers) {
    if (!byFact.has(producer.fact_id)) byFact.set(producer.fact_id, []);
    byFact.get(producer.fact_id).push(producer);
    const expectedId = `${catalog.generator.adapter_id}:${producer.section}:${producer.fact_id}`;
    if (producer.producer_id !== expectedId) fail("STATUS_INCONSISTENT", `${producer.producer_id}: expected ${expectedId}`);
    const expectedKind = producer.observed.derivation === "reported"
      ? producer.section === "macro_series" ? "normalized_source_field" : "direct_fetch"
      : "deterministic_derived";
    if (producer.kind !== expectedKind) {
      fail("STATUS_INCONSISTENT", `${producer.producer_id}: expected kind ${expectedKind}`);
    }
    if (["rederived", "estimated"].includes(producer.observed.derivation)) {
      const lineageToolId = producer.observed.lineage_tool_id;
      // Quote and options normalization currently use the adapter root id; sectioned paths use
      // an adapter-id prefix. Both are real deterministic adapter lineage, not model provenance.
      if (lineageToolId !== catalog.generator.adapter_id
        && !lineageToolId?.startsWith(`${catalog.generator.adapter_id}:`)) {
        fail("DERIVED_WITHOUT_LINEAGE", `${producer.producer_id}: derived fact lacks adapter lineage`);
      }
    }
    if (producer.declared_in) {
      const source = sourceByIdentity.get(`${producer.declared_in.source_module}\0${producer.declared_in.export_name}`);
      if (!source || !source.fact_ids.includes(producer.fact_id)) {
        fail("STATUS_INCONSISTENT", `${producer.producer_id}: declared_in does not bind a catalog source fact`);
      }
    }
  }
  for (const [factId, producers] of byFact) {
    if (producers.filter((producer) => producer.maximal_precedence).length !== 1) {
      fail("PRECEDENCE_NOT_UNIQUE", `${factId}: expected one maximal-precedence producer`);
    }
  }

  const derivedNoProducer = new Map();
  for (const entry of catalog.pack_fact_coverage.filter((candidate) => candidate.status === "no_producer")) {
    if (!derivedNoProducer.has(entry.fact_id)) derivedNoProducer.set(entry.fact_id, {
      fact_id: entry.fact_id,
      master_ids: [],
      critical: false,
      roles: [],
    });
    const aggregate = derivedNoProducer.get(entry.fact_id);
    aggregate.master_ids.push(entry.master_id);
    aggregate.critical ||= entry.critical;
    aggregate.roles.push(...entry.roles);
  }
  const normalizedNoProducer = [...derivedNoProducer.values()].map((entry) => canonicalValue({
    ...entry,
    master_ids: [...new Set(entry.master_ids)].sort(),
    roles: ROLE_ORDER.filter((role) => entry.roles.includes(role)),
  })).sort((left, right) => stableCompare(left.fact_id, right.fact_id));
  if (JSON.stringify(normalizedNoProducer) !== JSON.stringify(catalog.no_producer)) {
    fail("STATUS_INCONSISTENT", "$.no_producer does not equal the coverage-derived no-producer set");
  }

  if (acknowledgement) {
    uniqueIdentity(acknowledgement.entries, acknowledgementIdentity, "$ack.entries");
    const [error] = acknowledgementCrossReferenceErrors(catalog, acknowledgement);
    if (error) throw error;
  }
}

function validateShape(catalog, acknowledgement = null) {
  exactKeys(catalog, [
    "schema_version",
    "hash_domain",
    "catalog_hash",
    "generator",
    "sources",
    "producers",
    "pack_fact_coverage",
    "no_producer",
  ], "$");
  if (catalog.schema_version !== 1) schema("$.schema_version", "const_1");
  if (catalog.hash_domain !== "alphacouncil.typed-fact-producers.v1") schema("$.hash_domain", "const");
  matches(catalog.catalog_hash, HASH, "$.catalog_hash");
  validateGenerator(catalog.generator);
  validateSources(catalog.sources);
  array(catalog.producers, "$.producers", { min: 1 });
  unique(catalog.producers, "$.producers");
  catalog.producers.forEach(validateProducer);
  array(catalog.pack_fact_coverage, "$.pack_fact_coverage", { min: 1 });
  unique(catalog.pack_fact_coverage, "$.pack_fact_coverage");
  catalog.pack_fact_coverage.forEach(validateCoverage);
  array(catalog.no_producer, "$.no_producer");
  unique(catalog.no_producer, "$.no_producer");
  catalog.no_producer.forEach(validateNoProducer);
  if (acknowledgement) validateAcknowledgementShape(acknowledgement);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateFactProducerAcknowledgements(catalog, acknowledgement) {
  validateAcknowledgementShape(acknowledgement);
  assertSorted(acknowledgement.entries, (left, right) => stableCompare(left.fact_id, right.fact_id), "$ack.entries");
  const [error] = acknowledgementCrossReferenceErrors(catalog, acknowledgement);
  if (error) throw error;
  return deepFreeze(canonicalValue(acknowledgement));
}

export function factProducerAcknowledgementErrors(catalog, acknowledgement) {
  try {
    validateAcknowledgementShape(acknowledgement);
    assertSorted(acknowledgement.entries, (left, right) => stableCompare(left.fact_id, right.fact_id), "$ack.entries");
  } catch (error) {
    return [error];
  }
  return acknowledgementCrossReferenceErrors(catalog, acknowledgement);
}

export function validateFactProducerCatalog(catalog, acknowledgement, {
  rawCatalogText = null,
  checkAcknowledgements = true,
} = {}) {
  if (checkAcknowledgements && !acknowledgement) schema("$ack", "required");
  const checkedAcknowledgement = checkAcknowledgements ? acknowledgement : null;
  validateShape(catalog, checkedAcknowledgement);
  if (rawCatalogText !== null && String(rawCatalogText) !== `${canonicalJson(catalog)}\n`) {
    fail("NOT_CANONICAL", "catalog bytes are not canonical JSON plus one trailing newline");
  }
  assertCanonicalOrder(catalog, checkedAcknowledgement);
  const expectedHash = sha256(catalogHashSubject(catalog));
  if (catalog.catalog_hash !== expectedHash) {
    fail("CATALOG_HASH_MISMATCH", `expected ${expectedHash}; found ${catalog.catalog_hash}`);
  }
  validateCrossReferences(catalog, checkedAcknowledgement);
  return deepFreeze(canonicalValue(catalog));
}

let cachedDefault = null;

export function loadFactProducerCatalog({
  catalogFile = CATALOG_FILE,
  acknowledgementFile = ACKNOWLEDGEMENT_FILE,
} = {}) {
  const isDefault = catalogFile === CATALOG_FILE && acknowledgementFile === ACKNOWLEDGEMENT_FILE;
  if (isDefault && cachedDefault) return cachedDefault;
  const rawCatalogText = readFileSync(catalogFile, "utf8");
  const rawAcknowledgementText = readFileSync(acknowledgementFile, "utf8");
  let catalog;
  let acknowledgement;
  try {
    catalog = JSON.parse(rawCatalogText);
    acknowledgement = JSON.parse(rawAcknowledgementText);
  } catch (error) {
    schema("$", "valid_json", `fact-producer catalog JSON parse failed: ${error.message}`);
  }
  const validated = validateFactProducerCatalog(catalog, acknowledgement, { rawCatalogText });
  if (isDefault) cachedDefault = validated;
  return validated;
}

export function coverageFor(masterId, catalog = loadFactProducerCatalog()) {
  matches(masterId, MASTER_ID, "master_id");
  const entries = catalog.pack_fact_coverage.filter((entry) => entry.master_id === masterId);
  if (!entries.length) return deepFreeze({ critical_no_producer: [], conditional: [], produced: [] });
  return deepFreeze(canonicalValue({
    critical_no_producer: entries.filter((entry) => entry.critical && entry.status === "no_producer"),
    conditional: entries.filter((entry) => entry.status === "conditional"),
    produced: entries.filter((entry) => entry.status === "produced"),
  }));
}

export function hasCriticalNoProducer(masterId, catalog = loadFactProducerCatalog()) {
  return coverageFor(masterId, catalog).critical_no_producer.length > 0;
}

export function catalogHash(catalog = loadFactProducerCatalog()) {
  return catalog.catalog_hash;
}
