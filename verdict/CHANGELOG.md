# Changelog

All notable changes to Verdict. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-09-24

First release.

### Research
- Snapshot first: price, history, SEC fundamentals and multiples, filings, options, dated news and
  eight deterministic method screens, fetched in parallel with a disk cache before any model runs.
- Deep research (default): four research desks in parallel → bull and bear in parallel →
  portfolio-manager verdict. `--fast`: one research pass → verdict.
- Question-aware: earnings, valuation, short-term trade, long-term and risk questions steer what
  the desks prioritise and how the verdict is framed.
- The verdict streams while it is written.
- Every model output has a JSON schema; code resolves citations, fixes dates and orders the value
  range instead of re-running models. Reports are assembled by code.
- Honest outcomes: `complete`, `degraded` (a task failed) or `incomplete` (no verdict).

### Terminal
- Full-screen app (`verdict`): watchlist and history sidebar, Verdict / Report / Evidence / Ask
  tabs, command bar, background research, mouse wheel, CJK-aware layout.
- Stream mode (`verdict NVDA`): live progress redrawn in place, then the verdict card and
  follow-up questions.
- `compare`, `watch` with alerts (price zones, new filings, stale verdicts), `track` record,
  `ask`, `history`, `show`, `export`, data commands, `doctor`, and an offline `demo`.
- Self-contained HTML report with a price chart, value range and price levels.

### Engines
- `api`: official Anthropic SDK — streaming, server-side web search and fetch, a strict submit
  tool, `pause_turn` resumption and refusal handling.
- `claude`: headless Claude Code (`claude -p`) with `--json-schema`, using your Claude Code login.

### Plugins
- Claude Code plugin: `/verdict` skill, `desk` and `advocate` subagents in parallel, and a
  dependency-free MCP server for the snapshot, task instructions, validation and reports.
- Codex plugin sharing the same skill and server.

[1.0.0]: https://github.com/Zhao73/verdict/releases/tag/v1.0.0
