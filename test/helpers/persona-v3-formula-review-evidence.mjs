import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  buildFormulaApprovalBundle,
  buildFormulaReviewSigningRequest,
  formulaReviewSubjectHash,
  signFormulaReviewAttestation,
} from "../../mcp/lib/personas-v3/formula-review-attestations.mjs";
import {
  FORMULA_EXECUTABLE_STATUS,
  compileApprovedFormulaSpec,
  formulaApprovalCandidateRelativePath,
  formulaSpecCandidateRelativePath,
  planPersonaV3FormulaPipeline,
} from "../../scripts/lib/persona-v3-formula-pipeline.mjs";
import { REPO_ROOT } from "../../scripts/lib/persona-v3-build-specs.mjs";

export const TEST_FORMULA_REVIEWERS = [
  { principal_id: "Formula Reviewer A", key_id: "test.formula-reviewer-a" },
  { principal_id: "Formula Reviewer B", key_id: "test.formula-reviewer-b" },
].map((reviewer) => ({ ...reviewer, ...generateKeyPairSync("ed25519") }));

const REVIEWERS = TEST_FORMULA_REVIEWERS;

export const TRUSTED_FORMULA_REVIEW_KEYS = Object.fromEntries(REVIEWERS.map((reviewer) => [
  reviewer.key_id,
  {
    public_key: reviewer.publicKey,
    principal_id: reviewer.principal_id,
    purposes: ["formula_review"],
  },
]));

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function approvedFormulaSpec(entry = planPersonaV3FormulaPipeline().inventory.entries[0]) {
  const spec = clone(entry.formula_spec);
  spec.artifact_status = FORMULA_EXECUTABLE_STATUS;
  spec.formula = {
    version: "1.0.0",
    kind: "recomputation",
    operation: "identity",
    on_missing: "fail",
    inputs: [{
      operand: { fact_id: spec.authorship_request.candidate_input_fact_types[0] },
      value_kind: "scalar",
      unit: "reviewed_fixture_units",
      period: { basis: "instant", window: null, alignment: "as_of" },
      on_missing: "fail",
    }],
    output: {
      output_id: spec.authorship_request.candidate_output_fact_types[0],
      value_kind: "scalar",
      unit: "reviewed_fixture_units",
      period: { basis: "instant", window: null, alignment: "as_of" },
    },
  };
  spec.provenance = {
    basis_type: "reviewed_internal_derivation",
    source_ids: [`test:formula:${spec.tool_id}`],
    formula_citation: "Test-only exact identity formula; not a production method claim.",
    author_id: "test_formula_author",
    authored_at: "2026-07-27T00:00:00.000Z",
    source_as_of: "2026-07-27",
  };
  spec.review = {
    status: "approved",
    reviewer_ids: REVIEWERS.map((reviewer) => reviewer.principal_id),
    reviewed_at: "2026-07-27T02:00:00.000Z",
    approval_reference: `test-only:${spec.formula_spec_id}`,
    review_subject_hash: null,
  };
  spec.review.review_subject_hash = formulaReviewSubjectHash(spec);
  return spec;
}

export function signedFormulaApprovalBundle(spec, {
  reviewers = REVIEWERS,
  decisions = ["approve", "approve"],
  reviewedAt = ["2026-07-27T01:00:00.000Z", "2026-07-27T02:00:00.000Z"],
} = {}) {
  const attestations = reviewers.map((reviewer, index) => {
    const request = buildFormulaReviewSigningRequest(spec, {
      reviewer_id: reviewer.principal_id,
      signer_key_id: reviewer.key_id,
      decision: decisions[index] || "approve",
      reviewed_at: reviewedAt[index] || reviewedAt.at(-1),
    });
    return signFormulaReviewAttestation(request, {
      privateKey: reviewer.privateKey,
      signerKeyId: reviewer.key_id,
    });
  });
  return buildFormulaApprovalBundle({ formulaSpec: spec, attestations });
}

export function installAllFormulaCandidates(candidateRoot) {
  const entries = planPersonaV3FormulaPipeline().inventory.entries;
  const records = [];
  for (const entry of entries) {
    const spec = approvedFormulaSpec(entry);
    const bundle = signedFormulaApprovalBundle(spec);
    const specFile = resolve(candidateRoot, formulaSpecCandidateRelativePath(entry.persona_id, entry.tool_id));
    const approvalFile = resolve(candidateRoot, formulaApprovalCandidateRelativePath(entry.persona_id, entry.tool_id));
    mkdirSync(resolve(specFile, ".."), { recursive: true });
    mkdirSync(resolve(approvalFile, ".."), { recursive: true });
    writeFileSync(specFile, `${JSON.stringify(spec, null, 2)}\n`);
    writeFileSync(approvalFile, `${JSON.stringify(bundle, null, 2)}\n`);
    records.push({ entry, spec, bundle });
  }
  return records;
}

export function installFormulaEvidenceIntoPack(packRoot, personaId, toolsRelativePath) {
  const tools = [];
  for (const entry of planPersonaV3FormulaPipeline().inventory.entries
    .filter((candidate) => candidate.persona_id === personaId)) {
    const spec = approvedFormulaSpec(entry);
    const bundle = signedFormulaApprovalBundle(spec);
    const prototypeDocument = JSON.parse(readFileSync(join(REPO_ROOT, spec.prototype_provenance.source_path), "utf8"));
    tools.push(compileApprovedFormulaSpec(spec, {
      prototypeDocument,
      approvalBundle: bundle,
      trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
      now: new Date("2026-07-27T12:00:00.000Z"),
    }));
    const evidenceFile = resolve(packRoot,
      `formula-approvals/${entry.tool_id.slice(personaId.length + 1)}.approval-bundle.json`);
    mkdirSync(dirname(evidenceFile), { recursive: true });
    writeFileSync(evidenceFile, `${JSON.stringify(bundle, null, 2)}\n`);
  }
  const toolsFile = resolve(packRoot, toolsRelativePath);
  mkdirSync(dirname(toolsFile), { recursive: true });
  writeFileSync(toolsFile, `${JSON.stringify(tools, null, 2)}\n`);
  return tools;
}
