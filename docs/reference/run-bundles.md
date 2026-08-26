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

The manifest records relative payload paths, byte lengths and SHA-256 digests, the five-item evidence-standard version, and the exporter/verifier runtime build identity. The payload includes the persisted status, evidence, source manifest, company dossier, event ledger, selected analyst/method JSON, published artifacts, a portable publication projection and generated council diagnostics.

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

## Interpreting the 26 seats

The repository ships 26 named public-method operator lenses. They are AI-generated method-seat outputs, not 26 human experts, not 26 independently trained models, and not a promise of profit. A count of files or seats is never sufficient evidence that the outputs are independent or decision-useful; use a version-bound bundle plus repeated-case evaluation before publishing such a claim.
