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

Disposition: WP4d closes this input by preserving the pre-bound validation-error count, exposing
an explicit truncation flag and bounded method-voice paths, keywords and structural property names
in the durable attempt diagnostic and `master_parse_repair` event. The existing full-council test
prints one fixed TAP diagnostic line per repaired method seat. Rejected prose is still represented
only by length and digest, and the fail-closed/one-repair behavior is unchanged. This remains an
observability change, not a WP3W timing fix.

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

## First WP3W-b CI correction

The first scheduling commit ran in
[`33043254765`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33043254765).
Its Windows job
[`98421392091`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33043254765/job/98421392091)
entered `source_without_packaged_host_parity` and completed 1,412 tests: 1,404 passed, two
failed and 6 skipped in 255,216.3387 ms. The only failures were existing test-plan contract
cases whose synthetic temporary source trees intentionally omit the parity file. Those fixture
trees inherited the real Windows platform and were incorrectly treated as malformed complete
checkouts, so the isolated phase did not run. No parity, runtime, integration or seat-fidelity
assertion failed.

The correction keeps a single phase for a source-shaped synthetic tree that does not contain
its own `scripts/run-tests.mjs`. A real checkout is identified by that runner file: on Windows
it must include the packaged-host-parity test in the selected file set or fail closed. The
already extended `packaged parity CLI defaults to a read-only temporary check and Windows
isolates this file` contract test verifies the real repository's exact two phases and complete
file multiset, so no duplicate test is added.

All four non-Windows jobs passed. Ubuntu timings stayed at 2:00, 1:47 and 1:39. The macOS job
took 2:28 versus 1:41 in the immediately preceding run even though its single-phase plan is
byte-for-byte unchanged. This is recorded as one un-attributed runner variance observation;
it is not used as evidence that the scheduling change improved or regressed macOS.

## Second WP3W-b CI correction: explicit Windows serial group

The synthetic-tree correction ran in
[`33043857486`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33043857486).
Ubuntu 22, Ubuntu 18, Ubuntu 20 and macOS passed in 1:35, 2:01, 1:53 and 2:38 respectively.
The Windows job
[`98423253736`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33043857486/job/98423253736)
failed in 5:11; its `Run checks` step ran for about 4:51. It entered only the
`source_without_packaged_host_parity` phase and completed 1,412 tests: 1,405 passed, one
failed and 6 skipped in 229,135.2886 ms. The serial parity phase did not run, so the zero retry
notices in this job are not parity-success evidence.

The sole failure was `full council proves dedicated master workers, parallel barriers, exact
Q&A, display coverage and no-search parse repair` at `test/integration/full-analysis.test.mjs:417`.
The 12,551.5597 ms case failed its existing assertion that all eight evidence-worker launch
timestamps fall within a one-second wall-clock interval. No runtime, parity or seat-fidelity
assertion failed. The assertion is intentionally unchanged here. WP4 inherits a requirement to
replace this loaded-runner-sensitive clock comparison with a structural event-order contract:
every required spawn must occur before any worker-completion event.

The Windows scheduler now has one explicit, evidence-bounded serial-file group, rather than a
growing set of ad hoc phases. In fixed order it contains `full-analysis.test.mjs`, evidenced by
the job above, and `packaged-host-parity.test.mjs`, evidenced by the double-ETIMEDOUT job
[`98415795513`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33041464732/job/98415795513).
The remaining files stay at concurrency 4; the two listed files run afterward together at
concurrency 1. A local two-phase rehearsal produced 1,401 concurrent tests plus 16 serial tests
(11 full-analysis, including three parameterized cases, and 5 packaged-parity), preserving the
1,417-test total. The earlier static 1,404 plus 13 draft was an unmeasured assumption, not
evidence. Linux and macOS stay single-phase. A real checkout missing either listed file fails
closed; a synthetic source tree containing neither keeps its single phase. No assertion or
timeout changes in this correction.

The macOS 2:38 result is recorded as another un-attributed single-run variance observation. It
does not change the Windows closure gate: five green jobs, Windows `Run checks` at or below nine
minutes, zero packaged-parity retry notices and phase counts that sum to 1,417. The first WP4
commit must still supply a second consecutive green Windows result.

