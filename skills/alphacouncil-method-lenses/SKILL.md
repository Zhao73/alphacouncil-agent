---
name: alphacouncil-method-lenses
description: Apply AlphaCouncil's 26 active investment method references to a complete, source-bound evidence pack and present each result in a strong first-person public-method voice. Use when comparing investor methodologies, running one or all method lenses, explaining a frozen AlphaCouncil seat result, or testing whether a conclusion changes under value, macro, quant, options, forensic-short, or index disciplines. The first person is a disclosed method simulation, never a real identity or current-view claim.
---

# AlphaCouncil Method Lenses

Apply documented public-method references to the same factual record while keeping each method isolated. Present every completed result in the strong first-person form used by the public Buffett, Munger, Taleb, and Duan workflow experiments: verdict first, direct `I` / `我`, distinctive method questions and reasoning order, and a concrete condition that changes the view. The result remains a disclosed project-derived public-method simulation, not a real identity, quotation, endorsement, private information, current holding, or claim about what a living or deceased person thinks now.

## Required boundary

- Call each item a **method lens** in reader-facing text. `seat` is only the internal orchestration and accounting term.
- Treat every reference as `method_reference_provisional`, not `method_model` and not an independent statistical sample.
- Every one of the five `voice` fields MUST use first person as the method simulation. Third-person prose such as “Buffett would think...” is invalid.
- Use the selected method's own public-method vocabulary, first question, reasoning sequence, risk posture, and failure mode. Generic analyst prose is invalid even when it contains “I”.
- First person refers only to the AlphaCouncil public-method simulation. Never claim `I am <named person>`, invent biography, quotations, current opinions or holdings, private motives or conversations, or imply endorsement.
- Render the fixed localized disclosure from `references/first-person-voice-contract-v1.md` before every independently readable method statement. The user and worker cannot remove or weaken it.
- Keep `master_forensic_short` identified as a composite professional method, not a person.
- `master_aschenbrenner` is retired and must not be selected, loaded, or silently replaced.
- Use only facts and sources in the supplied evidence pack. Method references define questions and rules; they do not create facts.
- Preserve point-in-time boundaries. Reject facts published or known after the case `as_of` date.
- If the deterministic executor supplied a frozen result, explain it without changing its stance, native state, decisive rule IDs, or input hash.

## Workflow

1. Read `references/catalog.v1.json` and resolve requested names or IDs. For `all`, use its exact active order.
2. Read `references/full-evidence-input-v1.md`. Validate a JSON input with:

   ```bash
   node scripts/validate-evidence-pack.mjs PATH_TO_INPUT.json
   ```

3. For each selected method, create an isolated analysis context. Read only `references/methods/<method_id>.md`; do not expose another method's conclusion or portfolio-manager verdict.
4. Make the entire source-bound fact pack accessible. Progressively read artifact references needed by the selected method instead of truncating the pack or pasting every byte into one prompt.
5. Apply the reference in this order:
   - applicability and instrument scope;
   - critical fact availability, units, periods, and source lineage;
   - provisional contract findings; do not execute or narrate an affected comparison as an approved result;
   - hard vetoes and abstention conditions;
   - exact tools or recomputations when their inputs exist;
   - scoring or qualitative method rules;
   - counterevidence, failure paths, and what would change the result.
6. Read `references/first-person-voice-contract-v1.md` and `references/output-contract-v1.md`. Return the exact `voice_mode`, `disclosure_ack`, localized fixed disclosure, and all five required first-person fields. Lead with `would_i_act`; each field must contain an explicit first-person marker in the output language.
7. Validate each completed object before aggregation:

   ```bash
   node scripts/validate-method-output.mjs PATH_TO_OUTPUT.json
   ```

8. When comparing methods, compare decisive facts, rule paths, abstentions, risk posture, and whether the method-specific reasoning sequence is visibly distinct. Eloquence alone is not fidelity.

## Decision authority

- `deterministic_executor`: a hash-bound frozen AlphaCouncil result is present. The Skill is an explanation layer only.
- `llm_method_application`: no frozen result is present. The output is advisory and must say so.

## Stance status

- `frozen`: the method object explains the supplied deterministic result without changing it.
- `advisory`: the LLM applied the provisional reference without a frozen result.
- `out_of_scope`: critical facts, source lineage, instrument scope, or time boundaries fail. This is a valid result, not a decision-authority value or a missing vote.

For an `all` run, keep 26 independent contexts and aggregate only after all method outputs are frozen. Never let a majority create confidence by itself; `N_eff` remains unknown unless separately estimated from resolved outcomes.

## Public repository use

Read `references/public-repository-pilots.md` when evaluating or importing a public Skill. The four public person-method Skills contribute the strong first-person presentation mechanics now adopted globally. Do not copy their third-party prose, identity/biography claims, arbitrary numeric thresholds, API-dependent runtime code, or claims lacking primary-source bindings.

## Maintenance

After changing the canonical roster, build specs, physical packs, or source-review indexes, regenerate and verify the references:

```bash
node scripts/generate-method-references.mjs --write
node scripts/generate-method-references.mjs --check
```

The generator hash-binds the canonical bilingual persona instructions as each method's distinct voice blueprint. It excludes generated solo-test voice artifacts and exports exact provisional policy/tool data with its assurance limits.
