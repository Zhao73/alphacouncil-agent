<a name="readme-top"></a>

<div align="center">

<img src="assets/banner.png" alt="AlphaCouncil Agent" width="100%" />

<p>
  <img src="https://readme-typing-svg.demolab.com?font=Fira+Code&size=20&duration=2800&pause=700&color=1A7A6A&center=true&vCenter=true&width=620&lines=Spawn+a+council+of+analyst+agents;Gather+sourced+evidence%2C+hide+nothing;Run+a+bull+vs+bear+debate;Get+a+PM+verdict%3A+Buy+%C2%B7+Hold+%C2%B7+Sell" alt="tagline" />
</p>

**English** · [中文](README.zh-CN.md) · [日本語](README.ja.md)

<p>
  <img src="https://img.shields.io/github/actions/workflow/status/Zhao73/alphacouncil-agent/check.yml?style=for-the-badge&label=build&logo=githubactions&logoColor=white&color=1a7a6a" alt="build" />
  <img src="https://img.shields.io/badge/License-MIT-c9a227?style=for-the-badge" alt="MIT" />
  <img src="https://img.shields.io/badge/Node-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="node" />
  <img src="https://img.shields.io/github/stars/Zhao73/alphacouncil-agent?style=for-the-badge&logo=github&color=0d4d4d" alt="stars" />
</p>
<p>
  <img src="https://img.shields.io/badge/OpenAI_Codex-412991?style=for-the-badge&logo=openai&logoColor=white" alt="codex" />
  <img src="https://img.shields.io/badge/Claude_Code-D97757?style=for-the-badge&logo=anthropic&logoColor=white" alt="claude code" />
  <img src="https://img.shields.io/badge/OpenCode-1a7a6a?style=for-the-badge&logoColor=white" alt="opencode" />
  <img src="https://img.shields.io/badge/Grok_Build-000000?style=for-the-badge&logo=x&logoColor=white" alt="grok build" />
</p>
<p>
  <img src="https://img.shields.io/badge/MCP-compatible-000000?style=for-the-badge" alt="mcp" />
  <img src="https://img.shields.io/badge/API_keys-none_required-2ea043?style=for-the-badge" alt="no api keys" />
  <img src="https://img.shields.io/badge/dependencies-zero-2ea043?style=for-the-badge" alt="zero dependencies" />
</p>

<p>
  <a href="docs/INSTALL.md"><b>Install</b></a> ·
  <a href="#-usage"><b>Usage</b></a> ·
  <a href="#-tools--31-all-keyless"><b>Tools</b></a> ·
  <a href="#-the-bench--27-investor-method-lenses"><b>The bench</b></a> ·
  <a href="#-architecture"><b>Architecture</b></a> ·
  <a href="CHANGELOG.md"><b>Changelog</b></a> ·
  <a href="#-disclaimer"><b>Disclaimer</b></a>
</p>

</div>

---

<div align="center">

<img src="assets/demo.gif" alt="AlphaCouncil live: a council of analyst agents researching a ticker and debating to a verdict" width="100%" />

<sub><i>A real run, in real time. Want the still version? <a href="assets/run-example.png">Six lenses reaching the same call for different reasons</a> · <a href="docs/examples/final_report.SOX.zh.md">a complete real report</a> (SOX, full council, zh)</i></sub>

</div>

AlphaCouncil Agent is a Codex and Claude Code plugin for public-equity research councils. Full council is the default; an explicitly requested `quick` run uses a smaller, plugin-managed headless contract. Both gather sourced evidence, run selected method seats and produce an auditable portfolio-manager report.

### ✨ Why AlphaCouncil

