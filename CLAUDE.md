# Claude Instructions For This Repository

You are working on `alphacouncil-agent`, a Codex plugin for public-equity research.

## Purpose

The plugin turns `@alphacouncil-agent <ticker/request>` into one of two explicit equity-research council contracts:

- `full_v2` is the default: display and confirm the method catalog, run all eight mandatory
  evidence roles, run every selected method, complete the three-round Bull/Bear cross-exam,
  run the PM, and write the complete report. Plugin-managed headless full starts all eight
  evidence workers in one parallel wave, gives every selected v3 method one isolated voice
  worker after its deterministic stance is frozen, and runs Bull/Bear in parallel within
  each round with barriers between rounds. If mandatory evidence still fails after its one
  bounded parse-only repair, persist the failure package, skip method/debate/PM model calls,
  and terminate `incomplete` before downstream synthesis.
- `quick_v1` runs only when explicitly requested and only through plugin-managed headless
  `analyze_symbol`: display every method returned by the selector, confirm 1-4, run four fixed evidence roles and the
  selected methods in parallel waves, one parallel Bull/Bear statement round, then a short
  PM inside a hard ten-minute ceiling.

Never infer quick from impatience, a short prompt, a deadline, or a full-mode failure. Do not
downgrade to lite, smoke-test, or debug output unless the user explicitly asks for that
non-investment test output.

## Current Build Profile

The declared package/plugin version is `1.3.0`; verify npm/GitHub/installed-host state separately
before claiming which build is the current published default.
The packaged tree contains 26 physical v3 packs and 52 executable method tools.
Every seat carries the `operator_lens` admission level: `method_model` = 0,
human source approvals = 0, human formula approvals = 0, human approval signatures = 0.
Human review of the authored formulas and the live four-host end-to-end run are the
outstanding work, so the production assembly path stays fail-closed until both are done.
See `docs/releases/v1.0.0.md`, `CHANGELOG.md` for everything since, and
`docs/report-contract.md`.

## Agent-Skills Governance

Also follow `skills/agent-skills-governance/SKILL.md`. It is bundled with this plugin and applies the `addyosmani/agent-skills` style of explicit gates, anti-rationalizations, and exit criteria to AlphaCouncil runs. Do not treat it as an optional local setup step.

For methodology comparisons and public-Skill tests, also follow
`skills/alphacouncil-method-lenses/SKILL.md`. It exposes 26 isolated provisional method
references; it may explain a frozen deterministic result but may not replace or rewrite it.

## Invocation

`/alpha <ticker>` runs full council; `/alpha` with no arguments lists its modes and stops.
`/alpha <ticker> quick` explicitly selects plugin-managed headless `quick_v1`. `screen`,
`options`, `news` and `market` are data-only modes and spawn no subagents.

Every full or quick council run must first call `begin_council_selection`, display each
returned master with its stable number, identity, method and `best_for`, and obtain a
submission. A native multi-select is optional; the common fallback accepts numbered choices,
ranges and stable IDs on every host. Full also accepts `all`; quick requires 1-4 distinct
methods and rejects `all`/`select_all`. Even if the request already names masters, show the
complete catalog and treat those names only as a prefill. Call
`confirm_master_selection(selection_id, catalog_hash, display_ack: true, ...)`, then pass its
one-use, mode-bound `selection_receipt` with the same symbol, prompt, language and
`council_mode` to the execution tool. Full may use `plan_visible_run`, `collect_evidence` or
`analyze_symbol`; quick must use `analyze_symbol`, and `plan_visible_run` rejects it.
No research, run directory or worker may start before that receipt exists. Data-only
`screen`, `options`, `news` and `market` modes skip the selection gate.

## Full v2 Runtime Contract

- Plugin-managed headless `analyze_symbol(council_mode="full")` runs at one of three depth
  tiers, selected by `council_pace`: `fast` = 900000 ms, `normal` (default) = 1800000 ms,
  `slow` = 3600000 ms, queue-to-terminal-persistence. Queueing, grounding, bounded repair, all
  workers, synthesis and artifact persistence share that clock. A caller or environment may
  lower the selected tier's budget, never raise it; `total_timeout_ms` above the tier's total is
  rejected and names the tier that would allow it.
