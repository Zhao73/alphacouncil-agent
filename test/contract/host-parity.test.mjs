import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { catalogSnapshot } from "../../mcp/lib/council-selection.mjs";
import { registry } from "../../mcp/lib/personas/registry.mjs";
import {
  HOST_REPO_ROOT,
  auditHostAdapterFreshness,
  loadHostCapabilities,
  validateHostCapabilities,
} from "../../scripts/lib/host-capabilities.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

const read = (rel) => readFileSync(join(HOST_REPO_ROOT, rel), "utf8");

function effectiveCommand(host) {
  const adapter = host.command_surface.repository_adapters[0];
  return read(adapter || host.command_surface.canonical_source);
}

test("host capability record is exact, non-claiming and schema-backed", () => {
  const schema = JSON.parse(read("schemas/host-capabilities-v1.schema.json"));
  assert.equal(schema.properties.evidence_scope.const, "repository_static_contract_only");
  assert.equal(schema.properties.live_e2e_overall.const, "not_run");

  const contract = loadHostCapabilities();
  const result = validateHostCapabilities(contract);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.deepEqual(contract.hosts.map((host) => host.host_id), ["claude_code", "codex", "opencode", "grok"]);
  for (const host of contract.hosts) {
    assert.equal(host.live_e2e.status, "not_run", host.host_id);
    assert.equal(host.live_e2e.artifact, null, host.host_id);
    assert.equal(host.visible_subagents.live_status, "not_run", host.host_id);
    assert.equal(host.parallelism.live_status, "not_run", host.host_id);
    assert.equal(host.resume.host_session_resume, "not_live_verified", host.host_id);
    assert.equal(host.chooser.numbered_fallback, "required_shipped", host.host_id);
  }
});

test("all four shipped command surfaces impose the same ordered selection protocol", () => {
  const contract = loadHostCapabilities();
  const canonical = read("commands/alpha.md");
  const orderedMarkers = [
    "Call `begin_council_selection`",
    "Show **every returned master individually",
    "Ask for one submission",
    "Call `confirm_master_selection`",
    "Only now call `plan_visible_run`",
  ];
  for (const host of contract.hosts) {
    const command = effectiveCommand(host);
    assert.equal(command, canonical, `${host.host_id} command surface drifted`);
    let cursor = -1;
    for (const marker of orderedMarkers) {
      const next = command.indexOf(marker);
      assert.ok(next > cursor, `${host.host_id} does not require ordered step: ${marker}`);
      cursor = next;
    }
    for (const marker of ["`identity`", "`method`", "`best_for`", "`maturity`", "catalog_hash", "display_ack: true", "one-use `selection_receipt`", "missing, expired, stale or consumed"]) {
      assert.ok(command.includes(marker), `${host.host_id} lacks ${marker}`);
    }
  }
});

test("all four hosts resolve one canonical selector ID order and hash semantics", () => {
  const contract = loadHostCapabilities();
  const snapshots = contract.hosts.map(() => catalogSnapshot("English"));
  for (const snapshot of snapshots.slice(1)) assert.deepEqual(snapshot, snapshots[0]);
  const catalog = snapshots[0];
  assert.equal(catalog.count, CANONICAL_MASTER_COUNT);
  assert.deepEqual(catalog.all_master_ids, registry().ids("master"));
  assert.match(catalog.catalog_hash, /^[a-f0-9]{64}$/);
  for (const [index, seat] of catalog.masters.entries()) {
    assert.equal(seat.index, index + 1);
    assert.equal(seat.id, catalog.all_master_ids[index]);
    assert.match(seat.pack_hash, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(contract.shared_selection_protocol.pack_hash_semantics, "non_null_per_seat_hash_bound_into_selection_receipt");
  assert.equal(contract.shared_selection_protocol.receipt_semantics, "short_lived_one_run_symbol_intent_catalog_and_selected_pack_hash_binding");
});

test("capability model and permission records match shipped agent definitions", () => {
  const contract = loadHostCapabilities();
  const byId = new Map(contract.hosts.map((host) => [host.host_id, host]));
  const reg = registry();
  for (const id of [...reg.ids("analyst"), ...reg.ids("debate")]) {
    const persona = reg.get(id);
    const claude = read(`.claude/agents/alphacouncil-${id}.md`);
    assert.match(claude, new RegExp(`^model: ${byId.get("claude_code").model_mapping[persona.model_tier]}$`, "m"));
    const opencode = read(`.opencode/agent/alphacouncil-${id}.md`);
    assert.match(opencode, new RegExp(`^model: ${byId.get("opencode").model_mapping[persona.model_tier].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(opencode, /^  edit: deny$/m);
    assert.match(opencode, /^  bash: deny$/m);
    const grok = read(`.grok/agents/alphacouncil-${id}.md`);
    assert.match(grok, /^permission_mode: plan$/m);
  }
});

test("freshness audit distinguishes current, stale and absent Codex user prompts", () => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-host-parity-"));
  try {
    let audit = auditHostAdapterFreshness({ codexPromptsDir: dir });
    assert.deepEqual(audit.adapters.map((adapter) => adapter.status), ["current", "current", "current"]);
    assert.equal(audit.codex_user_prompt.status, "not_installed");
    writeFileSync(join(dir, "alpha.md"), "stale command\n");
    audit = auditHostAdapterFreshness({ codexPromptsDir: dir });
    assert.equal(audit.codex_user_prompt.status, "stale");
    writeFileSync(join(dir, "alpha.md"), read("commands/alpha.md"));
    audit = auditHostAdapterFreshness({ codexPromptsDir: dir });
    assert.equal(audit.codex_user_prompt.status, "current");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports an installed but stale Codex alpha prompt without overwriting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-doctor-host-"));
  try {
    const prompt = join(dir, "alpha.md");
    writeFileSync(prompt, "locally stale\n");
    const result = spawnSync(process.execPath, ["scripts/doctor.mjs"], {
      cwd: HOST_REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ALPHACOUNCIL_CODEX_PROMPTS_DIR: dir,
        ALPHACOUNCIL_AGENT_DATA_DIR: join(dir, "runtime-data"),
      },
    });
    assert.equal(result.status, 1, `a stale installed command must be actionable:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /WARN  Codex user \/alpha prompt is stale/);
    assert.match(result.stdout, /replace .*alpha\.md with commands\/alpha\.md/);
    assert.equal(readFileSync(prompt, "utf8"), "locally stale\n", "doctor must be read-only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validator rejects fabricated live execution and a weakened numbered fallback", () => {
  const changed = structuredClone(loadHostCapabilities());
  changed.live_e2e_overall = "passed";
  changed.hosts[0].live_e2e = { status: "passed", artifact: "invented.json" };
  changed.hosts[1].chooser.numbered_fallback = "optional";
  const result = validateHostCapabilities(changed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("real external execution artifact")));
  assert.ok(result.errors.some((error) => error.includes("fabricated artifact")));
  assert.ok(result.errors.some((error) => error.includes("weakens fallback")));
});

test("host capability report passes and labels live host E2E not_run", () => {
  const result = spawnSync(process.execPath, ["scripts/report-host-capabilities.mjs", "--check"], {
    cwd: HOST_REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /4 hosts/);
  assert.match(result.stdout, new RegExp(`${CANONICAL_MASTER_COUNT} selector IDs`));
  assert.match(result.stdout, /live_e2e=not_run/);
});
