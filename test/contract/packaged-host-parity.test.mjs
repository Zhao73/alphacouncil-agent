import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  PACKAGED_PARITY_REPO_ROOT,
  npmInvocation,
} from "../../scripts/lib/packaged-host-parity.mjs";
import { parseArgs } from "../../scripts/check-packaged-host-parity.mjs";
import { HOST_SELECTION_INSTRUCTION_PATHS } from "../../scripts/lib/host-selection-instruction-contract.mjs";
import {
  PACKAGE_INVENTORY_CATEGORIES,
  WP2_FORBIDDEN_PACKAGE_PATHS,
  WP2_REQUIRED_PACKAGE_TREES,
} from "../../scripts/lib/package-inventory.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

/**
 * The capsule is complete when the package ships every review the repository tracks, so the
 * expectation is counted from the repository rather than restated as a number that would have
 * to be edited on the day a seat is added.
 */
const REPO_REVIEW_JSON_COUNT = execSync("git ls-files knowledge/ai-assisted-solo/reviews", { cwd: PACKAGED_PARITY_REPO_ROOT, encoding: "utf8" })
  .split("\n").filter((path) => path.endsWith(".json") && existsSync(resolve(PACKAGED_PARITY_REPO_ROOT, path))).length;

/** Seats whose legacy v2 operator material survives in the production fallback profile. */
const LEGACY_OPERATOR_SEATS = 4;
const PACKAGED_PARITY_PROCESS_TIMEOUT_MS = 180_000;
const PACKAGED_PARITY_TEST_TIMEOUT_MS = process.platform === "win32" ? 400_000 : 200_000;