- A tier sets the total AND every per-stage cap together, because the per-stage caps are what
  bound each worker. `slow` gives each evidence seat 12 minutes instead of 6 and each debate
  round 6 minutes per side instead of 150 seconds; `fast` gives 4.7 minutes and 45 seconds. That
  is where the depth difference lives — raising `total_timeout_ms` alone buys idle time, and
  lowering it alone starves the later stages into `incomplete`. Every tier's stages are proven
  to fit inside its own budget with headroom.
- A tier also shapes the worker's OUTPUT, because a cap alone is a timeout and a timeout is not
  a plan: the same prompt with a shorter fuse buys a packet the worker could not finish, not a
  faster good one. For an LLM call the wall clock is dominated by generated tokens, so `fast`
  asks for the same information in less prose — claims, figures, scoped source IDs, required
  report sections and the decision are never what gets cut; restatement is. `slow` buys room to
  write a derivation out in full. `normal` adds nothing, so its prompts stay byte-identical to
  the reviewed golden. Quick keeps its own shaping and receives no tier.
- `council_pace` changes depth, never the contract: all three tiers are `full_v2` with eight
  evidence seats, every selected method, three debate rounds and the PM. Quick rejects the field
  — it is a smaller contract, not a slower one. The tier is recorded in `status.json`.
- The tier is ASKED at the selection gate, not typed as an argument.
  `begin_council_selection` returns `pace_options`, one row per tier carrying both
  `expected_minutes` and `hard_ceiling_minutes` plus what the extra time buys; a ceiling
  published alone reads as the estimate. The answer goes to `confirm_master_selection` as
  `council_pace` and binds into the receipt, so an execution call may repeat the confirmed tier
  but never change it — a user who approved 15 minutes cannot end up running an hour. A speed
  named in the request is a prefill exactly like a named master: it highlights the row, the menu
  is still shown, the answer is still taken. No answer means `normal`.
- Start the eight mandatory evidence workers in one parallel wave. A failed mandatory role
  after its single bounded parse-only repair closes the evidence barrier and terminates
  `incomplete`; never refill the result from memory.
- For each selected physical v3 seat, execute the deterministic policy first and freeze its
  stance. Then run exactly one isolated explanation worker for that stable ID. The worker
  may make the method-seat result readable but cannot alter the stance or invent missing
  typed facts. Its text is a recorded provisional lens explanation, not the named person's
  words, endorsement or current opinion.
- Run Bull and Bear in parallel within Round 1, wait for both, then repeat for Round 2 and
  Round 3. Preserve the exact Round-2-question to Round-3-answer binding. Start the PM only
  after both Round-3 sides pass.
- Every selected method seat must report for the run to be COMPLETE, and a seat that never
  reported is always named in `missing_masters` and in the report. Whether the debate and PM
  run at all is a separate, weaker question: a near-complete bench (at most two absent and at
  least eight recorded) still proceeds to a decision, because one hung voice worker taking the
  rating with it serves no reader. A materially unconsulted bench still stops before those
  stages. Proceeding never upgrades the run: it terminates `incomplete` with the gap published.
- On global expiry, stop new downstream work and persist a terminal fail-closed `incomplete`
  run naming every timed-out, failed and skipped role. The ceiling guarantees a terminal
  artifact, not that external search/model/data services will let all seats succeed.
- The plugin cannot enforce this deadline on `plan_visible_run` host subagents. Visible full
  runs retain the same evidence/report gates but must not be described as 30-minute bounded.
  Run every returned post-evidence v3 explanation worker and record its `acknowledged_stance`
  before debate. Every selected physical v3 seat gets a worker, including `out_of_scope`.
  Require `voice_mode=first_person_public_method_simulation_v1`, the exact disclosure ack,
  `position_intent`, and all five strong first-person fields. A legacy environment toggle may
  not skip an abstaining seat or weaken this contract.
- If any visible evidence, selected method or debate worker cannot pass its bounded repair,
  call `finalize_visible_run` with the failed IDs. It closes the run as `incomplete`, writes
  the standard artifacts and returns `user_response_markdown`; do not substitute a manual
  verdict or leave the run in `running`.
