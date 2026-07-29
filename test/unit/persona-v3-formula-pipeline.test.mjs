import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { deterministicToolSchemaHashes } from "../../mcp/lib/personas-v3/deterministic-executor.mjs";
import {
  FORMULA_AUTHORING_STATUS,
  COMPILED_FORMULA_DIRNAME,
  FORMULA_CANDIDATE_DIRNAME,
  compileApprovedFormulaSpec,
  compileApprovedFormulaSpecs,
  formulaReviewSubjectHash,
  planPersonaV3FormulaPipeline,
  planApprovedFormulaCompilation,
  validateFormulaSpec,
  writePersonaV3FormulaCandidates,
  writeApprovedFormulaCompilation,
} from "../../scripts/lib/persona-v3-formula-pipeline.mjs";
import {
  SOLO_TEST_FORMULA_DIRNAME,
  planSoloTestFormulaCompilation,
  writeSoloTestFormulaCompilation,
} from "../../scripts/lib/persona-v3-solo-formula-pipeline.mjs";
import { REPO_ROOT } from "../../scripts/lib/persona-v3-build-specs.mjs";
import {

  TRUSTED_FORMULA_REVIEW_KEYS,
  TEST_FORMULA_REVIEWERS,
  approvedFormulaSpec,
  installAllFormulaCandidates,
  signedFormulaApprovalBundle,
} from "../helpers/persona-v3-formula-review-evidence.mjs";
import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { PLANNED_TOOL_COUNT } from "../../data/persona-v3-build-specs.v1.mjs";

/** One `components/tools.json` per seat, plus the single compilation manifest. */
const PLANNED_SEAT_TOOL_FILES = CANONICAL_MASTER_COUNT + 1;

