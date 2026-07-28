import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  PACKAGED_PARITY_REPO_ROOT,
  npmInvocation,
} from "../../scripts/lib/packaged-host-parity.mjs";
import { parseArgs } from "../../scripts/check-packaged-host-parity.mjs";

test("packaged parity CLI defaults to a read-only temporary check", () => {
  assert.deepEqual(parseArgs([]), { json: false, markdown: false, help: false, checkOnly: true });
  assert.throws(() => parseArgs(["--write"]), /unknown argument/);
  assert.throws(() => parseArgs(["--json", "--markdown"]), /mutually exclusive/);
});

test("npm execution never spawns a cmd shim directly on Windows", () => {
  assert.deepEqual(npmInvocation(["pack"], {
    platform: "win32",
    env: { npm_execpath: "C:\\npm\\npm-cli.js" },
    nodeExecutable: "C:\\node\\node.exe",
    fileExists: () => true,
  }), {
    command: "C:\\node\\node.exe",
    args: ["C:\\npm\\npm-cli.js", "pack"],
  });
  assert.deepEqual(npmInvocation(["pack"], {
    platform: "win32",
    env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    fileExists: () => false,
  }), {
    command: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd", "pack"],
  });
});

test("npm tarball install exposes identical four-host MCP adapter behavior without external live claims", { timeout: 200_000 }, () => {
  const result = spawnSync(process.execPath, ["scripts/check-packaged-host-parity.mjs", "--json"], {
    cwd: PACKAGED_PARITY_REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_dry_run: "true",
      NPM_CONFIG_DRY_RUN: "true",
      Npm_Config_Dry_Run: "true",
    },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.evidence_scope, "installed_npm_tarball_mcp_stdio_adapters_only");
  assert.equal(report.packaged_adapter_e2e.status, "passed");
  assert.deepEqual(report.packaged_adapter_e2e.host_order, ["claude_code", "codex", "opencode", "grok"]);
  assert.equal(report.packaged_adapter_e2e.host_count, 4);
  assert.equal(report.packaged_adapter_e2e.catalog_count, 26);
  assert.deepEqual(report.packaged_adapter_e2e.maturity_counts, { operator_lens: 26 });
  assert.equal(report.packaged_adapter_e2e.controls.npm_lifecycle_scripts, "disabled_with_ignore_scripts");
  assert.equal(report.packaged_adapter_e2e.controls.npm_registry_access, "disabled_with_offline_install");
  assert.equal(report.packaged_adapter_e2e.controls.external_model_calls, 0);
  assert.equal(report.packaged_adapter_e2e.controls.network_attempts, 0);
  assert.ok(Object.values(report.packaged_adapter_e2e.parity).every(Boolean));
  for (const host of report.packaged_adapter_e2e.hosts) {
    assert.equal(host.adapter_status, "passed", host.host_id);
    assert.equal(host.catalog_count, 26, host.host_id);
    assert.equal(host.receipt_consumption, "one_run_only", host.host_id);
    assert.equal(host.cross_host_reuse, "SELECTION_RECEIPT_UNKNOWN", host.host_id);
    assert.equal(host.second_run_replay, "MASTER_SELECTION_REPLAYED", host.host_id);
    assert.equal(host.external_cli_live_e2e, "not_run", host.host_id);
    assert.deepEqual(host.run_masters, report.packaged_adapter_e2e.selected_master_ids, host.host_id);
    assert.deepEqual(host.run_selection_pack_hashes, report.packaged_adapter_e2e.selected_master_pack_hashes, host.host_id);
  }
  assert.equal(report.package_surfaces.deterministic_policy.status, "present_in_installed_tarball");
  assert.deepEqual(report.package_surfaces.exclusions, {
    knowledge_staging: "absent",
    acquisitions: "absent",
    source_bin: "absent",
    local_host_e2e_evidence: "absent",
  });
  assert.deepEqual(report.package_surfaces.ai_assisted_review_capsule, {
    status: "passed",
    json_file_count: 185,
    source_verification_mode: "packaged_capsule_only",
    semantic_verification_modes: {
      extraction: "packaged_capsule_only",
      skeptic: "packaged_capsule_only",
      adjudication: "packaged_capsule_only",
    },
    local_test_status: "ready",
    human_review_satisfied: false,
    formal_ga_effect: "none",
  });
  assert.equal(report.external_cli_live_e2e.status, "not_run");
  assert.ok(Object.values(report.external_cli_live_e2e.hosts).every((status) => status === "not_run"));
  assert.deepEqual(report.physical_v3_decision_parity, {
    status: "not_run",
    reason: "production package contains zero physical PersonaPack v3 packs",
    production_pack_inventory: { physical_v3: 0, legacy_v2: 4 },
  });
  assert.equal(report.temporary_workspace_cleanup, "completed");
});

test("an explicit production profile keeps the packaged legacy 4/22 fallback separate from solo-test runtime", { timeout: 200_000 }, () => {
  const result = spawnSync(process.execPath, ["scripts/check-packaged-host-parity.mjs", "--json"], {
    cwd: PACKAGED_PARITY_REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
    env: { ...process.env, ALPHACOUNCIL_PERSONA_BUILD_PROFILE: "production" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.packaged_adapter_e2e.maturity_counts, { operator_lens: 4, prompt_lens: 22 });
  assert.deepEqual(report.physical_v3_decision_parity, {
    status: "not_run",
    reason: "production package contains zero physical PersonaPack v3 packs",
    production_pack_inventory: { physical_v3: 0, legacy_v2: 4 },
  });
  assert.equal(report.packaged_adapter_e2e.controls.external_model_calls, 0);
  assert.equal(report.packaged_adapter_e2e.controls.network_attempts, 0);
});