| | |
|---|---|
| 🏛️ **A council, not one opinion** | Eight specialist analysts by default, eleven available — market data, earnings, forward expectations, quant, valuation, news and supply chain, insider/SEC, IB events, macro, narrative, crowding. |
| 🎭 **27 selectable investor lenses** | Buffett, Munger, Graham, Lynch, Marks, Damodaran, Ackman, Cathie Wood, Pabrai, Bogle and more read the **same facts** through different stated research priorities. Every council run shows all 27 with actual maturity before research. Full accepts any non-empty selection or `all`; quick requires 1-4 and rejects `all`. |
| 🧺 **A basket is not a company, and the bench knows it** | An ETF or index is priced by look-through: a fund owning 1% of a business has a claim on 1% of its owner earnings, so a company method reads a basket **without changing its method**. Ratios aggregate by weight; absolute figures become the fund's own dollar claim; a share count is refused because it has no portfolio meaning. |
| 📰 **A basket gets its own industry news** | `SOX` has no press office. Its industry is derived from the weighted SIC groups of its holdings, so SOXX resolves to semiconductors and survives a rebalance. Where no group dominates, the basket is queried as the several industries it actually is. |
| 🌏 **What else you are betting on** | Correlation to the broad market, to KOSPI, to KOSDAQ and to the semiconductor cycle, plus dispersion across the eleven sector SPDRs. Sessions pair by date, because Korea and the United States keep different holidays. |
| 💵 **Fund flow that refuses to be faked** | Creations minus redemptions, priced. Only a filed share count or the issuer's own assets-over-NAV identity may price a flow; a count reconstructed from positions is refused, because a difference cancels the number and keeps the error. |
| 🐂🐻 **Adversarial by design** | Full runs a three-round bull/bear cross-exam and the visible/deep path can add three adversarial verifiers. Quick runs one parallel bull/bear statement round and a short PM; it checks scoped source IDs but explicitly does not claim adversarial verification. |
| ⏱️ **You pick the depth: 15, 30 or 60 minutes** | The run asks before it starts and shows the expected time beside the hard ceiling for each tier — you never type a speed. All three are the same full contract: eight analysts, three debate rounds, the PM. What changes is how long each seat may think, and a tier shapes the output too, because a shorter fuse on the same prompt buys unfinished work rather than faster work. Plugin-managed full starts all eight analysts together, runs Bull/Bear together inside each round, and persists a terminal run inside the chosen tier. Provider failures produce an explicit `incomplete` result, never silently missing seats. |
| 🔍 **Auditable, never hallucinated** | Every claim maps to a source ID. A screen rule with missing inputs is `skipped`, never a pass. An undated headline is excluded, not shown as recent. Gaps are a section, not an omission. |
| 🧭 **Company, ETF and index routing** | The symbol is classified before research. Companies use issuer financials; ETFs use dated holdings look-through; indices use aggregate methodology. QQQ/SPY are never treated as companies with their own revenue or EPS. |
| 💰 **Entry price bands, not one number** | Three conditional bands with what each depends on. "The cycle position is undetermined" changes what the bands are conditional on; it does not excuse leaving them out. |
| 🔑 **31 tools, zero API keys, zero dependencies** | SEC EDGAR, CBOE options, Yahoo/Stooq quotes, 21 macro series, news and social — all keyless. `node mcp/server.mjs` and nothing else. |
| 🖥️ **One contract on four hosts** | Claude Code, Codex, OpenCode and Grok Build share the same selection, evidence and reporting gates. Quick is always executed by the plugin-managed headless `analyze_symbol` path. |

This repository is the uploadable source copy. Runtime outputs are written outside the repo under `~/.alphacouncil-agent/runs/<run_id>/`.

## What this ships

`npm install -g alphacouncil-agent` installs the current release.

Twenty-seven method seats, each running its own formulas and its own thresholds against typed
facts built from SEC filings, FRED series, issuer holdings disclosures, published index
aggregates, Section 16 ownership, cross-market price history and dated industry news.
Fifty-four executable tools.

Measured against live grounding, with no fixtures: every one of the 27 seats reaches a stance
somewhere across a mixed set of symbols, with no contract failures. A basket that had **no data
path at all** — `SOX` was in neither registry — now produces 40-plus typed facts, and the seats
that read them are running the same methods they run on a company.

Honesty note: seat formulas are AI-authored reconstructions of named published methods,
pending human review — the governance status and what remains open are tracked in
[the v1.0.0 release contract](docs/releases/v1.0.0.md), and `npm run check` prints
exactly where that stands.

Trust posture: zero runtime dependencies, no install scripts, no telemetry, every data
source keyless and public; analyst workers run in a read-only sandbox
(`codex exec -s read-only -a never --ephemeral`). Details in [SECURITY.md](SECURITY.md).

See [the v1.0.0 release contract](docs/releases/v1.0.0.md) for the exact ETF/index and full/quick
boundary and [the report contract](docs/report-contract.md) for `quick_v1` versus `full_v2`.

