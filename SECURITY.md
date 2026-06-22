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
- This software is for educational/research use only and is **not investment
  advice** (see the README disclaimer).

## Supported versions

This project is pre-1.0. Only the latest `main` is supported.