const EXECUTABLE_OPERATIONS = new Set([
  "identity", "add", "subtract", "multiply", "divide",
  "sum", "mean", "min", "max", "abs", "negate", "clamp",
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundPrototype(spec) {
  return JSON.parse(readFileSync(join(REPO_ROOT, spec.prototype_provenance.source_path), "utf8"));
}

function approvedFixture() {
  return approvedFormulaSpec();
}

function compileOptions(spec, prototypeDocument = boundPrototype(spec)) {
  return {
    prototypeDocument,
    approvalBundle: signedFormulaApprovalBundle(spec),
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  };
}

test("builds an exact one-per-tool fail-closed authoring inventory across every canonical seat", () => {
  const plan = planPersonaV3FormulaPipeline();
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.inventory.canonical_seat_count, CANONICAL_MASTER_COUNT);
  assert.equal(plan.inventory.prototype_count, PLANNED_TOOL_COUNT);
  assert.equal(plan.inventory.needs_formula_authorship_count, PLANNED_TOOL_COUNT);
  assert.equal(plan.inventory.executable_candidate_count, 0);
  assert.equal(plan.inventory.dedicated_tool_count, 0);
  assert.equal(new Set(plan.inventory.entries.map((entry) => entry.persona_id)).size, CANONICAL_MASTER_COUNT);
  assert.equal(new Set(plan.inventory.entries.map((entry) => entry.prototype_id)).size, PLANNED_TOOL_COUNT);
  assert.deepEqual(new Set(plan.inventory.entries.map((entry) => entry.artifact_status)), new Set([FORMULA_AUTHORING_STATUS]));
  for (const entry of plan.inventory.entries) {
    assert.equal(entry.formula_spec.formula, null, entry.prototype_id);
    assert.equal(entry.formula_spec.provenance, null, entry.prototype_id);
    assert.equal(entry.formula_spec.review.status, "pending_human_adjudication", entry.prototype_id);
    assert.equal(entry.formula_spec.production_effect, "none", entry.prototype_id);
    assert.ok(entry.blocking_reasons.includes("input_and_output_units_are_unresolved"), entry.prototype_id);
    assert.ok(entry.blocking_reasons.includes("period_basis_window_and_alignment_are_unresolved"), entry.prototype_id);
    assert.deepEqual(entry.validation_errors, [], entry.prototype_id);
  }
});

test("preserves cross-seat and within-seat prototype differences in the authoring queue", () => {
  const entries = planPersonaV3FormulaPipeline().inventory.entries;
  const bySeat = new Map();
  for (const entry of entries) {
    const request = entry.formula_spec.authorship_request;
    const signature = JSON.stringify({
      family: request.operation_family,
      inputs: request.candidate_input_fact_types,
      outputs: request.candidate_output_fact_types,
      steps: request.computation_steps,
    });
    const values = bySeat.get(entry.persona_id) || [];
    values.push(signature);
    bySeat.set(entry.persona_id, values);
  }
  assert.equal(bySeat.size, CANONICAL_MASTER_COUNT);
  for (const [personaId, signatures] of bySeat) {
    assert.equal(signatures.length, 2, personaId);
    assert.notEqual(signatures[0], signatures[1], personaId);
  }
  assert.equal(new Set([...bySeat.values()].map((pair) => JSON.stringify(pair))).size, CANONICAL_MASTER_COUNT);
});

test("pending formulas or formulas without a matching review-subject hash cannot compile", () => {
  const pending = planPersonaV3FormulaPipeline().inventory.entries[0].formula_spec;
  assert.throws(() => compileApprovedFormulaSpec(pending), /fails closed/u);

  const unbound = approvedFixture();
  unbound.review.review_subject_hash = null;
  assert.match(validateFormulaSpec(unbound).join("\n"), /review_subject_hash/u);
  assert.throws(() => compileApprovedFormulaSpec(unbound, { prototypeDocument: boundPrototype(unbound) }), /invalid or unapproved/u);
});

test("a content-bound exact formula compiles purely to a hashed DSL 1.1 tool", () => {
  const spec = approvedFixture();
  const snapshot = JSON.stringify(spec);
  assert.deepEqual(validateFormulaSpec(spec), []);
  const prototypeDocument = boundPrototype(spec);
  const first = compileApprovedFormulaSpec(spec, compileOptions(spec, prototypeDocument));
  const second = compileApprovedFormulaSpec(spec, compileOptions(spec, prototypeDocument));
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(spec), snapshot, "compiler must not mutate the reviewed spec");
  assert.equal(first.dsl_version, "1.1");
  assert.equal(first.id, spec.tool_id);
  assert.equal(first.operation, "identity");
  assert.deepEqual(first.inputs, spec.formula.inputs.map((input) => input.operand));
  assert.deepEqual(first.input_contracts, spec.formula.inputs.map(({ operand: _operand, ...contract }) => contract));
  assert.equal(first.output_id, spec.formula.output.output_id);
  assert.equal(first.unit, spec.formula.output.unit);
  assert.deepEqual(first.output_period, spec.formula.output.period);
  assert.deepEqual(
    { input_schema_hash: first.input_schema_hash, output_schema_hash: first.output_schema_hash },
    deterministicToolSchemaHashes(first),
  );
  assert.equal("review" in first, false);
  assert.equal("production_effect" in first, false);
  assert.deepEqual(compileApprovedFormulaSpecs([spec], {
    prototypeDocuments: { [spec.prototype_provenance.source_path]: prototypeDocument },
    approvalBundles: { [spec.formula_spec_id]: signedFormulaApprovalBundle(spec) },
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  }), [first]);
});

