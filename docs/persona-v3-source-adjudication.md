# PersonaPack v3 source adjudication

This pipeline closes the gap between “we archived some bytes” and “humans approved a source anchor.” It operates only in `knowledge/staging/personas-v3`; it does not edit `knowledge/masters`, create a `manifest.json`, change maturity, or mutate an acquisition record.

The three layers are intentionally separate:

1. `acquire-persona-source.mjs` archives exact response bytes and a `retrieved_unadjudicated` record. It cannot grade or approve.
2. `adjudicate-persona-source.mjs prepare` binds those verified bytes to metadata supplied verbatim in a human proposal JSON. It creates a pending queue anchor with zero reviewers.
3. `adjudicate-persona-source.mjs review` verifies Ed25519-signed human attestations against the exact content and anchor hashes. Only two approvals from distinct trusted reviewer principals can approve the anchor.

The staging queue remains a strict array of `source-anchor-v1` records. The separate `source-adjudication-ledger.json` retains the acquisition binding, exact proposal, every attestation, and the attestation hash chain. This preserves compatibility with staging validation while keeping review provenance auditable.

## AI-assisted pre-review lane

The repository also has a role-separated machine pre-review lane for triage when a solo
maintainer has no second human reviewer:

```bash
npm run persona:source:ai-prereview:write
npm run persona:source:ai-prereview:check -- --json
```

It creates one deterministic artifact per archived candidate under
`knowledge/ai-assisted-solo/reviews/persona-v3-ai-source-prereviews/<persona_id>/<candidate_id>.json`.
The current inventory contains 31 artifacts across 25 sourced seats and 93 role outputs:

1. `ai_source_extractor_v1` independently verifies the archived byte length, raw SHA-256
   and deterministic file-format probe. It explicitly performs no semantic extraction.
2. `ai_source_skeptic_v1` independently records missing proposition, locator, attribution,
   publication-date and grade evidence.
3. `ai_source_adjudicator_v1` reads only the two preceding output hashes and records the
   machine disposition `requires_human_review`.

Every role has a distinct prompt ID/hash, an input-binding hash and an output hash. The
top-level artifact is bound to the canonical acquisition-record hash and the exact raw
`source.bin` content hash. `--check` reconstructs the expected artifact from those bytes,
recomputes every hash, rejects symlinks/unexpected files and fails on any difference.
`--write` creates only missing files and refuses to overwrite an existing mismatch.

The boundary is machine-enforced: `reviewer_kind=ai`, `human_reviewed=false`,
`human_claims=false`, `semantic_review_performed=false`,
`method_attribution_approved=false`, and `production_effect=none`. These artifacts never
enter `source-adjudication-ledger.json`, have no signature field, are not accepted by the
trusted source-review key registry, cannot satisfy either human principal in the quorum,
and are excluded from production packs. They reduce manual sorting work; they do not turn
one maintainer plus several model calls into independent human review.

The machine artifact schema is `schemas/ai-source-prereview-v1.schema.json`; the deterministic
implementation and validator are in
`mcp/lib/personas-v3/ai-source-pre-review.mjs`.

### Round-1 semantic extractor

The second isolated tree contains actual machine reading of the archived HTML/PDF bytes,
but still only the extractor stage:

```bash
npm run persona:source:semantic:write
npm run persona:source:semantic:check -- --json
```

`knowledge/ai-assisted-solo/reviews/persona-v3-ai-semantic-extractions/` contains 31 source-bound artifacts:
26 readable, four partial and two unreadable. The readable set records 29 concise method
propositions, each with a short exact excerpt, snippet hash, and PDF page or HTML text
offset. Poppler extraction output, page counts and extracted-text hashes are recomputed by
the validator. Burry, Duan Yongping, Klarman, Munger, Simons and Thorp archives were
insufficient for safe method extraction and therefore contain zero propositions rather
than model-memory replacements.

