import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { canonicalJson, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { repoFile } from "../helpers/paths.mjs";

const EXPECTED_CRITICAL_NO_PRODUCER = Object.freeze([
  "event.expiry_coverage",
  "execution.round_trip_cost",
  "payoff.convexity",
  "payoff.max_loss",
  "risk.hidden_leverage",
  "risk.ruin_possible",
  "valuation.cash_flow",
  "valuation.cost_of_capital",
  "valuation.failure_probability",
  "valuation.implied_story",
  "valuation.reinvestment_rate",
  "valuation.target_margin",
]);

async function catalogApi() {
  return import("../../mcp/lib/personas-v3/fact-producer-catalog.mjs");
}

async function builderApi() {
  return import("../../scripts/build-fact-producer-catalog.mjs");
}

function mutable(value) {
  return JSON.parse(JSON.stringify(value));
}

function hashSubject(catalog) {
  const { catalog_hash: ignored, ...subject } = catalog;
  void ignored;
  return subject;
}

function rehash(catalog) {
  catalog.catalog_hash = sha256(hashSubject(catalog));
  return catalog;
}

function readAcknowledgement() {
  return JSON.parse(readFileSync(
    repoFile("data/typed-fact-no-producer-acknowledged.v1.json"),
    "utf8",
  ));
}

test("the committed producer catalog loads as a deeply immutable v1 artifact", async () => {
  const { loadFactProducerCatalog, validateFactProducerCatalog } = await catalogApi();
  const catalog = loadFactProducerCatalog();

  assert.equal(catalog.schema_version, 1);
  assert.equal(catalog.hash_domain, "alphacouncil.typed-fact-producers.v1");
  assert.match(catalog.catalog_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.producers), true);
  assert.equal(Object.isFrozen(catalog.producers[0].observed), true);
  assert.equal(Object.isFrozen(catalog.pack_fact_coverage), true);
  assert.throws(
    () => validateFactProducerCatalog(mutable(catalog), readAcknowledgement(), {
      rawCatalogText: canonicalJson(catalog),
    }),
    (error) => error?.code === "NOT_CANONICAL",
  );
  assert.throws(
    () => validateFactProducerCatalog(mutable(catalog), readAcknowledgement(), {
      rawCatalogText: `${canonicalJson(catalog)}\r\n`,
    }),
    (error) => error?.code === "NOT_CANONICAL",
  );
});

test("all 26 physical packs have role-aware coverage for every critical fact reference", async () => {
  const { loadFactProducerCatalog } = await catalogApi();
  const catalog = loadFactProducerCatalog();
  const masters = [...new Set(catalog.pack_fact_coverage.map((entry) => entry.master_id))];

  assert.equal(masters.length, 26);
  assert.ok(catalog.pack_fact_coverage.every((entry) => entry.roles.length > 0));
  assert.ok(catalog.pack_fact_coverage.every((entry) => [
    "produced", "conditional", "no_producer",
  ].includes(entry.status)));
  assert.ok(catalog.pack_fact_coverage
    .filter((entry) => entry.critical)
    .every((entry) => entry.roles.some((role) => [
      "required", "eligibility", "veto", "tool_input",
    ].includes(role))));
});

test("the only critical no-producer facts are the six Taleb and six Damodaran inputs", async () => {
  const { loadFactProducerCatalog } = await catalogApi();
  const catalog = loadFactProducerCatalog();
  const critical = catalog.no_producer.filter((entry) => entry.critical);

  assert.deepEqual(critical.map((entry) => entry.fact_id), EXPECTED_CRITICAL_NO_PRODUCER);
  assert.deepEqual(
    [...new Set(critical.flatMap((entry) => entry.master_ids))].sort(),
    ["master_damodaran", "master_taleb"],
  );
  assert.equal(readAcknowledgement().entries.length, 12);
});

test("every observed producer has one stable section-bound id and every fact has one maximal winner", async () => {
  const { loadFactProducerCatalog } = await catalogApi();
  const catalog = loadFactProducerCatalog();
  const byFact = new Map();
  for (const producer of catalog.producers) {
    if (!byFact.has(producer.fact_id)) byFact.set(producer.fact_id, []);
    byFact.get(producer.fact_id).push(producer);
  }

  assert.equal(new Set(catalog.producers.map((producer) => producer.producer_id)).size, catalog.producers.length);
  assert.ok(catalog.producers.every((producer) => (
    producer.producer_id === `${catalog.generator.adapter_id}:${producer.section}:${producer.fact_id}`
  )));
  for (const [factId, producers] of byFact) {
    assert.equal(producers.filter((producer) => producer.maximal_precedence).length, 1, factId);
  }
});

test("a dangling producer id fails after a valid catalog rehash", async () => {
  const { loadFactProducerCatalog, validateFactProducerCatalog } = await catalogApi();
  const catalog = mutable(loadFactProducerCatalog());
  catalog.pack_fact_coverage.find((entry) => entry.producer_ids.length)
    .producer_ids.push("grounding_to_typed_facts:quote:zz.missing");
  rehash(catalog);

  assert.throws(
    () => validateFactProducerCatalog(catalog, readAcknowledgement()),
    (error) => error?.code === "DANGLING_PRODUCER_ID",
  );
});

