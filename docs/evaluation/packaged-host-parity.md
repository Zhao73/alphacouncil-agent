# Installed npm-tarball packaged host parity

This gate tests what the published package actually contains and what its packaged MCP server does. It does not substitute repository files for installed files.

```bash
node scripts/check-packaged-host-parity.mjs --check
node scripts/check-packaged-host-parity.mjs --markdown
```

The command is check-only by default. It creates one validated OS-temporary workspace, runs `npm pack --ignore-scripts`, installs that local tarball with `npm install --offline --ignore-scripts`, uses a temporary npm cache and npm configuration, starts `mcp/server.mjs` from the installed package, and removes the workspace after the check. The lifecycle-script flags are required to prevent `prepublishOnly -> npm run check -> packaged parity -> npm pack` recursion.

For each of `claude_code`, `codex`, `opencode`, and `grok`, the gate starts a separate packaged MCP process and a separate temporary runtime-data directory. It executes the same protocol:

1. `begin_council_selection` with the host ID;
2. verify that all 26 catalog cards and required fields are present in both structured content and displayed text;
3. `confirm_master_selection` with `display_ack=true` and the same numbered selection;
4. reject a receipt issued into another host adapter's isolated runtime store;
5. `plan_visible_run` with an explicit network-free grounding fixture;
6. reject using the consumed receipt to create a second run.

The comparison covers catalog order/hash, selected IDs, selected pack hashes, normalized receipt binding, run masters, and run selection pack hashes. A preload blocks HTTP, HTTPS, TCP, TLS, DNS, and `fetch`; any attempted network call creates a sentinel and fails the gate.

The tarball must contain the four host configuration/command surfaces and `docs/persona-v3-deterministic-policy.md`. It must not contain `knowledge/staging`, `acquisitions`, or `source.bin`.

## Evidence boundary

The result field is `packaged_adapter_e2e`. It proves installed-tarball MCP adapter parity only. `external_cli_live_e2e` remains `not_run`: no Claude Code, Codex, OpenCode, Grok Build CLI, or external model is launched. `physical_v3_decision_parity` also remains `not_run` while the production package contains zero physical PersonaPack v3 packs.
