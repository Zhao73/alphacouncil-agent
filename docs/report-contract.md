# AlphaCouncil Report Contract

This contract prevents final handoffs from collapsing into a thin recap. The chat handoff
may stay concise, but saved artifacts must preserve the evidence chain and must identify the
contract that actually ran. `quick_v1` is not a shorter claim of `full_v2` completion.

## Shared Required Outputs

Every terminal `analyze_symbol` run, and every completed full visible portfolio-manager run,
writes the mode-appropriate versions of:

- `final_report.md` - the auditable report for this run's contract.
- `user_response.md` - concise user-facing handoff with status and important content.
- `artifact_index.md` - file map for every JSON and Markdown artifact.
- `<evidence_role>.md` - one readable Markdown file per planned evidence analyst.
- one Markdown/JSON artifact per recorded master method.
- `bull_researcher.md`, `bear_researcher.md`, `portfolio_manager.md` when those stages ran.
- `report_quality.json` - machine-readable report-structure result and contract metadata.
- `status.json`, `events.jsonl`, `evidence.json`, and `source_manifest.json`.
- `company_dossier.json` for an applicable full operating-company run, containing the frozen
  `operating_company_dossier_v1` evidence snapshot, its coverage ledger and content hash.
- `<task>.failure.json` for a worker failure, kept separate from investment evidence.

`artifact_index.md` lists `publication_manifest.json` only when report quality has passed and
the terminal publication step is expected to create that commit marker. An incomplete or
`needs_revision` package does not publish a dangling path to a marker that does not exist.

The report and handoff must call a named master result a recorded method-seat or lens result.
It is not a quote from, endorsement by, or current statement of the named person.

The run classifies its instrument before selecting financial-data routes. Operating-company
Company Facts and issuer financials are not applicable to ETFs, funds or indices. ETF/fund
runs use holdings look-through; index runs use aggregate-index evidence. Missing dated
holdings, constituents, weights, methodology, fees/rules, liquidity/tracking/flows or
aggregate-valuation coverage remain explicit gaps and are never replaced with invented fund
revenue, EPS, guidance, insider activity or summed constituent financial statements.

System-owned selector, report and handoff labels are localized for `zh-CN`, `en`, `ja` and
`ko`. Each worker receives the canonical run language, while stable IDs and JSON field names
remain English. Reader-facing evidence, method, debate and PM fields are checked against the
requested locale. Plugin-managed workers receive one bounded no-search language/JSON repair,
then fail closed; visible-host record tools reject the wrong-language packet before writing
it so the host may retry. `report_quality.json` records requested/observed locale, keeps
Han-only fragments explicitly inconclusive, and cannot pass a Japanese or Korean run whose
report body is English. Unsupported explicit selector locales are rejected instead of being
silently mislabeled as localized English.

## operating_company_dossier_v1 Contract

`operating_company_dossier_v1` is the shared, point-in-time public-evidence snapshot for a
full operating-company council. It is required for both US and non-US operating companies in
non-dry `full_v2`; it is not a quick-council artifact. It does not apply to ETFs, mutual funds
or cash indices. Those instruments continue to use `fund_lookthrough` or `index_aggregate`
and their own dated holdings, constituents, methodology and aggregate-coverage rules. A fund
or index must never receive an `operating_company_dossier_v1` label merely because it has a
ticker, SEC registrant or generated evidence file.

The dossier is not a claim that AlphaCouncil read the whole public internet. Public web search
has no finite, provable endpoint. The contract instead defines a finite decision-relevant
coverage roster. Every roster item must be accounted for exactly once with source lineage or
an explicit gap. Search results are locators, not evidence by themselves; a material claim
still needs a source ID that resolves inside `source_manifest.json`. Every source and fact
retains its publication/public/retrieval time, period, unit, currency and point-in-time
boundary where applicable. Post-`as_of` information, model memory and an uncited remembered
number are excluded.

Non-US names use the same coverage contract with the issuer's local regulator, exchange and
IR documents. A configured structured regulator adapter may improve extraction, but a
customer API key or extra package is not part of this contract. If the structured route is
not configured, the worker must attempt the public primary-document route and record the
remaining limitation; it may not substitute a US peer or model memory.

### Fixed 52-item coverage roster

The 52-item core roster is owned by the eight mandatory full evidence roles. The independent
`analyst_scope=all` choice adds `macro_regime`, `market_narrative`, and `social_pulse`, for
exactly eleven receipt-bound packets; those supplemental analysts add evidence but do not
replace or waive any core item below.

