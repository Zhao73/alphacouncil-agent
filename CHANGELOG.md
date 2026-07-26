# Changelog

Notable changes per release. Dates are UTC.

## [0.5.1] — 2026-07-26

### Added

- **Slash commands**: `/alphacouncil`, `/alphacouncil-quick`, `/alphacouncil-screen` and
  `/alphacouncil-market`, authored once and generated into every host's command directory.
  0.5.0 shipped with no command directory at all, so the plugin could only be reached by
  @-mention or by describing it in prose.

### Fixed

- The npm package did not carry the command directories, which meant an installed copy and
  a checkout behaved differently.

## [0.5.0] — 2026-07-26

Everything below is keyless: no API key, no account, no config file.

### Added

- **Options chain** (`get_options_chain`) from CBOE delayed quotes — ATM implied-volatility
  term structure, 25-delta skew, put/call ratios on open interest and volume, the strikes
  holding the most open interest, and the ATM spread as a share of mid.
- **News layer** (`get_news`) over Yahoo Finance RSS, Google News RSS and SEC EDGAR Atom,
  with a recency gate that excludes undated and out-of-window items rather than showing
  them as recent.
- **Market narrative** (`get_market_narrative`) — what the market is currently talking
  about, ranked by share of coverage, with each theme paired against the market series that
  would corroborate it. A theme leading coverage while its series has not moved is the
  finding, not the headline count.
- **Social layer** (`get_social_pulse`, `verify_x_post`) over Reddit, Hacker News and
  Bluesky, plus single-post verification against an X post id.
- **Options bench**: Taleb, Natenberg and Sinclair, and **Michael Burry** on the
  adversarial roster. The bench is now 21 lenses across six rosters.
- **Price bands are a mandatory report section.** Every seat contributes the price question
  its own method implies — Graham's calculable floor, Marks' do-not-touch level, Thorp's
  price at which expected value turns positive, the short seller's cover level and carry.
- `market_narrative` and `social_pulse` analyst seats, on the `full` roster. The default
  fan-out stays at eight.

### Changed

- **Masters now receive the established facts directly**, not only the analysts' packets,
  with the packets relabelled as other seats' readings. Previously all 21 lenses saw the
  world through one selection of what mattered, so a weak packet biased every seat
  identically.
- All 21 masters state how they think, what they notice first, their characteristic
  challenge, and their own failure mode.
- The ten stub personas — `bull_researcher` was 79 characters — are rewritten around what
  each seat is for and how it characteristically fails.
- Verifiers gained a claim-selection rule (verification runs on a budget), their own failure
  modes, and knowledge of which claims this system cannot settle at all.
- `screen_ticker` accepts a `ticker` and resolves the CIK itself; `cik` is no longer required.
- **The master bench and the verifier pass now run on every host.** They were described only
  in the Claude Code section of `SKILL.md`, so on Codex and OpenCode the twenty-one lenses
  and three verifiers never executed at all — the same plugin was a materially different
  product depending on where it ran.
- **`list_council_options` and a mandatory Stage 0.** A council is 7 to 44 seats, which is
  the user's time and money, so the host asks which one to run instead of choosing silently
  — and is told when not to ask, because a confirmation nobody needed is an interruption.
- **Grok Build support**, verified against grok 0.2.101: `.grok/config.toml` (TOML, not
  JSON), 14 generated `.grok/agents` definitions, and `AGENTS.md` as the project prompt. A
  repo-local server stays unstarted until the folder is trusted, which is a security prompt
  rather than a misconfiguration.
- `plan_visible_run` gathers the established facts itself. It previously accepted them only
  if the caller passed them and nothing told the caller to, so on the visible path — the one
  Claude Code uses — every analyst and every master ran with no filings, no quote and no
  macro, and nothing in the output said so.
- A run that selects a master bench and records no opinions is now `incomplete`, and the
  banner names the seats that never reported.

### Fixed

- **The npm package shipped no host agent files.** `.claude/agents/`, `.opencode/agent/` and
  `.grok/agents/` were all outside `files`, so an install gave you the server and no
  subagent definitions for three of the four hosts.
- **`CLAUDE.md` listed three roles that no longer exist** — `sell_side_revisions`,
  `earnings_call_transcript` and `management_industry_voices` — and it is loaded as an
  instruction file, so an agent reading it would dispatch seats that had been merged away.
- Bilingual `{en, zh}` labels rendered as `[object Object]` next to real numbers, which reads
  as a broken field rather than a missing one. A contract test now renders every surface in
  both languages against object-label fixtures.
- `SKILL.md` named none of the data tools, including `screen_ticker`. It is the runtime
  instruction Codex, OpenCode and Grok Build load, so a tool it never names is a tool those
  hosts never call. Nothing failed; the capability was invisible.

- `screen_ticker` offered a `ticker` property in its schema and threw on anything without a
  `cik`, so a caller passing the documented argument got an error.
- `get_options_chain` read its headline IV and skew from the nearest expiry, which can be
  one day out. A 1-DTE ATM prices pin risk rather than volatility: on a live chain it
  printed 69.6% between neighbours at 98.7% and 105.2%. Both now read from the first expiry
  at least a week out.
- Contracts reporting `iv = 0` are excluded from the term structure. CBOE returns zero for
  expired and deep-in-the-money contracts, and a zero entering an IV mean does not look like
  a gap — it looks like a calm stock.
- A site-wide Reddit search for a ticker name returned unrelated posts; search is now
  restricted to the equity subreddits.
- Hacker News search matched "Micron" against "microkernels" and "Microsoft" through
  Algolia's typo tolerance, which is now disabled with the phrase quoted.
- Restoring the analyst bodies dropped content from three merged roles (earnings call,
  sell-side revisions, industry voices). All three are restored, and the test that guards
  the merge now requires each absorbing seat to both declare what it absorbed and carry the
  topic, rather than matching one literal phrase.

## [0.4.0] — 2026-06-23

Keyless real market data (`get_quote`).

## [0.3.2] — 2026-06-22
## [0.3.1] — 2026-06-22

Bundles `agent-skills-governance`, an anti-laziness skill with explicit stop gates.

## [0.3.0] — 2026-06-22

The shared server runs the three-round debate, enforces the missing-source, full-run and
report-quality gates, writes concise and full report artifacts, and supports native Windows
Codex CLI launching.

## [0.2.0] — 2026-06-22

Full-council enforcement, three-round debate, verification gate.
