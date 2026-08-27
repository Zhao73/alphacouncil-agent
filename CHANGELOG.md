# Changelog

Notable changes per release. Dates are UTC.

## [Unreleased]

### Fixed

- Fast full councils now resolve an auditable candidate stage-aware Codex policy: low reasoning for
  evidence, method voices and debate, medium for the PM, and none for no-search repairs; the
  validated 5.6 Sol compatibility gate rejects unsupported effort values before worker launch.
  A global high-or-deeper fast override fails before queueing unless explicitly marked as an
  unvalidated diagnostic; normal and slow retain operator-selected global reasoning.
- Evidence, method, debate and PM timeout retries now debit the original seat/round lifecycle
  instead of receiving a second full stage cap. Fast reserves bounded repair slices inside the
  existing 15-minute allocation, records actual per-attempt reasoning provenance, and exposes
  the complete stage profile in persisted audit artifacts.
- Out-of-scope method prompts now forbid directional action vocabulary in every first-person
  field, including disagreement prose, so a substantive abstaining method voice can pass the
  existing action-safety gate without being replaced or falsely treated as a trade.
- Symbol news now applies a deterministic issuer-relevance gate after the date gate. Yahoo
  ticker RSS can return fresh but unrelated market syndication; the tool resolves the issuer
  name from the quote endpoint, retains only headlines naming the ticker or issuer, and reports
  excluded noise with samples instead of feeding it into research as company evidence.
- Full-council method execution now fails closed when any selected dedicated voice worker is
  missing or substituted. Only quick may continue with an explicitly disclosed deterministic
  fallback; full stops before Bull/Bear and the portfolio manager and records the missing seat.
- Debate timing now uses an explicit post-settlement barrier for each parallel Bull/Bear round.
  The start event remains a start marker, and real integration events—not reordered fixtures—
  prove that later rounds and the PM cannot begin before both sides settle.
- Run-bundle claim readiness now uses the runtime's canonical `model_voice` status, the PR matrix
  includes the release workflow's Node 24 runtime, and the forged-Host security regression uses
  raw TCP so client-side proxy/parser behavior cannot hide the server check.
- Pace selection no longer presents configured stage-budget arithmetic as a measured completion
  estimate. Each tier now exposes its persistence ceiling, configured stage budget and an
  explicit `observed_completion_status=not_validated` until preregistered live terminal evidence
  exists; the public READMEs state that 15 minutes is a terminal-persistence ceiling, not a
  proven successful completion time.
- Trigram similarity, character-length variance and one-run stance distribution are now
  monitoring findings rather than method-fidelity, seat-merging or release gates. A structured
  `out_of_scope` reason remains mandatory, while real fidelity stays blocked on preregistered,
  blinded, repeated-case review of facts, thresholds, rationale and counterfactual sensitivity.
- Evaluation and external-host artifact CLIs now provide `--help` output that makes their
  file-scoped npm `:check` contract explicit instead of leaving a bare `requires --file` error
  without the correct invocation.
- Integration RPC observers now derive from the exercised contract ceiling plus one shared
  15-second process-settlement allowance. Eleven already-faithful sites remain numerically
  unchanged, four under-sized observers are normalized, and deliberately early-return or
  path-bounded assertions stay explicit instead of inheriting a misleading full-pace timeout.
- The real-child RPC observer proof now keeps the legacy-to-contract timing ratio in a 2.5-second
  probe that runs outside the Windows serial group. Static assertions retain the production-scale
  15-second ceiling, 20-second legacy observer and 30-second derived observer relationships.
- Abstaining method voices now reject only subject-bound first-person trade actions. Sentiment
  words, research verbs and quoted third-party recommendations no longer turn a valid abstention
  into a `voice_contract_failure`; explicit buy, sell, add, trim and sizing commitments still
  fail closed in all four supported languages.
- An `out_of_scope` method result with no missing required fact is now labelled
  `abstain_policy_gate` instead of being misreported as a missing-fact failure, and the bench
  assurance count exposes that distinction.
- Budget-ahead checks now use the run's real total and deadline. A caller budget below the frozen
  stage-ceiling sum is disclosed as non-representable instead of triggering a vacuous early stop,
  and every checkpoint is persisted in `status.json`.
- Quick-run failure banners now say `incomplete` when the terminal contract is incomplete and
  reserve `degraded` wording for structurally complete runs that used a disclosed substitute.
- Windows caps the ordinary process-owning source phase at two files, then runs the three
  evidence-backed heavy-process files (`full-analysis`, `master-runtime-observability` and
  `packaged-host-parity`) as ordered single-file invocations. Real checkouts fail closed on a
  missing member; Linux and macOS retain the four-file source concurrency.
- The parse-retry failure test now gives its outer RPC observer enough time to cover both
  bounded worker attempts, with a deterministic delayed-response probe and a frozen Windows
  timing attribution report; runtime deadlines and failure assertions are unchanged.
- The advisory method-panel recommender no longer includes a physical pack when any required
  typed fact is missing. A family without a fully covered admitted pack is now reported as an
  explicit unfilled slot instead of throwing or recommending a known abstention.
- An `out_of_scope` method voice can no longer add buy/sell/hold-style language. The output
  now fails closed as `voice_contract_failure`, is omitted from published opinions and is
  rendered only as an explicit contract failure rather than silently replaced.

### Added

- Added an isolated ChatGPT Work developer-mode gateway using the official MCP SDK and stateless
  Streamable HTTP `/mcp`. Its 26-tool chat surface hides visible-host recorders and synchronous
  long calls, forces real councils onto durable `analyze_symbol` plus `read_run` polling, and
  leaves the canonical stdio runtime dependency-free. Public hosting remains blocked on OAuth,
  tenant isolation, stable HTTPS, quotas and live E2E evidence.
- Added a read-only public-release audit that reports source HEAD, GitHub main, the exact
  candidate PR, GitHub About/Release and npm dist-tags as separate machine-readable layers.
  Report mode records drift without blocking local work. The strict candidate gate checks the
  exact non-draft clean PR, base SHA, green checks and About truth before merge; the independent
  publication gate runs from main after release and no longer requires an open PR.
