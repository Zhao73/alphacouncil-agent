/** Isolated no-network deterministic machine simulations for ai_assisted_solo. */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { executeDeterministicPersonaPolicy } from "../../mcp/lib/personas-v3/runtime.mjs";
import { loadCompiledPersonaPacks } from "../../mcp/lib/personas-v3/registry.mjs";
import { buildAnonymousPreDecision } from "../../mcp/lib/personas-v3/runtime.mjs";
import { buildFactPack } from "../../mcp/lib/personas-v3/typed-facts.mjs";
import { CANONICAL_MASTER_COUNT, CANONICAL_MASTER_IDS } from "../../mcp/lib/personas-v3/staging.mjs";
import { PRIORITY_13_MASTER_IDS } from "./council-evaluation-protocol.mjs";
import { CANONICAL_SOLO_TEST_FACT_CONTRACTS } from "./persona-v3-solo-formula-pipeline.mjs";

export const AI_MACHINE_SIMULATION_RUN_IDS = Object.freeze([
  "A", "B", "C", "D13", "D26", "E:D13", "E:D26", "H_ai_reference",
]);
export const DEFAULT_AI_MACHINE_SIMULATION_ROOT = fileURLToPath(new URL(
  "../../knowledge/ai-assisted-solo/experiments/",
  import.meta.url,
));
export const AI_MACHINE_SIMULATION_INPUT_FILE = "simulation-input.json";
export const AI_MACHINE_SIMULATION_MANIFEST_FILE = "simulation-manifest.json";
export const AI_MACHINE_SIMULATION_NEFF_FILE = "n-eff-disclosure.json";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const AS_OF = "2026-07-27";
const SYNTHETIC_POLICY_FACT_CONTRACTS = Object.freeze({
  // This policy-only enum never enters a numeric tool, so it is intentionally outside the
  // formula bridge's numeric contract registry. Giving it an explicit state exercises Dalio's
  // regime rules instead of comparing a synthetic ratio with a string and silently missing.
  "macro.growth_regime": Object.freeze({
    value_kind: "text",
    unit: null,
    synthetic_value: "rising_growth_falling_inflation",
  }),
});
const BOUNDARY = Object.freeze({
  evidence_class: "machine_simulation",
  reviewer_kind: "ai",
  network_allowed: false,
  human_reference: false,
  formal_h_satisfied: false,
  formal_experiment_effect: "none",
  formal_ga_effect: "none",
  production_effect: "none",
});
const FIXTURE_PATHS = Object.freeze([
  "test/fixtures/options-chain-synthetic.json",
  "test/fixtures/nok-grounding-production-shape.json",
]);
const RUNTIME_PATHS = Object.freeze([
  "mcp/lib/personas-v3/runtime.mjs",
  "mcp/lib/personas-v3/deterministic-executor.mjs",
  "mcp/lib/personas-v3/typed-facts.mjs",
  "mcp/lib/personas-v3/registry.mjs",
]);

function bytesHash(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function inside(base, target) {
  const back = relative(base, target);
  return back === "" || (back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back));
}

function physicalFile(root, relativePath) {
  const file = resolve(root, relativePath);
  if (!inside(root, file) || !existsSync(file)) throw new Error(`missing bound file: ${relativePath}`);
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`bound file must be physical: ${relativePath}`);
  const physical = realpathSync(file);
  if (!inside(root, physical)) throw new Error(`bound file escapes root: ${relativePath}`);
  return { file: physical, bytes: readFileSync(physical) };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function artifactHash(domain, artifact, hashField) {
  const subject = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== hashField));
  return sha256({ hash_domain: domain, subject });
}

function boundFile(relativePath) {
  const opened = physicalFile(REPO_ROOT, relativePath);
  return canonicalValue({ path: relativePath, physical_file_hash: bytesHash(opened.bytes), byte_length: opened.bytes.length });
}

function factValue(kind, contract = {}) {
  if (Object.hasOwn(contract, "synthetic_value")) return contract.synthetic_value;
  if (kind === "boolean") return true;
  if (kind === "text") return "synthetic_machine_simulation";
  if (kind === "date") return AS_OF;
  return 1;
}

