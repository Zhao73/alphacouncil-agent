import { test } from "node:test";
import assert from "node:assert/strict";

import { ALL_ANALYST_TASKS } from "../../mcp/lib/constants.mjs";
import { verificationStatus } from "../../mcp/lib/gates.mjs";
import {
  REQUIRED_VERIFIER_IDS,
  buildVerifierBatchInput,
  buildVerifierClaimChunks,
  buildVerifierHeadlessOutputSchema,
  hardVerificationFindings,
  assertVerificationFindingsAck,
  initializeVerificationPolicy,
  materialEvidenceClaims,
  normalizeVerifierBatch,
  normalizeVerifierHeadlessTransport,
  verificationAuditStatus,
  verifierBatchPrompt,
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

function urlWeightedRun() {
  const run = slowAllRun();
  const task = ALL_ANALYST_TASKS[0];
  const urlCounts = [3, 2, 1, 5, 1];
  let sourceNumber = 0;
  const sources = [];
  const claims = urlCounts.map((urlCount, claimIndex) => {
    const source_ids = Array.from({ length: urlCount }, () => {
      sourceNumber += 1;
      const id = `${task}:S${sourceNumber}`;
      sources.push({
        id,
        title: `${task} source ${sourceNumber}`,
        url: `https://example.com/${task}/source-${sourceNumber}`,
        published_at: "2026-08-03",
        retrieved_at: "2026-08-03",
      });
      return id;
    });
    return {
      claim: `${task} URL-weighted claim ${claimIndex + 1}`,
      evidence: `${task} URL-weighted fixture evidence ${claimIndex + 1}`,
      confidence: "medium",
      source_ids,
    };
  });
  return {
    ...run,
    tasks: [task],
    packets: [{ task, confidence: "medium", claims, sources }],
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

test("the portfolio manager must acknowledge every hard verifier finding exactly once", () => {
  const run = slowAllRun();
  initializeVerificationPolicy(run);
  run.verifier_verdicts = cleanVerdicts(run);
  run.verifier_verdicts.find((row) => row.verifier === "source_fidelity").verdict = "contradicted";
  run.verifier_verdicts.find((row) => row.verifier === "rederivation").verdict = "disagree";
  run.verifier_verdicts.find((row) => row.verifier === "refuter").verdict = "refuted";

  const findings = hardVerificationFindings(run);
  assert.equal(findings.length, 3);
  const acknowledgement = findings.map((finding) => ({
    finding_id: finding.finding_id,
    disposition: finding.verifier === "rederivation" ? "corrected" : "excluded",
    note: `The final decision explicitly handles ${finding.finding_id}.`,
  }));
  const normalized = assertVerificationFindingsAck({ verification_findings_ack: acknowledgement }, run);
  assert.deepEqual(normalized.map((row) => row.finding_id), findings.map((row) => row.finding_id));
  assert.ok(normalized.every((row) => row.acknowledgement_note.length >= 12));

  assert.throws(
    () => assertVerificationFindingsAck({ verification_findings_ack: acknowledgement.slice(1) }, run),
    (error) => error?.data?.reason === "VERIFICATION_FINDINGS_ACK_MISMATCH",
  );
  assert.throws(
    () => assertVerificationFindingsAck({ verification_findings_ack: [...acknowledgement, acknowledgement[0]] }, run),
    (error) => error?.data?.reason === "VERIFICATION_FINDINGS_ACK_MISMATCH",
  );
  const invalid = structuredClone(acknowledgement);
  invalid[0].disposition = "ignored";
  assert.throws(
    () => assertVerificationFindingsAck({ verification_findings_ack: invalid }, run),
    (error) => error?.data?.reason === "VERIFICATION_FINDINGS_ACK_MISMATCH",
  );
});

test("rederivation input hides original sources while source fidelity receives them", () => {
  const run = slowAllRun();
  const fidelity = buildVerifierBatchInput(run, "source_fidelity");
  const rederivation = buildVerifierBatchInput(run, "rederivation");
  assert.equal(fidelity.claim_count, 11);
  assert.ok(fidelity.claims.every((claim) => claim.cited_sources.length === 1));
  assert.ok(rederivation.claims.every((claim) => !Object.hasOwn(claim, "cited_sources")));
});

test("source fidelity chunks by per-claim URL obligations while preserving frozen claim order", () => {
  const run = urlWeightedRun();
  const claimIds = materialEvidenceClaims(run).map((claim) => claim.claim_id);
  const chunks = buildVerifierClaimChunks(run, "source_fidelity", {
    maxClaimsPerBatch: 3,
    maxSourceUrlsPerBatch: 4,
  });
  assert.deepEqual(chunks, [
    [claimIds[0]],
    [claimIds[1], claimIds[2]],
    [claimIds[3]],
    [claimIds[4]],
  ]);
  assert.deepEqual(chunks.flat(), claimIds);

  const input = buildVerifierBatchInput(run, "source_fidelity");
  const urlsByClaim = new Map(input.claims.map((claim) => [claim.claim_id, claim.cited_sources.length]));
  for (const chunk of chunks) {
    const urlCount = chunk.reduce((sum, claimId) => sum + urlsByClaim.get(claimId), 0);
    assert.ok(urlCount <= 4 || chunk.length === 1, "only one atomic oversized claim may exceed the URL budget");
  }
  assert.deepEqual(buildVerifierClaimChunks(run, "refuter", { maxClaimsPerBatch: 3 }), [
    claimIds.slice(0, 3),
    claimIds.slice(3),
  ]);
});

test("source fidelity prompt binds every required URL to its claim without treating the checklist as evidence", () => {
  const run = urlWeightedRun();
  const expectedClaimIds = materialEvidenceClaims(run).slice(0, 2).map((claim) => claim.claim_id);
  const input = buildVerifierBatchInput(run, "source_fidelity", { expectedClaimIds });
  const prompt = verifierBatchPrompt(run, "source_fidelity", "/tmp/fidelity-input.json", {
    keyedResults: true,
    expectedClaimIds,
  });
  assert.match(prompt, /REQUIRED checked_urls BY CLAIM \(binding work checklist\)/u);
  assert.match(prompt, /actually open or attempt EVERY URL/u);
  assert.match(prompt, /NOT evidence that retrieval happened and MUST NOT be copied blindly/u);
  for (const claim of input.claims) {
    assert.ok(prompt.includes(claim.claim_id));
    assert.ok(claim.cited_sources.every((source) => prompt.includes(source.url)));
  }
  assert.ok(!prompt.includes(`${ALL_ANALYST_TASKS[0]}:C3`));
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
  assert.deepEqual(packet.results[0].checked_urls, [`https://example.com/${ALL_ANALYST_TASKS[0]}`],
    "coverage validation must not auto-fill an unchecked URL");

  const partial = structuredClone(packet);
  partial.results.pop();
  assert.throws(
    () => normalizeVerifierBatch(partial, run, "source_fidelity"),
    (error) => error?.data?.reason === "VERIFIER_BATCH_COVERAGE_MISMATCH",
  );
  assert.deepEqual(REQUIRED_VERIFIER_IDS, ["source_fidelity", "rederivation", "refuter"]);
});
