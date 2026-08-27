import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { validateDeterministicPolicyArtifacts } from "../../mcp/lib/personas-v3/deterministic-executor.mjs";
import { loadCompiledPersonaPacks } from "../../mcp/lib/personas-v3/registry.mjs";
import {
  POLICY_NUMERIC_BASELINE_HASH,
  caseAsOfErrors,
  impersonationHits,
  policySubjectHash,
  provenanceSummary,
  stripPolicyProvenance,
  stripSimulationIdentity,
} from "../../mcp/lib/personas-v3/seat-fidelity.mjs";
import { inspectSeatFidelity } from "../../scripts/check-seat-fidelity.mjs";
import { repoFile } from "../helpers/paths.mjs";

const report = inspectSeatFidelity();
const PARENT_STRIPPED_METHOD_CORPUS_DIGEST = "sha256:74012f92f0f70e574aa40506f8dd82a1dfa20b157ed79ff97a5892e2241d2dd9";
const PARENT_STRIPPED_METHOD_CATALOG_DIGEST = "sha256:a1bc54dd31db51c52a85bc54d8a7c6a8ec33efaab9d3eaffa4fd88b57deeda25";
const METHOD_POLICY_BLOCK = /(## Exact provisional decision policy\n\n```json\n)([\s\S]*?)(\n```\n)/u;

function readJson(relativePath) {
  return JSON.parse(readFileSync(repoFile(relativePath), "utf8"));
}

function strippedMethodReference(text, methodId) {
  let policyBlocks = 0;
  const withoutProvenance = text.replace(METHOD_POLICY_BLOCK, (whole, opening, json, closing) => {
    policyBlocks += 1;
    return `${opening}${JSON.stringify(stripPolicyProvenance(JSON.parse(json)), null, 2)}${closing}`;
  });
  assert.equal(policyBlocks, 1, `${methodId}: expected one exact provisional decision-policy block`);
  return withoutProvenance.split(/\r?\n/u)
    .filter((line) => !/sha256:[a-f0-9]{64}/u.test(line))
    .join("\n")
    .replace(/\n*$/u, "\n");
}

test("all 26 provisional seats satisfy one strict mechanical fidelity template", () => {
  assert.deepEqual(report.errors, []);
  assert.equal(report.assurance, "mechanical_structure_only_not_accuracy_or_profit_evidence");
  assert.equal(report.summary.seat_count, 26);
  assert.equal(report.seats.length, 26);
  assert.ok(report.seats.every((seat) => seat.build_profile === "solo_test"));
  assert.ok(report.seats.every((seat) => seat.maturity === "operator_lens"));
  assert.ok(report.seats.every((seat) => seat.fact_coverage.uncovered === 0));
});

test("216 policy records are explicitly unsourced and the pre-WP-3F policy subject is unchanged", () => {
  assert.equal(report.summary.threshold_records, 216);
  assert.equal(report.summary.sourced_threshold_records, 0);
  assert.equal(report.summary.policy_subject_hash, POLICY_NUMERIC_BASELINE_HASH);
  assert.ok(report.seats.every((seat) => seat.threshold_provenance.structural_unsourced));

  const registry = loadCompiledPersonaPacks({ buildProfile: "solo_test" });
  assert.equal(policySubjectHash(registry.packs.map((pack) => ({
    persona_id: pack.persona_id,
    decision_policy: pack.components.decision_policy,
  }))), POLICY_NUMERIC_BASELINE_HASH);
  for (const pack of registry.packs) {
    const summary = provenanceSummary(pack.components.decision_policy);
    assert.equal(summary.unsourced, Object.values(summary.breakdown).reduce((sum, count) => sum + count, 0));
    assert.equal(summary.sourced, 0);
  }
});

test("JSON Schema and dependency-free runtime validation agree on provenance mutations", () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true, allErrors: true });
  const validate = ajv.compile(readJson("schemas/persona-v3-decision-policy-v1.schema.json"));
  const pack = loadCompiledPersonaPacks({ buildProfile: "solo_test" }).get("master_buffett");
  const policy = structuredClone(pack.components.decision_policy);
  assert.equal(validate(policy), true, JSON.stringify(validate.errors));

  policy.scoring.rules[0].provenance = {
    status: "sourced",
    source_id: "",
  };
  assert.equal(validate(policy), false);
  const errors = validateDeterministicPolicyArtifacts({
    policy,
    tools: pack.components.tools,
    requiredFactTypes: pack.manifest.capability.required_fact_types,
    optionalFactTypes: pack.manifest.capability.optional_fact_types,
    pipeline: pack.manifest.computation.pipeline,
    dslVersion: pack.manifest.computation.dsl_version,
    nativeDecisionSchema: pack.manifest.capability.native_decision_schema,
  });
  assert.ok(errors.some((error) => error.includes("provenance.source_id")));
});

test("all required and eligibility single-fact ablations fail closed at the seat boundary", () => {
  assert.equal(report.summary.ablation_targets, 118);
  assert.equal(report.summary.ablation_out_of_scope, 118);
  assert.ok(report.seats.every((seat) => (
    seat.ablations.individual_target_count === seat.ablations.individual_out_of_scope_count
      && seat.ablations.all_targets_out_of_scope
  )));
});

