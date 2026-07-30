---
name: alphacouncil-agent
description: Use AlphaCouncil Agent for listed-equity research workflows that need multiple Codex subagents, shared evidence packets, public-equity analysis, banking/event analysis, filings/news search, valuation, long/short pitch work, risk debate, or portfolio-manager style decisions.
---

# AlphaCouncil Agent

Use this plugin when the user invokes `@alphacouncil-agent` or asks for a multi-agent public-equity research workflow.

## Agent-Skills Governance

Also apply `../agent-skills-governance/SKILL.md` before planning, running, synthesizing, or reporting. That bundled skill provides the agent-skills-style anti-laziness gates for every installer of this plugin; it is not a separate local dependency.

## Mandatory Council Contract (MUST READ FIRST)

Every council run has an explicit `council_mode`. `full` is the default. Never infer quick
from impatience, a short prompt, a deadline, or a model/tool failure, and never switch modes
after Stage 0.

- **Full council (`full_v2`)**: run all 8 planned evidence roles (`market_data`,
  `earnings_deep_dive`, `forward_expectations`, `quant_factor`, `valuation_long_short`,
  `news_industry_management`, `insider_sec`, `ib_event_analysis`), then every selected
  master, then the three-round bull/bear cross-exam, then `portfolio_manager`. In the
  plugin-managed headless path the eight roles start in one parallel wave; each selected v3
  method freezes its deterministic stance before one isolated voice worker explains it; and
  Bull/Bear run in parallel within each round with a barrier between rounds. When a plan
  explicitly adds optional analyst seats, every added seat is equally mandatory. A mandatory
  evidence failure is a fail-fast barrier: persist the failure and final diagnostic artifacts,
  skip masters/debate/PM model calls, and terminate `incomplete`; do not synthesize around it.
  Headless full has a hard 1800000 ms queue-to-terminal-persistence ceiling. It fails closed
  at expiry and does not promise all-seat success when external services deteriorate.
- **Quick council (`quick_v1`)**: only the plugin-managed headless `analyze_symbol` path may
  execute it. It runs the four fixed evidence roles in parallel, 1-4 selected methods in
  parallel, one parallel bull/bear statement, and one short PM inside the hard 600000 ms
  end-to-end ceiling. It is not a shortened claim of full-council completion.
- You MUST NOT answer single-pass from model knowledge, skip a planned seat silently, or call
  `plan_visible_run` and jump directly to a PM decision. `plan_visible_run` rejects quick.
- Completeness is mode-aware. Full is complete only when all planned evidence, selected
  methods (including deterministic `out_of_scope` decisions), all required debate rounds and
  the PM are recorded. Quick may terminate `degraded` only under its explicit coverage rule
  and system-owned degraded ledger; otherwise missing mandatory work is `incomplete` or
  `failed`. Never relabel `degraded`, `incomplete`, `needs_revision` or `failed` as `complete`.

## Preflight Interaction

Infer these fields rather than asking separate startup questions:

- language: user's apparent language
- goal: entry/actionability judgment
- horizon: include short-term 1-4 weeks, medium-term 3-6 months, and long-term 12 months in the final report

Every council judgment still has one mandatory preflight: the per-run master selection in
Stage 0. This applies to both full and quick council modes. It is not an optional preference
question and it cannot be inferred, silently reused or skipped because the request already
named a master. Data-only `screen`, `options`, `news` and `market` calls do not enter the
council and skip Stage 0.

Use the inferred language for the Stage 0 catalog, visible progress, agent prompts, evidence
packets, debate packets and final synthesis unless the user explicitly requests another
language. Always pass the original user request in `prompt` and the inferred language in
`language`. System-owned catalog/report/handoff labels and failure text are localized for
`zh-CN`, `en`, `ja` and `ko`; stable IDs and JSON field names remain English.

## Stage 0 — Display, confirm and receipt-gate the master selection

**No research, run envelope, network request or subagent may start before this gate passes.**

`list_council_options` remains a read-only discovery view for users who ask what the system
can do. It does **not** create a selection session, prove that the individual catalog was
displayed, or issue a receipt, so it never substitutes for the steps below.

The analysts have a sensible default -- the eight-seat fan-out -- and asking about them every
time is a question with an obvious answer. Master selection is the one configuration decision:

1. Call `begin_council_selection` with `symbol`, the original `prompt`, inferred `language`,
   the calling `host`, and the intended `council_mode` (`full` by default). If the request
   explicitly names masters, resolve their stable IDs and pass them as
   `preselected_master_ids`; preselection highlights only and never confirms.
