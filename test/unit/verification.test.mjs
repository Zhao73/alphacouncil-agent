import { test } from "node:test";
import assert from "node:assert/strict";

import { ALL_ANALYST_TASKS } from "../../mcp/lib/constants.mjs";
import { verificationStatus } from "../../mcp/lib/gates.mjs";
import {
  REQUIRED_VERIFIER_IDS,
  buildVerifierBatchInput,
  buildVerifierHeadlessOutputSchema,
  initializeVerificationPolicy,
  materialEvidenceClaims,
  normalizeVerifierBatch,
  normalizeVerifierHeadlessTransport,
  verificationAuditStatus,
} from "../../mcp/lib/verification.mjs";

function slowAllRun() {
  const packets = ALL_ANALYST_TASKS.map((task) => ({
    task,
    confidence: "medium",
    claims: [{
      claim: `${task} material claim`,
      evidence: `${task} fixture evidence`,
      confidence: "medium",
      source_ids: [`${task}:S1`],
    }],
    sources: [{
      id: `${task}:S1`,
      title: `${task} source`,
      url: `https://example.com/${task}`,
      published_at: "2026-08-03",
      retrieved_at: "2026-08-03",
    }],
  }));
  return {
    run_id: "VERIFY-UNIT",
    symbol: "ACME",
    as_of: "2026-08-03",
    language: "English",
    council_mode: "full",
    council_pace: "slow",
    analyst_scope: "all",
    tasks: [...ALL_ANALYST_TASKS],
    masters: Array.from({ length: 26 }, (_, index) => `master_fixture_${index + 1}`),
    master_selection: {
      selection_mode: "all",
      analyst_scope: "all",
      all_master_count: 26,
    },
    packets,
    grounding: {},
    verifier_verdicts: [],
  };
}

function cleanVerdicts(run) {
  return materialEvidenceClaims(run).flatMap((claim) => [
    { verifier: "source_fidelity", claim_id: claim.claim_id, verdict: "supported", note: "source supports the claim" },
    { verifier: "rederivation", claim_id: claim.claim_id, verdict: "agree", note: "independent derivation agrees" },
    { verifier: "refuter", claim_id: claim.claim_id, verdict: "stands", note: "negative search found no rebuttal" },
  ]);
}

test("slow + all methods + all eleven analysts cannot pass with verifier count zero", () => {
  const run = slowAllRun();
  const policy = initializeVerificationPolicy(run);
  assert.equal(policy.required, true);
  assert.equal(policy.material_claim_count, 11);
  assert.equal(policy.expected_verdict_count, 33);
  assert.equal(policy.analyst_roster_complete, true);

  const audit = verificationAuditStatus(run);
  assert.equal(audit.status, "needs_verification");
  assert.equal(audit.verifier_zero, true);
  assert.equal(audit.missing.length, 33);
  assert.equal(verificationStatus(run).verification, "needs_verification");
});

test("the triple gate requires exact coverage and preserves adverse findings for weighting", () => {
  const run = slowAllRun();
  initializeVerificationPolicy(run);
  run.verifier_verdicts = cleanVerdicts(run);
  assert.equal(verificationAuditStatus(run).status, "passed");
  assert.equal(verificationStatus(run).verification, "passed");

  const missing = structuredClone(run);
  missing.verifier_verdicts.pop();
  assert.equal(verificationAuditStatus(missing).status, "needs_verification");
  assert.equal(verificationAuditStatus(missing).missing.length, 1);

  const adverse = structuredClone(run);
  adverse.verifier_verdicts[0].verdict = "partial";
  assert.equal(verificationAuditStatus(adverse).status, "completed_with_findings");
  assert.equal(verificationStatus(adverse).verification, "passed");
  assert.equal(verificationAuditStatus(adverse).non_clean.length, 1);
});

test("rederivation input hides original sources while source fidelity receives them", () => {
  const run = slowAllRun();
  const fidelity = buildVerifierBatchInput(run, "source_fidelity");
  const rederivation = buildVerifierBatchInput(run, "rederivation");
  assert.equal(fidelity.claim_count, 11);
  assert.ok(fidelity.claims.every((claim) => claim.cited_sources.length === 1));
  assert.ok(rederivation.claims.every((claim) => !Object.hasOwn(claim, "cited_sources")));
});