- Added an offline release-consistency gate that binds the candidate version, dated changelog
  section, measured physical-pack and MCP-tool counts, release tag and prerelease dist-tag.
  The tag workflow runs it before dependency installation or publication, rejects commits not
  on `main`, routes `rc.N` only to npm `rc` and GitHub prereleases, and fails closed on drift.
- Method-worker schema failures now retain the pre-truncation validation-error count, an explicit
  truncation flag, and at most eight bounded paths, keywords and missing or unexpected property
  names. The repair event and full-council TAP output expose the same structure without retaining
  rejected model prose or changing the one-repair fail-closed contract.
- Added a machine-readable terminal contract that distinguishes `complete`, `degraded` and
  `incomplete`, records every structural gap or substitute execution, gives portfolio-manager
  absence one exact reason, and terminates ahead of the global cap when the remaining frozen
  stage reservation cannot fit. Quick runs complete against their own one-round contract;
  dry-run plans no longer present unexecuted full debate as complete.
- Added Seat Fidelity Harness v1 for all 26 provisional operator lenses. It labels every
  policy record and structural parameter as an unsourced AI proposal, locks the pre-change
  policy subject, verifies 52 derivation bindings, exercises 118 fail-closed fact ablations
  and 34 hard-veto branches, and leaves three live-operand vetoes explicitly pending.
- Added a multilingual impersonation lint and fixed per-seat reader disclosures. The current
  evaluation corpus remains truthfully reported as zero cases; future rows must carry a
  point-in-time `case_as_of` boundary.
- Regenerated the AI machine-simulation artifacts because policy identity hashes changed;
  a parent snapshot proves their non-identity semantics are unchanged and keeps the n-eff
  disclosure byte-identical.
- Regenerated all 26 method-reference documents and their catalog to expose the new provenance
  labels and rebind identity hashes; stripped-corpus snapshots prove their other semantics are
  unchanged.
- Added a generated, hash-bound typed-fact producer catalog derived from the real grounding
  adapter's offline emission paths. It covers every fact reference and role in all 26 physical
  solo-test packs, distinguishes conditional production from no producer, checks tool-input
  contracts, and requires an explicit acknowledgement for every critical no-producer fact.
- Added frozen capability, voice-provenance and catalog-derived evidence-quality labels for
  each method seat. The final bench exposes their basis and catalog hash, and distinguishes
  model-free deterministic output, worker-failure fallback, missing inputs and no-producer facts.

## [1.5.0] — 2026-08-26

### Security

- Hardened the local GUI against script-context payload injection, unsafe outbound links,
  non-loopback Host headers and platform-specific file URL errors.
- Company-source retrieval now rejects private and ambiguous destinations, pins the vetted
  DNS answer for the connection and revalidates every bounded redirect hop.

### Changed

- Codex installation is Skill-first and the four supported hosts now share explicit 15, 30
  and 60 minute council tiers without advertising unverified live-host results.
- The English, Chinese and Japanese entry READMEs now lead with an executable first run,
  product benefits and honest limits; the detailed material remains under `docs/reference/`.
- Package inventory is evidence-derived, with the runtime closure and retained audit surfaces
  checked before publication. Contributor guidance now names four small offline starting points.

### Release

- Added a tag-guarded, two-job GitHub Actions release path for npm Trusted Publishing with
  OIDC, followed by idempotent GitHub release creation. Publishing still requires the owner
  to configure the exact trusted publisher and push the intended tag.

## [1.4.1] — 2026-08-13

### Fixed

- A method seat whose voice worker died is no longer deleted from the report. It used to leave
  the reader nothing at all — no statement, no stance, no reason — even though the seat's
  decision was frozen deterministically before the worker was ever spawned, and one such seat
  could take the debate and the PM with it. The same renderer that gives an abstaining seat its
  five first-person fields needs no model, so the seat now publishes that reading, labelled
  `deterministic_worker_failure` with the worker's failure kind, its public reason and its
  diagnostic path attached. What a dead worker costs is the model-written prose, not the seat.
- The fallback is deliberately narrow. It covers failures that left the seat MUTE — a stall, a
  killed process, exhausted provider quota, a rejected output schema. It does not cover a worker
  that spoke WRONGLY: forged source provenance, a contract breach or a reader-language violation
  still fails loudly and visibly, because quietly replacing a wrong answer with a clean one is
  the silent failure these gates exist to catch.

## [1.4.0] — 2026-08-13

A method seat that withheld its vote was answering the reader with a declination. Two of the
twenty-six did it on every symbol, and one of them was the valuation lens — so on a name whose
whole argument is valuation, the reader lost exactly the seat they most wanted to hear from.
A withheld vote is now a withheld vote, never a withheld view.

### Changed

- The out_of_scope voice instruction was written only for baskets — "classification,
  concentration, top holdings and weights … a basket it cannot fully underwrite" — so on an
  operating company the worker had no frame to fill and fell back to leading with what it could
  not do. It now demands the company itself, read through the method's own priorities, in every
  one of the five fields, with the same figures and source IDs a voting seat carries. Opening a
  field with the declination is explicitly forbidden; exactly one sentence in `would_i_act`
  states that no scored vote is cast and why. The stance itself stays frozen: a seat still
  cannot talk itself into a scored position its inputs do not support.
- `position_intent` distinguishes a method that ruled itself out from one whose inputs never
  arrived. `not_in_my_circle` is a judgment that stays true however much data arrives — an index
  lens looking at a single operating company. `inputs_unavailable` is the opposite: the method
  fits the company squarely, but a fact it requires is produced by no tool yet, so the vote
  waits on the pipeline. Reporting the second as the first told readers a valuation lens found a
  semiconductor company outside its circle, which is simply untrue.

### Fixed

- A timed-out evidence worker is retried once, within the run's remaining budget — the same
  stall already handled on the method bench, and more expensive here because a core evidence
  seat closes the evidence barrier and takes the whole council with it. Two consecutive runs
  died this way, once on `market_data` and once on `quant_factor`, while every other seat
  finished comfortably inside the cap (median 136s against 360s). The retry recovered
  `quant_factor` on the next run, so the cap was never the thing to raise.