2. Display **every returned master individually in the returned order**. Preserve the stable
   number and show `identity`, `method`, `best_for` and `maturity` for every row. A school
   summary, preset or seat count does not satisfy this step.
3. Take one submission. The universal fallback is a numbered text reply: one index in
   `1..N`, any comma/space-separated combination, ranges such as `1-4` or `1..4`, or stable
   IDs/names. Full also accepts `all`; quick requires 1-4 distinct methods and rejects `all`.
   - **Claude Code, Codex, OpenCode and Grok Build** may use a native multi-select when it can
     display the complete catalog without truncation.
   - Native UI is an enhancement, never the protocol. If unavailable, print the same numbered
     table and accept the same text grammar on every host.
4. If the original request already named masters, or said `all` for a full run, mark those
   entries as a prefill, but still display the complete catalog and require a submission for
   this run. An over-limit quick prefill must be reduced by the user's submitted selection.
   Never reuse a prior run's selection. The submission itself is confirmation; do not add a
   second confirmation question.
   The obsolete rule **"Skip the question entirely"** is prohibited for council runs: a
   prefill reduces typing but never replaces this run's displayed catalog and receipt.
5. Call `confirm_master_selection` with the exact `selection_id`, `catalog_hash`,
   `display_ack: true`, and exactly one of:
   - `selected_master_ids: [...]` for a native multi-select;
   - `select_all: true` for all in full mode only;
   - `selection: "1,4-6"` (or another supported text selection) for the fallback.
6. Retain the returned one-use, mode-bound `selection_receipt`. Only after that may the host call
   `plan_visible_run`, `collect_evidence` or `analyze_symbol`, and each call must include the
   receipt plus the same symbol, prompt, language and `council_mode`. Never also pass `masters`
   or `masters_roster`; the confirmed receipt is authoritative. Missing, expired, stale,
   consumed or mode-mismatched receipts restart at step 1.

Do not ask about analysts: they default to the eight-seat fan-out. Use all eleven only if
the user asked for breadth, and say so in the report rather than asking first.

### Full v2 plugin-managed contract

Use this contract when full runs through headless `analyze_symbol`:

- Call `analyze_symbol` once with the full-mode receipt, `council_mode: "full"`,
  `wait_for_completion: false`, and no task override unless the user explicitly requested
  optional breadth. Poll the one durable `run_id`; never create a replacement.
- The eight mandatory evidence roles start together. Each has one bounded parse-only repair;
  repair converts malformed output and does not repeat web research.
- After the evidence barrier, every selected physical v3 method executes its deterministic
  policy and freezes its stance. Each seat that reached a stance then gets exactly one isolated
  voice worker for that stable ID. It may explain the recorded policy result in the user's
  language, but cannot change the stance, invent a typed fact or speak as the real named person.
  A missing voice result remains visible and prevents a false complete bench.
- A seat frozen `out_of_scope` is settled without a worker. Its deterministic statement names
  the condition that closed its gate and states that an abstention is not a bearish vote, which
  is all an out_of_scope seat is asked to say; `ALPHACOUNCIL_VOICE_ABSTAINING_SEATS=1` restores
  a worker for every seat. Such a seat is still published with a readable statement, and its
  `voice_status` is `deterministic_scope` rather than a claim that a worker ran.
- Every condition id a seat cites is resolved back to the id its pack declares. The ids are
  hashed before the policy runs so the decision layer cannot recognise the seat, but past the
  freeze the seat is named in the report and in its own worker prompt, so a surviving
  `anon_<hash>` only stopped a seat from telling a reader which condition decided it.
- Round 1 Bull/Bear run together; after both pass, Round 2 runs together; after both pass,
  Round 3 runs together with exact saved-question bindings. The PM starts after both Round-3
  sides pass.
- The hard ceiling is 1800000 ms from durable queueing through terminal artifact persistence,
  including queueing, retries, all workers and deterministic finalization. A caller or
  environment may lower it, never raise it. At expiry persist `incomplete` and name every
  timed-out/failed/skipped role. The deadline guarantees a terminal saved run, not successful
  completion under provider/search/data degradation.
- The concise handoff lists every selected stable master ID, frozen stance and voice-worker
  explanation/status; all eight analyst task IDs, statuses and summaries; and a system-owned
  price snapshot with currency/time/source or an explicit unavailable-data gap.

