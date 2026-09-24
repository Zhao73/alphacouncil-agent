---
name: alpha
description: Equity research council for a stock, ETF or index — parallel analyst subagents, deterministic method lenses, a Bull/Bear cross-examination and a portfolio-manager decision, saved as a sourced report. Also keyless data look-ups (quote, news, filings, options, macro, lenses). Use when the user asks to research, analyze, rate or value a ticker, or runs /alpha.
argument-hint: "<TICKER> [quick|fast|slow] [lang] · or <TICKER> quote|news|filings|options|lenses · or macro"
allowed-tools: mcp__plugin_alphacouncil_alphacouncil__council_plan, mcp__plugin_alphacouncil_alphacouncil__council_start, mcp__plugin_alphacouncil_alphacouncil__council_next, mcp__plugin_alphacouncil_alphacouncil__council_finalize, mcp__plugin_alphacouncil_alphacouncil__council_status, mcp__plugin_alphacouncil_alphacouncil__council_runs, mcp__plugin_alphacouncil_alphacouncil__quote, mcp__plugin_alphacouncil_alphacouncil__price_history, mcp__plugin_alphacouncil_alphacouncil__fundamentals, mcp__plugin_alphacouncil_alphacouncil__filings, mcp__plugin_alphacouncil_alphacouncil__news, mcp__plugin_alphacouncil_alphacouncil__options_snapshot, mcp__plugin_alphacouncil_alphacouncil__macro_snapshot, mcp__plugin_alphacouncil_alphacouncil__method_lenses, mcp__plugin_alphacouncil_alphacouncil__instrument_lookup
---

# AlphaCouncil

Request: **$ARGUMENTS**

You are the orchestrator. The MCP server `alphacouncil` owns the workflow as a state machine;
your job is to show the plan, get one confirmation, launch the tasks it hands you in parallel,
and present the result. You never write research yourself and never write the report — code
assembles it from the recorded packets.

## 1. Route the request

| Request looks like | Do |
|---|---|
| empty | Print the mode list below and stop. |
| `<TICKER>` or a question naming one | Full council, pace `normal`. |
| `<TICKER> fast` / `slow` | Full council with that pace. |
| `<TICKER> quick` | Quick council (4 analysts, 1 debate round, ≤10 min). |
| `<TICKER> quote` / `news` / `filings` / `options` / `lenses` | Data only: call `quote` / `news` (query = company name + ticker, 30 days) / `filings` / `options_snapshot` / `method_lenses`, summarize with dates and links. No subagents. |
| `macro` | `macro_snapshot`, summarize. No subagents. |
| `runs` / `status` | `council_runs` / `council_status`. |

Language: use the language the user wrote in (e.g. `zh-CN` for Chinese, `ja`, `en`) unless they
name one. Never infer `quick` from a short prompt or impatience — quick only when asked.

Mode list (print when the request is empty):

```
/alpha <TICKER>            full council · 8 analysts → 8 method lenses → 3 Bull/Bear rounds → PM
/alpha <TICKER> fast|slow  same contract, shallower (15 min) or deeper (60 min) work per seat
/alpha <TICKER> quick      4 analysts → lenses → 1 Bull/Bear round → PM (≤10 min)
/alpha <TICKER> quote      delayed quote            (no model calls)
/alpha <TICKER> news       dated headlines, 30 days (no model calls)
/alpha <TICKER> filings    recent SEC filings       (no model calls)
/alpha <TICKER> options    IV term structure, skew  (no model calls)
/alpha <TICKER> lenses     deterministic method lenses on live facts (no model calls)
/alpha macro               rates, curve, CPI, VIX, credit, USD (no model calls)
```

## 2. Plan and confirm (council modes only)

1. Call `council_plan` with `symbol`, `mode`, `pace`, `language`, and `lenses` (default `"all"`;
   pass a subset only if the user named lenses).
2. Show the plan compactly: instrument, mode/pace, the analyst seats, the lenses, the stages,
   the number of model calls, and the time ceiling (advisory in Claude Code).
3. Ask once with AskUserQuestion: **Start** (recommended) · **Switch to quick / full** ·
   **Change lenses or pace**. If the user changes something, call `council_plan` again with the
   new settings. Skip the question only when the user explicitly said not to ask (e.g. `--yes`).
4. Call `council_start` with the same settings, the user's original request as `question`, and
   the `plan_id` from the final `council_plan`. Tell the user the frozen price and any grounding
   gaps in one or two lines.

## 3. Run the loop

```
r = council_next(run_id)
while not r.done:
    in ONE message, launch every task in r.tasks with the Agent tool:
        subagent_type = task.subagent      (e.g. alphacouncil:market-data)
        description   = task.description
        prompt        = task.prompt        (verbatim — it is short on purpose)
    wait for all of them to return
    r = council_next(run_id)
council_finalize(run_id, reason = r.reason unless it is "all stages recorded")
```

- Launch the whole wave in parallel in a single message; never one at a time. If the subagents
  run in the background, wait for every one of their completion notifications. Never call
  `council_next` before every task in the wave has finished — an unrecorded task is treated as a
  failed attempt and re-issued.
- Subagents record their own packets. Their replies are one line (`RECORDED …` / `FAILED …`);
  do not ask them for more and do not re-type their work.
- If a `subagent_type` is not available, launch `general-purpose` with the same prompt; the
  brief it fetches includes the role guide.
- Repairs are automatic: `council_next` re-issues a missing seat once, then marks it failed.
  Too little evidence coverage or a failed debate/PM seat ends the run `incomplete` — that is a
  valid, honest outcome. Do not fill gaps yourself.
- Between waves, tell the user one short line of progress (e.g. "Evidence 8/8 recorded → Round 1").

## 4. Hand off

Show `handoff_markdown` from `council_finalize` as the answer body, then the report path. The
terminal state is `complete`, `degraded` (finished with failed seats, disclosed) or
`incomplete`; never describe degraded or incomplete as complete. Offer to open
`final_report.md` or answer follow-up questions from it (read the file; do not re-research).

## Rules

- Nothing starts before the user confirmed the plan (or explicitly waived confirmation).
- Research output is AI-generated from public sources, not investment advice. Method lenses are
  deterministic reconstructions of published screening methods, not the views of any person.
- Do not add execution labels such as "lite", "debug" or "smoke test" to anything user-facing.
