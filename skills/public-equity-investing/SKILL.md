---
name: public-equity-investing
description: Local, edition-agnostic equity-research methodology playbook for AlphaCouncil analysts. Use as the research method for the evidence roles (market_data, earnings_deep_dive, forward_expectations, sell_side_revisions, earnings_call_transcript, quant_factor, valuation_long_short, news_industry_management, management_industry_voices, insider_sec). On Codex this replaces or supplements the curated remote @public-equity-investing workflow; on Claude Code it IS the workflow (driven by WebSearch + WebFetch). No financial-data API or vendor key required.
---

# Public Equity Investing (bundled playbook)

This skill gives every AlphaCouncil analyst the same deep-research method **without** depending on
Codex's curated remote `@public-equity-investing` plugin. It is a runnable method with gates, not a
style guide. Evidence is gathered live via the agent's own web search (`WebSearch` + `WebFetch`).

> Educational/research only. Not investment advice. Report missing data; never fabricate figures.

## When to use

Whenever an AlphaCouncil evidence analyst runs. Each analyst applies the **sourcing ladder** and its
**role focus** below, then returns the standard JSON evidence packet (see AlphaCouncil's Agent Output
Contract). Keep JSON field names in English; write prose in the user's language.

## Sourcing ladder (per claim, in order)

1. **Primary document first.** Prefer the issuer/regulator over aggregators:
   - filings → SEC EDGAR full-text (`sec.gov`), 10-K/10-Q/8-K, 424B, Form 4; non-US → the local
     regulator / exchange filing (HKEX, SEHK, EDINET, etc.).
   - earnings → the 8-K Ex-99.1 press release and the IR deck / transcript on the company IR domain.
   - price/quote → the exchange or a named quote page, with the exact as-of timestamp.
2. **Dated, scoped search.** Run a primary-locator query (restrict to `sec.gov` + the company IR/exchange
   domain), then a recency query (`<ticker> <topic> <year>`), then ONE mandatory disconfirming query
   (`<ticker> guidance cut` / `downgrade` / `accounting concern` / `short thesis`).
3. **WebFetch the actual page** and quote exact numbers with their real dates (signal date, source
   publication date, retrieval date are distinct).
4. **Corroborate** any market-moving number across at least two independent sources; if only one exists,
   mark confidence `medium` and say so.
5. **Anything paywalled / stale / unfetchable → `open_questions`.** Do not invent it.

## Role focus

- `market_data` — price action, liquidity/volume, range vs 20/50/200-day, relative strength vs index/peers.
- `earnings_deep_dive` — last reported quarter: revenue/margins/segments, surprises vs consensus, guidance.
- `forward_expectations` — consensus estimates, implied beat/miss thresholds, what's priced in.
- `sell_side_revisions` — rating and target-price changes (who, when, from→to), dispersion of targets.
- `earnings_call_transcript` — management tone, commitments, hedges, repeated themes, Q&A pressure points.
- `quant_factor` — momentum, trend, volatility, volume/liquidity, relative strength, short interest,
  borrow, options IV/skew/expected move when available.
- `valuation_long_short` — see Valuation frameworks below; produce a long thesis AND a short thesis.
- `news_industry_management` — recent catalysts, industry context, regulatory/competitive backdrop.
- `management_industry_voices` — publicly verifiable commentary only; separate direct quote vs paraphrase
  vs media interpretation; never imply non-public information.
- `insider_sec` — Form 4 insider transactions, buybacks, dilution, debt, capital allocation.

## Valuation frameworks (valuation_long_short)

Use at least two, and state assumptions explicitly:

- **Comparables** — peer EV/EBITDA, P/E, P/S, EV/Sales with the peer set named and dated.
- **DCF / reverse-DCF** — what growth + margin the current price already implies; is it achievable?
- **Scenario** — bear / base / bull price targets with the trigger for each.
- **Catalyst & invalidation** — name the events that confirm or break the thesis.

Output a `valuation_range` plus the long thesis and short thesis; map every number to a `source_id`.

## Gates (must pass before a packet is "done")

1. **Primary-source gate** — every material claim cites a real `url` with a `published_at`; no bare
   aggregator paraphrase for a market-moving number.
2. **Disconfirming gate** — you ran at least one query designed to break the thesis.
3. **Recency gate** — figures carry real dates; stale data is flagged, not presented as current.
4. **Honesty gate** — missing/unavailable data is listed in `open_questions`; confidence reflects it.

## Anti-rationalizations

- "I already know this stock" → markets move; re-fetch dated primaries anyway.
- "One source is enough" → corroborate market-moving numbers or mark `medium`.
- "Close enough" → quote the exact figure and date, or route to `open_questions`.
