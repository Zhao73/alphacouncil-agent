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
- strategic transaction or banking-event analysis when relevant
- valuation range
- price levels: a table of price bands with the condition that triggers each, not a single target price
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

## How the gate checks this

`report_quality.json` (schema_version 2) is produced by `validateFinalReport`. A section
counts only when all of the following hold:

- it is a real Markdown ATX heading (`##` or `###`), not bold text and not a `#` inside a
  code fence;
- its normalized title matches one of the section's aliases -- the longest matching alias
  wins, so `Quant Factor / Technical Risk View` is the quant section and does not also
  satisfy the risks section;
- the body between that heading and the next heading of the same or higher level is not a
  placeholder (`- None`, `N/A`, `TBD`, `待补充`) and carries at least the section's
  `min_body` non-space characters.

Every planned analyst task id must appear **inside the Analyst Work Log section body**.
Mentioning it only in the source table does not count.

`report_quality.json` lists each section with `status` (`ok` / `missing` / `placeholder` /
`too_thin`), the heading it matched, its line, and its body size, so a `needs_revision`
result says which section failed and why.

### Sections the gate checks that were previously undocumented

- **Earnings-call management signals** — what management committed to, and whether the last
  commitment was met. The Q&A matters more than the prepared remarks.
- **Short-term view (1–4 weeks)**, **medium-term view (3–6 months)** and **long-term view
  (12 months)** — three separate sections, because a name can be a poor trade and a good
  hold at the same time and collapsing them hides that.
- **Price levels** — three bands with the condition attached to each. "The cycle position is
  undetermined" does not excuse omitting them; it changes what the bands are conditional on.

The authoritative list is `REPORT_SECTIONS` in `mcp/lib/constants.mjs`. The gate parses
heading structure, not substrings: a section needs a real level-2 or level-3 heading, a
title matching one of its aliases, and body text above a per-section minimum that is not a
placeholder such as `N/A`, `TBD` or `待补充`.
