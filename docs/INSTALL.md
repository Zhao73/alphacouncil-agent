# Install AlphaCouncil Agent

AlphaCouncil Agent runs in **OpenAI Codex** and **Claude Code**. It also loads as a
plain MCP server in the Claude desktop app.

> ⚠️ **Disclaimer.** Educational/research use only. **Not investment advice.**
> AI analysis can be incomplete, outdated, or wrong. Do your own research and
> consult a licensed professional before any investment decision.

---

## Prerequisites

- **Node.js ≥ 18** (the MCP server is ESM and uses modern Node APIs).
- For the **headless research path** (`analyze_symbol` / `collect_evidence`):
  an installed and authenticated **Codex CLI**, because each analyst worker is
  launched as `codex exec`. Without it, headless workers fail; use the
  **visible workflow** instead (the host agent does the research and records
  packets — no `codex` binary required).

Verify:

```bash
node --version      # >= 18
codex --version     # only needed for the headless path
npm run check       # runs the self-check (no Codex auth required)
```

---

## Install in Codex

> Note: OpenAI's public Plugin Directory self-publishing is still rolling out.
> Until then, use one of these:

**A. Add this GitHub repo as a marketplace (newer Codex versions):**

```text
codex plugin marketplace add Zhao73/alphacouncil-agent
codex
/plugins            # switch to the "AlphaCouncil" marketplace → Install
/reload-plugins
```

**B. Local / personal marketplace (works on any Codex version):**

```bash
git clone https://github.com/Zhao73/alphacouncil-agent.git \
  ~/.codex/plugins/alphacouncil-agent
```

Then add an entry to `~/.agents/plugins/marketplace.json` whose `source.path`
points at that folder (see `.agents/plugins/marketplace.json` in this repo for
the shape), restart Codex, and install from `/plugins`.

**Use it:**

```text
@alphacouncil-agent analyze NVDA as a long/short pitch
@alphacouncil-agent 帮我看看 NOK
```

---

## Install in Claude Code

This repo ships a Claude Code plugin manifest (`.claude-plugin/plugin.json`) and
acts as its own marketplace (`.claude-plugin/marketplace.json`).

```text
/plugin marketplace add Zhao73/alphacouncil-agent
/plugin install alphacouncil-agent@alphacouncil
/reload-plugins
```

Or wire just the MCP server, without the plugin system:

```bash
claude mcp add alphacouncil-agent -- node /absolute/path/to/alphacouncil-agent/mcp/server.mjs
```

**Two ways to actually run the research in Claude Code:**

1. **With Codex CLI installed & authenticated** — the headless `analyze_symbol`
   path works as-is (it shells out to `codex exec`).
2. **Without Codex** — use the visible path: let Claude Code's own subagents act
   as the analysts, then record their JSON with `record_visible_packet` /
   `record_visible_decision`. The MCP tools `plan_visible_run` /
   `record_visible_*` never call `codex`, so this runs fully inside Claude.

---

## Claude desktop app (MCP only)

Add the MCP server in the app's connector/MCP settings, pointing `command` to
`node` and `args` to the absolute path of `mcp/server.mjs`. Tools will load; the
headless path still needs Codex CLI as above.

---

## Windows

### Prerequisites (Windows)

- **Node.js ≥ 18** — install from [nodejs.org](https://nodejs.org), or in PowerShell:
  `winget install OpenJS.NodeJS.LTS`. Verify with `node --version`.
- (Headless path only) the Codex CLI plus **WSL** — see the runtime caveat below.

### Install in Codex desktop (Windows)

The in-app commands are identical to macOS/Linux — they run **inside Codex**, not in your
shell, so the OS does not matter:

```text
codex plugin marketplace add Zhao73/alphacouncil-agent
# then open Codex → /plugins → switch to the "AlphaCouncil" marketplace → Install → /reload-plugins
```

Local / personal marketplace (Windows paths). In PowerShell:

```powershell
git clone https://github.com/Zhao73/alphacouncil-agent.git "$env:USERPROFILE\.codex\plugins\alphacouncil-agent"
```

Then add an entry to `%USERPROFILE%\.agents\plugins\marketplace.json` whose `source.path`
points at that folder (copy the shape from `.agents/plugins/marketplace.json` in this repo).
In JSON, escape Windows backslashes, e.g.:

```json
{ "source": { "path": "C:\\Users\\you\\.codex\\plugins\\alphacouncil-agent" } }
```

Restart Codex and install from `/plugins`.

### Install in Claude Code (Windows)

Identical to other platforms (the commands run inside Claude Code):

```text
/plugin marketplace add Zhao73/alphacouncil-agent
/plugin install alphacouncil-agent@alphacouncil
/reload-plugins
```

The Claude Code **visible path works natively on Windows** — it never spawns the `codex`
binary; your Claude Code subagents do the research and record packets via
`record_visible_*`. **This is the recommended Windows path.**

### Runtime caveat (Windows)

The **headless Codex path** (`analyze_symbol` / `collect_evidence`, which launch `codex exec`
workers) is **not reliable on native Windows**: the npm-installed `codex` is a `.cmd`/shell
shim that Node's `spawn` cannot launch directly, and routing the large analyst prompts through
a shell would corrupt special characters. For full headless research on Windows, use either:

- **WSL** (Windows Subsystem for Linux) — run Codex + the plugin inside WSL, where it behaves
  exactly like Linux; or
- the **Claude Code visible path** above (no `codex` binary required).

Everything else is cross-platform: data lives under `%USERPROFILE%\.alphacouncil-agent\`
(via `os.homedir()`), paths use `path.join`, and the MCP wiring is plain `node`.

---

## 中文速览

- 前置:Node ≥ 18;headless 真跑研究需要已登录的 Codex CLI(worker 是 `codex exec`)。
- Codex 安装:`codex plugin marketplace add Zhao73/alphacouncil-agent` → `/plugins` 安装 → `/reload-plugins`;或 clone 到 `~/.codex/plugins/` 走本地 marketplace。
- Claude Code 安装:`/plugin marketplace add Zhao73/alphacouncil-agent` → `/plugin install alphacouncil-agent@alphacouncil` → `/reload-plugins`。
- 没有 Codex CLI 时:用 visible 工作流,让 Claude 子代理产出证据并用 `record_visible_*` 录入,无需 codex。

---

## 日本語クイックガイド

- 前提:Node ≥ 18。headless でリサーチを実走させるには、認証済みの Codex CLI が必要(worker は `codex exec`)。
- Codex でのインストール:`codex plugin marketplace add Zhao73/alphacouncil-agent` → `/plugins` でインストール → `/reload-plugins`。または `~/.codex/plugins/` に clone してローカル marketplace 経由でも可。
- Claude Code でのインストール:`/plugin marketplace add Zhao73/alphacouncil-agent` → `/plugin install alphacouncil-agent@alphacouncil` → `/reload-plugins`。
- Codex CLI が無い場合:visible ワークフローを使用。Claude のサブエージェントに根拠を生成させ、`record_visible_*` で記録する(codex 不要)。
