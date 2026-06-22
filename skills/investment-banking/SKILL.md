---
name: investment-banking
description: Local, edition-agnostic investment-banking / event-analysis methodology playbook for AlphaCouncil's ib_event_analysis role (and any M&A, ECM, debt, buyback, or strategic-transaction question). On Codex this replaces or supplements the curated remote @investment-banking workflow; on Claude Code it IS the workflow (driven by WebSearch + WebFetch). No financial-data API or vendor key required.
---

# Investment Banking — Event Analysis (bundled playbook)

This skill lets AlphaCouncil analyze corporate transactions and banking events **without** depending on
Codex's curated remote `@investment-banking` plugin. Runnable method with gates, evidence via
`WebSearch` + `WebFetch`.

> Educational/research only. Not investment advice, not a solicitation. Report missing data honestly.

## When to use

For the `ib_event_analysis` role, or whenever the request involves a deal/transaction: M&A, equity
issuance (ECM/secondary/ATM), debt issuance/refinancing, buyback/dividend, spin-off/divestiture, or a
strategic transaction (e.g. major supply/partnership terms). Return the standard evidence packet; keep
JSON field names in English, prose in the user's language.

## Deal taxonomy → what to extract

- **M&A** — acquirer/target, consideration (cash/stock/mix), price + premium to unaffected, structure,
  financing, expected synergies, accretion/dilution, conditions, regulatory/antitrust path, break fee,
  expected close.
- **ECM** — offering size, type (primary/secondary/ATM/convertible), price/discount, dilution %, use of
  proceeds, lockups, underwriters.
- **Debt** — size, tenor, coupon/spread, secured/unsecured, use of proceeds (refi vs growth), covenant
  and maturity-wall impact, rating action.
- **Buyback / dividend** — authorization size vs market cap, pace, funding source, signal vs dilution
  offset, capital-allocation tradeoff.
- **Spin-off / divestiture** — perimeter, rationale, stranded costs, pro-forma leverage, tax treatment.
- **Strategic transaction** — counterparty, scope, exclusivity, financial terms where disclosed, the
  earnings/strategic impact.

## Sourcing ladder (per claim, in order)

1. **Primary filing/release first**: the 8-K and its exhibits, 424B / S-4 / proxy (DEFM14A), the deal
   press release on the issuer IR domain, and the rating-agency release. Non-US → the local
   exchange/regulator filing.
2. Dated, scoped search (issuer IR + `sec.gov` + the named counterparty), then one disconfirming query
   (`<deal> regulatory block` / `antitrust` / `financing risk` / `terminated`).
3. **WebFetch the actual document**; quote exact terms (price, premium, size, coupon, close date) with
   dates.
4. Corroborate headline terms across the filing AND a second independent source; single-source → `medium`.
5. Paywalled/unconfirmed/rumored → `open_questions`; clearly label rumor vs confirmed.

## Analysis to produce

- **Terms table** — the hard numbers (price, premium, size, %, dates) each mapped to a `source_id`.
- **Impact** — accretion/dilution, pro-forma leverage/coverage, EPS and capital-structure effect.
- **Risk path** — regulatory/antitrust, financing, shareholder-vote, MAC/closing conditions, timeline.
- **Read-through** — what the deal implies for the thesis (catalyst or invalidation), feeding the
  bull/bear debate and the portfolio-manager verdict.

## Gates (must pass before the packet is "done")

1. **Primary-document gate** — headline terms come from the filing/release, not a paraphrase; each has a
   real `url` + `published_at`.
2. **Confirmed-vs-rumor gate** — anything not in a filing/official release is labeled rumor and
   confidence-capped.
3. **Quantify gate** — premium, dilution %, leverage delta, and close date are stated as numbers or
   explicitly listed as unavailable in `open_questions`.
4. **Honesty gate** — no invented terms; unknowns are surfaced, not guessed.

## Anti-rationalizations

- "The press summarized it" → fetch the actual 8-K/424B and quote exact terms.
- "Premium is roughly X" → compute it from the disclosed price vs the unaffected price, with both dates.
- "It'll obviously clear regulators" → state the actual approval path and the real risk, or mark unknown.