## Third WP3W-b CI correction: bounded three-file group

The first explicit-group commit ran in
[`33044857299`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33044857299).
Ubuntu 20, macOS, Ubuntu 18 and Ubuntu 22 passed in 1:42, 1:47, 2:02 and 1:23. The Windows job
[`98426386546`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33044857299/job/98426386546)
failed in 5:55; `Run checks` took about 5:17. Its `source_concurrent` phase completed 1,401
tests: 1,394 passed, one failed and 6 skipped in 248,325.7572 ms. The serial phase did not run,
so its zero retry notices are again not parity-success evidence.

The only failure was `directional prose from an abstaining voice fails loudly and never becomes
a published opinion` in `master-runtime-observability.test.mjs`. Its 20-second outer RPC observer
expired after 25,392.6195 ms of test wall time while the fixture shared the loaded Windows phase.
The same file's provenance, intentional-stall and recovery cases passed. An isolated local run
then completed all four file cases in 17,708.11675 ms. This is direct evidence to add the whole
process-heavy file to the explicit group; no product assertion, worker timeout or observer
timeout changes here.

The fixed serial order is now `full-analysis`, `master-runtime-observability`, then
`packaged-host-parity`, keeping parity last. The ordered local Windows-plan rehearsal completed
1,397 concurrent tests in 106,923.06425 ms, then 11 full-analysis tests in 33,425.770875 ms,
4 master-runtime-observability tests in 17,022.779833 ms and 5 packaged-parity tests in
10,205.213417 ms. All four summaries had zero failures or skips, so the measured equation is
1,397 + 11 + 4 + 5 = 1,417 rather than a static-source inference.

An initial combined-argument rehearsal exposed that Node's test runner reorders explicit files
by path: parity ran first even though it was last in the argument array. A combined `args` list
therefore cannot prove execution order. The logical `windows_serial` phase now exposes and runs
three ordered single-file invocations, emitting one `serial_file` marker before each; any
non-zero invocation stops the phase immediately. The rehearsal emitted the three markers in
the approved order and produced the separate timings recorded above.

This three-file boundary is also the stop rule for further isolation. If a fourth distinct file
has an evidence-specific process-heavy failure, the next change must reduce Windows
`source_concurrent` from concurrency 4 to concurrency 2 and measure that `Run checks` remains at
or below nine minutes; it must not append a fourth ad hoc serial entry.

WP4 also inherits the observer-budget defect disclosed by this run. The failing case expresses
`20000 = total_timeout 15000 + timeout 5000`, with no explicit settlement allowance. WP4 must
standardize RPC observation budgets as `contract_ceiling + settlement_headroom` instead of
scattering another one-off numeric increase through integration tests.

## WP3W-b closure baseline for the first WP4 commit

The bounded three-file schedule passed all five matrix jobs at commit
`cb05b7b22d45ebdfba279ddc309b5e98b316b81c` in check run
[`33046391937`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33046391937).
The Windows job
[`98431271961`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33046391937/job/98431271961)
ran `Run checks` from 06:35:42Z through 06:44:00Z, 8 minutes 18 seconds, below the nine-minute
gate. The whole job took 8 minutes 57 seconds.

The log emitted `source_concurrent`, then the three `serial_file` markers in the frozen order:
`full-analysis`, `master-runtime-observability`, `packaged-host-parity`. Their summaries were
1,397 + 11 + 4 + 5 = 1,417 tests: 1,411 passed, 6 skipped, zero failed and zero cancelled. The
job emitted zero `packaged-parity: attempt 1 timed out; retrying` notices. This closes WP3W-b;
the first WP4 commit still requires a new five-platform green run as the consecutive stability
check and must return to the Windows group if that job is red.

## WP4b evidence-wave proof

The full-analysis contract no longer treats sub-second process-start proximity as proof of one
parallel evidence wave. That wall-clock assertion was sensitive to Windows process scheduling
without testing the actual barrier. The runtime already appends a hash-chained
`worker_attempt_started` event from every worker's process-start callback and a matching
`worker_attempt_finished` only after settlement. WP4b therefore proves the stronger scheduling
invariant directly: all eight expected primary evidence start sequence numbers must be lower
than the first corresponding evidence finish sequence number, after the complete event hash
chain has validated. A counterexample with one finish before the eighth start fails this gate.