These are AI extractor notes only. They set `human_reviewed=false`,
`method_attribution_approved=false` and `production_effect=none`; they contain no skeptic
or adjudicator result and do not enter the human source ledger or production loader.

### Round-2 semantic skeptic

The independent skeptic reopens the original `source.bin` bytes rather than accepting the
extractor summary. It recomputes acquisition record/content hashes, Poppler or HTML text,
page/offset locators and snippet hashes, then challenges proposition support and
authorship/scope/date ambiguity:

```bash
npm run persona:source:semantic:skeptic:write
npm run persona:source:semantic:skeptic:check -- --json
```

`knowledge/ai-assisted-solo/reviews/persona-v3-ai-semantic-skeptic-reviews/` contains 31 machine-labelled
skeptic artifacts plus one index. All 32 raw/extracted-text bindings pass. Of the 29 proposed
propositions, 18 are supported by their exact source context and 11 are partial because the
extractor generalized a case, combined nearby principles, or bound too narrow a snippet.
At candidate level the results are 16 supported, 10 partial and six unverifiable; the six
unverifiable candidates are the same archives that do not expose reviewable primary text.

This stage remains `role=skeptic`, `reviewer_kind=ai`, `human_reviewed=false`,
`method_attribution_approved=false`, and `production_effect=none`. A supported machine
verdict is not a source grade, independent human principal, method attribution approval, or
production admission.

### Round-3 semantic adjudicator

The third machine process independently reopens every original `source.bin`, recomputes the
raw-byte, acquisition-record, extracted-text, exact locator and snippet hashes, validates
both prior artifacts, and compares each extractor claim with the skeptic challenges:

```bash
npm run persona:source:semantic:adjudicator:write
npm run persona:source:semantic:adjudicator:check -- --json
```

`knowledge/ai-assisted-solo/reviews/persona-v3-ai-semantic-adjudications/` contains 31 adjudications plus an
index. The 28 final proposition verdicts are 18 supported, 10 partial, zero unsupported and
zero unverifiable; the 32 candidate verdicts are 16 supported, 10 partial, zero unsupported
and six unverifiable. Each proposition records exact content/hash bindings, extractor and
skeptic agreements or disagreements, final rationale, and unresolved authorship, scope and
date questions. These remain machine-only artifacts with `reviewer_kind=ai`,
`role=adjudicator`, `human_reviewed=false`, `method_attribution_approved=false` and
`production_effect=none`; they do not create a human approval, signature, source grade, or
production/GA effect.

## Human review operations batch

Generate the global 26-seat review view before asking anyone to fill metadata or review a
source. Check mode is the default and writes nothing:

```bash
npm run persona:source:review-batch -- --check --json

# Create one new audit artifact only after choosing an explicit non-production path.
npm run persona:source:review-batch -- \
  --output /absolute/non-production/path/source-review-batch.json \
  --trusted-reviewer-keys /absolute/path/to/reviewer-public-keys.json \
  --write
```

The batch contains every canonical seat, each immutable acquisition record and raw archive
path relative to the selected staging root, record/content hashes, a deliberately invalid human proposal template, proposal and
anchor hashes once prepared, exact-locator gaps, an unsigned review template, reviewer
instructions, and global progress. The export does not copy raw bytes, infer a locator,
prepare a source, add a review, or mutate staging. `--write` uses exclusive creation and
refuses an existing output file or any destination inside production knowledge.

The progress report counts approval quorum only when current signatures verify against the
provided trusted public-key registry. Two signing keys bound to one normalized principal
still count as one human. A source is quorate only with two distinct trusted principals,
two distinct keys, no valid reject, no principal-level decision conflict, and no invalid
attestation. The 26-seat global flag is false unless every canonical seat has at least one
such source. A bare ledger status or `reviewer_ids` array is never accepted as quorum proof.

## Commands and write boundary

