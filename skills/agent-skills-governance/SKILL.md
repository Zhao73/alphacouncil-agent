---
name: agent-skills-governance
description: Enforces agent-skills-style anti-laziness gates for AlphaCouncil. Use automatically with alphacouncil-agent before planning, running, synthesizing, or reporting an equity-research council.
---

# Agent-Skills Governance

This skill is bundled with AlphaCouncil so every installer gets the same guardrails. It follows the `addyosmani/agent-skills` pattern: a skill is an executable workflow with gates, anti-rationalizations, and exit criteria, not a vague style guide.

Source inspiration: https://github.com/addyosmani/agent-skills

## Mandatory Use

Use this skill whenever `alphacouncil-agent` is invoked or when editing the plugin's research/reporting behavior. Do not require the user to install `addyosmani/agent-skills` separately.

## Stop Gates

Before giving a final investment answer, all gates below must be satisfied:

1. Selection gate: for every full or quick council run, call `begin_council_selection` with
   the intended `council_mode`, display all 26 returned methods with number, identity,
   method and `best_for`, obtain this run's submission, and call
   `confirm_master_selection` with `display_ack: true`. Full accepts 1..N/ranges/IDs/`all`;
   quick accepts only 1-4 methods and forbids `all`. Do not create a run, fetch evidence or
   spawn a worker until it returns a `selection_receipt`. Data-only `screen`, `options`,
   `news` and `market` calls are exempt.
2. Receipt gate: pass the one-use `selection_receipt` with the same symbol, prompt,
   language and `council_mode` used at selection. The receipt is mode-bound: never use a
   full receipt for quick or a quick receipt for full, and never override it with `masters`
   or `masters_roster`. Restart selection if it is missing, stale, expired, consumed or
   mode-mismatched.
3. Scope gate: infer ticker, language, horizon, and user goal, or ask only the minimum blocking question.
4. Evidence gate: full requires every planned evidence role to complete; after the bounded
   parse repair, any mandatory failure stops the run before masters/debate/PM and produces
   `incomplete`. Quick fixes four roles (`market_data`, `earnings_deep_dive`,
   `valuation_long_short`, `news_industry_management`) and may terminate `degraded` only
   when at least two completed and every failed role has a recorded diagnostic/data gap.
5. Source gate: every material claim maps to scoped source IDs like `<task>:S1`; never cite bare `S1`.
6. Master gate: every master named in the confirmed receipt has either reported or produced
   a deterministic `out_of_scope` result, every result has a readable final statement, and
   every stable ID appears in the published Master Bench. An unexecuted or hidden selected
   seat keeps the run incomplete or `needs_revision`.
7. Debate gate: full requires all three bull/bear rounds, exact round-3 Q&A and PM. Quick
   requires one parallel statement round and PM; one degraded side is allowed only if the
   other side and PM completed, while two degraded sides or PM failure is incomplete.
8. Verification gate: quick still enforces scoped source-ID presence but never claims the
   adversarial verifier fan-out ran. Full/deep verification claims must match the recorded
   runtime scope.
9. Report gate: `final_report.md`, `user_response.md`, `artifact_index.md`,
   `report_quality.json`, and per-analyst/method/debate Markdown files are written against
   `full_v2` or `quick_v1`, never a hybrid.
10. Quality gate: if the applicable `report_quality.json` is not `passed`, report
    `needs_revision`, not complete. A quick `passed` result never satisfies `full_v2`.
11. Handoff gate: chat may be concise, but it must state run status, contract, rating,
    winner, confidence, valuation/position, material gaps and saved file locations. Full
    also carries forward setup and invalidations. Quick names all four analyst statuses,
    selected method IDs/stances, dated recent company/industry news, every degraded item,
    and that it is not equivalent to full council. Full handoff ends with the exact selected
    seat count and every per-seat method statement; use returned `user_response_markdown`
    rather than an ACK-only recap.
12. Deadline gate: plugin-managed quick uses headless `analyze_symbol`; `plan_visible_run`
    quick is rejected. Never extend its end-to-end deadline above 600000 ms or silently
    omit work to appear complete.

## Anti-Rationalizations

| Shortcut | Required response |
| --- | --- |
| "The user wants a quick answer." | Use quick only when explicitly requested. Run the plugin-managed headless `quick_v1`, still display all 26 methods, confirm 1-4, and save the quick report. |
| "The user already named Buffett/all." | Prefill named methods, display the complete catalog, and require this run's submission. In quick, reduce the choice to at most four; `all` is invalid. |
| "This host has no multi-select." | Print the numbered catalog and accept indices, ranges, or stable IDs. Accept `all` only for full; quick still requires 1-4. |
| "The same selection ran last time." | Start a new selection; receipts are one-run and choices are never silently reused. |
| "The section has no data." | Include the section and state the data gap. |
| "One analyst found enough." | Full requires all mandatory evidence. Quick needs at least two successful roles plus an explicit degraded ledger; one seat never satisfies either contract. |
| "The conclusion is obvious." | Run the applicable debate: three rounds for full, one parallel statement round for quick. |
| "Files are internal details." | Tell the user where the files are; artifacts are part of done. |
| "Quick report quality passed, so full passed." | Keep `full_council_equivalent=false`; only `quick_v1` passed. |
| "The ten-minute clock expired, so skip a seat quietly." | Return the exact degraded/incomplete ledger; never extend the ceiling or invent evidence. |
| "The master said this." | Call it a recorded method-seat result, never a quote from the named person. |
| "The PM ACK says complete, so I can summarize it." | Deliver the returned `user_response_markdown`; the final per-seat section is part of the contract. |
| "QQQ has an SEC CIK, so the company screen applies." | Classify first. ETF/fund/index company financial routes are not applicable; require look-through or aggregate evidence. |

## Exit Criteria

A run is deliverable only after it reaches a documented terminal status:
`complete`, `degraded`, `incomplete`, `needs_verification`, `needs_revision`, or `failed`.
`complete` also requires the applicable report quality to pass. `degraded` is a quick-only
terminal result and must retain its system-owned degraded ledger, pass `quick_v1` report
quality, and be presented as degraded rather than complete. Every other non-complete terminal
status is returned with its exact missing/failed gates and saved directory; do not keep
polling a terminal run or create a replacement run silently.

For code changes, run `npm run check` before claiming the plugin is ready.