- `market_data` (6): `market.identity_listing_currency`, `market.quote_snapshot`,
  `market.price_history_range`, `market.liquidity_volume`, `market.technical_levels`,
  `market.relative_performance`.
- `earnings_deep_dive` (10): `financials.business_model`,
  `financials.latest_reported_period`, `financials.historical_statements`,
  `financials.balance_sheet_liquidity`, `financials.cash_flow_capex`,
  `financials.segments_geography`, `financials.margins_returns_quality`,
  `financials.customer_supplier_concentration`, `financials.guidance`,
  `financials.earnings_call_qna`.
- `forward_expectations` (5): `expectations.consensus_revenue_eps`,
  `expectations.estimate_dispersion_revisions`,
  `expectations.implied_beat_miss_thresholds`, `expectations.ratings_target_changes`,
  `expectations.next_reporting_date`.
- `quant_factor` (6): `quant.momentum_trend_volatility`,
  `quant.relative_strength_factors`, `quant.liquidity_volume_regime`,
  `quant.short_interest_borrow`, `quant.options_iv_skew_expected_move`,
  `quant.peer_cross_section`.
- `valuation_long_short` (6): `valuation.trading_multiples`,
  `valuation.peer_comparables`, `valuation.dcf_reverse_dcf`,
  `valuation.bear_base_bull`, `valuation.catalysts_invalidation`,
  `valuation.long_short_asymmetry`.
- `news_industry_management` (8): `news.regulator_timeline`,
  `news.issuer_ir_newsroom`, `news.recent_company_developments`,
  `news.industry_competition`, `news.customers_suppliers_partners`,
  `news.management_board_changes`, `news.regulation_litigation`,
  `news.disconfirming_search`.
- `insider_sec` (6): `ownership.insider_transactions`, `ownership.ownership_control`,
  `ownership.buybacks_dilution`, `ownership.debt_liquidity_capital_allocation`,
  `ownership.governance_related_parties`, `ownership.accounting_controls_restatements`.
- `ib_event_analysis` (5): `events.mna_strategic_transactions`,
  `events.capital_markets_financing`, `events.restructuring_spinoff`,
  `events.material_contracts_commitments`, `events.event_calendar`.

The authoritative roster is fixed independently of a caller-supplied task subset. A full
operating-company run cannot become coverage-complete by planning fewer than all eight
mandatory roles, and an all-scope receipt cannot become complete with fewer than eleven
analyst packets.

### Coverage-item semantics

Each role returns one `coverage_items` row for every ID it owns. An ID is missing if it is
absent, duplicated, renamed or replaced by an unexpected ID.

- `covered`: at least one `source_ids` entry is present and every ID resolves to that packet's
  evidence-domain source. The resolved source must belong to the same task namespace, must not
  be a PersonaPack/proxy source and must use an HTTP(S) URL. A static document needs a parseable
  `published_at` no later than the run's `as_of`. A directly fetched dynamic quote, history table
  or live aggregate/index page that genuinely has no publication date keeps
  `published_at: unknown`, declares `source_kind: dynamic_snapshot`, and records its actual ISO
  retrieval observation in `observed_at`, also no later than `as_of`. `retrieved_at` alone does
  not silently waive this check, and an ordinary undated article cannot use the dynamic label.
  Every `news.*` item and every `events.*` item except `events.event_calendar` still needs at
  least one genuinely dated source. `covered` means the named domain has usable public evidence;
  it does not mean every possible fact in that domain was published or found.
- `unavailable`: the worker actually attempted a named public route and still could not obtain
  usable evidence. It must record the concrete `attempted` route, at least one valid HTTP(S)
  locator actually tried in `attempted_urls`, and a non-empty `gap`; the exact same gap must
  appear in `open_questions`. Not researched, omitted for time, a missing optional adapter key,
  or a search snippet without the underlying document is not silently `covered`.
- `not_applicable`: the instrument or fact genuinely has no such field and the row carries a
  concrete reason consistent with the classified operating-company route. It cannot be used
  to avoid an applicable check. A field that should exist but could not be fetched is
  `unavailable`, not `not_applicable`.

Coverage accounting and evidence sufficiency are separate axes. Coverage is `complete` when
all 52 IDs appear exactly once and every row satisfies the structural/source/gap rules. A
coverage-complete dossier may still contain many `unavailable` rows, contradictory evidence,
stale observations or method-critical fact gaps. Those conditions lower the separately
reported evidence sufficiency and may make individual methods `out_of_scope` or the whole run
`incomplete`. Conversely, one rich packet never excuses a missing coverage row. Status,
evidence coverage, dossier coverage, evidence sufficiency, verification and report quality
must remain independently visible; `report_quality=passed` cannot upgrade any other axis.
An `unavailable` or `not_applicable` row on the fixed critical subset is a decision barrier,
even when all 52 rows are structurally accounted for.