- `plan_visible_run` always writes each planned prompt to `<run>/prompts/` and returns
  `prompt_file` beside every agent. It also returns `prompts_inline`: false means the prompt
  bodies were left out of the result because returning them together would exceed what a host
  accepts, and the host must read them from `prompt_file`. What drives that size is the
  grounding each prompt embeds, not the seat count.
- `record_visible_decision(role: 'portfolio_manager')` rejects a packet whose
  `report_markdown` does not carry every authored report-contract section, before the packet
  takes the idempotency lock. The rejection lists the missing sections and the heading to use
  for each. The master bench and instrument-structure sections are system-appended and are
  never asked of an author.

## Quick v1 Fixed Contract

- Fixed parallel evidence wave: `market_data`, `earnings_deep_dive`,
  `valuation_long_short`, `news_industry_management`. Task overrides are forbidden.
- The news role accepts only dated company/industry developments in the 120 days ending at
  `as_of`; future, undated and older items are excluded from recent news and recorded as gaps.
- Run the 1-4 selected methods in one parallel wave, then Bull and Bear once in parallel,
  then one short PM. There are no rebuttal/Q&A rounds or adversarial
  `source_fidelity`/`rederivation`/`refuter` workers.
- Enforce the 600000 ms queue-to-persistence ceiling: deterministic grounding wait 20s;
  each parallel evidence worker 210s; each parallel method worker 90s; Bull and Bear 90s per
  side; PM 90s; final assembly/persistence reserve 20s. Retry time is inside those caps.
  Callers and environment variables may lower the limit, never raise it.
- Quick may terminate `degraded` only under its explicit minimum-coverage rules and one
  system-owned, idempotent degraded ledger. Otherwise missing mandatory work is
  `incomplete` or `failed`. `report_quality=passed` validates only `quick_v1`; it never
  changes degraded to complete or makes `full_council_equivalent=true`.
- A selected method result is a recorded provisional lens output, never a quotation from the
  named person.

## Instrument Routing Contract

- Classify the symbol before selecting financial-data routes. Operating companies use
  `operating_company`; ETFs and mutual funds use `fund_lookthrough`; cash indices use
  `index_aggregate`.
- Do not call operating-company Company Facts or structured issuer financials for a fund or
  index. Record those paths as not applicable, then research dated holdings/constituents and
  weights, methodology, concentration, fees or index rules, liquidity/tracking/flows,
  rebalances and same-date aggregate valuation with explicit coverage weight.
- Never create fund/index revenue, company EPS, management guidance, fund-insider Form 4
  activity, or a portfolio financial statement by adding a few constituents.
- Every selected physical v3 method gets a readable final statement, including deterministic
  `out_of_scope` results. Full handoff ends with the exact selected-seat count and all complete,
  untruncated statements; failed seats remain visible as non-directional terminal diagnostics.
  Visible PM completion and `finalize_visible_run` return `user_response_markdown`; use it as
  the final response body rather than reducing it to an ACK or manual recap.

## Analyst Roles

Default evidence roles (the eight-seat default fan-out):

- `market_data`
- `earnings_deep_dive` — absorbed the former standalone earnings-call role
- `forward_expectations` — absorbed the former standalone sell-side-revisions role
- `quant_factor`
- `valuation_long_short`
- `news_industry_management` — absorbed the former standalone industry-voices role
- `insider_sec`
- `ib_event_analysis`

Optional analysts, on the `full` roster rather than the default:

- `macro_regime`
- `market_narrative`
- `social_pulse`

Quick evidence roles are the fixed four-seat subset listed above and always launch in one
parallel wave.

Master Bench: the selector's complete returned catalog is authoritative. Both modes display
every returned lens. Full accepts any non-empty selection or `all`; quick accepts only 1-4. Selected
methods run between evidence and debate. In plugin-managed headless mode, each selected v3
seat is a frozen deterministic stance plus its own isolated voice worker; this is a
process-isolated worker, not a persistent sidebar agent and not the real person. Quick runs
its 1-4 seats in one parallel wave. Full/deep
verifiers are `source_fidelity`, `rederivation`, and `refuter`; quick does not run this
adversarial fan-out. See `skills/alphacouncil-agent/SKILL.md` and `docs/personas.md`.

