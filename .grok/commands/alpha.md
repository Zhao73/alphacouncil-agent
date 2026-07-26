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
| ticker + `quick` | The `quick` preset: 4 analysts and the debate. No bench, no verification. |
| ticker + `screen` | `screen_ticker` only. No language-model judgment, no subagents. |
| ticker + `options` | `get_options_chain` only. |
| ticker + `news` | `get_news` on the symbol, and on its CIK when it is a US filer. |
| `market` (with or without a theme) | `get_market_narrative`. Add the theme as `extra_queries`. |

When `$ARGUMENTS` is empty, print exactly this and stop:

```
/alpha MU              full council — asks which preset first
/alpha MU quick        4 analysts + debate, no bench, no verification
/alpha MU screen       mechanical filings screen only        (no model spend)
/alpha MU options      IV term structure, skew, positioning  (no model spend)
/alpha MU news         dated filings and headlines           (no model spend)
/alpha market AI       what the market is talking about      (no model spend)
```

Say plainly that the four marked modes call keyless data tools and spawn no subagents, so
they cost nothing beyond this turn. The council modes spawn one subagent per seat, and that
is where the spend is.

## Full council

1. **Ask which preset first.** Call `list_council_options` and present the three with their
   seat counts. A council is 7 to 44 seats and that range is the user's time and money.
   **Skip the question when the request already answered it** — a named roster, "everything",
   "be quick". A confirmation nobody needed is an interruption.
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

State in the output that no master lenses ran and nothing was cross-verified, so the
confidence is lower than a standard run. Without it, a four-seat run reads like a full
council result.

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
