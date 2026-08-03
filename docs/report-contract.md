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

`artifact_index.md` lists `publication_manifest.json` only when report quality has passed and
the terminal publication step is expected to create that commit marker. An incomplete or
`needs_revision` package does not publish a dangling path to a marker that does not exist.

The report and handoff must call a named master result a recorded method-seat or lens result.
It is not a quote from, endorsement by, or current statement of the named person.

The run classifies its instrument before selecting financial-data routes. Operating-company
Company Facts and issuer financials are not applicable to ETFs, funds or indices. ETF/fund
runs use holdings look-through; index runs use aggregate-index evidence. Missing dated
holdings, constituents, weights, methodology, fees/rules, liquidity/tracking/flows or
aggregate-valuation coverage remain explicit gaps and are never replaced with invented fund
revenue, EPS, guidance, insider activity or summed constituent financial statements.

System-owned selector, report and handoff labels are localized for `zh-CN`, `en`, `ja` and
`ko`. Each worker receives the canonical run language, while stable IDs and JSON field names
remain English. Reader-facing evidence, method, debate and PM fields are checked against the
requested locale. Plugin-managed workers receive one bounded no-search language/JSON repair,
then fail closed; visible-host record tools reject the wrong-language packet before writing
it so the host may retry. `report_quality.json` records requested/observed locale, keeps
Han-only fragments explicitly inconclusive, and cannot pass a Japanese or Korean run whose
report body is English. Unsupported explicit selector locales are rejected instead of being
silently mislabeled as localized English.

## full_v2 Contract

Full remains the default. Its `final_report.md` visibly covers:

- conclusion and final rating
- analyst work log for every planned evidence role
- bull/bear debate record, including three rounds and exact round-3 Q&A
- recorded Master Bench when methods were selected
- fund/index structure and look-through when the instrument is an ETF, fund or index
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

Its `user_response.md` must also visibly carry:

- a system-owned price snapshot with price, currency, quote timestamp, exchange/feed and
  source when available, or an explicit statement that the quote is unavailable;
- every selected stable master ID, its frozen deterministic stance and its complete,
  untruncated recorded statement, or an explicit non-directional terminal failure record;
- all eight mandatory analyst task IDs, statuses and summaries, including failures or gaps;
- terminal status, contract, report quality, elapsed time, deadline state and artifact paths.
- a machine-marked final section with the exact selected-seat count. Every speaking seat keeps
  its complete recorded statement; every failed/unavailable seat instead carries
  `statement_status=not_produced` plus status/reason and never counts as a directional view.
  Full `all` therefore accounts for all 26 selected IDs; quick reports its actual 1–4.

`final_report.md` and `user_response.md` both end with that same complete system-owned
method-seat ledger. The tail end marker is the last non-whitespace content in each file. An
evidence-gate failure therefore still accounts for every selected seat as
`statement_status=not_produced`; it never converts a skipped seat into a directional view.

Visible PM completion returns `handoff_contract=inline_user_response_v1` plus the persisted
`user_response_markdown`. When a visible barrier cannot complete, the host must call
`finalize_visible_run`; it closes the run as `incomplete` and returns the same handoff contract.
The host uses that body for the final reply instead of reducing it to a compact ACK or manual
recap, and appends nothing after the method-seat tail. Idempotent replays return the same handoff.

Text-only MCP hosts receive that same persisted `user_response.md` body in `content[0].text`
when synchronous `analyze_symbol`, a terminal idempotent replay, or `read_run` observes a
terminal run. A nonterminal background acceptance remains a small polling acknowledgement.
`read_run` defaults to `detail=compact`: its structured payload contains only status, a bounded
decision, report quality, artifact paths, an event summary and the user response. Use
`detail=full` only when the caller explicitly needs the legacy evidence, event log,
`all_agents.md` or `final_report.md` bodies. The terminal text handoff is complete in either
detail mode and still ends at the method-seat tail marker.

All mandatory full evidence roles must be completed. If one still fails after the one bounded
parse-only repair, full fails closed at the evidence barrier: no master, bull/bear or PM model
call is started. The run is persisted as `incomplete` with the failed evidence and skipped
downstream roles named. A partial PM opinion never converts that run to complete.

## Full Runtime Budget

Plugin-managed headless `analyze_symbol(council_mode="full")` runs at one of three depth tiers
chosen with `council_pace`, measured from durable queueing through terminal artifact
persistence. A caller or environment may lower the selected tier's budget, never raise it.

| `council_pace` | total | evidence / seat | method / seat | debate / round | PM |
| --- | --- | --- | --- | --- | --- |
| `fast` | 15 min | 3.5 min | 1 min | 90 s | 2 min |
| `normal` (default) | 30 min | 6 min | 2 min | 150 s | 3 min |
| `slow` | 60 min | 12 min | 4 min | 6 min | 8 min |

The tier moves every per-stage cap together with the total, because the per-stage caps are what
bound each worker: a 60-minute total with 150-second debate rounds would finish in twenty
minutes with forty idle, and a 15-minute total with 6-minute evidence caps would starve the
debate into `incomplete`.

