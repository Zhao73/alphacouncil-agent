# PersonaPack v3 editorial draft slices

The draft factory gives every canonical master seat a physical, inspectable vertical slice before any seat is eligible for production. It is an implementation aid, not a maturity shortcut.

Run the read-only gate:

```bash
node scripts/generate-persona-v3-drafts.mjs --check
```

Create or deterministically refresh all 26 slices only with the explicit write flag:

```bash
node scripts/generate-persona-v3-drafts.mjs --write
```

Each seat receives nine files under `knowledge/staging/personas-v3/<persona_id>/artifacts/`: method hypotheses, research policy, decision policy, computation prototypes, case and experiment plan, memory policy, English and Chinese voice drafts, and a draft index. The factory also updates the existing staging scaffold component plan.

The artifacts deliberately remain `editorial_prototype` and `pending_human_adjudication`. They contain no source IDs, grades, reviewers, case outcomes, experiment results, maturity, admission claim, or `manifest.json`. Raw source acquisitions remain `retrieved_unadjudicated`; their presence changes only the honest staging note and never establishes method evidence.

The production v3 loader ignores the staging root. Promotion into `knowledge/masters/` remains a separate reviewed release operation and still has to satisfy the corpus, deterministic policy, experiment, host-parity, and admission gates.
