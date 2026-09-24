# Verdict — notes for coding agents

Verdict is stock research with a clear verdict, delivered three ways from one engine:
the terminal (`bin/verdict.mjs`), a Claude Code plugin and a Codex plugin.

## Layout

- `src/engine/` — research engine, no dependencies: `data` (keyless sources), `snapshot`,
  `prompts` + `schemas` + `normalize`, `pipeline` (terminal runs), `host` (plugin runs where the
  host does the model work), `compare`, `watch` (watchlist + track record), `intent`, `target`.
- `src/models/` — engines: `api.mjs` (the only file that imports `@anthropic-ai/sdk`) and
  `claude.mjs` (headless `claude -p`).
- `src/tui/` — full-screen app: `theme`, `frame` (cell buffer + row diffs), `keys`, `views`, `app`.
- `src/cli/` — commands and stream mode. `src/render/` — Markdown, HTML and terminal rendering.
- `src/mcp/server.mjs` — plugin MCP server. `skills/verdict/`, `agents/` — plugin surface.
- `src/demo.mjs` — offline demo on a fictional company (also used by `npm run shots`).

## Rules

- Research flow: snapshot → desks (`business`, `street`, `news`, `risk`; fast: `all`) → `bull` +
  `bear` → `decision`. Every model output has a schema; normalization fixes, it does not retry.
- Reports are assembled by code. States: `complete`, `degraded`, `incomplete` — never present the
  last two as complete. Never fill missing data from memory.
- Anything the MCP server imports must stay dependency-free (plugins run without `npm install`).
- Runtime data lives in `~/.verdict/` (`VERDICT_HOME`); never commit it.
- Screenshots and examples use the fictional ACME demo, never invented numbers for real companies.
- Before committing: `npm test` (offline). Regenerate README images with `npm run shots`.
