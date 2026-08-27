# Install AlphaCouncil Agent

AlphaCouncil Agent supports four host integrations: **OpenAI Codex**, **Claude Code**,
**OpenCode**, and **Grok Build**. Codex loads the bundled Skills and MCP declaration from
the plugin. Claude Code, OpenCode, and Grok Build also ship a host-native `/alpha` command.
The same server can additionally load as an MCP-only connector in the Claude desktop app.

> ⚠️ **Disclaimer.** Educational/research use only. **Not investment advice.**
> AI analysis can be incomplete, outdated, or wrong. Do your own research and
> consult a licensed professional before any investment decision.

---


## Install

```bash
npm install -g alphacouncil-agent
```

That installs the current release and places the `alphacouncil-agent` MCP executable on
your `PATH`. A global npm install is useful when a host needs a standalone MCP command; it
does **not** by itself register the bundled Codex Skill or the other hosts' command/agent
files. Use the matching host section below for the complete integration.

To pin a version or install straight from a tag:

```bash
npm install -g alphacouncil-agent@latest
npm install -g github:Zhao73/alphacouncil-agent#main
```

`npm view alphacouncil-agent dist-tags --json` shows what each channel currently serves.

Then point any MCP host at the `alphacouncil-agent` binary. For Claude Code:

```json
{ "mcpServers": { "alphacouncil-agent": { "command": "alphacouncil-agent" } } }
```

For OpenCode, `command` takes an argv array:

```json
{ "mcp": { "alphacouncil-agent": { "type": "local", "command": ["alphacouncil-agent"] } } }
```

Or run it without installing: `npx alphacouncil-agent`.

## Core setup: no data-vendor key required

The first US/Taiwan/market data check is keyless — SEC EDGAR for US filings, TWSE for
Taiwan, and Yahoo/Stooq for quotes and macro — and the package has no runtime package
dependencies. Headless council research additionally needs an installed and authenticated
Codex CLI; visible workflows use the authenticated model supplied by their host.
Development-only schema generation and property-test packages are not loaded by the
installed plugin.

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

### Codex: Skill-first

Invoke the installed plugin by its Skill mention. Modes remain plain-language arguments,
including the explicit quick path:

```text
@alphacouncil-agent AAPL news
@alphacouncil-agent analyze AAPL
@alphacouncil-agent AAPL quick
```

The Codex plugin already contributes its Skills and MCP server. There is no prompt file to
copy into your home directory, and `/alpha` is not the Codex invocation surface.

### Claude Code, OpenCode, and Grok Build: `/alpha`

On these three hosts, one command, `/alpha`, carries the mode as an argument.

```text
/alpha <ticker>              full council — asks for the 15/30/60m depth tier, then displays all methods
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
`analyze_symbol(council_mode="full")`, it runs at one of three depth tiers selected with
`council_pace` -- `fast` 15 minutes, `normal` (default) 30, `slow` 60 -- whose ceilings cover
durable queueing through terminal artifact persistence. Their rounded configured stage totals
are 13, 25 and 58 minutes; observed successful completion remains unvalidated. The tier raises every per-stage cap with the
total, which is where the depth difference lives; all three preserve the separately confirmed
eight-seat core or eleven-seat all-analyst roster and the three-round `full_v2` contract:

- all receipt-bound evidence workers start in one parallel wave;
- after the fail-closed evidence barrier, each selected physical v3 method freezes its
  deterministic stance and gets one isolated voice worker that cannot alter it; any missing
  real method voice stops full before debate and PM rather than becoming a successful fallback;
- Bull and Bear start in parallel within each of three rounds, with a barrier between rounds
  and exact Round-2-question to Round-3-answer binding;
- the PM and deterministic report persistence use the same global clock.

Callers and `ALPHACOUNCIL_FULL_TOTAL_MS` may lower the deadline, never raise it. At expiry
the server saves a terminal `incomplete` run naming failed/timed-out/skipped seats. The
selected tier's 15-, 30-, or 60-minute bound guarantees terminal persistence, not complete
results when search, model transport or data providers are unavailable. `plan_visible_run`
has no such enforceable deadline because the external host owns and schedules its subagents.

A full `user_response.md` lists all eight or eleven receipt-bound analyst statuses and summaries, every selected
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

Codex users express the same modes after the Skill mention, for example
`@alphacouncil-agent AAPL quick` or `@alphacouncil-agent AAPL news`.

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
(plugin manifest), and `codex.mcp.json` (Codex-only MCP server wiring) — so the two CLI
commands below work out of the box. (`.claude-plugin/marketplace.json` is kept for legacy compat.)

### A. GitHub marketplace — recommended ✅

```text
codex plugin marketplace add Zhao73/alphacouncil-agent
codex plugin add alphacouncil-agent@alphacouncil
```

Then **fully quit and restart the Codex desktop app** (plugins load at session
start — see [Troubleshooting](#troubleshooting-the-plugin-doesnt-show-up--alphacouncil-agent-isnt-found)),
open a new session, and invoke the Skill:

```text
@alphacouncil-agent AAPL news
```

`codex plugin list --json` should show `alphacouncil-agent@alphacouncil` with
`installed: true` and `enabled: true`.

### B. Local clone — advanced / offline only

```bash
git clone https://github.com/Zhao73/alphacouncil-agent.git \
  ~/.codex/plugins/alphacouncil-agent
