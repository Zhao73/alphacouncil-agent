# Method Skill pilot — 2026-08-03

## Decision

Adopt the four public single-person Skills' common presentation mechanics clean-room across all
26 active methods: direct `I` / `我`, verdict first, characteristic vocabulary and reasoning
order, and an explicit condition that changes the view. Keep their raw text and ungoverned
identity/current-view instructions as A/B controls. Use `alphacouncil-method-lenses` after
evidence validation and, when present, after the deterministic executor freezes the result.
Neither arm may replace the deterministic executor.

The active catalog contains 25 named public-method references plus one composite forensic-short
method. They are project-derived, provisional lenses—not replicas of the people, endorsements,
quotations, current opinions, validated method models, or 26 independent statistical samples.

## What was compared

Arm A used the public Buffett, Duan Yongping, Munger, and Taleb prompt Skills listed in
`skills/alphacouncil-method-lenses/references/public-repository-pilots.md`. Arm B used the new
router, the corresponding on-demand reference, the full-evidence input contract, and the output
contract. Four methods covered value, business quality, multidisciplinary risk, and tail risk.

Each pair received the same frozen synthetic fact record. Negative controls removed one decisive
fact and injected an unattributed numerical “quotation.” No experiment used a person's private
information or claimed to obtain that person's current view.

## Formal result

The raw machine-simulation `seat_inputs` are not `full-evidence-input-v1`: they do not carry the
case wrapper, source manifest, claim and coverage ledgers, artifact references, and complete
bindings. Arm B therefore returned `out_of_scope` for every formal attempt. That is the correct
contract result, not a method vote and not a failed analysis.

Arm A can produce fluent, recognisably first-person prose directly from the raw fields, but it has no mandatory input hash,
typed-fact/unit gate, rule IDs, native state, claim-level source lineage, or stable fail-closed
object. The revised governed arm adopts their direct first-person presentation while preserving
fact, rule, source, frozen-stance and output gates. Fluency alone remains insufficient evidence
of method fidelity or auditability.

## Diagnostic replay

The following paths were replayed only after assuming that an external validator had already
verified each fact pack. They are diagnostic policy traces, not formal Skill outputs and not a
registered benchmark.

| Method | Complete synthetic facts | Critical-fact deletion |
|---|---|---|
| Buffett | `1/3`, `provisional_reject`, opposed | missing owner earnings → fail closed |
| Duan Yongping | `2/3`, `provisional_wait`, cautious | missing five-year FCF → `provisional_do_not_understand` |
| Munger | `2/3`, `provisional_monitor`, cautious | missing incremental return → `out_of_scope` |
| Taleb | absorbing-barrier veto, `provisional_no_trade`, opposed | missing downside floor → `out_of_scope` |

The prose-only public Skills could often say “too hard,” “do not invest in what is not understood,”
or “fragile,” but those refusals were discretionary. They did not emit an immutable missing-fact
record and could continue from adjacent facts. An unsupported quote was not provenance-checked;
even if the model declined to repeat it, the first-person persona instruction still violated the
project boundary. Arm B rejected the quote outside typed facts and rejected the whole input when
it was inserted without source lineage.

## Comparative score

Five is best. These are pilot judgments over four methods and three test shapes, not statistical
performance estimates.

| Dimension | Public prompt Skills (A) | Governed Method Lenses (B) |
|---|---:|---:|
| Method differentiation | 3.0 | 4.0 |
| Fact/rule traceability | 1.0 | 3.5 |
| Correct refusal on missing decisive facts | 1.5 | 5.0 |
| Unsupported-number control | 1.5 | 4.5 |
| No fabricated quotation or impersonation | 0.0 | 5.0 |
| Stable output structure | 1.0 | 5.0 |
| Suitable as a governed explanation layer | 1.2 | 4.5 |
| Eligible to replace deterministic execution | 0.0 | 0.0 |

## Defects found and disposition

The pilot found that the synthetic Duan input had encoded
`financial.free_cash_flow_5y` as `ratio/decimal` even though its canonical contract and the
opportunity-cost output are `monetary/currency_units`. The fixture generator now uses the shared
canonical fact contracts; the evidence validator checks known fact IDs; and the deterministic
executor rejects comparisons across different value kinds. The regenerated D26 simulation still
executes 26/26 seats.

The same audit found that the policy-only `macro.growth_regime` enum had fallen through the old
numeric fallback. It now has an explicit text contract and synthetic regime state, while the
executor rejects a typed fact compared with a literal of the wrong JavaScript type.

Three provisional policy comparisons remain dimensionally questionable even though both sides
share the broad `ratio` kind:

- Natenberg: annualised implied volatility versus round-trip cost as a fraction of mid;
- Sinclair: round-trip cost as a fraction of mid versus annualised implied volatility;
- Thorp: a generic decimal net edge versus bid/ask as a fraction of mid.

These are explicit human formula-adjudication blockers. Exact ratio-unit admission is not relaxed
into a production claim: all affected tools remain `local_test_only`, `production_eligible=false`,
and the production assembly gate remains closed.

## Remaining release gates

- Human method-attribution approval for the 25 named references and the composite method.
- Claim-to-primary-source adjudication and human review of every formula and threshold.
- A full-evidence adapter that produces the required source, claim, coverage, artifact, and hash
  bindings from a real council run.
- Registered multi-case evaluation with missing-data, time-travel, unit-tampering, name-swap,
  policy-swap, evidence-swap, and fabricated-quote negative controls.
- Live four-host end-to-end verification. A package smoke test is not that verification.