## [1.3.0] — 2026-08-12

A full council could reach the end of its evidence phase in good shape and still hand the
reader a run with no rating. Three separate gates were all-or-nothing, and every one of them
could be tripped by a single seat, so the cost of one lost worker was the entire decision.
This release makes each of those gates proportional to what was actually lost, and re-cuts the
pace tiers against measured stage times instead of estimates.

### Fixed

- Sell-side consensus (`expectations.consensus_revenue_eps`) is no longer a critical coverage
  route. Every other critical id is obtainable from a filing, an issuer page or a free market
  source; consensus is licensed, so holding the decision barrier on it made `insufficient` the
  standing outcome for operating companies. The seat honestly reported `unavailable`, was
  retroactively demoted to `failed`, and that demotion aborted the council before any method
  seat, the debate or the PM ran. The route stays required and owned — the seat must still
  attempt it and declare an outcome — but an explicit unavailable now lands in `limited` and is
  published in the report's data-gap section.
- A failed supplemental analyst seat (`macro_regime`, `market_narrative`, `social_pulse`) no
  longer closes the evidence barrier. Those three own none of the 52 operating-company dossier
  routes, so their absence is a disclosed breadth gap rather than a foundation gap. The eight
  mandatory core roles keep the strict gate. Coverage degrades rather than reading as complete.
- A near-complete method bench now proceeds to the debate and the PM. One hung voice worker
  used to take the rating with it, on a bench where 25 of 26 seats had reported. At most two
  absent seats with at least eight recorded still debate; a materially unconsulted bench still
  stops. This never upgrades the run — the absent seats stay in `missing_masters`, the run still
  terminates `incomplete`, and the report still names every seat that never reported.
- A method voice worker that times out is retried once, within the run's remaining budget.
  Measured worker time is ~106s for the slowest of 26, yet failures landed at exactly the cap,
  on a different seat each run, at both 120s and 180s — a stalled spawn, not a seat that needed
  longer. A silence watchdog was measured and rejected: `codex` is legitimately silent for 15s+
  on a trivial prompt and emits its answer in one final chunk, so silence cannot separate
  stalled from busy.

### Changed

- `fast` and `normal` stage caps are re-cut against measured stage times. Evidence seats were
  finishing at 138–262s against a 210s `fast` cap, so roughly half the cohort was truncated;
  `normal` was leaving 495s of its 1800s budget unspendable while a voice worker timed out at
  exactly 120007ms and a 150s debate cap covered a measured 142s round by 5%. `fast` is now
  280s evidence / 110s method / 45s debate / 95s PM, `normal` 360s / 180s / 180s / 180s. The
  `normal` gate estimate moves from 22 to 25 minutes.
- `fast` is documented as an explicit best-effort tier. The measured floor for a COMPLETE
  three-round `full_v2` is ~1073s (262s evidence + 106s method + 3×142s debate + 108s PM plus
  grounding and persistence), so fifteen minutes cannot hold one however the stages are cut.
  `fast` spends its shorter clock on the stages that produce reader content and lets the debate
  take the shortfall; `normal` is the tier to reach for when the report must be complete.

## [1.2.3] — 2026-08-05

### Fixed

- Headless evidence and method workers now use bounded native structured-output envelopes.
  Segmented evidence transport reconstructs one canonical packet, and schema-aware arbitration
  accepts exactly one complete root while rejecting ambiguous or truncated alternatives.
- Operating-company source discovery now follows bounded issuer newsroom indexes to dated
  detail pages, preserves topic-balanced company news across a 120-day window, adds a dedicated
  management-change search, and retains direct official articles instead of only feed redirects.
- Dynamic market observations tolerate only a proven one-day local-calendar rollover against
  the same UTC `as_of`; historical, stale and future dates still fail closed. Derived price and
  source-acquisition fields retain their server-owned date, unit and provenance bindings.
- Full slow-all portfolio managers now receive every claim-level `contradicted`, `disagree` and
  `refuted` verdict as a hard override. They must acknowledge each finding exactly once as
  `excluded` or `corrected`; omissions, duplicates and extras fail the run before publication.
- The deterministic full report now includes a visible triple-verification correction table and
  annotates original analyst claims that failed a hard verifier. Refuted values may remain in the
  audit history but cannot silently survive in the final valuation, price bands or recommendation.
- Structured PM data gaps are limited to company and investment evidence. Internal file paths,
  filesystem visibility, tool permissions and execution-environment notes no longer belong in
  the investor-facing report.
- Regression coverage now exercises the dedicated headless PM schema, exact hard-finding
  acknowledgements, per-claim correction rendering, official management-news retention,
  timezone-bounded observations and the complete slow + all integration topology.

## [1.2.2] — 2026-08-05

### Fixed

- Source-acquisition `policy_id`, task ownership and source-ID scoping are now server-bound.
  Worker typos can no longer force a lossy rewrite of the complete evidence packet, and a
  ledger-only repair may bind `S1` only to an already-frozen task-scoped source.
- The fixed 52 acquisition routes belong only to the eight core evidence roles. `slow + all`
  still runs and freezes all eleven analyst packets, but `macro_regime`, `market_narrative`
  and `social_pulse` no longer fail on a synthetic zero-row plan.
- One `reported_actual` row may retain several disclosed metrics as typed observations rather
  than being rejected for lacking one artificial scalar. Observation history now keys metric
  and scope as well as period/unit/outcome, while missing numeric units or periods remain a
  hard failure instead of being guessed from the run date.
- Direct observations are now route-aware: cited exchange/market or local snapshots may support
  market and quant actuals, and a dated public estimate sample may support an expectations actual
  without being misrepresented as issuer guidance or full-market consensus. Recomputed proxies
  may use cited local/market inputs and multiple derived observations.
- A sourced domain may remain `coverage_items=covered` while its exact requested scalar is
  explicitly `unavailable`. This partial-coverage state requires shared source IDs, a concrete
  reason and the complete frozen terminal ladder; the exact unavailable scalar does not need a
  contradictory `succeeded` result. When a worker omits the ledger's copy of source IDs, the
  server binds only the already-validated matching coverage sources. It never invents a source.
