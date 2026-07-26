# Changelog

Notable changes per release. Dates are UTC.

## [Unreleased]

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

### Fixed

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
