---
description: Equity research council — full run, quick read, mechanical screen, or market narrative
argument-hint: "[ticker] [fast|slow|quick|screen|market|options|news] · or just a question"
---

# /alpha

Request: **$ARGUMENTS**

## Route on the arguments — do not ask what they meant

| `$ARGUMENTS` looks like | Do this |
|---|---|
| *(empty)* | Print the mode table below and stop. Do not start a run. |
| a ticker alone, or a question | **Full council** at the `normal` pace. Go to "Full council" below. Plugin-managed headless is bound by the selected pace; visible-host execution has no bound at all. |
| ticker + `fast` / `slow` / `deep` | Full council with that tier **prefilled**. Still show the pace menu and take the answer, exactly as with a named master. |
| ticker + `quick` | The plugin-managed headless `quick_v1` council: 4 fixed analysts, 1-4 selected methods, one parallel bull/bear round and a short PM inside a hard 10-minute ceiling. |
| ticker + `screen` | `screen_ticker` only. No language-model judgment, no subagents. |
| ticker + `options` | `get_options_chain` only. |
| ticker + `news` | `get_news` on the symbol, and on its CIK when it is a US filer. |
| `market` (with or without a theme) | `get_market_narrative`. Add the theme as `extra_queries`. |

When `$ARGUMENTS` is empty, print exactly this and stop:

```
/alpha <TICKER>          full council — asks how deep to go, then shows every master
/alpha <TICKER> fast     same, with the 15-minute tier prefilled
/alpha <TICKER> slow     same, with the 60-minute tier prefilled
/alpha <TICKER> quick    quick_v1: 4 analysts incl. news + 1-4 masters + 1 parallel debate round (<=10m)
/alpha <TICKER> screen   mechanical filings screen only        (no model spend)
/alpha <TICKER> options  IV term structure, skew, positioning  (no model spend)
/alpha <TICKER> news     dated filings and headlines           (no model spend)
/alpha market <theme>    what the market is talking about      (no model spend)

you do not have to type a speed: the run asks, and shows the persistence ceiling for each
tier. all three tiers are the same full_v2 contract at three depths; quick is a SMALLER
contract (4 analysts, 1 debate round) and is never full-equivalent

examples
  /alpha AAPL            /alpha 0700.HK quick     /alpha 7203.T news
  /alpha NVDA slow       /alpha MSFT fast
  /alpha NVDA screen     /alpha market rates      /alpha "is TSM cheap?"
```

Any listed equity. Filings-based modes need a US filer; for other markets say which market it
is and use `market_coverage`, rather than returning nothing.

Say plainly that the four marked modes call keyless data tools and spawn no subagents, so
they cost nothing beyond this turn. Council modes can launch model workers; selected method
seats first complete deterministically (including recorded `out_of_scope`) and, on the
plugin-managed headless path, each selected v3 seat then gets one isolated voice worker that
may explain but cannot change the frozen stance. This is not the named person's real speech.

## Council selection gate — mandatory for full and quick

This gate happens before any research tool, run envelope, network fetch or subagent. It is
the same in Claude Code, Codex, OpenCode and Grok Build.

1. Call `begin_council_selection` with the symbol, original request, language, host and the
   intended `council_mode` (`full` by default; exactly `quick` for quick mode). If
   the request explicitly names masters, also pass those stable IDs as
   `preselected_master_ids`; if it named a speed, pass `council_pace`. Both highlight a choice
   without confirming it.
2. **Ask how deep to go first**, from the returned `pace_options`. It is a three-option
   question and the catalog is long, so it goes above the catalog. Show the persistence ceiling,
   per-stage budget and `observed_completion_status`; never relabel configured budgets as an
   expected duration:

   ```
   本次分析要跑多深？（默认 2）
     1. 快速   持久化上限 15 分钟；完整完成实测：尚未验证  每证据席 3.5 分钟，每轮辩论每侧 90 秒
     2. 标准   持久化上限 30 分钟；完整完成实测：尚未验证  每证据席 6 分钟，每轮辩论每侧 150 秒   ← 默认
     3. 深入   持久化上限 60 分钟；完整完成实测：尚未验证  每证据席 12 分钟，每轮辩论每侧 360 秒
   三档都是完整评议：同样 8 个证据席、同样三轮辩论、同样 PM，只是每席能想多久不同。
   ```

   Quick returns an empty menu and rejects the field; say so rather than offering a tier.
