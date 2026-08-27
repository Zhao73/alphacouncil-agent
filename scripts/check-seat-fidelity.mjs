#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { renderMasterMarkdown } from "../mcp/lib/markdown.mjs";
import { normalizeMasterVoice } from "../mcp/lib/packets.mjs";
import { completedMasterOpinion, declinedMasterOpinion, planMasterSeats } from "../mcp/lib/personas/engine.mjs";
import { canonicalValue, sha256 } from "../mcp/lib/personas-v3/canonical.mjs";
import { executeDeterministicPersonaPolicy } from "../mcp/lib/personas-v3/deterministic-executor.mjs";
import { loadFactProducerCatalog } from "../mcp/lib/personas-v3/fact-producer-catalog.mjs";
import { loadCompiledPersonaPacks } from "../mcp/lib/personas-v3/registry.mjs";
import { buildAnonymousPreDecision, technicalIdReadableMap } from "../mcp/lib/personas-v3/runtime.mjs";
import {
  POLICY_NUMERIC_BASELINE_HASH,
  caseAsOfErrors,
  caseIsLabeled,
  factIdsIn,
  impersonationHits,
  policySubjectHash,
  provenanceSummary,
  rootNonliteralComparison,
  stripPolicyProvenance,
  stripSimulationIdentity,
  thresholdDisclosure,
  validateDerivationBindings,
  validateImpersonationLintConfig,
} from "../mcp/lib/personas-v3/seat-fidelity.mjs";
import { buildFactPack } from "../mcp/lib/personas-v3/typed-facts.mjs";
import {
  FIRST_PERSON_DISCLOSURE_ACK,
  FIRST_PERSON_VOICE_MODE,
} from "../mcp/lib/voice.mjs";
import {
  DEFAULT_SOLO_TEST_PACK_ROOT,
  inspectPersonaV3SoloTestPacks,
} from "./lib/persona-v3-solo-test-packs.mjs";
import { resolvePersonaPackVersion } from "./lib/build-profile.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const AS_OF = "2026-07-27";
const EXPECTED_SEATS = 26;
const EXPECTED_TOOLS = 52;
const EXPECTED_POLICY_RECORDS = 216;
const EXPECTED_PENDING_ROOT_NONLITERAL = 3;
const FORMULA_MANIFEST = join(
  REPO_ROOT,
  "knowledge/solo-test/persona-v3-solo-test-formulas/compilation-manifest.json",
);
const IMPERSONATION_CONFIG = join(REPO_ROOT, "data/impersonation-lint.v1.json");
const NO_PRODUCER_ACKNOWLEDGEMENT = join(
  REPO_ROOT,
  "data/typed-fact-no-producer-acknowledged.v1.json",
);
const POLICY_SCHEMA = join(REPO_ROOT, "schemas/persona-v3-decision-policy-v1.schema.json");
const TEMPLATE_SCHEMA = join(REPO_ROOT, "schemas/persona-v3-seat-template-v1.schema.json");
const AI_SIMULATION_ROOT = join(REPO_ROOT, "knowledge/ai-assisted-solo/experiments");
const AI_SIMULATION_PARENT_SNAPSHOT = Object.freeze({
  "simulation-input.json": {
    semantic_hash: "sha256:da67a5acccc9ff743a135f598fe68c04839fbf028ed42b56e73f818129c475ce",
    byte_hash: "sha256:fe8a611dcdd8c0fbca8dd3129c8ec725af38600a13a7873646922d830d6cbe94",
  },
  "simulation-manifest.json": {
    semantic_hash: "sha256:2330315aa0732a67ab2c26171febbad0f107589988881a6b240f591ad4cab18d",
    byte_hash: "sha256:be6d7975b850c9bb43542221c29a547bf59e5e66e784ab6365fe28545927d22b",
  },
  "n-eff-disclosure.json": {
    semantic_hash: "sha256:d4bd6d8200f62314e6e56cf7d8f0270cc40f876df2e669d0760759e0d1cfb6bc",
    byte_hash: "sha256:5edd131c1206819e3a172317ceb89ea8588248cc3b24658357f92822448f026a",
  },
  "runs/a.json": {
    semantic_hash: "sha256:46fe4559702b4c004df7e14d9f64ea81b3ca19589f09e0cbec74d5d68455d3b1",
    byte_hash: "sha256:53e6f02ab61a790ed45f033e5348f4cbca07900f4d54cf77e108e70827b51d27",
  },
  "runs/b.json": {
    semantic_hash: "sha256:08b68044ac37bcc19ecaabfcdeac315d3d78961b893837683f4ee391253d30c6",
    byte_hash: "sha256:7922b5552409c790d18eb89f25199c9ff52030167454ac09d2d73b868d123f23",
  },
  "runs/c.json": {
    semantic_hash: "sha256:bd6be2820d0e027ee570e77d91a21c81db1e5c241108f1765e398dd02fcdc24b",
    byte_hash: "sha256:fe927c0fd675c36707ca16467b6cc289fd4ce7de0efc71fa3325de3233bc7afe",
  },
  "runs/d13.json": {
    semantic_hash: "sha256:c0877f8658aabdf727daa190f54c84d506f322382321c24d1980f96cbc7f22ec",
    byte_hash: "sha256:f8e3a485bd3ad8f46e280980128fb9ffbaf53ede03c49b0cf1b6ff178b6861cf",
  },
  "runs/d26.json": {
    semantic_hash: "sha256:98e9852c18f9a9c8d525eaac066bdb63348ff2851d88bd24801e445e3e9f6221",
    byte_hash: "sha256:24a59794dc4fa95c8d7e0d594238bb52bedd9c6015055a73ed8bfa54a708d7d3",
  },
  "runs/e-d13.json": {
    semantic_hash: "sha256:0cd95adbd8308322404ba1a20c62377207c31f6a29cc5e4347c2b342a3b46030",
    byte_hash: "sha256:5e397bddefb07c03d3cf7888f0167b208a0640bf71d3cd4c0202bed23c2fd6dc",
  },
  "runs/e-d26.json": {
    semantic_hash: "sha256:cd10b65a305ad3fc951656e8f9e52d3eb63acf0d2187422bd255cce9415dbad3",
    byte_hash: "sha256:798a2879c2ee54925dbdc11da642239895bf1b4ac276377e64a9d9d24b393d83",
  },
  "runs/h_ai_reference.json": {
    semantic_hash: "sha256:7e2f8356917ac673f6caf564d82a607502143dbf09f14f70aa36ecc731d09203",
    byte_hash: "sha256:0da76457e0595e65d075080ba2cc2d2372bc0122b9ae9d5ac5f1b40414766ed0",
  },
});