```bash
# Read-only inventory; also the default when no operation is supplied.
node scripts/adjudicate-persona-source.mjs --check

# Read and validate the archived bytes and human proposal. No mutation.
node scripts/adjudicate-persona-source.mjs prepare \
  --persona master_buffett \
  --candidate-id REAL_CANDIDATE_ID \
  --proposal /absolute/path/to/human-proposal.json

# Perform the prepared write only after inspecting the plan.
node scripts/adjudicate-persona-source.mjs prepare \
  --persona master_buffett \
  --candidate-id REAL_CANDIDATE_ID \
  --proposal /absolute/path/to/human-proposal.json \
  --write

# Review is also plan-only unless --write is explicit.
node scripts/adjudicate-persona-source.mjs review \
  --persona master_buffett \
  --source-id REAL_SOURCE_ID \
  --attestation /absolute/path/to/human-review.json \
  --trusted-reviewer-keys /absolute/path/to/reviewer-public-keys.json
```

`--proposal` and `--attestation` must point to physical regular JSON files. Symlinked inputs are rejected. `--json` returns machine-readable results.

## Human proposal contract

Author, title, publication dates, public-availability date, locator, summary, source kind, grade and `supports` must all be entered by a human who inspected the material. The program neither extracts nor guesses them. The URL must equal the immutable acquisition’s requested or final URL.

```json
{
  "schema_version": 1,
  "artifact_kind": "persona_v3_source_anchor_proposal",
  "persona_id": "master_buffett",
  "candidate_id": "REPLACE_WITH_REAL_CANDIDATE_ID",
  "source_id": "REPLACE_WITH_REAL_SOURCE_ID",
  "source_kind": "primary_text",
  "grade": "A",
  "author": "REPLACE_AFTER_READING_SOURCE",
  "title": "REPLACE_AFTER_READING_SOURCE",
  "url": "REPLACE_WITH_EXACT_ACQUISITION_URL",
  "published_at": "REPLACE_WITH_VERIFIED_DATE",
  "public_at": "REPLACE_WITH_VERIFIED_DATE",
  "known_at": null,
  "locator": { "section": "REPLACE_WITH_EXACT_LOCATOR" },
  "summary": "REPLACE_WITH_A_HUMAN_PARAPHRASE_OF_THE_SUPPORTED_METHOD_CLAIM",
  "supports": ["REPLACE_WITH_THE_RULE_OR_CASE_ID"]
}
```

These placeholders intentionally fail validation. Do not replace them with model-generated guesses.

Prepare reopens `record.json` and `source.bin` without following symlinks, validates the acquisition record, recomputes byte length and SHA-256, and binds:

- canonical acquisition-record hash;
- raw content hash and byte length;
- exact human proposal and proposal hash;
- immutable anchor hash excluding mutable adjudication status.

The resulting queue anchor is always `pending`, with `reviewer_ids: []`.

## Human review contract

Each reviewer must inspect the archived `source.bin`, verify the proposal’s exact locator against that material, and use the `content_hash` and `anchor_hash` printed by prepare. Review timestamps, reviewer identities and signatures are supplied by the reviewer; the program does not synthesize them. The trusted public-key descriptor must bind the key to the same NFKC-normalized `principal_id` and authorize the `source_review` purpose.

```json
{
  "schema_version": 2,
  "artifact_kind": "persona_v3_source_review_attestation",
  "reviewer_id": "REPLACE_WITH_REAL_HUMAN_REVIEWER_ID",
  "signer_key_id": "REPLACE_WITH_REGISTERED_REVIEWER_KEY_ID",
  "decision": "approve",
  "content_hash": "sha256:REPLACE_WITH_PREPARE_OUTPUT",
  "anchor_hash": "sha256:REPLACE_WITH_PREPARE_OUTPUT",
  "reviewed_at": "REPLACE_WITH_THE_REAL_COMPLETION_TIMESTAMP",
  "affirmations": {
    "reviewed_raw_archive_bytes": true,
    "verified_locator_against_raw_material": true,
    "reviewer_is_human": true,
    "review_was_independent": true
  },
  "notes": "REPLACE_WITH_REAL_REVIEW_NOTES",
  "signature": "ed25519:REPLACE_WITH_SIGNATURE_OVER_THE_CANONICAL_UNSIGNED_PAYLOAD"
}
```

