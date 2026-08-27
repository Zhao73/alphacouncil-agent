# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report
privately via GitHub's **"Report a vulnerability"** button under the repository's
**Security** tab (Security advisories), or contact the maintainer directly.

We aim to acknowledge reports within a few days.

## Scope and notes

AlphaCouncil Agent runs an autonomous research workflow. Be aware that:

- The headless path spawns `codex exec` worker processes that perform **live web
  search**. Treat fetched content as untrusted; the agents are instructed not to
  act on embedded instructions, but you should review outputs before relying on
  them.
- Run artifacts under `~/.alphacouncil-agent/runs/<run_id>/` may contain text
  captured from third-party pages. These are **not** committed (ignored by
  `.gitignore`) — mind what you share.
- Never commit API keys, tokens, brokerage credentials, or private filings.
- `preflight_permissions` reads the host's own configuration files
  (`~/.claude/settings.json`, `~/.claude/settings.local.json`, OpenCode config)
  **read-only**, to detect whether background agents would silently lose web
  search and degrade into unsourced reports. Nothing is written and nothing
  leaves the machine.
- Worker subprocesses are launched sandboxed: `codex exec` runs with
  `-s read-only -a never --ephemeral --ignore-user-config`, so an analyst
  worker cannot write to disk, auto-approve actions, or recursively load the
  user's own MCP configuration. Optional model/reasoning overrides are passed as
  validated argv values, never through a shell, and are recorded in run artifacts.
- This software is for educational/research use only and is **not investment
  advice** (see the README disclaimer).

## Supported versions

Only the latest published release (npm `latest`) and the current `main` branch
are supported. Older versions receive no fixes.
