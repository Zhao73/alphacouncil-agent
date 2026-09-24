---
name: verdict
description: Stock research with a clear verdict — live data snapshot, parallel research desks, a bull vs bear debate and a portfolio-manager decision with value range, price levels and a saved HTML/Markdown report. Use when the user asks to research, analyze, value or decide on a stock, ETF or index ("is NVDA a buy?", "research 0700.HK", "/verdict AAPL"), asks about their watchlist, or wants a quote, news, filings, options or macro data.
argument-hint: "<TICKER> [question] [--fast]"
allowed-tools: Agent, mcp__plugin_verdict_verdict__verdict_start, mcp__plugin_verdict_verdict__verdict_task, mcp__plugin_verdict_verdict__verdict_submit, mcp__plugin_verdict_verdict__verdict_finish, mcp__plugin_verdict_verdict__verdict_report, mcp__plugin_verdict_verdict__verdict_history, mcp__plugin_verdict_verdict__watchlist, mcp__plugin_verdict_verdict__snapshot, mcp__plugin_verdict_verdict__quote, mcp__plugin_verdict_verdict__news, mcp__plugin_verdict_verdict__filings, mcp__plugin_verdict_verdict__options, mcp__plugin_verdict_verdict__macro
---

# Verdict

Request: **$ARGUMENTS**

Start right away — no plan to confirm, no menus. The `verdict` MCP server fetches the data,
hands out exact instructions per task and writes the report; you and your subagents think.

## Route

| Request | Do |
|---|---|
| empty | Reply: `/verdict <TICKER> [question] [--fast]` — deep research by default (~3-5 min), `--fast` for a quick read. Stop. |
| ticker, company name or a question about one | **Deep research** |
| ticker + `--fast` or "quick" | **Fast read** |
| "my watchlist" | `watchlist` and summarise alerts first |
| quote / news / filings / options / snapshot + ticker, or "macro" | that data tool; summarise with dates. No research run. |
| follow-up about an earlier verdict | `verdict_report` (ticker or latest) and answer from it; search only if it lacks the answer |

Company names → ticker (Microsoft → MSFT, Tencent → 0700.HK, Toyota → 7203.T). Language: the
language the user writes in.

## Deep research (default)

1. `verdict_start(symbol, mode "deep", language, question, host)` with `host` = `claude-code`
   or `codex`. Tell the user the price and two or three key numbers from the snapshot.
2. **Desks** `business`, `street`, `news`, `risk`
   - Claude Code: in ONE message start four `verdict:desk` subagents with the prompt
     `Verdict run <run_id>, task <task>.` and wait for all four (background subagents: wait for
     every completion notice).
   - Codex or no subagents: for each task, `verdict_task` → research (~5 web searches) →
     `verdict_submit`.
3. **Debate** `bull`, `bear`
   - Claude Code: in ONE message start two `verdict:advocate` subagents
     (`Verdict run <run_id>, task bull.` / `… task bear.`) and wait for both.
   - Codex: write `bull` then `bear` yourself from `verdict_task`, no browsing.
4. **Decision** — yourself: `verdict_task(run_id, "decision")` → decide → `verdict_submit`.
5. `verdict_finish(run_id)`: show its `summary`, then the `report` and `html` paths. Offer
   follow-up questions.

A task that fails twice: skip it; `verdict_finish` records it and the report says so. Never fill
a missing result from memory.

## Fast read

`verdict_start(mode "fast")` → task `all` (Claude Code: one `verdict:desk`; Codex: yourself) →
`decision` yourself → `verdict_finish`.

## Rules

- `verdict_submit` validates; on errors fix exactly those and resubmit.
- Subagents submit their own results; don't re-type their work.
- State the outcome honestly: `complete`, `degraded` (a task failed) or `incomplete`.
- AI-generated research from public sources, not investment advice.
