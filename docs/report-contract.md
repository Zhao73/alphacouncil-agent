# AlphaCouncil Report Contract

This contract prevents final handoffs from collapsing into a thin recap. The chat
handoff may stay concise, but the saved report and artifacts must preserve the
investment evidence chain.

## Required Outputs

Every completed `analyze_symbol` or `record_visible_decision` portfolio-manager
run writes:

- `final_report.md` - complete investment committee report.
- `user_response.md` - concise user-facing handoff with the important content.
- `artifact_index.md` - file map for every JSON and Markdown artifact.
- `<evidence_role>.md` - one readable Markdown file per evidence analyst.
- `bull_researcher.md`, `bear_researcher.md`, `portfolio_manager.md`.
- `report_quality.json` - machine-readable pass/fail report-quality check.

## Final Report Sections

`final_report.md` must visibly cover:

- conclusion and final rating
- analyst work log for every planned evidence role
- bull/bear debate record
- long thesis and short thesis
- market expectations and implied beat/miss thresholds
- analyst rating and target-price revisions
- earnings-call management signals
- quant factor / technical risk view
- news and company / industry voice signals
- short interest / borrow / options information when available
- strategic transaction, banking-event, NVIDIA, or similar terms when relevant
- valuation range
- key catalysts
- major risks
- position recommendation
- short-term 1-4 week view
- medium-term 3-6 month view
- long-term 12 month view
- data gaps / unavailable data
- invalidation conditions
- confidence
- source table

## Concise Chat Handoff

`user_response.md` should not paste the whole report. It should include:

- rating, debate winner, confidence, and one judgment paragraph
- latest earnings / financial result highlights
- forward expectations and event thresholds
- important news and industry / management signals
- valuation or price range
- position recommendation
- top invalidation conditions
- file locations for the full report and analyst files

## Anti-Rationalizations

| Bad shortcut | Required behavior |
| --- | --- |
| "The user only asked if they can enter, so four bullets are enough." | Give a concise handoff, but write the full report and artifact index. |
| "The source table mentions the news, so the news section can be skipped." | News and voice findings need their own visible section. |
| "The final report exists, so chat can hide file locations." | The handoff must list `final_report.md`, `artifact_index.md`, and `all_agents.md`. |
| "A failed or incomplete council still has a PM opinion." | Mark it incomplete or needs revision; do not call it complete. |

## Quality Gate

A run should not be marked `complete` if the report is missing required sections,
planned analyst work-log entries, scoped source IDs when sources exist, or enough
body content to make the decision auditable. In that case write
`report_quality.json` and set status to `needs_revision`.