### company_source_acquisition_v1

Every fresh full operating-company run freezes a company-specific acquisition plan before an
evidence worker starts. The plan is generated from the resolved issuer identity and regulator
profile, never from a single-ticker exception list. For SEC filers the keyless prefetch retrieves the
submissions timeline, probes the issuer's disclosed IR and corporate sites, follows a bounded
set of same-site earnings/news/filing/product links, stores content hashes and excerpts, and
queries dated company, financial, customer/supplier/capacity, product/delivery/quality,
regulatory/litigation and management/capital-allocation feeds. These starter records and their
failed feed attempts are included in the one dossier shared with every analyst and method seat.
Within the bounded issuer-site crawl, current earnings/results detail pages, event pages and
financial documents rank ahead of generic navigation and governance pages. The order in an IR
menu therefore cannot consume the whole detail-page budget before the latest release is fetched.

Each of the 52 coverage IDs has a frozen ordered source ladder. Depending on the field, the
stages include regulator filings, issuer IR/product documents, exchange or market-official
data, local like-for-like observations, public estimate samples, customer, supplier and
competitor disclosures, peer filings, counterparties, other regulators, courts, an explicit
disconfirming search and a reproducible derivation. An empty Yahoo, Google or SEC Atom feed is
therefore only one recorded attempt; it is never completion.

The evidence packet returns one `acquisition_ledger.items` row per owned coverage ID. Its
`outcome` is exactly one of:

- `reported_actual`: an authorised source actually disclosed the value, or the frozen route
  permits a cited direct market, public-estimate-sample or local observation. The packet records
  either one value/unit/period/scope tuple or, when the same coverage ID contains several
  disclosed metrics, `observations[]` rows with metric, value, unit, period and scope. A public
  estimate sample stays scoped as a sample and is never relabelled issuer guidance or complete
  market consensus.
- `recomputed_proxy`: cited public inputs support a reproducible value; the packet records
  value, unit, period, formula and inputs. It is never relabelled as an actual.
- `modeled_estimate`: cited public inputs support a bounded scenario; the packet records
  numeric low/base/high, unit, period, formula and assumptions. It is never relabelled as an
  actual or full-market consensus.
- `unavailable`: every stage frozen for that coverage ID records the actual URL, search query
  or local-ledger locator tried and its terminal result. A bare "not found", an omitted search
  or a missing optional API fails the runtime gate.
- `not_applicable`: the fact genuinely does not apply, with a concrete reason.

`coverage_items=covered` means that the named domain has usable cited evidence; it does not
assert that every desired scalar exists. When the exact acquisition outcome is still not
publishable, the matching ledger row may therefore remain `unavailable` while coverage stays
`covered`, but only when the two rows share a resolved source, every frozen terminal stage is
recorded, and the ledger gives a concrete reason. The exact target may
have no successful attempt—that is consistent with `unavailable`; the cited coverage source
proves useful domain evidence, not the missing scalar. If a worker omits the ledger copy of that
source ID, the server may bind only the already-validated source IDs from the matching coverage
row. This is sourced partial coverage, not a successful scalar. It preserves the evidence packet without allowing a
missing range, formula, unit or period to become a fact.

`policy_id`, `task` and the ownership of every coverage ID are server-frozen bindings rather
than model judgments. Only the eight core evidence roles own this 52-row acquisition ledger;
the three all-scope supplemental packets are still frozen into the dossier and acknowledged by
every method seat, but they neither receive nor satisfy synthetic acquisition rows. Transport
parsing deliberately leaves ledger semantics to the post-normalization gate, which validates
the exact frozen plan, sources, attempts and outcomes. The normalizer may turn a worker input
map into bounded input rows, parse strict numeric low/base/high strings, and retain known
supplemental source stages for audit. It never invents a source, value, unit, period, formula,
assumption or missing range bound. A successful external attempt without a resolvable source is
recorded as `not_disclosed`; a proposed actual/proxy/model that lacks its required evidence or
metadata is downgraded to `unavailable` with `proposed_outcome` and a rejection reason rather
than repaired into a publishable value.

The canonical supplemental stage for an already-cited, non-official public market-data page is
`public_market_data`. The observed worker spelling `market_data_provider` and mistaken task-name
spelling `market_data` normalize to that stage with the proposed spelling retained for audit. This
stage may support a route-appropriate market/quant direct observation only after every frozen
`required_terminal_stage` is recorded for that row. It is never treated as `market_official`,
never counts as a derivation, and never replaces a frozen terminal-stage attempt.