const NUMERIC_CANDIDATES = Object.freeze([
  -10, -3, -1, -0.5, -0.1, -0.01, 0, 0.001, 0.01, 0.03, 0.05, 0.1,
  0.15, 0.2, 0.25, 0.4, 0.5, 0.75, 1, 2, 3, 4, 5, 10, 20, 100,
]);

// These are deterministic test fixtures, not investment thresholds. Their only purpose is to
// keep the non-targeted vetoes quiet while one required/eligibility fact is removed.
const BASELINE_VALUES = Object.freeze({
  "accounting.cash_conversion": 1,
  "capital_allocation.share_count": 1,
  "capital_allocation.share_count_change_5y": 0,
  "event.expiry_coverage": true,
  "execution.bid_ask": 0.01,
  "execution.round_trip_cost": 0.02,
  "financial.free_cash_flow_5y": 10,
  "financial.gross_margin_5y": 0.5,
  "financial.incremental_return_on_capital": 0.3,
  "financial.interest_coverage": 10,
  "financial.leverage": 0.5,
  "financial.net_current_asset_value": 10,
  "financial.net_margin_5y": 0.3,
  "financial.owner_earnings": 10,
  "financial.return_on_equity_10y": 0.3,
  "fund.top_ten_weight": 0.4,
  "governance.insider_ownership": 0.1,
  "index.aggregate_earnings_yield": 0.08,
  "index.aggregate_pe_ttm": 15,
  "index.dividend_yield": 0.03,
  "macro.aaa_corporate_yield": 0.05,
  "macro.breakeven_inflation": 0.02,
  "macro.credit_spread": 0.06,
  "macro.growth_regime": "rising_growth_falling_inflation",
  "macro.liquidity_impulse": 0.1,
  "macro.long_bond_yield": 0.04,
  "macro.real_rate": 0.02,
  "macro.short_bond_yield": 0.03,
  "macro.term_structure_slope": 0.1,
  "market.change_pct": 0.1,
  "market.price": 1,
  "options.implied_volatility": 0.4,
  "options.realized_volatility": 0.3,
  "options.skew_25d": 0.1,
  "options.term_structure": "contango",
  "payoff.convexity": 1,
  "payoff.max_loss": 0.5,
  "risk.hidden_leverage": 0,
  "risk.ruin_possible": false,
  "valuation.cash_flow": 1,
  "valuation.cost_of_capital": 0.1,
  "valuation.downside_asset_value": 10,
  "valuation.downside_floor": 10,
  "valuation.failure_probability": 0.1,
  "valuation.implied_story": 1,
  "valuation.reinvestment_rate": 0.4,
  "valuation.revenue_growth": 0.2,
  "valuation.target_margin": 0.2,
});

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function intervalFor(period) {
  if (!["duration", "forecast_horizon"].includes(period?.basis)) {
    return { period_start: null, period_end: null };
  }
  const match = /^P([1-9]\d*)([DMY])$/u.exec(period.window || "");
  const days = period.window === "ANY" ? 365
    : match ? Number(match[1]) * ({ D: 1, M: 30, Y: 365 })[match[2]]
      : 365;
  const end = Date.parse(`${AS_OF}T00:00:00.000Z`);
  return {
    period_start: new Date(end - days * 86_400_000).toISOString().slice(0, 10),
    period_end: AS_OF,
  };
}

