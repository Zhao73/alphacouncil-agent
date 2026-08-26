# Run bundles and claim readiness

`run-bundle-v1` turns one saved council run into a bounded, read-only review package. It separates two questions that must not be collapsed:

- `structure: PASS|FAIL` means the payload inventory, bytes, JSON/JSONL, event chain, timestamps, IDs and attached diagnostics can or cannot be reproduced.
- `claim_readiness: READY|BLOCKED` means the run does or does not satisfy the stricter release/content gates needed before a public performance or “26 method seats” claim.

A structure pass is not a release pass. The verifier never prints a bare, unqualified `PASS`.

## Export and verify

```sh
npm run run:bundle:export -- \
  --run-dir "$HOME/.alphacouncil-agent/runs/RUN_ID" \
  --output ./RUN_ID.run-bundle

npm run run:bundle:verify -- --bundle ./RUN_ID.run-bundle
npm run run:bundle:verify -- --bundle ./RUN_ID.run-bundle --require-claim-ready
```

The export target must not exist. Export uses a private sibling staging directory and renames it only after every payload file and digest is complete. It rejects source or payload symlinks, absolute/traversal bundle paths, files over 32 MiB, bundles over 128 MiB and any attempt to overwrite an existing output.

Default verification exits nonzero only when structure fails. `--require-claim-ready` exits `2` for a structurally valid bundle whose release/content evidence is blocked.

## What is bound

The manifest records relative payload paths, byte lengths and SHA-256 digests, the five-item evidence-standard version, and the exporter/verifier runtime build identity. The payload includes the persisted status, evidence, source manifest, company dossier, event ledger, selected analyst/method JSON, published artifacts, a portable publication projection, generated council diagnostics and a timing ledger derived from the persisted run bytes.

These hashes detect modification inside the bundle. They are not a signature and do not prove author identity, source authenticity, investment accuracy or future profitability.

The original publication manifest is preserved for audit and can contain source-machine absolute paths. The portable projection replaces those with bundle-relative paths. Treat the raw bundle as controlled review material until a separately reviewed public-redaction workflow exists.

## Claim-readiness gates

The strict layer currently checks:

1. a clean v1.5.0 runtime bound to the exact `v1.5.0` tag tree, with the run started after that release commit;
2. a complete hash-linked, time-monotonic event ledger and a positive running/completed interval for every selected method seat;
3. a separately persisted, completed method voice for every selected seat, including the exact frozen stance acknowledgement, five voice fields, source IDs, company-dossier hash and every selected analyst-packet acknowledgement;
4. normalized trigram similarity below `0.5` for every seat pair, nondegenerate text lengths, non-unanimous stance without repeated-case support, and a method-specific reason for every `out_of_scope` result;
5. a hash-bound `council_diagnostics.json`; a missing seat may appear only as `not_produced`, never as synthetic content.

The tool also reports `derived_marker_hits` using a fixed TF-IDF-like rule over pack-declared text. It is advisory only. It is not a reviewed method vocabulary and is not evidence that a seat is genuine.

Until P1c preregisters reviewed per-seat vocabulary markers and thresholds, claim readiness intentionally remains `BLOCKED` with `reviewed_vocabulary_contract_pending`. This is an explicit evidence boundary, not a failed export.

## Timing payload compatibility

For a current headless run, the exporter derives `payload/timing-ledger.json` from `status.json`, `evidence.json` and `events.jsonl`. The verifier derives it again and requires a byte-for-byte match; changing the ledger and refreshing only the ordinary manifest digest therefore fails structure. A byte-matching ledger whose worker pairs, topology or declared terminal evidence are structurally invalid also fails bundle structure.

A consistently inventoried legacy bundle without worker-attempt events may omit the timing ledger and remain structurally valid. If worker-attempt events are present but the ledger is removed, structure can still pass when the inventory is internally consistent, but claim readiness is explicitly `BLOCKED` with `timing_ledger_missing_for_observed_run`. This compatibility rule never upgrades old stage markers into process-boundary observations. `visible_host_threads` runs also remain `not_evaluable` because the external host owns worker scheduling.

The ledger schema is published as `schemas/timing-ledger-v1.schema.json`. Its `marketing_eligible` field is fixed to `false`. See [Timing evidence and offline replay](timing-evidence.md) before interpreting any duration or projection.

## Interpreting the 26 seats

The repository ships 26 named public-method operator lenses. They are AI-generated method-seat outputs, not 26 human experts, not 26 independently trained models, and not a promise of profit. A count of files or seats is never sufficient evidence that the outputs are independent or decision-useful; use a version-bound bundle plus repeated-case evaluation before publishing such a claim.
