# PersonaPack v3 GA release evidence

Status: package/plugin version `0.9.0-solo-test.1`, channel `solo_test`; verifier contracts implemented,
but no production pass, approval artifact or signature claim is included in this repository.

## Solo-test boundary

The packaged solo-test tree makes 26 physical v3 packs and 52 executable
`provisional_derived_proxy` tools testable. All 26 are provisional `operator_lens`;
operational = 0 and `method_model` = 0. Human source approvals, human formula approvals and
human approval signatures are all zero. The production loader rejects the complete tree.
These facts are build/readiness results, not release evidence, and cannot satisfy any trust
layer below. Formal production GA therefore remains fail-closed.

GA uses three separate trust layers. None can replace another:

1. `--release-root` plus `--release-id` invokes the full immutable-release verifier. It
   opens all 26 physical packs plus the physical `source-review-evidence.json` and
   `formula-review-evidence.json` bundles, recomputes their hashes, and verifies source and
   formula approvals against the separately supplied `--trusted-source-reviewer-keys` and
   `--trusted-formula-reviewer-keys` registries. A standalone manifest is rejected.
2. `persona_v3_experiment_adjudication` is a separate external Ed25519 adjudication. It
   binds a physical registered protocol, physical case freeze, the eight canonical run
   files (`A`, `B`, `C`, `D13`, `D26`, `E:D13`, `E:D26`, `H`), and the physical result
   manifest. Its signed subject includes the preregistered promotion thresholds,
   multiplicity policy, H human-reference boundary and explicit release claims. The key
   must carry purpose `experiment_adjudication` and its trusted principal must equal the
   named adjudicator.
3. `persona_v3_ga_release_evidence` is signed by two independent release reviewers. It
   binds the physical file hash and semantic artifact hash of the experiment adjudication,
   package artifact, four external-host result files, and the complete physical release
   operation proof. The operation proof contains a candidate cutover, rollback to the
   retained prior release, final re-cutover to the candidate, final `current.json`, and the
   monotonic `cutover-ever.json` marker. Its key purpose is `persona_release_evidence`.

Collector outputs stay non-claiming: case/run/result collectors, the package collector and
the host import collector keep their own `attestations` arrays empty. Only the external
experiment adjudication and release-review documents can state a pass.

## Physical cross-checks

The GA verifier opens host, package and experiment bindings relative to the signed evidence
document, and release-operation bindings relative to the explicit immutable
`--release-root`. Both roots reject symlinks, path escapes, missing files, JSON drift and
raw-file hash drift. It then requires:

- exactly the host IDs `claude_code`, `codex`, `opencode`, `grok`, in that order;
- every external-host artifact to validate as `passed` and to reopen its executable, package
  tarball, fact artifact, deterministic decision, report and report-quality paths;
- identical package name, version and tarball hash across all four hosts;
- identical catalog hash/order, selected IDs/hashes and receipt binding across all four hosts,
  checked against the safely installed physical package; result equality is computed only
  from reopened file bytes, never from nested declarations;
- selected IDs/order and selected pack hashes to equal the immutable release manifest;
- release-operation paths to resolve under the explicit `--release-root`; every bound
  pointer-history, operation approval, candidate manifest and previous-release manifest is
  opened and checked against both its raw-file and canonical JSON hashes;
- contiguous monotonic pointer versions for candidate cutover, rollback and final cutover;
  exact operation, release ID, manifest hash, previous-release ID and approval hash
  continuity; and two distinct externally trusted `persona_release` principals on every
  operation approval;
- rollback to reactivate the release that immediately preceded the candidate, that old
  immutable release to remain present and fully verifiable, then a final verified cutover
  and `current.json` selecting the GA candidate; `cutover-ever.json` must end at the same
  pointer version and timestamp;
- every declared `version` in repository and physical-tarball copies of `package.json`,
  `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and
  `.claude-plugin/marketplace.json`, all 26 release `pack_version` values, and all four host
  package versions to equal the explicit `--expected-version` value. Missing, unshipped or
  mixed metadata fails. A package artifact claiming 26 IDs/packs is installed into an
  isolated OS-temporary prefix with lifecycle scripts, registry access, lockfile writes,
  audit and funding calls disabled. Canonical ID order, catalog hash/order and pack hashes
  are derived from the installed physical release manifest.

There is no `evidence_hash` escape hatch. A plausible hash string without its signed
relative path and matching physical file cannot pass. Likewise, free-form
`"cutover":"passed"` or `"rollback":"passed"` claims are schema-invalid and never count.

## Schemas and key purposes

- `schemas/registered-council-evaluation-protocol-v1.schema.json`
- `schemas/persona-v3-experiment-adjudication-v1.schema.json`
- `schemas/persona-v3-ga-package-artifact-v1.schema.json`
- `schemas/persona-v3-release-evidence-v1.schema.json`
- `schemas/external-host-e2e-result-v1.schema.json`

Private keys remain outside the repository, release tree and evidence directory. Public
registries are explicit inputs:

- source reviewers: purpose `source_review`;
- formula reviewers: purpose `formula_review`, at least two distinct principals and keys per
  approved formula;
- experiment adjudicator: purpose `experiment_adjudication`;
- release reviewers: purpose `persona_release_evidence`, at least two distinct principals
  and keys;
- production release approval/cutover: purpose `persona_release` in its separate runtime
  release-key registry.

## Gate invocation

The 0.9.0 GA command shape is:

```bash
node scripts/check-persona-v3-ga.mjs \
  --json \
  --expected-version 0.9.0 \
  --release-root /absolute/path/to/persona-releases \
  --release-id 0.9.0 \
  --release-evidence /absolute/path/to/ga-evidence/release-evidence.json \
  --trusted-source-reviewer-keys /absolute/path/to/source-reviewer-public-keys.json \
  --trusted-formula-reviewer-keys /absolute/path/to/formula-reviewer-public-keys.json \
  --trusted-release-keys /absolute/path/to/persona-release-public-keys.json \
  --trusted-experiment-adjudication-keys /absolute/path/to/experiment-public-keys.json \
  --trusted-release-evidence-keys /absolute/path/to/release-reviewer-public-keys.json \
  --require-count 26 \
  --require-min-admission operational \
  --forbid-legacy \
  --forbid-prompt-lens
```

`--release-manifest` remains only as a migration diagnostic and always blocks GA. The
current worktree is version 0.9.0-solo-test.1 and has no approved physical production release
or signed GA evidence set, so the default production-GA command must fail.
