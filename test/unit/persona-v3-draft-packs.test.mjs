import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import inventory from "../../data/persona-v3-build-specs.v1.mjs";
import { loadV3Packs } from "../../mcp/lib/personas-v3/loader.mjs";
import { scaffoldPersonaV3Staging } from "../../mcp/lib/personas-v3/staging.mjs";
import {
  DRAFT_ARTIFACT_FILES,
  inspectPersonaV3DraftPacks,
  writePersonaV3DraftPacks,
} from "../../scripts/lib/persona-v3-draft-packs.mjs";
import { REPO_ROOT } from "../../scripts/lib/persona-v3-build-specs.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

/** Each seat gets the same fixed slice of draft artifacts; the roster size is what varies. */
const DRAFT_ARTIFACTS_PER_SEAT = 9;

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-v3-drafts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "staging");
  const productionRoot = join(dir, "production");
  mkdirSync(productionRoot);
  scaffoldPersonaV3Staging({ root, productionRoot });
  return { dir, root, productionRoot };
}

test("factory writes every canonical seat physical draft slices and is byte-stable", (t) => {
  const paths = workspace(t);
  const first = writePersonaV3DraftPacks(paths);
  assert.equal(first.written.length, CANONICAL_MASTER_COUNT * (DRAFT_ARTIFACTS_PER_SEAT + 1)); // artifacts plus one scaffold update per seat
  assert.equal(first.unchanged.length, 0);
  const firstReport = inspectPersonaV3DraftPacks(paths);
  assert.equal(firstReport.draft_pack_count, CANONICAL_MASTER_COUNT);
  assert.equal(firstReport.present_artifact_count, CANONICAL_MASTER_COUNT * DRAFT_ARTIFACTS_PER_SEAT);
  assert.equal(firstReport.invalid_count, 0);
  assert.equal(firstReport.production_loader_visible_count, 0);
  assert.equal(firstReport.production_eligible_count, 0);
  assert.equal(firstReport.staging_physical_v3_count, 0);

  const second = writePersonaV3DraftPacks(paths);
  assert.equal(second.written.length, 0);
  assert.equal(second.unchanged.length, CANONICAL_MASTER_COUNT * (DRAFT_ARTIFACTS_PER_SEAT + 1));
  const secondReport = inspectPersonaV3DraftPacks(paths);
  assert.equal(secondReport.draft_inventory_hash, firstReport.draft_inventory_hash);
});

test("every seat covers its facts, tools, vetoes and native projection without unearned claims", (t) => {
  const paths = workspace(t);
  writePersonaV3DraftPacks(paths);
  for (const seat of inventory.seats) {
    const artifact = (key) => JSON.parse(readFileSync(join(paths.root, seat.persona_id, DRAFT_ARTIFACT_FILES[key]), "utf8"));
    const research = artifact("research_policy");
    const policy = artifact("decision_policy");
    const tools = artifact("tools");
    const index = artifact("draft_pack_index");
    const facts = [...research.fact_contract.critical, ...research.fact_contract.optional].map((item) => item.fact_type);
    assert.deepEqual(new Set(facts), new Set(seat.required_fact_types), seat.persona_id);
    assert.ok(research.fact_contract.critical.length >= 2, seat.persona_id);
    assert.ok(research.fact_contract.optional.length >= 1, seat.persona_id);
    assert.equal(research.raw_acquisition_snapshot.establishes_method_evidence, false, seat.persona_id);
    assert.equal(research.raw_acquisition_snapshot.target_linkage_status, "not_established", seat.persona_id);
    assert.deepEqual(tools.computations.map((tool) => tool.tool_id), seat.planned_dedicated_tools.map((tool) => tool.tool_id), seat.persona_id);
    assert.ok(tools.computations.length >= 2, seat.persona_id);
    assert.deepEqual(policy.hard_veto_hypotheses.map((veto) => veto.veto_id), seat.veto_families.map((veto) => veto.veto_id), seat.persona_id);
    assert.ok(policy.hard_veto_hypotheses.length >= 3, seat.persona_id);
    assert.deepEqual(policy.native_states, seat.native_decision_contract.states, seat.persona_id);
    assert.deepEqual(policy.common_projection_hypotheses.map((item) => item.native_state), seat.native_decision_contract.states, seat.persona_id);
    assert.equal(index.artifact_status, "editorial_prototype");
    assert.equal(index.human_adjudication_status, "pending_human_adjudication");
    assert.equal(index.production_guard.production_eligible, false);
    assert.doesNotMatch(JSON.stringify({ research, policy, tools, index }), /"source_ids"|"grade"|"reviewer_ids"|"maturity"|"admission"/u, seat.persona_id);
    assert.equal(existsSync(join(paths.root, seat.persona_id, "manifest.json")), false, seat.persona_id);
  }
});