test("headless structured output keys every frozen claim and converts to the canonical row contract", () => {
  const run = slowAllRun();
  const expected = materialEvidenceClaims(run).slice(0, 2).map((claim) => claim.claim_id);
  const schema = buildVerifierHeadlessOutputSchema(run, "refuter", expected);
  assert.deepEqual(schema.properties.results.required, expected);
  assert.deepEqual(Object.keys(schema.properties.results.properties), expected);
  assert.equal(schema.properties.results.additionalProperties, false);
  const row = {
    verdict: "stands",
    note: "The disconfirming fixture search found no contradiction.",
    checked_urls: [],
    queries: ["fixture contradiction query"],
    excerpt: "",
    rederivation: "",
  };
  const converted = normalizeVerifierHeadlessTransport({
    verifier: "refuter",
    run_id: run.run_id,
    results: Object.fromEntries(expected.map((claimId) => [claimId, row])),
  }, run, "refuter", expected);
  assert.deepEqual(converted.results.map((result) => result.claim_id), expected);
});

test("an independently rederived primary filing may overlap the citation but remains a visible finding", () => {
  const run = slowAllRun();
  initializeVerificationPolicy(run);
  const claims = materialEvidenceClaims(run);
  const packet = {
    verifier: "rederivation",
    run_id: run.run_id,
    results: claims.map((claim) => ({
      claim_id: claim.claim_id,
      verdict: "agree",
      note: "An independent search and calculation reproduced the bounded claim.",
      checked_urls: [`https://example.com/${claim.task}`],
      queries: [`independently recompute ${claim.claim_id}`],
      excerpt: "",
      rederivation: "The independently located inputs reproduce the stated fixture value.",
    })),
  };
  const normalized = normalizeVerifierBatch(packet, run, "rederivation");
  assert.ok(normalized.results.every((result) => result.source_independence === "same_source_only"));
  run.verifier_verdicts = cleanVerdicts(run).map((verdict) => {
    const overlap = normalized.results.find((result) => (
      result.verifier === verdict.verifier && result.claim_id === verdict.claim_id
    ));
    return overlap || verdict;
  });
  const audit = verificationAuditStatus(run);
  assert.equal(audit.status, "completed_with_findings");
  assert.equal(audit.non_clean.filter((finding) => finding.verdict === "agree_same_source_only").length, claims.length);
});

test("a verifier batch must cover every frozen claim exactly once and obey its verdict space", () => {
  const run = slowAllRun();
  initializeVerificationPolicy(run);
  const claims = materialEvidenceClaims(run);
  const packet = {
    verifier: "source_fidelity",
    run_id: run.run_id,
    results: claims.map((claim) => ({
      claim_id: claim.claim_id,
      verdict: "supported",
      note: "The cited fixture sentence supports this bounded claim.",
      checked_urls: [`https://example.com/${claim.task}`],
      queries: [],
      excerpt: "Fixture evidence supports the bounded claim.",
      rederivation: "",
    })),
  };
  const normalized = normalizeVerifierBatch(packet, run, "source_fidelity");
  assert.equal(normalized.results.length, 11);
  assert.ok(normalized.results.every((row) => row.verifier === "source_fidelity"));

  const multiSourceRun = slowAllRun();
  multiSourceRun.packets[0].claims[0].source_ids.push(`${ALL_ANALYST_TASKS[0]}:S2`);
  multiSourceRun.packets[0].sources.push({
    id: `${ALL_ANALYST_TASKS[0]}:S2`,
    title: "second source",
    url: `https://example.com/${ALL_ANALYST_TASKS[0]}/second`,
    published_at: "2026-08-03",
    retrieved_at: "2026-08-03",
  });
  assert.throws(
    () => normalizeVerifierBatch(packet, multiSourceRun, "source_fidelity"),
    (error) => error?.data?.details?.problems?.some?.((problem) => (
      problem.reason === "source_fidelity_did_not_check_every_cited_url"
    )) || error?.data?.problems?.some?.((problem) => (
      problem.reason === "source_fidelity_did_not_check_every_cited_url"
    )),
  );

  const partial = structuredClone(packet);
  partial.results.pop();
  assert.throws(
    () => normalizeVerifierBatch(partial, run, "source_fidelity"),
    (error) => error?.data?.reason === "VERIFIER_BATCH_COVERAGE_MISMATCH",
  );
  assert.deepEqual(REQUIRED_VERIFIER_IDS, ["source_fidelity", "rederivation", "refuter"]);
});
