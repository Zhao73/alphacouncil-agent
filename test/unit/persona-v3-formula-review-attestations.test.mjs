import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  buildFormulaApprovalBundle,
  buildFormulaReviewSigningRequest,
  formulaReviewSubjectHash,
  signFormulaReviewAttestation,
  verifyFormulaApprovalBundle,
} from "../../mcp/lib/personas-v3/formula-review-attestations.mjs";
import {
  compileApprovedFormulaSpec,
  planPersonaV3FormulaPipeline,
} from "../../scripts/lib/persona-v3-formula-pipeline.mjs";
import { REPO_ROOT } from "../../scripts/lib/persona-v3-build-specs.mjs";
import {
  TEST_FORMULA_REVIEWERS,
  TRUSTED_FORMULA_REVIEW_KEYS,
  approvedFormulaSpec,
  clone,
  signedFormulaApprovalBundle,
} from "../helpers/persona-v3-formula-review-evidence.mjs";

const NOW = new Date("2026-07-27T12:00:00.000Z");

function prototype(spec) {
  return JSON.parse(readFileSync(join(REPO_ROOT, spec.prototype_provenance.source_path), "utf8"));
}

test("two different trusted formula-review principals approve the complete immutable spec", () => {
  const spec = approvedFormulaSpec();
  const bundle = signedFormulaApprovalBundle(spec);
  const verified = verifyFormulaApprovalBundle(bundle, {
    trustedKeyRegistry: TRUSTED_FORMULA_REVIEW_KEYS,
    now: NOW,
    expectedFormulaSpec: spec,
  });
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.reviewer_principal_ids, ["Formula Reviewer A", "Formula Reviewer B"]);

  const tool = compileApprovedFormulaSpec(spec, {
    prototypeDocument: prototype(spec),
    approvalBundle: bundle,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: NOW,
  });
  assert.equal(tool.formula_spec_hash, verified.formula_spec_hash);
  assert.equal(tool.formula_review_subject_hash, verified.review_subject_hash);
  assert.equal(tool.approval_bundle_hash, verified.approval_bundle_hash);
});

test("one reviewer, two keys for one principal, and a rejection cannot approve", () => {
  const spec = approvedFormulaSpec();
  const valid = signedFormulaApprovalBundle(spec);
  const one = buildFormulaApprovalBundle({ formulaSpec: spec, attestations: valid.attestations.slice(0, 1) });
  assert.equal(verifyFormulaApprovalBundle(one, {
    trustedKeyRegistry: TRUSTED_FORMULA_REVIEW_KEYS, now: NOW,
  }).valid, false);

  const samePrincipalSpec = approvedFormulaSpec();
  samePrincipalSpec.review.reviewer_ids = ["Same Formula Reviewer", "Same Formula Reviewer"];
  samePrincipalSpec.review.review_subject_hash = formulaReviewSubjectHash(samePrincipalSpec);
  const samePrincipalAttestations = TEST_FORMULA_REVIEWERS.map((reviewer, index) => signFormulaReviewAttestation(
    buildFormulaReviewSigningRequest(samePrincipalSpec, {
      reviewer_id: "Same Formula Reviewer",
      signer_key_id: reviewer.key_id,
      decision: "approve",
      reviewed_at: index === 0 ? "2026-07-27T01:00:00.000Z" : "2026-07-27T02:00:00.000Z",
    }),
    { privateKey: reviewer.privateKey, signerKeyId: reviewer.key_id },
  ));
  const samePrincipalKeys = Object.fromEntries(TEST_FORMULA_REVIEWERS.map((reviewer) => [
    reviewer.key_id,
    { public_key: reviewer.publicKey, principal_id: "Same Formula Reviewer", purposes: ["formula_review"] },
  ]));
  const samePrincipal = verifyFormulaApprovalBundle(buildFormulaApprovalBundle({
    formulaSpec: samePrincipalSpec,
    attestations: samePrincipalAttestations,
  }), { trustedKeyRegistry: samePrincipalKeys, now: NOW });
  assert.equal(samePrincipal.valid, false);
  assert.equal(samePrincipal.reason, "insufficient_independent_formula_approvals");

  const rejected = signedFormulaApprovalBundle(spec, { decisions: ["approve", "reject"] });
  assert.equal(verifyFormulaApprovalBundle(rejected, {
    trustedKeyRegistry: TRUSTED_FORMULA_REVIEW_KEYS, now: NOW,
  }).valid, false);
});

test("unsigned, untrusted, revoked and wrong-purpose formula reviews fail closed", () => {
  const spec = approvedFormulaSpec();
  const unsigned = clone(signedFormulaApprovalBundle(spec));
  delete unsigned.attestations[0].signature;
  assert.equal(verifyFormulaApprovalBundle(unsigned, {
    trustedKeyRegistry: TRUSTED_FORMULA_REVIEW_KEYS, now: NOW,
  }).valid, false);

  const bundle = signedFormulaApprovalBundle(spec);
  assert.equal(verifyFormulaApprovalBundle(bundle, { trustedKeyRegistry: {}, now: NOW }).valid, false);
  const revoked = Object.fromEntries(TEST_FORMULA_REVIEWERS.map((reviewer) => [reviewer.key_id, {
    public_key: reviewer.publicKey, principal_id: reviewer.principal_id,
    purposes: ["formula_review"], revoked: true,
  }]));
  assert.equal(verifyFormulaApprovalBundle(bundle, { trustedKeyRegistry: revoked, now: NOW }).valid, false);
  const wrongPurpose = Object.fromEntries(TEST_FORMULA_REVIEWERS.map((reviewer) => [reviewer.key_id, {
    public_key: reviewer.publicKey, principal_id: reviewer.principal_id,
    purposes: ["source_review"],
  }]));
  assert.equal(verifyFormulaApprovalBundle(bundle, { trustedKeyRegistry: wrongPurpose, now: NOW }).valid, false);
});

test("tampering plus a self-computed subject hash and cross-tool replay cannot compile", () => {
  const spec = approvedFormulaSpec();
  const original = signedFormulaApprovalBundle(spec);
  const tamperedSpec = clone(spec);
  tamperedSpec.formula.output.unit = "tampered_units";
  tamperedSpec.review.review_subject_hash = formulaReviewSubjectHash(tamperedSpec);
  const tampered = buildFormulaApprovalBundle({ formulaSpec: tamperedSpec, attestations: original.attestations });
  const tamperedVerification = verifyFormulaApprovalBundle(tampered, {
    trustedKeyRegistry: TRUSTED_FORMULA_REVIEW_KEYS, now: NOW,
  });
  assert.equal(tamperedVerification.valid, false);

  const otherEntry = planPersonaV3FormulaPipeline().inventory.entries[1];
  const otherSpec = approvedFormulaSpec(otherEntry);
  assert.throws(() => compileApprovedFormulaSpec(otherSpec, {
    prototypeDocument: prototype(otherSpec),
    approvalBundle: original,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: NOW,
  }), /invalid_bundle|different formula spec/u);
});