test("all computation pairs are structurally differentiated by seat-specific facts, outputs, families or steps", (t) => {
  const paths = workspace(t);
  writePersonaV3DraftPacks(paths);
  const signatures = [];
  for (const seat of inventory.seats) {
    const tools = JSON.parse(readFileSync(join(paths.root, seat.persona_id, DRAFT_ARTIFACT_FILES.tools), "utf8"));
    const [first, second] = tools.computations;
    const signature = (tool) => JSON.stringify({
      family: tool.operation_family,
      inputs: tool.input_fact_types,
      outputs: tool.output_fact_types,
      steps: tool.computation_steps,
    });
    assert.notEqual(signature(first), signature(second), seat.persona_id);
    signatures.push(JSON.stringify(tools.computations.map(signature)));
  }
  assert.equal(new Set(signatures).size, CANONICAL_MASTER_COUNT, "every canonical seat need distinct computation structures");
});

test("scaffolds describe draft work without hashes, reviewers or production eligibility", (t) => {
  const paths = workspace(t);
  writePersonaV3DraftPacks(paths);
  for (const seat of inventory.seats) {
    const scaffold = JSON.parse(readFileSync(join(paths.root, seat.persona_id, "scaffold.json"), "utf8"));
    assert.equal(scaffold.production_guard.production_eligible, false);
    for (const component of scaffold.component_plan) {
      assert.equal(component.status, component.component === "sources" ? "not_started" : "draft", `${seat.persona_id}:${component.component}`);
      assert.equal(component.artifact_hash, null);
      assert.equal(component.reviewed_at, null);
      assert.deepEqual(component.reviewer_ids, []);
      assert.ok(component.notes.length > 10);
    }
  }
});

test("checker rejects artifact drift and symlink paths", (t) => {
  const paths = workspace(t);
  writePersonaV3DraftPacks(paths);
  const seat = inventory.seats[0].persona_id;
  const policyFile = join(paths.root, seat, DRAFT_ARTIFACT_FILES.decision_policy);
  writeFileSync(policyFile, `${readFileSync(policyFile, "utf8")}\n`);
  let report = inspectPersonaV3DraftPacks(paths);
  assert.equal(report.invalid_count, 1);
  assert.match(report.personas[0].errors.join("\n"), /content drifted/);

  rmSync(policyFile);
  symlinkSync(join(paths.root, seat, DRAFT_ARTIFACT_FILES.tools), policyFile);
  assert.throws(() => inspectPersonaV3DraftPacks(paths), /staging integrity must pass|symlink/u);
});

test("draft-index schema is parseable and hard-codes non-production status", () => {
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas/persona-v3-draft-pack-index-v1.schema.json"), "utf8"));
  assert.equal(schema.properties.artifact_status.const, "editorial_prototype");
  assert.equal(schema.properties.human_adjudication_status.const, "pending_human_adjudication");
  assert.equal(schema.properties.production_effect.const, "none");
  assert.equal(schema.properties.production_guard.properties.production_eligible.const, false);
  assert.equal(schema.properties.production_guard.properties.manifest_allowed.const, false);
});

test("CLI is check-only by default and --write is explicit", (t) => {
  const paths = workspace(t);
  const baseArgs = ["scripts/generate-persona-v3-drafts.mjs", "--root", paths.root, "--production-root", paths.productionRoot];
  const before = spawnSync(process.execPath, baseArgs, { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(before.status, 1);
  assert.equal(existsSync(join(paths.root, inventory.seats[0].persona_id, "artifacts")), false);

  const write = spawnSync(process.execPath, [...baseArgs, "--write"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, new RegExp(`seats=${CANONICAL_MASTER_COUNT}/${CANONICAL_MASTER_COUNT}`));
  assert.match(write.stdout, /loader_visible=0/);

  const check = spawnSync(process.execPath, baseArgs, { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, new RegExp(`artifacts=${CANONICAL_MASTER_COUNT * DRAFT_ARTIFACTS_PER_SEAT}/${CANONICAL_MASTER_COUNT * DRAFT_ARTIFACTS_PER_SEAT}`));
  assert.equal(loadV3Packs({ dir: paths.root }).packs.length, 0);
});
