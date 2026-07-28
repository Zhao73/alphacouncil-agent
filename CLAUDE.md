# Claude Instructions For This Repository

You are working on `alphacouncil-agent`, a Codex plugin for public-equity research.

## Purpose

The plugin turns `@alphacouncil-agent <ticker/request>` into one of two explicit equity-research council contracts:

- `full_v2` is the default: display and confirm the method catalog, run all eight mandatory
  evidence roles, run every selected method, complete the three-round Bull/Bear cross-exam,
  run the PM, and write the complete report. If mandatory evidence still fails after its one
  bounded parse-only repair, persist the failure package, skip method/debate/PM model calls,
  and terminate `incomplete` before downstream synthesis.
- `quick_v1` runs only when explicitly requested and only through plugin-managed headless
  `analyze_symbol`: display all 26 methods, confirm 1-4, run four fixed evidence roles and the
  selected methods in parallel waves, one parallel Bull/Bear statement round, then a short
  PM inside a hard ten-minute ceiling.

Never infer quick from impatience, a short prompt, a deadline, or a full-mode failure. Do not
downgrade to lite, smoke-test, or debug output unless the user explicitly asks for that
non-investment test output.

## Current Build Profile

The declared package/plugin version is `0.9.2`. It is published to npm's `next` dist-tag and
as a GitHub prerelease: a non-GA quick-council preview. The build channel remains
`solo_test`. The isolated packaged tree contains 26 physical v3 packs and 52 executable
`provisional_derived_proxy` tools.
Every seat is still a provisional `operator_lens`: operational = 0, `method_model` = 0,
human source approvals = 0, human formula approvals = 0, human approval signatures = 0.
The production loader rejects these packs and formal production GA remains fail-closed.
See `docs/releases/v0.9.2.md` and `docs/report-contract.md`.

## Agent-Skills Governance

Also follow `skills/agent-skills-governance/SKILL.md`. It is bundled with this plugin and applies the `addyosmani/agent-skills` style of explicit gates, anti-rationalizations, and exit criteria to AlphaCouncil runs. Do not treat it as an optional local setup step.

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

Master Bench: the complete generated catalog has 26 selectable lenses. Both modes display
all 26. Full accepts any non-empty selection or `all`; quick accepts only 1-4. Selected
methods run between evidence and debate; quick runs them in one parallel wave. Full/deep
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
Tell the user the terminal status, report contract and file locations. `degraded` is a real
quick-only terminal state, never a synonym for complete.

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
