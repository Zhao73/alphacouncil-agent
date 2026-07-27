---
description: Equity research council — full run, quick read, mechanical screen, or market narrative
argument-hint: [ticker] [quick|screen|market|options|news] · or just a question
---

# /alpha

Request: **$ARGUMENTS**

## Route on the arguments — do not ask what they meant

| `$ARGUMENTS` looks like | Do this |
|---|---|
| *(empty)* | Print the mode table below and stop. Do not start a run. |
| a ticker alone, or a question | **Full council.** Go to "Full council" below. |
| ticker + `quick` | The `quick` evidence preset: 4 analysts + the selected master methods + debate. No verification. |
| ticker + `screen` | `screen_ticker` only. No language-model judgment, no subagents. |
| ticker + `options` | `get_options_chain` only. |
| ticker + `news` | `get_news` on the symbol, and on its CIK when it is a US filer. |
| `market` (with or without a theme) | `get_market_narrative`. Add the theme as `extra_queries`. |

When `$ARGUMENTS` is empty, print exactly this and stop:

```
/alpha <TICKER>          full council — shows every master, then asks which to run
/alpha <TICKER> quick    4 analysts + selected masters + debate, no verification
/alpha <TICKER> screen   mechanical filings screen only        (no model spend)
/alpha <TICKER> options  IV term structure, skew, positioning  (no model spend)
/alpha <TICKER> news     dated filings and headlines           (no model spend)
/alpha market <theme>    what the market is talking about      (no model spend)

examples
  /alpha AAPL            /alpha 0700.HK quick     /alpha 7203.T news
  /alpha NVDA screen     /alpha market rates      /alpha "is TSM cheap?"
```

Any listed equity. Filings-based modes need a US filer; for other markets say which market it
is and use `market_coverage`, rather than returning nothing.

Say plainly that the four marked modes call keyless data tools and spawn no subagents, so
they cost nothing beyond this turn. The council modes spawn one subagent per seat, and that
is where the spend is.

## Council selection gate — mandatory for full and quick

This gate happens before any research tool, run envelope, network fetch or subagent. It is
the same in Claude Code, Codex, OpenCode and Grok Build.

1. Call `begin_council_selection` with the symbol, original request, language and host. If
   the request explicitly names masters, also pass those stable IDs as
   `preselected_master_ids`; this highlights them but does not confirm them.
2. Show **every returned master individually, in the returned order and with its stable
   number**. Each row must include `identity`, `method`, `best_for` and `maturity`; a school
   name or a count is not a substitute for the individual catalog.
3. Ask for one submission. Accept one number from `1..N`, any comma/space-separated
   combination, ranges such as `1-4` or `1..4`, stable IDs/names, or `all`. A host-native
   multi-select is a convenience only. If it is unavailable or cannot show the full catalog,
   use the numbered text table and plain reply on every host.
4. If the original request already named masters or said `all`, prefill that choice but
   **still show the full catalog and require this run's submission**. Do not silently reuse a
   prior choice. The submitted choice is the confirmation; do not ask a second confirmation.
5. Call `confirm_master_selection` with the returned `selection_id`, `catalog_hash`,
   `display_ack: true`, and exactly one of `selected_master_ids`, `select_all: true`, or
   `selection`. Retain the returned one-use `selection_receipt`.
6. Only now call `plan_visible_run`, `collect_evidence` or `analyze_symbol`, passing that
   `selection_receipt`. Do not also pass `masters` or `masters_roster`; the receipt is the
   authoritative selection. If the receipt is missing, expired, stale or consumed, restart
   from `begin_council_selection`.

`screen`, `options`, `news` and `market` are data-only modes and skip this gate. `quick` is
still a council judgment, so it never skips the gate; it changes the analyst fan-out, not the
master-selection contract.

## Full council

1. Complete the mandatory council selection gate above. Analysts default to the eight-seat
   fan-out; do not ask about them.
2. Follow `skills/alphacouncil-agent/SKILL.md` from Stage 0. Do not improvise a shorter
   workflow: a report that looks finished and skipped the bench is worse than an obviously
   partial one.
3. **Call the tools rather than searching for numbers they can supply.** `screen_ticker`,
   `get_quote`, `get_options_chain`, `get_macro_snapshot`, `get_news`. Search is for
   explanation and for what is not yet filed.
4. Every selected master must report before the run is complete. `out_of_scope` is a
   conclusion, not an abstention.
5. Give price bands with the condition attached to each. "The cycle position is undetermined"
   changes what the bands depend on; it does not excuse leaving them out.

## Quick mode owes the reader one sentence

Complete the same mandatory council selection gate, then use four analysts, the selected
masters and the debate without verifier fan-out. State that evidence coverage and
cross-verification are thinner than a standard run; list the selected masters so the quick
result cannot be mistaken for the full bench.

## Screen mode

A rule whose inputs are missing is `skipped`, **never a pass** — reporting "6/7 passed"
without naming the seventh misrepresents the screen. Surviving is not a recommendation; it
means the name is worth research time. For a non-US ticker, say which market it is and use
`market_coverage` rather than returning nothing.

## Market mode

Read it by the gap, not the ranking. A theme leading coverage while its series has not moved
means the story is ahead of the data, or the market stopped listening — say which. A series
that moved sharply while its theme is barely covered is the more valuable finding. Headline
counts measure attention, never truth.

## Never

- Never fill a number from memory when a tool could have supplied it.
- Never let social or narrative evidence enter the conclusion on its own.

Educational software. The report says so.
