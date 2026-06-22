---
name: alphacouncil-agent
description: Use AlphaCouncil Agent for listed-equity research workflows that need multiple Codex subagents, shared evidence packets, public-equity analysis, banking/event analysis, filings/news search, valuation, long/short pitch work, risk debate, or portfolio-manager style decisions.
---

# AlphaCouncil Agent

Use this plugin when the user invokes `@alphacouncil-agent` or asks for a multi-agent public-equity research workflow.

## Preflight Interaction

Do not ask startup option questions by default. For underspecified requests such as `@alphacouncil-agent 帮我看看 NOK`, infer:

- language: user's apparent language
- goal: entry/actionability judgment
- horizon: include short-term 1-4 weeks, medium-term 3-6 months, and long-term 12 months in the final report

Ask only when the user explicitly requests option selection before launch. Use the inferred language for visible main-thread preflight/progress updates, visible agent prompts, evidence packets, debate packets, and final synthesis unless the user explicitly requests another language. Always pass the original user request in `prompt`, and pass the inferred language as `language` to AlphaCouncil Agent MCP tools.

## Visible-First Workflow

Use visible Codex subagents whenever the user asks to see subagents, asks for a chat-style analyst team, says child agents must be visible, or invokes `@alphacouncil-agent` for an investment decision without explicitly requesting headless/background mode.

Default to the full workflow. Do not downgrade to a lite/smoke/visible-only summary unless the user explicitly asks for lite, smoke test, or debug output. Do not describe the final user-facing report as "visible version", "lite", "smoke", or "debug"; those are execution details, not investment-report content.

1. If `multi_agent_v1.spawn_agent` is available, spawn separate visible agents for the full default analyst team:
   - `market_data`
   - `earnings_deep_dive`
   - `forward_expectations`
   - `sell_side_revisions`
   - `earnings_call_transcript`
   - `quant_factor`
   - `valuation_long_short`
   - `news_industry_management`
   - `management_industry_voices`
   - `insider_sec`
   - `ib_event_analysis`
   - `bull_researcher`
   - `bear_researcher`
   - `portfolio_manager`
2. Give each visible agent a narrow prompt and require JSON evidence or debate output. Tell each agent not to call `alphacouncil-agent` recursively.
3. Use the selected or inferred language for visible agent prompts, evidence packets, debate packets, and final synthesis. Keep JSON field names in English.
4. Wait for the evidence agents, merge their outputs into a shared evidence set in the main thread, then run bull, bear, and portfolio-manager agents.
   - Round 1: bull writes the long case; bear writes the short case.
   - Round 2: pass bull's packet to bear for rebuttal, and bear's packet to bull for rebuttal.
   - Round 3: each side asks three questions; the other side answers them.
   - Final: portfolio_manager reads evidence plus all debate rounds and decides whether bull, bear, or balanced won.
5. Return the complete final report in the selected or inferred language in the main thread. The final report itself must be comprehensive enough to read without opening artifacts: include each evidence analyst's summary, key data/news/filing/quant findings, the bull case, bear case, rebuttals/questions where available, portfolio-manager verdict, data gaps, and source table. Include links/paths to saved artifacts only after the report or in a short appendix.
   - If the Data Analytics `datascienceWidgets` tools are available, also create a real dashboard/report artifact from the completed evidence and decision: call `validate_artifact` first, then `render_artifact`. Do not treat `output_mode=data_analytics` as only a prose style.
   - If Documents, PDF, Spreadsheets, or Presentations are requested as output formats, use their plugin/skill workflow as a delivery layer after the investment decision is complete; do not move investment judgment into those format plugins.
6. If the user specifically wants left-sidebar Codex chat threads, use `codex_app.list_projects` and `codex_app.create_thread` instead of MCP headless execution. Create one thread per major role and report the created thread IDs.
7. Do not treat `plan_visible_run` as execution. It only creates the run envelope and prompts; visible agents/threads must actually be created and read before final synthesis.

## Headless MCP Workflow

Use MCP only when the user explicitly accepts background/headless execution, wants saved files, or asks to inspect/re-run a previous saved run.

1. Call `collect_evidence` when the request needs source gathering and file artifacts.
2. Call `analyze_symbol` when the user wants a complete long/short or portfolio decision saved under `~/.alphacouncil-agent/runs/`.
3. Call `read_run` to inspect a saved evidence run.
4. Headless MCP defaults to real `codex exec` workers. Pass `dry_run=true` only for explicit planning/self-test requests, not for a user-requested stock analysis.
5. Do not describe MCP `codex exec` workers as visible chat subagents. They are background workers with `status.json`, `events.jsonl`, and `all_agents.md`.

## Claude Code Parallel Path

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
Call `plan_visible_run` with `symbol`, `prompt` (original user request), `as_of`, and inferred `language`. It returns `run_id`, the 11 evidence agent specs, the 3 debate agent specs, and artifact paths. This is planning only (SKILL step 7); do not treat it as execution.