- Worker-shaped input maps, numeric-string low/base/high ranges and known supplemental acquisition
  stages are normalized without weakening the frozen route audit. An external page-open marked
  successful without a resolvable source becomes `not_disclosed`; an incomplete actual, proxy or
  model becomes fail-closed `unavailable` with its `proposed_outcome` retained for audit.
- Cited non-official market pages now use the explicit supplemental `public_market_data` stage.
  Common worker spellings normalize to it without promoting the page to `market_official`,
  treating retrieval as a derivation, or bypassing any frozen terminal-stage attempt.
- An acquisition-only semantic failure receives one bounded no-search ledger repair. Claims,
  sources, coverage rows and official-news coverage remain frozen, preventing a repair worker
  from changing a valid dated URL or publication boundary while fixing ledger structure.
- Company evidence now has two disjoint repair budgets instead of one shared slot. A general
  transport/schema repair may be followed by one acquisition-ledger-only repair when—and only
  when—the repaired packet has already passed every non-ledger gate. The chain is capped at
  three total attempts, uses no search for either repair and records both diagnostics.
- Issuer-site discovery now ranks current earnings/results, event and financial-document detail
  URLs ahead of navigation/governance pages within a bounded ten-page fetch budget. A current
  release linked after a long IR navigation menu therefore reaches every analyst's starter pack
  instead of being recorded only as an unfetched URL lead.
- Headless Round-2/3 outputs now cross the exact-Q&A gate inside each worker's bounded repair
  path. One no-search repair receives the authoritative question arrays and may restore exact
  count/order/bindings; a second mismatch still terminates the debate fail-closed before PM.
- Schema-aware multi-root repair arbitration now applies the same lossless nullable-coverage
  normalization as the ordinary single-root path. One complete evidence packet beside a
  non-contract diagnostic can be recovered; two distinct valid packets or any truncated or
  malformed additional root remain ambiguous and are rejected.
- Full `slow + all` regression coverage now exercises eleven analysts, all 26 methods, all
  three verifier batches, the zero-verifier fail-closed barrier, VSH-shaped multi-metric and
  partial-coverage data, direct market/consensus observations, object-form proxy inputs,
  incomplete-model downgrades, supplemental-seat separation and a real ledger-only retry. The
  language fixture also uses an explicit `as_of`, so a UTC date rollover cannot create an
  unrelated news retry.

## [1.2.1] — 2026-08-05

### Added

- Fresh full operating-company runs now freeze `company_source_acquisition_v1`: an exact,
  issuer-driven source ladder for all 52 company-dossier coverage IDs. Fixed news feeds are
  only discovery attempts; every item escalates through the applicable regulator, issuer,
  market, local-history, customer, supplier, peer, counterparty, court, disconfirming-search
  and derivation stages before `unavailable` is allowed.
- The new keyless `get_company_sources` tool returns both the frozen acquisition map and a real
  starter evidence pack. It resolves the SEC filer, preserves the recent filing timeline,
  discovers issuer-owned domains from periodic filing text when the SEC profile omits website
  fields, probes same-site IR/news/filing/product pages, stores bounded excerpts with content
  hashes, and fetches dated company-specific topic feeds.
- Evidence packets now carry an audited `acquisition_ledger` with one row per owned coverage ID.
  Outcomes distinguish authorised `reported_actual`, cited `recomputed_proxy`, bounded
  `modeled_estimate`, exhaustively attempted `unavailable`, and genuine `not_applicable`.
  Runtime gates reject a bare gap, missing stages, unresolved sources, uncited actuals, and
  proxies/models without their formula, period, unit and inputs or assumptions.
- Successful actual, proxy and model observations are saved in a bounded per-company local
  ledger. A 90-day change appears only for like-for-like coverage ID, period, unit and outcome;
  the system never mixes fiscal vintages or backfills an unavailable history from model memory.

### Fixed

- Company news prefetch now applies an issuer-identity relevance gate. Broad market headlines
  emitted by a ticker feed no longer enter the shared dossier merely because the feed endpoint
  was ticker-scoped; exclusions and samples remain auditable.
- Issuer discovery retains distinct official subdomains. If an IR vendor blocks automated HTML,
  reachable official newsroom, corporate and product sites from the same filing remain usable,
  while the blocked attempt stays visible.
- All acquired filing rows, dated starter leads and issuer-document excerpts reach every
  evidence analyst prompt and the hash-bound company dossier. The status snapshot exposes
  expected/recorded acquisition rows, actual/proxy/model/unavailable counts, official-site
  discovery, and starter evidence totals.

## [1.2.0] — 2026-08-04

### Added

- Method-seat choice and analyst breadth are now two independent receipt-bound decisions.
  `analyst_scope=core` freezes the eight core evidence roles; `analyst_scope=all` freezes the
  canonical eleven-role roster and cannot be narrowed or expanded by execution arguments.
- The exact `slow + all methods + all analysts` path now inserts three mandatory, independent
  claim-complete verifier batches: `source_fidelity`, `rederivation`, and `refuter`. Zero,
  missing, duplicate, unexpected, or malformed coverage terminalizes the run as
  `needs_verification` before any method, debate, or portfolio-manager worker can start.
  Complete coverage with adverse/unresolved findings proceeds as `completed_with_findings` and
  transparently reduces the originating evidence seat's weight.
- Every operating-company method voice now acknowledges the canonical dossier hash and each
  selected evidence packet by task/hash with `used`, `reviewed_not_relevant`, or `unavailable`.
  The eight core acknowledgements are always required; all-scope runs add all three
  supplemental acknowledgements.
- Keyless market grounding now records one-year price/volume history, 20/63-session realised
  volatility, 5/21/63/126/252-session returns, benchmark-relative returns, and a local
  append-only ATM-IV observation history that publishes a percentile only after 60 daily
  observations.

### Fixed

- Section 16 retrieval is process-rate-limited, locally cached and fail-closed. Empty
  `notSubjectToSection16` filings and valid zero-holding forms no longer become parse failures;
  incomplete candidate coverage is labelled a lower bound instead of an exact ownership ratio.
