# Roadmap

Where this plugin is going, and the reasoning that decides it. Dated entries, newest first.
Anything here is a statement of intent, not a shipped feature. Shipped work lives in
`CHANGELOG.md`.

## 0.9.0 solo-test - all 26 seats become physically testable v3 operator lenses

0.9.0 is the declared **solo-test** package channel. It adds a mandatory per-run individual
master selector and an isolated, physically testable tree of 26 v3 packs with 52 executable
`provisional_derived_proxy` tools. Every pack remains a provisional `operator_lens`;
operational = 0, `method_model` = 0, human source/formula approvals and approval signatures
= 0. The chooser and executable proxies do not make any seat an approved named method.

Formal production GA remains fail-closed until the source, formula, experiment, host,
release-operation and admission gates in `docs/plans/0.9.0-personapack-v3.md` pass. No seat
count is reported as a count of independent information sources. Exact solo-test verification
is recorded in `docs/solo-test-0.9.0.md`.

## The problem that shapes everything after 0.6.0

A user asked why the master bench never appears in the report. Answering it surfaced a
larger defect, and the larger defect is the one worth stating plainly:

> Twenty-one masters are twenty-one prompt voices, not twenty-one independent sources.
> They share a base model, a batch of evidence, a training corpus, a context bias, and
> therefore a set of factual errors. "Twenty-one votes" is not twenty-one samples. It can
> be one error repeated in twenty-one investing accents.

This is correct, and the published literature is harsher than the summary above.

- Contemporary LLM errors are **>60% correlated**, so naive ensembling has a non-zero
  error floor. ([Minority Sentinel](https://arxiv.org/html/2606.29270v1))
- Majority voting inherits its legitimacy from the **Condorcet Jury Theorem**, which
  requires *independent* errors. Shared pretraining violates the premise outright.
- When agents are handed **identical information**, deliberation does not raise collective
  accuracy — they already agreed, and exchanging messages only hardens the shared prior.
  ([Diverse Evidence, Better Forecasts](https://arxiv.org/html/2607.01661v1))
- With identical inputs, debate forms a **martingale**: expected correctness does not
  improve across rounds. Closed deliberation is a Markov chain whose mutual information
  with the truth can only decrease.
- The failure mode has a name — **the Deliberative Illusion**: factual attrition plus
  stance homogenisation. ([arXiv 2606.03032](https://arxiv.org/pdf/2606.03032))
- In roughly **one divergent case in four the minority is right**, so a majority rule
  actively destroys the most valuable signal in the room.

The plugin has been shipping the exact artifact this literature warns about: a tally.

### What that means for how a run is reported

A concurring bench is the *weakest* thing the council produces, not the strongest. The
dissenting seat is the informative one. Any report that prints `6 avoid / 2 neutral /
2 long` and lets the reader do arithmetic on it is selling correlated noise as consensus.

## 0.7.0 — the bench becomes visible (prerequisite, not a feature)

`markdown.mjs` contains zero references to `master`. Master opinions are recorded, gated
for completeness, weighted in synthesis — and then rendered nowhere. A run can select ten
lenses, pay for ten, pass every gate, and emit a report in which they are invisible.

Folded into 0.8.0 rather than shipped alone: you cannot evaluate whether a persona rewrite
worked while its output is unreadable.

- Render master opinions to `master_<id>.md`, `all_agents.md`, and `artifact_index.md`.
- Add a `master_bench` report section, required only when a bench was actually selected.
- Make the analyst work log generate from packets instead of trusting the manager to retype
  them, and make the gate check for substance rather than for the task name as a substring.
- Stop returning the entire run state from every `record_*` call. Late in a long run a
  single response reached ~240k characters, which is a context-exhaustion bug on any host
  that keeps tool results in the transcript.

## 0.8.0 — masters become methods, not accents

The fix is architectural, and the reference implementation for it already exists in the
open: in [`virattt/ai-hedge-fund`](https://github.com/virattt/ai-hedge-fund) the Buffett
agent is not a prompt. It is a scoring function — ROE > 15%, debt/equity < 0.5, operating
margin > 15%, owner earnings with maintenance capex at 85% of total capex, a two-stage DCF
capped at 8%/4% with a 2.5% terminal and a 0.85 margin-of-safety multiplier. The model is
called **after** `total_score` and `max_possible_score` already exist, and it writes prose
about a verdict it did not choose.

That is the whole idea: **differentiation lives in code, not in the prompt.** Two masters
differ because they compute different functions over different inputs — not because one of
them was told to sound like Omaha.

Four layers per master, with the model confined to the last one:

1. **Eligibility gate** — can this method evaluate this security at all? Deterministic.
   Buffett facing a 20-F filer with 0/7 computable rules returns `out_of_scope` and never
   reaches an LLM.
2. **Scoring function** — named metrics, numeric thresholds, weights, provenance for every
   threshold. Deterministic.
3. **Evidence slice** — different masters read *different* evidence. This is the lever the
   information-asymmetry paper identifies, and it is the only one that produces disagreement
   from something other than tone.
4. **Narrative** — the model explains a stance it cannot overturn.

Reporting changes with it: the tally disappears, correlation is disclosed as a property of
the run, and the minority report is promoted rather than buried.

A new `council_diagnostics` tool measures whether any of this worked — self-consistency of
one master across runs against pairwise agreement between masters. **If different masters
agree with each other about as often as one master agrees with itself, the bench added no
information, and the report must say so.** A feature that can prove itself decorative is
worth more than one that cannot.

Full plan: `docs/plans/0.8.0-master-models.md`.

## Known limits that no version fixes

- **Shared base model.** Per-master vendor routing narrows the correlation; it does not
  make the seats independent, and it costs keys most users will not have.
- **Thresholds are still human choices.** Determinism moves the uncertainty from the model
  into the constants. The mitigation is provenance, not confidence.
- **Some masters have thin public methodology.** There is far more verifiable Buffett than
  verifiable Duan Yongping. Those rule sets will be smaller and labelled as such. Padding
  them to look uniform would reintroduce exactly the invention this release exists to remove.