function conditionLiteralForFact(policy, factId) {
  let literal;
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.left?.fact_id === factId && Object.hasOwn(value.right || {}, "literal")) {
      literal = value.right.literal;
    }
    if (value.right?.fact_id === factId && Object.hasOwn(value.left || {}, "literal")) {
      literal = value.left.literal;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(policy);
  return literal;
}

function factContract(pack, catalog, factId) {
  for (const tool of pack.components.tools) {
    for (const [index, operand] of tool.inputs.entries()) {
      if (operand.fact_id === factId) return tool.input_contracts[index];
    }
  }
  const producer = catalog.producers.find((item) => item.fact_id === factId && item.maximal_precedence)
    || catalog.producers.find((item) => item.fact_id === factId);
  if (producer) {
    return {
      value_kind: producer.observed.value_kind,
      unit: producer.observed.unit,
      period: {
        basis: producer.observed.period_basis,
        window: producer.observed.period_basis === "duration" ? "ANY" : null,
        alignment: producer.observed.period_basis === "instant" ? "as_of" : "same_period",
      },
    };
  }
  const literal = conditionLiteralForFact(pack.components.decision_policy, factId);
  const valueKind = typeof literal === "boolean" ? "boolean"
    : typeof literal === "string" ? "text" : "ratio";
  return {
    value_kind: valueKind,
    unit: valueKind === "ratio" ? "decimal" : null,
    period: { basis: "instant", window: null, alignment: "as_of" },
  };
}

function syntheticFact(pack, catalog, factId) {
  const contract = factContract(pack, catalog, factId);
  const value = Object.hasOwn(BASELINE_VALUES, factId) ? BASELINE_VALUES[factId]
    : contract.value_kind === "boolean" ? false
      : contract.value_kind === "text" ? "synthetic_state" : 1;
  return canonicalValue({
    schema_version: 1,
    fact_id: factId,
    value_kind: contract.value_kind,
    value,
    unit: contract.unit ?? (contract.value_kind === "ratio" ? "decimal" : null),
    currency: contract.value_kind === "monetary" ? "USD" : null,
    scale: contract.value_kind === "monetary" ? 1 : null,
    ...(contract.value_kind === "ratio" ? { ratio_denominator: "synthetic_denominator" } : {}),
    ...intervalFor(contract.period),
    fiscal_year: null,
    as_of: AS_OF,
    public_at: AS_OF,
    source_ids: ["synthetic:seat-fidelity"],
    derivation: "reported",
    confidence: 0.9,
    restatement_policy: "frozen seat-fidelity fixture",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  });
}

function fullFactTemplates(pack, catalog) {
  const ids = [...new Set([
    ...factIdsIn(pack.components.decision_policy),
    ...factIdsIn(pack.components.tools),
  ])].sort();
  return ids.map((factId) => {
    const fact = syntheticFact(pack, catalog, factId);
    if (pack.persona_id === "master_soros" && factId === "macro.credit_spread") {
      return canonicalValue({ ...fact, value: 0.04 });
    }
    return fact;
  });
}