If an otherwise-valid evidence packet fails only this ledger gate, the one bounded retry is a
no-search `acquisition_ledger` repair. The runtime freezes and preserves the original claims,
sources, coverage rows and official-news coverage, accepts no new source, locator or fact, and
merges only the repaired ledger. An unscoped repair ID such as `S1` may bind only to that
packet's already-existing scoped source; an unresolved ID still fails closed.

A company packet may first need the separate bounded transport/schema repair. If that repair
produces a packet that passes the transport, source, coverage and reader-language gates but then
reveals an acquisition-ledger-only error, the runtime may invoke the ledger repair once as a
third and final attempt. Both repairs run without search and have disjoint mutation authority;
the second repair receives the now-frozen packet and may replace only `acquisition_ledger`.
Another transport, language, coverage or ledger failure does not receive a fourth attempt.

Successful actual, proxy and model observations are stored by ticker, coverage ID, period,
metric, unit, scope and outcome. Later runs compare only like-for-like records; a 90-day change is emitted
only when an observation at least 90 days old exists for the same metric, period, unit, scope
and outcome.
This makes the acquisition system improve with use without silently mixing forecast vintages
or turning a changed fiscal period into a revision.

### Public-data availability boundary

“All analysts received the complete dossier” means every public fact actually acquired for
this frozen run was distributed and acknowledged. It does not mean private operating data or a
proprietary vendor history became public. The runtime handles the recurring gaps as follows:

- **Automated keyless observations:** one-year daily price and volume history, 5/21/63/126/252
  session returns, 20/63-session realised volatility, session-aligned benchmark-relative
  returns, current filings, reported financials and the current options snapshot are fetched
  and hash-bound when their public routes respond.
- **Locally accumulated histories:** each valid ATM-IV snapshot is appended to an owner-local
  ledger. A historical IV percentile remains unavailable until at least 60 distinct daily
  observations exist; the system never backfills model memory. Consensus revisions need the
  same observation-ledger approach, but no reliable, standardized keyless consensus archive is
  currently treated as canonical, so a 90-day revision series stays unavailable without dated
  public records.
- **Section 16:** filing documents are process-rate-limited and cached. Empty
  `notSubjectToSection16` and valid no-securities-owned filings parse as zero. The system emits
  an exact ownership ratio only when the applicable candidate set is complete; otherwise it
  publishes the measured amount as an explicit lower bound with omitted/failure counts.
- **Disclosure-dependent or proprietary fields:** product acceptance, yield, actual shipment
  and revenue contribution, order/prepayment coverage, hyperscaler capex allocation, GPU/rack
  ASP, monthly supply-chain capacity, current stock-loan fee and comparable private transaction
  detail are actuals only when a dated issuer, customer, supplier, regulator, exchange or other
  attributable public source discloses them. Otherwise the acquisition ladder must attempt a
  cited reproducible proxy or bounded scenario first. If neither has defensible public inputs,
  the exact fact remains `unavailable` after the exhaustive attempt ledger; it is never invented
  from a promise, headline, model prior or adjacent metric.
- **Forward free cash flow:** a future-year sustainable FCF figure is a scenario/rederivation,
  not an observed fact. Its assumptions, units, source IDs and calculation must be explicit;
  failed independent rederivation remains `needs_verification` on the mandatory triple path.

For a mandatory triple-verification run, transport size is not allowed to weaken coverage. Each
verifier may process bounded claim chunks concurrently, with a per-chunk structured-output schema
that requires every exact claim ID as a key. The server converts those keyed results to the public
row contract and accepts only the exact full union. Source fidelity uses ten-claim chunks because
each claim may require several original URLs. A syntax/shape failure has one no-search transport
repair; an actual coverage failure has one bounded web-enabled audit retry against the unchanged
chunk, after the artifact records the precise claim, reason and omitted URL. An independent rederivation that naturally
returns to the same primary filing remains valid analytical work when it carries its own query and
calculation, but is surfaced as a same-source finding rather than claimed as independent-source
corroboration.

If one of these gaps is method-critical, dossier sufficiency blocks the decision. Otherwise the
run may continue only with the gap visible in the packet, method receipt and final report.

### Frozen snapshot, distribution and acknowledgements

The system freezes the applicable dossier as `company_dossier.json` and computes one canonical
SHA-256 `content_hash`. The eight mandatory evidence analysts collectively populate the core
artifact and all 52 coverage rows. An all-scope run freezes the three supplemental packets in
the same revision, so the dossier contains eight packets for `core` and eleven for `all`. Every
mandatory downstream consumer for that dossier revision receives the exact same hash-bound
artifact, not independently summarized copies:

- for a confirmed `all` selection, all 26 active method seats; for another valid selection,
  every selected method seat;
- Bull and Bear in every required debate round; and
- the portfolio manager.

Compact evidence embedded in a prompt is only an index. Information omitted from that index
remains available through the full hash-bound dossier artifact. Before accepting a mandatory
consumer's output, the runtime revalidates the persisted dossier against the expected hash and
requires that output (or the deterministic method execution record) to carry the exact
`company_dossier_hash_ack`. Every method voice additionally returns one `evidence_packet_acks`
row for each packet frozen in that revision: the eight core rows are always mandatory and an
all-scope run adds the three supplemental rows. Each row must bind the exact task and packet
hash and use one status: `used`, `reviewed_not_relevant`, or `unavailable`; status-specific
source IDs or reasons are validated. A missing hash, a mismatched hash, a changed dossier artifact, an
unresolved source ID, an invalid coverage row or a mandatory consumer that never acknowledged
the frozen revision fails closed. The run names the affected role, persists diagnostics and
does not proceed past the relevant evidence, method, debate or PM barrier. A changed accepted
source creates a new dossier revision and invalidates acknowledgements to the old hash; it is
never silently appended behind a previously frozen decision.

The acknowledgement proves which snapshot was delivered and bound to the output. It does not,
by itself, prove that a model reasoned over every byte. Material figures and conclusions still
need scoped source IDs, and the report must preserve the dossier's explicit gaps and conflicts.

### Deterministic-method input boundary

The dossier and a deterministic method's executable fact pack are related but are not the same
thing. Physical PersonaPack v3 policies consume only point-in-time, source-bound facts that can
be represented under the compatible typed-fact contracts, with valid units, periods and
lineage. They do not parse arbitrary dossier prose, raw documents or an analyst's qualitative
claim. Binding the dossier hash into a method execution record proves snapshot identity; it
does not prove that every dossier field affected the frozen stance.

The isolated method explanation worker may read the full dossier after the deterministic
stance is frozen, but it may only explain or challenge the evidence and may not change that
stance or invent a typed fact. A dossier fact that has no valid typed-fact adapter remains
visible to the explanation, Bull/Bear and PM, while the deterministic method records it as an
unavailable input or returns `out_of_scope` when its own critical contract requires it. A real
`full-evidence-input-v1` claim requires the separate case wrapper, typed fact pack, source,
claim and coverage ledgers, artifact references and complete hash bindings; the company
dossier alone must not be relabeled as that stronger contract.

## full_v2 Contract

Full remains the default. Its `final_report.md` visibly covers:

- conclusion and final rating
- analyst work log for every planned evidence role
- bull/bear debate record, including three rounds and exact round-3 Q&A
- recorded Master Bench when methods were selected
- fund/index structure and look-through when the instrument is an ETF, fund or index
- long thesis and short thesis
- market expectations and implied beat/miss thresholds
- analyst rating and target-price revisions
- earnings-call management signals
- quant factor / technical risk view
- news and company / industry voice signals
- short interest / borrow / options information when available
- strategic transaction or banking-event analysis when relevant
- valuation range
- price levels: conditional bands, not one unsupported target
- key catalysts and major risks
- position recommendation
- short-term 1-4 week, medium-term 3-6 month and long-term 12 month views
- data gaps / unavailable data
- invalidation conditions
- confidence
- source table

Its `user_response.md` must also visibly carry:

- a system-owned price snapshot with price, currency, quote timestamp, exchange/feed and
  source when available, or an explicit statement that the quote is unavailable;
- every selected stable master ID, its frozen deterministic stance and its complete,
  untruncated recorded statement, or an explicit non-directional terminal failure record;
- all eight or eleven receipt-bound analyst task IDs, statuses and summaries, including failures or gaps;
- terminal status, contract, report quality, elapsed time, deadline state and artifact paths.
- a machine-marked final section with the exact selected-seat count. Every speaking seat keeps
  its complete recorded statement; every failed/unavailable seat instead carries
  `statement_status=not_produced` plus status/reason and never counts as a directional view.
  Full `all` therefore accounts for all 26 selected IDs; quick reports its actual 1–4.

`final_report.md` and `user_response.md` both end with that same complete system-owned
method-seat ledger. The tail end marker is the last non-whitespace content in each file. An
evidence-gate failure therefore still accounts for every selected seat as
`statement_status=not_produced`; it never converts a skipped seat into a directional view.