codex plugin marketplace add ~/.codex/plugins/alphacouncil-agent
codex plugin add alphacouncil-agent@alphacouncil
```

The CLI records the clone's absolute path in the isolated marketplace configuration.
Restart Codex after installation. **Prefer A** unless you're doing offline/local
development; it keeps the user's installation tied to the GitHub marketplace source.

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
   `record_visible_decision`. If a visible worker cannot complete, call
   `finalize_visible_run` so the run becomes terminal and returns the mandatory handoff instead
   of remaining `running`. The MCP tools `plan_visible_run` / `record_visible_*` /
   `finalize_visible_run` never call `codex`, so this runs fully inside Claude.

---

## Claude desktop app (MCP only)

Add the MCP server in the app's connector/MCP settings, pointing `command` to
`node` and `args` to the absolute path of `mcp/server.mjs`. Tools will load; the
headless path still needs Codex CLI as above.

---

## Install in OpenCode

The repository checkout is the complete OpenCode integration: `opencode.json` wires the
local MCP server, `AGENTS.md` plus the listed instruction files carry the workflow, and
`.opencode/agent/` plus `.opencode/command/alpha.md` provide the host-native agents and
`/alpha` command.

```bash
git clone https://github.com/Zhao73/alphacouncil-agent.git
cd alphacouncil-agent
opencode mcp list
```

Verified against OpenCode 1.18.4:

- the MCP shape is `{"type":"local","command":["node","./mcp/server.mjs"]}`; `command`
  is one argv array and the environment key is `environment`, not `env`;
- OpenCode does not import `.claude/agents/` or `.claude/settings.json`; the generated
  `.opencode/agent/*.md` files carry per-role permissions, and
  `opencode debug agent alphacouncil-<role>` exposes the resolved provider/model and rules;
- `opencode.json` intentionally has no global `permission` block, because a global block
  overrides the safer per-agent network rules. Only evidence gatherers receive network
  access, and no generated role may edit files or run shell commands;
- no root `.mcp.json` is shipped. This prevents compatibility plugins from auto-importing
  a second cwd-sensitive server beside the explicit OpenCode and Codex wiring;
- runtime-added Skills do not appear in OpenCode 1.18.4's static Skill catalogue. The
  workflow therefore loads through `instructions`, the MCP tools, and the generated agents.

`websearch` needs the OpenCode provider or `OPENCODE_ENABLE_EXA=1`. Run
`preflight_permissions` before a fan-out. A global npm install can provide an MCP-only
`alphacouncil-agent` command, but it does not install these repo-local instructions,
agents, or `/alpha` command.

---

## Install in Grok Build

Use a repository checkout so Grok Build can read `AGENTS.md`, `.grok/agents/`,
`.grok/commands/alpha.md`, and the project-scoped MCP configuration:

```bash
git clone https://github.com/Zhao73/alphacouncil-agent.git
cd alphacouncil-agent
grok mcp doctor
```

Verified against Grok Build 0.2.101:

- MCP configuration is TOML under `.grok/config.toml`. To regenerate it, run
  `grok mcp add alphacouncil-agent -s project -t stdio node -- ./mcp/server.mjs`. No root
  `.mcp.json` is shipped, so compatibility loaders cannot start a duplicate server;
- a repo-local server stays stopped until the folder is trusted. The corresponding
  `folder untrusted` doctor result is a security prompt, not a broken command;
- `AGENTS.md` is the project system prompt, and generated `.grok/agents/*.md` seats use
  read-only `permission_mode: plan`. Those agents are Markdown files with `name` and
  `description` frontmatter and inherit `AGENTS.md`;
- this repository does not duplicate the workflow under `.grok/skills/` or
  `.claude/skills/`; Grok receives it through `AGENTS.md` plus MCP tools.

A global npm install again provides only the standalone MCP executable. The checkout is
what supplies Grok's agents and `/alpha` command.

---

## Troubleshooting: the plugin doesn't show up / `@alphacouncil-agent` isn't found

Codex loads its tool list **at session start**. Installing or enabling a plugin
mid-session does **not** hot-add it to the current conversation — even if the files
are installed, `config.toml` marks it enabled, and the self-check passes.

Do this in order:

1. **Fully quit and restart the Codex desktop app** (not just a new tab) and open a **new session**.
2. In a terminal, run `codex plugin list --json` and confirm
   `alphacouncil-agent@alphacouncil` is installed and enabled.
3. Trigger it with the **exact lowercase id**: `@alphacouncil-agent ...`. The display
   name `@AlphaCouncil Agent` (spaces + capitals) may not trigger — prefer the id.

If the plugin is absent, add both the marketplace and plugin in a normal terminal, then
restart Codex:

```text
codex plugin marketplace add Zhao73/alphacouncil-agent
codex plugin add alphacouncil-agent@alphacouncil
```

When using a local clone, pass its absolute path to `codex plugin marketplace add`; do
not hand-edit a relative `source.path`.

## Windows

### Prerequisites (Windows)

- **Node.js ≥ 18** — install from [nodejs.org](https://nodejs.org), or in PowerShell:
  `winget install OpenJS.NodeJS.LTS`. Verify with `node --version`.
- (Headless path only) the Codex CLI installed and authenticated. v0.3.0+ supports
  native Windows `codex.cmd` installs; WSL is only a fallback if your Codex CLI
  itself does not work from PowerShell/CMD.

### Install in Codex desktop (Windows)

Run the same plugin CLI commands in PowerShell or CMD, then restart Codex Desktop:

```text
codex plugin marketplace add Zhao73/alphacouncil-agent
codex plugin add alphacouncil-agent@alphacouncil
```

Local / personal marketplace (Windows paths). In PowerShell:

```powershell
git clone https://github.com/Zhao73/alphacouncil-agent.git "$env:USERPROFILE\.codex\plugins\alphacouncil-agent"
codex plugin marketplace add "$env:USERPROFILE\.codex\plugins\alphacouncil-agent"
codex plugin add alphacouncil-agent@alphacouncil
```

Restart Codex, open a new session, and use `@alphacouncil-agent ...`.

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
- 四个宿主:Codex、Claude Code、OpenCode、Grok Build;完整 full 的三档硬上限分别为 15/30/60 分钟。
- Codex 安装:`codex plugin marketplace add Zhao73/alphacouncil-agent` → `codex plugin add alphacouncil-agent@alphacouncil` → 重启;用 `@alphacouncil-agent AAPL news`，quick 用 `@alphacouncil-agent AAPL quick`。
- Claude Code 安装:`/plugin marketplace add Zhao73/alphacouncil-agent` → `/plugin install alphacouncil-agent@alphacouncil` → `/reload-plugins`。
- OpenCode/Grok Build:使用仓库 checkout 里的各自配置、agents 与 `/alpha` 命令;见上方对应小节。npm 全局安装只提供 MCP 可执行文件。
- 没有 Codex CLI 时:用 visible 工作流,让 Claude 子代理产出证据并用 `record_visible_*` 录入,无需 codex。

---

## 日本語クイックガイド

- 前提:Node ≥ 18。headless でリサーチを実走させるには、認証済みの Codex CLI が必要(worker は `codex exec`)。Windows は v0.3.0+ で `codex.cmd` をネイティブに起動可能。WSL は fallback。
- 4 ホスト:Codex、Claude Code、OpenCode、Grok Build。full の深度別ハード上限は 15/30/60 分です。
- Codex:`codex plugin marketplace add Zhao73/alphacouncil-agent` → `codex plugin add alphacouncil-agent@alphacouncil` → 再起動。`@alphacouncil-agent AAPL news` で使用し、quick は `@alphacouncil-agent AAPL quick`。
- Claude Code でのインストール:`/plugin marketplace add Zhao73/alphacouncil-agent` → `/plugin install alphacouncil-agent@alphacouncil` → `/reload-plugins`。
- OpenCode/Grok Build:リポジトリ checkout 内の専用設定、agents、`/alpha` コマンドを使用します。npm のグローバルインストールだけでは MCP 実行ファイルのみです。
- Codex CLI が無い場合:visible ワークフローを使用。Claude のサブエージェントに根拠を生成させ、`record_visible_*` で記録する(codex 不要)。
