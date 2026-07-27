import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  inspectSemanticSourceSkepticReviews, semanticSourceSkepticArtifactHash,
  validateSemanticSourceSkepticArtifact,
} from "../../mcp/lib/personas-v3/semantic-source-skeptic-review.mjs";
import { parseArgs, usage } from "../../scripts/review-persona-source-semantics.mjs";

const root = fileURLToPath(new URL("../../knowledge/ai-assisted-solo/reviews/persona-v3-ai-semantic-skeptic-reviews/", import.meta.url));

function artifact(path) {
  return JSON.parse(readFileSync(`${root}/${path}`, "utf8"));
}

test("independent skeptic reopens all 32 sources and reports exact proposition verdicts", () => {
  const report = inspectSemanticSourceSkepticReviews();
  assert.equal(report.valid, true, report.errors.join("\n"));
  assert.equal(report.candidate_count, 32);
  assert.equal(report.valid_artifact_count, 32);
  assert.equal(report.seats_with_candidates, 26);
  assert.equal(report.proposition_review_count, 29);
  assert.deepEqual(report.proposition_verdict_counts, {
    partial: 11,
    supported: 18,
    unsupported: 0,
    unverifiable: 0,
  });
  assert.deepEqual(report.candidate_verdict_counts, {
    partial: 10,
    supported: 16,
    unsupported: 0,
    unverifiable: 6,
  });
  assert.equal(report.binding_pass_count, 32);
  assert.equal(report.human_reviewed_count, 0);
  assert.equal(report.method_attribution_approved_count, 0);
  assert.equal(report.production_effect, "none");
  assert.equal(report.production_write_count, 0);
});

test("skeptic binds source bytes, exact locator and snippet before challenging overreach", () => {
  const value = artifact("master_ackman/ackman_pershing_netflix_letter_2022.json");
  assert.equal(value.role, "skeptic");
  assert.equal(value.reviewer_kind, "ai");
  assert.equal(value.human_reviewed, false);
  assert.equal(value.method_attribution_approved, false);
  assert.equal(value.production_effect, "none");
  assert.ok(Object.values(value.binding_checks).every((check) => check.status === "pass"));
  assert.equal(value.source_binding.raw_bytes_reverified, true);
  assert.equal(value.source_binding.content_hash, value.source_binding.raw_bytes_hash_recomputed);
  assert.equal(value.source_binding.extracted_text_hash, value.source_binding.extracted_text_hash_recomputed);
  assert.equal(value.proposition_reviews.length, 1);
  const review = value.proposition_reviews[0];
  assert.equal(review.snippet_binding_status, "exact");
  assert.equal(review.locator_verification.status, "exact");
  assert.equal(review.support_verdict, "partial");
  assert.match(review.support_rationale, /only-when|strict/iu);
  assert.ok(review.challenges.some((challenge) => challenge.includes("general entry rule")));
  assert.equal(semanticSourceSkepticArtifactHash(value), value.artifact_hash);
  assert.deepEqual(validateSemanticSourceSkepticArtifact(value), []);
});

test("supported and unverifiable candidates remain distinct", () => {
  const supported = artifact("master_asness/asness_value_momentum_interaction.json");
  assert.equal(supported.overall_verdict, "supported");
  assert.equal(supported.proposition_reviews[0].support_verdict, "supported");
  const unverifiable = artifact("master_burry/burry_fcic_interview_archive.json");
  assert.equal(unverifiable.overall_verdict, "unverifiable");
  assert.deepEqual(unverifiable.proposition_reviews, []);
  assert.ok(unverifiable.challenges.some((challenge) => challenge.includes("neither playable audio")));
});

test("validator rejects machine-to-human impersonation and semantic tampering", () => {
  const value = structuredClone(artifact("master_asness/asness_value_momentum_interaction.json"));
  value.human_reviewed = true;
  value.method_attribution_approved = true;
  value.proposition_reviews[0].support_verdict = "unsupported";
  const errors = validateSemanticSourceSkepticArtifact(value);
  assert.ok(errors.some((error) => error.includes("machine-only boundary")));
  assert.ok(errors.some((error) => error.includes("review_hash")));
  assert.ok(errors.some((error) => error.includes("artifact_hash")));
});

test("schema and CLI stop at skeptic review", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL("../../schemas/persona-v3-ai-semantic-source-skeptic-review-v1.schema.json", import.meta.url)), "utf8"));
  assert.equal(schema.properties.reviewer_kind.const, "ai");
  assert.equal(schema.properties.role.const, "skeptic");
  assert.equal(schema.properties.human_reviewed.const, false);
  assert.equal(schema.properties.method_attribution_approved.const, false);
  assert.equal(schema.properties.production_effect.const, "none");
  assert.equal(parseArgs(["--check", "--json"]).write, false);
  assert.throws(() => parseArgs(["--adjudicate"]), /unknown argument/u);
  assert.match(usage(), /never human review, adjudication/iu);
});