test("catalog hash tampering is rejected before cross-reference validation", async () => {
  const { loadFactProducerCatalog, validateFactProducerCatalog } = await catalogApi();
  const catalog = mutable(loadFactProducerCatalog());
  catalog.catalog_hash = `sha256:${"0".repeat(64)}`;

  assert.throws(
    () => validateFactProducerCatalog(catalog, readAcknowledgement()),
    (error) => error?.code === "CATALOG_HASH_MISMATCH",
  );
});

test("duplicate producer records violate the schema and unsorted records violate canonical order", async () => {
  const { loadFactProducerCatalog, validateFactProducerCatalog } = await catalogApi();
  const base = mutable(loadFactProducerCatalog());
  const duplicate = mutable(base);
  duplicate.producers.push(mutable(duplicate.producers[0]));
  rehash(duplicate);
  const reversed = mutable(base);
  reversed.producers.reverse();
  rehash(reversed);

  assert.throws(
    () => validateFactProducerCatalog(duplicate, readAcknowledgement()),
    (error) => error?.code === "SCHEMA_VIOLATION",
  );
  assert.throws(
    () => validateFactProducerCatalog(reversed, readAcknowledgement()),
    (error) => error?.code === "NOT_CANONICAL",
  );
});

test("missing and stale critical no-producer acknowledgements both fail closed", async () => {
  const { loadFactProducerCatalog, validateFactProducerCatalog } = await catalogApi();
  const { checkCatalogArtifacts } = await builderApi();
  const catalog = mutable(loadFactProducerCatalog());
  const missing = readAcknowledgement();
  missing.entries = missing.entries.filter((entry) => entry.fact_id !== "payoff.convexity");
  const stale = readAcknowledgement();
  stale.entries.push({
    fact_id: "market.price",
    master_ids: ["master_buffett"],
    critical: true,
    reason_code: "no_public_keyless_source",
    note: "Deliberately stale mutation for the contract test.",
  });
  stale.entries.sort((left, right) => left.fact_id.localeCompare(right.fact_id));

  assert.throws(
    () => validateFactProducerCatalog(catalog, missing),
    (error) => error?.code === "UNACKNOWLEDGED_CRITICAL_NO_PRODUCER",
  );
  assert.throws(
    () => validateFactProducerCatalog(catalog, stale),
    (error) => error?.code === "STALE_ACKNOWLEDGEMENT",
  );

  const candidate = mutable(catalog);
  const newlyCritical = candidate.pack_fact_coverage.find((entry) => (
    entry.status === "no_producer" && !entry.critical && entry.roles.includes("optional")
  ));
  newlyCritical.roles.push("eligibility");
  newlyCritical.roles.sort((left, right) => (
    ["required", "optional", "eligibility", "veto", "scoring", "tool_input"].indexOf(left)
    - ["required", "optional", "eligibility", "veto", "scoring", "tool_input"].indexOf(right)
  ));
  newlyCritical.critical = true;
  newlyCritical.declared_optional_but_critical = true;
  const aggregate = candidate.no_producer.find((entry) => entry.fact_id === newlyCritical.fact_id);
  aggregate.critical = true;
  aggregate.roles.push("eligibility");
  aggregate.roles.sort((left, right) => (
    ["required", "optional", "eligibility", "veto", "scoring", "tool_input"].indexOf(left)
    - ["required", "optional", "eligibility", "veto", "scoring", "tool_input"].indexOf(right)
  ));
  rehash(candidate);
  const checked = checkCatalogArtifacts({
    generate: () => candidate,
    acknowledgement: readAcknowledgement(),
    committedText: `${canonicalJson(catalog)}\n`,
  });
  assert.deepEqual(
    checked.failures.map((error) => error.code),
    ["UNACKNOWLEDGED_CRITICAL_NO_PRODUCER", "CATALOG_STALE"],
  );
});

test("conditions come from class and source-difference fixtures rather than every live dependency", async () => {
  const { loadFactProducerCatalog } = await catalogApi();
  const catalog = loadFactProducerCatalog();
  const coverage = new Map(catalog.pack_fact_coverage
    .map((entry) => [`${entry.master_id}:${entry.fact_id}`, entry]));

  for (const [key, expectedCondition] of [
    ["master_bogle:fund.top_ten_weight", "instrument_class"],
    ["master_marks:index.aggregate_pe_ttm", "instrument_class"],
    ["master_pabrai:options.implied_volatility", "data_source"],
    ["master_jhunjhunwala:governance.insider_ownership", "data_source"],
  ]) {
    const entry = coverage.get(key);
    assert.equal(entry?.status, "conditional", key);
    const producers = catalog.producers.filter((producer) => entry.producer_ids.includes(producer.producer_id));
    assert.ok(producers.some((producer) => producer.conditions.some((condition) => condition.kind === expectedCondition)), key);
  }
  const dalio = coverage.get("master_dalio:macro.growth_regime");
  assert.equal(dalio?.status, "produced");
  assert.deepEqual(
    catalog.producers.find((producer) => producer.fact_id === "macro.growth_regime")?.conditions,
    [],
  );
  assert.deepEqual(
    catalog.producers.find((producer) => producer.fact_id === "market.correlation_to_broad_market")?.conditions,
    [{ kind: "data_source", id: "cross_market_reference" }],
  );
});

