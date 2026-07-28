# Install AlphaCouncil Agent

AlphaCouncil Agent runs in **OpenAI Codex** and **Claude Code**. It also loads as a
plain MCP server in the Claude desktop app.

> ⚠️ **Disclaimer.** Educational/research use only. **Not investment advice.**
> AI analysis can be incomplete, outdated, or wrong. Do your own research and
> consult a licensed professional before any investment decision.

---


## GitHub v0.9.5 preview

This acceptance release is GitHub-only:

```bash
npm install -g github:Zhao73/alphacouncil-agent#v0.9.5
```

## npm channel

```bash
npm install -g alphacouncil-agent@next
```

The GitHub-only 0.9.5 source upgrade does not run `npm publish` or change npm dist-tags.
`alphacouncil-agent@next` installs whichever preview npm currently serves; verify it with
`npm view alphacouncil-agent dist-tags --json` rather than assuming it is 0.9.5. The
unqualified package follows the stable `latest` tag.

Then point any MCP host at the `alphacouncil-agent` binary. For Claude Code:

```json
{ "mcpServers": { "alphacouncil-agent": { "command": "alphacouncil-agent" } } }
```

For OpenCode, `command` takes an argv array:

```json
{ "mcp": { "alphacouncil-agent": { "type": "local", "command": ["alphacouncil-agent"] } } }
```

Or run it without installing: `npx alphacouncil-agent`.

## Configuration: none required

There is nothing to configure. Every core data source is keyless — SEC EDGAR for US
filings, TWSE for Taiwan, Yahoo and Stooq for quotes and macro — and the package has no
dependencies, so the install is the download and nothing else.

Two optional free keys widen coverage. Without them the tools still answer; they report
which market is missing a feed and which variable would unlock it, and analysts are told
that figures for those names must come from a primary document and be cited as such.

| Variable | Unlocks | Register |
|---|---|---|
| `ALPHACOUNCIL_DART_KEY` | Korean filings (Samsung, SK hynix) | <https://opendart.fss.or.kr> |
| `ALPHACOUNCIL_EDINET_KEY` | Japanese filings (Kioxia, Tokyo Electron) | EDINET portal |
| `ALPHACOUNCIL_SEC_USER_AGENT` | Your own SEC contact, advisable at volume | n/a |

Run `node scripts/doctor.mjs` at any time to see which copy is running, whether the
persona set loads, and what the data directory holds.

## How to invoke it once installed

One command, `/alpha`. Modes are arguments.

```text
/alpha <ticker>              full council — displays all methods; headless run is bounded <=30m
/alpha <ticker> quick        quick_v1 — 4 analysts incl. news + 1-4 methods + one parallel debate round (<=10m)
/alpha <ticker> screen       mechanical filings screen only        (no model spend)
/alpha <ticker> options      IV term structure, skew, positioning  (no model spend)
/alpha <ticker> news         dated filings and headlines           (no model spend)
/alpha market <theme>       what the market is talking about      (no model spend)
/alpha                 lists the modes and stops             (no model spend)
```

The four marked *no model spend* call keyless data tools and spawn no subagents. **Start
there** — they show real data at no cost, so you can see the shape of the thing before
committing a fan-out. Full and quick both require a fresh method selection receipt. Model
spend is not a fixed seat count. In plugin-managed headless mode every selected v3 seat runs
its deterministic policy (which may return `out_of_scope`) and then one isolated voice
worker explains that frozen result; evidence and debate seats are also model workers. The
voice is a recorded provisional method result, not the named person's words.

### What full headless means

Full remains `full_v2`. When launched through plugin-managed headless
`analyze_symbol(council_mode="full")`, it has a hard maximum of 1800000 ms from durable
queueing through terminal artifact persistence:

- all eight mandatory evidence workers start in one parallel wave;
- after the fail-closed evidence barrier, each selected physical v3 method freezes its
  deterministic stance and gets one isolated voice worker that cannot alter it;
- Bull and Bear start in parallel within each of three rounds, with a barrier between rounds
  and exact Round-2-question to Round-3-answer binding;
- the PM and deterministic report persistence use the same global clock.

Callers and `ALPHACOUNCIL_FULL_TOTAL_MS` may lower the deadline, never raise it. At expiry
the server saves a terminal `incomplete` run naming failed/timed-out/skipped seats. The
30-minute bound guarantees terminal persistence, not complete results when search, model
transport or data providers are unavailable. `plan_visible_run` has no such enforceable
deadline because the external host owns and schedules its subagents.