`plan_visible_run` is not governed by this clock: the external host schedules and owns those
subagents, so the plugin cannot force-stop them. Do not promise the 30-minute headless bound
for visible-host execution.

### Quick v1 fixed contract

Quick remains a council judgment and passes the same display/confirmation gate, but its
execution graph is deliberately smaller and immutable:

- Call `analyze_symbol` with `council_mode: "quick"`, the mode-bound receipt,
  `wait_for_completion: false`, and no task override. Do not call `plan_visible_run`; it
  rejects quick so the host cannot silently turn a bounded run into visible orchestration.
- Launch exactly these four evidence roles in one parallel wave: `market_data`,
  `earnings_deep_dive`, `valuation_long_short`, `news_industry_management`.
- The news role covers dated company and industry developments in the 120 days ending at
  `as_of`. Future, undated, and older items are not presented as recent.
- Run the 1-4 selected methods in one parallel wave. Then run one bull and one bear statement
  in parallel, followed by one short PM. There are no rebuttal/Q&A rounds and no adversarial
  `source_fidelity` / `rederivation` / `refuter` fan-out.
- Enforce the 600000 ms queue-to-persistence ceiling: deterministic grounding 20 seconds;
  each parallel evidence worker 210 seconds; each parallel selected method 90 seconds; bull
  and bear 90 seconds per side; PM 90 seconds; final assembly/persistence reserve 20 seconds.
  Retry time is inside those caps and the global deadline. Callers and environment variables
  may lower the ceiling, never raise it.
- Missing data is not invented. If minimum evidence coverage survives, timed-out or failed
  seats are explicitly degraded and the terminal run keeps one idempotent, system-owned
  `alphacouncil:degraded-ledger:v1` block. If minimum coverage does not survive, terminate
  incomplete. `report_quality=passed` checks only `quick_v1` structure and never erases a
  degraded status or implies `full_council_equivalent=true`.
- A valid `quick_v1` report has 13 visible sections: conclusion/rating; analyst work log;
  one-round Bull/Bear record; system-owned Master Bench; earnings-call management signals;
  recent company/industry news; valuation range; price conditions; major risks; position
  recommendation; data gaps; confidence; and source table.

## Visible-First Workflow

This section applies to full council only. If the user explicitly chooses quick, use the
plugin-managed Headless MCP path; never emulate quick with visible subagents.

Use visible Codex subagents whenever the user asks to see subagents, asks for a chat-style analyst team, says child agents must be visible, or invokes `@alphacouncil-agent` for an investment decision without explicitly requesting headless/background mode. If the user requires a hard 30-minute terminal bound, explain that visible host tasks cannot be force-stopped by the plugin and use plugin-managed headless full after Stage 0.

Default to the full workflow. Do not downgrade to a lite/smoke/visible-only summary unless the user explicitly asks for lite, smoke test, or debug output. Do not describe the final user-facing report as "visible version", "lite", "smoke", or "debug"; those are execution details, not investment-report content.

1. If `multi_agent_v1.spawn_agent` is available, spawn separate visible agents for the full default analyst team:
<!-- generated:roster start -->
   - `macro_regime`
   - `market_data`
   - `earnings_deep_dive`
   - `forward_expectations`
   - `quant_factor`
   - `valuation_long_short`
   - `news_industry_management`
   - `market_narrative`
   - `social_pulse`
   - `insider_sec`
   - `ib_event_analysis`
   - `bull_researcher`
   - `bear_researcher`
   - `portfolio_manager`
<!-- generated:roster end -->
2. Give each visible agent a narrow prompt and require JSON evidence or debate output. Tell each agent not to call `alphacouncil-agent` recursively.
3. Use the selected or inferred language for visible agent prompts, evidence packets, debate packets, and final synthesis. Keep JSON field names in English.
4. **Master bench — runs on every host, not only Claude Code.** After Stage 0, pass its
   `selection_receipt` to `plan_visible_run`; the run envelope resolves the exact selected
   master IDs. After the evidence agents finish and before the debate, run each selected lens.
   Each master reads the SAME established facts the analysts read plus the analyst packets,
   and returns one JSON opinion recorded with `record_master_opinion(run_id, master, packet)`.
   - There is no silent default roster. At least one method or `all` is confirmed per run.
   - A master whose method cannot judge this name returns `stance: "out_of_scope"`. That is a conclusion, not an abstention, and it carries zero weight rather than being coerced into a view.
   - **The run is `incomplete` until every selected master has reported.** A bench nobody consulted is worse than no bench: the reader believes the verdict survived every lens when it survived none.
   - Feed the masters' disagreements into the bull and bear prompts. Their disagreement is the point; a bench that agrees with the analysts has added nothing.