test("formula contract drift or post-review tampering invalidates compilation", () => {
  const mismatch = approvedFixture();
  mismatch.formula.inputs[0].on_missing = "skip";
  mismatch.review.review_subject_hash = formulaReviewSubjectHash(mismatch);
  assert.match(validateFormulaSpec(mismatch).join("\n"), /must equal formula.on_missing/u);

  const invalidPeriod = approvedFixture();
  invalidPeriod.formula.output.period = { basis: "duration", window: null, alignment: "same_period" };
  invalidPeriod.review.review_subject_hash = formulaReviewSubjectHash(invalidPeriod);
  assert.match(validateFormulaSpec(invalidPeriod).join("\n"), /window: is required/u);

  const tampered = approvedFixture();
  tampered.formula.output.unit = "tampered_units";
  assert.match(validateFormulaSpec(tampered).join("\n"), /review_subject_hash/u);

  const spec = approvedFixture();
  const wrongPrototype = { ...boundPrototype(spec), persona_id: "master_wrong" };
  assert.throws(
    () => compileApprovedFormulaSpec(spec, compileOptions(spec, wrongPrototype)),
    /not bound to the current source prototype/u,
  );
});

test("explicit writer emits only one spec per tool plus one inventory below an isolated staging root", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-formulas-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outputRoot = join(dir, "knowledge", "staging", "persona-v3-formula-candidates");
  const first = writePersonaV3FormulaCandidates({ outputRoot });
  assert.equal(first.written.length, PLANNED_TOOL_COUNT + 1); // one spec per tool, plus the inventory
  assert.equal(first.unchanged.length, 0);
  assert.equal(existsSync(join(outputRoot, "authoring-inventory.json")), true);
  assert.equal(existsSync(join(outputRoot, "manifest.json")), false);
  const second = writePersonaV3FormulaCandidates({ outputRoot });
  assert.equal(second.written.length, 0);
  assert.equal(second.unchanged.length, PLANNED_TOOL_COUNT + 1);
});

test("the real approved-candidate path verifies and emits exactly one per planned tool tools with one preserved bundle each", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-approved-formulas-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const candidateRoot = join(dir, "staging", FORMULA_CANDIDATE_DIRNAME);
  const outputRoot = join(dir, "staging", COMPILED_FORMULA_DIRNAME);
  const records = installAllFormulaCandidates(candidateRoot);
  assert.equal(records.length, PLANNED_TOOL_COUNT);

  const plan = planApprovedFormulaCompilation({
    candidateRoot,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  });
  assert.equal(plan.compiled_tool_count, PLANNED_TOOL_COUNT);
  assert.equal(plan.formula_approval_binding_count, PLANNED_TOOL_COUNT);
  assert.equal(new Set(plan.tool_ids).size, PLANNED_TOOL_COUNT);
  assert.ok(plan.tools.every((tool) => tool.formula_spec_hash && tool.approval_bundle_hash));

  const written = writeApprovedFormulaCompilation({
    candidateRoot,
    outputRoot,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  });
  assert.equal(written.compiled_tool_count, PLANNED_TOOL_COUNT);
  assert.equal(written.formula_approval_binding_count, PLANNED_TOOL_COUNT);
  assert.equal(written.written.length, PLANNED_TOOL_COUNT + PLANNED_SEAT_TOOL_FILES); // per-seat tool files plus one compilation manifest
  assert.equal(existsSync(join(outputRoot, "compilation-manifest.json")), true);

  const keysFile = join(dir, "formula-review-keys.json");
  writeFileSync(keysFile, `${JSON.stringify(Object.fromEntries(TEST_FORMULA_REVIEWERS.map((reviewer) => [
    reviewer.key_id,
    {
      public_key: reviewer.publicKey.export({ type: "spki", format: "pem" }),
      principal_id: reviewer.principal_id,
      purposes: ["formula_review"],
    },
  ])), null, 2)}\n`);
  const cli = spawnSync(process.execPath, [
    "scripts/compile-persona-v3-formulas.mjs", "--compile-approved",
    "--candidate-root", candidateRoot,
    "--trusted-formula-reviewer-keys", keysFile,
  ], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`tools=${PLANNED_TOOL_COUNT}/${PLANNED_TOOL_COUNT}`, "u"));
  assert.match(cli.stdout, new RegExp(`formula_approvals=${PLANNED_TOOL_COUNT}/${PLANNED_TOOL_COUNT}`, "u"));

  unlinkSync(join(candidateRoot, "approvals", records[0].entry.persona_id,
    `${records[0].entry.tool_id.slice(records[0].entry.persona_id.length + 1)}.approval-bundle.json`));
  assert.throws(() => planApprovedFormulaCompilation({
    candidateRoot,
    trustedFormulaReviewerKeys: TRUSTED_FORMULA_REVIEW_KEYS,
    now: new Date("2026-07-27T12:00:00.000Z"),
  }), /candidate file is missing/u);
});

