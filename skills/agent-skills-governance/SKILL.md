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

1. Scope gate: infer ticker, language, horizon, and user goal, or ask only the minimum blocking question.
2. Evidence gate: all planned evidence roles are completed or explicitly marked unavailable with a data-gap reason.
3. Source gate: every material claim maps to scoped source IDs like `<task>:S1`; never cite bare `S1`.
4. Debate gate: bull, bear, and portfolio-manager work are recorded; do not replace them with one-pass synthesis.
5. Report gate: `final_report.md`, `user_response.md`, `artifact_index.md`, `report_quality.json`, and per-analyst Markdown files are written.
6. Quality gate: if `report_quality.json` is not `passed`, report `needs_revision`, not `complete`.
7. Handoff gate: chat may be concise, but must include rating, debate winner, key earnings/financial facts, forward setup, news/voice signals, valuation, risks/invalidation, and saved file locations.

## Anti-Rationalizations

| Shortcut | Required response |
| --- | --- |
| "The user wants a quick answer." | Keep the chat summary short; do not skip the saved full report. |
| "The section has no data." | Include the section and state the data gap. |
| "One analyst found enough." | Continue until every planned role is recorded or explicitly unavailable. |
| "The conclusion is obvious." | Run bull/bear debate anyway; obvious calls still need disconfirmation. |
| "Files are internal details." | Tell the user where the files are; artifacts are part of done. |

## Exit Criteria

A run is done only when the MCP status is `complete`, the report quality status is `passed`, and the user-facing handoff names the saved report directory. Otherwise continue the run or return the exact missing gates.

For code changes, run `npm run check` before claiming the plugin is ready.
