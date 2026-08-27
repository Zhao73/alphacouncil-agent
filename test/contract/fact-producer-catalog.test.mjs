import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { repoFile } from "../helpers/paths.mjs";

async function catalogApi() {
  return import("../../mcp/lib/personas-v3/fact-producer-catalog.mjs");
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(repoFile(relativePath), "utf8"));
}

function validators() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  return {
    catalog: ajv.compile(readJson("schemas/typed-fact-producers-v1.schema.json")),
    acknowledgement: ajv.compile(readJson("schemas/typed-fact-no-producer-acknowledged-v1.schema.json")),
  };
}

test("the committed producer catalog and acknowledgement satisfy their published schemas", async () => {
  await catalogApi();
  const validate = validators();
  const catalog = readJson("data/typed-fact-producers.v1.json");
  const acknowledgement = readJson("data/typed-fact-no-producer-acknowledged.v1.json");

  assert.equal(validate.catalog(catalog), true, JSON.stringify(validate.catalog.errors));
  assert.equal(validate.acknowledgement(acknowledgement), true, JSON.stringify(validate.acknowledgement.errors));
});

test("Ajv and the dependency-free runtime validator reject the same structural mutations", async () => {
  const { validateFactProducerCatalog } = await catalogApi();
  const validate = validators();
  const originalCatalog = readJson("data/typed-fact-producers.v1.json");
  const originalAcknowledgement = readJson("data/typed-fact-no-producer-acknowledged.v1.json");
  const mutations = [
    (catalog) => { delete catalog.generator.adapter_version; },
    (catalog) => { catalog.extra = true; },
    (catalog) => { catalog.producers[0].kind = "model_supplied"; },
    (catalog) => { catalog.producers[0].fact_id = "Market.Price"; },
    (catalog) => { catalog.producers.push(structuredClone(catalog.producers[0])); },
  ];

  for (const mutate of mutations) {
    const catalog = structuredClone(originalCatalog);
    mutate(catalog);
    assert.equal(validate.catalog(catalog), false);
    assert.throws(
      () => validateFactProducerCatalog(catalog, originalAcknowledgement),
      (error) => error?.code === "SCHEMA_VIOLATION",
    );
  }
});

test("the acknowledgement schema rejects non-critical, duplicate, and unsupported reasons", async () => {
  await catalogApi();
  const validate = validators().acknowledgement;
  const original = readJson("data/typed-fact-no-producer-acknowledged.v1.json");
  const mutations = [
    (value) => { value.entries[0].critical = false; },
    (value) => { value.entries.push(structuredClone(value.entries[0])); },
    (value) => { value.entries[0].reason_code = "because_ai_said_so"; },
  ];

  for (const mutate of mutations) {
    const value = structuredClone(original);
    mutate(value);
    assert.equal(validate(value), false);
  }
});