3. Show **every returned master individually, in the returned order and with its stable
   number**. Each row must include `identity`, `method`, `best_for` and `maturity`; a school
   name or a count is not a substitute for the individual catalog.
4. Ask for one submission covering both the tier and the seats. In full mode accept one number from `1..N`, combinations,
   ranges, stable IDs/names, or `all`. In quick mode the same complete returned catalog is
   displayed, but the submission must contain **1..4 seats** and `all` / `select_all` is
   forbidden. A host-native multi-select is a convenience only. If it is unavailable or
   cannot show the full catalog, use the numbered text table and plain reply on every host.
5. If the original full-mode request already named masters or said `all`, prefill that choice but
   **still show the full catalog and require this run's submission**. Do not silently reuse a
   prior choice. For quick, prefill at most four named methods and ask the user to reduce an
   oversized/`all` request to 1-4. The submitted choice is the confirmation; do not ask a
   second confirmation.
6. Call `confirm_master_selection` with the returned `selection_id`, `catalog_hash`,
   `display_ack: true`, the answered `council_pace` (omit to accept `normal`), and exactly one
   of `selected_master_ids`, `select_all: true`, or `selection`. Retain the returned
   one-use `selection_receipt`. The pace binds into it: an execution call may repeat the confirmed tier
   but never change it, so a user who approved 15 minutes cannot end up running an hour.
7. Only now call `plan_visible_run` (full only), `collect_evidence` (full only), or
   `analyze_symbol`, passing that `selection_receipt` and the same symbol, prompt, language
   and `council_mode`. Quick must use `analyze_symbol`. Do not also pass `masters` or
   `masters_roster`; the receipt is authoritative and mode-bound. A full receipt cannot start
   quick and a quick receipt cannot start full. For missing, expired, stale or consumed
   receipts, or for a mode mismatch, restart from `begin_council_selection`.

`screen`, `options`, `news` and `market` are data-only modes and skip this gate. `quick` is
still a council judgment, so it never skips the gate; it changes the analyst fan-out, not the
master-selection contract.

## Full council

1. Complete the mandatory council selection gate above. Analysts default to the eight-seat
   fan-out; do not ask about them.
2. Follow `skills/alphacouncil-agent/SKILL.md` from Stage 0. Do not improvise a shorter
   workflow: a report that looks finished and skipped the bench is worse than an obviously
   partial one.
3. **Call the tools rather than searching for numbers they can supply.** `screen_ticker`,
   `get_quote`, `get_options_chain`, `get_macro_snapshot`, `get_news`. Search is for
   explanation and for what is not yet filed.
4. Every selected master must report before the run is complete. `out_of_scope` is a
   conclusion, not an abstention.
5. Give price bands with the condition attached to each. "The cycle position is undetermined"
   changes what the bands depend on; it does not excuse leaving them out.
6. Full mode fails closed at the evidence barrier. If any mandatory evidence role still
   fails after its bounded parse repair, do not spend more model calls on masters, bull/bear
   or PM. Persist an `incomplete` run naming the failed evidence and skipped downstream roles.
7. For the hard runtime contract, call plugin-managed headless `analyze_symbol` once with
   `council_mode:"full"`, `wait_for_completion:false`, the full-mode receipt, and
   `council_pace` when the arguments asked for a speed: `fast` for 15 minutes, `slow` (or
   `deep`) for 60, omitted for the 30-minute default. Poll the same durable `run_id` to
   terminal. All eight mandatory evidence roles start in one wave; every selected v3 method
   gets a frozen deterministic stance plus its own isolated voice worker; Bull/Bear run in
   parallel within each of three rounds with a barrier between rounds; then the PM runs.
   Queueing, retries and final persistence share the selected tier's clock. At expiry the
   saved run is `incomplete`, never silently shortened or relabeled complete. This guarantees
   terminal persistence, not all-seat success during search/model/data-provider degradation.
   Pass `total_timeout_ms` only to LOWER the tier's budget; above it the call is rejected.
   Tell the user which pace ran and what it bought: the tier raises every per-stage cap, so
   `slow` gives each evidence seat 12 minutes instead of 6 and each debate round 6 minutes per
   side instead of 150 seconds. All three paces are the same `full_v2` contract.
   `normal` is the pace to default to and the one to recommend when the user asks for a
   complete, presentable report. Measured stage floors for a complete council are ~262s of
   evidence, ~106s for the slowest method voice, ~142s per debate round and ~108s for the PM,
   which lands a clean run around eighteen minutes -- inside `normal` and outside `fast`.
   Say so plainly if the user asks for fifteen minutes: `fast` cannot hold a complete
   three-round council, and it spends its shorter clock on evidence and the bench.
