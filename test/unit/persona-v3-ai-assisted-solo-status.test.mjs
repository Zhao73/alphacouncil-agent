import { readdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  inspectAiAssistedSoloStatus,
  loadAiAssistedSoloProfile,
  validateAiFormulaCrossReviewArtifact,
  validateAiSourcePrereviewArtifact,
} from "../../scripts/lib/persona-v3-ai-assisted-solo-status.mjs";
import { parseArgs } from "../../scripts/check-persona-v3-ai-assisted-solo.mjs";
import { resolveRuntimePersonaBuildProfile } from "../../mcp/lib/personas-v3/registry.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { PLANNED_TOOL_COUNT } from "../../data/persona-v3-build-specs.v1.mjs";

const ROOT = process.cwd();

function json(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("the isolated AI-assisted profile cannot masquerade as production or human review", () => {
  const profile = loadAiAssistedSoloProfile();
  assert.equal(profile.profile_id, "ai_assisted_solo");
  assert.equal(profile.package_channel, "solo_test");
  assert.equal(profile.human_review_satisfied, false);
  assert.equal(profile.formal_ga_effect, "none");
  assert.equal(profile.production_eligible, false);
  assert.equal(profile.method_model_eligible, false);

  const directory = mkdtempSync(join(tmpdir(), "alphacouncil-ai-profile-"));
  const file = join(directory, "profile.json");
  writeFileSync(file, `${JSON.stringify({ ...profile, profile_id: "production" })}\n`);
  assert.throws(() => loadAiAssistedSoloProfile(file), /profile_id must be "ai_assisted_solo"/u);
  assert.throws(
    () => resolveRuntimePersonaBuildProfile({ env: { ALPHACOUNCIL_PERSONA_BUILD_PROFILE: "ai_assisted_solo" } }),
    /must be production or solo_test/u,
  );
});

test("the current physical machine reviews are hash-bound and remain explicitly non-human", () => {
  const source = json(resolve(
    ROOT,
    "knowledge/ai-assisted-solo/reviews/persona-v3-ai-source-prereviews/master_buffett/buffett_berkshire_letter_2024.json",
  ));
  const sourceCheck = validateAiSourcePrereviewArtifact(source, { sourcePathRoot: null });
  assert.equal(sourceCheck.valid, true, sourceCheck.errors.join("\n"));
  const sourceTamper = structuredClone(source);
  sourceTamper.human_reviewed = true;
  const sourceTamperCheck = validateAiSourcePrereviewArtifact(sourceTamper);
  assert.equal(sourceTamperCheck.valid, false);
  assert.ok(sourceTamperCheck.errors.some((error) => /human_reviewed must remain false|differs from deterministic/u.test(error)));

  // Bound to whatever the seat's first tool is currently called: an authored method names its
  // own steps, so pinning a placeholder filename here made the test a rename detector.
  const reviewDir = resolve(
    ROOT,
    "knowledge/ai-assisted-solo/reviews/persona-v3-ai-formula-reviews/master_buffett/reviews",
  );
  const [reviewFile] = readdirSync(reviewDir).filter((name) => name.endsWith(".ai-review.json")).sort();
  assert.ok(reviewFile, "master_buffett has no machine formula review on disk");
  const formula = json(resolve(reviewDir, reviewFile));
  const schema = json(resolve(ROOT, "schemas/persona-v3-ai-formula-cross-review-v1.schema.json"));
  const formulaCheck = validateAiFormulaCrossReviewArtifact(formula, { reviewSchema: schema });
  assert.equal(formulaCheck.valid, true, formulaCheck.errors.join("\n"));
  const formulaTamper = structuredClone(formula);
  formulaTamper.roles.adjudicator.prompt_id = formulaTamper.roles.deriver.prompt_id;
  const formulaTamperCheck = validateAiFormulaCrossReviewArtifact(formulaTamper, { reviewSchema: schema });
  assert.equal(formulaTamperCheck.valid, false);
  assert.ok(formulaTamperCheck.errors.some((error) => /prompt IDs must be distinct|prompt_hash mismatch|artifact_hash mismatch/u.test(error)));
});

test("the status gate separates local AI-review readiness from unfinished release evidence", () => {
  const report = inspectAiAssistedSoloStatus();
  assert.equal(report.integrity_status, "passed", report.integrity_errors.join("\n"));
  assert.equal(report.local_test_status, "ready");
  assert.equal(report.release_status, "blocked");
  assert.equal(report.solo_packs.completed, CANONICAL_MASTER_COUNT);
  assert.equal(report.ai_review_coverage.source.completed, 31);
  assert.ok(["raw_revalidated", "packaged_capsule_only"].includes(report.ai_review_coverage.source.verification_mode));
  assert.equal(
    report.ai_review_coverage.source.raw_source_revalidated_count,
    report.ai_review_coverage.source.verification_mode === "raw_revalidated" ? 31 : 0,
  );
  assert.equal(report.ai_review_coverage.semantic.extraction.completed, 31);
  assert.equal(report.ai_review_coverage.semantic.skeptic.completed, 31);
  assert.equal(report.ai_review_coverage.semantic.adjudication.completed, 31);
  assert.equal(report.ai_review_coverage.semantic.status, "passed");
  assert.equal(report.ai_review_coverage.formula.completed, PLANNED_TOOL_COUNT);
  assert.equal(report.automated_experiment_coverage.completed, 8);
  assert.equal(report.automated_experiment_coverage.canonical_experiment_completed, 0);
  assert.equal(report.live_host_coverage.completed, 0);
  assert.equal(report.n_eff.n_eff, null);
  assert.equal(report.n_eff.status, "insufficient_resolved_outcomes");
  assert.equal(report.n_eff.disclosure_complete, true);
  assert.equal(report.human_review_satisfied, false);
  assert.equal(report.formal_ga_effect, "none");
  assert.ok(report.blockers.some((blocker) => /live host E2E 0\/4/u.test(blocker)));
  assert.equal(report.blockers.length, 1);
  assert.match(report.report_hash, /^sha256:[a-f0-9]{64}$/u);
});

test("the packaged review capsule verifies hashes without pretending to reopen omitted raw sources", () => {
  const missingRawRoot = resolve(mkdtempSync(join(tmpdir(), "alphacouncil-no-raw-")), "not-packaged");
  const report = inspectAiAssistedSoloStatus({ sourceAcquisitionRoot: missingRawRoot });
  assert.equal(report.integrity_status, "passed", report.integrity_errors.join("\n"));
  assert.equal(report.local_test_status, "ready");
  assert.equal(report.ai_review_coverage.source.completed, 31);
  assert.equal(report.ai_review_coverage.source.verification_mode, "packaged_capsule_only");
  assert.equal(report.ai_review_coverage.source.raw_source_revalidated_count, 0);
  for (const stage of ["extraction", "skeptic", "adjudication"]) {
    assert.equal(report.ai_review_coverage.semantic[stage].completed, 31, stage);
    assert.equal(report.ai_review_coverage.semantic[stage].verification_mode, "packaged_capsule_only", stage);
    assert.equal(report.ai_review_coverage.semantic[stage].raw_source_revalidated_count, 0, stage);
  }
  assert.equal(report.human_review_satisfied, false);
  assert.equal(report.formal_ga_effect, "none");
});

test("CLI modes distinguish status, local check, and the still-failing release gate", () => {
  assert.equal(parseArgs([]).requirement, "integrity");
  assert.equal(parseArgs(["--check"]).requirement, "local");
  assert.equal(parseArgs(["--gate"]).requirement, "release");
  assert.equal(parseArgs(["--require-release-ready", "--json"]).json, true);
});

test("profile and status schemas freeze the human and formal-GA boundaries", () => {
  const profileSchema = json(resolve(ROOT, "schemas/persona-v3-ai-assisted-solo-profile-v1.schema.json"));
  const statusSchema = json(resolve(ROOT, "schemas/persona-v3-ai-assisted-solo-status-v1.schema.json"));
  assert.equal(profileSchema.properties.profile_id.const, "ai_assisted_solo");
  assert.equal(profileSchema.properties.package_channel.const, "solo_test");
  assert.equal(profileSchema.properties.human_review_satisfied.const, false);
  assert.equal(profileSchema.properties.formal_ga_effect.const, "none");
  assert.equal(statusSchema.properties.human_review_satisfied.const, false);
  assert.equal(statusSchema.properties.formal_ga_effect.const, "none");
});