Do not call the 26 solo-test packs approved method models. The explicit solo-test loader
exposes 26 provisional `operator_lens` packs and 52 executable derived-proxy tools; none is
operational or `method_model`, and none has human source/formula approval or signature.

Debate roles:

- `bull_researcher`
- `bear_researcher`
- `portfolio_manager`

Full requires all three Bull/Bear rounds and exact round-3 Q&A before the PM. Quick requires
one parallel Bull/Bear statement round followed by a short PM.

## Hard Output Rules

Also follow `docs/report-contract.md`.

Full `full_v2` reports must include:

- conclusion and final rating
- analyst work log summarizing every evidence agent
- bull/bear debate record
- long thesis
- short thesis
- market expectations and implied thresholds
- analyst rating and target-price revisions
- earnings-call management signals
- quant factor / technical risk view
- news and management/industry voice signals
- short interest / borrow / options information when available
- strategic transaction or banking-event analysis when relevant
- valuation range
- catalysts
- risks
- position recommendation
- short-term 1-4 week view
- medium-term 3-6 month view
- long-term 12 month view
- data gaps / unavailable data
- invalidation conditions
- confidence
- source table

Quick `quick_v1` instead uses its fixed 13 sections: conclusion/rating; analyst work log;
one-round Bull/Bear record; system-owned Master Bench; earnings-call management signals;
recent company/industry news; valuation range; price conditions; major risks; position
recommendation; data gaps; confidence; and source table. Missing full-only quant, banking,
three-horizon, three-round-Q&A or adversarial-verifier sections must not fail a valid quick
report, and a passing quick report must never be presented as full-equivalent.

The final chat handoff may be concise, but it must not replace the saved report. Terminal runs
must write mode-appropriate `final_report.md`, `user_response.md`, `artifact_index.md`,
`report_quality.json`, per-seat Markdown, and Bull/Bear/PM output or explicit failure records.
A full handoff must list all eight mandatory analyst statuses and summaries, every selected
stable master ID with frozen stance and isolated-worker explanation/status, and one
system-owned price snapshot with currency/time/source or an explicit unavailable-data gap.
Tell the user the terminal status, report contract, elapsed/deadline state and file locations.
System-owned labels and failure text support `zh-CN`, `en`, `ja` and `ko`; propagate the
request language to every worker. `degraded` is a real quick-only terminal state, never a
synonym for complete.

Never hide missing data. If a source is unavailable, say so in `open_questions` and in the final report's data-gap section. If no critical data is missing, explicitly state that no critical data gaps were found.

Do not put execution labels like "visible version", "lite", "smoke test", "debug", or "did not use PDF/Data Analytics" in the user-facing investment report.

## Evidence Rules

Every material claim should map to a source ID. Source IDs must be globally scoped as:

```text
<task>:<local_source_id>
```

Example:

```text
market_data:S1
earnings_deep_dive:S3
quant_factor:S2
```

Do not cite bare `S1` after packets are merged.

## Runtime Files

Generated files live under:

```text
~/.alphacouncil-agent/runs/<run_id>/
```

Typical outputs:

- `status.json`
- `events.jsonl`
- `evidence.json`
- `<task>.json`
- `source_manifest.json`
- `bull_researcher.json`
- `bear_researcher.json`
- `manager_synthesis.json`
- `decision.json`
- `final_report.md`
- `all_agents.md`

Do not commit generated run artifacts.

## Development Rules

- Keep the implementation small.
- Do not add dependencies unless there is no simple Node.js standard-library path.
- Preserve the JSON packet contracts in `mcp/server.mjs`.
- After changes, run:

```bash
npm run check
```

## Important Boundaries

This repository is an independent Codex plugin implementation. It can be inspired by multi-agent investment-committee workflows, but do not copy external project source code into this repository.

Public Equity Investing and Investment Banking are Codex skills or remote workflows, not importable JavaScript libraries. Treat them as agent instructions, not as packages to `import`.