function factPackFor(pack) {
  const byFact = new Map();
  for (const tool of pack.components.tools) {
    tool.inputs.forEach((operand, index) => {
      if (typeof operand.fact_id === "string" && !byFact.has(operand.fact_id)) {
        byFact.set(operand.fact_id, tool.input_contracts[index]);
      }
    });
  }
  // Everything the seat declares it reads, not only what its tools consume. An authored
  // policy gates eligibility on a fact outside its tool inputs on purpose, so a fixture built
  // from tool inputs alone leaves every such seat correctly -- and uselessly -- out of scope,
  // and the simulation would then demonstrate nothing.
  for (const factId of [
    ...(pack.manifest.capability.required_fact_types || []),
    ...(pack.manifest.capability.optional_fact_types || []),
  ]) {
    // A policy-only fact does not inherit a contract from a tool input. Use the same canonical
    // fact contract as the grounding/formula bridge whenever one exists; otherwise a monetary
    // fact can silently become a ratio in the synthetic fixture and an invalid cross-kind
    // comparison can look executable. Unknown qualitative facts retain the legacy placeholder
    // because most are presence gates and do not yet have a physical adapter.
    if (!byFact.has(factId)) {
      byFact.set(factId, CANONICAL_SOLO_TEST_FACT_CONTRACTS[factId]
        || SYNTHETIC_POLICY_FACT_CONTRACTS[factId]
        || { value_kind: "ratio", unit: "decimal" });
    }
  }
  const facts = [...byFact].map(([factId, contract]) => canonicalValue({
    schema_version: 1,
    fact_id: factId,
    value_kind: contract.value_kind,
    value: factValue(contract.value_kind, contract),
    unit: contract.unit,
    currency: contract.value_kind === "monetary" ? "USD" : null,
    scale: contract.value_kind === "monetary" ? 1 : null,
    ...(contract.value_kind === "ratio" ? { ratio_denominator: "synthetic_denominator" } : {}),
    // A fixture whose facts are all instants cannot exercise a method that reads a reporting
    // interval -- the contract check rejects the fact before any arithmetic runs. The synthetic
    // fact therefore carries whatever span its own contract asks for.
    ...syntheticInterval(contract.period),
    fiscal_year: null,
    as_of: AS_OF,
    public_at: AS_OF,
    source_ids: ["synthetic:machine-simulation"],
    derivation: "reported",
    confidence: 1,
    restatement_policy: "frozen synthetic machine-simulation fixture",
    lineage: { input_fact_ids: [], tool_id: null, tool_version: null, calculation_hash: null },
  }));
  return buildFactPack(facts, { asOf: AS_OF });
}

/** Build an interval that satisfies the contract's declared window, or none for an instant. */
function syntheticInterval(period) {
  if (period?.basis !== "duration" && period?.basis !== "forecast_horizon") {
    return { period_start: null, period_end: null };
  }
  const end = Date.parse(`${AS_OF}T00:00:00.000Z`);
  const match = /^P([1-9]\d*)([DMY])$/u.exec(period.window || "");
  const days = period.window === "ANY" ? 365
    : match ? Number(match[1]) * ({ D: 1, M: 30, Y: 365 })[match[2]]
      : 365;
  return {
    period_start: new Date(end - days * 86_400_000).toISOString().slice(0, 10),
    period_end: AS_OF,
  };
}

function buildInput(registry) {
  const protocol = boundFile("data/council-evaluation-protocol.v1.json");
  const protocolValue = readJson(resolve(REPO_ROOT, protocol.path));
  const payload = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_machine_simulation_input",
    ...BOUNDARY,
    as_of: AS_OF,
    protocol_binding: { ...protocol, protocol_hash: sha256(protocolValue), protocol_status: protocolValue.protocol_status },
    fixture_bindings: FIXTURE_PATHS.map(boundFile),
    runtime_bindings: RUNTIME_PATHS.map(boundFile),
    seat_inputs: CANONICAL_MASTER_IDS.map((personaId) => {
      const pack = registry.get(personaId);
      const manifestPath = `knowledge/solo-test/masters/${personaId}/manifest.json`;
      const factPack = factPackFor(pack);
      return canonicalValue({
        persona_id: personaId,
        pack_hash: pack.pack_hash,
        pack_manifest_binding: boundFile(manifestPath),
        fact_pack: factPack,
        fact_pack_hash: factPack.fact_pack_hash,
      });
    }),
  });
  return canonicalValue({ ...payload, input_hash: artifactHash("alphacouncil.ai-machine-simulation.input.v1", payload, "input_hash") });
}