- Every leaf `codex exec` now gives any unexpectedly inherited MCP/plugin process an isolated
  temporary AlphaCouncil data directory. A nested older plugin can no longer run startup
  recovery against the parent council's live `status.json` and `evidence.json`.
- A method voice that remains in the wrong reader language after the normal transport repair
  receives one final no-search, language-only translation pass. It must preserve the frozen
  stance, figures, source IDs, dossier hash and every packet acknowledgement; a third mismatch
  still fails the seat. Slow mode reserves 4m15s per method wave while retaining more than the
  required 90-second total scheduling headroom.
- Portfolio-manager price bands must be continuous and use one currency; gaps or overlaps can
  no longer pass the report contract.
- Verifier responses now have compact field bounds and source-fidelity workers must attempt every
  cited URL. Large ledgers use bounded, concurrently scheduled transport chunks whose keyed
  claim objects are enforced by Codex native structured output and then merged into one exact
  canonical batch. This reduces transport and deadline pressure without weakening the
  all-claim coverage gate.
- Source-fidelity transport uses smaller ten-claim chunks. A pure JSON/shape failure receives
  only the existing no-search transport repair; a real verifier-coverage failure receives one
  bounded web-enabled audit retry against the same frozen chunk, with exact claim IDs, reasons
  and missing URLs persisted before it runs. Neither path mutates analyst evidence.
- Rederivation still receives no original URL list and must independently query and recompute
  every claim. If that independent search lands on the same authoritative filing, the overlap
  is preserved as `agree_same_source_only` finding rather than being mislabeled as missing
  verifier coverage.
- The canonical all-analyst order is shared by the catalog, selection receipt and orchestrator,
  preventing a valid eleven-seat confirmation from failing when the registry file order differs.

## [1.1.9] — 2026-08-03

### Added

- Full operating-company decisions now freeze an auditable 52-item
  `operating_company_dossier_v1` across the eight mandatory evidence roles. The same complete
  `company_dossier.json` revision and SHA-256 binding reaches every selected method voice,
  all three Bull/Bear rounds and the portfolio manager.

### Fixed

- Missing, duplicated, cross-task, proxy, undated/future or unresolved dossier coverage fails
  closed before a rating. Dynamic quote and history pages use an explicit retrieval observation
  instead of a fabricated publication date, while genuine retrieval gaps remain visible.
- Evidence-only calls are labelled `evidence_only_v1`; public full `analyze_symbol` can no
  longer disable synthesis or shrink the mandatory eight-role roster through an override.
- Dossier hashing now removes runtime-only `undefined` values from grounding and source
  records, preventing a valid evidence run from crashing during artifact materialization.
  Nullable unused coverage fields receive only a deterministic empty transport normalization,
  and coverage failures expose exact bounded repair paths.
- Skill validation is repository-local and dependency-free instead of relying on one developer
  machine's absolute `quick_validate.py` path, restoring clean-checkout and multi-platform CI.

## [1.1.8] — 2026-08-03

### Fixed

- Parse-only repair outputs with multiple complete JSON roots now receive a schema-aware,
  deterministic arbitration step. The runtime accepts only one distinct contract-valid packet;
  two different valid packets, a truncated extra root, or no valid packet still fail closed.
- Initial worker output remains strictly single-root. The bounded arbitration is available only
  after the existing no-search repair attempt and applies consistently to evidence, method,
  debate and portfolio-manager packets without choosing between competing semantic answers.

## [1.1.7] — 2026-08-03

### Fixed

- Dedicated headless method voices now preserve over-structured prose entries as deterministic
  canonical JSON strings inside the three narrative arrays. This prevents one otherwise valid
  seat from blocking the 26-seat barrier when a worker returns a sourced object instead of a
  plain string, without loosening visible-input, source-ID, stance, confidence or PM contracts.
- Method-voice prompts now state explicitly that findings, disagreements and change-of-mind
  lists contain plain strings only. Structured-prose regression coverage proves the seat crosses
  the full council barrier without launching a parse-repair worker or losing authored content.

## [1.1.6] — 2026-08-03

### Fixed

- Full-council worker limits now inherit the pace selected at the one-run gate. Omitting the
  legacy timeout fields no longer cuts a slow evidence seat from twelve minutes to ten; explicit
  legacy values may still lower, but never enlarge, each evidence, method, debate or PM cap.
- Section 16 ownership now sums every distinct non-derivative holding bucket in an insider's
  newest document, including separately disclosed trusts and LLCs, while still excluding
  derivative awards. The ratio now uses the latest eligible point-in-time common-share count
  from SEC CompanyFacts instead of an annual weighted-average diluted EPS denominator. Any
  unresolved candidate Form now withholds the ratio, and every exact XML accession remains in
  typed-fact lineage.
- Revenue TTM growth must end at the newest visible regular period. It uses a same-period
  full-year/YTD bridge or the latest contiguous eight direct quarters and never searches back
  to an old clean window; the exact bridge inputs are included in fact lineage and hashes.
- Five-year share-count change now requires a physical P5Y endpoint interval, shares the same
  period matcher as deterministic method contracts, and never mixes instant common shares with
  weighted diluted averages. Shorter histories fail closed instead of being labelled five-year.
- Blank FRED CSV observations are discarded before numeric conversion, preserving true zeroes
  without contaminating macro history, percentiles or liquidity alignment with synthetic zeroes.
- The official SEC news surface is materialized deterministically from the already-grounded
  filing feed before source-coverage validation, so parse-only repair cannot fail on a copied
  canonical filing URL while issuer-official coverage remains worker-supplied and fail-closed.
  Future analysis cutoffs are rejected, and official coverage cannot extend past its actual
  grounding retrieval date.

## [1.1.5] — 2026-08-03

### Fixed

- Full headless portfolio-manager workers now return a compact, source-validated decision;
  the complete multilingual `full_v2` report is rendered deterministically in-process instead
  of embedding more than twenty Markdown sections inside JSON. Failed attempts retain bounded,
  owner-only length/hash/schema diagnostics without rejected model prose, and never fabricate a
  rating or high confidence.
