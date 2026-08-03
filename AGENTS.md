# Agent Instructions

Read `CLAUDE.md` first. It defines the workflow, analyst roles, final-report requirements, evidence contract and repository boundaries.

For report-generation behavior, also follow `docs/report-contract.md`. The chat handoff may be concise, but the saved report and artifact files must preserve the full evidence chain.

For anti-laziness governance, also follow `skills/agent-skills-governance/SKILL.md`. It is bundled with the plugin so installed agents inherit the same gates without separately installing `addyosmani/agent-skills`.

For methodology comparisons or Skill experiments, also follow
`skills/alphacouncil-method-lenses/SKILL.md`. Its 26 on-demand references are provisional
explanation material and never replace a frozen deterministic PersonaPack result.

Run `npm run check` after any code or prompt change.

## Current Release Boundary

Package/plugin version `1.1.7` is the GitHub/Codex marketplace release line; npm's public
`latest` tag must be verified separately before claiming it matches this source. The current source tree carries 26 physical
PersonaPack v3 packs, 26 `operator_lens` seats and 52 executable method tools, with 0 validated
`method_model` seats. Human review of the authored formulas and the live four-host
end-to-end run are outstanding, so do not present a passing full/quick report or a packaged
smoke as evidence that either has been done.

## Council Modes

`full` is the default and uses the `full_v2` contract. It requires all eight mandatory
evidence roles, every selected method, the three-round Bull/Bear cross-exam and PM. If any
mandatory evidence role still fails after its one bounded parse-only repair, persist the
failure/diagnostic artifacts, skip method/debate/PM model calls and terminate `incomplete`
before downstream synthesis. Never auto-downgrade that run to quick.

Plugin-managed headless full runs launched with `analyze_symbol` use the selected pace's hard
queue-to-terminal-persistence ceiling: 15 minutes for fast, 30 for normal, and 60 for slow. The eight mandatory evidence workers
start in one parallel wave. Each selected v3 method first produces a deterministic, frozen
stance and then gets one isolated voice worker that may explain, but never change, that
stance. Bull and Bear run in parallel within each of the three rounds, with a hard barrier
between rounds, followed by the PM. Retries, queueing and persistence consume the same
deadline; callers and environment variables may lower it, never raise it. At expiry, persist
a terminal fail-closed `incomplete` run and name every missing/skipped seat. The clock
guarantees terminal persistence, not successful completion when data providers, search or
model transport deteriorates.

This 30-minute enforcement belongs only to plugin-managed headless `analyze_symbol`. A
visible-host full run is scheduled by the external host, so the plugin cannot force-stop its
subagents or promise the same deadline. It still returns one post-evidence explanation
worker per non-blocked selected physical v3 seat, including deterministic `out_of_scope`
seats, and the PM waits for every returned worker. Do not advertise a visible run as
SLA-bound.

`quick` is explicit and uses `quick_v1`. It can run only through plugin-managed headless
`analyze_symbol`; `plan_visible_run` rejects it. Quick launches the fixed four evidence roles
`market_data`, `earnings_deep_dive`, `valuation_long_short`, and
`news_industry_management` in parallel; 1-4 selected methods in parallel; one Bull and one
Bear statement in parallel; then one short PM. It has no rebuttal/Q&A rounds and no
adversarial `source_fidelity`/`rederivation`/`refuter` fan-out.

Quick company/industry news must be dated within the 120 days ending at `as_of`. Future,
undated and older items are gaps, not recent news. Its hard queue-to-persistence ceiling is
600000 ms: grounding wait 20s; each evidence worker 210s; each selected-method worker 90s;
Bull and Bear 90s per side; PM 90s; final assembly/persistence reserve 20s. Retry time is
inside the same caps. The ceiling may be lowered, never raised.

Quick may terminate `degraded` only under its documented minimum-coverage rule and one
system-owned idempotent degraded ledger. `report_quality=passed` validates `quick_v1`
structure only; it does not turn degraded into complete or imply full-council equivalence.
Method-seat output is a recorded provisional lens result, never a quotation from the named
person.

Classify the instrument before choosing evidence routes. Operating companies may use SEC
Company Facts or local structured issuer financials; ETFs and mutual funds use
`fund_lookthrough`; cash indices use `index_aggregate`. Fund/index work must cover dated
holdings or constituents and weights, methodology, concentration, fee or index rules,
liquidity/tracking/flows and same-date aggregate valuation with disclosed coverage. Never
create fund/index revenue, company EPS, management guidance, fund-insider Form 4 activity or
portfolio financials made by adding a few constituents. Company-style data routes must be
recorded as not applicable for funds and indices, not as research failures.

Every terminal full handoff must show a system-owned price snapshot (price, currency,
timestamp and source when available, otherwise an explicit unavailable-data record), every
selected stable master ID with its frozen stance and readable explanation/status, and all
eight mandatory analyst statuses and summaries. The handoff's machine-gated final section
carries the exact selected-seat count and each complete, untruncated statement; a failed seat
appears as a non-directional `statement_status=not_produced` diagnostic. Visible PM completion
and `finalize_visible_run` return `handoff_contract=inline_user_response_v1`; deliver their
`user_response_markdown` instead of an ACK-only or manual recap, and append nothing after the
method-seat ledger. System-owned report/handoff prose is localized for `zh-CN`, `en`, `ja`
and `ko`; workers receive the run language. Never present a method-seat explanation as the
real person's current words, quote or endorsement.

## Hosts