function executeSeat(registry, inputBySeat, personaId) {
  const pack = registry.get(personaId);
  const factPack = inputBySeat.get(personaId).fact_pack;
  try {
    const preDecision = buildAnonymousPreDecision({ compiledPack: pack, factPack, privateEvidence: [] });
    const execution = executeDeterministicPersonaPolicy(preDecision);
    const result = execution.frozen_decision.structured_decision.result;
    return canonicalValue({
      persona_id: personaId,
      status: "executed",
      pack_hash: pack.pack_hash,
      fact_pack_hash: factPack.fact_pack_hash,
      anonymous_method_hash: preDecision.anonymous_method_hash,
      deterministic_core_hash: preDecision.deterministic_core_hash,
      policy_execution_hash: execution.policy_execution_hash,
      structured_decision_hash: execution.frozen_decision.structured_decision_hash,
      frozen_decision_hash: execution.frozen_decision.frozen_decision_hash,
      stance: result.common_projection.stance,
      native_state: result.native_decision.state,
      score_ratio: result.score.ratio,
    });
  } catch (error) {
    const finding = canonicalValue({ name: error.name, message: error.message, details: error.details || {} });
    return canonicalValue({
      persona_id: personaId,
      status: "blocked_fail_closed",
      pack_hash: pack.pack_hash,
      fact_pack_hash: factPack.fact_pack_hash,
      error: finding,
      error_hash: sha256(finding),
    });
  }
}

function repeatabilityCheck(registry, inputBySeat, selectedIds, decisions) {
  const repeated = selectedIds.map((id) => executeSeat(registry, inputBySeat, id));
  const firstHash = sha256(decisions);
  const repeatedHash = sha256(repeated);
  return canonicalValue({
    check_id: "deterministic_rederivation",
    status: firstHash === repeatedHash ? "pass" : "fail",
    first_result_hash: firstHash,
    repeated_result_hash: repeatedHash,
  });
}

function failClosedCheck(registry, selectedIds) {
  const empty = buildFactPack([], { asOf: AS_OF });
  const outcomes = selectedIds.map((personaId) => {
    try {
      const pre = buildAnonymousPreDecision({ compiledPack: registry.get(personaId), factPack: empty, privateEvidence: [] });
      return { persona_id: personaId, decision_allowed: pre.execution_gate.anonymous_decision_allowed };
    } catch (error) {
      return { persona_id: personaId, decision_allowed: false, refusal_hash: sha256({ name: error.name, message: error.message }) };
    }
  });
  return canonicalValue({
    check_id: "missing_input_fail_closed",
    status: outcomes.every((item) => item.decision_allowed === false) ? "pass" : "fail",
    outcome_hash: sha256(outcomes),
  });
}

function configs() {
  return [
    { run_id: "A", formal_arm_id: "A", ids: ["master_buffett"], scope: "single deterministic seat surrogate; formal single-model answer is not simulated", checks: false },
    { run_id: "B", formal_arm_id: "B", ids: [], scope: "frozen-input control digest only; eight LLM analyst outputs are not simulated", checks: false },
    { run_id: "C", formal_arm_id: "C", ids: [], scope: "prompt-catalog binding only; prompt-only LLM outputs are not simulated", checks: false },
    { run_id: "D13", formal_arm_id: "D13", ids: [...PRIORITY_13_MASTER_IDS], scope: "13 physical provisional deterministic seats on frozen synthetic typed facts", checks: false },
    { run_id: "D26", formal_arm_id: "D26", ids: [...CANONICAL_MASTER_IDS], scope: `${CANONICAL_MASTER_COUNT} physical provisional deterministic seats on frozen synthetic typed facts`, checks: false },
    { run_id: "E:D13", formal_arm_id: "E", ids: [...PRIORITY_13_MASTER_IDS], scope: "D13 deterministic seats plus machine-only hash, rederivation and fail-closed checks", checks: true },
    { run_id: "E:D26", formal_arm_id: "E", ids: [...CANONICAL_MASTER_IDS], scope: "D26 deterministic seats plus machine-only hash, rederivation and fail-closed checks", checks: true },
    { run_id: "H_ai_reference", formal_arm_id: "H", ids: [...CANONICAL_MASTER_IDS], scope: "AI deterministic reference digest only; no human analysts or blinded human adjudicator", checks: true },
  ];
}