5. **Verifiers — every host executing this full visible/deep path.** Build a claim ledger from the merged packets, take only thesis-bearing claims, and run `source_fidelity`, `rederivation` and `refuter` against each. Record each with `record_verifier_verdict(run_id, verifier, seat, verdict, claim)`.
   - Failed verification **down-weights the seat that made the claim** in the PM synthesis; a seat is never silently erased.
   - `cannot_confirm` and `stands` are real results. Manufacturing a `weakened` verdict to look diligent lowers a seat's weight for no reason, and weight moves the final rating.
6. Wait for the evidence agents, merge their outputs into a shared evidence set in the main thread, then run bull, bear, and portfolio-manager agents.
   - Round 1: bull writes the long case; bear writes the short case; launch both in parallel and wait for both.
   - Round 2: pass bull's packet to bear and bear's packet to bull for rebuttal; each side
     ends with exactly three questions for the opponent.
   - Round 3: cross-feed those six saved questions; each side preserves its own three in
     `questions` and answers the opponent's three as exact `{question, answer}` bindings in
     `questions_answered`.
   - Final: portfolio_manager reads evidence plus all debate rounds and decides whether bull, bear, or balanced won.
7. Return a concise but evidence-rich user handoff in the selected or inferred language: rating, debate winner, key earnings/financial results, forward expectations or event thresholds, important news/industry signals, valuation range, position guidance, top invalidation conditions, and saved file locations. It must name every selected master and every mandatory evidence analyst, with each status/summary, plus the system price snapshot or an explicit quote-data gap. Do not paste an overlong report into chat unless the user asks for the full body inline. The saved `final_report.md` must still be complete enough to read without opening artifacts: include each evidence analyst's summary, key data/news/filing/quant findings, the bull case, bear case, rebuttals/questions where available, portfolio-manager verdict, data gaps, and source table. Include links/paths to saved artifacts in the handoff.
   - If the Data Analytics `datascienceWidgets` tools are available, also create a real dashboard/report artifact from the completed evidence and decision: call `validate_artifact` first, then `render_artifact`. Do not treat `output_mode=data_analytics` as only a prose style.
   - If Documents, PDF, Spreadsheets, or Presentations are requested as output formats, use their plugin/skill workflow as a delivery layer after the investment decision is complete; do not move investment judgment into those format plugins.
8. If the user specifically wants left-sidebar Codex chat threads, use `codex_app.list_projects` and `codex_app.create_thread` instead of MCP headless execution. Create one thread per major role and report the created thread IDs.
9. Do not treat `plan_visible_run` as execution. It only creates the run envelope and prompts; visible agents/threads must actually be created and read before final synthesis.

## Data Tools — call these instead of searching

Every tool below is keyless. **A number these can supply must never come from a search
result, from a summary, or from memory.** Search is for what the tools cannot reach:
explanation, guidance, competitor commentary, and anything not yet filed.

| Need | Call | Notes |
|---|---|---|
| Price | `get_quote` | Delayed ~15m. Say so wherever a level matters. |
| Filings-based quality screen | `screen_ticker` | Pass `ticker`; the CIK is resolved for you. A rule whose inputs are missing is `skipped`, **never a pass**. |
| Screen a list | `screen_candidates` | Capped at 40; a fetch failure is `unavailable`, not an elimination. |
| Full US filer list | `list_us_universe` | SEC `company_tickers.json`. |
| Non-US financials | `market_financials`, `market_coverage` | TWSE keyless; KR/JP need a free key; HK/CN are documents only. Check coverage **before** promising a number. |
| Macro context | `get_macro_snapshot` | 21 series, 5 derived. Observations, not a regime call. |
| Options positioning | `get_options_chain` | IV term structure, 25-delta skew, put/call ratios, open-interest concentration. |
| Dated news and filings | `get_news` | `symbol`, `query` and/or `cik`. Undated items are excluded, not shown as recent. |
| What the market is talking about | `get_market_narrative` | Themes ranked by coverage, each paired with the series that would corroborate it. |
| Retail and technical chatter | `get_social_pulse` | Reddit, Hacker News, Bluesky. |
| Confirm a quoted X post | `verify_x_post` | A decoded timestamp proves nothing; any invented id decodes to a plausible date. |
| Industry map | `industry_brief`, `industry_peers`, `industry_coverage` | Ask coverage first — it says whether the participant list is authoritative. |
| Facts + brief in one call | `compose_research_brief` | Grounding for a whole run. |

