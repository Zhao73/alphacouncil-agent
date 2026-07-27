import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { councilOptions } from "../../mcp/lib/council-options.mjs";
import { executeDeterministicPersonaPolicy } from "../../mcp/lib/personas-v3/deterministic-executor.mjs";
import { loadSoloTestV3Pack, loadV3Pack } from "../../mcp/lib/personas-v3/loader.mjs";
import {
  loadCompiledPersonaPacks,
  resolveRuntimePersonaBuildProfile,
} from "../../mcp/lib/personas-v3/registry.mjs";
import { buildAnonymousPreDecision } from "../../mcp/lib/personas-v3/runtime.mjs";
import { buildFactPack } from "../../mcp/lib/personas-v3/typed-facts.mjs";
import {
  DEFAULT_SOLO_TEST_PACK_ROOT,
  inspectPersonaV3SoloTestPacks,
  portableRelativePath,
} from "../../scripts/lib/persona-v3-solo-test-packs.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PACKAGE_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
const AS_OF = "2026-07-27";

test("physical pack inventories use canonical slash paths on Windows and POSIX", () => {
  assert.equal(portableRelativePath("ignored", "ignored", {
    relativePath: () => "evaluation/golden_cases.jsonl",
    separator: "/",
  }), "evaluation/golden_cases.jsonl");
  assert.equal(portableRelativePath("ignored", "ignored", {
    relativePath: () => "evaluation\\golden_cases.jsonl",
    separator: "\\",
  }), "evaluation/golden_cases.jsonl");
});

function positiveFactPack(pack) {
  const byFact = new Map();
  for (const tool of pack.components.tools) {
    tool.inputs.forEach((operand, index) => {
      if (typeof operand.fact_id !== "string" || byFact.has(operand.fact_id)) return;
      byFact.set(operand.fact_id, tool.input_contracts[index]);
    });
  }
  const facts = [...byFact].map(([factId, contract]) => ({
    schema_version: 1,
    fact_id: factId,
    value_kind: contract.value_kind,
    value: 1,
    unit: contract.unit,
    currency: null,
    scale: null,
    period_start: null,
    period_end: null,
    fiscal_year: null,
    as_of: AS_OF,
    public_at: AS_OF,
    source_ids: ["synthetic:solo-test"],
    derivation: "reported",
    confidence: 0.9,
    restatement_policy: "frozen snapshot",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  }));
  return buildFactPack(facts, { asOf: AS_OF });
}

test("the packaged solo-test tree is exactly 26 physical operator lenses and 52 provisional tools", () => {
  const report = inspectPersonaV3SoloTestPacks({ packVersion: PACKAGE_VERSION });
  assert.equal(report.summary.ready_for_solo_testing, true);
  assert.equal(report.summary.physical_pack_count, 26);
  assert.equal(report.summary.solo_loader_valid_count, 26);
  assert.equal(report.summary.compiler_valid_count, 26);
  assert.equal(report.summary.provisional_operator_lens_count, 26);
  assert.equal(report.summary.production_loader_rejection_count, 26);
  assert.equal(report.summary.tool_count, 52);
  assert.equal(report.summary.operational_count, 0);
  assert.equal(report.summary.method_model_count, 0);
});
test("production loading rejects a solo-test pack while the explicit provisional loader accepts it", () => {
  const packDir = join(DEFAULT_SOLO_TEST_PACK_ROOT, "master_buffett");
  assert.throws(() => loadV3Pack(packDir), /explicit provisional loader|forbidden in production/u);
  const pack = loadSoloTestV3Pack(packDir);
  assert.equal(pack.manifest.build_profile, "solo_test");
  assert.equal(pack.manifest.identity.maturity, "operator_lens");
  assert.equal(pack.components.sources[0].source_kind, "derived_proxy");
  assert.equal(pack.components.sources[0].adjudication.status, "pending");
  assert.deepEqual(pack.components.sources[0].adjudication.reviewer_ids, []);
  assert.ok(pack.components.tools.every((tool) => tool.assurance_class === "provisional_derived_proxy"));
  assert.ok(pack.components.tools.every((tool) => !("formula_spec_id" in tool) && !("approval_bundle_hash" in tool)));
});

test("runtime build profile exposes all 26 as visibly provisional while formal compilation stays production", () => {
  assert.equal(resolveRuntimePersonaBuildProfile(), "solo_test");
  const formal = loadCompiledPersonaPacks();
  const solo = loadCompiledPersonaPacks({ buildProfile: "solo_test" });
  assert.equal(formal.build_profile, "production");
  assert.equal(solo.build_profile, "solo_test");
  assert.equal(solo.packs.length, 26);
  assert.ok(solo.packs.every((pack) => pack.build_profile === "solo_test"));
  assert.ok(solo.packs.every((pack) => pack.admission.level === "operator_lens"));

  const menu = councilOptions({ language: "中文" });
  assert.equal(menu.masters.filter((master) => master.production_status === "solo_test_provisional").length, 26);
  assert.ok(menu.masters.every((master) => master.provisional === true));
});

test("all-positive provisional proxy inputs execute but can never project constructive", () => {
  const pack = loadCompiledPersonaPacks({ buildProfile: "solo_test" }).get("master_buffett");
  const preDecision = buildAnonymousPreDecision({
    compiledPack: pack,
    factPack: positiveFactPack(pack),
    privateEvidence: [],
  });
  assert.equal(preDecision.eligibility.status, "ready");
  assert.ok(preDecision.anonymous_method_contract.tools.every((tool) => !tool.id.includes("buffett")));
  const execution = executeDeterministicPersonaPolicy(preDecision);
  const result = execution.frozen_decision.structured_decision.result;
  assert.equal(result.common_projection.stance, "cautious");
  assert.notEqual(result.common_projection.stance, "constructive");
  assert.equal(result.score.ratio, 1);
  assert.match(result.native_decision.state, /^provisional_/u);
});
