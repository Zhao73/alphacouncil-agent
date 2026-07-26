# Changelog

Notable changes per release. Dates are UTC.

## [0.8.0] — 2026-07-27

Minor rather than patch: **the master bench changes from prompt voices to method models,
and a defect is fixed that manufactured consensus in every prior run.**

A user asked why the masters never appear in the report. The answer turned out to be three
problems wearing one coat, and the third is the one that mattered.

### Fixed

- **An unrecognised master stance was silently rewritten as `cautious`.** The enum check
  fell through to a default and the default was a real stance carrying real weight, so a
  caller writing `avoid`, `long` or `neutral` got a seat that looked deliberate and voted.
  A ten-seat run whose opinions ranged from avoid to long **recorded `cautious` ten times**
  and rendered as a unanimity nobody produced. Worse in the other direction: a mistyped
  `out_of_scope`, which carries zero weight, would have been promoted to a full vote.
  Unmappable values now record as `out_of_scope` and warn; plausible synonyms are mapped;
  the tool schema states the enum so a caller can see it before guessing.
- **Master opinions were rendered nowhere.** `markdown.mjs` contained no reference to
  `master`. Opinions were recorded, gated for completeness and weighted into the synthesis,
  and a run could select ten lenses, pass every gate, and publish a report in which none of
  them were readable.
- **`record_*` echoed the entire run on every call.** Payloads grew with each recording and
  a late call in a twenty-one-seat run passed 240k characters — context exhaustion arriving
  exactly when a run was nearly finished. They now return progress and a path to
  `status.json`.
- **The Bluesky handle loader silently returned an empty list**, because `readFileSync` was
  never imported and the `catch` swallowed the `ReferenceError`.

### Added

- **Persona v2: method models, not impressions.** A master is now an eligibility gate, a
  scoring function with cited thresholds, an evidence slice and a narrative — in that order,
  with the model confined to the last. `docs/persona-v2-spec.md`,
  `schemas/persona-v2.schema.json`.
- **Four pilot packs** — Buffett, Duan Yongping, Marks, Taleb — each with its own gate rather
  than its own adjectives. On the real NOK facts the Buffett method declines (a 20-F filer
  has no long-run series) while the Taleb method acts (an option chain exists). Different
  methods see different companies, which twenty-one prompts over one brief never could.
- **The admission bar is enforced in the loader.** A corpus below 25 propositions / 5 primary
  sources / 5 decisions / 3 failures / 10 vetoes / 10 counterfactuals is downgraded to
  `operator_lens` and carries its shortfall. All four pilots are honestly below it. A display
  name reading as a person, a doctrine rule citing no grade A/B source, and a threshold
  without provenance are each refused.
- **Swap experiments.** Name swap: renaming a pack moves no verdict. Policy swap: Taleb's
  policy under Buffett's name judges as Taleb. The differentiation diagnostic returns `none`
  for four renamed copies of one method, which is what makes `effective` on the real four
  worth anything.
- **Memory with both clauses of the leak rule** — `public_at <= as_of AND
  memory_created_at <= as_of`. The second clause stops a model reading its own diary. Undated
  records are excluded rather than assumed harmless, and a postmortem cannot be written
  before the horizon it judges.
- **Enforced evidence slices.** The frozen fact pack is shared and unoverridable; what each
  method may read on top of it is filtered in code, not requested in a prompt.

### Changed

- **The bench prints dissent first**, and a correlation note above every bench states that
  the seats share a base model and an evidence brief, so their agreement is not independent
  confirmation and the stance spread is not a vote count. Unanimity is reported as the
  absence of independent dissent.
- **`master_bench` is a required report section**, conditional on a bench having run, so
  screen and quick modes are not failed for omitting one they never selected.
- **Curated Bluesky accounts** are configurable by file or environment and ship **empty**:
  unverified handles would be invented sources inside a tool that exists to refuse them. X
  remains uncovered and the payload says so.

### Not yet wired

The v2 engine is tested and shipped but the live council still runs the v1 prompt personas.
Integration, the remaining seventeen masters, and `N_eff` — which needs resolved ground truth
that does not exist yet — are next. Investment return is recorded as a long-run outcome and
is never a gate.