A full `user_response.md` lists all eight analyst statuses and summaries, every selected
stable master ID with its stance and isolated-worker output/status, and a system-owned price
snapshot with currency/time/source or an explicit quote-data gap. System-owned labels are
localized for Chinese (`zh-CN`), English, Japanese and Korean, and worker prompts carry the
run language.

### What `quick` means

`quick` is a first-class `quick_v1` contract and remains opt-in; a ticker with no mode still
runs full. It is managed by the plugin's headless `analyze_symbol` path so the MCP server can
enforce a wall-clock deadline. `plan_visible_run` rejects `council_mode=quick` rather than
pretending an external host Task can be force-stopped by the plugin.

- Stage 0 still displays the complete 26-seat catalog, but quick accepts exactly 1-4 selected
  methods and forbids `all` / `select_all`.
- The receipt is bound to symbol, prompt, language and `council_mode`; it cannot be reused
  across quick and full.
- Four fixed evidence workers start in parallel: `market_data`, `earnings_deep_dive`,
  `valuation_long_short`, and `news_industry_management`. A caller cannot override this list.
- Recent news means dated company and industry developments from the 120 days ending at
  `as_of`; future, undated and older sources are excluded from the recent-news handoff.
- Up to four method workers run in parallel, followed by one parallel bull/bear statement
  round and one short PM. There is no round-2 rebuttal, round-3 Q&A or adversarial verifier
  fan-out. Scoped source-ID presence is still checked.
- The saved report is checked against `quick_v1`, not the full `full_v2` report, and is
  explicitly marked `full_council_equivalent: false`.

The public end-to-end ceiling is 600000 ms. It starts when the durable run is queued and
includes all work: grounding (maximum 20 seconds), evidence (210 seconds per worker), up to
four masters in parallel (90 seconds each), parallel bull and bear (90 seconds each), the
short PM (90 seconds), retry time, and a 20-second finalization reserve. `total_timeout_ms`
and `ALPHACOUNCIL_QUICK_TOTAL_MS` may lower this ceiling; neither can raise it. The ceiling
limits runtime, not uncertainty: a run can terminate `degraded` or `incomplete` rather than
invent evidence to meet the clock.

Headless quick returns a durable `run_id` immediately by default. Poll that same run with
`read_run` until one of these terminal statuses appears:

```text
complete | degraded | incomplete | needs_verification | needs_revision | failed
```

`degraded` is quick-only evidence/debate coverage, not an alias for complete. The report and
handoff retain a system-owned ledger naming every degraded task or debate side and its cause.
`report_quality=passed` only means the mode-appropriate report structure passed; it does not
upgrade a degraded run or make quick equivalent to full.

Codex keeps prompts user-scoped rather than in the plugin, so copy it once:

```bash
mkdir -p ~/.codex/prompts && cp commands/alpha.md ~/.codex/prompts/
```

`@alphacouncil-agent <question>` still works everywhere and does the same thing.

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

This repo already ships the manifests Codex expects, at the official paths:
`.agents/plugins/marketplace.json` (repo marketplace), `.codex-plugin/plugin.json`
(plugin manifest), and `codex.mcp.json` (Codex-only MCP server wiring) — so the one-command install below
works out of the box. (`.claude-plugin/marketplace.json` is kept for legacy compat.)

### A. One command — recommended ✅

```text
codex plugin marketplace add Zhao73/alphacouncil-agent
```