### Limits you must carry into the report, not discover later

- **IV percentile is not computable.** The chain is a snapshot with no history. Any claim that
  volatility is high or low versus its own past goes in `open_questions`.
- **X / Twitter has no free discovery channel.** Professional FinTwit is **not** covered and
  Reddit is not a substitute. Say so rather than implying you looked at social media.
- **Non-US names have no options chain here** and often no structured financials. Report the
  gap; never substitute a US peer's numbers.
- **A skipped screen rule is a gap.** Reporting `6/7 passed` without naming the seventh
  misrepresents the screen.

## Headless MCP Workflow

Use MCP only when the user explicitly accepts background/headless execution, wants saved files, or asks to inspect/re-run a previous saved run.

1. Call `collect_evidence` for a full-mode source-gathering request that needs file artifacts.
   Quick is an end-to-end contract and must enter through `analyze_symbol`, not a hand-built
   sequence of lower-level tools.
2. Call `analyze_symbol` with the intended `council_mode`, mode-bound receipt, and
   `wait_for_completion=false` when the user wants a long/short or portfolio decision saved
   under `~/.alphacouncil-agent/runs/`. This returns a small durable accepted response with
   `run_id`, `status_json`, and `events_jsonl`; acceptance does not mean the report is done.
   For quick, do not pass task overrides and do not request `synthesis=false`. For full, the
   1800000 ms global maximum and parallel/barrier topology in the full contract above apply.
3. Poll `read_run(run_id)` at a bounded interval until `status.status` is terminal:
   `complete`, `degraded`, `incomplete`, `needs_verification`, `needs_revision`, or `failed`.
   Surface meaningful phase changes, not every unchanged poll. Poll the same `run_id`; never
   create a replacement because progress is slow. Only read/return `decision` and final
   artifacts after a terminal status. Use `wait_for_completion=true` only when the caller
   explicitly requires a synchronous run and its MCP connection is known to outlive the
   entire council.
4. Headless `analyze_symbol` does not run the host-visible Stage 2b verifier fan-out. Read
   `status.verification_scope`: `source_id_presence_only` means only that cited IDs resolve
   inside the saved packets, while `status.adversarial_verification=not_run` means the
   `source_fidelity`, `rederivation`, and `refuter` agents did not run. Use the Visible-First
   deep workflow when those verifiers are required; never relabel source-ID presence as
   adversarial verification.
5. Call `council_diagnostics` over saved run IDs to measure descriptive agreement, unique
   cited-source contribution, and repeated-input behavioural differentiation. Do not turn
   its seat count or agreement into `N_eff`; that remains `null` without the separately
   preregistered, signed, resolved-outcome ledger.
6. Headless MCP defaults to real `codex exec` workers. Pass `dry_run=true` only for explicit planning/self-test requests, not for a user-requested stock analysis.
7. Do not describe MCP `codex exec` workers as visible chat subagents. They are isolated
   background processes with `status.json`, `events.jsonl`, and `all_agents.md`. Each selected
   physical v3 method gets its own isolated voice worker after the deterministic stance is
   frozen, but that worker is not a persistent sidebar agent and is not the named person.
8. For full mode, any mandatory evidence failure closes the evidence barrier and terminates
   before masters, debate, and PM model calls. For quick, inspect the degraded ledger and the
   independent execution-status, evidence-coverage, and report-quality fields before handing
   off the result.

## Claude Code Parallel Path

This path is full-council-only. An explicit quick request always uses plugin-managed headless
`analyze_symbol`, even when the Task tool is available.

Use this path when running under Claude Code with the Task tool available. It reuses the exact same MCP run envelope and recording tools as the Visible-First and Headless workflows above; only the executor and the gating change. If the Task tool is NOT available, fall back to the Visible-First Workflow (or Headless MCP), and say so plainly per the fail-closed visibility rule.

Detect capability first: if you can emit `Task` subagent calls in one turn, prefer this path over the sequential fallback. Otherwise do not claim a parallel council ran.

### Model policy (cost-aware)

Opus on every subagent is expensive. Default to a tiered policy, and let the user override at launch:

- **Evidence analysts (Stage 1) and verifiers (Stage 2b)** → a fast, cheaper model (**Sonnet 4.6**, or **Haiku** for pure fetch/extract). These are bounded source-gathering jobs.
- **Bull/bear debate (Stage 3) and `portfolio_manager` verdict (Stage 4)** → the strongest model (**Opus 4.8**), because these carry the reasoning.

Default is "evidence on Sonnet, debate/verdict on Opus 4.8". Ask once at launch only to offer overrides ("all Opus" for max depth, "all Sonnet" for max thrift); otherwise use the default tiering. Set the model per `Task` subagent (`model:` option). If the host cannot set per-subagent models, say so and proceed on the host default.

### Language

Detect the user's language from their request and propagate it to EVERY subagent: each `Task` prompt, the evidence/debate/verdict content the subagents produce, and all workflow progress text shown in the main thread must be in that language (Chinese in -> Chinese throughout; Japanese in -> Japanese throughout). Keep JSON field names and role keys in English; translate values and prose. This matches the Preflight language rule.


### Stage 0 — Plan (envelope only)
Call `plan_visible_run` with `symbol`, `prompt` (original user request), `as_of`, inferred `language`, `council_mode: "full"`, and the Stage 0 `selection_receipt`. It returns `run_id`, the planned evidence agent specs, the selected master specs, the 3 debate agent specs, and artifact paths. This is planning only (SKILL step 9); do not treat it as execution. The tool rejects `council_mode: "quick"`.

Every planned prompt is written to `<run>/prompts/` and each agent spec carries `prompt_file`. Check `prompts_inline`: when it is `false` the prompt bodies were deliberately left out of the result, because returning them together would exceed what a host accepts, and you must `Read` each `prompt_file` instead of the inline field. What drives that size is the grounding each prompt embeds rather than the seat count, so a run with a full macro series crosses the budget where a sparse one does not. A truncated or rejected plan result is never a reason to write prompts from memory.

### Stage 1 — Evidence fan-out (one turn, isolated context)
In a SINGLE assistant turn, emit one `Task` (subagent_type: general-purpose) call for every evidence role returned by the plan. The default eight are `market_data`, `earnings_deep_dive`, `forward_expectations`, `quant_factor`, `valuation_long_short`, `news_industry_management`, `insider_sec`, and `ib_event_analysis`. Each subagent:
- May use ONLY `WebSearch` + `WebFetch`. It must NOT call `@alphacouncil-agent`, `collect_evidence`, `analyze_symbol`, or `read_run` (leaf-worker rule, Boundaries).
- Runs a query ladder: a primary-locator search (use `allowed_domains` such as `sec.gov` and the company IR/exchange domain), a dated recency search, and one mandatory disconfirming search (e.g. `<ticker> guidance cut`, `downgrade`, `accounting concern`).
- WebFetches the actual primary doc where one exists (`insider_sec` -> EDGAR full-text + Form 4; `earnings_deep_dive` -> 8-K Ex-99.1 plus the IR transcript; `ib_event_analysis` -> 8-K / 424B / deal release; `market_data` -> exchange/quote page) and quotes exact figures with real dates.
- Returns exactly one JSON evidence packet matching the Agent Output Contract, with a real `url` and `published_at` on every source and every paywalled/missing/stale item routed into `open_questions`.

### Stage 2 — Collect + barrier
As each Task returns, call `record_visible_packet(run_id, task, packet, thread_id=<subagent id>)`. The server upserts by `task`, rescopes sources to `<task>:S1`, rewrites `source_manifest.json` + `all_agents.md`, and flips the run phase toward `visible_debate`. HARD GATE: do not start the master stage or debate until every task returned by the full plan is recorded and completed. If a bounded repair still leaves a task failed or degraded, persist the run as `incomplete`, name the skipped downstream roles, and stop. Proceeding with fewer than the planned count violates the barrier.

