import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { registry, selectRoster } from "../../mcp/lib/personas/registry.mjs";
import {
  CANONICAL_ARM_IDS,
  CANONICAL_METRIC_IDS,
  CANONICAL_PROTOCOL_FILE,
  PRIORITY_13_MASTER_IDS,
  REPO_ROOT,
  councilEvaluationProtocolReport,
  loadCouncilEvaluationProtocol,
  validateCouncilEvaluationProtocol,
} from "../../scripts/lib/council-evaluation-protocol.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";

function canonical() {
  return loadCouncilEvaluationProtocol();
}

test("canonical draft matches the live analysts, verifier roster, priority 13 and the whole master roster", () => {
  const protocol = canonical();
  const validation = validateCouncilEvaluationProtocol(protocol);
  const reg = registry();
  assert.equal(validation.valid, true, validation.errors.join("\n"));
  assert.deepEqual(protocol.canonical_arm_order, CANONICAL_ARM_IDS);
  assert.deepEqual(protocol.registry_snapshot.default_analyst_ids, DEFAULT_TASKS);
  assert.deepEqual(
    protocol.registry_snapshot.verifier_ids,
    selectRoster(reg, { kind: "verifier", roster: "verify" }).map((persona) => persona.id),
  );
  assert.deepEqual(protocol.registry_snapshot.priority_13_master_ids, PRIORITY_13_MASTER_IDS);
  assert.deepEqual(protocol.registry_snapshot.canonical_master_ids, reg.ids("master"));
  assert.equal(reg.ids("master").length, CANONICAL_MASTER_COUNT);
});

test("the seven arm contracts are exact and preserve E variants plus blinded H", () => {
  const byId = new Map(canonical().arms.map((arm) => [arm.arm_id, arm]));
  assert.deepEqual([...byId.keys()], CANONICAL_ARM_IDS);
  assert.equal(byId.get("A").execution_mode, "single_agent_baseline");
  assert.deepEqual(byId.get("B").analyst_ids, DEFAULT_TASKS);
  assert.deepEqual(byId.get("B").master_ids, []);
  assert.equal(byId.get("C").master_execution_mode, "legacy_prompt_snapshot");
  assert.equal(byId.get("C").master_ids.length, CANONICAL_MASTER_COUNT);
  assert.deepEqual(byId.get("D13").master_ids, PRIORITY_13_MASTER_IDS);
  assert.equal(byId.get("D26").master_ids.length, CANONICAL_MASTER_COUNT);
  assert.deepEqual(byId.get("E").base_arm_ids, ["D13", "D26"]);
  assert.deepEqual(byId.get("E").verifier_ids, ["source_fidelity", "rederivation", "refuter"]);
  assert.equal(byId.get("E").bounded_repair.maximum_rounds, 2);
  assert.deepEqual(byId.get("H").human_reference, {
    minimum_independent_analysts: 2,
    maximum_independent_analysts: 3,
    blinded_adjudicator_count: 1,
    automated_vote: false,
    independent_before_adjudication: true,
  });
});

test("draft has null registration, no results, no signatures and no passed claims", () => {
  const report = councilEvaluationProtocolReport(canonical());
  assert.equal(report.valid, true);
  assert.equal(report.status, "draft_unregistered");
  assert.equal(report.registered, false);
  assert.equal(report.dataset_hash, null);
  assert.equal(report.case_ledger_hash, null);
  assert.equal(report.result_count, 0);
  assert.equal(report.signature_count, 0);
  assert.equal(report.passed_claim_count, 0);
  assert.match(report.draft_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(report.blockers, [
    "dataset_hash_not_frozen",
    "case_ledger_hash_not_frozen",
    "protocol_not_registered",
    "promotion_thresholds_not_preregistered",
    "multiplicity_policy_not_preregistered",
  ]);
});

test("validator rejects fake registration, signatures, results and passed claims", () => {
  const changed = structuredClone(canonical());
  changed.protocol_status = "registered";
  changed.registration.dataset_hash = `sha256:${"1".repeat(64)}`;
  changed.registration.registered_at = "2026-07-27T00:00:00.000Z";
  changed.registration.signer_key_id = "self:declared";
  changed.registration.signature = `sha256:${"2".repeat(64)}`;
  changed.metrics[0].result = { value: 1, passed: true };
  changed.arms[0].result_status = "passed";
  changed.arms[0].results = { winner: true };
  changed.arms[0].signatures = ["self-signed"];
  changed.arms[0].passed_claims = ["A wins"];
  changed.comparison_policy.release_claims = ["D26 is better"];
  changed.comparison_policy.promotion_effect = "method_model";
  const result = validateCouncilEvaluationProtocol(changed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /draft_unregistered/.test(error)));
  assert.ok(result.errors.some((error) => /dataset_hash must remain null/.test(error)));
  assert.ok(result.errors.some((error) => /signatures must remain empty/.test(error)));
  assert.ok(result.errors.some((error) => /passed_claims must remain empty/.test(error)));
  assert.ok(result.errors.some((error) => /release_claims must remain empty/.test(error)));
  assert.ok(result.errors.some((error) => /promotion_effect must remain none/.test(error)));
});

