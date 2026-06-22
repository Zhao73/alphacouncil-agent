# Contributing to AlphaCouncil Agent

Thanks for your interest in improving AlphaCouncil Agent!

## Development setup

```bash
git clone https://github.com/Zhao73/alphacouncil-agent.git
cd alphacouncil-agent
node --version      # must be >= 18
npm run check       # runs node --check + the self-check (no Codex auth needed)
```

There are **no runtime dependencies** — the MCP server is plain Node.js standard
library. Please keep it that way unless there is no simple standard-library path.

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
