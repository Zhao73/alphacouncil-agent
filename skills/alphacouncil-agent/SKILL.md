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

Ask only when the user explicitly requests option selection before launch. Always pass the original user request in `prompt`, and pass the inferred language as `language` to AlphaCouncil Agent MCP tools.

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