- CBOE snapshot timestamps and underlying last-trade timestamps use their correct independent
  timezone semantics. Derived typed facts cannot predate any cited input, and the final fact gate
  drops missing-lineage or look-ahead records rather than silently accepting them.
- The news/industry seat must return structured regulator and issuer-official coverage with a
  dated latest item and checked-through boundary. Missing issuer coverage becomes an explicit
  gap, while prose-only claims that an official newsroom was checked fail closed.
- Slow handoffs report the actual 60-minute ceiling. Incomplete manager fallbacks state that the
  manager ran but failed its output contract, keep `rating=null` and `confidence=low`, and preserve
  every completed method statement at the end of the report.

## [1.1.4] — 2026-08-03

### Fixed

- Method-definition provenance and investment evidence now use separate source domains.
  PersonaPack `proxy:*` references remain auditable but can never satisfy a company-evidence
  gate, while every directional method voice is limited to real sources present in its
  bounded evidence context.
- Method workers persist each terminal seat into the canonical run record before the parallel
  barrier, survive interrupted-run recovery, classify provenance failures separately from
  transport parsing, and retain bounded hashed diagnostics without copying rejected prose.
- Method-voice prompts expose the exact allowed source IDs and one strict repair contract,
  removing the invalid `task:S1` example that caused all-seat schema repair failures.
- Quote output reports measured observation age and price basis instead of a fixed delay claim.
  SEC submissions retain the authoritative latest filing, options grounding includes open
  interest and observation time, and split-adjusted dilution keeps the true share-history
  period.
- Source IDs are bounded and reject whitespace/control characters across evidence, debate,
  method-voice and typed-fact contracts. The `/alpha` command metadata is valid YAML on every
  generated host surface.

## [1.1.3] — 2026-08-03

### Fixed

- Parse-only schema repairs now receive pace-aware, deadline-safe budgets instead of a fixed
  30 seconds, and receive bounded validator paths plus the exact evidence contract without
  being allowed to search or invent sources.
- Full reports and chat handoffs both end with the complete selected-seat ledger. Missing
  evidence is reported as incomplete coverage, and unpublished runs no longer advertise a
  publication marker that does not exist.
- SEC split conversion facts now prevent stock splits from being misclassified as economic
  dilution. Unverified split-like jumps fail closed for manual adjustment rather than becoming
  a pass or an elimination.
- Evidence prompts must retain available options open-interest data and verify regulator plus
  issuer-official news coverage before making a no-event claim. Failure reports now route
  forward-expectations and earnings-deep-dive packets into their current sections.

## [1.1.2] — 2026-08-03

### Fixed

- Installed Codex source caches now run the dependency-free package smoke instead of mistaking
  bundled test folders for a developer checkout and trying to import absent AJV/fast-check
  devDependencies.
- The Codex plugin manifest carries its MCP server entry inline, satisfying current plugin
  ingestion without adding a root `.mcp.json` that OpenCode would auto-import as a duplicate
  server. `codex.mcp.json` remains as the explicit compatibility wiring.

## [1.1.1] — 2026-08-03

### Fixed

- Terminal MCP responses now return the complete persisted handoff, including the final
  statement for every selected method seat. `read_run` adds explicit compact/full detail
  levels so large evidence and report bodies no longer crowd the handoff out of text-only hosts.
- Evidence, method, debate and PM packets fail closed on hollow schemas or unknown source IDs;
  PM output can no longer become a synthetic Hold when rating or authored report content is
  absent.
- Final artifacts use durable atomic writes and a hash-bound publication marker committed only
  after terminal evidence, status, source, decision, quality and every delivered Markdown file.
  Event logs now carry a verified append-only hash chain and recover only a trailing half-line.
- Worker outputs have bounded UTF-8-safe reads, bounded diagnostics and no untrusted whole-file
  allocation. Selection/receipt and lock recovery are crash-tested before this release is
  installed.

### Changed

- The provisional public-method bench contains 26 seats; the retired AI-genius seat is absent.
  Every selected seat receives the same validated evidence pack and produces a strong
  first-person public-method simulation after its deterministic stance is frozen.
- Omitting `read_run.detail` now selects the bounded `compact` payload. Callers that require the
  legacy multi-megabyte structured body must request `detail=full`; terminal text remains the
  complete persisted handoff in both modes.

## [1.1.0] — 2026-08-02

### Added

- **Visible runs now have a real fail-closed terminal operation.** `finalize_visible_run`
  closes a host-orchestrated run as `incomplete` when an evidence, method or debate worker
  cannot cross its barrier. It preserves completed records, writes the standard no-rating
  report/artifact package, returns `inline_user_response_v1`, is idempotent, and rejects late
  worker writes instead of letting a terminal run drift back to `running`.
- **Local GUI and TUI clients.** The run viewer exposes saved council artifacts without
  digging through the hidden data directory, while the terminal meeting view carries the
  project mark, progress, readable portraits and transcript-style council output.

### Fixed

- **Every selected method seat is now forced into the final handoff ledger.** Completed seats
  retain the full recorded `voice_statement` with no character clipping. Failed or unavailable
  seats remain visible as `statement_status=not_produced` with status/reason and explicitly do
  not become a directional vote.
- **Handoff quality is independently gated.** `report_quality.json` schema 3 verifies the
  system-owned tail markers, selected-seat count, frozen order, per-seat coverage, verbatim
  statement preservation and that no section follows the method ledger. A valid full report
  can no longer hide a shortened or truncated chat handoff.
- Visible v3 policy failures retain their stable error code and bounded diagnostic, so input
  contract and deterministic-policy failures are distinguishable without inventing an opinion.
- Quick recent-news regression coverage now uses a fixed `as_of`, so the future-source gate
  does not change merely because the calendar advanced.

### Changed

- The MCP surface now contains 32 tools after adding `finalize_visible_run`; packaged host
  parity, smoke tests and all three READMEs carry the same count.

## [1.0.15] — 2026-07-30

### Changed

- **Listed in the official MCP Registry** as `io.github.Zhao73/alphacouncil-agent`:
  `server.json` added, and package.json carries the `mcpName` field the registry uses to
  verify npm ownership. No runtime change.