function resultOutput(result) {
  return [result.error?.stack || result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n");
}

function runPackagedParity(env) {
  const attempts = [];
  while (attempts.length < 2) {
    const result = spawnSync(process.execPath, ["scripts/check-packaged-host-parity.mjs", "--json"], {
      cwd: PACKAGED_PARITY_REPO_ROOT,
      encoding: "utf8",
      env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: PACKAGED_PARITY_PROCESS_TIMEOUT_MS,
    });
    attempts.push(result);
    const transientWindowsInstallTimeout = process.platform === "win32"
      && /offline npm install from tarball.*ETIMEDOUT/su.test(resultOutput(result));
    if (!transientWindowsInstallTimeout) break;
  }
  return {
    result: attempts.at(-1),
    diagnostics: attempts.map((attempt, index) => `attempt ${index + 1}:\n${resultOutput(attempt)}`).join("\n"),
  };
}

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

test("npm tarball install exposes identical four-host MCP adapter behavior without external live claims", { timeout: PACKAGED_PARITY_TEST_TIMEOUT_MS }, () => {
  const { result, diagnostics } = runPackagedParity({
    ...process.env,
    npm_config_dry_run: "true",
    NPM_CONFIG_DRY_RUN: "true",
    Npm_Config_Dry_Run: "true",
  });
  assert.equal(result.status, 0, diagnostics);
  const report = JSON.parse(result.stdout);
  assert.equal(report.evidence_scope, "installed_npm_tarball_mcp_stdio_adapters_only");
  assert.equal(report.packaged_adapter_e2e.status, "passed");
  assert.deepEqual(report.packaged_adapter_e2e.host_order, ["claude_code", "codex", "opencode", "grok"]);
  assert.equal(report.packaged_adapter_e2e.host_count, 4);
  assert.equal(report.packaged_adapter_e2e.tool_count, 34);
  assert.equal(report.packaged_adapter_e2e.locale_count, 4);
  assert.equal(report.packaged_adapter_e2e.selection_input_type, "stable_ids");
  assert.deepEqual(report.packaged_adapter_e2e.selection_input, [
    "master_buffett", "master_damodaran", "master_taleb", "master_sinclair",
  ]);
  assert.deepEqual(Object.keys(report.packaged_adapter_e2e.locale_catalog_hashes).sort(), ["en", "ja", "ko", "zh"]);
  assert.equal(report.packaged_adapter_e2e.catalog_count, CANONICAL_MASTER_COUNT);
  assert.deepEqual(report.packaged_adapter_e2e.maturity_counts, { operator_lens: CANONICAL_MASTER_COUNT });
  assert.equal(report.packaged_adapter_e2e.controls.npm_lifecycle_scripts, "disabled_with_ignore_scripts");
  assert.equal(report.packaged_adapter_e2e.controls.npm_registry_access, "disabled_with_offline_install");
  assert.equal(report.packaged_adapter_e2e.controls.external_model_calls, 0);
  assert.equal(report.packaged_adapter_e2e.controls.network_attempts, 0);
  assert.ok(Object.values(report.packaged_adapter_e2e.parity).every(Boolean));
  for (const host of report.packaged_adapter_e2e.hosts) {
    assert.equal(host.adapter_status, "passed", host.host_id);
    assert.equal(host.tool_count, 34, host.host_id);
    assert.equal(host.catalog_count, CANONICAL_MASTER_COUNT, host.host_id);
    assert.equal(host.receipt_consumption, "one_run_only", host.host_id);
    assert.equal(host.cross_host_reuse, "SELECTION_RECEIPT_UNKNOWN", host.host_id);
    assert.equal(host.second_run_replay, "MASTER_SELECTION_REPLAYED", host.host_id);
    assert.equal(host.external_cli_live_e2e, "not_run", host.host_id);
    assert.deepEqual(host.run_masters, report.packaged_adapter_e2e.selected_master_ids, host.host_id);
    assert.deepEqual(host.run_selection_pack_hashes, report.packaged_adapter_e2e.selected_master_pack_hashes, host.host_id);
  }
  assert.deepEqual(report.package_surfaces.host_selection_instructions, {
    status: "passed",
    contract_id: "host_selector_returned_catalog_v1",
    canonical_catalog_count: CANONICAL_MASTER_COUNT,
    files: [...HOST_SELECTION_INSTRUCTION_PATHS],
  });
  assert.equal(report.package_surfaces.deterministic_policy.status, "present_in_installed_tarball");
  assert.deepEqual(report.package_surfaces.exclusions, {
    knowledge_staging: "absent",
    acquisitions: "absent",
    source_bin: "absent",
    local_host_e2e_evidence: "absent",
  });
  assert.deepEqual(report.package_surfaces.ai_assisted_review_capsule, {
    status: "passed",
    json_file_count: REPO_REVIEW_JSON_COUNT,
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
  const inventory = report.package_surfaces.package_inventory;
  assert.equal(inventory.status, "passed");
  assert.ok(inventory.runtime_closure_file_count >= 100);
  assert.deepEqual(Object.keys(inventory.classifications), [...PACKAGE_INVENTORY_CATEGORIES]);
  assert.equal(
    Object.values(inventory.classifications).reduce((sum, value) => sum + value.files, 0),
    report.package.tarball_file_count,
  );
  assert.deepEqual(inventory.forbidden_paths, [...WP2_FORBIDDEN_PACKAGE_PATHS]);
  assert.deepEqual(inventory.required_trees, [...WP2_REQUIRED_PACKAGE_TREES]);
  assert.equal(report.external_cli_live_e2e.status, "not_run");
  assert.ok(Object.values(report.external_cli_live_e2e.hosts).every((status) => status === "not_run"));
  assert.deepEqual(report.physical_v3_decision_parity, {
    status: "not_run",
    reason: "production package contains zero physical PersonaPack v3 packs",
    production_pack_inventory: { physical_v3: 0, legacy_v2: 4 },
  });
  assert.equal(report.temporary_workspace_cleanup, "completed");
});

test("an explicit production profile keeps the packaged legacy fallback separate from solo-test runtime", { timeout: PACKAGED_PARITY_TEST_TIMEOUT_MS }, () => {
  const { result, diagnostics } = runPackagedParity({
    ...process.env,
    ALPHACOUNCIL_PERSONA_BUILD_PROFILE: "production",
  });
  assert.equal(result.status, 0, diagnostics);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.packaged_adapter_e2e.maturity_counts, { operator_lens: LEGACY_OPERATOR_SEATS, prompt_lens: CANONICAL_MASTER_COUNT - LEGACY_OPERATOR_SEATS });
  assert.deepEqual(report.physical_v3_decision_parity, {
    status: "not_run",
    reason: "production package contains zero physical PersonaPack v3 packs",
    production_pack_inventory: { physical_v3: 0, legacy_v2: 4 },
  });
  assert.equal(report.packaged_adapter_e2e.controls.external_model_calls, 0);
  assert.equal(report.packaged_adapter_e2e.controls.network_attempts, 0);
});
