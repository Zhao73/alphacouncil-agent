import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  inspectSemanticSourceExtractions, semanticSourceExtractionArtifactHash,
  validateSemanticSourceExtractionArtifact,
} from "../../mcp/lib/personas-v3/semantic-source-extraction.mjs";
import { parseArgs } from "../../scripts/extract-persona-source-semantics.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

/** Seats that currently carry at least one raw source acquisition. */
const SEATS_WITH_RAW_ACQUISITIONS = 25;

const root = fileURLToPath(new URL("../../knowledge/ai-assisted-solo/reviews/persona-v3-ai-semantic-extractions/", import.meta.url));

test("round-1 semantic extractor covers all candidates without human or production claims", () => {
  const report = inspectSemanticSourceExtractions();
  assert.equal(report.valid, true, report.errors.join("\n"));
  assert.equal(report.candidate_count, 31);
  assert.equal(report.valid_artifact_count, 31);
  assert.equal(report.seats_with_candidates, SEATS_WITH_RAW_ACQUISITIONS);
  assert.deepEqual(report.readability_counts, { partial: 4, readable: 25, unreadable: 2 });
  assert.equal(report.proposition_count, 28);
  assert.equal(report.human_reviewed_count, 0);
  assert.equal(report.method_attribution_approved_count, 0);
  assert.equal(report.production_write_count, 0);
});

test("a readable artifact has page/hash-bound propositions and explicit AI identity", () => {
  const artifact = JSON.parse(readFileSync(`${root}/master_buffett/buffett_berkshire_letter_2024.json`, "utf8"));
  assert.equal(artifact.reviewer_kind, "ai");
  assert.equal(artifact.role, "extractor");
  assert.equal(artifact.review_stage, "round_1_semantic_extraction");
  assert.equal(artifact.model_identity.exact_deployment_id, "not_exposed_to_agent");
  assert.equal(artifact.human_reviewed, false);
  assert.equal(artifact.method_attribution_approved, false);
  assert.equal(artifact.production_effect, "none");
  assert.equal(artifact.readability.status, "readable");
  assert.equal(artifact.method_propositions.length, 1);
  assert.equal(artifact.method_propositions[0].locator.kind, "pdf_page");
  assert.equal(artifact.method_propositions[0].locator.page, 11);
  assert.match(artifact.method_propositions[0].snippet_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(semanticSourceExtractionArtifactHash(artifact), artifact.artifact_hash);
  assert.deepEqual(validateSemanticSourceExtractionArtifact(artifact), []);
});

test("insufficient archives contain no invented method propositions", () => {
  for (const path of [
    "master_burry/burry_fcic_interview_archive.json",
    "master_duan_yongping/duan_yongping_xueqiu_business_culture_2023.json",
    "master_klarman/klarman_cfa_patient_investors_2010.json",
    "master_munger/munger_sec_wesco_annual_report_2009.json",
    "master_simons/simons_foundation_career_interview_2012.json",
    "master_thorp/thorp_kelly_stock_market.json",
  ]) {
    const artifact = JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
    assert.notEqual(artifact.readability.status, "readable");
    assert.deepEqual(artifact.method_propositions, []);
    assert.ok(artifact.open_questions.length > 0);
  }
});

test("schema and CLI hard-code extractor-only machine status", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../schemas/persona-v3-ai-semantic-source-extraction-v1.schema.json", import.meta.url)), "utf8"));
  assert.equal(schema.properties.reviewer_kind.const, "ai");
  assert.equal(schema.properties.role.const, "extractor");
  assert.equal(schema.properties.human_reviewed.const, false);
  assert.equal(schema.properties.method_attribution_approved.const, false);
  assert.equal(schema.properties.production_effect.const, "none");
  assert.equal(parseArgs(["--check", "--json"]).write, false);
  assert.throws(() => parseArgs(["--skeptic"]), /unknown argument/u);
});
