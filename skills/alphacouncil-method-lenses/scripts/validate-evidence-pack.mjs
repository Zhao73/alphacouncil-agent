#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateTypedFact } from "../../../mcp/lib/personas-v3/typed-facts.mjs";
import { CANONICAL_SOLO_TEST_FACT_CONTRACTS } from "../../../scripts/lib/persona-v3-solo-formula-pipeline.mjs";

const HASH = /^sha256:[a-f0-9]{64}$/u;
const METHOD = /^master_[a-z0-9_]+$/u;

function fail(message) {
  process.stderr.write(`invalid full-evidence input: ${message}\n`);
  process.exitCode = 1;
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  fail("usage: node validate-evidence-pack.mjs PATH_TO_INPUT.json");
} else {
  let value;
  try { value = JSON.parse(readFileSync(resolve(file), "utf8")); }
  catch (error) { fail(`cannot read JSON (${error.message})`); }

  if (value) {
    const errors = [];
    if (value.schema_version !== 1) errors.push("schema_version must be 1");
    for (const field of ["case", "typed_fact_pack", "coverage_ledger", "bindings"]) {
      if (!value[field] || typeof value[field] !== "object" || Array.isArray(value[field])) errors.push(`${field} must be an object`);
    }
    for (const field of ["selected_method_ids", "evidence_packets", "source_manifest", "claim_ledger", "artifact_refs"]) {
      if (!Array.isArray(value[field])) errors.push(`${field} must be an array`);
    }
    for (const field of ["case_id", "instrument_id", "instrument_type", "question", "as_of", "knowledge_as_of"]) {
      if (!nonEmpty(value.case?.[field])) errors.push(`case.${field} is required`);
    }
    if (value.case?.as_of && value.case?.knowledge_as_of
      && Date.parse(value.case.knowledge_as_of) > Date.parse(value.case.as_of)) errors.push("knowledge_as_of cannot be after as_of");
    if (!HASH.test(value.typed_fact_pack?.fact_pack_hash || "")) errors.push("typed_fact_pack.fact_pack_hash must be sha256");
    if (value.typed_fact_pack?.as_of !== value.case?.as_of) errors.push("typed_fact_pack.as_of must equal case.as_of");
    if (value.typed_fact_pack?.knowledge_as_of !== value.case?.knowledge_as_of) errors.push("typed_fact_pack.knowledge_as_of must equal case.knowledge_as_of");
    if (value.selected_method_ids?.some((id) => !METHOD.test(id) || id === "master_aschenbrenner")) errors.push("selected_method_ids contains an invalid or retired ID");
    const sourceIds = new Set();
    for (const [index, source] of (value.source_manifest || []).entries()) {
      if (!nonEmpty(source?.id) || sourceIds.has(source.id)) errors.push(`source_manifest[${index}].id must be unique and non-empty`);
      sourceIds.add(source?.id);
      if (!HASH.test(source?.content_hash || "")) errors.push(`source_manifest[${index}].content_hash must be sha256`);
      for (const field of ["published_at", "public_at", "retrieved_at", "locator"]) {
        if (!nonEmpty(source?.[field])) errors.push(`source_manifest[${index}].${field} is required`);
      }
      if (!nonEmpty(source?.url) && !nonEmpty(source?.artifact_id)) errors.push(`source_manifest[${index}] needs url or artifact_id`);
      const publicAt = Date.parse(source?.public_at);
      if (!Number.isFinite(publicAt) || publicAt > Date.parse(value.case?.knowledge_as_of)) errors.push(`source_manifest[${index}].public_at is invalid or post-knowledge-as-of`);
    }
    for (const [index, fact] of (value.typed_fact_pack?.facts || []).entries()) {
      errors.push(...validateTypedFact(fact, {
        file: `typed_fact_pack.facts[${index}]`,
        expectedAsOf: value.case?.as_of,
        knowledgeAsOf: value.case?.knowledge_as_of,
      }));
      if (fact?.value_kind === "monetary" && !/^currency(?:_|$)/u.test(fact?.unit || "")) errors.push(`fact ${fact.fact_id || index} has a non-monetary unit`);
      if (fact?.value_kind === "ratio" && /^currency(?:_|$)/u.test(fact?.unit || "")) errors.push(`fact ${fact.fact_id || index} has a monetary ratio unit`);
      const canonicalContract = CANONICAL_SOLO_TEST_FACT_CONTRACTS[fact?.fact_id];
      if (canonicalContract && fact?.value_kind !== canonicalContract.value_kind) {
        errors.push(`fact ${fact.fact_id} value_kind must be ${canonicalContract.value_kind}`);
      }
      if (canonicalContract && fact?.unit !== canonicalContract.unit) {
        errors.push(`fact ${fact.fact_id} unit must be ${canonicalContract.unit}`);
      }
      for (const sourceId of fact?.source_ids || []) if (!sourceIds.has(sourceId)) errors.push(`fact ${fact.fact_id || index} has unresolved source ${sourceId}`);
    }
    for (const [index, artifact] of (value.artifact_refs || []).entries()) {
      if (!nonEmpty(artifact?.id) || !HASH.test(artifact?.content_hash || "") || !Number.isSafeInteger(artifact?.byte_length)) errors.push(`artifact_refs[${index}] is incomplete`);
    }
    if (errors.length) fail(errors.join("; "));
    else {
      const digest = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      process.stdout.write(`full-evidence input valid: methods=${value.selected_method_ids.length} sources=${sourceIds.size} input_digest=sha256:${digest}\n`);
    }
  }
}
