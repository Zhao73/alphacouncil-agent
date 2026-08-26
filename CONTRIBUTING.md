# Contributing to AlphaCouncil Agent

Thanks for your interest in improving AlphaCouncil Agent!

## Development setup

```bash
git clone https://github.com/Zhao73/alphacouncil-agent.git
cd alphacouncil-agent
node --version      # must be >= 18
npm ci              # development-only schema/property-test tools
npm run check       # runs node --check + the self-check (no Codex auth needed)
```

There are **no runtime dependencies** — the MCP server is plain Node.js standard
library. Ajv, fast-check and jsonrepair are development-only: the committed standalone
validators and bounded local parser run without `node_modules`, including direct Codex
marketplace installs. Please keep the runtime dependency-free unless there is no simple
standard-library path.

## Where to start

Pick one small, offline change. Add the failing test first, make the smallest fix, and
avoid unrelated runtime changes.

| Area | Start here | Bounded first change |
|---|---|---|
| Feed parsing and recency | `mcp/lib/feeds.mjs`: `parseFeed`, `applyRecencyGate`; `test/unit/feeds.test.mjs` | Add one RSS/Atom or date-boundary fixture; do not add a network call. |
| Quote parsing | `mcp/lib/quotes.mjs`: `parseYahooChart`, `parseStooqCsv`; `test/unit/quotes.test.mjs` | Add one provider-response edge fixture; do not add a live fetch. |
| Reader-language checks | `mcp/lib/lang.mjs`: `readerLanguageStatus`; `test/unit/lang.test.mjs` | Add one Unicode or mixed-finance-terms fixture; do not weaken the threshold. |
| Markdown tables | `mcp/lib/tables.mjs`: `table`, `metricValue`; `test/unit/markets.test.mjs` | Add one Markdown-escaping or numeric-format fixture; do not change report contracts. |

## Before opening a pull request

- Run `npm run check` and make sure it passes.
- Preserve the JSON packet contracts in `mcp/server.mjs` (evidence packets and
  debate packets). If you change a contract, update `scripts/selfcheck.mjs` and
  the README/skill docs to match.
- Keep source IDs globally scoped as `<task>:<local_source_id>`.
- Keep the implementation small and readable.

## Scope and boundaries

- This is an **independent** plugin. Do not copy source code from other
  multi-agent investment projects into this repo.
- "Public Equity Investing" and "Investment Banking" are agent instructions /
  skills, not importable libraries.
- Never commit API keys, brokerage credentials, private filings, or generated
  run artifacts (everything under `~/.alphacouncil-agent/` and `runs/` is
  ignored by `.gitignore`).

## Reporting bugs / requesting features

Use the issue templates. Please include your OS, Node version, and whether you
were using the Codex headless path or the visible workflow.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).

## Commit messages

Prefer writing the message to a file and passing it to Git:

```bash
git commit -F /path/to/message.txt
```

If a heredoc is more convenient, quote its delimiter. Never interpolate a message
containing backticks or variables into a shell command string.

```bash
git commit -F - <<'MSG'
...
MSG
```

Before pushing, inspect the stored message with `git show -s --format=%B HEAD`. Do not
amend a published or tagged commit; use `git notes add` or a follow-up commit instead.
