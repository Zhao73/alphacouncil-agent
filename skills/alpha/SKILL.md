---
name: alpha
description: Equity research on a stock, ETF or index — live data snapshot, parallel research desks, a bull vs bear debate and a portfolio-manager decision with a value range, price levels and a saved report. Use when the user asks to research, analyze, value, rate or decide on a ticker ("is NVDA a buy?", "analyze 0700.HK", "/alpha AAPL"), or asks for its quote, news, filings, options or a macro snapshot.
argument-hint: "<TICKER> [question] [--fast]"
allowed-tools: Agent, mcp__plugin_alphacouncil_alphacouncil__research_start, mcp__plugin_alphacouncil_alphacouncil__research_brief, mcp__plugin_alphacouncil_alphacouncil__research_submit, mcp__plugin_alphacouncil_alphacouncil__research_finalize, mcp__plugin_alphacouncil_alphacouncil__research_report, mcp__plugin_alphacouncil_alphacouncil__research_runs, mcp__plugin_alphacouncil_alphacouncil__snapshot, mcp__plugin_alphacouncil_alphacouncil__quote, mcp__plugin_alphacouncil_alphacouncil__news, mcp__plugin_alphacouncil_alphacouncil__filings, mcp__plugin_alphacouncil_alphacouncil__options, mcp__plugin_alphacouncil_alphacouncil__macro
---

# AlphaCouncil

Request: **$ARGUMENTS**

Start immediately — no plan to confirm, no menus. The `alphacouncil` MCP server fetches the
data and gives exact instructions per task; you (and your subagents) do the thinking; code
writes the report.

## Route

| Request | Do |
|---|---|
| empty | Say: `/alpha <TICKER> [question] [--fast]` — deep research by default (~3-5 min); `--fast` for a quick read. Stop. |
| ticker (+ optional question) | **Deep research** (default) |
| ticker + `--fast` / "quick" | **Fast read** |
| "quote / news / filings / options / snapshot" + ticker, or "macro" | Call that data tool and summarise it with dates. No research run. |
| a follow-up about an earlier report | `research_report` (latest, or the ticker) and answer from it; search only if it lacks the answer. |

If the user names a company instead of a ticker, use the ticker you are confident of (e.g.
Microsoft → MSFT, Tencent → 0700.HK). Language: the language the user writes in.

## Deep research (default)

1. `research_start(symbol, mode "deep", language, question, host)` — `host` is `claude-code`
   or `codex`. Show the user 2-3 lines from the snapshot (price, key multiples, gaps).
2. **Research desks** — tasks `business`, `street`, `news`, `risk`:
   - **Claude Code:** in ONE message launch four `alphacouncil:analyst` subagents in parallel,
     each with the prompt `AlphaCouncil run <run_id>, task <task>.` Wait until all four finish
     (if they run in the background, wait for every completion notification).
   - **Codex / no subagents:** for each task in turn: `research_brief` → research with web search →
     `research_submit`. Keep each desk to ~5 searches.
3. **Debate** — tasks `bull`, `bear`:
   - **Claude Code:** in ONE message launch two `alphacouncil:advocate` subagents with
     `AlphaCouncil run <run_id>, task bull.` / `… task bear.` and wait for both.
   - **Codex:** do `bull` then `bear` yourself (brief → write → submit), no browsing.
4. **Decision** — do it yourself: `research_brief(run_id, "decision")`, decide, `research_submit`.
5. `research_finalize(run_id)` and show its `summary` plus the report path. Offer follow-ups.

A task that fails twice: skip it and continue — `research_finalize` records it and the report
says so. Never fill a missing result from memory.

## Fast read

`research_start(mode "fast")` → task `all` (Claude Code: one `alphacouncil:analyst`; Codex: do it
yourself) → `decision` yourself → `research_finalize`.

## Rules

- `research_submit` validates; if it returns errors, fix exactly those and resubmit.
- Subagents submit their own results; do not re-type their work into the chat.
- Tell the user the terminal state honestly: `complete`, `degraded` (finished with a failed
  task) or `incomplete`.
- Research output is AI-generated from public sources, not investment advice.