function runtimePlan(pack, facts) {
  const factPack = buildFactPack(facts, { asOf: AS_OF });
  const run = {
    symbol: "SYNTHETIC",
    as_of: AS_OF,
    language: "English",
    grounding: { typed_fact_pack: factPack },
  };
  const plan = planMasterSeats(run, [pack.persona_id], {
    v3Registry: { get: (id) => id === pack.persona_id ? pack : undefined },
    legacyPlanner: () => { throw new Error("seat-fidelity must not enter a legacy seat path"); },
  });
  if (plan.blocked.length) {
    const item = plan.blocked[0];
    throw new Error(`${pack.persona_id}: runtime blocked (${item.error_code || item.reason}): ${item.error || "unknown"}`);
  }
  const item = plan.completed[0] || plan.declined[0];
  if (!item) throw new Error(`${pack.persona_id}: no terminal runtime item`);
  const opinion = item.completed ? completedMasterOpinion(run, item) : declinedMasterOpinion(run, item);
  return { run, plan, item, opinion, stance: item.decision?.stance || opinion.stance };
}

function ablationTargets(pack) {
  return [...new Set([
    ...(pack.manifest.capability.required_fact_types || []),
    ...factIdsIn(pack.components.decision_policy.eligibility),
  ])].sort();
}

function dependencyFacts(pack, condition) {
  const byOutput = new Map(pack.components.tools.map((tool) => [tool.output_id, tool]));
  const found = new Set();
  const visitedOutputs = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.fact_id === "string") found.add(value.fact_id);
    if (typeof value.output_id === "string" && byOutput.has(value.output_id)
      && !visitedOutputs.has(value.output_id)) {
      visitedOutputs.add(value.output_id);
      visit(byOutput.get(value.output_id).inputs);
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(condition);
  return [...found].sort();
}

function witnessValue(fact, iteration, index) {
  if (fact.value_kind === "boolean") return ((iteration + index * 3) & 1) === 1;
  if (!["monetary", "ratio", "count", "scalar"].includes(fact.value_kind)) return fact.value;
  const offset = iteration * (index * 7 + 3) + index * 11
    + Math.floor(iteration / NUMERIC_CANDIDATES.length);
  return NUMERIC_CANDIDATES[offset % NUMERIC_CANDIDATES.length];
}

function hardVetoStatus(pack, templates) {
  const readable = technicalIdReadableMap(pack);
  const pendingIds = [];
  const triggeredIds = [];
  for (const veto of pack.components.decision_policy.hard_vetoes) {
    if (rootNonliteralComparison(veto.condition)) {
      pendingIds.push(veto.veto_id);
      continue;
    }
    const dependencies = new Set(dependencyFacts(pack, veto.condition));
    let triggered = false;
    for (let iteration = 0; iteration < 5_000 && !triggered; iteration += 1) {
      const facts = templates.map((fact, index) => (
        dependencies.has(fact.fact_id)
          ? canonicalValue({ ...fact, value: witnessValue(fact, iteration, index) })
          : fact
      ));
      try {
        const preDecision = buildAnonymousPreDecision({
          compiledPack: pack,
          factPack: buildFactPack(facts, { asOf: AS_OF }),
          privateEvidence: [],
        });
        if (preDecision.eligibility.status === "out_of_scope") continue;
        const execution = executeDeterministicPersonaPolicy(preDecision);
        const ids = execution.frozen_decision.structured_decision.result.vetoes_triggered
          .map((record) => readable.get(record.veto_id) || record.veto_id);
        triggered = ids.includes(veto.veto_id);
      } catch {
        // A candidate may be a zero divisor or violate an operand contract. The bounded search
        // continues; success is recorded only after the real executor returns the target veto.
      }
    }
    if (!triggered) throw new Error(`${pack.persona_id}/${veto.veto_id}: no mechanical veto witness found`);
    triggeredIds.push(veto.veto_id);
  }
  return { triggeredIds, pendingIds };
}

