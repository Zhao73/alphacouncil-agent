# Agent Instructions

Read `CLAUDE.md` first. It defines the workflow, analyst roles, final-report requirements, evidence contract and repository boundaries.

For report-generation behavior, also follow `docs/report-contract.md`. The chat handoff may be concise, but the saved report and artifact files must preserve the full evidence chain.

For anti-laziness governance, also follow `skills/agent-skills-governance/SKILL.md`. It is bundled with the plugin so installed agents inherit the same gates without separately installing `addyosmani/agent-skills`.

Run `npm run check` after any code or prompt change.

## Hosts

The MCP server is the load-bearing integration on every host: it reads `personas/` directly,
so a host that ignores the generated agent files still gets correct prompts.

| Host | Config | Agents | Skills |
|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json`, `.mcp.json` | `.claude/agents/alphacouncil-*.md` | `skills/` via the plugin manifest |
| Codex | `.codex-plugin/plugin.json`, `.mcp.json` | — | `skills/` via the plugin manifest |
| OpenCode | `opencode.json` | `.opencode/agent/alphacouncil-*.md` | see the caveat below |

### OpenCode

Verified against a real opencode 1.18.4 install rather than from documentation:

- `opencode mcp list` shows `alphacouncil-agent connected`. The MCP entry must use
  OpenCode's shape — `{"type":"local","command":["node","./mcp/server.mjs"]}` — a single
  argv array. Copying Claude Code's `{command, args}` produces a server that never starts,
  and the env key is `environment`, not `env`.
- `opencode debug agent alphacouncil-<role>` parses the generated agent files, resolves
  `anthropic/claude-…` into a provider and model, and applies their permissions.
  OpenCode does **not** read `.claude/agents/`, `.mcp.json` or `.claude/settings.json`.
- `opencode.json` deliberately declares **no** global `permission` block. A global block is
  merged into every agent and overrides the per-agent one, which silently hands the debate
  roles the network access they are specifically denied. Verified both ways: with the block,
  `bull_researcher` resolved to `websearch: allow`; without it, `deny`.
- Per-agent permissions come from each persona's `tools_hint`, so only the roles that
  actually gather evidence get the network, and no role can edit files or run shell commands.

**Skills:** opencode 1.18.4 serves `debug skill` from a static catalogue -- a skill added
at runtime never appears, in any location, including `~/.claude/skills` and with a clean
`OPENCODE_CONFIG_DIR`. Tested both with and without third-party plugins. So the workflow
does not ship as skills on OpenCode; it ships through `instructions`, which IS resolved:
`opencode debug config` shows all four workflow files loaded alongside `AGENTS.md`. The
MCP tools and `.opencode/agent/*.md` carry the rest.

`websearch` is gated in OpenCode — it needs the OpenCode provider or `OPENCODE_ENABLE_EXA=1`.
Run `preflight_permissions` before a fan-out; it reads OpenCode's permission syntax too.

## Market data coverage

Structured financials come from each market's own regulator, and the pipeline degrades in
a stated order rather than quietly becoming US-only.

| Market | Regulator | Key needed | What you get |
|---|---|---|---|
| US | SEC EDGAR | none | Full XBRL history with filing dates |
| Taiwan | TWSE OpenAPI | none | Quarterly income-statement summary |
| Korea | DART | `ALPHACOUNCIL_DART_KEY` | Full statements |
| Japan | EDINET v2 | `ALPHACOUNCIL_EDINET_KEY` | Filing index; documents are XBRL in a ZIP |
| Hong Kong, China A | HKEXnews, cninfo | n/a | No machine-readable API; PDFs only |

Both keys are free. Register at <https://opendart.fss.or.kr> and at the EDINET portal,
then export them. Nothing breaks without them: `market_coverage` reports which symbols
have no feed, and the grounding block tells analysts that any financial figure for those
names must come from a primary document they actually read and be cited as such.

Korea indexes by DART's 8-digit `corp_code`, which is not the ticker -- Samsung
Electronics is `00126380`, SK hynix `00164779`. Japan uses a 5-digit `secCode`, so
`285A.T` becomes `285A0`.

Call `market_coverage` before building a report across markets. Without it a memory-industry
report quietly becomes a Micron report, because Micron is the participant whose numbers
were easy to fetch.
