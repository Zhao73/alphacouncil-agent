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

1. Selection gate: for every full or quick council run, call `begin_council_selection`,
   display every returned master with number, identity, method and `best_for`, obtain this
   run's submission, and call `confirm_master_selection` with `display_ack: true`. Do not
   create a run, fetch evidence or spawn a worker until it returns a `selection_receipt`.
   Data-only `screen`, `options`, `news` and `market` calls are exempt.
2. Receipt gate: pass the one-use `selection_receipt` to `plan_visible_run`,
   `collect_evidence` or `analyze_symbol`. Never override it with `masters` or
   `masters_roster`; restart selection if it is missing, stale, expired or consumed.
3. Scope gate: infer ticker, language, horizon, and user goal, or ask only the minimum blocking question.
4. Evidence gate: all planned evidence roles are completed or explicitly marked unavailable with a data-gap reason.
5. Source gate: every material claim maps to scoped source IDs like `<task>:S1`; never cite bare `S1`.
6. Master gate: every master named in the confirmed receipt has either reported or produced
   a deterministic `out_of_scope` result. An unexecuted selected seat keeps the run incomplete.
7. Debate gate: bull, bear, and portfolio-manager work are recorded; do not replace them with one-pass synthesis.
8. Report gate: `final_report.md`, `user_response.md`, `artifact_index.md`, `report_quality.json`, and per-analyst Markdown files are written.
9. Quality gate: if `report_quality.json` is not `passed`, report `needs_revision`, not `complete`.
10. Handoff gate: chat may be concise, but must include rating, debate winner, key earnings/financial facts, forward setup, news/voice signals, valuation, risks/invalidation, and saved file locations.

## Anti-Rationalizations

| Shortcut | Required response |
| --- | --- |
| "The user wants a quick answer." | Use the quick analyst fan-out, but still display and confirm the master catalog before research. Keep the chat summary short; do not skip the saved report. |
| "The user already named Buffett/all." | Prefill it, display the complete catalog, and require this run's submission; prior wording is not a receipt. |
| "This host has no multi-select." | Print the numbered catalog and accept the common `1..N` / ranges / `all` text grammar. |
| "The same selection ran last time." | Start a new selection; receipts are one-run and choices are never silently reused. |
| "The section has no data." | Include the section and state the data gap. |
| "One analyst found enough." | Continue until every planned role is recorded or explicitly unavailable. |
| "The conclusion is obvious." | Run bull/bear debate anyway; obvious calls still need disconfirmation. |
| "Files are internal details." | Tell the user where the files are; artifacts are part of done. |

## Exit Criteria

A run is done only when the MCP status is `complete`, the report quality status is `passed`, and the user-facing handoff names the saved report directory. Otherwise continue the run or return the exact missing gates.

For code changes, run `npm run check` before claiming the plugin is ready.