### Stage 2b — Adversarial verify + repair (loop-until-dry, max 2 rounds)
Build a claim ledger from the merged packets (only non-low / thesis-bearing claims are "material"). For each material claim, fan out up to 3 verifier `Task` subagents in one turn, each with fresh context and seeing only the bare claim + ticker:
- source_fidelity: `WebFetch` the exact cited URL; return supported | partial | contradicted | source_unreachable | source_does_not_mention.
- rederivation: find the fact fresh from OTHER sources; return agree | disagree | cannot_confirm with a new source.
- refuter: search for disconfirming / newer evidence respecting `as_of` (newer truth that supersedes is a data gap, not a contradiction).
Compute per-claim survived-confidence: keep `high` only if source_fidelity != contradicted AND >=2/3 verifiers confirm; force DISPUTED on any contradiction; force UNVERIFIABLE if >=2 cannot_confirm/unreachable. Re-dispatch ONLY analysts with remaining `missing_claim_source_ids`, parse failures, or DISPUTED claims, with a stricter prompt; re-`record_visible_packet` (idempotent). Cap at 2 rounds; log residual gaps for the PM to report honestly. Verifiers also obey the leaf-worker rule.

### Stage 2c - Selected master methods

Run every `master_agent` returned by `plan_visible_run` after the evidence and verification barrier, and before the bull/bear debate. Physical v3 agents are explanation workers over an already frozen stance, including `out_of_scope`; append the completed Evidence JSON, require `acknowledged_stance` to match `frozen_stance`, and record each result with `record_master_opinion`. `masters_declined` documents the deterministic result but does not waive a returned visible explanation worker. HARD GATE: `status.json.pending_masters` must be empty before Stage 3.

### Stage 3 — Debate pipeline (3 rounds, parallel per round)
Run the documented rounds, each as a parallel fan-out of `bull_researcher` + `bear_researcher` fed the verified evidence:
- Round 1: bull writes the long case; bear writes the short case (parallel).
- Round 2: cross-feed each side the other's round-1 packet for rebuttal; require exactly
  three opponent questions in each returned `questions` array (parallel).
- Round 3: cross-feed the saved Round-2 questions; each side copies its own questions and
  answers the opponent's three as exact `{question, answer}` bindings in
  `questions_answered` (parallel). A missing, reordered, substituted or non-three
  question/answer array fails the Q&A gate and the run remains incomplete.
Persist each round via `record_visible_decision(run_id, role, packet)` so `all_agents.md` accumulates the full trace. DISPUTED/UNVERIFIABLE claims may appear in a thesis only with an explicit caveat.

### Stage 4 — Verdict + synthesize
Run one `portfolio_manager` `Task` fed the verified evidence plus all three debate rounds. Its packet MUST carry `report_markdown` as the complete report body with every authored contract section; the tool rejects a packet that does not, before taking the idempotency lock, and the rejection lists each missing section with the heading to use. Do not send a PM packet without it and expect the report to be assembled from the summary. The master bench and any instrument-structure section are system-appended and are never asked of you. Record it via `record_visible_decision(run_id, 'portfolio_manager', packet)`, which writes `decision.json` + `final_report.md` and marks the run complete. A successful PM response has `handoff_contract=inline_user_response_v1` and returns `user_response_markdown`; use that Markdown as the final user-facing response body instead of replacing it with a shorter recap. Its last section is the exact selected-seat count and one readable method statement per seat, including deterministic `out_of_scope` statements. Then link the complete report and audit artifacts in an appendix. The saved full report still contains the Analyst Work Log, Bull/Bear Debate record, verification ledger, all mandated sections, data gaps, horizons and `<task>:<source_id>` source table.

Honest limits: Task fan-out is best-effort, not a guaranteed workflow engine; enforce the barrier by polling artifacts, not by assuming. WebSearch/WebFetch is the only evidence channel (no financial API), so some numeric claims stay "narratively corroborated, not vendor-verified". This is the same auditable contract as the other paths — a stronger runner, not a different audit story.


## Agent Output Contract

Evidence agents return:

```json
{
  "task": "market_data",
  "symbol": "NOK",
  "as_of": "YYYY-MM-DD",
  "summary": "string",
  "claims": [{"claim": "string", "evidence": "string", "confidence": "high|medium|low", "source_ids": ["S1"]}],
  "metrics": {},
  "sources": [{"id": "S1", "title": "string", "url": "string", "published_at": "YYYY-MM-DD or unknown", "retrieved_at": "YYYY-MM-DD"}],
  "open_questions": ["string"],
  "confidence": "high|medium|low"
}
```

Debate agents return:

```json
{
  "role": "bull_researcher",
  "symbol": "NOK",
  "as_of": "YYYY-MM-DD",
  "verdict": "string",
  "rating": "Buy|Overweight|Hold|Underweight|Sell",
  "winner": "bull|bear|balanced|unknown",
  "summary": "string",
  "long_thesis": ["string"],
  "short_thesis": ["string"],
  "valuation_range": "string",
  "catalysts": ["string"],
  "risks": ["string"],
  "position": "string",
  "invalidation": ["string"],
  "source_ids": ["S1"],
  "confidence": "high|medium|low",
  "report_markdown": "string"
}
```