## WP4a2 closure rerun and WP4c observer budgets

WP4a2 check run
[`33055769340`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33055769340)
tested the exact head `98b80a6dbef05042d5d430af6efbd751ab5717fc`. The first Windows
attempt was functionally green but missed the frozen nine-minute `Run checks` gate by four
seconds. Before any rerun, the independent review froze one and only one clean Windows rerun on
the same SHA; a second miss would have forbidden a third rerun and required an attributed
performance change. Both attempts remain visible here:

| Windows attempt | Jobs API `Run checks` interval | Duration | Source concurrent | Full analysis | Master observability | Packaged parity | Actual parity retry notices | Frozen gate |
| --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| Attempt 1 / [`98462053546`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33055769340/job/98462053546) | 2026-08-27 08:50:20Z–08:59:24Z | 544 s | 1,410 tests; 1,404 pass; 6 skip; 0 fail | 11/11; 0 fail | 4/4; 0 fail | 5/5; 0 fail | 0 | Missed: 544 s > 540 s |
| Attempt 2 / [`98466063969`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33055769340/job/98466063969) | 2026-08-27 09:06:09Z–09:14:27Z | 498 s | 1,410 tests; 1,404 pass; 6 skip; 0 fail | 11/11; 0 fail | 4/4; 0 fail | 5/5; 0 fail | 0 | Passed: 498 s <= 540 s |

Each attempt produced 1,430 tests across the four Windows TAP groups with zero failures. The
second row closes the pre-declared rerun rule; it does not erase the first row or claim that
shared-runner timing variance has disappeared.

WP4c replaces faithful outer-RPC literals with one executable rule:
`observerBudget(contract_ceiling) = contract_ceiling + 15,000 ms`. The helper rejects zero,
negative, non-integer and non-finite inputs. The eleven pre-existing faithful sites remain
numerically identical after conversion; four disclosed mismatches are normalized:

| Class | File and pre-change anchor | Contract ceiling | Previous observer | Derived observer |
| --- | --- | ---: | ---: | ---: |
| Faithful | `full-analysis.test.mjs` L336 | 30,000 | 45,000 | `observerBudget(30,000)` = 45,000 |
| Faithful | `full-analysis.test.mjs` L533 | 45,000 | 60,000 | `observerBudget(45,000)` = 60,000 |
| Faithful | `full-analysis.test.mjs` L609 | 45,000 | 60,000 | `observerBudget(45,000)` = 60,000 |
| Faithful | `full-analysis.test.mjs` L684 | 60,000 | 75,000 | `observerBudget(60,000)` = 75,000 |
| Faithful | `full-analysis.test.mjs` L730 | 30,000 | 45,000 | `observerBudget(30,000)` = 45,000 |
| Faithful | `full-analysis.test.mjs` L780 | 30,000 | 45,000 | `observerBudget(30,000)` = 45,000 |
| Faithful | `quick-analysis.test.mjs` L218 | 30,000 | 45,000 | `observerBudget(30,000)` = 45,000 |
| Faithful | `quick-analysis.test.mjs` L294 | 30,000 | 45,000 | `observerBudget(30,000)` = 45,000 |
| Faithful | `quick-analysis.test.mjs` L340 | 30,000 | 45,000 | `observerBudget(30,000)` = 45,000 |
| Faithful | `quick-analysis.test.mjs` L392 | 30,000 | 45,000 | `observerBudget(30,000)` = 45,000 |
| Faithful | `runtime-language-failures.test.mjs` L186 | 30,000 | 45,000 | `observerBudget(30,000)` = 45,000 |
| Normalized | `master-runtime-observability.test.mjs` L123 | 15,000 | 20,000 | `observerBudget(15,000)` = 30,000 |
| Normalized | `master-runtime-observability.test.mjs` L180 | 15,000 | 20,000 | `observerBudget(15,000)` = 30,000 |
| Normalized | `master-runtime-observability.test.mjs` L229 | 80,000 | 90,000 | `observerBudget(80,000)` = 95,000 |
| Normalized | `headless-company-dossier.test.mjs` L294 | 60,000 | 60,000 | `observerBudget(60,000)` = 75,000 |