8. `plan_visible_run` is owned by the external host. The plugin cannot force-stop its Task
   agents, so visible-host full must not be advertised as meeting the 30-minute deadline.
9. The terminal full handoff must include the system price snapshot (or explicit unavailable
   gap), every selected stable master ID/stance/voice-worker explanation or failure, and all
   eight analyst statuses and summaries. A method-seat explanation is a recorded provisional
   lens output, never a quotation, endorsement or current statement by the named person.
   System-owned labels support `zh-CN`, `en`, `ja` and `ko`; propagate the request language
   to every worker.

## Quick mode — plugin-managed headless quick_v1

Quick is an explicit, bounded council contract, not an automatic downgrade of full and not a
visible-host orchestration. `plan_visible_run` rejects `council_mode=quick`; run it through
plugin-managed headless `analyze_symbol` so the server can enforce the deadline.

1. Complete Stage 0 with `council_mode: "quick"`; display every method returned by the selector and confirm 1-4.
2. Call `analyze_symbol` once with the exact same prompt/language/mode and one-use receipt,
   `dry_run:false`, `wait_for_completion:false`, and optionally `total_timeout_ms` no greater
   than `600000`. Do not pass `tasks`: quick fixes and starts these four roles in parallel:
   `market_data`, `earnings_deep_dive`, `valuation_long_short`,
   `news_industry_management`.
3. The news role covers the highest-impact company and industry developments from the 120
   days ending at `as_of`; future, undated and older items are excluded from recent news.
4. The hard end-to-end budget starts with the durable queued run and includes a 20-second
   grounding wait, evidence workers capped at 210 seconds each, up to four master workers in
   parallel capped at 90 seconds each, one bull/bear statement round in parallel capped at
   90 seconds per side, one short PM capped at 90 seconds, retries and a 20-second
   finalization reserve. Callers may lower the total but never raise it above 600000 ms.
5. No round-2 rebuttal, round-3 exact Q&A or adversarial verifier fan-out runs. Scoped source
   IDs are still checked. The report uses `quick_v1`, not `full_v2`, and
   `full_council_equivalent` is false.
6. Poll the same run with `read_run`; never create a replacement run. Terminal statuses are
   `complete`, `degraded`, `incomplete`, `needs_verification`, `needs_revision`, and `failed`.
7. `degraded` is a real quick terminal state, not success renamed: at least 2 of 4 evidence
   roles completed, every failed role has a sanitized recorded packet/diagnostic, at least
   one bull/bear side completed, the PM completed and all selected methods were recorded.
   The system-owned degraded ledger and handoff must name every degraded task/side and cause.
8. The concise handoff must include rating/winner/confidence, every selected stable master ID
   and stance, all four analyst statuses and summaries, dated recent news, valuation/position,
   data gaps and artifact paths. Method-seat output is a recorded lens result, never a quote
   from the named person. State explicitly that quick is not equivalent to full council.

## Screen mode

A rule whose inputs are missing is `skipped`, **never a pass** — reporting "6/7 passed"
without naming the seventh misrepresents the screen. Surviving is not a recommendation; it
means the name is worth research time. For a non-US ticker, say which market it is and use
`market_coverage` rather than returning nothing.

## Market mode

Read it by the gap, not the ranking. A theme leading coverage while its series has not moved
means the story is ahead of the data, or the market stopped listening — say which. A series
that moved sharply while its theme is barely covered is the more valuable finding. Headline
counts measure attention, never truth.

## Never

- Never fill a number from memory when a tool could have supplied it.
- Never let social or narrative evidence enter the conclusion on its own.

Educational software. The report says so.