test("34 vetoes reach their real executor branch and three root dynamic comparisons stay explicit pending work", () => {
  assert.equal(report.summary.hard_vetoes, 37);
  assert.equal(report.summary.vetoes_mechanically_triggered, 34);
  assert.equal(report.summary.vetoes_pending_nonliteral, 3);
  assert.deepEqual(report.seats.flatMap((seat) => seat.hard_vetoes.pending_ids).sort(), [
    "master_bogle.expected_return_below_inflation",
    "master_sinclair.edge_dies_in_the_spread",
    "master_thorp.edge_inside_the_friction",
  ]);
});

test("all 52 local-test derivation specs remain hash-bound to their physical tools", () => {
  const bindings = report.seats.flatMap((seat) => seat.derivation_bindings);
  assert.equal(bindings.length, 52);
  assert.equal(new Set(bindings.map((binding) => binding.tool_id)).size, 52);
  assert.equal(new Set(bindings.map((binding) => binding.derivation_spec_id)).size, 52);
  assert.ok(bindings.every((binding) => /^sha256:[a-f0-9]{64}$/u.test(binding.derivation_spec_hash)));
  assert.ok(bindings.every((binding) => /^sha256:[a-f0-9]{64}$/u.test(binding.derivation_evidence_hash)));
});

test("AI machine simulations change identity only and keep the n-eff disclosure byte-identical", () => {
  assert.deepEqual(report.ai_simulations, {
    artifact_count: 11,
    errors: [],
    identity_drift_count: 10,
    n_eff_disclosure_byte_identical: true,
    semantic_equal_count: 11,
    valid: true,
  });
});

test("generated method references change only provenance blocks and bound identity hashes", () => {
  const relativeRoot = "skills/alphacouncil-method-lenses/references";
  const methods = readdirSync(repoFile(`${relativeRoot}/methods`))
    .filter((name) => name.endsWith(".md"))
    .sort();
  assert.equal(methods.length, 26);
  const strippedHashes = methods.map((name) => sha256(strippedMethodReference(
    readFileSync(repoFile(`${relativeRoot}/methods/${name}`), "utf8"),
    name,
  ))).sort();
  assert.equal(sha256(strippedHashes), PARENT_STRIPPED_METHOD_CORPUS_DIGEST);

  const catalog = readJson(`${relativeRoot}/catalog.v1.json`);
  assert.equal(
    sha256(stripSimulationIdentity(catalog)),
    PARENT_STRIPPED_METHOD_CATALOG_DIGEST,
  );
});

test("empty evaluation files stay truthfully empty and future rows require point-in-time labels", () => {
  assert.deepEqual({
    cases: report.summary.cases,
    golden: report.summary.golden_cases,
    pairwise: report.summary.pairwise_cases,
    calibration: report.summary.calibration_cases,
    unlabeled: report.summary.unlabeled_cases,
  }, { cases: 0, golden: 0, pairwise: 0, calibration: 0, unlabeled: 0 });

  assert.deepEqual(caseAsOfErrors([{
    case_id: "case.valid",
    case_as_of: "2026-07-27",
    label_as_of: "2026-07-28",
    expected_stance: "cautious",
    evidence: [{ public_at: "2026-07-26" }],
  }], { kind: "golden" }), []);
  assert.match(caseAsOfErrors([{
    case_id: "case.leaked-label",
    case_as_of: "2026-07-27",
    label_as_of: "2026-07-27",
    expected_stance: "cautious",
  }], { kind: "golden" })[0], /label_as_of: must be later/u);
  assert.deepEqual(caseAsOfErrors([{
    case_id: "case.unlabeled",
    case_as_of: "2026-07-27",
    evidence: [{ public_at: "2026-07-26" }],
  }], { kind: "golden" }), []);
  assert.match(caseAsOfErrors([{
    case_id: "case.future",
    case_as_of: "2026-07-27",
    label_as_of: "2026-07-29",
    expected_stance: "cautious",
    evidence: [{ known_at: "2026-07-28" }],
  }], { kind: "golden" })[0], /exceeds case_as_of/u);
  assert.match(caseAsOfErrors([{ case_id: "case.unbounded" }])[0], /case_as_of/u);
});

test("impersonation lint rejects biography, quotation, holdings and named-identity claims", () => {
  const config = readJson("data/impersonation-lint.v1.json");
  assert.ok(impersonationHits("I am Warren Buffett and my current portfolio owns TEST.", config, {
    identities: ["Warren Buffett"],
  }).length >= 2);
  assert.ok(impersonationHits("我曾经说过这是我的当前持仓。", config).length >= 2);
  assert.equal(report.summary.impersonation_hits, 0);
  assert.ok(report.seats.every((seat) => seat.voice_safety.directional_abstention_rejected));
  assert.ok(report.seats.every((seat) => (
    seat.voice_safety.disclosure_prefix.startsWith("AI simulation of the ")
      && seat.voice_safety.threshold_disclosure.startsWith("thresholds: ")
  )));
});
