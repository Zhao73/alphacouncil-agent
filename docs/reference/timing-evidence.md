# Timing evidence and offline replay

AlphaCouncil records two clocks for every plugin-managed Codex worker attempt: the append clock on the hash-linked event and the child-process boundary clock returned by the worker transport. The timing ledger pairs `worker_attempt_started` and `worker_attempt_finished` by a unique invocation key and preserves whether an attempt was primary, a timeout retry or a parse repair.

## What the measurements mean

- A worker duration is local wall time from successful child-process spawn to settlement. A synchronous spawn failure is `not_started` and has no observed interval.
- A parallel stage's observed `elapsed_ms` runs from its first worker start to its persisted barrier. `worker_elapsed_ms_sum` is capacity consumed, not wall time. `worker_critical_elapsed_ms` is the longest observed worker duration used by the offline scheduler: it means scheduling-critical by duration, not “the worker that opened the observed barrier.” The latter remains reconstructable from the individual attempt intervals.
- Total elapsed time uses the persisted run start and completion anchors. The `terminal_persistence` interval is an estimate bounded by those existing anchors, not proof that the clock extends through the final publication write. Time not covered by classified intervals remains visible as `unattributed_ms`; it is never silently assigned to a worker.
- A complete current headless run can earn `observed_process_boundary` coverage. An explicit early terminal run is `truncated`. Legacy stage-only and externally scheduled `visible_host_threads` runs cannot be upgraded to process-boundary coverage.

These are engineering diagnostics. They do not establish source quality, investment accuracy, future return or profit.

## What offline replay does—and does not do

`replayTimingLedger` is a deterministic, offline counterfactual. It preserves every observed worker duration exactly and only list-schedules those observations under alternate per-stage concurrency and timeout caps. It has no clock, filesystem write, child-process or network capability.

The projected stage duration excludes launch stagger, barrier delay and terminal persistence. It therefore underestimates end-to-end wall time unless those costs are added by a separate model. A replay is never a provider/model speed benchmark and never counts as a measured 15-minute result; every replay carries `counterfactual_estimate: true` and `marketing_eligible: false`.

Timeouts are right-censored observations. If a worker timed out at an observed cap, replaying a higher cap cannot reveal when—or whether—it would have completed, so the result is `not_evaluable_censored`. A lower cap can project another timeout, but cannot prove the remaining stages would complete successfully.

## Public claim boundary

Do not turn a configured 15-minute terminal ceiling, one historical run, or an offline replay into “full research completes in 15 minutes.” A completion claim requires a preregistered live case set, the exact runtime/model/provider configuration, measured terminal artifacts, explicit incomplete outcomes and a disclosed success-rate/latency distribution. Until that evidence exists, timing output stays an internal engineering diagnostic.
