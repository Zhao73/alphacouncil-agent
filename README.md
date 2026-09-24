<div align="center">

<img src="assets/logo-icon.png" width="72" alt="" />

# AlphaCouncil

**Fast AI equity research — in your terminal, in Claude Code, and in Codex.**

**English** · [中文](README.zh-CN.md)

</div>

```
$ alpha NVDA is it a buy now?

◆ NVDA  NVIDIA Corp · NASDAQ · equity
  Price 228.87 USD +1.2%   52w 131–240   12m +61% · P/E 46 · FCF 2.1%
  Lenses deep− quality+ garp~ growth+ trend+ …

Desks
  ✓ Business & earnings        1:31  mixed
  ✓ Expectations & valuation   1:24  bullish
  ✓ News, industry & catalysts 1:04  mixed
  ✓ Positioning & risk         1:28  mixed
Debate
  ✓ Bull                       0:21
  ✓ Bear                       1:04
Decision
  ✓ Portfolio manager          0:36  Overweight
⏱ 3:12 · $1.53

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NVDA  NVIDIA Corp                                   Overweight ▲  confidence medium
Value 170 / 285 / 380 USD · base vs price +25%
Conclusion  …   Bull  …   Bear  …   Verdict  bull wins — …
Levels      > 280 avoid · 205-235 start · < 198 add
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Ask a follow-up (Enter to quit, /report for the full report)
›
```

## How it works

1. **Snapshot (seconds, no model):** price, technicals, SEC fundamentals and multiples, filings,
   options, dated news and eight deterministic method lenses, fetched in parallel and cached.
2. **Research desks (parallel):** business & earnings · expectations & valuation · news, industry
   & catalysts · positioning & risk. Each starts from the snapshot, does ~5 targeted searches and
   returns sourced findings.
3. **Bull vs bear (parallel):** each argues the strongest honest case from the record.
4. **Portfolio manager:** rating, bear/base/bull value, price levels, catalysts, risks, position,
   views by horizon, what would prove it wrong.
5. **Report:** assembled by code from the saved results, so no finding, citation or data gap is
   lost. Every output has a JSON schema, and code checks that citations resolve.

`--fast` runs one research pass and then the decision (~1-2 min). Measured deep run: 3:12 in total,
$1.53 on the Claude Code engine.

## Terminal

```bash
npm install -g github:Zhao73/alphacouncil-agent
alpha NVDA                       # deep research (default)
alpha AAPL "is it a buy now?"    # a question; the decision answers it
alpha 0700.HK --fast             # fast read
alpha                            # interactive
```

After a report, type follow-up questions (answered from the report, searching only when needed);
`/report` opens the full report. Also: `alpha ask NVDA "what if rates rise?"`, `alpha runs`,
`alpha show NVDA`, and no-model data commands `alpha quote|snapshot|news|filings|options|lenses NVDA`,
`alpha macro`, `alpha doctor`.

**Engines** (automatic; override with `--engine`):

| Engine | When | Notes |
|---|---|---|
| `api` | `ANTHROPIC_API_KEY` is set | Official Anthropic SDK, streaming, server-side web search. Fastest. Defaults: `claude-sonnet-5` for research/debate, `claude-opus-5` for the decision (with server-side refusal fallbacks). |
| `claude` | Claude Code is installed and signed in | Each step is a headless `claude -p` call on your Claude Code plan; structured results via `--json-schema`. |

Options: `--fast`, `--lang zh-CN|ja|en…` (default: the language you type in), `--model`,
`--research-model`, `--debate-model`, `--decision-model`, `--fresh` (ignore a report from the last
6 hours), `--json`, `--plain`. Data: `ALPHA_HOME` (default `~/.alphacouncil`), `ALPHA_SEC_CONTACT`
(SEC asks for a contact in the User-Agent), `NO_COLOR`.

## Claude Code

```text
/plugin marketplace add Zhao73/alphacouncil-agent
/plugin install alphacouncil@alphacouncil
```

Then `/alpha NVDA`, `/alpha AAPL is it a buy?`, `/alpha 0700.HK --fast` — or just ask
"research NVDA". Four `analyst` subagents research in parallel, two `advocate` subagents argue
bull and bear, and Claude makes the decision; the bundled MCP server supplies the snapshot,
per-task instructions, validation and the report. No confirmation menus. Measured deep run:
about 5.5 minutes (subagent start-up adds time; the terminal client is faster).

To skip permission prompts for the plugin's tools, allow
`mcp__plugin_alphacouncil_alphacouncil__*`, `WebSearch` and `WebFetch` in `/permissions`.

## Codex

```bash
codex plugin marketplace add Zhao73/alphacouncil-agent
codex plugin add alphacouncil@alphacouncil
```

Restart Codex and ask `@alphacouncil research NVDA`. Codex runs the same tasks in sequence with
its own web search; the same MCP server supplies data, instructions and the report.

## Data

Keyless public sources, cached on disk: Yahoo Finance (delayed quotes, history, search), SEC
EDGAR (XBRL facts → TTM metrics and multiples; filings), Google News (dated headlines), Cboe
(delayed options), FRED (macro). ETFs are researched through holdings and indices through
methodology, never as if they were a company. Unreachable sources show up as named gaps in the
report.

## Development

```bash
npm install
npm test        # 32 tests, no network: fixtures, a fake backend and a fake `claude`
```

Layout: `src/core` (data, snapshot, prompts, schemas, pipeline, report; dependency-free),
`src/backends` (api, claude), `src/cli` (terminal), `src/mcp` (plugin server), `skills/`,
`agents/`. See [CLAUDE.md](CLAUDE.md).

---

AI-generated research from public sources; not investment advice. Method lenses are
deterministic screens inspired by published approaches, not the views of any person. MIT licensed.
