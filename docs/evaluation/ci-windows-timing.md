# Windows CI timing evidence (WP3W)

WP3W classifies the Windows failures from check run
[`33032648711`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33032648711)
at commit `d6d97820313dcbe8d7c08b83e2ee9e9dcfbec29d`. It is an evidence and
root-cause package, not a general timeout increase. No runtime file, workflow, package script,
global timeout constant or product assertion changed in this package.

## Frozen failure evidence

The first Windows attempt failed in
[`98388438797`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33032648711/job/98388438797).
The other four matrix jobs passed. Its only failing test was:

| Test | Duration | Exact terminal evidence | Classification |
| --- | ---: | --- | --- |
| `full council proves dedicated master workers, parallel barriers, exact Q&A, display coverage and no-search parse repair` | 29,223.2622 ms | `master_buffett` and `master_druckenmiller` ended `schema_mismatch` | Not a timing failure. It is a separate fail-closed method-voice contract result and is outside WP3W timing conclusions. |

Attempt 1 totalled 1,393 tests: 1,386 passed, 1 failed and 6 skipped in
360,756.0927 ms.

Only the Windows job was rerun. Attempt 2 failed in
[`98389871168`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33032648711/job/98389871168):

| Test | Duration | Exact terminal evidence |
| --- | ---: | --- |
| `npm tarball install exposes identical four-host MCP adapter behavior without external live claims` | 253,758.214 ms | Both bounded attempts ended `offline npm install from tarball failed to start: ... ETIMEDOUT`. |
| `full headless PM fails closed on missing price_levels and never publishes a rating` | 70,839.8931 ms | Expected PM `failed`; observed PM `skipped`. |
| `a transport failure on the parse retry remains empty evidence` | 69,798.511 ms | The test RPC client ended `timed out after 30000ms waiting for tools/call (id=4)`. |

Attempt 2 totalled 1,393 tests: 1,384 passed, 3 failed and 6 skipped in
513,370.4136 ms.

## Same-test Windows comparisons

The next two branch runs passed the complete five-platform matrix. These are comparisons, not
proof that a single green rerun cured a race.

| Test | Failed attempt 2 | [`33036251830`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33036251830) / [`98399463589`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33036251830/job/98399463589) | [`33037027700`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33037027700) / [`98401844457`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33037027700/job/98401844457) |
| --- | ---: | ---: | ---: |
| npm tarball parity | 253,758.214 ms, failed | 255,652.6753 ms, passed after one announced retry | 137,861.3833 ms, passed after one announced retry |
| PM missing `price_levels` | 70,839.8931 ms, failed | 10,315.2576 ms, passed | 9,052.1777 ms, passed |
| parse-retry transport | 69,798.511 ms, failed | 8,255.0827 ms, passed | 5,862.6798 ms, passed |
| full-council method voice | 29,223.2622 ms, failed on attempt 1 | 13,641.5719 ms, passed | 12,417.8672 ms, passed |

Run `33036251830` completed 1,405 tests with 1,399 passing, 0 failing and 6 skipped in
324,415.0853 ms. Run `33037027700` completed 1,406 tests with 1,400 passing, 0 failing
and 6 skipped in 320,243.5568 ms.

## Attribution and disposition

### 1. Packaged-host parity: reproducible first-attempt Windows install stall; double stall not reproduced

The failing text comes from the nested `offline npm install from tarball` command, whose
test-tool process ceiling is 120 seconds. The outer test process has a separate 180-second
ceiling and the Node test has a 400-second ceiling. Therefore the 253.8-second failure is two
nested 120-second install stalls plus setup and settlement, not the 400-second test ceiling.

The same attempt-2 job ran the parity check once before the parallel Node suite and completed it
from 02:23:42Z to 02:24:55Z, about 73.3 seconds. Inside the four-way test run, both installs hit
120 seconds. Each of the next two Windows jobs also announced a first-attempt timeout, then
passed; one successful test took 255.7 seconds, longer than the failed test. The most likely
explanation is temporary-directory/npm process I/O pressure under concurrent suite load, but
that component-level latency was not directly instrumented. The evidence establishes only that
the nested install twice reached its 120-second process ceiling and that a green run can take
longer overall; it does not establish a measured I/O latency distribution. It does disprove the
400-second Node test ceiling as the failing boundary.

Disposition: retain the existing single bounded retry. Do not change the 120-second global
command ceiling, the 180-second outer process ceiling, the 400-second test ceiling, test-runner
concurrency or assertions in WP3W. A second consecutive 120-second install stall occurred in
one of three observed Windows jobs and did not reproduce in the next two; changing a forbidden
global constant would hide rather than attribute it.

### 2. Parse-retry transport: reproducible test-harness budget defect

The failing stack ends in `test/helpers/rpc-client.mjs`, not runtime code. The fixture permits
two separately bounded worker attempts at 30 seconds each, while its outer RPC observer used
the helper's 30-second default. The observer could therefore stop before the second attempt
settled, preventing the test from checking the intended `exit code 17` and empty-evidence
contract.

Disposition: the one affected call now gives the outer observer 75 seconds: two 30-second
worker ceilings plus 15 seconds of process-settlement headroom. Worker limits and assertions
are unchanged. A platform-independent delayed-response probe deterministically demonstrates
the red and green sides: a 250 ms service response is rejected by a 25 ms observer and accepted
by a 2,000 ms observer. This makes the failure reproducible without waiting for another loaded
Windows runner.

