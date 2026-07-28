# AlphaCouncil Report Contract

This contract prevents final handoffs from collapsing into a thin recap. The chat handoff
may stay concise, but saved artifacts must preserve the evidence chain and must identify the
contract that actually ran. `quick_v1` is not a shorter claim of `full_v2` completion.

## Shared Required Outputs

Every terminal `analyze_symbol` run, and every completed full visible portfolio-manager run,
writes the mode-appropriate versions of:

- `final_report.md` - the auditable report for this run's contract.
- `user_response.md` - concise user-facing handoff with status and important content.
- `artifact_index.md` - file map for every JSON and Markdown artifact.
- `<evidence_role>.md` - one readable Markdown file per planned evidence analyst.
- one Markdown/JSON artifact per recorded master method.
- `bull_researcher.md`, `bear_researcher.md`, `portfolio_manager.md` when those stages ran.
- `report_quality.json` - machine-readable report-structure result and contract metadata.
- `status.json`, `events.jsonl`, `evidence.json`, and `source_manifest.json`.
- `<task>.failure.json` for a worker failure, kept separate from investment evidence.

The report and handoff must call a named master result a recorded method-seat or lens result.
It is not a quote from, endorsement by, or current statement of the named person.

## full_v2 Contract

Full remains the default. Its `final_report.md` visibly covers:

- conclusion and final rating
- analyst work log for every planned evidence role
- bull/bear debate record, including three rounds and exact round-3 Q&A
- recorded Master Bench when methods were selected
- long thesis and short thesis
- market expectations and implied beat/miss thresholds
- analyst rating and target-price revisions
- earnings-call management signals
- quant factor / technical risk view
- news and company / industry voice signals
- short interest / borrow / options information when available
- strategic transaction or banking-event analysis when relevant
- valuation range
- price levels: conditional bands, not one unsupported target
- key catalysts and major risks
- position recommendation
- short-term 1-4 week, medium-term 3-6 month and long-term 12 month views
- data gaps / unavailable data
- invalidation conditions
- confidence
- source table

All mandatory full evidence roles must be completed. If one still fails after the one bounded
parse-only repair, full fails closed at the evidence barrier: no master, bull/bear or PM model
call is started. The run is persisted as `incomplete` with the failed evidence and skipped
downstream roles named. A partial PM opinion never converts that run to complete.

## quick_v1 Contract

Quick is explicit and plugin-managed through headless `analyze_symbol`. It is not available
through `plan_visible_run`, is never selected implicitly, and always records:

- `scope: quick`
- `contract_id: quick_v1`
- `full_council_equivalent: false`
- `debate_rounds_expected: 1`
- `adversarial_verification: not_run`
- required tasks `market_data`, `earnings_deep_dive`, `valuation_long_short`, and
  `news_industry_management`

Every quick `final_report.md` receives exactly one system-owned, idempotent quick-scope
marker stating `full_council_equivalent=false`; PM prose cannot remove or override it.

The four tasks start in parallel. Recent-news output is limited to dated company and industry
developments published in the 120 days ending at `as_of`; future, undated and older sources
are not presented as recent.

Stage 0 still displays all 26 methods, but quick records only 1-4 selected methods and does
not accept `all`. It then runs one parallel bull/bear statement round and one short PM. It
does not run rebuttal/Q&A rounds or adversarial verifier agents. Source IDs must still resolve
inside the saved packets.

### quick_v1 required sections

The smaller report contract requires these 13 visible sections:

1. conclusion and rating
2. analyst work log naming all four fixed roles and their statuses
3. one-round bull/bear debate record
4. system-owned Master Bench with every selected stable ID and stance
5. earnings-call management signals
6. recent company and industry news
7. valuation range
8. price levels / conditions
9. major risks
10. position recommendation
11. data gaps / unavailable data
12. confidence
13. source table

Forward-expectations revisions, quant, short-interest/options, banking-event detail,
catalysts, three horizon sections, invalidation and three-round Q&A remain full-only required
sections. Their absence does not make a valid quick report fail, and a quick report passing
its smaller contract does not satisfy `full_v2`.

## Quick Runtime Budget

Quick has a non-overridable end-to-end ceiling of 600000 ms, measured from durable queueing
through artifact persistence. A caller or environment may lower it, never raise it. The
server budgets:

