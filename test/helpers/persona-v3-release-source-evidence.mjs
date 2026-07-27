import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { signCanonicalAttestation } from "../../mcp/lib/personas-v3/attestations.mjs";
import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";

const REVIEWERS = [
  { keyId: "source-review:key-a", principal: "Source Reviewer A", ...generateKeyPairSync("ed25519") },
  { keyId: "source-review:key-b", principal: "Source Reviewer B", ...generateKeyPairSync("ed25519") },
];

export const TRUSTED_SOURCE_REVIEW_KEYS = Object.freeze(Object.fromEntries(REVIEWERS.map((reviewer) => [
  reviewer.keyId,
  {
    public_key: reviewer.publicKey,
    principal_id: reviewer.principal,
    purposes: ["source_review"],
  },
])));

export function createEmptyReleaseAdjudicationRoot(root) {
  mkdirSync(root);
  for (const personaId of CANONICAL_MASTER_IDS) {
    const seat = join(root, personaId);
    mkdirSync(seat);
    writeFileSync(join(seat, "source-adjudication-ledger.json"), `${JSON.stringify({
      schema_version: 1,
      artifact_kind: "source_adjudication_ledger",
      persona_id: personaId,
      records: [],
    }, null, 2)}\n`);
  }
  return root;
}

export function releaseSourceEvidenceOptions(adjudicationRoot) {
  return {
    adjudicationRoot,
    trustedReviewerKeys: TRUSTED_SOURCE_REVIEW_KEYS,
  };
}

export function installApprovedReleaseSource({ sourceRoot, adjudicationRoot, personaId }) {
  const candidateId = `candidate_${personaId.replace(/^master_/u, "")}`;
  const sourceId = `${personaId}:primary_method`;
  const contentHash = sha256({ personaId, bytes: "fixture-reviewed-source" });
  const subject = canonicalValue({
    schema_version: 1,
    source_id: sourceId,
    source_kind: "primary_text",
    grade: "A",
    author: "Fixture Primary Author",
    title: `Fixture primary source for ${personaId}`,
    url: `https://example.test/${personaId}/primary`,
    published_at: "2026-07-26T00:00:00.000Z",
    public_at: "2026-07-26T00:00:00.000Z",
    known_at: "2026-07-26T00:00:00.000Z",
    retrieved_at: "2026-07-26T01:00:00.000Z",
    locator: { section: "Method statement" },
    summary: "A fixture-only primary method statement inspected by two test reviewers.",
    content_hash: contentHash,
    supports: ["doctrine:fixture-method"],
  });
  const anchorHash = sha256(subject);
  let previous = null;
  const attestations = REVIEWERS.map((reviewer, index) => {
    const unsigned = canonicalValue({
      schema_version: 2,
      artifact_kind: "persona_v3_source_review_attestation",
      reviewer_id: reviewer.principal,
      signer_key_id: reviewer.keyId,
      decision: "approve",
      content_hash: contentHash,
      anchor_hash: anchorHash,
      reviewed_at: `2026-07-27T0${index + 8}:00:00.000Z`,
      affirmations: {
        reviewed_raw_archive_bytes: true,
        verified_locator_against_raw_material: true,
        reviewer_is_human: true,
        review_was_independent: true,
      },
      notes: "Fixture reviewer inspected the bound source bytes and locator.",
    });
    const signed = canonicalValue({
      ...unsigned,
      signature: signCanonicalAttestation(unsigned, {
        privateKey: reviewer.privateKey,
        signerKeyId: reviewer.keyId,
      }),
      normalized_reviewer_id: reviewer.principal,
      previous_attestation_hash: previous,
    });
    const persisted = canonicalValue({ ...signed, attestation_hash: sha256(signed) });
    previous = persisted.attestation_hash;
    return persisted;
  });
  const anchor = canonicalValue({
    ...subject,
    adjudication: {
      status: "approved",
      reviewer_ids: REVIEWERS.map((reviewer) => reviewer.principal).sort(),
      reviewed_at: attestations.at(-1).reviewed_at,
      notes: "two_independent_cryptographically_verified_human_approvals",
    },
  });
  const proposal = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_source_anchor_proposal",
    persona_id: personaId,
    candidate_id: candidateId,
    source_id: sourceId,
    source_kind: subject.source_kind,
    grade: subject.grade,
    author: subject.author,
    title: subject.title,
    url: subject.url,
    published_at: subject.published_at,
    public_at: subject.public_at,
    known_at: subject.known_at,
    locator: subject.locator,
    summary: subject.summary,
    supports: subject.supports,
  });
  const manifest = JSON.parse(readFileSync(join(sourceRoot, personaId, "manifest.json"), "utf8"));
  writeFileSync(
    join(sourceRoot, personaId, manifest.components.sources),
    `${JSON.stringify([anchor], null, 2)}\n`,
  );
  const ledger = canonicalValue({
    schema_version: 1,
    artifact_kind: "source_adjudication_ledger",
    persona_id: personaId,
    records: [{
      schema_version: 1,
      persona_id: personaId,
      candidate_id: candidateId,
      source_id: sourceId,
      status: "approved",
      status_reason: "two_independent_cryptographically_verified_human_approvals",
      acquisition: {
        record_path: `acquisitions/candidates/${candidateId}/record.json`,
        archive_path: `acquisitions/candidates/${candidateId}/source.bin`,
        record_hash: sha256({ personaId, candidateId, kind: "acquisition" }),
        content_hash: contentHash,
        byte_length: 100,
      },
      proposal,
      proposal_hash: sha256(proposal),
      anchor_hash: anchorHash,
      prepared_at: "2026-07-26T02:00:00.000Z",
      review_attestations: attestations,
      attestation_chain_head: attestations.at(-1).attestation_hash,
    }],
  });
  writeFileSync(
    join(adjudicationRoot, personaId, "source-adjudication-ledger.json"),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
  return { anchor, ledger, sourceId, anchorHash, contentHash };
}