The tier also shapes what each worker is asked to produce. A cap on its own is a timeout, and a
timeout is not a plan: the identical prompt with a shorter fuse buys a packet the worker could
not finish rather than a faster good one. Because an LLM call's wall clock is dominated by the
tokens it generates, `fast` asks for the same information in less prose. What it never cuts is
claims, figures, scoped source IDs, the required report sections or the decision; what it cuts is
restatement — re-quoting evidence that could be cited by ID, recapping an opponent before
answering, methodology preambles. `slow` buys room to write a derivation out step by step.
`normal` adds no shaping at all, so its prompts remain byte-identical to the reviewed golden. Each tier's stages are proven to fit inside its own budget with
headroom for queueing, retries and the bounded parse repair. All three tiers are `full_v2`: a
tier changes how long each seat may think, never which seats run. Quick rejects the field.

The execution topology is:

1. the eight mandatory evidence workers start in one parallel wave;
2. after the evidence barrier, every selected physical v3 method runs its deterministic
   policy and freezes a stance, then receives one isolated voice worker that can explain but
   cannot change that stance;
3. Bull and Bear start together within each of three rounds, with a barrier before the next
   round; the PM starts only after both Round-3 outputs pass exact Q&A validation;
4. deterministic assembly and persistence consume the same global clock.

At deadline expiry the run stops opening downstream work and persists fail-closed as
`incomplete`, naming timed-out, failed and skipped roles. This is a terminal-persistence
guarantee, not a promise of full-seat success when search, model transport or data sources
are unavailable. The deadline does not apply to `plan_visible_run`: an external host owns
those subagents and the plugin cannot force-stop them.

Visible full runs use the same six role-by-round audit records and exact Q&A gate. Each
Bull/Bear call declares round 1, 2 or 3; the server rejects out-of-order calls, altered replay
content and a PM submitted before both Round-3 records pass. Identical role/round retries are
idempotent. Every non-blocked selected physical v3 seat also returns a visible post-evidence
explanation worker, including a deterministic `out_of_scope` seat. Its
`acknowledged_stance` must match the frozen stance, and PM checks the worker's completed
status rather than accepting the fallback record alone. This preserves workflow completeness
but does not give host-owned subagents the plugin-managed 30-minute deadline.

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
- `evidence_coverage`: `complete`, quick-only `degraded`, or `incomplete` when mandatory
  evidence is missing or failed.
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
signals and top invalidation conditions. It lists every selected method seat and all eight
mandatory analysts rather than sampling a subset, and includes the system-owned price
  snapshot or an explicit quote-data gap. The system-owned method-seat ledger is the final
  handoff section; recorded statements are not clipped and missing statements are explicit
  non-directional failure entries rather than summary/verdict fallbacks.

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
| "Thirty minutes expired, so finish full with the seats that returned." | Persist full as `incomplete`, name every missing/skipped role and keep the saved partial evidence; never synthesize a complete verdict. |
| "One evidence task failed, but the PM has an opinion." | Apply the mode-specific evidence gate; full fails before downstream calls, quick may only use its explicit degraded rules. |
| "The source table mentions the news, so the news section can be skipped." | News findings need their own visible section; quick recent news must also pass its date window. |
| "The final report exists, so chat can hide file locations." | The handoff lists the saved report, index, trace and quality file. |
| "The master said this." | Call it a recorded method-seat result, never a quote from the named person. |
| "The full report has a bench table, so the handoff can hide the individual seats." | Full handoff ends with every selected stable ID and its complete statement or explicit non-directional failure status. |
| "The PM tool returned success, so its small ACK is enough." | Deliver `user_response_markdown`; success metadata is not the user-facing report. |
| "A visible worker failed, so I will summarize the partial run myself." | Call `finalize_visible_run` and deliver its persisted handoff; never leave the run open or bypass the final ledger. |
| "QQQ has a ticker and SEC CIK, so run the company screen." | Classify first. ETF/fund/index company financial routes are not applicable; use look-through or aggregate evidence. |

## How the Quality Gate Checks Reports

`validateFinalReport` retains its report-only `schema_version: 2` result. Artifact publication
writes `report_quality.json` with `schema_version: 3`, the applicable `contract_id`, and a
`handoff_method_statement_coverage` result from `validateUserResponse`. A report section counts
only when:

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
Master Bench must contain the exact stable ID and a readable statement for every selected
seat; `report_quality.json.method_statement_coverage` records selected/readable/rendered
counts and IDs. A missing statement or ID forces `needs_revision`. Fund/index runs also
require the system-owned instrument-structure section. The authoritative lists are
`REPORT_SECTIONS` and `QUICK_REPORT_SECTIONS` in `mcp/lib/constants.mjs`.

The handoff gate independently requires one begin/end ledger marker, the end marker as the
last non-whitespace content, exactly one ordered seat marker for every selected stable ID, and
the full original `voice_statement` inside each speaking block. A non-speaking block passes
only with `statement_status=not_produced`; it remains incomplete at the execution gate.
