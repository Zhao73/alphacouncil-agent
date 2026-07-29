# Changelog

Notable changes per release. Dates are UTC.

## [1.0.8] — 2026-07-30

### Changed

- **The catalog stops repeating a review-status warning next to every seat.** The owner
  reviewed and accepted the method attributions, so `operator_label` is now just the method's
  name and the selection identity says what a seat IS — "a method model, not the person's own
  words" — instead of "project-derived and not human reviewed" twenty-seven times. The
  impersonation guard stays; the machine-verified `admission_level` and every fail-closed
  release gate are unchanged. All 27 solo-test packs regenerated; machine simulations re-run
  against the new pack hashes.

## [1.0.7] — 2026-07-29

### Fixed

- **A historical cutoff silently discarded the market yardstick and a fund's entire evidence
  base.** Two sibling blocks in grounding skipped their fetch when the cutoff was historical and
  wrote nothing to `unavailable`: the US-subject market-valuation block (so Marks and Damodaran
  declined with `unmet: index.aggregate_earnings_yield` and the reader was never told why) and
  the fund/index holdings block (worse — holdings, look-through aggregates and basket news ARE a
  fund's evidence, so a historical fund run kept only a price). Both now record the gap the way
  their sibling blocks always did. Three network-free regression tests pin the contract,
  including one that walks the market earnings yield through the typed-fact lineage gate to a
  `ready` Damodaran seat.

### Clarified

- The LITE council run that motivated 1.0.5 was executed by a cached 1.0.2 server, not by
  current code: on HEAD, `index.aggregate_earnings_yield` resolves from the WSJ keyless
  trailing-P/E source (verified live: 0.0397, dated, https lineage) and Marks, Damodaran and
  Asness are all `ready` on a US equity. The seats were never method-blocked — the host was
  running last week's build. If a seat declines on a fact the catalog says it should have,
  check the plugin cache version before the method.

## [1.0.6] — 2026-07-29

First release on which `npm run check` and the full test suite pass together: 995/995.

### Fixed

- **The formula-review gate demanded exactly 156 roles after the bench grew to 162.** The
  literal (26 seats × 2 tools × 3 roles) survived the twenty-seventh seat, so
  `review-persona-v3-solo-formulas --check` failed a review tree whose own output line printed
  `roles=162/162`. The gate now derives the count from the planned-tool inventory.

### Repaired (local staging, not shipped in the package)

- The private PersonaPack staging tree had been left behind by the v1.0.x sessions, which
  worked in a scratch worktree and never synced back: `staging-index.json` was missing
  `master_bogle` (39 test failures from one integrity error), and all 27 seats' formula
  prototypes still carried pre-rename tool ids. Synced from the authoring worktree; the
  packaged `knowledge/solo-test` tree was already correct and is unchanged.

## [1.0.5] — 2026-07-29

Five defects found by running one full visible council end to end on a US operating company.
Every one of them was silent: the run produced a report and none of these said anything was wrong.

### Fixed

- **A plan response could exceed the host's tool-result limit.** `plan_visible_run` echoed the
  entire grounding object, whose macro history and typed-fact lineage are unbounded — 2.33 MB of a
  2.54 MB payload on a single US equity — so the host truncated the plan to a scratch file and the
  agent could not read the seat specs it had just asked for. Both fields are already in every seat
  prompt and in `evidence.json`; the response now carries the rest of the grounding plus a pointer
  and an entry count. Nothing else about the shape changed.
- **An English source title failed a Chinese packet's language gate.** `sources[].title` counted
  toward the reader-language ratio, so packets whose every authored sentence was Chinese were
  rejected at ratio 0.49. The only way to pass was to translate the citation, which falsifies the
  source. `title` now joins `url` as machine text.
- **A portfolio-manager report that failed the structure gate could not be repaired.** The
  idempotency lock was taken before the gate ran, so a thin report left the run permanently at
  `needs_revision`: the corrected submission came back as a conflicting replay and there was no
  other way in. A PM whose `report_quality` is not `passed` is now revisable; one that passed stays
  frozen.
- **A failed verification down-weighted nothing when the seat was an analyst.** The contract
  promises that a `contradicted` verdict reduces the weight of the seat that made the claim, but
  the seat enumeration covered only debate and master seats. Verdicts against evidence roles were
  recorded and then ignored, and the tool still answered with `verification_factor: 1`.
- **A missing market yardstick looked like an abstention.** When the broad-market valuation fetch
  succeeded but yielded no market-level fact, it was dropped without a trace; downstream, Marks and
  Damodaran declined with `unmet: index.aggregate_earnings_yield` and the report never said why the
  fact was absent. An unexplained abstention reads as a verdict. It is now recorded as a data gap.

### Changed

- `MASTER_SELECTION_INTENT_MISMATCH` now returns the expected and submitted intent hashes, the
  fields the receipt binds, and the remedy. The receipt binds the prompt verbatim by design, but
  the error gave the caller no way to tell a retyped prompt from a wrong symbol.

## [1.0.4] — 2026-07-29

### Fixed

- **Total liabilities had one tag and many filers use none of it.** Net current asset value, the
  downside asset value and the downside floor all failed on `Liabilities`, silencing Graham,
  Burry, Klarman and Pabrai. It is now reconstructed where a filer tags the balance-sheet total
  and equity instead — but only against the equity tag that INCLUDES non-controlling interests,
  where the identity is exact. With the parent-only tag minority interest lands inside
  "liabilities" and nothing says so, which is why the previous refusal was right and is kept
  wherever that tag is absent.
- **Revenue growth insisted the last eight filings were its window.** One restated quarter, one
  stub period or one duplicate at the end discarded a company's entire revenue history. It now
  searches backwards for the most recent clean pair of four-quarter blocks; each window is
  checked exactly as strictly as before, only the search moved.

Measured: INTC and WMT go from six of eight derived fundamentals to **eight of eight**, GLW to
seven.

### Changed

- The seat selector labels an `operator_lens` as a method lens rather than leading with
  "provisional". The machine-verified admission level is unchanged and still published as
  `admission_level`.

## [1.0.3] — 2026-07-29

Three real runs are the specification: a GLW run put all eight selected seats at `out_of_scope`
with weight zero, an INTC run sent six to the deterministic fallback, and a LITE run reported
"no ticker was provided" for a ticker that had been provided. The filings contained the data
every one of them said was missing.

### Fixed

- **The missing facts were mostly missing tag aliases.** `grossProfit` resolved for five of
  fifteen large caps, because most filers publish revenue and cost of revenue separately rather
  than tagging it; it is now derived from those two, matched by period end, with a tagged value
  always winning. `capex` missed Corning entirely, which files `PaymentsForCapitalImprovements`
  — that one absent alias removed owner earnings, and with it Buffett and Ackman, for every
  issuer tagging it that way. Gross margin now resolves for all fourteen testable filers.
- **Market facts were fetched only for baskets.** Asness, Marks and Damodaran require
  `index.aggregate_earnings_yield` and reported it missing on every single-company run. The
  market's aggregate earnings yield is not a property of the subject; it is the yardstick the
  subject is measured against.
- **A seat could not reach its own answer about an absent fact.** Pabrai is authored with a veto
  that says no downside floor means pass. That fact is also a tool input, and a tool declaring
  `on_missing: "fail"` aborted the policy before any veto ran. A veto that reads only facts
  needs nothing a tool produces, so when one has already decided the seat, the tools it would
  have fed no longer abort the run.
- **A grounding timeout discarded everything.** The caller threw away a completed quote, screen
  and filing set because one feed was slow, and the analysts described the empty result as a
  missing ticker. Grounding settles at its own budget and returns what arrived. Section 16
  ownership was reading filings one at a time — up to sixty throttled round trips on the
  critical path — and is now batched: LITE completes in seven seconds.
- **SEC rate limiting collapsed a run.** A 429 is now retried with a bounded backoff instead of
  being indistinguishable in the report from the data not existing.
- **A registrant with no filings is one diagnosis, not eight.** `XOM` resolves through SEC's own
  ticker file to a newly formed holding company with zero us-gaap tags.
- **The maturity suffix stopped leaking into sentences.** Statements read "using the X
  provisional operator lens method".

### Added

- **Seats say what they looked at.** The five-field voice — what I see, how my method reads it,
  would I act, what changes my mind, where I disagree — is composed from the frozen decision:
  the facts read and their values, what the tools produced, which scoring conditions held and
  which did not, and what would move the verdict. Because it is derived from the decision it
  cannot drift from it, and anonymous rule ids are mapped back to the seat's readable names.
  Abstentions get the same structure.

## [1.0.2] — 2026-07-29

### Added

- **A basket now has a news identity.** `SOX` has no press office and files nothing, so a
  basket run carried market-wide headlines and no industry at all. The industry is derived from
  the SIC groups of the largest holdings, weighted — SOXX resolves to semiconductors because
  its holdings are semiconductor registrants, and it survives a rebalance because nothing is
  hand-maintained. Where no group dominates, the basket is queried as the several industries it
  actually is: an industrial fund gets aerospace, machinery and electronics rather than one
  misleading label. Constituent news and 8-K filings come with the weight of the holding they
  belong to.
- **The SIC group table covers every code a US registrant can file.** It had real holes —
  aerospace and autos, brokers, media and entertainment, commercial research — and a holding in
  one of them resolved to no industry and therefore to no industry news. 22 groups to 43, with
  a test that walks every SIC from 0100 to 8999.
- **News as counts, never as content.** `news.covered_weight` and `news.filing_event_weight`
  are dated quantities an event-driven method may read. Headlines themselves stay out of the
  arithmetic: a stance that changed with the morning's press would not be reproducible, which
  is the property this runtime exists to protect.
- **Cross-market correlation and sector dispersion.** Correlation to the broad market, to
  KOSPI, to KOSDAQ and to the semiconductor cycle, plus dispersion across the eleven sector
  SPDRs. Dalio's authored policy already limited position size by correlation and had none to
  read. Sessions pair by DATE: Korea and the United States keep different holidays, and zipping
  two close arrays by index compares a Tuesday with a Wednesday.

### Changed

- **A fired veto is a verdict, not silence.** Graham finding no asset floor has answered —
  his construction is a price below a computed floor, and without one there is no margin of
  safety, which is his own definition of speculation. He passes. Klarman and Pabrai likewise.
  Left alone: li_lu, forensic_short and asness refuse on circle-of-competence grounds, and a
  forensic short with no allegation is not bearish.
- **The report separates a judgment from a data gap**, in four languages. A seat whose method
  ran to completion and returned "not this one" no longer reads as a seat that was starved of
  inputs.

## [1.0.1] — 2026-07-29

A SOX run ended with 25 of 27 seats abstaining. The seats were not the problem.

### Fixed

- **A basket nobody registered produced no facts.** `^SOX` was not in `INDEX_PROXIES` and
  `SOXX` was not in `FUND_REGISTRY`, so there were no holdings, no look-through and no
  aggregate valuation — and `master_bogle`, the seat built to price a basket, abstained with
  the rest. `^SOX` and `^RUT` are mapped, and 25 more baskets are registered, every product id
  read from the issuer's own screener and verified by live fetch.
- **An index typed without its caret did not route to the index path.** `^SOX` classified as an
  index and `SOX` did not, so a run on the name people actually type produced nothing.
- **`funds.mjs` re-exported six parsers it also calls.** A bare `export ... from` publishes a
  name without binding it, so every live fetch path threw `not defined` while the parser tests,
  which import directly, stayed green.
- **Three recorded data gaps were closed and still being reported** — breadth, the implied ERP
  and the valuation percentile. A note about a fact the pack produced reads as a gap that is
  filled, which sends a reader to solve a solved problem.

### Added

- **Company methods can price a basket, without changing their methods.** A fund holding 1% of
  a company has a claim on 1% of its owner earnings; summed across the basket that is a dollar
  figure about the fund, and a fund's market capitalisation is its AUM, so a seat dividing one
  by the other gets the weighted look-through yield. Ten seats were blocked on a share count
  and none of them wanted a share count — they wanted a denominator.
- **Every pure ratio a constituent reports now aggregates**: cash conversion, both margins,
  ten-year ROE, incremental return on capital, interest coverage. Coverage aggregates
  harmonically, because one debt-free constituent at 900x drags an arithmetic mean to
  "comfortably covered" for a basket that is not.
- **ETF flow**, from an append-only ledger of what each run saw, because no issuer serves a
  keyless share-count history. Only a filed count or the issuer's own assets-over-NAV identity
  may price a flow; a count reconstructed from positions over market price may size a fund and
  is refused for a flow, because a difference cancels the number and keeps the error. Eleven
  Select Sector SPDRs registered, which is where the question is usually asked.
- **A cash index reads its tracking ETF's option chain**, labelled a proxy, the same discipline
  the holdings path already applies.

### Changed

- A share count is carried as a point-in-time quantity. It was declared over a fiscal year
  because that is how the filing reports it, which left a fund's count — a genuine instant —
  unable to satisfy any contract.

Measured on live grounding: SOX 0 seats to 6, SOXX 0 to 17, QQQ 11 to 16, AAPL unchanged at 18
as the control, and across five mixed symbols all 27 seats reach a stance with no contract
failures.

## [1.0.0] — 2026-07-29

The release where the method seats stop abstaining on everything. Full notes in
`docs/releases/v1.0.0.md`.

All twenty-seven seats now run their own arithmetic and their own thresholds. Measured on live
grounding across eight symbols, twenty-six of twenty-seven reach a stance somewhere with no
contract failures. `master_jhunjhunwala` declines everywhere by construction: its first filter
is the promoter shareholding record, which US filings do not contain, and the seat names that
gap rather than substituting for it.

### Changed

- `prepublishOnly` verifies the package rather than GA readiness. It ran `npm run check`, which
  includes reports that exit non-zero until the corpus has human-reviewed method models and a
  live four-host E2E run — a state this build declares it is not in and cannot reach without
  work outside the repository. Gating `npm publish` on it meant a self-declared non-GA preview
  could never ship at all. GA readiness keeps its own gate in `release:check`, which is
  unchanged and still fails closed.

### Added

- Four keyless feeds supplying the facts the seats actually ask for: dated FRED series with
  history (net liquidity, its impulse over a stated window, the growth/inflation quadrant),
  company fundamentals derived from XBRL (owner earnings, NCAV, downside values, growth,
  incremental return on capital, leverage), published daily fund holdings from four issuers,
  and index aggregates (valuation, breadth, put/call, volatility).
- Look-through aggregation, so an operating-company method can read a basket. Absolute-currency
  facts have no aggregation path at all, and every aggregate carries the coverage weight it was
  computed over.
- Authored method logic. A seat may carry its real formulas and a real decision policy —
  eligibility, hard vetoes, scoring — instead of the generated identity proxy. A seat that is
  not authored is unchanged, so the set fills in one seat at a time.
- A reader-facing voice: five first-person fields per seat plus a `position_intent` that
  narrows the frozen stance and is rejected server-side if it does not.

### Fixed

- Classifier failed open: with no exchange metadata, common fund tickers were asserted to be
  operating companies; fund registrant SIC codes were read as evidence of an operating company;
  a fund named after an index was routed as a cash index, disabling its option chain.
- Japanese and Korean reports could never publish — a relabelled commentary section legally
  contains a section alias and won heading assignment, so the per-seat gate failed against PM
  prose permanently. The gate now anchors on the system section's content marker.
- Worker statements were interpolated raw into a system-owned section, so a statement
  containing a heading captured the section the quality gate validates.
- The status snapshot and the blocking gates disagreed about a seat with no status entry, so a
  recovered run reported complete while being hard-rejected.
- Declined seats no longer schedule an explanation worker; the stance is frozen and the record
  is already readable, so the worker cost one sequential model turn per seat and changed nothing.
- Fundamentals re-registered filing records under the consuming metric's period, silently
  dropping every fact that shared a record with the mechanical screen.
- The look-through aggregator was handed a nested object where it reads one number per ticker,
  so every aggregate refused while the constituents sat resolved in memory.
- `not_applicable` strings and the fund/index research contract were English-only inside
  localized reports.

### Assurance boundary

Unchanged. Build channel `solo_test`; admission `operator_lens`; `production_eligible=false`.
Authored formulas are AI-written and unreviewed, and record that in place of the
"mechanical identity proxy" limitation, which would otherwise be false. No human has reviewed
either kind. Method-seat outputs remain project-derived provisional lenses, not quotations or
current views of the named people.

## [0.9.5] — 2026-07-28

### Fixed

- Preserved Yahoo instrument metadata and classified operating companies, ETFs, mutual
  funds, cash indices and other market instruments before choosing a research route.
  SEC ticker/registrant names provide a fallback when quote metadata is unavailable.
- Stopped ETF/fund/index runs from invoking operating-company Company Facts or structured
  issuer financials. Those routes are now explicit `not_applicable` records rather than
  false research failures.
- Added role-specific ETF/index assignments for all eight evidence seats and a system-owned
  fund/index report section covering methodology, dated holdings/weights, concentration,
  fees/rules, liquidity/tracking/flows and disciplined aggregate valuation.
- Added readable deterministic statements for every completed or `out_of_scope` physical
  v3 seat. The full handoff ends with the exact selected-seat count and one statement per
  stable ID; an `all` selection therefore ends with all 26 method-seat statements.
- Returned the saved handoff inline from visible portfolio-manager completion and replay
  (`inline_user_response_v1`) so hosts do not replace it with an ACK-only recap.
- Strengthened `report_quality` from a Master Bench heading check to per-selected-seat
  readable and rendered statement coverage. Missing text or IDs now force
  `needs_revision`.
- Decoupled runtime package version from the unchanged PersonaPack snapshot. `0.9.5` keeps
  `persona_pack_version=0.9.4`, preserving existing pack hashes and simulation evidence
  instead of rerunning method validation for a routing-only release.

### Acceptance boundary

- Still `solo_test`, non-GA, `production_eligible=false`, `method_model_eligible=false`,
  with 26 provisional `operator_lens` packs and zero approved method models.
- This source change does not publish npm or mutate dist-tags. See
  `docs/releases/v0.9.5.md` for the full routing and delivery contract.

## [0.9.4] — 2026-07-28

### Fixed

- Canonicalized `zh-CN`/English/Japanese/Korean selection language before catalog, intent
  and receipt binding; `auto` now infers CJK prompts and unsupported explicit locales fail
  instead of silently presenting English as localized output.
- Rebuilt all 26 provisional physical v3 packs with four-locale selector copy. Chinese
  `method` fields are no longer copied English, and Japanese/Korean selection plus
  confirmation text is localized.
- Added reader-language enforcement for evidence, isolated method voice, Bull/Bear and PM
  packets. Plugin-managed workers use one bounded no-search repair before failing closed;
  visible-host recording rejects wrong-language packets before persistence.
- Added Japanese/Korean execution-failure, deterministic method and manager fallback copy;
  removed mixed-English system Master Bench and delayed-quote labels.
- Added report-language status to `report_quality` so an English report cannot pass a
  Japanese or Korean run.
- Revalidated the complete selection-record/receipt binding and recomputed `selection_hash`
  before consumption, so tampering cannot be persisted as audit evidence or burn a receipt.
- Replaced reader-facing snake-case best-for domains with reviewed four-language copy while
  preserving stable machine domain IDs outside the display fields.
- Required six ordered Bull/Bear round records and exact Round-3 Q&A before a visible full
  PM can complete; identical retries are idempotent and conflicting replays fail closed.
- Routed quick PM through the shared language/parse repair path and separated real
  timeout/transport/language failures from `DRY_RUN` and malformed-JSON failures.

### Acceptance boundary

- The package check now packs and offline-installs the physical tarball, starts the installed
  server, and proves 31 tools, 26 seats, all four selector locales, stable-ID confirmation,
  one-time receipt consumption and replay rejection.
- Still `solo_test`, non-GA, `production_eligible=false`, `method_model_eligible=false`,
  with 26 provisional `operator_lens` packs and zero approved method models.

## [0.9.3] — 2026-07-28

This is a **non-GA full-council runtime and reporting correction** on the `solo_test`
channel. It retains the `full_v2`/`quick_v1` contracts and all PersonaPack maturity gates.

### Added

- Plugin-managed headless full now has a hard 1,800,000 ms queue-to-terminal-persistence
  ceiling. Deadline expiry persists a fail-closed `incomplete` run with every affected role;
  it does not claim all-seat success under external provider degradation.
- Every selected physical v3 method now freezes its deterministic stance and then launches
  one isolated voice worker for that stable ID. The worker can explain but cannot alter the
  stance or manufacture missing typed facts. Output is explicitly a provisional method-seat
  result, not the named person's words or endorsement.
- Full handoff now lists all selected master IDs/stances/worker statuses, all eight mandatory
  analyst statuses/summaries, and a system-owned price snapshot or explicit quote-data gap.
- System-owned labels and failure text support Chinese (`zh-CN`), English, Japanese and
  Korean, while stable IDs and JSON keys stay unchanged.

### Changed

- The eight mandatory full evidence workers start in one parallel wave.
- Bull and Bear start in parallel inside each full debate round, while inter-round barriers
  and exact Round-2-to-Round-3 Q&A binding remain mandatory.
- Parse-only repair receives a separate bounded conversion budget and does not repeat the
  original evidence web research.
- Documentation now separates the enforceable plugin-managed headless deadline from visible
  host orchestration, whose external subagents the plugin cannot force-stop.

The ten-minute `quick_v1` contract is unchanged. Build channel remains `solo_test`;
`production_eligible=false`, `method_model_eligible=false`, operational seats = 0 and
validated `method_model` seats = 0. Formal production GA remains fail-closed.

## [0.9.2] — 2026-07-28

This is a **non-GA hotfix** for the bounded quick-council preview. `0.9.1` passed the
source, package and public-install smoke checks, but the first clean GitHub Actions matrix
exposed a cross-platform event-loop failure in the new hard-deadline path. Because npm
versions are immutable, `0.9.2` supersedes `0.9.1` on the `next` dist-tag.

### Fixed

- Grounding and linked-operation deadline timers now remain referenced until they abort or
  are explicitly cleared. The previous `unref()` calls allowed Node to exit while a timeout
  Promise was still pending when no other event-loop handle remained. That could cancel the
  grounding test on Linux, macOS and Windows and weakened the claimed hard deadline in
  short-lived hosts.
- A new isolated-process regression proves the linked abort deadline fires even when it is
  the only event-loop handle.
- The quick-analysis fixture now uses a Node `.cmd` wrapper on Windows, so the five-job CI
  matrix exercises the same fake worker behavior instead of silently producing empty output.

Quick/full scope, the 600,000ms ceiling, fixed evidence topology and all PersonaPack
assurance boundaries are otherwise unchanged from `0.9.1`. The production GA gate remains
intentionally failing.

## [0.9.1] — 2026-07-28

This is a **non-GA quick-council preview** published on npm's `next` dist-tag and as a
GitHub prerelease. The bare SemVer does not promote the PersonaPack assurance level: the
build profile remains `solo_test`, `production_eligible=false` and
`method_model_eligible=false`; all 26 named-investor packs remain provisional
`operator_lens`, not validated simulations of those people.

### Added

- A first-class `council_mode=quick` with a non-overridable ten-minute end-to-end ceiling.
  It runs four fixed evidence seats in parallel (`market_data`, `earnings_deep_dive`,
  `valuation_long_short`, `news_industry_management`), one to four selected method seats,
  one parallel Bull/Bear statement, and one short PM synthesis.
- `quick_v1`, a separate 13-section report contract. It records
  `full_council_equivalent=false`, one expected debate round and
  `adversarial_verification=not_run`; a passing quick report is never represented as a
  passing full council.
- A mode-bound selection receipt. Quick still displays the complete 26-seat catalog, but
  accepts at most four explicit seats and rejects `all`; a quick receipt cannot start full.
- An explicit terminal `degraded` state. A quick run may deliver when at least two evidence
  seats and at least one debate side succeeded and the PM plus all selected methods were
  recorded. A system-owned ledger names every failed/degraded seat and reason even when the
  report-structure check passes.
- A 120-day, `as_of`-bounded recent-news handoff. Undated, future and stale sources are
  excluded and counted as gaps instead of being mislabeled as recent news.

### Fixed

- Full analysis now fails fast before method, debate and PM model calls when mandatory
  evidence remains missing. The older RKLB runs spent another 16–43 minutes after the
  result was already guaranteed to be incomplete.
- Cross-seat prompts no longer resend raw transcripts or full report Markdown. Quick
  evidence keeps a bounded claim/source projection with referential integrity; full PM
  context retains bounded three-round summaries and exact Q&A while dropping artifact-only
  raw text.
- Worker and synthesis budgets share one quick deadline: grounding wait 20 seconds,
  evidence up to 210 seconds in one four-seat wave, up to four method seats in one 90-second
  wave, Bull/Bear in one parallel 90-second wave, PM up to 90 seconds, and 20 seconds
  reserved for deterministic finalization. These are ceilings, not a success guarantee.
- Failure fallback no longer emits a synthetic `Hold`; it records
  `NEEDS_MANAGER_REVIEW`, `decision_available=false` and no rating.
- `degraded` is recognized as terminal during polling and startup recovery. Evidence
  telemetry uses `evidence_degraded` rather than the misleading `evidence_complete` event.
- `npm publish --dry-run` no longer leaks `npm_config_dry_run` into the nested package-parity
  `npm pack`, which previously returned metadata without creating the tarball and caused a
  false release failure.

The production GA gate remains intentionally failing and is not bypassed by this release.
Formal GA requires a later monotonic version such as `0.10.0` or `1.0.0`, plus the existing
source, method-model, experiment, physical-host and signed-release evidence.

## [0.9.0-solo-test.3] — 2026-07-27

This is a post-acceptance hotfix for the **0.9.0 solo-test prerelease** channel. An
independent public-package RKLB run of `0.9.0-solo-test.2` completed in 23m12s with seven
of eight evidence seats, exact Round-2-to-Round-3 Q&A binding and all four selected v3
method seats declining out of scope. The run also exposed one code-zero malformed-JSON
worker response and a PM report that omitted Master Bench. Because those two defects left
the run incomplete, `.2` is not treated as a passing acceptance result.

### Fixed from the public `.2` rerun

- **Malformed worker output now fails closed.** A process that exits successfully but
  violates the one-object JSON contract produces an empty evidence packet. Its malformed
  output, parse error, bounded parse context, character count and SHA-256 stay in a separate
  `*.failure.json` diagnostic and cannot enter `evidence.json`, the source manifest or
  debate claims. The diagnostic is mode `0600` on POSIX; Windows ACL ownership is not
  independently verified by this release.
- **One parse-only retry is bounded by the original seat timeout.** The worker receives one
  fresh transport-contract retry without the malformed response being fed back. The first
  diagnostic is retained, `task_retry` is recorded, and a second malformed result remains
  fail-closed. The retry is allocated only the remaining configured worker budget rather
  than a fresh full timeout.
- **Recorded master opinions cannot disappear from the final report.** Master Bench is now
  a system-owned deterministic section. PM-authored bench headings are retained only as
  explicitly non-authoritative commentary, any prior system section is replaced, and one
  hash-marked table containing the frozen seat IDs, stances and verdicts is assembled before
  the quality gate runs.
- **Worker diagnostics are owner-only on POSIX.** Atomic JSON writes support an explicit
  file mode and the temporary file is set to `0600` before rename.

The package remains on npm's `next` dist-tag and the GitHub release remains a prerelease.
Stable `0.9.0` is still reserved for formal production-GA evidence. Assurance is unchanged:
26 provisional physical `operator_lens`, 52 provisional derived tools, 0 operational seats,
0 `method_model` seats and 0 human approval signatures.

## [0.9.0-solo-test.2] — 2026-07-27

This is a corrective **0.9.0 solo-test prerelease**, cut from a real RKLB acceptance run of
`0.9.0-solo-test.1`. It does not change the production assurance boundary: all 26 physical
packs remain provisional `operator_lens`; operational seats and `method_model` seats remain
**0**; human source/formula approvals and formal four-host GA evidence remain **0**.

### Fixed from the RKLB run

- **Full headless analysis no longer dies at the host's five-minute MCP deadline.** Real
  `analyze_symbol` calls now return a small accepted handle immediately, persist a
  receipt-bound `queued` run before returning, and are polled with `read_run`. Initialization
  and later background failures therefore remain inspectable under the original `run_id`.
  On restart, a dead-process background run is terminalized as
  `failed/server_interrupted`; active locked runs in another host process are left alone.
- **Leaf workers cannot recursively inherit user MCP plugins.** `codex exec` workers retain
  native web search but use `--ignore-user-config`, preventing an installed Codex search
  bridge from spawning nested Codex workers and consuming the entire per-seat timeout. The
  flag is placed after the `exec` subcommand and covered by an argv-order regression test.
- **Worker transcripts are no longer investment evidence.** A timed-out or failed analyst
  writes an empty-claim, low-confidence evidence packet and a separate `*.failure.json`
  diagnostic. Partial tool chatter, internal instructions and search logs cannot flow into
  `evidence.json`, the source manifest or the debate.
- **Partial evidence is named partial.** Runs with failed/timed-out tasks emit
  `evidence_partial` with successful/failed counts instead of an `evidence_complete 8/8`
  event merely because eight packet files exist.
- **Debate telemetry now proves the actual dependency order.** Every awaited Bull/Bear round
  emits `agent_round_completed`; the role enters `waiting` between rounds instead of staying
  misleadingly `running` while the opposite side executes.
- **Round 3 is now a real cross-fed Q&A.** Round 2 must save exactly three opponent
  questions per side; Round 3 receives those questions and must return exactly three ordered
  `{question, answer}` bindings. Each `question` must match the corresponding opponent
  Round-2 question exactly and in position, and every answer must be non-empty. The JSON
  schema now includes both fields, and any missing, reordered or substituted exchange fails
  the Q&A gate instead of being marked complete with `questions_answered=[]`.
- **SEC typed-fact source identity is canonical.** The same Company Facts record may support
  ROE and net-margin derivations without a false `source_id_collision`. The metric rule now
  belongs to derivation lineage, not source identity; the RKLB fixture consequently retains
  `financial.net_margin_5y` without inventing owner earnings, forward growth, liquidity
  impulse, realized volatility or ruin facts.
- **Chinese report-quality headings match the generated report contract.** The mixed
  `Master席位分歧处理` heading emitted by a Chinese PM now satisfies the conditional
  `master_bench` section instead of causing a false `needs_revision` result.
- **Chat handoff summaries stop at readable boundaries.** Chinese and English handoff fields
  prefer sentence or word boundaries and use Unicode code points, avoiding mid-sentence
  fragments and unpaired surrogate characters.
- **Headless verification claims are explicit.** `status.json` separates
  `source_id_presence_only` from adversarial verification and records verifier verdict count.
  The runtime skill now says plainly that headless execution does not run the host-visible
  three-verifier fan-out.
- **Codex MCP wiring no longer creates an OpenCode duplicate.** Codex uses the isolated
  `codex.mcp.json`; the ambiguous root `.mcp.json` is not shipped. The Codex interface icon
  is now included in the npm package.

The public package remains on npm's `next` dist-tag and the GitHub release remains a
prerelease. Stable `0.9.0` is still reserved for the formal production-GA gates.

## [0.9.0-solo-test.1] — 2026-07-27

This package is the first **0.9.0 solo-test prerelease**, not a formal production-GA release.
`package.json`, the Claude/Codex plugin surfaces, marketplace metadata and
`data/build-profile.v1.json` all declare `0.9.0-solo-test.1`.

The public package uses npm's `next` dist-tag and the GitHub release is marked as a
pre-release. Exact `0.9.0-solo-test.1` installation is supported while `latest` stays on the
production-facing 0.8.0 line and the stable `0.9.0` version remains unoccupied until the
formal GA gates pass.

### Solo-test assurance boundary

- Exactly 26 physical PersonaPack v3 packs are packaged under the isolated solo-test root.
- Exactly 52 executable tools are present, all marked `provisional_derived_proxy`.
- All 26 seats remain provisional `operator_lens`; operational seats: **0**;
  `method_model` seats: **0**.
- Human source approvals: **0**; human formula approvals: **0**; human approval signatures:
  **0**. Project-derived proxies are test fixtures, not named-investor method attribution.
- All 32 archived source candidates now have hash-bound machine pre-review artifacts. Three
  isolated AI roles produce 96 deterministic triage outputs with explicit questions and
  verdicts, while `human_reviewed=false` and `production_effect=none` keep the trusted
  human-review quorum and production gate fail-closed.
- The production loader rejects all 26 solo-test packs. Formal production assembly,
  cutover, rollback evidence and GA remain fail-closed until the outstanding human-review,
  experiment, host and release gates pass.
- Source and installed-package validation are now separated: a source checkout verifies its
  private/raw staging tree when present, while an installed package runs a real MCP selection
  and receipt-replay smoke instead of reporting a misleading zero-test pass.

Exact verification commands and the observed status are recorded in
`docs/solo-test-0.9.0.md`.

### Added in the first 0.9.0 increment

- **A mandatory per-run master chooser.** `begin_council_selection` freezes the current
  catalog and returns every seat with a stable number, identity, method, best-use case and
  maturity. `confirm_master_selection` accepts one seat, any combination, ranges, stable IDs
  or `all`, then issues a short-lived one-run receipt.
- **Server-side enforcement rather than prompt etiquette.** `plan_visible_run`,
  `collect_evidence` and `analyze_symbol` reject an absent, stale, replayed, cross-symbol or
  cross-intent receipt before creating a run or fetching data. Confirm and consume operations
  use exclusive file locks so separate host processes cannot spend the same selection twice.
  Run starts also hold an exclusive lock: concurrent retries create one lifecycle, while a
  completed same-receipt retry loads existing state instead of erasing packets or paying for
  the council again.
- **Text-complete four-host interaction.** Claude Code, Codex, OpenCode and Grok may enhance
  the chooser with native multi-select, but all share the numbered text grammar and the same
  MCP receipt. A named master is only preselected; the catalog is still displayed and the
  user still submits this run's choice.
- **Headless master execution.** The one-call analysis path now actually runs the selected
  masters between evidence and debate. A failed selected seat stays missing and prevents a
  false `complete` status.
- **Selection audit fields.** `status.json` records the catalog/selection hashes, selected,
  completed and pending masters, counts, per-seat state and the consumed selection ID.
- **The five missing requested seats are now selectable.** Damodaran, Ackman, Cathie Wood,
  Pabrai and Jhunjhunwala expand the active catalog from 21 to exactly 26. The complete
  26-seat solo-test tree now loads only through the explicit provisional path as
  `operator_lens`; none is mislabeled as operational or as a completed v3 method model.
- **Cryptographic PersonaPack admission and release foundations.** Experiment results now use
  Ed25519 attestations bound to the exact artifact/corpus/policy/tool/prompt hashes;
  `method_model` promotion stays fused closed until explicitly enabled after all gates pass.
  Source review and release operations each require two distinct trusted principals, so
  repeated keys or copied reviewer names cannot manufacture independence.
- **Immutable 26-pack publication and rollback.** The assembler accepts only one complete
  operational-or-higher 26-seat tree, verifies signed source-adjudication ledgers, embeds and
  hashes their evidence, then publishes by same-filesystem fsync and atomic rename. Signed
  cutover/rollback approvals produce immutable versioned pointer history.
- **A fail-closed GA verifier.** The real immutable release manifest is checked against the
  production pack hashes. A separate signed evidence document must cover Claude Code,
  Codex, OpenCode, Grok, the installed package, cutover and rollback. The previous unsigned
  combined-JSON shape is rejected rather than accepted as self-certification.

### In progress, not yet a production-GA claim

- Migrate all 26 seats to PersonaPack v3 with sourced doctrine, private research plans,
  typed computations, native decisions, hard vetoes, calibration and ablation tests.
- Pass the A-E comparison ladder: single-agent baseline; 8 analysts; 8 analysts plus selected
  masters; verifier-enabled council; and blinded human reference answers. Seat count is never
  treated as independent sample count.

Implementation tracker: `docs/plans/0.9.0-personapack-v3.md`.

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

### Wired into the live run

`plan_visible_run` takes the deterministic pass before spawning anything. A seat whose
method cannot reach the security is settled during planning and written straight into the
run as an `out_of_scope` opinion — the completeness gate is satisfied and no agent is paid
for a lens that had already declined. A seat that can look receives its settled verdict
inside the prompt and is told to explain it rather than choose one; `record_master_opinion`
then reconciles what came back, and a narrated stance contradicting the arithmetic does not
win quietly — the deterministic verdict stands and the disagreement is kept as
`narrated_stance`.

Two distinctions the wiring forced. Absent grounding is not a screen that computed nothing:
a run that was never measured falls back to v1 prompts instead of having its bench declined
on missing data. And a declined seat cannot merely be skipped, because the completeness gate
counts every selected master.

### Still open

The remaining seventeen masters, and `N_eff` — which needs an error-correlation matrix, which
needs resolved ground truth that does not exist yet. Investment return is recorded as a
long-run outcome and is never a gate.

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
