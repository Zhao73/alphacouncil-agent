# PersonaPack v3 production-candidate validation

Production candidates live only in the isolated
`knowledge/staging/persona-v3-production-candidates/` tree. The validator reads that tree,
loads and compiles each physical schema-v3 pack, recomputes its admission, and reports
the exact set of 52 planned seat-specific tools and their cryptographic formula approvals.

```bash
# Read-only status report. This succeeds even while candidates are missing.
npm run persona:candidates:check

# Fail unless all 26 physical candidates clear the requested admission and cover all 52 tools.
npm run persona:candidates:gate
node scripts/check-persona-v3-production-candidates.mjs --gate \
  --require-admission candidate \
  --trusted-formula-reviewer-keys /offline/path/formula-review-public-keys.json
```

Both commands are inspection-only. They never create a candidate, copy a draft, generate a
manifest, approve a source, sign an experiment or host result, assemble a release, update the
production registry, promote a pack, or change the package version. A clear candidate gate is
therefore only an input to the separate release-evidence, approval, assembly, and promotion
workflow; it is not production status.

The gate requires exactly two planned tool IDs per canonical seat and exactly 52 globally.
Duplicates and extras fail, even when all planned IDs are also present. Every tool must carry
hash-bound `formula_spec_hash`, `approval_bundle_hash`, and review-subject reference, and the
matching physical `formula-approvals/*.approval-bundle.json` must verify
against two distinct trusted `formula_review` principals. Missing, unsigned, revoked,
wrong-purpose, tampered or replayed evidence cannot enter a production candidate.

`npm run check` uses the non-blocking `--check` mode so an honest empty tree remains valid
development state. Use `--gate` explicitly when the physical candidate corpus is expected to
be complete. At present the repository has 0/26 physical candidates and the gate correctly
fails closed.