test("solo-test compilation derives the executable tools without inventing formula approvals", () => {
  const plan = planSoloTestFormulaCompilation();
  assert.equal(plan.artifact_kind, "persona_v3_solo_test_formula_compilation");
  assert.equal(plan.assurance_class, "provisional_derived_proxy");
  assert.equal(plan.review_status, "not_human_reviewed");
  assert.equal(plan.intended_use, "local_test_only");
  assert.equal(plan.canonical_seat_count, CANONICAL_MASTER_COUNT);
  assert.equal(plan.compiled_tool_count, PLANNED_TOOL_COUNT);
  assert.equal(plan.provisional_derivation_count, PLANNED_TOOL_COUNT);
  assert.equal(plan.formula_approval_binding_count, 0);
  assert.equal(plan.human_reviewer_count, 0);
  assert.equal(plan.signature_count, 0);
  assert.equal(plan.production_eligible, false);
  assert.equal(plan.method_model_eligible, false);
  assert.equal(new Set(plan.tools.map((tool) => tool.id)).size, PLANNED_TOOL_COUNT);
  assert.equal(new Set(plan.tools.map((tool) => tool.output_id)).size, PLANNED_TOOL_COUNT);
  for (const tool of plan.tools) {
    assert.equal(tool.assurance_class, "provisional_derived_proxy");
    assert.equal(tool.review_status, "not_human_reviewed");
    assert.equal(tool.production_eligible, false);
    // Authoring replaced the identity placeholder with the method's own arithmetic, so what
    // has to hold is that the operation is one the executor implements -- not that it is the
    // one that computes nothing.
    assert.ok(EXECUTABLE_OPERATIONS.has(tool.operation), `unknown operation ${tool.operation}`);
    assert.equal("formula_spec_id" in tool, false);
    assert.equal("formula_review_subject_hash" in tool, false);
    assert.equal("approval_bundle_hash" in tool, false);
    assert.deepEqual(
      { input_schema_hash: tool.input_schema_hash, output_schema_hash: tool.output_schema_hash },
      deterministicToolSchemaHashes(tool),
    );
  }
  const optionTool = plan.tools
    .find((tool) => (tool.inputs || []).some((input) => input.fact_id === "options.implied_volatility"));
  assert.ok(optionTool);
  assert.deepEqual(optionTool.output_period, { basis: "instant", window: null, alignment: "as_of" });
  // A fact the grounding adapter now produces binds to its real contract; only a fact nothing
  // generates still falls back to the fail-closed proxy scalar.
  // Bound by the fact a tool reads rather than by its name: an authored method names its own
  // steps, so a pinned tool id here would only detect renames.
  const contractFor = (factId) => plan.tools
    .flatMap((tool) => (tool.inputs || []).map((operand, index) => [operand, tool.input_contracts[index]]))
    .find(([operand]) => operand?.fact_id === factId)?.[1];
  // A fact the grounding adapter produces binds to its declared contract.
  assert.equal(contractFor("financial.owner_earnings").value_kind, "monetary");
  assert.equal(contractFor("financial.owner_earnings").unit, "currency_units");
  // Stronger than the old fallback check, and now true: every authored tool reads a fact the
  // grounding adapter declares, so none of them silently binds the fail-closed proxy scalar.
  // A tool on that placeholder contract can never execute against real grounding.
  const onProxyContract = plan.tools.flatMap((tool) => (tool.inputs || [])
    .map((operand, index) => ({ tool: tool.id, fact: operand.fact_id, contract: tool.input_contracts[index] }))
    .filter((entry) => entry.fact && entry.contract.unit === "derived_proxy_scalar"));
  assert.deepEqual(onProxyContract, [], `tools bound to an undeclared fact: ${JSON.stringify(onProxyContract)}`);
  for (const evidence of plan.evidence) {
    assert.equal(evidence.human_reviewer_ids.length, 0);
    assert.equal(evidence.signature_count, 0);
    assert.equal(evidence.production_eligible, false);
    // An authored formula drops the identity-proxy claim, which would be false of it, and
    // says what it actually is. Neither kind has been reviewed by a human.
    assert.ok(
      evidence.limitations.includes("mechanical_identity_proxy_not_the_named_investor_method")
      || evidence.limitations.includes("ai_authored_candidate_formula_not_human_reviewed"),
    );
    assert.ok(evidence.limitations.includes("no_human_formula_review_or_cryptographic_approval_exists"));
  }
});

