# Claude Instructions For This Repository

You are working on `alphacouncil-agent`, a Codex plugin for public-equity research.

## Purpose

The plugin turns `@alphacouncil-agent <ticker/request>` into a full equity-research workflow:

1. Display every available master method and confirm a one-run selection receipt.
2. Spawn or plan specialized analyst workers.
3. Produce JSON evidence packets with sourced claims.
4. Merge packets into a shared evidence base and run every selected master.
5. Run bull and bear researchers.
6. Run a portfolio manager to decide Buy / Overweight / Hold / Underweight / Sell.
7. Write a complete final report directly in chat and to `~/.alphacouncil-agent/runs/<run_id>/final_report.md`.

Default behavior is full workflow. Do not downgrade to lite, smoke-test, or debug output unless the user explicitly asks for it.

## Current Build Profile

The declared package/plugin version is `0.9.0-solo-test.3`, channel `solo_test`. The isolated packaged
tree contains 26 physical v3 packs and 52 executable `provisional_derived_proxy` tools.
Every seat is still a provisional `operator_lens`: operational = 0, `method_model` = 0,
human source approvals = 0, human formula approvals = 0, human approval signatures = 0.
The production loader rejects these packs and formal production GA remains fail-closed.
See `docs/solo-test-0.9.0.md`.

## Agent-Skills Governance

Also follow `skills/agent-skills-governance/SKILL.md`. It is bundled with this plugin and applies the `addyosmani/agent-skills` style of explicit gates, anti-rationalizations, and exit criteria to AlphaCouncil runs. Do not treat it as an optional local setup step.

## Invocation

`/alpha <ticker>` runs the council; `/alpha` with no arguments lists its modes and stops.
`quick`, `screen`, `options`, `news` and `market` select narrower modes, and the last four
spawn no subagents at all.

Every full or quick council run must first call `begin_council_selection`, display each
returned master with its stable number, identity, method and `best_for`, and obtain a
submission. A native multi-select is optional; the common fallback accepts numbered choices,
ranges and `all` in plain text on every host. Even if the request already names masters,
show the complete catalog and treat those names only as a prefill. Call
`confirm_master_selection(selection_id, catalog_hash, display_ack: true, ...)`, then pass its
one-use `selection_receipt` to `plan_visible_run`, `collect_evidence` or `analyze_symbol`.
No research, run directory or worker may start before that receipt exists. Data-only
`screen`, `options`, `news` and `market` modes skip the selection gate.

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

Master bench: the complete generated catalog (26 selectable lenses for the 0.9.0 roster), selectable
one by one or with `all`, and run between evidence and debate on **every** host. Verifiers:
`source_fidelity`, `rederivation`, `refuter`. See `skills/alphacouncil-agent/SKILL.md` for the
workflow and `docs/personas.md` for the generated roster.

Do not call the 26 solo-test packs approved method models. The explicit solo-test loader
exposes 26 provisional `operator_lens` packs and 52 executable derived-proxy tools; none is
operational or `method_model`, and none has human source/formula approval or signature.

Debate roles:

- `bull_researcher`
- `bear_researcher`
- `portfolio_manager`

## Hard Output Rules

Also follow `docs/report-contract.md`.

Final reports must include:

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

The final chat handoff may be concise, but it must not replace the saved report. Completed runs must write `final_report.md`, `user_response.md`, `artifact_index.md`, `report_quality.json`, one Markdown file per evidence analyst, and Markdown files for bull, bear, and portfolio manager. Tell the user where those files are.

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