Then **fully quit and restart the Codex desktop app** (plugins load at session
start — see [Troubleshooting](#troubleshooting-the-plugin-doesnt-show-up--alphacouncil-agent-isnt-found)),
open a new session, and:

```text
/plugins            # switch to the "AlphaCouncil" marketplace → Install alphacouncil-agent
/reload-plugins
```

### B. Local clone — advanced / offline only

```bash
git clone https://github.com/Zhao73/alphacouncil-agent.git \
  ~/.codex/plugins/alphacouncil-agent
```

Then add an entry to `~/.agents/plugins/marketplace.json` whose `source.path` is the
**absolute** path to that clone (copy the shape from `.agents/plugins/marketplace.json`
in this repo; on Windows use `C:\\Users\\you\\.codex\\plugins\\alphacouncil-agent`, not
`./`), restart Codex, and install from `/plugins`. **Prefer A** unless you're doing
offline/local development — it avoids hand-editing paths.

**Use it:**

```text
@alphacouncil-agent analyze AAPL as a long/short pitch
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

## Troubleshooting: the plugin doesn't show up / `@alphacouncil-agent` isn't found

Codex loads its tool list **at session start**. Installing or enabling a plugin
mid-session does **not** hot-add it to the current conversation — even if the files
are installed, `config.toml` marks it enabled, and the self-check passes.

Do this in order:

1. **Fully quit and restart the Codex desktop app** (not just a new tab) and open a **new session**.
2. Type `/plugins` and confirm **AlphaCouncil** is listed; enable `alphacouncil-agent`.
3. Type `/reload-plugins`.
4. Trigger it with the **exact lowercase id**: `@alphacouncil-agent ...`. The display
   name `@AlphaCouncil Agent` (spaces + capitals) may not trigger — prefer the id.

If `/plugins` **still** doesn't list it after a full restart, your Codex build didn't
pick up the local marketplace. Use the official GitHub marketplace command instead (run
in a normal terminal), then restart Codex:

```text
codex plugin marketplace add Zhao73/alphacouncil-agent
```

> Local-clone install (Option B): the `source.path` in your
> `~/.agents/plugins/marketplace.json` must be the **absolute** path to the clone
> (e.g. `C:\\Users\\you\\.codex\\plugins\\alphacouncil-agent`), **not** `./`. When in
> doubt, use the GitHub marketplace command above — it avoids hand-editing paths.

## Windows

### Prerequisites (Windows)

- **Node.js ≥ 18** — install from [nodejs.org](https://nodejs.org), or in PowerShell:
  `winget install OpenJS.NodeJS.LTS`. Verify with `node --version`.
- (Headless path only) the Codex CLI installed and authenticated. v0.3.0+ supports
  native Windows `codex.cmd` installs; WSL is only a fallback if your Codex CLI
  itself does not work from PowerShell/CMD.

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

### Runtime notes (Windows)

The **headless Codex path** (`analyze_symbol` / `collect_evidence`, which launch `codex exec`
workers) is supported on native Windows in v0.3.0+: the server launches through
`cmd.exe /d /s /c` so `codex.cmd` resolves correctly, and it sends large analyst prompts
through stdin (`codex exec -`) instead of putting Chinese/multiline prompts on the command
line. Timeout cleanup uses the normal Node process plus Windows process-tree termination.

If headless still fails, check these first:

- `node --version` is >= 18.
- `codex --version` works in PowerShell or CMD.
- Codex CLI is logged in for the same Windows user running Codex Desktop.
- If `codex` is not on PATH, set `ALPHACOUNCIL_AGENT_CODEX_CMD` to the absolute path of
  `codex.cmd`.

Fallbacks:

- Use **WSL** and run Codex + the plugin inside Linux if your native Codex CLI install is broken.
- Use the **visible path** above when you do not want the MCP server to spawn `codex` at all.

Everything else is cross-platform: data lives under `%USERPROFILE%\.alphacouncil-agent\`
(via `os.homedir()`), paths use `path.join`, and the MCP wiring is plain `node`.

---

## 中文速览

- 前置:Node ≥ 18;headless 真跑研究需要已登录的 Codex CLI(worker 是 `codex exec`)。Windows v0.3.0+ 原生支持 `codex.cmd`;WSL 只是 fallback。
- Codex 安装:`codex plugin marketplace add Zhao73/alphacouncil-agent` → `/plugins` 安装 → `/reload-plugins`;或 clone 到 `~/.codex/plugins/` 走本地 marketplace。
- Claude Code 安装:`/plugin marketplace add Zhao73/alphacouncil-agent` → `/plugin install alphacouncil-agent@alphacouncil` → `/reload-plugins`。
- 没有 Codex CLI 时:用 visible 工作流,让 Claude 子代理产出证据并用 `record_visible_*` 录入,无需 codex。

---

## 日本語クイックガイド

- 前提:Node ≥ 18。headless でリサーチを実走させるには、認証済みの Codex CLI が必要(worker は `codex exec`)。Windows は v0.3.0+ で `codex.cmd` をネイティブに起動可能。WSL は fallback。
- Codex でのインストール:`codex plugin marketplace add Zhao73/alphacouncil-agent` → `/plugins` でインストール → `/reload-plugins`。または `~/.codex/plugins/` に clone してローカル marketplace 経由でも可。
- Claude Code でのインストール:`/plugin marketplace add Zhao73/alphacouncil-agent` → `/plugin install alphacouncil-agent@alphacouncil` → `/reload-plugins`。
- Codex CLI が無い場合:visible ワークフローを使用。Claude のサブエージェントに根拠を生成させ、`record_visible_*` で記録する(codex 不要)。
