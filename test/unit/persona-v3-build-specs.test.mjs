import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import inventory from "../../data/persona-v3-build-specs.v1.mjs";
import {
  REPO_ROOT,
  personaV3BuildSpecReport,
  validatePersonaV3BuildSpecs,
} from "../../scripts/lib/persona-v3-build-specs.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { PLANNED_TOOL_COUNT } from "../../data/persona-v3-build-specs.v1.mjs";

test("the planning inventory matches the canonical seat catalog and legacy material", () => {
  const result = validatePersonaV3BuildSpecs();
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.equal(result.canonical_ids.length, CANONICAL_MASTER_COUNT);
  assert.deepEqual(inventory.seats.map((seat) => seat.persona_id), result.canonical_ids);
  assert.deepEqual(result.legacy_v2_ids, [
    "master_buffett",
    "master_duan_yongping",
    "master_marks",
    "master_taleb",
  ]);
  assert.equal(inventory.inventory_status, "non_production_planning_only");
  assert.equal(inventory.adjudication_policy.promotion_effect, "none");
});

test("every seat remains evidence-honest and pending human adjudication", () => {
  for (const seat of inventory.seats) {
    assert.equal(seat.build_status, "spec_only", seat.persona_id);
    assert.equal(seat.native_decision_contract.implementation_status, "planned_unverified", seat.persona_id);
    assert.ok(seat.planned_dedicated_tools.length >= 2, seat.persona_id);
    assert.ok(seat.veto_families.length >= 3, seat.persona_id);
    assert.ok(seat.primary_source_acquisition_targets.length >= 3, seat.persona_id);
    assert.deepEqual(seat.case_acquisition_targets.map((target) => target.case_family).sort(), ["counterfactual", "decision", "failure", "golden"]);
    assert.equal(seat.human_adjudication.method_attribution, "pending_human_adjudication", seat.persona_id);
    assert.equal(seat.human_adjudication.source_grade, "pending_human_adjudication", seat.persona_id);
    assert.equal(seat.human_adjudication.reviewer_approvals, "none", seat.persona_id);
    assert.equal(seat.human_adjudication.experiment_status, "not_started", seat.persona_id);
    assert.doesNotMatch(JSON.stringify(seat), /https?:\/\//i, seat.persona_id);
  }
});

test("report distinguishes planned requirements from current maturity", () => {
  const report = personaV3BuildSpecReport();
  assert.equal(report.valid, true);
  // The split between prompt-only and legacy-operator material is a property of the seats, not
  // a number to restate: what has to hold is that every canonical seat lands in exactly one bucket.
  assert.equal(report.current_material.v1_prompt + report.current_material.v2_operator, CANONICAL_MASTER_COUNT);
  assert.equal(report.current_material.v2_operator, 4);
  assert.equal(report.current_material.physical_v3, 0);
  assert.equal(report.current_material.method_model, 0);
  assert.deepEqual(report.adjudication, {
    pending_seats: CANONICAL_MASTER_COUNT,
    reviewer_approvals: 0,
    experiment_passes: 0,
    production_promotions: 0,
  });
  assert.equal(report.totals.planned_tools, PLANNED_TOOL_COUNT);
  // Every seat plans three vetoes, three source targets and the same four case minimums, so
  // these are per-seat rates rather than fixed totals -- stating them as multiples keeps the
  // shape pinned while letting the roster grow.
  assert.equal(report.totals.veto_families, CANONICAL_MASTER_COUNT * 3);
  assert.equal(report.totals.source_targets, CANONICAL_MASTER_COUNT * 3);
  assert.deepEqual(report.totals.case_targets, {
    decision: CANONICAL_MASTER_COUNT * 5,
    failure: CANONICAL_MASTER_COUNT * 3,
    counterfactual: CANONICAL_MASTER_COUNT * 20,
    golden: CANONICAL_MASTER_COUNT * 12,
  });
});

test("validator rejects invented citations, fake completion and fake reviewer approval", () => {
  const changed = structuredClone(inventory);
  changed.seats[0].primary_source_acquisition_targets[0].acquisition_target = "https://example.invalid/fake";
  changed.seats[1].primary_source_acquisition_targets[0].acquisition_status = "complete";
  changed.seats[2].human_adjudication.reviewer_approvals = "approved";
  const result = validatePersonaV3BuildSpecs(changed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("contains a URL")));
  assert.ok(result.errors.some((error) => error.includes("falsely implies acquired")));
  assert.ok(result.errors.some((error) => error.includes("reviewer approvals must be none")));
});

test("validator rejects catalog drift and paths that leave the repository", () => {
  const changed = structuredClone(inventory);
  [changed.seats[0], changed.seats[1]] = [changed.seats[1], changed.seats[0]];
  changed.seats[2].current_material.prompt_path = "../../outside.md";
  const result = validatePersonaV3BuildSpecs(changed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes("catalog order mismatch")));
  assert.ok(result.errors.some((error) => error.includes("unsafe repository path")));
});

test("build-spec JSON schema is parseable and carries non-production constants", () => {
  const schema = JSON.parse(readFileSync(`${REPO_ROOT}/schemas/persona-v3-build-spec-v1.schema.json`, "utf8"));
  assert.equal(schema.properties.inventory_status.const, "non_production_planning_only");
  assert.equal(schema.properties.seat_count.const, CANONICAL_MASTER_COUNT);
  assert.equal(schema.properties.adjudication_policy.properties.promotion_effect.const, "none");
  assert.equal(schema.$defs.seat.properties.build_status.const, "spec_only");
});

test("report CLI passes its validation gate and can render markdown", () => {
  const check = spawnSync(process.execPath, ["scripts/report-persona-v3-build-specs.mjs", "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, new RegExp(`${CANONICAL_MASTER_COUNT}/${CANONICAL_MASTER_COUNT} specs`));
  assert.match(check.stdout, new RegExp(`${CANONICAL_MASTER_COUNT} pending human review`));
  assert.match(check.stdout, /0 production promotions/);

  const markdown = spawnSync(process.execPath, ["scripts/report-persona-v3-build-specs.mjs", "--markdown"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /Planning-only inventory/);
  assert.match(markdown.stdout, /`master_buffett` \| v2_operator/);
  assert.match(markdown.stdout, /`master_sinclair` \| v1_prompt/);
});