The two 15-second master-runtime ceilings now use the same expression. A deterministic delayed
RPC probe schedules a valid response after 20,500 ms: the former 20,000 ms observer rejects it,
while the 30,000 ms contract-derived observer receives it. The existing parse-retry observer is
also expressed as `observerBudget(30,000 * 2)`, preserving its proven 75,000 ms value.

Three literals deliberately remain outside this rule:

| File and pre-change anchor | Literal | Classification | Reason |
| --- | ---: | --- | --- |
| `full-analysis.test.mjs` L834 | 15,000 | `early_return_assertion` | The shorter observer is the assertion that a lowered-budget run settles before its 20-second cap. |
| `full-analysis.test.mjs` L878 | 90,000 | `path_bounded_observer` | The test exercises a short default-pace path; deriving from the full pace could permit a 30-minute hang. |
| `slow-all-triple-verification.test.mjs` L380 | 120,000 | `path_bounded_observer` | The fixture exercises a bounded synthetic path; deriving from the slow pace could permit a 60-minute hang. |

Dry-run selection gates, probe-local observation literals and every pre-existing `node:test`
timeout remain unchanged. The two path-bounded observers need a separately reviewed path-derived
ceiling rather than a misleading pace-derived expansion.

## WP4c latency result and WP4cP attributable-cost move

WP4c check run
[`33058961948`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33058961948)
tested exact commit `8b15b326c3cf46610205ddc1717fe92f6758fd56`. Both Windows attempts
were functionally green, but both missed the frozen 540-second `Run checks` gate. The one
pre-authorized same-SHA latency rerun was used; no third attempt was made:

| Windows attempt | Jobs API `Run checks` interval | Duration | Source concurrent | Full analysis | Master observability | Packaged parity | Actual parity retry notices | Frozen gate |
| --- | --- | ---: | --- | --- | --- | --- | ---: | --- |
| Attempt 1 / [`98472689551`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33058961948/job/98472689551) | 2026-08-27 09:31:59Z–09:41:57Z | 598 s | 1,411 tests; 1,405 pass; 6 skip; 0 fail | 11/11; 0 fail | 5/5; 0 fail | 5/5; 0 fail | 0 | Missed: 598 s > 540 s |
| Attempt 2 / [`98475805738`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33058961948/job/98475805738) | 2026-08-27 09:44:27Z–09:55:36Z | 669 s | 1,411 tests; 1,405 pass; 6 skip; 0 fail | 11/11; 0 fail | 5/5; 0 fail | 5/5; 0 fail | 0 | Missed: 669 s > 540 s |

The TAP group durations distinguish the package's attributable cost from shared-runner variance:

| Evidence run | Source concurrent | Full analysis | Master observability | Packaged parity | Jobs API `Run checks` |
| --- | ---: | ---: | ---: | ---: | ---: |
| WP4a2 attempt 2 baseline (`98466063969`) | 218,294.5487 ms | 63,500.7658 ms | 29,353.3730 ms | 116,103.3184 ms | 498 s |
| WP4c attempt 1 (`98472689551`) | 240,996.1381 ms | 95,729.5762 ms | 60,235.9352 ms | 86,674.0138 ms | 598 s |
| WP4c attempt 2 (`98475805738`) | 277,831.3905 ms | 107,937.8561 ms | 57,301.0467 ms | 117,126.5274 ms | 669 s |

The only deterministic cost added by WP4c was the 20,500 ms delayed-response probe plus child
startup and settlement inside the serial master-observability group. WP4cP preserves that real
child-process red/green proof while scaling it to a 1,500 ms ceiling, 2,000 ms legacy observer
and 2,500 ms response. The locked 4:3 ratio matches the real 15,000 ms ceiling to 20,000 ms
legacy observer, while static assertions retain the real 15,000/20,000/30,000 relationships.
The new probe file runs in the concurrent source phase rather than the Windows serial group.