## [0.6.0] — 2026-07-26

Minor rather than patch: **every screened number changes.** Anyone comparing a result from
0.5.x will see different figures, and the 0.5.x ones were wrong.

### Fixed

- **Quarterly and stub periods were counted as years.** A 10-K reports quarterly and
  acquisition-stub periods alongside annual ones, and the reader keyed only on the end date.
  Lumentum's fiscal 2015 became ten separate "years" — nine quarters and stubs plus the real
  363-day period — so every multi-year rule averaged quarterly income against annual equity.
  LITE's ten-year ROE read 2.26% and is **-1.64%**; MU's read 10.03% and is **12.83%**.
  Periods must now span 300–400 days, wide enough for a 53-week fiscal year, with instant
  balance-sheet facts exempt because they have no duration.
- **Tag aliases stopped at the first match instead of merging.** Revenue moved to the ASC 606
  tag in 2022, so a company filing since 2013 appeared to have four years of history — which
  then fired a "listed under ten years" exemption on a decade-old filer. Aliases now merge,
  the preferred one winning a contested year and a later filing winning within one alias.
- **The dilution rule had never once been computed.** Share counts live under the XBRL
  `shares` unit and the reader asked for `USD`, so it reported `skipped` for every company
  ever screened — seven rules advertised, six ever computed, and a skip is indistinguishable
  from a genuine data gap. AAPL now computes 7 of 7.

### Testing

- The existing dilution test passed throughout because its fixture also put share counts
  under `USD` — the same mistake as the reader, so the two agreed with each other. The
  fixture now uses the unit XBRL actually uses.
- A regression test pins that one company's filings cannot leak into another's result.
  Verified live as well: LITE, then AAPL, then LITE again, identical to the digit.

## [0.5.5] — 2026-07-26

### Fixed

- **Five masters never ran.** Aschenbrenner, Druckenmiller, Fisher, Asness and Klarman were
  not in the `masters-core` roster, which is what the standard preset selects, while the
  seat estimate counted every master. The menu offered 21 lenses and the run delivered 16,
  with nothing failing and nothing warning. A test now asserts the roster equals the full
  set rather than merely being large.

### Changed

- **Stage 0 asks one question, about the master bench, then runs.** It previously asked which
  preset, then which analysts, then confirmed — an interview before any work. The analysts
  have an obvious default; the bench is the part a user has a view on and where cost varies.
- `list_council_options` prints the **named** roster: every analyst with what it covers, and
  the six master schools with their members. Presets remain as shortcuts. Naming the seats is
  what made the missing five visible.
- Command help uses `<TICKER>` with examples across US, Hong Kong and Tokyo listings. One
  real ticker repeated down the column read as if the tool were about that company.

## [0.5.4] — 2026-07-26

### Fixed

- `docs/INSTALL.md`, `SECURITY.md` and `CONTRIBUTING.md` were never in the package. The
  install guide is the page an npm user reads specifically to learn how to invoke the thing,
  and it was absent from every published version.
- A contract test now asserts the property rather than the entries: every tracked
  consumer-facing file must be in the package. The gaps had been surfacing one release at a
  time — the host agent directories in 0.5.1, the install guide in 0.5.3.

## [0.5.3] — 2026-07-26

### Fixed

- The 0.5.2 tarball was cut before the translated READMEs and `docs/INSTALL.md` learned that
  `/alpha` exists, so an installed copy carried stale Chinese and Japanese documentation
  while the repository did not. Docs-only; no code changed.

## [0.5.2] — 2026-07-26

### Changed

- **Four slash commands collapse into one: `/alpha`**, with the modes as arguments.
  `/alphacouncil-quick` and friends were long to type and, in a menu of a hundred commands,
  four near-identical entries are harder to navigate than one. Modes: bare ticker for the
  full council, plus `quick`, `screen`, `options`, `news`, and `market`. Invoked with no
  arguments it lists the modes and stops rather than guessing.
- The modes that spawn no subagents are marked as such, because that is the actual choice a
  user is making — `screen`, `options`, `news` and `market` call keyless data tools and cost
  nothing beyond the turn.

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