## Boundaries

- Public-equity-investing and investment-banking methodology is **bundled as local skills**
  (`skills/public-equity-investing`, `skills/investment-banking`); use them as the research method on
  BOTH editions. On Codex you may additionally use the curated remote `@public-equity-investing` /
  `@investment-banking` workflows; on Claude Code (or when the remote workflows are unavailable) the
  bundled local skills ARE the method, driven by `WebSearch` + `WebFetch`. Treat them as agent
  playbooks run by subagents, not Python libraries.
- Keep non-public information out of scope unless the user provides the document directly.
- For exact index / index-futures (incl. night session) / FX / rates / vol / commodity / stock levels, call the **`get_quote`** MCP tool (keyless, ~15m delayed; accepts names like `KOSPI`/`纳指期货`/`VIX`/`美元指数` or raw tickers) and cite it. Web search is the interpretation layer and the fallback when `get_quote` errors — then record the gap in `open_questions`. `get_quote` is delayed market data, never a real-time feed.
- Classify the instrument before choosing company-data routes. ETFs/funds use dated
  holdings look-through; cash indices use aggregate-index methodology. Do not call or ask
  for operating-company revenue, EPS, guidance, Form 4 or Company Facts as if they belonged
  to a fund/index. Cover methodology, holdings/constituent date and weights, concentration,
  fee or index rules, liquidity/tracking/flows, rebalances and same-date aggregate valuation
  with disclosed coverage; every missing field is an explicit gap.
- Every material claim should map back to an evidence packet with sources and confidence.
- Evidence sources are globally scoped as `<task>:<local_source_id>` and mirrored in `source_manifest.json`; never cite bare `S1/S2` after packets are merged.
- Full `full_v2` manager reports must include separate visible sections for market expectations / implied beat-miss thresholds, analyst rating or target-price revisions, earnings-call management signals, quant factor / technical risk view, news and management/industry voice signals, short interest / borrow / options where available, strategic transaction or banking-event terms where relevant, data gaps / unavailable data, and separate short-term 1-4 weeks / medium-term 3-6 months / long-term 12 months views. Do not hide these only in the source table. If a data source is unavailable, state that explicitly instead of omitting the section. If no key source is missing, include a data-gaps section saying no critical gaps were found.
- Full `full_v2` reports must also include an "Analyst Work Log" / "分析师工作记录" section summarizing every evidence agent packet, plus a "Bull/Bear Debate" / "多空辩论记录" section summarizing the long case, short case, rebuttals, exact Round-3 Q&A, unanswered questions, and who won. Do not replace these with a one-paragraph execution summary.
- Quick `quick_v1` reports use the fixed 13-section contract stated above. Do not fail a quick report merely because it lacks full-only quant, event-banking, three-horizon, three-round-Q&A, or adversarial-verifier sections; likewise, never present a passing quick report as full-equivalent.
- Terminal runs must preserve the standard artifacts appropriate to the executed contract, including `final_report.md`, `user_response.md`, `artifact_index.md`, `report_quality.json`, evidence-role Markdown, selected-method output, and bull/bear/PM output or explicit failure records. If `report_quality.json` is not `passed`, report `needs_revision`, not complete. A passing report-quality gate checks structure only: it does not convert a quick `degraded` execution into `complete` or prove evidence coverage.
- A full `user_response.md` lists all eight mandatory analyst statuses/summaries, every
  selected stable master ID with frozen stance and readable explanation/status, and one
  system-owned price snapshot with currency/time/source or an explicit unavailable gap. Its
  final section contains the exact selected-seat count and one statement per selected ID.
  Visible PM completion returns `user_response_markdown`; deliver it instead of an ACK recap.
- The `management_industry_voices` agent only uses publicly verifiable commentary from executives, board members, official company channels, customers, suppliers, competitors, regulators, industry experts, and channel voices. It must separate direct quotes, paraphrases, and media interpretation, and must not imply non-public inside information.
- Fail closed on visibility: if visible agent/thread tools are unavailable, say that visible subagents are unavailable in this runtime and use MCP only with that limitation stated.
- Never let a subagent call `@alphacouncil-agent`, `collect_evidence`, `analyze_symbol`, or `read_run`; visible agents are leaf workers.