## 📜 Disclaimer

This software is for **educational and research purposes only**. It is **not
investment advice**, not a recommendation to buy or sell any security, and not a
solicitation. AI-generated analysis can be incomplete, outdated, or wrong. Do
your own research and consult a licensed financial professional before making any
investment decision. The authors accept no liability for any loss.

## Install

See **[docs/INSTALL.md](docs/INSTALL.md)** for full Codex and Claude Code setup. **Windows users:** see the [Windows section](docs/INSTALL.md#windows).

**Prerequisites:** Node.js >= 18. The headless research path also needs an
installed, authenticated **Codex CLI** (each analyst worker runs as `codex
exec`). On Windows, v0.3.0+ launches the CLI through `cmd.exe` and feeds prompts
over stdin so native `codex.cmd` installs work without WSL in the normal case.

```text
# Codex
codex plugin marketplace add Zhao73/alphacouncil-agent
# then run `codex`, open /plugins, install, and /reload-plugins

# Claude Code
/plugin marketplace add Zhao73/alphacouncil-agent
/plugin install alphacouncil-agent@alphacouncil
/reload-plugins
```

**First run, 30 seconds, zero model spend** — before committing to a full council,
verify the data layer works:

```text
/alpha AAPL news
```

That calls only keyless data tools and spawns no subagents. When it returns dated
headlines and filings, the install is good; then try a full council with `/alpha AAPL`.
Note the headless full/quick paths additionally need an authenticated **Codex CLI**
(each analyst worker runs as `codex exec`) — Claude Code without Codex uses the
visible host-subagent path instead, see [docs/INSTALL.md](docs/INSTALL.md).

## 🚀 Usage

Just talk to it. Mention the agent and a ticker or a question:

```text
@alphacouncil-agent analyze AAPL as a long/short pitch
@alphacouncil-agent is AAPL a buy at current levels?
@alphacouncil-agent compare TSLA vs RIVN for a 12-month horizon
@alphacouncil-agent 帮我看看 700.HK 现在能不能买
@alphacouncil-agent トヨタ(7203)を分析して
```

You get back a single, chat-readable report:

```text
VERDICT: Overweight  (confidence: medium)
├─ Analyst work log ........ 11 evidence agents, 38 sourced claims
├─ Bull thesis ............. demand inflection, margin expansion, buyback
├─ Bear thesis ............. valuation, customer concentration, cycle risk
├─ Short / medium / long ... 1-4wk · 3-6mo · 12mo views
├─ Catalysts & risks ....... earnings, guidance, regulatory
├─ Data gaps ............... explicitly listed, never hidden
└─ Source table ............ every claim mapped to <task>:<source_id>
```

The concise handoff is written to `~/.alphacouncil-agent/runs/<run_id>/user_response.md`.
The full report is written to `~/.alphacouncil-agent/runs/<run_id>/final_report.md`,
with analyst Markdown files and `artifact_index.md` in the same run directory. Full handoff
shows the system quote (or an explicit quote-data gap), all eight analyst statuses/summaries,
and every selected method seat's frozen stance plus readable explanation/status. Its final
section contains the exact selected-seat count and one statement per stable ID; `all` ends
with all 27 statements. These are provisional method-seat outputs, never quotes from the
named people.

### Slash commands

**One command, `/alpha`.** Modes are arguments, so there is one name to remember
rather than four in a menu of a hundred.

| Invocation | What runs | Model spend |
|---|---|---|
| `/alpha <ticker>` | Asks the depth tier with its expected time, shows every master, confirms `1..N`/ranges/`all`, then full; headless is bounded by the chosen tier (15/30/60m) | deterministic stance + one isolated voice worker per v3 seat that reached a stance; a frozen abstention is published without one |
| `/alpha <ticker> quick` | Shows all 27, confirms 1-4 (no `all`), then plugin-managed `quick_v1` (≤10m) | varies with selection |
| `/alpha <ticker> screen` | Mechanical filings screen only | **none** |
| `/alpha <ticker> options` | IV term structure, skew, positioning | **none** |
| `/alpha <ticker> news` | Dated filings and headlines | **none** |
| `/alpha market <theme>` | What the market is talking about | **none** |
| `/alpha` | Lists the modes and stops | **none** |

The four marked **none** call keyless data tools and spawn no subagents, so they cost
nothing beyond the turn you type them in. Full and quick first display every master with a
number, identity, method and best-use case. A native multi-select may make that easier, but
all four hosts support the same numbered text fallback. Full accepts `all`; quick accepts
only 1-4 distinct seats and rejects `all`. Even a request that already names a master must
show the catalog and confirm a fresh, one-use, mode-bound receipt before research starts.

Any listed equity: `/alpha AAPL` · `/alpha 0700.HK quick` · `/alpha 7203.T news` · `/alpha market rates`.
Filings-based modes need a US filer; other markets are reported through `market_coverage` rather than silently returning nothing.

### Full v2 — three depth tiers, chosen at the gate

The run asks how deep to go before it asks which methods to seat. You never type a speed:
`begin_council_selection` returns the menu, with the expected time and the hard ceiling for each
tier side by side.

| tier | expected | ceiling | evidence / seat | debate / round / side |
| --- | --- | --- | --- | --- |
| `fast` | ~12 min | 15 min | 3.5 min | 90 s |
| `normal` (default) | ~20 min | 30 min | 6 min | 150 s |
| `slow` | ~44 min | 60 min | 12 min | 6 min |

**All three are the same `full_v2` contract** — eight evidence seats, every selected method,
three debate rounds, the PM. A tier changes how long each seat may think, never which seats run.
Both numbers are published because a ceiling shown alone reads as the estimate, and then every
fast run looks like it takes fifteen minutes.

A tier moves every per-stage cap together with the total, and it also shapes what each worker is
asked to produce. That second half matters: a cap on its own is a timeout, and the same prompt
with a shorter fuse buys a packet the worker could not finish rather than a faster good one.
Since an LLM call's wall clock is dominated by the tokens it generates, `fast` asks for the same
information in less prose — claims, figures, scoped source IDs, required report sections and the
decision are never what gets cut; restatement is. `slow` buys room to write a derivation out
step by step.

The chosen tier binds into the one-use `selection_receipt`, so an execution call may repeat it
but never change it: a run approved as fifteen minutes cannot become an hour, and `status.json`
records which tier produced it. Quick has no tier — it is a smaller contract, not a slower one.

All eight mandatory evidence workers start in one parallel wave. After the evidence barrier,
each selected physical v3 method freezes its deterministic stance; a method that reached a
stance gets one isolated voice worker that can explain, but cannot change, that result, while a
frozen abstention is published from its deterministic record without spending a worker. Bull and
Bear run in parallel within each of the three rounds, with a barrier between rounds, followed by
the PM.

At expiry the server persists `incomplete` with every timed-out, failed and skipped role. The
tier's ceiling is a terminal-persistence guarantee, not a promise that search, model transport or
data providers will let every seat succeed. A visible-host `plan_visible_run` is scheduled
outside the plugin and cannot be force-stopped, so it carries no time claim at all.

The resulting full handoff names every selected stable master ID and all eight analysts, and
includes a system-owned price snapshot or explicit unavailable-data record. Method-seat
voice is a recorded provisional lens explanation, not a quote, endorsement or current
statement by the named person. System-owned output supports Chinese (`zh-CN`), English,
Japanese and Korean; each worker receives the run language.

### Quick v1 — bounded, not full

Quick is never inferred from impatience or a full-run failure. It runs only through the
plugin-managed headless `analyze_symbol(council_mode="quick")`; `plan_visible_run` rejects
quick. After the complete 27-seat display and a 1-4-seat confirmation, it executes:

1. `market_data`, `earnings_deep_dive`, `valuation_long_short` and
   `news_industry_management` in one parallel wave;
2. the 1-4 selected method seats in one parallel wave;
3. one Bull and one Bear statement in parallel, then one short PM;
4. deterministic `quick_v1` report assembly and standard artifacts.

Recent company and industry news must be dated inside the 120 days ending at `as_of`;
future, undated and older items are excluded from recent news and recorded as gaps. The hard
queue-to-persistence ceiling is **600000 ms**: grounding wait 20s; each parallel evidence
worker 210s; each parallel method worker 90s; Bull and Bear 90s per side; PM 90s; final
assembly/persistence reserve 20s. Retries consume the same caps and global clock.

Quick has no round-2 rebuttal, round-3 exact Q&A or adversarial
`source_fidelity`/`rederivation`/`refuter` fan-out. It may terminate `degraded` only under its
explicit coverage rules and system-owned degraded ledger; otherwise missing required work is
`incomplete` or `failed`. `report_quality=passed` means the `quick_v1` structure passed—it
does not make the run complete or equivalent to `full_v2`. A method-seat result is a
recorded provisional lens output, never a quotation from the named person.


Available in Claude Code, OpenCode and Grok Build as soon as the plugin is installed. Codex keeps
its prompts user-scoped, so copy it once: `mkdir -p ~/.codex/prompts && cp commands/alpha.md ~/.codex/prompts/`

## What It Does

Default stock-analysis runs are full runs, not lite summaries:

- Market data and price action
- Earnings deep dive, including the earnings call
- Forward expectations, implied beat/miss thresholds, and sell-side target revisions
- Quant factor view: momentum, trend, volatility, liquidity, relative strength, crowding
- Valuation and long/short pitch, with price bands rather than a single target
- News, industry context, supply chain, and management's words checked against their actions
- SEC filings, Form 4 insider transactions, buybacks, dilution, debt and capital allocation
- Investment-banking event analysis for M&A, ECM, debt, buybacks and strategic transactions
- A selectable bench of 27 investor method lenses reading the same facts
- Bull researcher, bear researcher and portfolio-manager synthesis

Full is fail-fast at its mandatory evidence barrier. If a required evidence role still
fails after the one bounded parse-only repair, the run persists the failure and diagnostic
artifacts, skips selected-method, debate and PM model calls, and terminates `incomplete`.
It does not spend downstream synthesis time on a run that cannot satisfy `full_v2`.

The final report is readable directly in chat. It carries analyst work logs, data and filing
summaries, the bull/bear debate, the PM verdict, entry price bands, short/medium/long-term
views, data gaps, confidence and a source table.

## 🔧 Tools — 31, all keyless

Nothing below needs an API key, an account, or a config file. Install and run.

| Area | Tools | Source |
|---|---|---|
| **Instrument + filings** | `compose_research_brief` `screen_ticker` `screen_candidates` `list_us_universe` | Company/ETF/index classification; SEC EDGAR XBRL only where applicable |
| **Non-US filings** | `market_financials` `market_coverage` | TWSE keyless; DART/EDINET on a free key; HK/CN documents only |
| **Market data** | `get_quote` `get_macro_snapshot` | Yahoo / Stooq, 21 macro series + 5 derived |
| **Options** | `get_options_chain` | CBOE delayed quotes — IV term structure, 25-delta skew, open interest, Greeks |
| **News** | `get_news` `get_market_narrative` | Yahoo, Google News, SEC Atom, Fed, WSJ, CNBC |
| **Social** | `get_social_pulse` `verify_x_post` | Reddit, Hacker News, Bluesky |
| **Industry** | `industry_brief` `industry_peers` `industry_coverage` `list_industries` | SIC across all US filers + curated maps |
| **Workflow** | `analyze_symbol` `plan_visible_run` `collect_evidence` `read_run` and 5 more | — |

**What it deliberately will not do.** Every one of these is stated in the tool output itself,
not only in the docs, because the payload is what gets quoted downstream:

- **IV percentile is not computable.** The chain is a snapshot with no history, so any claim
  that volatility is high or low against its own past is reported as an open question.
- **X / Twitter has no free discovery channel** as of 2026-07. Nitter search is dead, the X
  API bills per post and xAI bills per call. Professional FinTwit is **not** covered, and
  Reddit is not a substitute for it.
- **A screen rule whose inputs are missing is `skipped`, never a pass.**
- **A news item with no parsable timestamp is excluded**, not shown as recent.
- **A contract reporting `iv = 0`** — CBOE does this for expired and deep-in-the-money
  contracts — is dropped rather than averaged in, because a zero does not look like a gap,
  it looks like a calm stock.

## 🏛️ The bench — 27 investor method lenses

Reconstructions of publicly documented methods, not anything the named people said. Each
states how it thinks, what it notices first, its characteristic challenge, and **its own
failure mode** — a seat that cannot name how it goes wrong will not flag it when it does.

| Roster | Lenses |
|---|---|
| Value | Buffett · Munger · Duan Yongping · Li Lu |
| Classic value | Graham · Fisher · Lynch · Marks · Klarman |
| Adversarial | Soros · Druckenmiller · Dalio · Burry · short seller |
| Quant | Simons · Asness · Thorp |
| Options | Taleb · Natenberg · Sinclair |
| Modern | Aschenbrenner |
| v3 expansion | Damodaran · Ackman · Cathie Wood · Pabrai · Bogle · Jhunjhunwala |

The `solo_test` catalog has 27 selectable physical v3 packs, but **27 physical packs is
not 27 approved method models**. Every seat is a provisional `operator_lens` backed by
project-derived proxy material; the 54 tools are executable test proxies, not human-approved
formula attribution. Operational and `method_model` counts are both zero, and production GA
remains fail-closed.

Masters read the **same established facts** the analysts read — filings, quotes, financials,
macro — and receive the analyst packets separately, labelled as other seats' readings rather
than as fact. That separation is the point: the bench is worth having only because Munger
looks at incentives where an analyst looked at margins. See [docs/attribution.md](docs/attribution.md).

A seat that reached a stance gets its own isolated voice worker and speaks in first person —
what it sees, how its standard reads the number, whether it would act, and what would change
its mind. A seat that abstained publishes a deterministic first-person statement at zero
model cost; set `ALPHACOUNCIL_VOICE_ABSTAINING_SEATS=1` to give abstaining seats a full
voice worker too, at the cost of one worker per abstained seat.

## 🧩 Architecture

The diagram below is the full/deep path. Quick retains the Master Bench but uses its fixed
four-role evidence wave, one parallel Bull/Bear statement round and short PM; it does not run
the verifier node shown here.

```mermaid
flowchart TD
    U["@alphacouncil-agent<br/>ticker / question"] --> G[("Established facts<br/>filings · quotes · macro · options")]
    G --> AG{{"Analyst council"}}
    G --> MS{{"Master bench<br/>27 lenses"}}
    AG --> A1["📈 Market data"]
    AG --> A2["💰 Earnings"]
    AG --> A3["⚖️ Valuation"]
    AG --> A4["🧮 Quant factors"]
    AG --> A5["🏛️ Insider / SEC"]
    AG --> A6["📰 News / narrative"]
    A1 --> EV[("Evidence base<br/>sourced packets")]
    A2 --> EV
    A3 --> EV
    A4 --> EV
    A5 --> EV
    A6 --> EV
    EV -.->|"read as interpretation,<br/>not as fact"| MS
    EV --> VF{{"Verifiers<br/>fidelity · re-derive · refute"}}
    VF -->|"failed checks<br/>down-weight the seat"| PM
    MS --> BULL["🐂 Bull"]
    MS --> BEAR["🐻 Bear"]
    EV --> BULL
    EV --> BEAR
    BULL --> PM{{"Portfolio manager"}}
    BEAR --> PM
    PM --> R[["final_report.md<br/>verdict + entry price bands"]]
```

The masters branch off the facts, not off the packets. Feeding 27 lenses one analyst's
selection of what mattered would give them all the same blind spot — a large and perfectly
correlated error — and would remove the reason for having a bench at all.

Key files:

- `.codex-plugin/plugin.json` - Codex plugin metadata.
- `codex.mcp.json` - isolated Codex MCP server wiring.
- `assets/logo-icon.png` - plugin icon used by Codex.
- `skills/alphacouncil-agent/SKILL.md` - runtime instructions for Codex.
- `mcp/server.mjs` - JSON-RPC MCP server and workflow implementation.
- `scripts/selfcheck.mjs` - minimal regression check.

## 🆚 Codex vs Claude Code edition

For full council, both editions share the same workflow, JSON packet contract, audit artifacts, the no-API-keys / live-web evidence model, and the same disclaimer. The Claude Code edition changes only *how* the full council is run. Quick does not use visible host orchestration on either edition; it always uses the plugin-managed headless path.

| | Codex edition | Claude Code edition |
|---|---|---|
| Council execution | plugin-managed `codex exec` workers; full headless ≤15/30/60m by chosen tier | Host-owned `Task` subagents; no plugin-enforced deadline at all |
| Quick `quick_v1` | Plugin-managed headless `analyze_symbol` | Same plugin-managed headless `analyze_symbol` |
| Per-analyst context | Separate process | Separate subagent, full isolated context window |
| Evidence | `codex exec --search` | `WebSearch` + `WebFetch` in each analyst's own context |
| Evidence → debate | Eight-role parallel wave, then hard barrier | Hard barrier on the run's phase machine |
| Debate depth | 3 rounds (case / rebuttal / Q&A), bull + bear parallel per round | 3 rounds, bull + bear in parallel per round |
| Claim verification | Missing-source gate (run flagged, report banner) | + per-claim adversarial verify: re-fetch cited URL, re-derive, refute *(host-driven)* |
| Full-run enforcement | Incomplete runs marked `incomplete` (server gate) | Same gate, plus a hard barrier before debate |
| Model & cost | One model | **Pick per role** — evidence on Sonnet, debate/verdict on Opus 4.8 (or all-Opus / all-Sonnet) |
| Language | `zh-CN`/English/Japanese/Korean system copy; workers get run language | User's language across every subagent + the live workflow |

**Honest scope:** same model family, same prompts, same audit contract — the win is context isolation, always-on parallel fan-out, and deterministic gates, *not* a smarter model. As of **v0.3.0** the shared server runs the 3-round debate, enforces missing-source / full-run / report-quality gates, writes concise and full report artifacts, and supports native Windows Codex CLI launching. As of **v0.3.1**, the plugin also bundles `agent-skills-governance`, an `addyosmani/agent-skills`-style anti-laziness skill with explicit stop gates and exit criteria. The Claude Code edition adds parallel per-round execution and host-driven per-claim verification. Live-web staleness and paywalls limit both editions equally.

## Data Contract

Evidence agents return JSON packets:

```json
{
  "task": "market_data",
  "symbol": "AAPL",
  "as_of": "YYYY-MM-DD",
  "summary": "string",
  "claims": [
    {
      "claim": "string",
      "evidence": "string",
      "confidence": "high|medium|low",
      "source_ids": ["market_data:S1"]
    }
  ],
  "metrics": {},
  "sources": [
    {
      "id": "market_data:S1",
      "title": "string",
      "url": "https://example.com",
      "published_at": "YYYY-MM-DD or unknown",
      "retrieved_at": "YYYY-MM-DD"
    }
  ],
  "open_questions": ["missing data item"],
  "confidence": "high|medium|low"
}
```

All source IDs are task-scoped as `<task>:<source_id>`. Missing data must be reported in `open_questions` and in the final report's data-gap section.

## Run Locally

```bash
npm run check
```

The check validates:

- MCP server syntax
- tool schema exposure
- source ID scoping
- default real-run behavior
- visible-run recording
- `events.jsonl`, `status.json`, `all_agents.md`, `source_manifest.json`
- `final_report.md`, `user_response.md`, `artifact_index.md`, `report_quality.json`
- one Markdown file per evidence analyst plus bull, bear, and portfolio manager
- final report includes analyst work log, bull/bear debate record and data gaps

## Codex Install Shape

The plugin expects this local layout:

```text
.codex-plugin/plugin.json
codex.mcp.json
skills/alphacouncil-agent/SKILL.md
mcp/server.mjs
scripts/selfcheck.mjs
package.json
```

`codex.mcp.json` runs:

```json
{
  "mcpServers": {
    "alphacouncil-agent": {
      "command": "node",
      "args": ["./mcp/server.mjs"],
      "cwd": "."
    }
  }
}
```

## Notes

This is an independent Codex plugin implementation. It uses a multi-agent investment-committee workflow: analyst teams, evidence sharing, bull/bear debate and portfolio-manager synthesis.

No API keys, brokerage credentials, private filings or generated run artifacts should be committed.

## ⭐ Star History

<div align="center">

<a href="https://star-history.com/#Zhao73/alphacouncil-agent&Date">
  <img src="https://api.star-history.com/svg?repos=Zhao73/alphacouncil-agent&type=Date" width="640" alt="Star History Chart" />
</a>

<br/><br/>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png" />
  <img src="assets/logo.png" alt="AlphaCouncil" width="120" />
</picture>

If AlphaCouncil saved you time, consider leaving a ⭐ — it genuinely helps.

<a href="#readme-top">↑ Back to top</a>

</div>