### 3. PM `missing price_levels`: runtime terminal-semantics input for WP4

The fixture set a 60-second full-council deadline. Its 70.8-second result exhausted that budget
before it could exercise the named PM schema barrier; the deadline/upstream-failure path left
the PM `skipped`. That is not the schema rejection named by the test, and accepting either
`failed` or `skipped` would weaken the contract. The same fixture reached the PM schema barrier
in 10.3 and 9.1 seconds in the next two Windows jobs.

Disposition: no WP3W test or runtime timeout change. WP4 must decide and freeze terminal
semantics for a PM stage that is admitted but has no remaining global budget. The required WP4
input is: distinguish `not_started_global_deadline` from an upstream-gate `skipped`, preserve
`decision_available=false` and `rating=null`, expose the reason in status/events, and keep the
dedicated deadline tests separate from PM schema-contract tests.

### 4. Attempt-1 method `schema_mismatch`: non-timing observability input for WP4

Attempt 1 persisted the terminal kind and diagnostic paths for the Buffett and Druckenmiller
workers, but the CI assertion output did not capture the specific schema fields or keywords
that failed. No timing conclusion is drawn from this event.

Disposition: WP4 should make a bounded list of violated method-voice schema paths and keywords
available in the durable diagnostic and CI assertion output, without retaining rejected prose
or changing the fail-closed result. This is an observability input, not a WP3W fix.

## WP3W gate result

- All observed failures are attributed; only the test-owned outer RPC budget changed.
- The deterministic delayed-response probe covers red and green behavior on every platform.
- No assertion accepts `failed` or `skipped`; PM schema assertions remain exact.
- Packaged-host double timeout and PM deadline terminal semantics remain disclosed rather than
  being converted into passing claims.
- The only correction is alignment of the parse-retry test observer with its two-attempt
  contract; this package does not claim to have fixed general Windows timing variance.
- A new five-platform CI run is still required for this package before WP3W can close.

## WP3F recurrence and WP3W-b scheduling decision

WP3F check run
[`33041464732`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33041464732)
reproduced the Windows contention shape at commit
`7a16d4c0ae47a8e8e3f6afac4cbbd7969cb53a53`. The first Windows job
[`98415795513`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33041464732/job/98415795513)
failed after 12 minutes 41 seconds. Its source suite took 631,415.8502 ms: 1,417 tests,
1,388 passed, 23 failed and 6 skipped. Both packaged-host-parity contract cases exhausted
two bounded attempts with the same nested offline-install `ETIMEDOUT`. The remaining 21
failures reported global deadlines, RPC observer timeouts or absent downstream artifacts
while that work occupied the runner. Classifying those 21 as a contention cascade is an
inference, supported by the bounded clean-runner comparison below; none was a seat-fidelity
assertion failure.

Only the failed Windows job was rerun. Attempt 2 job
[`98418253637`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33041464732/job/98418253637)
passed in 7 minutes 40 seconds; its `Run checks` step took 7 minutes 15 seconds. The source
suite took 362,092.3768 ms: 1,417 tests, 1,411 passed, zero failed, zero cancelled and 6
skipped. It still announced one packaged-parity timeout before its bounded retry succeeded.
The other four matrix jobs were already green, so attempt 2 closed WP3F but did not establish
that the Windows contention had disappeared.

The two parity case durations are the isolation baseline:

| CI attempt | npm tarball case | production-profile case | Retry notices | Result |
| --- | ---: | ---: | ---: | --- |
| Attempt 1 / `98415795513` | 257,203.009 ms | 251,161.8086 ms | 2 | Both cases exhausted both attempts and failed. |
| Attempt 2 / `98418253637` | 271,171.2418 ms | 78,675.081 ms | 1 | First case passed on retry; second passed first try. |

The TAP case durations cover setup, both attempts when retried and settlement; the log does not
expose a separate stopwatch for each nested attempt, so no finer-grained duration is inferred.

The ten WP3F seat-fidelity tests took 3,401.4159 ms in that successful Windows rerun. The two
schema/policy-subject checks accounted for 1,585.1885 ms and 1,750.9463 ms; the method-reference
comparison took 56.0006 ms and each remaining case took less than 4 ms. These measured timings
quantitatively rule out WP3F's seat-fidelity tests as a material cause of the multi-minute
increase. The repeated npm stall, not the WP3F fidelity workload, is the component that still
needs isolation.

WP3W-b therefore changes scheduling only on Windows:

- the selected source-file set is partitioned without omission or duplication;
- the ordinary source files retain `--test-concurrency=4`;
- `test/contract/packaged-host-parity.test.mjs` runs afterward in its own
  `--test-concurrency=1` phase;
- Linux and macOS keep the original single source-suite phase;
- the packaged test's assertions and 120/180/400-second boundaries are unchanged.

The post-change gate is a five-platform green run with the two Windows phase summaries totaling
the same 1,417 tests, a Windows `Run checks` duration in the nine-minute-or-less range and zero
`packaged-parity: attempt 1 timed out; retrying` notices. If isolation leaves any such notice,
the contention source must be investigated again instead of calling WP3W-b complete. The first
WP4 commit must then produce another green Windows job, so one favorable runner is not presented
as proof of stability.