| Work | Maximum |
|---|---:|
| deterministic grounding wait | 20 seconds |
| each of four parallel evidence workers | 210 seconds |
| each of up to four parallel master workers | 90 seconds |
| bull and bear, one parallel statement each | 90 seconds per side |
| short portfolio manager | 90 seconds |
| final report assembly and persistence reserve | 20 seconds |

Retry time is inside the same ceiling. The clock is a fail-closed upper bound, not a promise
that unavailable evidence will be replaced from memory.

## Execution Status, Coverage and Report Quality Are Separate

Do not collapse these axes:

- `status`: terminal orchestration result.
- `completeness`: whether the applicable structural gates were satisfied.
- `evidence_coverage`: `complete` or quick-only `degraded`.
- `verification`: scoped source-ID presence; adversarial verification is reported separately.
- `report_quality`: whether `quick_v1` or `full_v2` report structure passed.

Terminal analysis statuses are:

```text
complete | degraded | incomplete | needs_verification | needs_revision | failed
```

`degraded` is a quick-only terminal result. It is permitted only when at least two of the
four evidence roles completed, every failed role has a sanitized packet/diagnostic, at least
one bull/bear side completed, the PM completed, and every selected method was recorded. Both
debate sides failing, PM failure, fewer than two successful evidence roles, or a missing
master makes the run `incomplete`.

A degraded report contains exactly one system-owned, idempotent degraded execution ledger
naming each affected task/side and its cause. `report_quality.json` repeats the degraded
evidence/debate arrays. A structurally valid report can therefore have
`report_quality=passed` while the run remains `degraded`; never present that as complete.
`needs_verification` or `needs_revision` may be the top-level terminal status while degraded
coverage remains visible in the independent ledger/status fields.

## Concise Chat Handoff

Every handoff includes status, report contract, report quality, rating, winner, confidence,
one judgment paragraph, valuation/position, material gaps and file locations.

A full handoff additionally carries the key earnings result, forward setup, news/voice
signals and top invalidation conditions.

A quick handoff instead names:

- every selected stable master ID, stance and short recorded result, marked as not a quote;
- all four analyst statuses and summaries;
- dated recent company/industry news;
- every degraded or failed task/side and its cause;
- the explicit sentence that `quick_v1` has no three-round cross-exam or adversarial
  verification and is not equivalent to full council.

Both handoffs list `final_report.md`, `artifact_index.md`, `all_agents.md`, and
`report_quality.json`.

## Anti-Rationalizations

| Bad shortcut | Required behavior |
| --- | --- |
| "The user only asked if they can enter, so four bullets are enough." | Keep chat concise, but write the mode-appropriate report and artifact index. |
| "Quick passed report quality, so it passed full." | `quick_v1` can only pass `quick_v1`; retain `full_council_equivalent=false`. |
| "Ten minutes expired, so silently omit a seat." | Record the exact degraded/incomplete ledger; never manufacture evidence or extend the ceiling. |
| "One evidence task failed, but the PM has an opinion." | Apply the mode-specific evidence gate; full fails before downstream calls, quick may only use its explicit degraded rules. |
| "The source table mentions the news, so the news section can be skipped." | News findings need their own visible section; quick recent news must also pass its date window. |
| "The final report exists, so chat can hide file locations." | The handoff lists the saved report, index, trace and quality file. |
| "The master said this." | Call it a recorded method-seat result, never a quote from the named person. |

## How the Quality Gate Checks Reports

`validateFinalReport` writes `report_quality.json` with `schema_version: 2` and the applicable
`contract_id`. A section counts only when:

- it is a real Markdown ATX heading (`##` or `###`), not bold text or a heading inside a code
  fence;
- its normalized title matches the section aliases, with the longest alias winning;
- the body before the next same/higher heading is not a placeholder and meets the section's
  minimum non-space length.

Every planned task ID must appear inside the Analyst Work Log body, not only in the source
table. When sources exist, scoped IDs such as `market_data:S1` must appear. Full reports need
at least 1600 non-space characters, quick reports 700, and dry reports 600.

The system-owned recorded Master Bench and degraded ledger are checked independently of PM
prose so a generic, stale or duplicate heading cannot satisfy the contract. The authoritative
lists are `REPORT_SECTIONS` and `QUICK_REPORT_SECTIONS` in `mcp/lib/constants.mjs`.