### Stage 1 — Evidence fan-out (one turn, isolated context)
In a SINGLE assistant turn, emit 11 `Task` (subagent_type: general-purpose) calls, one per evidence role: `market_data`, `earnings_deep_dive`, `forward_expectations`, `sell_side_revisions`, `earnings_call_transcript`, `quant_factor`, `valuation_long_short`, `news_industry_management`, `management_industry_voices`, `insider_sec`, `ib_event_analysis`. Each subagent:
- May use ONLY `WebSearch` + `WebFetch`. It must NOT call `@alphacouncil-agent`, `collect_evidence`, `analyze_symbol`, or `read_run` (leaf-worker rule, Boundaries).
- Runs a query ladder: a primary-locator search (use `allowed_domains` such as `sec.gov` and the company IR/exchange domain), a dated recency search, and one mandatory disconfirming search (e.g. `<ticker> guidance cut`, `downgrade`, `accounting concern`).
- WebFetches the actual primary doc where one exists (insider_sec -> EDGAR full-text + Form 4; earnings_deep_dive / earnings_call_transcript -> 8-K Ex-99.1 / IR transcript; ib_event_analysis -> 8-K / 424B / deal release; market_data -> exchange/quote page) and quotes exact figures with real dates.
- Returns exactly one JSON evidence packet matching the Agent Output Contract, with a real `url` and `published_at` on every source and every paywalled/missing/stale item routed into `open_questions`.

### Stage 2 — Collect + barrier
As each Task returns, call `record_visible_packet(run_id, task, packet, thread_id=<subagent id>)`. The server upserts by `task`, rescopes sources to `<task>:S1`, rewrites `source_manifest.json` + `all_agents.md`, and flips the run phase toward `visible_debate`. HARD GATE: do not start debate until all 11 packets are recorded (assert each `task` is completed or explicitly degraded; poll `status.json` if needed). Proceeding with k<11 violates the barrier.

### Stage 2b — Adversarial verify + repair (loop-until-dry, max 2 rounds)
Build a claim ledger from the merged packets (only non-low / thesis-bearing claims are "material"). For each material claim, fan out up to 3 verifier `Task` subagents in one turn, each with fresh context and seeing only the bare claim + ticker:
- source_fidelity: `WebFetch` the exact cited URL; return supported | partial | contradicted | source_unreachable | source_does_not_mention.
- rederivation: find the fact fresh from OTHER sources; return agree | disagree | cannot_confirm with a new source.
- refuter: search for disconfirming / newer evidence respecting `as_of` (newer truth that supersedes is a data gap, not a contradiction).
Compute per-claim survived-confidence: keep `high` only if source_fidelity != contradicted AND >=2/3 verifiers confirm; force DISPUTED on any contradiction; force UNVERIFIABLE if >=2 cannot_confirm/unreachable. Re-dispatch ONLY analysts with remaining `missing_claim_source_ids`, parse failures, or DISPUTED claims, with a stricter prompt; re-`record_visible_packet` (idempotent). Cap at 2 rounds; log residual gaps for the PM to report honestly. Verifiers also obey the leaf-worker rule.

### Stage 3 — Debate pipeline (3 rounds, parallel per round)
Run the documented rounds, each as a parallel fan-out of `bull_researcher` + `bear_researcher` fed the verified evidence:
- Round 1: bull writes the long case; bear writes the short case (parallel).
- Round 2: cross-feed each side the other's round-1 packet for rebuttal (parallel; main thread reads `bull_researcher.json` / `bear_researcher.json` and pastes into the next prompts).
- Round 3: each side asks three questions; the other answers (parallel).
Persist each round via `record_visible_decision(run_id, role, packet)` so `all_agents.md` accumulates the full trace. DISPUTED/UNVERIFIABLE claims may appear in a thesis only with an explicit caveat.

### Stage 4 — Verdict + synthesize
Run one `portfolio_manager` `Task` fed the verified evidence plus all three debate rounds. Record it via `record_visible_decision(run_id, 'portfolio_manager', packet)`, which writes `decision.json` + `final_report.md` and marks the run complete. Then return the complete report inline (SKILL step 5) in the user's language, including the Analyst Work Log, Bull/Bear Debate record, the verification ledger (per material claim: self-confidence, verifier tally, source-fidelity, survived-confidence), all mandated sections, data gaps, short/medium/long-term views, and the `<task>:<source_id>` source table. Link artifacts only in an appendix.

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

- Treat Public Equity Investing and Investment Banking as Codex skills run by subagents, not Python libraries.
- Keep non-public information out of scope unless the user provides the document directly.
- Use structured market data for exact prices, financial statements, and indicators when available; use Codex web search as an evidence and interpretation layer.
- Every material claim should map back to an evidence packet with sources and confidence.
- Evidence sources are globally scoped as `<task>:<local_source_id>` and mirrored in `source_manifest.json`; never cite bare `S1/S2` after packets are merged.
- Final manager reports must include separate visible sections for market expectations / implied beat-miss thresholds, analyst rating or target-price revisions, earnings-call management signals, quant factor / technical risk view, news and management/industry voice signals, short interest / borrow / options where available, NVIDIA or other strategic transaction terms where relevant, data gaps / unavailable data, and separate short-term 1-4 weeks / medium-term 3-6 months / long-term 12 months views. Do not hide these only in the source table. If a data source is unavailable, state that explicitly instead of omitting the section. If no key source is missing, include a data-gaps section saying no critical gaps were found.
- Final manager reports must also include an "Analyst Work Log" / "分析师工作记录" section summarizing every evidence agent packet, plus a "Bull/Bear Debate" / "多空辩论记录" section summarizing the long case, short case, rebuttal, unanswered questions, and who won. Do not replace these with a one-paragraph execution summary.
- The `management_industry_voices` agent only uses publicly verifiable commentary from executives, board members, official company channels, customers, suppliers, competitors, regulators, industry experts, and channel voices. It must separate direct quotes, paraphrases, and media interpretation, and must not imply non-public inside information.
- Fail closed on visibility: if visible agent/thread tools are unavailable, say that visible subagents are unavailable in this runtime and use MCP only with that limitation stated.
- Never let a subagent call `@alphacouncil-agent`, `collect_evidence`, `analyze_symbol`, or `read_run`; visible agents are leaf workers.