## [1.0.14] — 2026-07-30

### Changed

- **Method seats speak like a person with a view, not a form being filled.** The voice
  worker is now instructed to write each of the five first-person fields as two to four
  complete sentences in the method's own characteristic register — what it reaches for
  first, the standard it holds the number to, and why this number settles it — and those
  five fields are exempt from fast-tier prose compression, because they are the worker's
  deliverable, not restatement.
- **An abstaining seat now explains itself in first person instead of reciting a gate
  code.** Both deterministic abstention templates (gate-closed and record-missing) grew
  from one formula sentence into a short statement of the method's own discipline: what it
  checks first, what was absent this round, why guessing without it would stop being a
  method, and that the seat returns the moment the inputs arrive. The load-bearing
  sentence — an abstention is neither bearish nor a vote against the asset — is unchanged
  in every language.
- **The bench no longer glues twenty-five abstaining seats into one run-on paragraph.**
  Each abstained or declined seat renders as its own quoted block under its own name, and
  a per-seat statement composed from the five voice fields renders as labelled lines
  rather than one joined sentence.
- The READMEs document `ALPHACOUNCIL_VOICE_ABSTAINING_SEATS=1` for operators who want
  abstaining seats voiced by a full worker as well.

## [1.0.13] — 2026-07-30

### Fixed

- **Screen rules pair both series by fiscal period end, never by array position.** Every
  two-series elimination rule (`roe_10y`, `gross_margin`, `interest_cover`, `fcf_5y`,
  `ocf_over_ni`, `net_margin`) used to slice the last N entries of each series independently
  and divide position-by-position. A gap in one series — a tag the filer stopped using, a
  year reported under an out-of-catalog alias — shifted every later year onto the wrong
  counterpart while the provenance block still showed a clean range: this year's EBIT divided
  by a two-year-old interest figure read as a confident 2.5x cover, and an equity series
  missing one middle year shifted a decade of ROE by one year. Rules now drop a year present
  on only one side, report the pair count as their coverage, and `interest_cover` is
  `skipped` when the latest EBIT year has no same-period interest figure — a stale
  denominator is a gap, not a cover ratio. Four regression tests pin the misalignment
  scenarios.
- **The SEC universe cache in peer matching expires after six hours** instead of living for
  the whole MCP process. A resident server that never re-read the ticker file silently lost
  every new listing and rename from `industry_peers`, with no gap recorded anywhere.

### Changed

- **The three READMEs, CLAUDE.md and INSTALL.md now agree on the counts**: 27 selectable
  lenses (the bench table had listed 26 — Bogle was missing), 31 keyless MCP tools, 54
  solo-test proxy tools. INSTALL.md no longer pins its examples to 1.0.0.
- **README leads with the recorded demo and a 30-second zero-cost first run** (`/alpha AAPL
  news`), links a complete real full-council report
  (`docs/examples/final_report.SOX.zh.md`), states the Codex CLI prerequisite for headless
  paths next to the install commands instead of below the fold, and compresses the
  governance status into one honest sentence linking the release contract.
- **SECURITY.md discloses what was already true**: `preflight_permissions` reads host
  configuration files read-only to detect silent web-search downgrades, workers run in a
  read-only sandbox, and the supported-versions line no longer claims the project is
  pre-1.0.

## [1.0.12] — 2026-07-30

### Changed

- **The depth tier is asked at the selection gate instead of typed as an argument, and the menu
  publishes the predicted time.** `begin_council_selection` now returns `pace_options`: one row
  per tier carrying `expected_minutes`, `hard_ceiling_minutes`, the per-seat evidence budget and
  the per-round debate budget. Both numbers are published on purpose — a ceiling shown on its own
  reads as the estimate, and then every `fast` run looks like it takes fifteen minutes when the
  serial worst case is twelve.

  ```
  本次分析要跑多深？（默认 2）
    1. 快速   预计 ~12 分钟（上限 15）  每证据席 3.5 分钟，每轮辩论每侧 90 秒
    2. 标准   预计 ~20 分钟（上限 30）  每证据席 6 分钟，每轮辩论每侧 150 秒   ← 默认
    3. 深入   预计 ~44 分钟（上限 60）  每证据席 12 分钟，每轮辩论每侧 360 秒
  ```

  The tier is the gate's second decision, so it is taken in the same interaction as the seat
  catalog and **binds into the receipt**. An execution call may repeat the confirmed tier but
  never change it: a user who approved fifteen minutes cannot end up running an hour, and the
  reverse cannot happen either. `status.json` records which tier produced the run.

  A speed named in the request (`/alpha NOW slow`) is now a **prefill**, exactly like a named
  master: it highlights the row, the menu is still shown, the answer is still taken. No answer
  means `normal`. Quick returns an empty menu and rejects the field.

### Fixed

- **A tier confirmed at the gate was lost at consumption.** `council_pace` reached the receipt
  but not the consumed selection, so a run approved as `slow` silently fell back to the
  30-minute default with nothing in the record showing the switch — and the execution-time
  mismatch guard could not fire because it had nothing to compare against.

## [1.0.11] — 2026-07-30

### Fixed

- **A depth tier was a timeout with no plan behind it, so `fast` bought unfinished work rather
  than faster work.** 1.0.10 shipped three tiers that all sent the identical prompt: `fast` asked
  every worker for exactly the same output with 40% less time, which does not produce a faster
  good packet — it produces one the worker could not finish, arriving `degraded` or not at all.
  There was no pace awareness anywhere in the prompt layer.

  A tier now shapes the worker's output as well as capping its clock. Because an LLM call's wall
  clock is dominated by the tokens it generates, running faster without losing information means
  asking for the same information in less prose:

  - `fast` — at most six arguments, one to two sentences each, cite a source ID instead of
    re-quoting the evidence, no opponent recap, no methodology preamble. Every figure, every
    scoped source ID and every required report section stays mandatory; price levels and
    invalidation conditions may not be compressed, because they are the only actionable part of
    the report. Dropping an argument is acceptable; dropping a source ID or filling a number from
    memory never is. A short packet that names its gap beats a complete-looking one built from
    memory.
  - `slow` — write the derivation out step by step with its basis, assumptions and sensitivity;
    handle the opponent's arguments one at a time; state your own falsification conditions.
    Longer is not better, so repetition still gets cut.
  - `normal` — adds nothing at all, so its prompts stay byte-identical to the reviewed golden.
  - Quick keeps its own existing shaping and receives no tier, so no prompt ever carries two
    different length budgets.

  The shaping reaches the evidence seats, both debaters, the PM and the method voice workers, in
  the run's language.

