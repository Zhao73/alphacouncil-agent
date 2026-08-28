# ChatGPT Work developer gateway

This package adds a local Streamable HTTP `/mcp` endpoint without changing the
dependency-free stdio runtime used by Codex, Claude Code, OpenCode, and Grok Build.

It exposes 26 chat-safe tools. That count is the Work tool surface, not the 26
provisional method seats. The method-seat catalog is returned by
`begin_council_selection` and must be shown and confirmed for every research run.

## Local protocol test

The gateway requires Node.js 18.14.1 or newer.

```sh
npm ci --prefix work
npm test --prefix work
npm start --prefix work
```

The default endpoint is `http://127.0.0.1:8787/mcp`. Real council work must call
`analyze_symbol` without `wait_for_completion=true`; it returns a durable `run_id`
and ChatGPT polls `read_run` until terminal. This prevents a long council from
holding one HTTP tool call open.

The live-tested path reuses the owner's file-backed ChatGPT login. Headless workers share one
`CODEX_HOME`, so OAuth refresh state is never copied or forked; this is not a claim of strict
refresh locking. File-backed static API-key login and environment API credentials use the same
shared or inherited path but need their own host smoke; keyring-backed login is not yet
certified with `--ignore-user-config`. Every worker receives a temporary `HOME`/`USERPROFILE`;
plugins, apps, nested agents, tool suggestions, and non-system Skills under the shared Codex
home are disabled for the child invocation. The temporary user home is removed after normal
settlement; a failed removal is reported and retried on a late child close. This is local
single-owner worker isolation, not user authentication or tenant isolation for a public service.

## Temporary ChatGPT developer-mode test

For a short-lived local test, expose the localhost endpoint through a secure MCP
tunnel or a temporary HTTPS tunnel. If Cloudflare Quick Tunnel is used, preserve
localhost Host validation:

```sh
cloudflared tunnel --url http://127.0.0.1:8787 --http-host-header localhost
```

Register the resulting `https://.../mcp` endpoint only in ChatGPT developer mode,
run the end-to-end checks, and stop the tunnel immediately afterward. A random
temporary URL is not authentication and is not suitable for publication.

Public or multi-user hosting remains blocked until the service has OAuth 2.1/PKCE,
tenant-separated storage and credentials, quotas/cost controls, stable HTTPS, and
an operational rollback path. The local gateway uses the owner's local Codex login
and filesystem; it must never be advertised as a public multi-tenant service.