Visible PM completion returns `handoff_contract=inline_user_response_v1` plus the persisted
`user_response_markdown`. When a visible barrier cannot complete, the host must call
`finalize_visible_run`; it closes the run as `incomplete` and returns the same handoff contract.
The host uses that body for the final reply instead of reducing it to a compact ACK or manual
recap, and appends nothing after the method-seat tail. Idempotent replays return the same handoff.

Text-only MCP hosts receive that same persisted `user_response.md` body in `content[0].text`
when synchronous `analyze_symbol`, a terminal idempotent replay, or `read_run` observes a
terminal run. A nonterminal background acceptance remains a small polling acknowledgement.
`read_run` defaults to `detail=compact`: its structured payload contains only status, a bounded
decision, report quality, artifact paths, an event summary and the user response. Use
`detail=full` only when the caller explicitly needs the legacy evidence, event log,
`all_agents.md` or `final_report.md` bodies. The terminal text handoff is complete in either
detail mode and still ends at the method-seat tail marker.

All mandatory full evidence roles must be completed. If one still fails after the one bounded
parse-only repair, full fails closed at the evidence barrier: no master, bull/bear or PM model
call is started. The run is persisted as `incomplete` with the failed evidence and skipped
downstream roles named. A partial PM opinion never converts that run to complete.

## Full Runtime Budget

Plugin-managed headless `analyze_symbol(council_mode="full")` runs at one of three depth tiers
chosen with `council_pace`, measured from durable queueing through terminal artifact
persistence. A caller or environment may lower the selected tier's budget, never raise it.

| `council_pace` | total | evidence / seat | method / seat | debate / round | PM |
| --- | --- | --- | --- | --- | --- |
| `fast` | 15 min | 3.5 min | 1 min | 90 s | 2 min |
| `normal` (default) | 30 min | 6 min | 2 min | 150 s | 3 min |
| `slow` | 60 min | 12 min | 4 min | 6 min | 8 min |

The tier moves every per-stage cap together with the total, because the per-stage caps are what
bound each worker: a 60-minute total with 150-second debate rounds would finish in twenty
minutes with forty idle, and a 15-minute total with 6-minute evidence caps would starve the
debate into `incomplete`.

The tier also shapes what each worker is asked to produce. A cap on its own is a timeout, and a
timeout is not a plan: the identical prompt with a shorter fuse buys a packet the worker could
not finish rather than a faster good one. Because an LLM call's wall clock is dominated by the
tokens it generates, `fast` asks for the same information in less prose. What it never cuts is
claims, figures, scoped source IDs, the required report sections or the decision; what it cuts is
restatement — re-quoting evidence that could be cited by ID, recapping an opponent before
answering, methodology preambles. `slow` buys room to write a derivation out step by step.
`normal` adds no shaping at all, so its prompts remain byte-identical to the reviewed golden. Each tier's stages are proven to fit inside its own budget with
headroom for queueing, retries and the bounded parse repair. All three tiers are `full_v2`: a
tier changes how long each seat may think, never which seats run. Quick rejects the field.

The execution topology is:

1. the eight core or eleven all-scope evidence workers start in one parallel wave;
2. when and only when the frozen receipt is `slow + all methods + all analysts`, three
   verifier workers run concurrently. Each independently returns one verdict for every frozen
   material claim: `source_fidelity` opens the cited source, `rederivation` receives no original
   URLs and recomputes from another source, and `refuter` performs a recorded adverse search.
   Exact claim-by-verifier coverage is mandatory. A zero count or any missing, duplicate,
   unexpected or malformed row terminalizes as `needs_verification` and skips every downstream
   worker. Allowed unresolved/adverse verdicts produce `completed_with_findings`, remain visible,
   and lower the originating evidence seat's weight rather than pretending the verifier was absent;
3. after the evidence and applicable verification barriers, every selected physical v3 method runs its deterministic
   policy and freezes a stance, then receives one isolated voice worker that can explain but
   cannot change that stance;
4. Bull and Bear start together within each of three rounds, with a barrier before the next
   round; the PM starts only after both Round-3 outputs pass exact Q&A validation;
5. deterministic assembly and persistence consume the same global clock.

For headless full runs, each Round-2/3 worker is checked against its own frozen Q&A context
before that round is accepted. A schema-valid Round 2 with other than three non-empty questions,
or a Round 3 that rewrites/reorders either exact question array, receives the same single bounded
no-search transport repair as other packet-contract errors. The repair prompt includes the two
authoritative arrays and may only restore their bindings; a second mismatch remains fail-closed.

