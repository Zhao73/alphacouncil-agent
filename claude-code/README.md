# AlphaCouncil for Claude Code

**English** · [中文](README.zh-CN.md)

A research council for a stock, ETF or index, rebuilt around Claude Code's own primitives.
One request becomes parallel analyst subagents, deterministic method lenses, a three-round
Bull/Bear cross-examination and a portfolio-manager decision — saved as a sourced report.

It ships two ways to run the **same** council:

| | Claude Code plugin | Terminal client |
|---|---|---|
| Start | `/alpha NVDA` in Claude Code | `alphacouncil NVDA` in any terminal |
| Seats run as | Claude Code subagents (parallel `Agent` calls) | supervised headless `claude -p` workers |
| Orchestrated by | the `/alpha` skill following the MCP state machine | the client, deterministically, over the same state machine |
| Time ceiling | advisory (Claude Code owns subagent lifetimes) | enforced: per-seat caps + global deadline |
| Shared | `agents/*.md`, `lib/` state machine, packet validators, report renderer, run folder `~/.alphacouncil/runs/` |

A run started in one can be resumed in the other: `alphacouncil resume latest`.

## How a run works

```
council_plan ──► user confirms ──► council_start (freeze price, SEC fundamentals, technicals, options; evaluate 8 lenses)
      │
      ▼
council_next ──► wave of tasks ──► every seat researches, then calls council_record(packet)
      ▲                                  │   (validated: schema, local source IDs, dates, citations;
      └──────────────────────────────────┘    errors come back as repair instructions)
  evidence (8 parallel) → Bull/Bear R1 → R2 (rebuttals + questions) → R3 (answers) → PM
      │
      ▼
council_finalize ──► final_report.md · transcript.md · report_quality.json · user_response.md
```

- **Evidence seats (full = 8, quick = 4):** market data · earnings deep dive · forward
  expectations · quant factor · valuation & long/short · news/industry/management · insider &
  SEC · banking events.
- **Method lenses (8, no model calls):** deep value · quality compounder · GARP · secular growth ·
  trend & momentum · shareholder yield · balance-sheet risk · contrarian reversal. Each is a
  published-style screen computed from the frozen facts *before* any model writes, so a stance
  cannot be talked into existence. Too little data → `out_of_scope`, a gap and never a vote.
- **Debate:** Bull and Bear run in parallel inside each round; rounds are sequential. Round-3
  answers must address the opponent's exact round-2 question IDs (enforced).
- **PM:** rating (Buy/Overweight/Hold/Underweight/Sell), bear/base/bull values, ≥3 price
  conditions, catalysts, risks, position, three horizons, invalidation, data gaps.
- **Report:** assembled by code from the recorded packets, so no seat, citation or gap is lost
  in a model's summary. Every citation (`market_data:S3`, `grounding:quote`,
  `lens:garp`) must resolve to the source table.
- **Failure is explicit:** a seat that does not record is re-issued once, then marked failed.
  Too little evidence coverage or a failed debate/PM seat ends `incomplete`; finishing with
  failed seats is `degraded`. Neither is ever called complete.

## Install the plugin

```bash
# inside Claude Code
/plugin marketplace add Zhao73/alphacouncil-agent
/plugin install alphacouncil@alphacouncil
```

Restart Claude Code, then:

```text
/alpha                 list modes
/alpha NVDA            full council (asks you to confirm the plan first)
/alpha 0700.HK quick   quick council
/alpha AAPL news       keyless data, no model calls (also: quote, filings, options, lenses, macro)
```

To avoid a permission prompt for every data or council call made by subagents, allow the
plugin's tools and web research once (in `/permissions` or `.claude/settings.json`):

```json
{ "permissions": { "allow": ["mcp__plugin_alphacouncil_alphacouncil__*", "WebSearch", "WebFetch"] } }
```

Local development: `claude --plugin-dir ./claude-code`.

## Terminal client

Requires Node ≥ 18 and Claude Code (`npm i -g @anthropic-ai/claude-code`, signed in or with
`ANTHROPIC_API_KEY`). No other dependencies.

```bash
npm i -g ./claude-code          # or: node claude-code/cli/alphacouncil.mjs …
alphacouncil                    # interactive: ticker → question → mode → depth → language → lenses → confirm
alphacouncil NVDA --pace slow --lang zh-CN
alphacouncil 7203.T --quick --yes --plain     # scripted, append-only progress
alphacouncil runs | show latest | status latest | resume latest
alphacouncil quote|news|filings|options|lenses AAPL · alphacouncil macro
alphacouncil doctor --live
```

The dashboard shows every seat's state, elapsed time, current tool call (web search query, URL,
data tool), cost, repair attempts and the run clock against its ceiling. `Ctrl+C` stops the run
and finalizes what was recorded; `alphacouncil show latest` renders the report in the terminal
(tables wrap to width, CJK-aware) through your pager.

Options: `--model`, `--evidence-model`, `--debate-model`, `--pm-model` (default
sonnet/sonnet/opus), `--concurrency` (default 8), `--worker-budget-usd`, `--question`,
`--lenses`. Environment: `ALPHACOUNCIL_HOME` (default `~/.alphacouncil`),
`ALPHACOUNCIL_CLAUDE_BIN`, `ALPHACOUNCIL_SEC_CONTACT` (SEC asks for a contact in the User-Agent),
`NO_COLOR`.

| Mode | Workers | Ceiling (terminal) |
|---|---|---:|
| quick | 4 evidence → 1 Bull/Bear round → PM | 10 min |
| full · fast | 8 evidence → 3 rounds → PM, terse output | 15 min |
| full · normal | same, standard depth | 30 min |
| full · slow | same, derivations written out | 60 min |

Ceilings are hard stops, not expected durations.

## Data

Keyless public sources, each result stamped with its source and retrieval date: Yahoo Finance
chart/search (delayed quotes, daily history), SEC EDGAR (XBRL company facts → TTM metrics and
multiples; filings), Google News RSS (dated headlines only), Cboe delayed options (put/call,
ATM IV term structure, 25-delta skew), FRED (rates, curve, CPI, VIX, credit spreads, USD).
ETFs route to holdings look-through and indices to aggregate methodology; issuer financials are
never synthesized for a basket. When a source is unreachable the gap is named in the report.

## Layout

```
claude-code/
  .claude-plugin/plugin.json   .mcp.json
  skills/alpha/SKILL.md        the /alpha orchestrator (≈1.7k tokens when invoked)
  agents/*.md                  11 seats — plugin subagents AND terminal worker system prompts
  mcp/server.mjs               zero-dependency MCP stdio server
  lib/                         data, technicals, lenses, spec, state machine, validation, report
  cli/                         terminal client: orchestrator, worker, dashboard, renderer
  test/                        node:test suite, including a fake `claude` for end-to-end runs
```

`npm test` runs the suite (no network). Research output is AI-generated from public sources and
is not investment advice. Method lenses are deterministic reconstructions of published screening
methods, not the views of any person.