test("fact ids are exact identifiers and aliases, whitespace, case drift, and duplicates are rejected", async () => {
  const { loadFactProducerCatalog, validateFactProducerCatalog } = await catalogApi();
  const base = mutable(loadFactProducerCatalog());
  for (const invalid of ["Market.Price", " market.price", "market.price "]) {
    const catalog = mutable(base);
    catalog.pack_fact_coverage[0].fact_id = invalid;
    rehash(catalog);
    assert.throws(
      () => validateFactProducerCatalog(catalog, readAcknowledgement()),
      (error) => error?.code === "SCHEMA_VIOLATION",
      invalid,
    );
  }
});

test("tool-input contracts are compared against the maximal-precedence runtime producer", async () => {
  const { loadFactProducerCatalog } = await catalogApi();
  const catalog = loadFactProducerCatalog();
  const coverage = new Map(catalog.pack_fact_coverage
    .map((entry) => [`${entry.master_id}:${entry.fact_id}`, entry]));

  assert.equal(coverage.get("master_buffett:financial.owner_earnings")?.contract_status, "match");
  assert.equal(coverage.get("master_asness:macro.real_rate")?.contract_status, "match");
  assert.notEqual(coverage.get("master_buffett:financial.owner_earnings")?.contract_status, "not_checked");
});

test("estimated deterministic producers stay visible with confidence and never become model-supplied facts", async () => {
  const { loadFactProducerCatalog } = await catalogApi();
  const catalog = loadFactProducerCatalog();
  const producer = catalog.producers.find((entry) => entry.fact_id === "governance.insider_ownership");

  assert.equal(producer.kind, "deterministic_derived");
  assert.equal(producer.observed.derivation, "estimated");
  assert.equal(producer.observed.confidence, 0.7);
  assert.match(producer.observed.lineage_tool_id, /^grounding_to_typed_facts:/u);
  assert.equal(catalog.producers.some((entry) => entry.observed.derivation === "qualitative_extraction"), false);
});

test("the public summary names explicit gaps and never claims every seat is computable", async () => {
  const { loadFactProducerCatalog } = await catalogApi();
  const { catalogSummary } = await builderApi();
  const summary = catalogSummary(loadFactProducerCatalog());

  assert.match(summary, /critical no_producer: 2 \(master_taleb, master_damodaran\)/u);
  assert.match(summary, /covered only by estimated producers/u);
  assert.doesNotMatch(summary, /26\s*\/\s*26[^\n]*computable/iu);
});

test("the committed catalog is byte-identical to a fresh offline runtime-emission build", async () => {
  const { buildFactProducerCatalog, renderCatalog } = await builderApi();
  const generated = buildFactProducerCatalog();
  const committed = readFileSync(repoFile("data/typed-fact-producers.v1.json"), "utf8");

  assert.equal(renderCatalog(generated), committed);
});

test("a runtime fact declaration that the maximal fixtures never emit fails closed", async () => {
  const { assertDeclaredFactsObserved, buildFactProducerCatalog } = await builderApi();
  const catalog = buildFactProducerCatalog();
  const adapterSource = `${readFileSync(
    repoFile("mcp/lib/personas-v3/grounding-adapter.mjs"),
    "utf8",
  )}\nconst hidden = { factId: "zz.never_emitted" };\n`;

  assert.throws(
    () => assertDeclaredFactsObserved(catalog, { adapterSource }),
    (error) => error?.code === "DECLARED_NOT_OBSERVED" && /zz\.never_emitted/u.test(error.message),
  );
});

test("the shipped generator imports without side effects or test-layer dependencies and builds deterministically", async () => {
  const scriptFile = repoFile("scripts/build-fact-producer-catalog.mjs");
  const source = readFileSync(scriptFile, "utf8");
  const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)].map((match) => match[1]);
  assert.ok(specifiers.length > 0);
  assert.ok(specifiers.every((specifier) => specifier.startsWith("node:") || specifier.startsWith("../mcp/lib/")));

  const imported = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `const before=process.exitCode;await import(${JSON.stringify(pathToFileURL(scriptFile).href)});if(process.exitCode!==before)throw new Error("exitCode changed")`,
  ], { cwd: "/", encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");

  const { generateCatalog } = await builderApi();
  assert.equal(canonicalJson(generateCatalog()), canonicalJson(generateCatalog()));
});