function directionalAbstentionRejected(master) {
  const sourceId = "market_data:S1";
  const frozen = {
    master,
    stance: "out_of_scope",
    confidence: "low",
    source_ids: [sourceId],
    evidence_source_ids: [sourceId],
    method_source_ids: [`proxy:${master}`],
  };
  const run = {
    symbol: "SYNTHETIC",
    as_of: AS_OF,
    language: "English",
    packets: [{ task: "market_data", sources: [{ id: sourceId }] }],
    grounding: { typed_fact_sources: [] },
    master_runtime_provenance: {
      [master]: { method_sources: [{ source_id: `proxy:${master}`, source_kind: "derived_proxy" }] },
    },
  };
  const voice = {
    would_i_act: "I issue no directional view while the required inputs are absent.",
    what_i_see: "I see an incomplete point-in-time record.",
    how_my_method_reads_it: "I stop at the frozen evidence boundary.",
    where_i_disagree: "I would buy after the missing fact arrives.",
    what_changes_my_mind: "I reassess when a dated source supplies the missing fact.",
  };
  try {
    normalizeMasterVoice({
      master,
      acknowledged_stance: "out_of_scope",
      voice_mode: FIRST_PERSON_VOICE_MODE,
      disclosure_ack: FIRST_PERSON_DISCLOSURE_ACK,
      position_intent: "inputs_unavailable",
      voice,
      key_findings: [],
      disagreements: [],
      what_would_change_my_mind: [],
      source_ids: [sourceId],
      confidence: "low",
    }, master, run, frozen);
  } catch (error) {
    return error?.data?.reason === "METHOD_VOICE_DIRECTIONAL_ABSTENTION";
  }
  return false;
}

function identityCandidates(pack) {
  return [...new Set(Object.values(pack.manifest.identity.public_label || {})
    .flatMap((label) => [
      label,
      String(label).replace(/\s+(?:Solo Test|Lens).*$/iu, "")
        .replace(/(?:单人测试|視角|视角|単独テスト|방법론 렌즈|단독 테스트).*$/u, "")
        .trim(),
    ])
    .filter(Boolean))];
}

function caseInventory(pack) {
  const groups = {
    golden: pack.components.golden_cases || [],
    pairwise: pack.components.pairwise_cases || [],
    calibration: pack.components.calibration_cases || [],
  };
  const temporal = Object.entries(groups)
    .flatMap(([kind, values]) => caseAsOfErrors(values, { kind }));
  const all = Object.values(groups).flat();
  return {
    total: all.length,
    golden: groups.golden.length,
    pairwise: groups.pairwise.length,
    calibration: groups.calibration.length,
    unlabeled: all.filter((record) => !caseIsLabeled(record)).length,
    temporal_errors: temporal.length,
    errors: temporal,
  };
}

function factCoverage(pack, catalog, acknowledged) {
  const targets = ablationTargets(pack);
  const counts = { produced: 0, conditional: 0, acknowledged_no_producer: 0, uncovered: 0 };
  const errors = [];
  for (const factId of targets) {
    const row = catalog.pack_fact_coverage.find((entry) => (
      entry.master_id === pack.persona_id && entry.fact_id === factId
    ));
    if (!row) { counts.uncovered += 1; errors.push(`${pack.persona_id}/${factId}: no catalog row`); continue; }
    if (row.status === "produced") counts.produced += 1;
    else if (row.status === "conditional") counts.conditional += 1;
    else if (row.status === "no_producer" && acknowledged.has(factId)) counts.acknowledged_no_producer += 1;
    else { counts.uncovered += 1; errors.push(`${pack.persona_id}/${factId}: unacknowledged ${row.status}`); }
  }
  return { target_facts: targets.length, ...counts, errors };
}

function schemaValidators() {
  const ajv = new Ajv2020({
    strict: true,
    allowUnionTypes: true,
    allErrors: true,
    validateFormats: false,
  });
  return {
    policy: ajv.compile(readJson(POLICY_SCHEMA)),
    template: ajv.compile(readJson(TEMPLATE_SCHEMA)),
  };
}

export function inspectAIMachineSimulationSemanticEquality() {
  const errors = [];
  let semanticEqual = 0;
  let identityDrift = 0;
  let nEffByteIdentical = false;
  for (const [relativePath, parent] of Object.entries(AI_SIMULATION_PARENT_SNAPSHOT)) {
    try {
      const text = readFileSync(join(AI_SIMULATION_ROOT, relativePath), "utf8");
      const semanticHash = sha256(stripSimulationIdentity(JSON.parse(text)));
      const byteHash = sha256(text);
      if (semanticHash === parent.semantic_hash) semanticEqual += 1;
      else errors.push(`${relativePath}: semantic content drifted from the WP-3F parent`);
      if (relativePath === "n-eff-disclosure.json") {
        nEffByteIdentical = byteHash === parent.byte_hash;
        if (!nEffByteIdentical) errors.push(`${relativePath}: must remain byte-identical to the WP-3F parent`);
      } else if (byteHash !== parent.byte_hash) identityDrift += 1;
      else errors.push(`${relativePath}: expected an identity rebind from the WP-3F parent`);
    } catch (error) {
      errors.push(`${relativePath}: ${error.message}`);
    }
  }
  return canonicalValue({
    artifact_count: Object.keys(AI_SIMULATION_PARENT_SNAPSHOT).length,
    semantic_equal_count: semanticEqual,
    identity_drift_count: identityDrift,
    n_eff_disclosure_byte_identical: nEffByteIdentical,
    valid: errors.length === 0,
    errors,
  });
}

