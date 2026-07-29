import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import {
  AI_FORMULA_REVIEW_HASH_DOMAINS,
  AI_FORMULA_REVIEW_ROLE_SEQUENCE,
  AI_FORMULA_REVIEW_SCHEMA_PATH,
  computeAIFormulaReviewArtifactHash,
  computeAIFormulaReviewManifestHash,
  computeAIFormulaReviewSubjectHash,
  computeAIFormulaRoleArtifactHash,
  planAIFormulaCrossReviews,
  validateAIFormulaReviewArtifact,
  verifyAIFormulaCrossReviewTree,
  writeAIFormulaCrossReviews,
} from "../../scripts/lib/persona-v3-ai-formula-review.mjs";
import { PLANNED_TOOL_COUNT } from "../../data/persona-v3-build-specs.v1.mjs";

/** The review profile gives every tool three independent machine roles. */
const INDEPENDENT_ROLES_PER_REVIEW = 3;

test("every derived proxy receives three hash-bound machine reviews", () => {
  const plan = planAIFormulaCrossReviews();
  const { manifest, reviews } = plan;
  assert.equal(reviews.length, PLANNED_TOOL_COUNT);
  assert.equal(manifest.review_count, PLANNED_TOOL_COUNT);
  assert.equal(manifest.role_count, PLANNED_TOOL_COUNT * INDEPENDENT_ROLES_PER_REVIEW);
  // Four vectors per tool, two invariants checked on each.
  assert.equal(manifest.test_vector_count, PLANNED_TOOL_COUNT * 4);
  assert.equal(manifest.invariant_count, PLANNED_TOOL_COUNT * 8);
  assert.equal(manifest.mechanical_pass_count, PLANNED_TOOL_COUNT);
  assert.equal(manifest.disagreement_count, 0);
  assert.equal(manifest.machine_unknown_count, 0);
  assert.equal(manifest.semantic_unknown_count, PLANNED_TOOL_COUNT);
  assert.equal(manifest.human_reviewer_count, 0);
  assert.equal(manifest.signature_count, 0);
  assert.equal(manifest.approval_count, 0);
  assert.equal(manifest.human_reviewed, false);
  assert.equal(manifest.human_claims, false);
  assert.equal(manifest.production_effect, "none");
  assert.equal(manifest.production_eligible, false);
  assert.equal(manifest.method_model_eligible, false);
  assert.deepEqual(manifest.distinct_role_ids, AI_FORMULA_REVIEW_ROLE_SEQUENCE);
  assert.equal(new Set(manifest.distinct_prompt_ids).size, 3);
  assert.equal(manifest.manifest_hash, computeAIFormulaReviewManifestHash(manifest));
  assert.equal(manifest.review_schema_hash, sha256(JSON.parse(readFileSync(AI_FORMULA_REVIEW_SCHEMA_PATH, "utf8"))));

  for (const review of reviews) {
    assert.deepEqual(validateAIFormulaReviewArtifact(review), []);
    assert.equal(review.reviewer_kind, "ai");
    assert.equal(review.human_reviewed, false);
    assert.equal(review.human_claims, false);
    assert.equal(review.production_eligible, false);
    assert.equal(review.method_model_eligible, false);
    assert.equal(review.adjudication_status, "machine_consistent_semantics_unknown");
    assert.equal(review.vector_summary.total, 4);
    assert.equal(review.vector_summary.pass, 4);
    assert.equal(review.invariant_summary.total, 8);
    assert.equal(review.invariant_summary.pass, 8);
    assert.equal(review.disagreement.status, "none_detected_on_mechanical_contract");
    assert.ok(review.unknowns.includes("semantic_equivalence_to_named_investor_method"));
    assert.equal(review.review_subject_hash, computeAIFormulaReviewSubjectHash(review.review_subject));
    assert.equal(review.review_artifact_hash, computeAIFormulaReviewArtifactHash(review));
    for (const roleId of AI_FORMULA_REVIEW_ROLE_SEQUENCE) {
      const role = review.roles[roleId];
      assert.equal(role.role_id, roleId);
      assert.equal(role.reviewer_kind, "ai");
      assert.equal(role.human_principal, false);
      assert.equal(role.artifact_hash, computeAIFormulaRoleArtifactHash(role));
    }
  }

  const bindingByTool = new Map(manifest.bindings.map((binding) => [binding.tool_id, binding]));
  for (const review of reviews) {
    const binding = bindingByTool.get(review.tool_id);
    assert.equal(binding.review_artifact_hash, review.review_artifact_hash);
    assert.equal(binding.review_file_content_hash, sha256(review));
  }
});

test("mutation produces explicit hash disagreement instead of an approval", () => {
  const review = structuredClone(planAIFormulaCrossReviews().reviews[0]);
  review.roles.adversarial_checker.result.independently_recomputed_vectors[0].recomputed.value = 999;
  const errors = validateAIFormulaReviewArtifact(review);
  assert.ok(errors.some((error) => error.includes("adversarial_checker.artifact_hash mismatch")));
  assert.ok(errors.some((error) => error.includes("review_artifact_hash mismatch")));
  assert.equal(review.production_eligible, false);
  assert.equal(review.human_reviewed, false);
});

test("isolated review tree writes one review per tool plus one manifest and verifies byte-for-byte", (t) => {
  const temp = mkdtempSync(join(tmpdir(), "alphacouncil-ai-formula-review-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const staging = resolve(temp, "staging");
  const reviewRoot = resolve(staging, "persona-v3-ai-formula-reviews");
  mkdirSync(staging, { recursive: true });
  const written = writeAIFormulaCrossReviews({ outputRoot: reviewRoot });
  assert.equal(written.written.length, PLANNED_TOOL_COUNT + 1); // one review per tool, plus the manifest
  assert.equal(written.unchanged.length, 0);
  assert.equal(written.production_effect, "none");
  assert.equal(existsSync(resolve(reviewRoot, "review-manifest.json")), true);

  const verified = verifyAIFormulaCrossReviewTree({ reviewRoot });
  assert.equal(verified.tree_verified, true);
  assert.equal(verified.physical_file_count, PLANNED_TOOL_COUNT + 1);
  assert.equal(verified.manifest_hash, written.manifest_hash);
});

test("hash domains are explicit and disjoint from formal human approval domains", () => {
  assert.deepEqual(Object.keys(AI_FORMULA_REVIEW_HASH_DOMAINS).sort(), [
    "artifact",
    "manifest",
    "prompt",
    "subject",
  ]);
  for (const domain of Object.values(AI_FORMULA_REVIEW_HASH_DOMAINS)) {
    assert.match(domain, /^alphacouncil\.persona-v3\.ai-formula-/u);
    assert.doesNotMatch(domain, /human|approval|signature/u);
  }
});