The probe's approximately 21-second attributable cost is removed from the serial path; the
source and full-analysis increases are attributed to shared-runner variation because WP4c made
no corresponding code-path change. 本包不声称消除共享 runner 方差，也不保证 ≤540 s.

## WP4d closure run

WP4d check run
[`33063711767`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33063711767)
tested exact commit `ba151bcbfd426e3d020101c3864c6b6e75a6c094`. Attempt 1 was
functionally green but missed the frozen latency gate. The one permitted same-SHA whole-run
rerun then passed; no third attempt was made:

| Windows attempt | Jobs API job interval | Job duration | `Run checks` interval | `Run checks` duration | Result |
| --- | --- | ---: | --- | ---: | --- |
| Attempt 1 / [`98488520587`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33063711767/job/98488520587) | 2026-08-27 10:35:40Z–10:46:26Z | 646 s | 10:36:00Z–10:46:23Z | 623 s | FAIL: latency only; 623 s > 540 s |
| Attempt 2 / [`98491259196`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33063711767/job/98491259196) | 2026-08-27 10:47:26Z–10:56:20Z | 534 s | 10:47:49Z–10:56:15Z | 506 s | PASS: 506 s ≤ 540 s; job 534 s ≤ 540 s |

Attempt 2 completed all five matrix jobs. Its four Windows TAP groups contained 1,415, 11,
4 and 5 tests respectively, totalling 1,435 with zero failures and six intentional skips.
`source_concurrent` preceded `windows_serial`; both expected method-schema diagnostic lines
were present; packaged-host parity passed with zero actual retry announcements. The action
runtime's Node.js 20 deprecation annotations were non-blocking and remain assigned to WP7.

## Candidate regression: bound the ordinary Windows source phase

Candidate head `18311038bbb512a20d66c6792252fafe3cf0a666` exposed the stop condition recorded
in the third WP3W-b correction. Pull-request check run
[`33105096639`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33105096639), Windows job
[`98632700256`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33105096639/job/98632700256),
ran the ordinary source phase for 352,938.0952 ms at file concurrency four. It finished 1,462
tests with 1,441 passed, 15 failed and six intentionally skipped. The failures crossed several
otherwise unrelated integration files and were all bounded RPC observer expirations after
process startup slowed by roughly an order of magnitude; this was not one fourth heavy file to
append to the special serial list.

The scheduler therefore follows the pre-recorded stop rule: ordinary Windows source-file
concurrency falls from four to two and the phase is now named `windows_bounded_source`. The
three evidence-backed heavy files remain ordered `--test-concurrency=1` invocations afterward.
Linux and macOS stay at concurrency four. This change does not relax a product deadline,
runtime assertion, RPC observer or selected-file set. Closure requires both exact-head Windows
jobs, the other ten matrix jobs and the pull-request fuzz job to pass without a rerun.

## v1.5.0 release-candidate regression: serialize the ordinary Windows source phase

Release-candidate head `3205790c462a4cb885175c30ed509a92a9e3dad0` did not satisfy that
closure rule. Push run [`33163118840`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33163118840)
and pull-request run [`33163129833`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33163129833)
both passed Linux, macOS and ChatGPT Work checks, but their Windows jobs failed in different test
files while the ordinary phase ran at file concurrency two. The failures were transient file-lock
release and RPC observer expirations across `fast-no-cold-retry`, `runtime-language-failures`,
`pace-selection-gate` and `quick-analysis`; no common product assertion failed on both runners.

The ordinary Windows source phase therefore moves from concurrency two to one. The selected-file
set, product deadlines, RPC observers and assertions remain unchanged. The existing three heavy
files still run as individually named serial invocations so their timing remains visible.

The first serialized candidate, `2d906eeafa0bef374a52a5ea64b2547ab939c330`, exposed a separate
pre-test failure in pull-request run
[`33164118743`](https://github.com/Zhao73/alphacouncil-agent/actions/runs/33164118743): the offline
tarball install exhausted its existing 120-second process ceiling before the source phase began.
The CLI now permits exactly one Windows-only retry of that `ETIMEDOUT`, and the retry starts the
entire parity check in a fresh temporary root. Other errors remain immediately fatal.