`ALPHACOUNCIL_TRUSTED_SOURCE_REVIEW_KEYS` may supply the same public-key registry as JSON when `--trusted-reviewer-keys` is omitted. Private keys never enter this repository, the PersonaPack or logs. Bare reviewer IDs and the old unsigned v1 shape cannot approve a source.

Review outcome rules:

- zero reviews or one unique approval: ledger and queue remain pending;
- two valid approvals from different signing keys and different trusted principals: approved;
- repeated keys, two keys bound to one principal, or typographic variants of one normalized reviewer never increase the independent count;
- one or more rejects with no approval: rejected;
- approve/reject disagreement or one normalized identity submitting conflicting decisions: ledger `blocked`, queue `pending`;
- no state containing a reject can become approved.

## Offline reviewer signing

Copy the prepared entry's `unsigned_review_template` to a separate JSON file and have the
actual reviewer fill every field. The signer supplies none of these values: reviewer ID,
registered key ID, approve/reject decision, hashes, completion timestamp, affirmations, and
notes must already be present. Check the exact request and private key without producing a
signature:

```bash
npm run persona:source:review:sign -- \
  --request /absolute/path/to/completed-unsigned-review.json \
  --private-key /absolute/private/path/reviewer-ed25519.pem \
  --check
```

After inspecting the payload hash and public-key fingerprint, create one signed attestation:

```bash
npm run persona:source:review:sign -- \
  --request /absolute/path/to/completed-unsigned-review.json \
  --private-key /absolute/private/path/reviewer-ed25519.pem \
  --output /absolute/path/to/signed-review.json \
  --write
```

The private key must be a physical regular Ed25519 PEM file whose group/other permission
bits are clear (for example mode `0600`). Symlinks are rejected. Key bytes are read through
`O_NOFOLLOW`, converted to an in-memory key, cleared from the input buffer, and never printed
or written. The command never creates a key pair, identity, decision, approval, timestamp,
or production artifact. Output is exclusive: it cannot overwrite an existing file, reuse
the request/private-key path, or live inside the staging or production roots.

Every persisted attestation binds the previous attestation hash. An exact replay is idempotent and does not extend the chain.

## Atomicity and recovery

Queue and ledger updates run under a per-seat write lease. A live same-host PID is never pre-empted, even after the advertised lease expiry. Only a confirmed dead same-host owner can be recovered after the explicit grace period. Foreign-host, malformed, future-shaped, directory and symlink leases fail closed.

Before replacement, the operation fsyncs a transaction journal containing base and target hashes plus both target documents. Queue and ledger are each replaced atomically on the same filesystem. If the process stops between replacements, the next writer compares physical files with the journal’s base/target hashes and completes the transaction. Divergence from both hashes blocks recovery instead of guessing.

## Schemas and production isolation

- `schemas/source-anchor-proposal-v1.schema.json`
- `schemas/source-review-attestation-v2.schema.json` (production review input)
- `schemas/source-review-signing-request-v1.schema.json` (human-completed unsigned payload)
- `schemas/source-review-batch-v1.schema.json` (26-seat operational export and progress)
- `schemas/source-review-attestation-v1.schema.json` (deprecated unsigned migration shape; never approval evidence)
- `schemas/source-adjudication-ledger-v1.schema.json`
- existing queue records continue to follow `schemas/source-anchor-v1.schema.json`

Approval is still only a staging source-review result; it does not itself promote a pack.
Immutable release assembly requires the adjudication root plus separate trusted source-review
and formula-review public-key registries:

