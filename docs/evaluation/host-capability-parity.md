# Host capability and parity contract

Status: **repository-static contract complete; live host E2E not run**.

The canonical record is `data/host-capabilities.v1.json`, validated against
`schemas/host-capabilities-v1.schema.json` by `scripts/lib/host-capabilities.mjs`.
Generate a report with:

```bash
node scripts/report-host-capabilities.mjs --check
node scripts/report-host-capabilities.mjs --markdown
node scripts/report-host-capabilities.mjs --json
node scripts/doctor.mjs
```

## What is proven

The static contract proves that the package has exactly four host records—Claude Code,
Codex, OpenCode and Grok Build—and that each host reaches the same authored `/alpha` command.
Claude Code, OpenCode and Grok ship exact generated copies. Codex uses a user-scoped prompt,
so the repository ships the canonical source and doctor compares the installed copy only
when it exists.

Every command surface requires the same sequence:

```text
begin_council_selection
-> display the complete returned catalog in returned order
-> collect one numbered/range/stable-ID/all submission
-> confirm_master_selection(display_ack=true)
-> consume the one-run selection_receipt
```

The validator also calls the real runtime catalog code and proves that all four records bind
to the same 26 stable IDs in the same order, one-based indices, non-null per-seat pack hashes
and one language-specific catalog hash. The native chooser is optional UI sugar for every
host; the complete numbered fallback is mandatory.

Static model and permission checks cover the generated files:

- Claude Code maps `fast/standard/deep` to `haiku/sonnet/opus` in its agent definitions and
  grants only the tools declared for a role.
- OpenCode uses provider/model IDs, denies edit and shell, and grants network tools only to
  evidence roles.
- Grok ships agents in plan mode and leaves model choice to the host.
- Codex has no fabricated repository-local agent or per-tier model mapping; those remain
  host-capability dependent.

Saved run artifacts are a server capability. Host-thread resume, visible-subagent execution,
parallelism limits and native chooser behavior remain unverified until a live matrix is run.

## What is not proven

The presence of a manifest, command, generated agent file or passing contract test does not
prove that an external host installed the package, trusted the repository, granted network
permissions, resolved a model, spawned a subagent or resumed a session. Consequently every
host record contains:

```json
{
  "live_e2e": {
    "status": "not_run",
    "artifact": null
  }
}
```

Changing this field requires a real execution artifact that records host and version,
installed package hash, command hash, selected IDs, catalog hash, per-seat pack hashes,
receipt lifecycle, deterministic decision hashes, degradation events and final report gate.
Screenshots or a successful MCP listing alone are insufficient.

## Doctor behavior

Doctor now checks the static four-host contract and the three repository command adapters.
It reports a missing Codex user prompt as a note because Codex may not be installed. If a
Codex `alpha.md` exists but differs from `commands/alpha.md`, doctor reports a stale-prompt
warning with the exact replacement path. Set `ALPHACOUNCIL_CODEX_PROMPTS_DIR` to audit a
non-default prompt directory.

This freshness check does not edit user files. Command repair remains an explicit copy or
installer action.

## Required live matrix before 0.9 GA

For each host, freeze the same package tarball, language, ticker, typed fact pack and selected
IDs, then record:

1. installation and MCP handshake;
2. complete catalog display and user submission;
3. catalog and per-seat pack hashes before receipt confirmation;
4. receipt confirmation, one successful consumption and replay rejection;
5. selected-seat execution or deterministic `out_of_scope`;
6. report completeness and quality gates;
7. visible-subagent, parallelism, model, permission and resume behavior;
8. every degradation reason rather than silently changing the workflow.

Until those artifacts exist, the accurate release statement is “four-host static parity
contract passes; live host E2E is not run.”

## External CLI evidence collector

The external-host evidence CLI is deliberately import-only and defaults to a no-cost plan:

```bash
npm run host:e2e:artifacts
node scripts/host-e2e-artifacts.mjs --preflight \
  --host claude_code --executable claude
node scripts/host-e2e-artifacts.mjs --preflight \
  --host claude_code --executable claude \
  --runtime /usr/local/bin/node \
  --path /usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin
node scripts/host-e2e-artifacts.mjs --preflight \
  --host codex --executable codex --write \
  --output /absolute/evidence-directory/codex-not-run.json
node scripts/host-e2e-artifacts.mjs --check --file /absolute/path/to/host-result.json
npm run host:e2e:artifacts:check -- --file /absolute/path/to/host-result.json
node scripts/host-e2e-artifacts.mjs --import-result \
  --file /absolute/path/to/host-result.json \
  --output /absolute/path/to/immutable-import-directory
```

The npm `:check` alias is intentionally file-scoped; it never guesses which external result
to validate. `--preflight` is read-only. It may resolve and hash an explicit executable/runtime and run
only `--version`; it never invokes a prompt or paid model. Even a successful version probe
returns `status: not_run`, because credentials, repository trust and an external run were not
proved. A crash, missing executable or missing runtime is retained as a blocker/degradation.
Explicit runtime and PATH overrides are recorded rather than silently substituted.
The preflight output is itself a schema-valid, hash-bound `not_run` result. Saving it is
explicit (`--write --output FILE`), exclusive, mode `0600`, non-overwriting, and forbidden
inside the repository production `knowledge/` tree. Shell redirection is not required.

An imported `external-host-e2e-result-v1` artifact records the actual executable path,
version and executable hash; the physical package path/hash; catalog/order and selected-pack
hashes; selection-receipt confirmation, one-use consumption and replay rejection; fact,
deterministic-decision, report and quality physical path/hash pairs; host capabilities; and
every degradation. Paths may be absolute or safe paths relative to the host-result file. A
`passed` artifact is accepted only after the checker opens the executable, package and all
four result files with `O_NOFOLLOW`, confirms regular files and recomputes every raw SHA-256.
Nested hash strings alone are declarations, not evidence. A `not_run` result keeps all four
result paths and hashes null and is never inferred into a pass.

The collector leaves `attestations` empty and records `collector_initiated_paid_calls: false`.
External execution authorization, credentials and repository trust are separate explicit
preconditions; all three must be independently verified before an imported result can be
`passed`. A verified external authorization must carry its physical record's hash in
`external_run_authorization.reference_hash`; an unsigned boolean is insufficient. The
collector does not update `data/host-capabilities.v1.json`, release evidence,
or any GA status.
