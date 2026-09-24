# AlphaCouncil — instructions for coding agents

AlphaCouncil is fast AI equity research that runs in three places from one codebase:

- **Terminal client** (`bin/alpha.mjs`, `src/cli/`): `alpha NVDA`. The engine in
  `src/core/pipeline.mjs` runs the models itself through a backend in `src/backends/`:
  `api.mjs` (official Anthropic SDK, used when `ANTHROPIC_API_KEY` is set) or `claude.mjs`
  (headless `claude -p` with the user's Claude Code sign-in).
- **Claude Code plugin** (`.claude-plugin/`, `.mcp.json`, `skills/alpha/`, `agents/`): the host
  does the model work with parallel subagents; the MCP server (`src/mcp/server.mjs`) supplies
  the snapshot, per-task instructions, validation and the report (`src/core/host.mjs`).
- **Codex plugin** (`.codex-plugin/`, `.agents/plugins/`): same skill and MCP server; Codex runs
  the tasks in sequence.

## Research flow

snapshot (code, parallel, seconds) → deep: 4 desks in parallel (`business`, `street`, `news`,
`risk`) → bull and bear in parallel → portfolio-manager decision; fast: 1 desk (`all`) →
decision. Prompts live in `src/core/prompts.mjs`, schemas in `src/core/schemas.mjs`.

## Rules

- Every model output has a JSON schema; code then normalizes it (`src/core/normalize.mjs`):
  unknown citations are removed, dates fixed, valuation ordered — with a warning, not a retry.
- The report (`src/core/report.mjs`) is assembled by code from the saved packets.
- Terminal states: `complete`, `degraded` (finished with a failed task), `incomplete` (no
  decision). Never present degraded or incomplete as complete. Never fill missing data from memory.
- The MCP server and everything it imports must stay dependency-free: plugins run from a git
  checkout without `npm install`. Only `src/backends/api.mjs` may import `@anthropic-ai/sdk`.
- Run artifacts go to `~/.alphacouncil/` (`ALPHA_HOME`); never commit them.
- After changes: `npm test` (no network; uses fixtures, a fake backend and a fake `claude`).