At deadline expiry the run stops opening downstream work and persists fail-closed as
`incomplete`, naming timed-out, failed and skipped roles. This is a terminal-persistence
guarantee, not a promise of full-seat success when search, model transport or data sources
are unavailable. The deadline does not apply to `plan_visible_run`: an external host owns
those subagents and the plugin cannot force-stop them.

Visible full runs use the same six role-by-round audit records and exact Q&A gate. Each
Bull/Bear call declares round 1, 2 or 3; the server rejects out-of-order calls, altered replay
content and a PM submitted before both Round-3 records pass. Identical role/round retries are
idempotent. Every non-blocked selected physical v3 seat also returns a visible post-evidence
explanation worker, including a deterministic `out_of_scope` seat. Its
`acknowledged_stance` must match the frozen stance, and PM checks the worker's completed
status rather than accepting the fallback record alone. This preserves workflow completeness
but does not give host-owned subagents the plugin-managed 30-minute deadline.

## quick_v1 Contract

Quick is explicit and plugin-managed through headless `analyze_symbol`. It is not available
through `plan_visible_run`, is never selected implicitly, and always records:

- `scope: quick`
- `contract_id: quick_v1`
- `full_council_equivalent: false`
- `debate_rounds_expected: 1`
- `adversarial_verification: not_run`
- required tasks `market_data`, `earnings_deep_dive`, `valuation_long_short`, and
  `news_industry_management`

Every quick `final_report.md` receives exactly one system-owned, idempotent quick-scope
marker stating `full_council_equivalent=false`; PM prose cannot remove or override it.

The four tasks start in parallel. Recent-news output is limited to dated company and industry
developments published in the 120 days ending at `as_of`; future, undated and older sources
are not presented as recent.

Stage 0 still displays all 26 methods, but quick records only 1-4 selected methods and does
not accept `all`. It then runs one parallel bull/bear statement round and one short PM. It
does not run rebuttal/Q&A rounds or adversarial verifier agents. Source IDs must still resolve
inside the saved packets.

### quick_v1 required sections

The smaller report contract requires these 13 visible sections:

1. conclusion and rating
2. analyst work log naming all four fixed roles and their statuses
3. one-round bull/bear debate record
4. system-owned Master Bench with every selected stable ID and stance
5. earnings-call management signals
6. recent company and industry news
7. valuation range
8. price levels / conditions
9. major risks
10. position recommendation
11. data gaps / unavailable data
12. confidence
13. source table

Forward-expectations revisions, quant, short-interest/options, banking-event detail,
catalysts, three horizon sections, invalidation and three-round Q&A remain full-only required
sections. Their absence does not make a valid quick report fail, and a quick report passing
its smaller contract does not satisfy `full_v2`.

## Quick Runtime Budget

Quick has a non-overridable end-to-end ceiling of 600000 ms, measured from durable queueing
through artifact persistence. A caller or environment may lower it, never raise it. The
server budgets:

| Work | Maximum |
|---|---:|
| deterministic grounding wait | 20 seconds |
| each of four parallel evidence workers | 210 seconds |
| each of up to four parallel master workers | 90 seconds |
| bull and bear, one parallel statement each | 90 seconds per side |
| short portfolio manager | 90 seconds |
| final report assembly and persistence reserve | 20 seconds |

Retry time is inside the same ceiling. The clock is a fail-closed upper bound, not a promise
that unavailable evidence will be replaced from memory.

## Execution Status, Coverage and Report Quality Are Separate

Do not collapse these axes:

- `status`: terminal orchestration result.
- `completeness`: whether the applicable structural gates were satisfied.
- `evidence_coverage`: `complete`, quick-only `degraded`, or `incomplete` when mandatory
  evidence is missing or failed.
- `verification`: source-ID lineage plus, when required, the exact triple-verifier audit.
- `adversarial_verification`: `not_required`, `pending`, `passed`, or
  `needs_verification`; a required verifier count of zero is never `complete`.
- `report_quality`: whether `quick_v1` or `full_v2` report structure passed.

Terminal analysis statuses are:

```text
complete | degraded | incomplete | needs_verification | needs_revision | failed
```

`degraded` is a quick-only terminal result. It is permitted only when at least two of the
four evidence roles completed, every failed role has a sanitized packet/diagnostic, at least
one bull/bear side completed, the PM completed, and every selected method was recorded. Both
debate sides failing, PM failure, fewer than two successful evidence roles, or a missing
master makes the run `incomplete`.

A degraded report contains exactly one system-owned, idempotent degraded execution ledger
naming each affected task/side and its cause. `report_quality.json` repeats the degraded
evidence/debate arrays. A structurally valid report can therefore have
`report_quality=passed` while the run remains `degraded`; never present that as complete.
`needs_verification` or `needs_revision` may be the top-level terminal status while degraded
coverage remains visible in the independent ledger/status fields.

