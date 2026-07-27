import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AI_SOURCE_PRE_REVIEW_ROLES,
  aiSourcePreReviewArtifactHash,
  buildAiSourcePreReviewArtifact,
  defaultAiSourcePreReviewRoot,
  inspectAiSourcePreReviews,
  validateAiSourcePreReviewArtifact,
} from "../../mcp/lib/personas-v3/ai-source-pre-review.mjs";
import { sha256Bytes } from "../../mcp/lib/personas-v3/source-acquisition.mjs";
import { buildSourceReviewBatch } from "../../mcp/lib/personas-v3/source-review-operations.mjs";
import { parseArgs } from "../../scripts/pre-review-persona-sources.mjs";

const BYTES = Buffer.from("machine pre-review source bytes");
const RECORD = {
  schema_version: 1,
  artifact_kind: "persona_v3_source_acquisition",
  status: "retrieved_unadjudicated",
  persona_id: "master_buffett",
  candidate_id: "buffett-test-source",
  archive_path: "acquisitions/candidates/buffett-test-source/source.bin",
  content_hash: sha256Bytes(BYTES),
  byte_length: BYTES.length,
  content_type: "text/plain",
  retrieved_at: "2026-07-27T06:00:00.000Z",
  final_url: "https://example.test/source",
  human_review: { status: "not_requested", reviewer_ids: [] },
};

test("machine pre-review binds three isolated AI roles to exact source bytes without human claims", () => {
  const artifact = buildAiSourcePreReviewArtifact({ record: RECORD, bytes: BYTES });
  assert.deepEqual(validateAiSourcePreReviewArtifact(artifact, { record: RECORD, bytes: BYTES }), []);
  assert.equal(artifact.reviewer_kind, "ai");
  assert.equal(artifact.human_reviewed, false);
  assert.equal(artifact.human_claims, false);
  assert.equal(artifact.semantic_review_performed, false);
  assert.equal(artifact.method_attribution_approved, false);
  assert.equal(artifact.production_effect, "none");
  assert.equal(artifact.verdict, "requires_human_review");
  assert.equal(artifact.source_binding.content_hash, sha256Bytes(BYTES));
  assert.equal(artifact.source_binding.source_bytes_reverified, true);
  assert.deepEqual(artifact.roles.map((role) => role.role), ["extractor", "skeptic", "adjudicator"]);
  assert.equal(new Set(artifact.roles.map((role) => role.role_id)).size, 3);
  assert.equal(new Set(artifact.roles.map((role) => role.prompt_hash)).size, 3);
  assert.deepEqual(artifact.roles[0].input_role_output_hashes, []);
  assert.deepEqual(artifact.roles[1].input_role_output_hashes, []);
  assert.deepEqual(
    artifact.roles[2].input_role_output_hashes,
    [artifact.roles[0].output_hash, artifact.roles[1].output_hash],
  );
  assert.equal(aiSourcePreReviewArtifactHash(artifact), artifact.artifact_hash);
  assert.deepEqual(Object.keys(AI_SOURCE_PRE_REVIEW_ROLES), ["extractor", "skeptic", "adjudicator"]);
});
test("validator rejects human impersonation, production effect, and unbound role edits", () => {
  const artifact = structuredClone(buildAiSourcePreReviewArtifact({ record: RECORD, bytes: BYTES }));
  artifact.human_reviewed = true;
  artifact.human_claims = true;
  artifact.production_effect = "approve";
  artifact.roles[0].observations[0] = "unbound replacement";
  const errors = validateAiSourcePreReviewArtifact(artifact, { record: RECORD, bytes: BYTES });
  assert.ok(errors.some((error) => error.includes("human_reviewed must remain false")));
  assert.ok(errors.some((error) => error.includes("human_claims must remain false")));
  assert.ok(errors.some((error) => error.includes("production_effect must be none")));
  assert.ok(errors.some((error) => error.includes("output_hash is invalid")));
  assert.ok(errors.some((error) => error.includes("artifact_hash is invalid")));
});

test("physical machine pre-review inventory covers all 32 candidates across 26 seats and leaves human quorum empty", () => {
  const report = inspectAiSourcePreReviews();
  assert.equal(report.valid, true, report.errors.join("\n"));
  assert.equal(report.canonical_master_count, 26);
  assert.equal(report.seats_with_candidates, 26);
  assert.equal(report.candidate_count, 32);
  assert.equal(report.valid_artifact_count, 32);
  assert.equal(report.role_output_count, 96);
  assert.equal(report.human_reviewed_count, 0);
  assert.equal(report.human_claim_count, 0);
  assert.equal(report.production_write_count, 0);

  const humanBatch = buildSourceReviewBatch({ trustedReviewerKeys: {} });
  assert.equal(humanBatch.progress.raw_acquisition_count, 32);
  assert.equal(humanBatch.progress.trusted_quorum_source_count, 0);
  assert.equal(humanBatch.progress.production_write_count, 0);
});

test("schema and CLI preserve the machine-only boundary", () => {
  const schema = JSON.parse(readFileSync(fileURLToPath(new URL(
    "../../schemas/ai-source-prereview-v1.schema.json",
    import.meta.url,
  )), "utf8"));
  assert.equal(schema.properties.reviewer_kind.const, "ai");
  assert.equal(schema.properties.human_reviewed.const, false);
  assert.equal(schema.properties.human_claims.const, false);
  assert.equal(schema.properties.production_effect.const, "none");
  assert.equal(schema.properties.roles.minItems, 3);
  assert.equal(schema.properties.roles.maxItems, 3);

  const parsed = parseArgs(["--check", "--json"]);
  assert.equal(parsed.write, false);
  assert.equal(parsed.json, true);
  assert.equal(parsed.preReviewRoot, defaultAiSourcePreReviewRoot({ stagingRoot: parsed.root }));
  assert.throws(() => parseArgs(["--write", "--unknown"]), /unknown argument/u);
});
