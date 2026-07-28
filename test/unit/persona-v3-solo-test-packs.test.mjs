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
import { portableRelativePath } from "../../mcp/lib/personas-v3/canonical.mjs";
import { MASTER_SELECTOR_BEST_FOR_LOCALES } from "../../data/master-selector-method-locales.v1.mjs";
import {
  DEFAULT_SOLO_TEST_PACK_ROOT,
  inspectPersonaV3SoloTestPacks,
} from "../../scripts/lib/persona-v3-solo-test-packs.mjs";
import { resolvePersonaPackVersion } from "../../scripts/lib/build-profile.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PERSONA_PACK_VERSION = resolvePersonaPackVersion(REPO_ROOT);
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
  // Built from what the seat DECLARES it reads, not only from its tool inputs. An authored
  // policy deliberately gates eligibility on a fact that is not a tool input, so a pack made
  // of tool inputs alone leaves every such seat correctly but uselessly out of scope.
  const byFact = new Map();
  for (const tool of pack.components.tools) {
    tool.inputs.forEach((operand, index) => {
      if (typeof operand.fact_id !== "string" || byFact.has(operand.fact_id)) return;
      byFact.set(operand.fact_id, tool.input_contracts[index]);
    });
  }
  const declared = [
    ...(pack.manifest.capability.required_fact_types || []),
    ...(pack.manifest.capability.optional_fact_types || []),
  ];
  for (const factId of declared) {
    if (!byFact.has(factId)) byFact.set(factId, { value_kind: "ratio", unit: "decimal" });
  }
  const facts = [...byFact].map(([factId, contract]) => ({
    schema_version: 1,
    fact_id: factId,
    value_kind: contract.value_kind,
    value: 1,
    unit: contract.unit,
    // A monetary contract carries a currency and a scale; the tools that read filing amounts
    // declare one now that those facts have real contracts instead of a proxy scalar.
    currency: contract.value_kind === "monetary" ? "USD" : null,
    scale: contract.value_kind === "monetary" ? 1 : null,
    ...(contract.value_kind === "ratio" ? { ratio_denominator: "synthetic_denominator" } : {}),
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
  const report = inspectPersonaV3SoloTestPacks({ packVersion: PERSONA_PACK_VERSION });
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

test("the PersonaPack JSON Schema requires four reader locales conditionally for solo-test manifests", () => {
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, "schemas/persona-v3.schema.json"), "utf8"));
  const conditional = schema.allOf?.find((entry) => entry.if?.properties?.build_profile?.const === "solo_test");
  assert.ok(conditional, "solo_test must have an explicit JSON Schema condition");
  assert.deepEqual(conditional.if.required, ["build_profile"]);

  const identity = conditional.then?.properties?.identity?.properties;
  const selection = conditional.then?.properties?.selection?.properties;
  for (const field of [identity?.public_label, identity?.operator_label,
    selection?.identity, selection?.method, selection?.best_for]) {
    assert.equal(field?.$ref, "#/$defs/localizedTextFourLocales");
  }
  assert.deepEqual(
    schema.$defs.localizedTextFourLocales.allOf.at(-1).required,
    ["en", "zh", "ja", "ko"],
  );
});

test("all 26 physical selector manifests carry distinct Chinese plus Japanese and Korean copy", () => {
  const scripts = { zh: /\p{Script=Han}/u, ja: /[\p{Script=Hiragana}\p{Script=Katakana}]/u, ko: /\p{Script=Hangul}/u };
  const ids = loadCompiledPersonaPacks({ buildProfile: "solo_test" }).ids();
  assert.deepEqual(Object.keys(MASTER_SELECTOR_BEST_FOR_LOCALES).sort(), [...ids].sort());
  for (const id of ids) {
    const pack = loadSoloTestV3Pack(join(DEFAULT_SOLO_TEST_PACK_ROOT, id));
    for (const field of ["public_label", "operator_label"]) {
      const value = pack.manifest.identity[field];
      for (const [locale, script] of Object.entries(scripts)) assert.match(value[locale], script, `${id}.${field}.${locale}`);
    }
    for (const field of ["identity", "method", "best_for"]) {
      const value = pack.manifest.selection[field];
      for (const [locale, script] of Object.entries(scripts)) assert.match(value[locale], script, `${id}.selection.${field}.${locale}`);
    }
    for (const locale of ["en", "zh", "ja", "ko"]) {
      const bestFor = pack.manifest.selection.best_for[locale];
      assert.doesNotMatch(bestFor, /[a-z0-9]+(?:_[a-z0-9]+)+/iu, `${id}.selection.best_for.${locale} leaks a machine domain id`);
      assert.equal(bestFor, MASTER_SELECTOR_BEST_FOR_LOCALES[id][locale]);
    }
    assert.ok(pack.manifest.capability.domains.every((domain) => /^[a-z0-9_]+$/u.test(domain)), `${id} must retain stable machine domain ids separately`);
    assert.notEqual(pack.manifest.selection.method.zh, pack.manifest.selection.method.en, `${id} Chinese method must not copy English`);
  }
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
  for (const language of ["English", "中文", "日本語", "한국어"]) {
    const localizedMenu = councilOptions({ language });
    assert.equal(localizedMenu.masters.length, 26);
    assert.ok(localizedMenu.masters.every((master) => master.maturity_label));
  }
});

// An identity proxy could only ever reject or abstain: successful arithmetic over a
// placeholder must never read as a recommendation. An authored seat is different by design --
// a method that cannot say yes is not a method. What must not change is the assurance
// boundary, so that is what this now pins.
test("an authored seat decides on a full fact pack without gaining production standing", () => {
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
  // Every fact set to one satisfies an identity proxy trivially and satisfies a real method
  // only where its comparison happens to hold, so the ratio is whatever the method computes.
  // What matters is that it computed rather than abstained.
  assert.ok(result.score.ratio >= 0 && result.score.ratio <= 1);
  assert.ok(["constructive", "cautious", "opposed"].includes(result.common_projection.stance));
  assert.notEqual(result.common_projection.stance, "out_of_scope");
  assert.match(result.native_decision.state, /^provisional_/u);
  // The seat may now recommend; it still may not claim to be validated.
  assert.equal(pack.admission.level, "operator_lens");
  assert.equal(pack.maturity, "operator_lens");
  assert.equal(pack.build_profile, "solo_test");
});