```bash
node scripts/assemble-persona-v3-release.mjs \
  --release-id 0.9.0-rc.1 \
  --source-root /absolute/path/to/26-production-packs \
  --adjudication-root /absolute/path/to/knowledge/staging/personas-v3 \
  --trusted-reviewer-keys /absolute/path/to/reviewer-public-keys.json \
  --trusted-formula-reviewer-keys /absolute/path/to/formula-reviewer-public-keys.json \
  --check
```

There is no environment-only or `reviewer_ids` shortcut at this boundary. The assembler
fails closed unless every source anchor eligible to define a method rule matches its seat's
`source-adjudication-ledger.json` by `source_id`, raw `content_hash`, and anchor subject hash,
and has valid approvals from two distinct trusted Ed25519 principals and signing keys. It
also requires the pack's reviewer IDs and review timestamp to match those signatures.

On `--write`, the assembler copies a self-contained `source-review-evidence.json` into the
immutable release. That bundle contains the 26 ledgers, the exact public-key registry used
for verification, and per-source verified binding records. `release-manifest.json` binds the
bundle, key registry, and ledger inventory by SHA-256. Release verification, promotion, and
active production-root resolution fail if that evidence file is missing or mutated. The
embedded public keys are an audit snapshot, not a runtime trust root: verification must also
receive the current external reviewer registry and every embedded signing key must still be
identically trusted, unrevoked, valid for its signing time, and authorized for
`source_review`.

Runtime activation requires three external public-key registries. They may be passed to the
release API/CLI as `trustedReleaseKeys`, `trustedReviewerKeys`, and
`trustedFormulaReviewerKeys`, or supplied to host runtime processes as JSON:

```bash
export ALPHACOUNCIL_TRUSTED_RELEASE_KEYS="$(< /absolute/path/to/release-public-keys.json)"
export ALPHACOUNCIL_TRUSTED_SOURCE_REVIEW_KEYS="$(< /absolute/path/to/reviewer-public-keys.json)"
export ALPHACOUNCIL_TRUSTED_FORMULA_REVIEW_KEYS="$(< /absolute/path/to/formula-reviewer-public-keys.json)"
export ALPHACOUNCIL_REQUIRE_PERSONA_RELEASE=1
```

`ALPHACOUNCIL_TRUSTED_RELEASE_KEYS` authorizes only keys whose descriptor purpose contains
`persona_release`; `ALPHACOUNCIL_TRUSTED_SOURCE_REVIEW_KEYS` authorizes only
`source_review`; and `ALPHACOUNCIL_TRUSTED_FORMULA_REVIEW_KEYS` authorizes only
`formula_review`. Missing, malformed, untrusted, revoked, expired, not-yet-valid, or
wrong-purpose keys fail closed. `--current`, `--cutover`, and `--rollback` accept
`--trusted-release-keys`; every verify/current/cutover/rollback path accepts both
`--trusted-reviewer-keys` and `--trusted-formula-reviewer-keys`. Private keys never belong
in any registry. GA evidence verification additionally requires the distinct external
experiment-adjudication and release-evidence registries documented in
`docs/evaluation/persona-v3-release-evidence.md`; neither substitutes for the three runtime
registries.

The legacy `knowledge/masters` migration fallback is used only for a never-activated
installation: `current.json` is absent, `ALPHACOUNCIL_REQUIRE_PERSONA_RELEASE` is not `1`,
and there is no non-empty pointer history, release-approval artifact, or fsynced monotonic
`cutover-ever.json` marker. Any such prior-activation evidence makes a missing
`current.json` fatal. Once activated, runtime requires a contiguous pointer history whose
latest record equals `current.json` and whose highest version/timestamps equal the marker;
malformed JSON, gaps, stale current, unsafe links, history mismatch, approval failure,
evidence failure, or physical pack/hash mutation is fatal. `ALPHACOUNCIL_KNOWLEDGE_DIR`
remains a migration-only override and cannot bypass strict or previously activated release
mode.

This does not turn staging drafts into production packs and does not replace the separate
corpus, deterministic-policy, experiment, admission, and signed release-approval gates.