test("validator rejects arm, analyst, verifier and master drift", () => {
  const changed = structuredClone(canonical());
  [changed.arms[0], changed.arms[1]] = [changed.arms[1], changed.arms[0]];
  changed.registry_snapshot.default_analyst_ids.pop();
  changed.registry_snapshot.verifier_ids.reverse();
  changed.arms.find((arm) => arm.arm_id === "D13").master_ids.pop();
  changed.arms.find((arm) => arm.arm_id === "D26").master_ids.reverse();
  const result = validateCouncilEvaluationProtocol(changed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /canonical arm order drifted/.test(error)));
  assert.ok(result.errors.some((error) => /default_analyst_ids vs live DEFAULT_TASKS drifted/.test(error)));
  assert.ok(result.errors.some((error) => /verifier_ids vs live verify roster drifted/.test(error)));
  assert.ok(result.errors.some((error) => /arms\[.*\]\.master_ids drifted/.test(error)));
});

test("metric suite contains the seven preregistration families and no values", () => {
  const protocol = canonical();
  assert.deepEqual(protocol.metrics.map((metric) => metric.metric_id), CANONICAL_METRIC_IDS);
  assert.deepEqual(protocol.metrics.map((metric) => metric.family), [
    "fact", "citation", "calibration", "abstention", "unique_contribution", "cost", "latency",
  ]);
  assert.ok(protocol.metrics.every((metric) => metric.result === null));
  assert.ok(protocol.resource_accounting.record_failed_and_retried_work);
  assert.ok(protocol.resource_accounting.matched_cost_secondary_analysis_required);
  assert.equal(protocol.point_in_time_controls.fact_visibility_rule, "public_at <= as_of AND known_at <= as_of");
  assert.equal(protocol.anti_leakage_controls.post_as_of_search_results_forbidden, true);
  assert.equal(protocol.adjudication.agreement_reported_separately_from_independence, true);
});

test("JSON schema is parseable and structurally forbids result claims", () => {
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas/council-evaluation-protocol-v1.schema.json"), "utf8"));
  assert.equal(schema.properties.protocol_status.const, "draft_unregistered");
  assert.deepEqual(schema.properties.canonical_arm_order.const, CANONICAL_ARM_IDS);
  assert.equal(schema.properties.registration.properties.dataset_hash.const, null);
  assert.equal(schema.$defs.metric.properties.result.const, null);
  assert.equal(schema.$defs.arm.properties.result_status.const, "not_run");
  assert.equal(schema.$defs.arm.properties.signatures.maxItems, 0);
  assert.equal(schema.$defs.arm.properties.passed_claims.maxItems, 0);
  assert.equal(schema.properties.comparison_policy.properties.release_claims.maxItems, 0);
});

test("report CLI validates the canonical file and labels markdown as no-results draft", () => {
  const check = spawnSync(process.execPath, ["scripts/report-council-evaluation-protocol.mjs", "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /status=draft_unregistered arms=7 results=0 signatures=0 passed_claims=0 valid/);

  const markdown = spawnSync(process.execPath, ["scripts/report-council-evaluation-protocol.mjs", "--markdown"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /DRAFT \/ UNREGISTERED \/ NO RESULTS/);
  assert.match(markdown.stdout, /\| D13 \| machine_council \| 8 \| 13/);
  assert.match(markdown.stdout, /Results: 0; signatures: 0; passed claims: 0/);
  assert.match(markdown.stdout, /dataset_hash_not_frozen/);
});

test("CLI check fails for a draft file containing a fabricated result", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-protocol-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "fake.json");
  const changed = structuredClone(canonical());
  changed.arms[4].results = { claim: "fabricated" };
  writeFileSync(file, `${JSON.stringify(changed, null, 2)}\n`);
  const check = spawnSync(process.execPath, ["scripts/report-council-evaluation-protocol.mjs", "--check", "--file", file], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /results must remain null/);
});

test("canonical protocol path is stable and exists", () => {
  assert.equal(CANONICAL_PROTOCOL_FILE, join(REPO_ROOT, "data/council-evaluation-protocol.v1.json"));
  assert.equal(JSON.parse(readFileSync(CANONICAL_PROTOCOL_FILE, "utf8")).schema_version, 1);
});