The MCP server is the load-bearing integration on every host: it reads `personas/` directly,
so a host that ignores the generated agent files still gets correct prompts.

Every host also follows the same mandatory master-selection protocol for a full or quick
council. Call `begin_council_selection` with the intended `council_mode`, display every
returned entry with number, identity, method and `best_for`, collect one submission, then
call `confirm_master_selection` with `display_ack: true`. Full accepts numbers, ranges,
stable IDs or `all`; quick accepts exactly 1-4 distinct methods and rejects `all` and
`select_all`. Existing names in the request are only a prefill; the full catalog is still
shown. Only the returned one-use, mode-bound `selection_receipt`, reused with the same
symbol, prompt, language and mode, may authorize the applicable execution tool. A full
receipt cannot launch quick and a quick receipt cannot launch full. A host-native
multi-select is optional UI sugar; the numbered text fallback is mandatory on Claude Code,
Codex, OpenCode and Grok Build. Data-only `screen`, `options`, `news` and `market` modes are
the only `/alpha` routes that skip this gate.

| Host | Config | Agents | Skills |
|---|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | `.claude/agents/alphacouncil-*.md` | `skills/` via the plugin manifest |
| Codex | `.codex-plugin/plugin.json`, `codex.mcp.json` | — | `skills/` via the plugin manifest |
| OpenCode | `opencode.json` | `.opencode/agent/alphacouncil-*.md` | see the caveat below |
| Grok Build | `.grok/config.toml` | `.grok/agents/alphacouncil-*.md` | `AGENTS.md` (this file) |

### OpenCode

Verified against a real opencode 1.18.4 install rather than from documentation:

- `opencode mcp list` shows `alphacouncil-agent connected`. The MCP entry must use
  OpenCode's shape — `{"type":"local","command":["node","./mcp/server.mjs"]}` — a single
  argv array. Copying Claude Code's `{command, args}` produces a server that never starts,
  and the env key is `environment`, not `env`.
- `opencode debug agent alphacouncil-<role>` parses the generated agent files, resolves
  `anthropic/claude-…` into a provider and model, and applies their permissions.
  OpenCode does **not** natively read `.claude/agents/` or `.claude/settings.json`. Some
  compatibility plugins auto-import a root `.mcp.json`, so this repository deliberately
  keeps Codex wiring in `codex.mcp.json` to avoid a duplicate, cwd-sensitive server.
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

### Grok Build

Verified against a real install (grok 0.2.101) rather than from documentation:

- MCP lives in `.grok/config.toml` as TOML, not JSON:
  `[mcp_servers.alphacouncil-agent]` with `command`, `args` and `enabled`. Generate it with
  `grok mcp add alphacouncil-agent -s project -t stdio node -- ./mcp/server.mjs` rather than
  hand-writing it. AlphaCouncil does not ship a root `.mcp.json`; this prevents third-party
  compatibility loaders from importing a second cwd-sensitive server.
- **A repo-local server will not start until the folder is trusted.** `grok mcp doctor`
  reports `folder untrusted (repo-local (project-scoped) server not started)`. That is a
  security prompt, not a misconfiguration: trust the folder on first launch.
- `AGENTS.md` is the project system prompt, which is why the generated agents set
  `agents_md: true` and inherit it.
- Agent definitions are `.md` with `name` / `description` frontmatter in `.grok/agents/`.
  Every generated seat uses `permission_mode: plan`, matching the bundled read-only
  `explore` agent: the council gathers and reasons, it never edits the repo.
- Skills resolve from `.grok/skills/` and `.claude/skills/`. This repo ships neither, so on
  Grok Build the workflow arrives through `AGENTS.md` plus the MCP tools, the same shape
  that works on OpenCode.

## Slash commands

**One command, `/alpha`.** Modes are arguments, so there is one name to remember
rather than four in a menu of a hundred.

| Invocation | What runs | Model spend |
|---|---|---|
| `/alpha <ticker>` | Shows every master, confirms `1..N`/ranges/`all`, then runs full; plugin-managed headless is ≤30m | deterministic stance + one isolated voice worker per selected v3 seat |
| `/alpha <ticker> quick` | Shows the complete returned catalog, confirms 1-4 (no `all`), then plugin-managed `quick_v1` (≤10m) | varies with selection |
| `/alpha <ticker> screen` | Mechanical filings screen only | **none** |
| `/alpha <ticker> options` | IV term structure, skew, positioning | **none** |
| `/alpha <ticker> news` | Dated filings and headlines | **none** |
| `/alpha market <theme>` | What the market is talking about | **none** |
| `/alpha` | Lists the modes and stops | **none** |

The four marked **none** call keyless data tools and spawn no subagents, so they cost
nothing beyond the turn you type them in. Full and quick are council modes: both require a
fresh mode-bound selection receipt. Quick must poll the single durable `run_id` returned by
`analyze_symbol(wait_for_completion=false)` through `read_run`; never emulate quick with
visible agents or create a replacement run when it is slow.

| Host | Where it reads them |
|---|---|
| Claude Code | `commands/` via `.claude-plugin/plugin.json`, plus `.claude/commands/` for a checkout |
| OpenCode | `.opencode/command/` |
| Grok Build | `.grok/commands/`, and `.claude/commands/` as a high-priority compatibility source |
| Codex | `~/.codex/prompts/` is **user-scoped**: `mkdir -p ~/.codex/prompts && cp commands/alpha.md ~/.codex/prompts/` |

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