## Concise Chat Handoff

Every handoff includes status, report contract, report quality, rating, winner, confidence,
one judgment paragraph, valuation/position, material gaps and file locations.

A full handoff additionally carries the key earnings result, forward setup, news/voice
signals and top invalidation conditions. It lists every selected method seat and all eight or
eleven receipt-bound analysts rather than sampling a subset, and includes the system-owned price
  snapshot or an explicit quote-data gap. The system-owned method-seat ledger is the final
  handoff section; recorded statements are not clipped and missing statements are explicit
  non-directional failure entries rather than summary/verdict fallbacks.

A quick handoff instead names:

- every selected stable master ID, stance and short recorded result, marked as not a quote;
- all four analyst statuses and summaries;
- dated recent company/industry news;
- every degraded or failed task/side and its cause;
- the explicit sentence that `quick_v1` has no three-round cross-exam or adversarial
  verification and is not equivalent to full council.

Both handoffs list `final_report.md`, `artifact_index.md`, `all_agents.md`, and
`report_quality.json`.

## Anti-Rationalizations

| Bad shortcut | Required behavior |
| --- | --- |
| "The user only asked if they can enter, so four bullets are enough." | Keep chat concise, but write the mode-appropriate report and artifact index. |
| "Quick passed report quality, so it passed full." | `quick_v1` can only pass `quick_v1`; retain `full_council_equivalent=false`. |
| "Ten minutes expired, so silently omit a seat." | Record the exact degraded/incomplete ledger; never manufacture evidence or extend the ceiling. |
| "Thirty minutes expired, so finish full with the seats that returned." | Persist full as `incomplete`, name every missing/skipped role and keep the saved partial evidence; never synthesize a complete verdict. |
| "One evidence task failed, but the PM has an opinion." | Apply the mode-specific evidence gate; full fails before downstream calls, quick may only use its explicit degraded rules. |
| "The source table mentions the news, so the news section can be skipped." | News findings need their own visible section; quick recent news must also pass its date window. |
| "The final report exists, so chat can hide file locations." | The handoff lists the saved report, index, trace and quality file. |
| "The master said this." | Call it a recorded method-seat result, never a quote from the named person. |
| "The full report has a bench table, so the handoff can hide the individual seats." | Full handoff ends with every selected stable ID and its complete statement or explicit non-directional failure status. |
| "The PM tool returned success, so its small ACK is enough." | Deliver `user_response_markdown`; success metadata is not the user-facing report. |
| "A visible worker failed, so I will summarize the partial run myself." | Call `finalize_visible_run` and deliver its persisted handoff; never leave the run open or bypass the final ledger. |
| "QQQ has a ticker and SEC CIK, so run the company screen." | Classify first. ETF/fund/index company financial routes are not applicable; use look-through or aggregate evidence. |

## How the Quality Gate Checks Reports

`validateFinalReport` retains its report-only `schema_version: 2` result. Artifact publication
writes `report_quality.json` with `schema_version: 3`, the applicable `contract_id`, and a
`handoff_method_statement_coverage` result from `validateUserResponse`. A report section counts
only when:

- it is a real Markdown ATX heading (`##` or `###`), not bold text or a heading inside a code
  fence;
- its normalized title matches the section aliases, with the longest alias winning;
- the body before the next same/higher heading is not a placeholder and meets the section's
  minimum non-space length.

Every planned task ID must appear inside the Analyst Work Log body, not only in the source
table. When sources exist, scoped IDs such as `market_data:S1` must appear. Full reports need
at least 1600 non-space characters, quick reports 700, and dry reports 600.

The system-owned recorded Master Bench and degraded ledger are checked independently of PM
prose so a generic, stale or duplicate heading cannot satisfy the contract. The authoritative
Master Bench must contain the exact stable ID and a readable statement for every selected
seat; `report_quality.json.method_statement_coverage` records selected/readable/rendered
counts and IDs. A missing statement or ID forces `needs_revision`. Fund/index runs also
require the system-owned instrument-structure section. The authoritative lists are
`REPORT_SECTIONS` and `QUICK_REPORT_SECTIONS` in `mcp/lib/constants.mjs`.

The handoff gate independently requires one begin/end ledger marker, the end marker as the
last non-whitespace content, exactly one ordered seat marker for every selected stable ID, and
the full original `voice_statement` inside each speaking block. A non-speaking block passes
only with `statement_status=not_produced`; it remains incomplete at the execution gate.
