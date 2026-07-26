---
description: Run the full investment council on a ticker or a question
argument-hint: [ticker or question]
---

# AlphaCouncil — full council

The user asked for: **$ARGUMENTS**

## Do this in order

1. **Ask which council to run first.** Call `list_council_options` and present the three
   presets with their seat counts and relative cost. A council is 7 to 44 seats and that
   range is the user's time and money.
   **Skip the question if they already answered** — if `$ARGUMENTS` names a roster, says
   "everything", or says "quick", act on it. A confirmation nobody needed is an interruption.

2. Follow `skills/alphacouncil-agent/SKILL.md` from Stage 0. Do not improvise a shorter
   workflow: the gates exist because a report that looks finished and skipped the bench is
   worse than an obviously partial one.

3. **Call the tools instead of searching for numbers they can supply.** `screen_ticker` for
   filings, `get_quote` for price, `get_options_chain` for positioning, `get_macro_snapshot`
   for context, `get_news` for dated items. Search is for explanation and for what is not
   yet filed.

4. Every selected master must report before the run can be complete. `out_of_scope` is a
   conclusion, not an abstention.

5. Give price bands with the condition attached to each. "The cycle position is undetermined"
   changes what the bands depend on; it does not excuse leaving them out.

## Never

- Never fill a number from memory when a tool could have supplied it.
- Never present a rule with missing inputs as a pass — it is `skipped`.
- Never let social or narrative evidence enter the conclusion on its own.

This is educational software. The final report says so.
