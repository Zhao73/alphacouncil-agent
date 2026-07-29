import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import {
  createPackIndex,
  evaluateCountGate,
  parseArgs,
} from "../../scripts/compile-persona-packs.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/compile-persona-packs.mjs");

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function fakePack(personaId, digit) {
  const hash = `sha256:${digit.repeat(64)}`;
  return {
    persona_id: personaId,
    pack_version: "0.1.0",
    maturity: "operator_lens",
    admitted_label: { en: `${personaId} lens`, zh: `${personaId}视角` },
    source_cutoff: "2026-07-27",
    pack_hash: hash,
    corpus_hash: hash,
    tool_graph_hash: hash,
    policy_hash: hash,
    component_hashes: { doctrine: hash },
    admission: {
      level: "operational",
      counts: { propositions: 10 },
      delta_to_operational: {},
      delta_to_candidate: { propositions: 15 },
      method_model_experiment_status: { status: "not_started", file: "/unstable/path" },
    },
  };
}

test("the stable index sorts packs and legacy ids and hashes only canonical summary fields", () => {
  const index = createPackIndex({
    packs: [fakePack("master_z", "b"), fakePack("master_a", "a")],
    legacy_ids: ["master_y", "master_b"],
  });
  assert.deepEqual(index.packs.map((pack) => pack.persona_id), ["master_a", "master_z"]);
  assert.deepEqual(index.legacy_ids, ["master_b", "master_y"]);
  assert.equal(index.packs[0].admission.method_model_experiment_status, "not_started");
  assert.doesNotMatch(JSON.stringify(index), /unstable\/path/);
  const { pack_index_hash: hash, ...payload } = index;
  assert.equal(hash, sha256(payload));
});

test("the count gate never treats zero physical v3 packs as complete", () => {
  assert.deepEqual(evaluateCountGate(0), {
    status: "failed",
    required_count: null,
    actual_count: 0,
    reason: "no_physical_v3_packs",
  });
  assert.equal(evaluateCountGate(CANONICAL_MASTER_COUNT, CANONICAL_MASTER_COUNT).status, "passed");
  assert.equal(evaluateCountGate(25, 26).reason, "required_count_mismatch");
});

test("argument parsing supports JSON, check mode and the explicit canonical-roster GA gate", () => {
  assert.deepEqual(parseArgs(["--json", "--check", "--require-count", String(CANONICAL_MASTER_COUNT)]), {
    json: true,
    check: true,
    help: false,
    requiredCount: CANONICAL_MASTER_COUNT,
  });
  assert.equal(parseArgs([`--require-count=${CANONICAL_MASTER_COUNT}`]).requiredCount, CANONICAL_MASTER_COUNT);
  assert.throws(() => parseArgs(["--require-count", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--unknown"]), /unknown argument/);
});

test("the CLI reports the current physical registry with a repeatable index hash", () => {
  const first = run(["--json"]);
  const second = run(["--json"]);
  const firstReport = JSON.parse(first.stdout);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(first.status, firstReport.physical_v3_count === 0 ? 1 : 0, first.stderr);
  assert.equal(second.status, first.status, second.stderr);
  assert.equal(firstReport.pack_index_hash, secondReport.pack_index_hash);
  assert.deepEqual(firstReport.packs, secondReport.packs);
  assert.deepEqual(firstReport.legacy_ids, [...firstReport.legacy_ids].sort());
  assert.deepEqual(firstReport.packs.map((pack) => pack.persona_id),
    [...firstReport.packs.map((pack) => pack.persona_id)].sort());
});

test("an empty knowledge directory is incomplete and legacy ids remain visible", (t) => {
  const knowledgeDir = mkdtempSync(join(tmpdir(), "alphacouncil-v3-cli-"));
  t.after(() => rmSync(knowledgeDir, { recursive: true, force: true }));
  const legacyDir = join(knowledgeDir, "master_legacy");
  mkdirSync(legacyDir);
  writeFileSync(join(legacyDir, "manifest.json"), '{"schema_version":2}\n');
  const result = run(["--json"], { ALPHACOUNCIL_KNOWLEDGE_DIR: knowledgeDir });
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.physical_v3_count, 0);
  assert.deepEqual(report.legacy_ids, ["master_legacy"]);
  assert.equal(report.count_gate.status, "failed");
  assert.equal(report.count_gate.reason, "no_physical_v3_packs");
});

test("--require-count fails closed on a mismatch and --check stays terse", () => {
  const current = JSON.parse(run(["--json"]).stdout);
  const mismatched = current.physical_v3_count === CANONICAL_MASTER_COUNT ? CANONICAL_MASTER_COUNT - 1 : CANONICAL_MASTER_COUNT;
  const result = run(["--check", "--require-count", String(mismatched)]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /persona-v3 compile:/);
  assert.match(result.stdout, /count_gate=failed/);
  assert.match(result.stdout, /reason=(?:no_physical_v3_packs|required_count_mismatch)/);
  assert.doesNotMatch(result.stdout, /\n.*\n/u);
});