export function inspectSeatFidelity() {
  const errors = [];
  const aiSimulations = inspectAIMachineSimulationSemanticEquality();
  errors.push(...aiSimulations.errors.map((error) => `ai-simulations/${error}`));
  const packVersion = resolvePersonaPackVersion(REPO_ROOT);
  const physical = inspectPersonaV3SoloTestPacks({ packVersion });
  if (!physical.summary.ready_for_solo_testing) errors.push("persona:solo-test:check is not ready");
  const registry = loadCompiledPersonaPacks({ buildProfile: "solo_test" });
  const packs = registry.packs;
  const catalog = loadFactProducerCatalog();
  const acknowledged = new Set(readJson(NO_PRODUCER_ACKNOWLEDGEMENT).entries.map((entry) => entry.fact_id));
  const lint = validateImpersonationLintConfig(readJson(IMPERSONATION_CONFIG));
  const formulaManifest = readJson(FORMULA_MANIFEST);
  const validators = schemaValidators();
  const toolRows = packs.flatMap((pack) => pack.components.tools.map((tool) => ({
    persona_id: pack.persona_id,
    tool,
  })));
  errors.push(...validateDerivationBindings(toolRows, formulaManifest.bindings || []));
  if (toolRows.length !== EXPECTED_TOOLS) errors.push(`expected ${EXPECTED_TOOLS} tools; found ${toolRows.length}`);

  const seats = [];
  for (const pack of packs) {
    const policy = pack.components.decision_policy;
    if (!validators.policy(policy)) {
      errors.push(`${pack.persona_id}: decision policy schema: ${JSON.stringify(validators.policy.errors)}`);
    }
    let provenance;
    try { provenance = provenanceSummary(policy); } catch (error) {
      errors.push(`${pack.persona_id}: ${error.message}`);
      continue;
    }
    if (provenance.sourced !== 0 || !provenance.structural_unsourced) {
      errors.push(`${pack.persona_id}: current solo-test provenance must be wholly unsourced`);
    }

    const templates = fullFactTemplates(pack, catalog);
    let baseline;
    let allAblated;
    const targets = ablationTargets(pack);
    let individualOutOfScope = 0;
    try {
      baseline = runtimePlan(pack, templates);
      if (baseline.stance === "out_of_scope") errors.push(`${pack.persona_id}: synthetic baseline unexpectedly abstained`);
      for (const target of targets) {
        const ablated = runtimePlan(pack, templates.filter((fact) => fact.fact_id !== target));
        if (ablated.stance === "out_of_scope") individualOutOfScope += 1;
        else errors.push(`${pack.persona_id}/${target}: ablation returned ${ablated.stance}`);
      }
      allAblated = runtimePlan(pack, templates.filter((fact) => !targets.includes(fact.fact_id)));
      if (allAblated.stance !== "out_of_scope") {
        errors.push(`${pack.persona_id}: all-target ablation returned ${allAblated.stance}`);
      }
    } catch (error) {
      errors.push(error.message);
      continue;
    }

    let vetoStatus;
    try { vetoStatus = hardVetoStatus(pack, templates); } catch (error) {
      errors.push(error.message);
      continue;
    }
    const directionalRejected = directionalAbstentionRejected(pack.persona_id);
    if (!directionalRejected) errors.push(`${pack.persona_id}: directional abstention was not rejected`);

    const inventory = caseInventory(pack);
    errors.push(...inventory.errors.map((error) => `${pack.persona_id}: ${error}`));
    const coverage = factCoverage(pack, catalog, acknowledged);
    errors.push(...coverage.errors);

    const opinion = { ...baseline.opinion, threshold_provenance: provenance };
    const ablatedOpinion = { ...allAblated.opinion, threshold_provenance: provenance };
    const rendered = renderMasterMarkdown(opinion, "English");
    const prefix = /^(AI simulation of the .+ method — not the person)$/mu.exec(rendered)?.[1] || "";
    const thresholdLine = /^(thresholds: .+)$/mu.exec(rendered)?.[1] || "";
    if (!prefix) errors.push(`${pack.persona_id}: fixed simulation prefix is absent`);
    if (thresholdLine !== thresholdDisclosure(provenance)) {
      errors.push(`${pack.persona_id}: threshold disclosure is absent or drifted`);
    }

    const artifacts = [
      { id: "voice.en.md", text: pack.voice.en },
      { id: "voice.zh.md", text: pack.voice.zh },
      { id: "doctrine.jsonl", text: JSON.stringify(pack.components.doctrine) },
      { id: "dry-run:baseline", text: JSON.stringify(baseline.opinion) },
      { id: "dry-run:all-target-ablation", text: JSON.stringify(ablatedOpinion) },
      { id: "rendered:dry-run", text: rendered },
    ];
    const identities = identityCandidates(pack);
    const lintHits = artifacts.flatMap((artifact) => impersonationHits(artifact.text, lint, { identities })
      .map((hit) => ({ artifact: artifact.id, ...hit })));
    for (const hit of lintHits) {
      errors.push(`${pack.persona_id}/${hit.artifact}: impersonation ${hit.rule_id}: ${hit.match}`);
    }

    const bindings = pack.components.tools.map((tool) => canonicalValue({
      tool_id: tool.id,
      derivation_spec_id: tool.derivation_spec_id,
      derivation_spec_hash: tool.derivation_spec_hash,
      derivation_evidence_hash: tool.derivation_evidence_hash,
    }));
    const seat = canonicalValue({
      schema_version: 1,
      artifact_kind: "persona_v3_seat_fidelity_template",
      persona_id: pack.persona_id,
      build_profile: pack.build_profile,
      maturity: pack.maturity,
      policy_subject_hash: sha256(stripPolicyProvenance(policy)),
      threshold_provenance: provenance,
      derivation_bindings: bindings,
      case_inventory: {
        total: inventory.total,
        golden: inventory.golden,
        pairwise: inventory.pairwise,
        calibration: inventory.calibration,
        unlabeled: inventory.unlabeled,
        temporal_errors: inventory.temporal_errors,
      },
      fact_coverage: {
        target_facts: coverage.target_facts,
        produced: coverage.produced,
        conditional: coverage.conditional,
        acknowledged_no_producer: coverage.acknowledged_no_producer,
        uncovered: coverage.uncovered,
      },
      ablations: {
        individual_target_count: targets.length,
        individual_out_of_scope_count: individualOutOfScope,
        all_targets_out_of_scope: allAblated.stance === "out_of_scope",
      },
      hard_vetoes: {
        total: pack.components.decision_policy.hard_vetoes.length,
        mechanically_triggered: vetoStatus.triggeredIds.length,
        pending_nonliteral: vetoStatus.pendingIds.length,
        pending_ids: vetoStatus.pendingIds,
      },
      voice_safety: {
        directional_abstention_rejected: directionalRejected,
        artifacts_scanned: artifacts.length,
        impersonation_hits: lintHits.length,
        disclosure_prefix: prefix,
        threshold_disclosure: thresholdLine,
      },
    });
    if (!validators.template(seat)) {
      errors.push(`${pack.persona_id}: seat template schema: ${JSON.stringify(validators.template.errors)}`);
    }
    seats.push(seat);
  }

  const numericSubjectHash = policySubjectHash(packs.map((pack) => ({
    persona_id: pack.persona_id,
    decision_policy: pack.components.decision_policy,
  })));
  if (numericSubjectHash !== POLICY_NUMERIC_BASELINE_HASH) {
    errors.push(`policy subject changed: expected ${POLICY_NUMERIC_BASELINE_HASH}; found ${numericSubjectHash}`);
  }
  const summary = canonicalValue({
    seat_count: seats.length,
    threshold_records: seats.reduce((sum, seat) => sum + seat.threshold_provenance.unsourced, 0),
    sourced_threshold_records: seats.reduce((sum, seat) => sum + seat.threshold_provenance.sourced, 0),
    derivation_spec_count: seats.reduce((sum, seat) => sum + seat.derivation_bindings.length, 0),
    cases: seats.reduce((sum, seat) => sum + seat.case_inventory.total, 0),
    golden_cases: seats.reduce((sum, seat) => sum + seat.case_inventory.golden, 0),
    pairwise_cases: seats.reduce((sum, seat) => sum + seat.case_inventory.pairwise, 0),
    calibration_cases: seats.reduce((sum, seat) => sum + seat.case_inventory.calibration, 0),
    unlabeled_cases: seats.reduce((sum, seat) => sum + seat.case_inventory.unlabeled, 0),
    ablation_targets: seats.reduce((sum, seat) => sum + seat.ablations.individual_target_count, 0),
    ablation_out_of_scope: seats.reduce((sum, seat) => sum + seat.ablations.individual_out_of_scope_count, 0),
    hard_vetoes: seats.reduce((sum, seat) => sum + seat.hard_vetoes.total, 0),
    vetoes_mechanically_triggered: seats.reduce((sum, seat) => sum + seat.hard_vetoes.mechanically_triggered, 0),
    vetoes_pending_nonliteral: seats.reduce((sum, seat) => sum + seat.hard_vetoes.pending_nonliteral, 0),
    impersonation_hits: seats.reduce((sum, seat) => sum + seat.voice_safety.impersonation_hits, 0),
    policy_subject_hash: numericSubjectHash,
  });
  if (packs.length !== EXPECTED_SEATS || seats.length !== EXPECTED_SEATS) {
    errors.push(`expected ${EXPECTED_SEATS} seat templates; found ${seats.length}/${packs.length}`);
  }
  if (summary.threshold_records !== EXPECTED_POLICY_RECORDS
    || summary.sourced_threshold_records !== 0) {
    errors.push(`expected ${EXPECTED_POLICY_RECORDS} wholly unsourced policy records`);
  }
  if (summary.derivation_spec_count !== EXPECTED_TOOLS) {
    errors.push(`expected ${EXPECTED_TOOLS} derivation bindings; found ${summary.derivation_spec_count}`);
  }
  if (summary.vetoes_pending_nonliteral !== EXPECTED_PENDING_ROOT_NONLITERAL) {
    errors.push(`expected ${EXPECTED_PENDING_ROOT_NONLITERAL} pending root nonliteral vetoes; found ${summary.vetoes_pending_nonliteral}`);
  }
  if (summary.vetoes_mechanically_triggered + summary.vetoes_pending_nonliteral !== summary.hard_vetoes) {
    errors.push("hard-veto accounting does not close");
  }
  if (summary.ablation_targets !== summary.ablation_out_of_scope) {
    errors.push("not every required/eligibility ablation returned out_of_scope");
  }
  return Object.freeze(canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_seat_fidelity_report",
    assurance: "mechanical_structure_only_not_accuracy_or_profit_evidence",
    root: DEFAULT_SOLO_TEST_PACK_ROOT,
    summary,
    ai_simulations: aiSimulations,
    errors,
    seats,
  }));
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0] !== "--check") {
    throw new Error("usage: node scripts/check-seat-fidelity.mjs --check");
  }
  const report = inspectSeatFidelity();
  const s = report.summary;
  process.stdout.write(`seat-fidelity: seats=${s.seat_count}; policy records=${s.threshold_records} unsourced, ${s.sourced_threshold_records} sourced; derivation specs=${s.derivation_spec_count}\n`);
  process.stdout.write(`seat-fidelity: cases: ${s.cases} (golden ${s.golden_cases}, pairwise ${s.pairwise_cases}, calibration ${s.calibration_cases}); unlabeled: ${s.unlabeled_cases}\n`);
  process.stdout.write(`seat-fidelity: ablations=${s.ablation_out_of_scope}/${s.ablation_targets} out_of_scope; hard vetoes=${s.vetoes_mechanically_triggered} triggered + ${s.vetoes_pending_nonliteral} pending nonliteral = ${s.hard_vetoes}\n`);
  process.stdout.write(`seat-fidelity: impersonation hits=${s.impersonation_hits}; policy subject=${s.policy_subject_hash}\n`);
  const ai = report.ai_simulations;
  if (ai.valid) {
    process.stdout.write("ai-simulations: 11 artifacts regenerated; identity drift only; n-eff-disclosure byte-identical\n");
  } else {
    process.stdout.write(`ai-simulations: semantic=${ai.semantic_equal_count}/${ai.artifact_count}; identity drift=${ai.identity_drift_count}/10; n-eff byte-identical=${ai.n_eff_disclosure_byte_identical}\n`);
  }
  if (report.errors.length) {
    process.stderr.write(`seat-fidelity failed:\n- ${report.errors.join("\n- ")}\n`);
    return 1;
  }
  process.stdout.write("seat-fidelity: mechanical structure gate passed; no accuracy, method-attribution, production, or profit claim is implied\n");
  return 0;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try { process.exitCode = main(); } catch (error) {
    process.stderr.write(`seat-fidelity failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