test("solo-test writer stays isolated and CLI reports zero approvals", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-solo-formulas-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outputRoot = join(dir, "staging", SOLO_TEST_FORMULA_DIRNAME);
  const first = writeSoloTestFormulaCompilation({ outputRoot });
  assert.equal(first.written.length, PLANNED_TOOL_COUNT + PLANNED_SEAT_TOOL_FILES);
  assert.equal(first.unchanged.length, 0);
  assert.equal(first.compiled_tool_count, PLANNED_TOOL_COUNT);
  assert.equal(first.formula_approval_binding_count, 0);
  assert.equal(existsSync(join(outputRoot, "compilation-manifest.json")), true);
  assert.equal(existsSync(join(outputRoot, "master_buffett", "components", "tools.json")), true);
  assert.equal(existsSync(join(outputRoot, "master_buffett", "formula-approvals")), false);
  const second = writeSoloTestFormulaCompilation({ outputRoot });
  assert.equal(second.written.length, 0);
  assert.equal(second.unchanged.length, PLANNED_TOOL_COUNT + PLANNED_SEAT_TOOL_FILES);

  const cli = spawnSync(process.execPath, [
    "scripts/compile-persona-v3-formulas.mjs",
    "--compile-solo-test",
  ], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`tools=${PLANNED_TOOL_COUNT}/${PLANNED_TOOL_COUNT}`, "u"));
  assert.match(cli.stdout, new RegExp(`formula_approvals=0/${PLANNED_TOOL_COUNT}`, "u"));
  assert.match(cli.stdout, /assurance=provisional_derived_proxy/u);
  assert.match(cli.stdout, /production_eligible=false/u);
});

test("formula schema is exact and CLI is plan-only unless --write is explicit", (t) => {
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas/persona-v3-formula-spec-v1.schema.json"), "utf8"));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.dsl_target.const, "1.1");
  assert.equal(schema.properties.production_effect.const, "none");
  assert.ok(schema.required.includes("provenance"));
  assert.ok(schema.required.includes("review"));
  assert.ok(schema.required.includes("prototype_provenance"));
  assert.ok(schema.$defs.review.required.includes("review_subject_hash"));

  const dir = mkdtempSync(join(tmpdir(), "alphacouncil-formula-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outputRoot = join(dir, "staging", "persona-v3-formula-candidates");
  const args = ["scripts/compile-persona-v3-formulas.mjs", "--output-root", outputRoot];
  const plan = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, new RegExp(`prototypes=${PLANNED_TOOL_COUNT}/${PLANNED_TOOL_COUNT}`));
  assert.match(plan.stdout, new RegExp(`needs_authorship=${PLANNED_TOOL_COUNT}`));
  assert.match(plan.stdout, /executable_candidates=0/);
  assert.equal(existsSync(outputRoot), false);

  const write = spawnSync(process.execPath, [...args, "--write"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.equal(write.status, 0, write.stderr);
  assert.equal(existsSync(join(outputRoot, "authoring-inventory.json")), true);
});
