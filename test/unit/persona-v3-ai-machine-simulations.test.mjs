import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  AI_MACHINE_SIMULATION_RUN_IDS,
  DEFAULT_AI_MACHINE_SIMULATION_ROOT,
  planAIMachineSimulations,
  verifyAIMachineSimulationTree,
} from "../../scripts/lib/persona-v3-ai-machine-simulations.mjs";
import { parseArgs } from "../../scripts/run-persona-v3-ai-machine-simulations.mjs";
import { inspectAiAssistedSoloStatus } from "../../scripts/lib/persona-v3-ai-assisted-solo-status.mjs";

function byId(plan, id) {
  return plan.runs.find((run) => run.run_id === id);
}

test("eight physical machine simulations run without network, human, formal experiment or GA claims", () => {
  const plan = planAIMachineSimulations();
  assert.deepEqual(plan.runs.map((run) => run.run_id), [...AI_MACHINE_SIMULATION_RUN_IDS]);
  assert.equal(plan.runs.length, 8);
  for (const run of plan.runs) {
    assert.equal(run.evidence_class, "machine_simulation");
    assert.equal(run.network_allowed, false);
    assert.equal(run.results.network_call_count, 0);
    assert.equal(run.human_reference, false);
    assert.equal(run.formal_h_satisfied, false);
    assert.equal(run.formal_arm_satisfied, false);
    assert.equal(run.formal_experiment_effect, "none");
    assert.equal(run.formal_ga_effect, "none");
    assert.equal(run.production_effect, "none");
    assert.deepEqual(run.results.metric_claims, []);
    assert.equal(run.results.formal_results, null);
  }

  const d13 = byId(plan, "D13");
  const d26 = byId(plan, "D26");
  assert.equal(d13.configuration.selected_master_count, 13);
  assert.equal(d13.results.executed_count, 13);
  assert.equal(d26.configuration.selected_master_count, 26);
  assert.equal(d26.results.executed_count, 26);
  assert.equal(d26.results.blocked_fail_closed_count, 0);
  assert.ok(d26.results.decisions.every((decision) => decision.stance !== "constructive"));
  for (const personaId of ["master_graham", "master_pabrai", "master_forensic_short"]) {
    assert.equal(d26.results.decisions.find((decision) => decision.persona_id === personaId)?.status, "executed");
  }

  const h = byId(plan, "H_ai_reference");
  assert.equal(h.formal_arm_id, "H");
  assert.equal(h.human_reference, false);
  assert.match(h.results.machine_reference_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(plan.n_eff_disclosure.n_eff, null);
  assert.equal(plan.n_eff_disclosure.status, "insufficient_resolved_outcomes");
  assert.equal(plan.n_eff_disclosure.formal_n_eff_effect, "none");
});

test("physical simulation artifacts are exact and tampering is rejected", () => {
  const report = verifyAIMachineSimulationTree();
  assert.equal(report.valid, true);
  assert.equal(report.run_count, 8);
  assert.equal(report.executed_count, 105);
  assert.equal(report.blocked_fail_closed_count, 0);
  assert.equal(report.network_call_count, 0);
  assert.equal(report.human_reference_count, 0);
  assert.equal(report.n_eff, null);
  assert.equal(report.n_eff_status, "insufficient_resolved_outcomes");

  const temporary = mkdtempSync(join(tmpdir(), "alphacouncil-machine-simulation-"));
  const root = join(temporary, "ai-assisted-solo", "experiments");
  mkdirSync(dirname(root), { recursive: true });
  cpSync(DEFAULT_AI_MACHINE_SIMULATION_ROOT, root, { recursive: true });
  const file = join(root, "runs", "d13.json");
  const artifact = JSON.parse(readFileSync(file, "utf8"));
  artifact.results.executed_count = 12;
  writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`);
  assert.throws(() => verifyAIMachineSimulationTree({ root }), /artifact drift/u);
});

test("AI-assisted status counts simulations separately and treats honest null N_eff as complete", () => {
  const report = inspectAiAssistedSoloStatus();
  assert.equal(report.automated_experiment_coverage.completed, 8);
  assert.equal(report.automated_experiment_coverage.canonical_experiment_completed, 0);
  assert.equal(report.automated_experiment_coverage.formal_h_status, "not_run");
  assert.equal(report.automated_experiment_coverage.formal_experiment_effect, "none");
  assert.equal(report.n_eff.n_eff, null);
  assert.equal(report.n_eff.status, "insufficient_resolved_outcomes");
  assert.equal(report.n_eff.disclosure_complete, true);
  assert.equal(report.n_eff.formal_n_eff_effect, "none");
  assert.deepEqual(report.blockers, ["live host E2E 0/4"]);
});

test("formal protocol still contains H and never consumes H_ai_reference", () => {
  const protocol = JSON.parse(readFileSync(resolve("data/council-evaluation-protocol.v1.json"), "utf8"));
  assert.deepEqual(protocol.canonical_arm_order, ["A", "B", "C", "D13", "D26", "E", "H"]);
  assert.equal(protocol.arms.at(-1).arm_id, "H");
  assert.equal(JSON.stringify(protocol).includes("H_ai_reference"), false);
  assert.equal(parseArgs(["--check", "--json"]).write, false);
});

test("machine-simulation schema keeps all formal boundaries closed", () => {
  const schema = JSON.parse(readFileSync(resolve("schemas/persona-v3-ai-machine-simulation-v1.schema.json"), "utf8"));
  assert.equal(schema.$defs.boundary.properties.evidence_class.const, "machine_simulation");
  assert.equal(schema.$defs.boundary.properties.human_reference.const, false);
  assert.equal(schema.$defs.boundary.properties.formal_h_satisfied.const, false);
  assert.equal(schema.$defs.boundary.properties.formal_experiment_effect.const, "none");
  assert.equal(schema.$defs.boundary.properties.formal_ga_effect.const, "none");
});
