# Full evidence input v1

`all data` means every factual artifact is available by a hash-bound reference. It does not mean all bytes must be pasted into one prompt, and it never includes another method's conclusion.

## Required top-level fields

```json
{
  "schema_version": 1,
  "case": {
    "case_id": "stable-id",
    "instrument_id": "ticker-or-index-id",
    "instrument_type": "company|etf|index|option|portfolio|other",
    "currency": "USD",
    "question": "decision question",
    "as_of": "ISO-8601 timestamp",
    "knowledge_as_of": "ISO-8601 timestamp",
    "horizons": ["near", "base", "long"]
  },
  "selected_method_ids": ["master_buffett"],
  "typed_fact_pack": {
    "schema_version": 1,
    "as_of": "ISO-8601 timestamp",
    "knowledge_as_of": "ISO-8601 timestamp",
    "fact_pack_hash": "sha256:...",
    "facts": []
  },
  "evidence_packets": [],
  "source_manifest": [],
  "claim_ledger": [],
  "coverage_ledger": {},
  "artifact_refs": [],
  "bindings": {},
  "frozen_method_result": null
}
```

Each fact needs a stable fact ID, typed value, unit, period or `as_of`, source IDs, and lineage. Each source needs a stable ID, URL or immutable artifact ID, publication/public/retrieval times, locator, and content hash. Each artifact reference needs an ID, path or retrievable handle, SHA-256 hash, media type, and byte length.

`bindings` records the hashes of the case input, fact pack, source manifest, method reference, decision policy, tool graph, and frozen result when present.

## Completeness rules

- Include completed, failed, timed-out, and omitted evidence roles in `coverage_ledger`.
- Preserve conflicting evidence and refutations; do not pre-resolve them for the method.
- Include raw artifact references for information omitted by compact packets.
- Exclude other method outputs, debate conclusions, portfolio-manager conclusions, future outcomes, model memory, and post-`as_of` sources.
- A source ID must resolve to exactly one source-manifest entry.
- A derived fact must name its input fact IDs, operation, and derivation hash.
- Missing critical facts remain explicitly missing; never fill them with estimates unless the input marks an estimate and supplies its derivation.

If any identity, hash, timestamp, unit, or lineage control fails, return `out_of_scope` before analysis.