function runOne(config, registry, input) {
  const inputBySeat = new Map(input.seat_inputs.map((entry) => [entry.persona_id, entry]));
  const decisions = config.ids.map((id) => executeSeat(registry, inputBySeat, id));
  const verifierChecks = config.checks ? [
    canonicalValue({ check_id: "physical_input_hash_binding", status: "pass", input_hash: input.input_hash }),
    repeatabilityCheck(registry, inputBySeat, config.ids, decisions),
    failClosedCheck(registry, config.ids),
  ] : [];
  const findings = decisions.filter((item) => item.status !== "executed").map((item) => ({
    persona_id: item.persona_id,
    status: item.status,
    error_hash: item.error_hash,
    message: item.error.message,
  }));
  const results = canonicalValue({
    completion_status: "completed_machine_simulation",
    provider_cost_usd: 0,
    network_call_count: 0,
    deterministic_execution_count: decisions.length,
    executed_count: decisions.filter((item) => item.status === "executed").length,
    blocked_fail_closed_count: findings.length,
    decisions,
    verifier_checks: verifierChecks,
    runtime_findings: findings,
    machine_reference_digest: config.run_id === "H_ai_reference" ? sha256(decisions) : null,
    metric_claims: [],
    formal_results: null,
  });
  const payload = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_machine_simulation_run",
    ...BOUNDARY,
    run_id: config.run_id,
    formal_arm_id: config.formal_arm_id,
    formal_arm_satisfied: false,
    simulation_scope: config.scope,
    input_binding: { path: AI_MACHINE_SIMULATION_INPUT_FILE, input_hash: input.input_hash },
    configuration: {
      selected_master_ids: config.ids,
      selected_master_count: config.ids.length,
      deterministic_runtime_only: true,
      simulated_verifier_checks: config.checks,
      formal_analyst_outputs_simulated: false,
      formal_human_outputs_simulated: false,
    },
    results,
    result_hash: sha256(results),
  });
  return canonicalValue({ ...payload, run_artifact_hash: artifactHash("alphacouncil.ai-machine-simulation.run.v1", payload, "run_artifact_hash") });
}

function nEffDisclosure() {
  const payload = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_assisted_n_eff_disclosure",
    evidence_class: "machine_simulation",
    n_eff: null,
    status: "insufficient_resolved_outcomes",
    reason: "insufficient_resolved_outcomes",
    resolved_outcome_count: 0,
    minimum_required: 36,
    formal_n_eff_effect: "none",
    formal_experiment_effect: "none",
    formal_ga_effect: "none",
  });
  return canonicalValue({ ...payload, artifact_hash: artifactHash("alphacouncil.ai-assisted-solo.n-eff-disclosure.v1", payload, "artifact_hash") });
}

function runFile(runId) {
  return `runs/${runId.replaceAll(":", "-").toLowerCase()}.json`;
}

export function planAIMachineSimulations() {
  const registry = loadCompiledPersonaPacks({ buildProfile: "solo_test" });
  const input = buildInput(registry);
  const runs = configs().map((config) => runOne(config, registry, input));
  const disclosure = nEffDisclosure();
  const manifestPayload = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_ai_machine_simulation_manifest",
    ...BOUNDARY,
    input_binding: { path: AI_MACHINE_SIMULATION_INPUT_FILE, input_hash: input.input_hash, content_hash: sha256(input) },
    run_count: runs.length,
    required_run_ids: [...AI_MACHINE_SIMULATION_RUN_IDS],
    run_bindings: runs.map((run) => ({
      run_id: run.run_id,
      path: runFile(run.run_id),
      run_artifact_hash: run.run_artifact_hash,
      content_hash: sha256(run),
      executed_count: run.results.executed_count,
      blocked_fail_closed_count: run.results.blocked_fail_closed_count,
    })),
    n_eff_disclosure_binding: { path: AI_MACHINE_SIMULATION_NEFF_FILE, artifact_hash: disclosure.artifact_hash, content_hash: sha256(disclosure) },
  });
  const manifest = canonicalValue({
    ...manifestPayload,
    manifest_hash: artifactHash("alphacouncil.ai-machine-simulation.manifest.v1", manifestPayload, "manifest_hash"),
  });
  return Object.freeze({ input, runs: Object.freeze(runs), n_eff_disclosure: disclosure, manifest });
}