## [1.0.10] — 2026-07-30

### Added

- **Three full-council depth tiers, selected with `council_pace`: `fast` 15 minutes, `normal`
  (default) 30, `slow` 60.** All three are the same `full_v2` contract — eight evidence seats,
  every selected method, three debate rounds, the PM — so a tier changes how long each seat may
  think, never which seats run. Quick rejects the field: it is a smaller contract, not a slower
  one. The tier is recorded in `status.json`, because two runs of one symbol at different paces
  are not the same analysis.

  A tier moves every per-stage cap together with the total, which is the part that actually buys
  depth. Raising only the total would leave a 60-minute run finishing in twenty minutes with
  forty idle, because what bounds each worker is its per-stage cap; lowering only the total would
  starve the later stages and terminate `incomplete` with the debate missing.

  | `council_pace` | total | evidence / seat | method / seat | debate / round | PM |
  | --- | --- | --- | --- | --- | --- |
  | `fast` | 15 min | 3.5 min | 1 min | 90 s | 2 min |
  | `normal` | 30 min | 6 min | 2 min | 150 s | 3 min |
  | `slow` | 60 min | 12 min | 4 min | 6 min | 8 min |

  `/alpha <TICKER> fast` and `/alpha <TICKER> slow` reach it from the command surface. A test
  pins the property that makes a tier coherent: every tier's stages fit inside its own budget
  with headroom, and no stage cap is allowed to stay flat as the tier widens.

### Changed

- **The full-council ceiling is now the selected tier's total rather than a single 30-minute
  maximum.** A caller or environment may still only lower the applicable budget; a
  `total_timeout_ms` above the tier's total is rejected and names the tier that would allow it.
  `ALPHACOUNCIL_FULL_TOTAL_MS` becomes an operator cap that only ever lowers a tier, instead of
  doubling as the default budget — as the default it silently held the 60-minute tier to 30.

## [1.0.9] — 2026-07-30

Seven fixes found by auditing one real 148-minute visible NOW council against its own
artifacts. Every one of them was quiet: the run produced a complete report each time.

### Fixed

- **A hashed hard veto made two seats guess, in writing, which condition had vetoed them.**
  Condition ids are hashed before a policy runs so the decision layer cannot recognise the seat.
  The voice layer reversed that for scoring conditions but not for vetoes, tool output ids or
  `common_projection.veto_ids`, so a seat published `anon_e41f54d07b56b0ff5` where it meant
  `master_marks.euphoria`. Both vetoed seats on NOW speculated their veto came from a
  424.67% dilution figure that was a stock-split artefact; the actual veto was a market-level
  reading. Past the freeze the seat is named in the report and in its own worker prompt, so the
  hash protected nothing. Also fixes a latent mis-mapping: the positional fallback assumed the
  executor returns hits, misses and uncomputable rules in declaration order, and would have
  published two condition names swapped for any seat with a mixed split.
- **`plan_visible_run` returned 311,007 characters and the host rejected the whole plan.**
  Prompts now always land in `<run>/prompts/` with `prompt_file` on every agent spec, and
  `prompts_inline: false` says the bodies were left out on purpose. What drives the size is the
  grounding each prompt embeds, not the seat count.
- **A portfolio-manager packet with no `report_markdown` was accepted, then failed the report
  gate with 21 missing sections.** The gate could only run after assembly, so the whole PM turn
  was spent first. Submission now rejects a body that cannot pass, before the idempotency lock,
  and names each owed section with the heading to use. System-appended sections are never asked
  of an author. The revision path stays for defects only the assembled report can see.
- **One absent XBRL alias killed three facts on a company whose debt is on the face of its
  balance sheet.** ServiceNow's FY2020 and FY2025 balance sheets carry no straight debt tag: the
  only debt instant either year is `ConvertibleLongTermNotesPayable`. Total debt therefore read
  as unknown, and because unknown debt is correctly refused rather than treated as zero,
  leverage, downside asset value and incremental return on capital all died — which is why a
  seat requiring incremental return on capital abstained. The convertible aliases are appended
  last, where an earlier alias still wins a year outright, so coverage is strictly additive: a
  filer that resolves its debt today resolves to the identical number. On real ServiceNow
  Company Facts this turns four recorded gaps into one.
- **A rate-limited filing document was lost where a rate-limited JSON call was retried.** Every
  SEC JSON endpoint backed off on 429/503; `fetchFilingDocument` threw on the first one, so the
  documents carrying the actual disclosure were the easiest evidence in a run to lose, on the
  path SEC throttles hardest.

### Changed

- **A seat's statement reaches the handoff instead of its metadata.** The per-seat line led with
  the first 520 characters of background and put the frozen-record tag in the same sentence, so
  the part always cut was the seat's conclusion — seven seats that all spoke read as seven seats
  that had not. Each seat now leads with the reading that decided it and the action it implies,
  quotes its statement at a budget that survives a paragraph, and carries provenance on its own
  line.
- **A frozen abstention no longer spends a model worker to restate itself.** A seat whose gate
  never opened has no reading to explain, and its deterministic statement now names the
  condition that closed the gate and states that an abstention is not a bearish vote — all an
  `out_of_scope` seat is asked to say. Four such seats took most of the method phase on NOW.
  `ALPHACOUNCIL_VOICE_ABSTAINING_SEATS=1` restores a worker for every seat.
- `insider_sec` carries an explicit EDGAR retrieval order, a same-URL backoff rule, and a
  mandatory degradation rule. On NOW it tried eight different URLs in a row, was rate-limited on
  all of them, and read no original filing.

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
