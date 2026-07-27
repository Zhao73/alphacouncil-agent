import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectSemanticSourceAdjudications, semanticSourceAdjudicationArtifactHash,
  validateSemanticSourceAdjudicationArtifact,
} from "../../mcp/lib/personas-v3/semantic-source-adjudication.mjs";
import { parseArgs, usage } from "../../scripts/adjudicate-persona-source-semantics.mjs";

const root = fileURLToPath(new URL("../../knowledge/ai-assisted-solo/reviews/persona-v3-ai-semantic-adjudications/", import.meta.url));
const artifact = (path) => JSON.parse(readFileSync(`${root}/${path}`, "utf8"));

test("third-process adjudicator independently rebinds all 32 candidates and 29 propositions", () => {
  const report = inspectSemanticSourceAdjudications();
  assert.equal(report.valid, true, report.errors.join("\n"));
  assert.equal(report.candidate_count, 32);
  assert.equal(report.valid_artifact_count, 32);
  assert.equal(report.proposition_adjudication_count, 29);
  assert.deepEqual(report.proposition_verdict_counts, { partial: 11, supported: 18, unsupported: 0, unverifiable: 0 });
  assert.deepEqual(report.candidate_verdict_counts, { partial: 10, supported: 16, unsupported: 0, unverifiable: 6 });
  assert.equal(report.binding_pass_count, 32);
  assert.equal(report.skeptic_agreement_count, 29);
  assert.equal(report.skeptic_disagreement_count, 0);
  assert.equal(report.human_reviewed_count, 0);
  assert.equal(report.method_attribution_approved_count, 0);
  assert.equal(report.production_effect, "none");
  assert.equal(report.production_write_count, 0);
});

test("adjudication records exact hashes, agreements, disagreements, and unresolved questions", () => {
  const value = artifact("master_ackman/ackman_pershing_netflix_letter_2022.json");
  assert.equal(value.reviewer_kind, "ai");
  assert.equal(value.role, "adjudicator");
  assert.equal(value.human_reviewed, false);
  assert.equal(value.method_attribution_approved, false);
  assert.equal(value.production_effect, "none");
  assert.ok(Object.values(value.binding_checks).every((check) => check.status === "pass"));
  const review = value.proposition_adjudications[0];
  assert.equal(review.exact_content_binding.binding_status, "exact");
  assert.equal(review.exact_content_binding.extractor_snippet_hash, review.exact_content_binding.adjudicator_snippet_hash_recomputed);
  assert.equal(review.final_verdict, "partial");
  assert.equal(review.skeptic_claim.adjudicator_relation, "agree");
  assert.ok(review.disagreements.some((item) => item.includes("narrowed")));
  assert.ok(review.unresolved_questions.scope.length > 0);
  assert.equal(semanticSourceAdjudicationArtifactHash(value), value.artifact_hash);
  assert.deepEqual(validateSemanticSourceAdjudicationArtifact(value), []);
});

test("unreadable candidates remain unverifiable without fabricated propositions", () => {
  const value = artifact("master_burry/burry_fcic_interview_archive.json");
  assert.equal(value.final_overall_verdict, "unverifiable");
  assert.deepEqual(value.proposition_adjudications, []);
  assert.ok(value.unresolved_questions.authorship.length > 0);
  assert.ok(value.unresolved_questions.scope.length > 0);
  assert.ok(value.unresolved_questions.date.length > 0);
});

test("validator rejects human/production impersonation and verdict tampering", () => {
  const value = structuredClone(artifact("master_asness/asness_value_momentum_interaction.json"));
  value.human_reviewed = true;
  value.method_attribution_approved = true;
  value.production_effect = "approve";
  value.proposition_adjudications[0].final_verdict = "unsupported";
  const errors = validateSemanticSourceAdjudicationArtifact(value);
  assert.ok(errors.some((error) => error.includes("machine-only boundary")));
  assert.ok(errors.some((error) => error.includes("review_hash")));
  assert.ok(errors.some((error) => error.includes("artifact_hash")));
});

test("schema and CLI are isolated from human approvals and production gates", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../schemas/persona-v3-ai-semantic-source-adjudication-v1.schema.json", import.meta.url)), "utf8"));
  assert.equal(schema.properties.reviewer_kind.const, "ai");
  assert.equal(schema.properties.role.const, "adjudicator");
  assert.equal(schema.properties.human_reviewed.const, false);
  assert.equal(schema.properties.method_attribution_approved.const, false);
  assert.equal(schema.properties.production_effect.const, "none");
  assert.equal(parseArgs(["--check", "--json"]).write, false);
  assert.throws(() => parseArgs(["--human-approve"]), /unknown argument/u);
  assert.match(usage(), /never human review.*production promotion/iu);
});