function expectedFiles(plan) {
  return new Map([
    [AI_MACHINE_SIMULATION_INPUT_FILE, `${JSON.stringify(plan.input, null, 2)}\n`],
    [AI_MACHINE_SIMULATION_NEFF_FILE, `${JSON.stringify(plan.n_eff_disclosure, null, 2)}\n`],
    [AI_MACHINE_SIMULATION_MANIFEST_FILE, `${JSON.stringify(plan.manifest, null, 2)}\n`],
    ...plan.runs.map((run) => [runFile(run.run_id), `${JSON.stringify(run, null, 2)}\n`]),
  ]);
}

function collectFiles(root, current = root, out = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const file = resolve(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`machine-simulation tree contains symlink: ${file}`);
    if (entry.isDirectory()) collectFiles(root, file, out);
    else if (entry.isFile()) out.push(relative(root, file).split(sep).join("/"));
    else throw new Error(`unsupported machine-simulation entry: ${file}`);
  }
  return out.sort();
}

function isolatedRoot(root, { create = false } = {}) {
  const output = resolve(root);
  if (basename(output) !== "experiments" || basename(dirname(output)) !== "ai-assisted-solo") {
    throw new Error("machine-simulation root must end in ai-assisted-solo/experiments");
  }
  if (create && !existsSync(output)) mkdirSync(output, { recursive: true });
  if (!existsSync(output) || lstatSync(output).isSymbolicLink() || !statSync(output).isDirectory()) {
    throw new Error("machine-simulation root must be a physical directory");
  }
  return realpathSync(output);
}

export function writeAIMachineSimulations({ root = DEFAULT_AI_MACHINE_SIMULATION_ROOT } = {}) {
  const plan = planAIMachineSimulations();
  const output = isolatedRoot(root, { create: true });
  const result = { written: [], unchanged: [] };
  for (const [relativePath, content] of expectedFiles(plan)) {
    const file = resolve(output, relativePath);
    if (!inside(output, file)) throw new Error(`unsafe machine-simulation output: ${relativePath}`);
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && readFileSync(file, "utf8") === content) result.unchanged.push(relativePath);
    else { writeFileSync(file, content, { encoding: "utf8", mode: 0o644 }); result.written.push(relativePath); }
  }
  const verified = verifyAIMachineSimulationTree({ root: output });
  return canonicalValue({ ...verified, ...result });
}

export function verifyAIMachineSimulationTree({ root = DEFAULT_AI_MACHINE_SIMULATION_ROOT } = {}) {
  const plan = planAIMachineSimulations();
  const output = isolatedRoot(root);
  const expected = expectedFiles(plan);
  const actual = collectFiles(output);
  if (JSON.stringify(actual) !== JSON.stringify([...expected.keys()].sort())) throw new Error("machine-simulation physical file inventory drift");
  for (const [relativePath, content] of expected) {
    const file = resolve(output, relativePath);
    if (lstatSync(file).isSymbolicLink() || readFileSync(file, "utf8") !== content) throw new Error(`machine-simulation artifact drift: ${relativePath}`);
  }
  return canonicalValue({
    valid: true,
    root: output,
    run_count: plan.runs.length,
    completed_run_ids: plan.runs.map((run) => run.run_id),
    deterministic_execution_count: plan.runs.reduce((sum, run) => sum + run.results.deterministic_execution_count, 0),
    executed_count: plan.runs.reduce((sum, run) => sum + run.results.executed_count, 0),
    blocked_fail_closed_count: plan.runs.reduce((sum, run) => sum + run.results.blocked_fail_closed_count, 0),
    network_call_count: 0,
    human_reference_count: 0,
    formal_experiment_effect: "none",
    formal_ga_effect: "none",
    n_eff: null,
    n_eff_status: plan.n_eff_disclosure.status,
    manifest_hash: plan.manifest.manifest_hash,
    physical_file_count: actual.length,
  });
}
