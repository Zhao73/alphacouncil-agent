/**
 * Honest single-maintainer formula bridge for local PersonaPack v3 testing.
 *
 * This module mechanically derives one identity proxy from every still-pending authoring
 * candidate. The resulting 52 DSL 1.1 tools are executable, but deliberately carry a
 * disjoint `provisional_derived_proxy` evidence binding. They contain no reviewer identity,
 * signature, approval bundle, or method-model claim and cannot satisfy production admission.
 */

import { PLANNED_TOOL_COUNT } from "../../data/persona-v3-build-specs.v1.mjs";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import {
  ANY_REPORTING_INTERVAL,
  PROVISIONAL_DERIVED_PROXY_ASSURANCE,
  deterministicToolSchemaHashes,
} from "../../mcp/lib/personas-v3/deterministic-executor.mjs";
import {
  CANONICAL_MASTER_COUNT,
  CANONICAL_MASTER_IDS,
  defaultStagingRoot,
} from "../../mcp/lib/personas-v3/staging.mjs";
import { authoredMethods } from "../../data/authored/index.mjs";
import {
  DEFAULT_FORMULA_CANDIDATE_ROOT,
  FORMULA_AUTHORING_STATUS,
  FORMULA_CANDIDATE_DIRNAME,
  FORMULA_DSL_VERSION,
  formulaSpecCandidateRelativePath,
  planPersonaV3FormulaPipeline,
  validateFormulaSpec,
} from "./persona-v3-formula-pipeline.mjs";

export const SOLO_TEST_FORMULA_DIRNAME = "persona-v3-solo-test-formulas";
export const DEFAULT_SOLO_TEST_FORMULA_ROOT = resolve(
  defaultStagingRoot(),
  "../..",
  "solo-test",
  SOLO_TEST_FORMULA_DIRNAME,
);
export const SOLO_TEST_REVIEW_STATUS = "not_human_reviewed";
export const SOLO_TEST_INTENDED_USE = "local_test_only";
export const SOLO_TEST_PROXY_UNIT = "derived_proxy_scalar";

const INSTANT_AS_OF = Object.freeze({ basis: "instant", window: null, alignment: "as_of" });

/**
 * Some facts genuinely cover a span rather than a moment: a five-year cash-flow total is not an
 * observation taken on one day. Declaring those as instants made them unusable -- the executor
 * rejects an instant contract against a fact that carries a reporting interval, so every seat
 * whose method reads company fundamentals failed closed on live grounding.
 */
function duration(window) {
  return Object.freeze({ basis: "duration", window, alignment: "as_of" });
}

/**
 * Typed-fact contracts currently emitted by grounding-adapter and safe to bind mechanically.
 * A fact whose physical period differs from this canonical instant snapshot still fails closed.
 */
export const CANONICAL_SOLO_TEST_FACT_CONTRACTS = Object.freeze({
  "market.price": Object.freeze({ value_kind: "monetary", unit: "currency_units", period: INSTANT_AS_OF }),
  "market.change_pct": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "financial.return_on_equity_10y": Object.freeze({ value_kind: "ratio", unit: "decimal", period: duration("P10Y") }),
  "financial.free_cash_flow_5y": Object.freeze({ value_kind: "monetary", unit: "currency_units", period: duration("P5Y") }),
  "financial.interest_coverage": Object.freeze({ value_kind: "ratio", unit: "multiple", period: duration(ANY_REPORTING_INTERVAL) }),
  "financial.gross_margin_5y": Object.freeze({ value_kind: "ratio", unit: "decimal", period: duration("P5Y") }),
  "financial.net_margin_5y": Object.freeze({ value_kind: "ratio", unit: "decimal", period: duration("P5Y") }),
  "accounting.cash_conversion": Object.freeze({ value_kind: "ratio", unit: "multiple", period: duration("P5Y") }),
  "capital_allocation.share_count_change_5y": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "options.implied_volatility": Object.freeze({ value_kind: "ratio", unit: "decimal_annualized_volatility", period: INSTANT_AS_OF }),
  "options.skew_25d": Object.freeze({ value_kind: "ratio", unit: "decimal_volatility_difference", period: INSTANT_AS_OF }),
  "execution.bid_ask": Object.freeze({ value_kind: "ratio", unit: "decimal_of_mid", period: INSTANT_AS_OF }),

  // Dated official series. These are what let a macro or cycle method have a direction at all,
  // and their units are decimal fractions rather than the percent the sources publish.
  "macro.long_bond_yield": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "macro.short_bond_yield": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "macro.term_structure_slope": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "macro.real_rate": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "macro.breakeven_inflation": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "macro.aaa_corporate_yield": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "macro.credit_spread": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "macro.liquidity_impulse": Object.freeze({ value_kind: "ratio", unit: "decimal", period: duration("P3M") }),
  // macro.growth_regime is deliberately absent. A tool contract accepts only monetary, ratio,
  // count or scalar, so a text-valued fact cannot flow through the computation layer at all.
  // It reaches a policy the other way: a condition compares it with `eq` against a state name.

  // Company fundamentals derived from filings, beyond the seven the mechanical screen computes.
  "financial.owner_earnings": Object.freeze({ value_kind: "monetary", unit: "currency_units", period: duration("P1Y") }),
  "financial.net_current_asset_value": Object.freeze({ value_kind: "monetary", unit: "currency_units", period: INSTANT_AS_OF }),
  "financial.incremental_return_on_capital": Object.freeze({ value_kind: "ratio", unit: "decimal", period: duration("P5Y") }),
  "financial.leverage": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "valuation.revenue_growth": Object.freeze({ value_kind: "ratio", unit: "decimal", period: duration(ANY_REPORTING_INTERVAL) }),
  "valuation.downside_asset_value": Object.freeze({ value_kind: "monetary", unit: "currency_units", period: INSTANT_AS_OF }),
  "valuation.downside_floor": Object.freeze({ value_kind: "monetary", unit: "currency_units", period: INSTANT_AS_OF }),
  // Shares outstanding is measured AT a date, not over one. The filing reports it inside a
  // fiscal year, which is where the interval came from, but a count is an instant quantity --
  // and a fund's share count, which carries no fiscal year at all, could satisfy no duration.
  "capital_allocation.share_count": Object.freeze({ value_kind: "count", unit: "shares", period: INSTANT_AS_OF }),

  // Basket-level facts. Without these an index or fund method has nothing to reason about,
  // which is why every seat abstained on an ETF regardless of how well it was written.
  "index.aggregate_pe_ttm": Object.freeze({ value_kind: "ratio", unit: "multiple", period: INSTANT_AS_OF }),
  "index.aggregate_pe_forward": Object.freeze({ value_kind: "ratio", unit: "multiple", period: INSTANT_AS_OF }),
  "index.aggregate_earnings_yield": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "index.dividend_yield": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "fund.top_ten_weight": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "fund.concentration_hhi": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "valuation.implied_erp": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "cycle.valuation_percentile": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "index.breadth_above_200dma": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "index.breadth_counted_above_200dma": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "fund.aum": Object.freeze({ value_kind: "monetary", unit: "currency_units", period: INSTANT_AS_OF }),
  "fund.expense_ratio": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  // Creations minus redemptions, priced. A crowding signal, never a valuation one.
  // What else the holding is a bet on. Correlation decides what a position actually
  // diversifies; dispersion says whether one factor or many are repricing the market.
  "market.correlation_to_broad_market": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "market.correlation_to_kospi": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "market.correlation_to_kosdaq": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "market.correlation_to_semiconductors": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "market.sector_dispersion": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
  "fund.net_flow": Object.freeze({ value_kind: "monetary", unit: "currency_units", period: INSTANT_AS_OF }),
  "fund.net_flow_ratio": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),

  // The US has no promoter shareholding record. Section 16 ownership is the filed analogue,
  // and it is what lets a governance-first method reach a number on this universe at all.
  "governance.insider_ownership": Object.freeze({ value_kind: "ratio", unit: "decimal", period: INSTANT_AS_OF }),
});

const ID = /^[a-z][a-z0-9_.:-]{1,159}$/u;

export class PersonaV3SoloFormulaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaV3SoloFormulaError";
    this.details = canonicalValue(details);
  }
}

function fail(message, details = {}) {
  throw new PersonaV3SoloFormulaError(message, details);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function physicalStagingRoot(root, expectedBasename, label, { requireExisting = true } = {}) {
  const resolved = resolve(root);
  if (basename(resolved) !== expectedBasename) fail(`${label} basename must be ${expectedBasename}`);
  const isolated = resolved.split(sep).includes("staging") || basename(dirname(resolved)) === "solo-test";
  if (!isolated) fail(`${label} must be below an isolated staging or solo-test directory`);
  if (!existsSync(resolved)) {
    if (requireExisting) fail(`${label} is missing: ${resolved}`);
    return resolved;
  }
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} must be a plain directory`);
  const physical = realpathSync(resolved);
  const physicalIsolated = physical.split(sep).includes("staging") || basename(dirname(physical)) === "solo-test";
  if (!physicalIsolated) fail(`${label} must physically resolve below an isolated formula directory`);
  return physical;
}

function readPlainJson(root, relativePath, label) {
  const file = resolve(root, relativePath);
  if (!inside(root, file) || !existsSync(file)) fail(`${label} is missing: ${relativePath}`);
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be a plain file: ${relativePath}`);
  const physical = realpathSync(file);
  if (!inside(root, physical)) fail(`${label} escapes its root: ${relativePath}`);
  try {
    return JSON.parse(readFileSync(physical, "utf8"));
  } catch (error) {
    fail(`${label} is invalid JSON: ${relativePath} (${error.message})`);
  }
}

function collectFiles(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) fail(`solo formula input contains a symlink: ${prefix}${entry.name}`);
    const path = resolve(dir, entry.name);
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...collectFiles(path, `${relativePath}/`));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(relativePath);
    else fail(`solo formula input contains an unsupported entry: ${relativePath}`);
  }
  return files;
}

function exactPendingCandidate(entry, candidateRoot) {
  const relativePath = formulaSpecCandidateRelativePath(entry.persona_id, entry.tool_id);
  const spec = readPlainJson(candidateRoot, relativePath, "formula authoring candidate");
  const errors = validateFormulaSpec(spec);
  if (errors.length) fail(`${entry.tool_id}: authoring candidate is invalid`, { errors });
  if (spec.artifact_status !== FORMULA_AUTHORING_STATUS
    || spec.formula !== null
    || spec.provenance !== null
    || spec.review?.status !== "pending_human_adjudication"
    || spec.review?.reviewer_ids?.length !== 0) {
    fail(`${entry.tool_id}: solo derivation only accepts an unsigned, unreviewed pending candidate`);
  }
  if (JSON.stringify(canonicalValue(spec)) !== JSON.stringify(canonicalValue(entry.formula_spec))) {
    fail(`${entry.tool_id}: physical authoring candidate drifted from the current bound prototype`);
  }
  return spec;
}

/**
 * The formula a seat's method actually needs, when one has been authored for it.
 *
 * Everything else in this module derives an identity proxy, which is executable and
 * deliberately meaningless: it exists so the pipeline can be exercised before any method has
 * been written. An authored formula replaces that with the seat's real arithmetic, still
 * unreviewed and still barred from production, but no longer a placeholder pretending to be a
 * computation. Both paths are validated identically downstream.
 */
function authoredFormula(spec, authored) {
  const tool = (authored?.tools || []).find((candidate) => candidate.tool_id === spec.tool_id);
  if (!tool) return null;
  // The per-tool candidate lists are a generated projection of the authored tools themselves,
  // so checking one against the other proves nothing. What still has to hold is that every
  // input names a real fact and the output is the one the spec was regenerated to expect --
  // the meaningful contract check happens downstream, where the policy validator rejects any
  // condition reading a fact the seat did not declare.
  for (const operand of tool.inputs || []) {
    if (operand?.fact_id && !ID.test(operand.fact_id)) {
      fail(`${spec.tool_id}: authored input ${JSON.stringify(operand.fact_id)} is not a valid fact id`);
    }
  }
  if (!ID.test(tool.output_id || "")) {
    fail(`${spec.tool_id}: authored output ${JSON.stringify(tool.output_id)} is not a valid output id`);
  }
  const contractFor = (operand) => {
    if (operand?.literal !== undefined) {
      return { value_kind: "scalar", unit: SOLO_TEST_PROXY_UNIT, period: INSTANT_AS_OF };
    }
    if (operand?.fact_id) {
      return CANONICAL_SOLO_TEST_FACT_CONTRACTS[operand.fact_id]
        || { value_kind: "scalar", unit: SOLO_TEST_PROXY_UNIT, period: INSTANT_AS_OF };
    }
    // An output operand carries the PRODUCING tool's contract, not the consuming one's. The
    // executor compares against what the producer declared, so reading the consumer's kind
    // breaks every tool that divides a monetary numerator by a monetary denominator to make
    // a ratio -- which is most of what a valuation method does.
    if (operand?.output_id) {
      const producer = (authored?.tools || []).find((candidate) => candidate.output_id === operand.output_id);
      if (producer) return { value_kind: producer.value_kind, unit: producer.unit, period: INSTANT_AS_OF };
      return { value_kind: "scalar", unit: SOLO_TEST_PROXY_UNIT, period: INSTANT_AS_OF };
    }
    return { value_kind: tool.value_kind, unit: tool.unit, period: INSTANT_AS_OF };
  };
  return canonicalValue({
    version: "0.2.0",
    kind: "recomputation",
    operation: tool.operation,
    on_missing: "fail",
    inputs: (tool.inputs || []).map((operand) => {
      const contract = contractFor(operand);
      return {
        operand,
        value_kind: contract.value_kind,
        unit: contract.unit,
        period: contract.period,
        on_missing: "fail",
      };
    }),
    output: {
      output_id: tool.output_id,
      value_kind: tool.value_kind,
      unit: tool.unit,
      period: INSTANT_AS_OF,
    },
  });
}

function proxyFormula(spec) {
  const inputFactId = spec.authorship_request.candidate_input_fact_types[0];
  const outputId = spec.authorship_request.candidate_output_fact_types[0];
  if (!ID.test(inputFactId || "") || !ID.test(outputId || "")) {
    fail(`${spec.tool_id}: cannot derive a proxy from empty or invalid fact contracts`);
  }
  const contract = CANONICAL_SOLO_TEST_FACT_CONTRACTS[inputFactId] || Object.freeze({
    value_kind: "scalar",
    unit: SOLO_TEST_PROXY_UNIT,
    period: INSTANT_AS_OF,
  });
  return canonicalValue({
    version: "0.1.0",
    kind: "transform",
    operation: "identity",
    on_missing: "fail",
    inputs: [{
      operand: { fact_id: inputFactId },
      value_kind: contract.value_kind,
      unit: contract.unit,
      period: contract.period,
      on_missing: "fail",
    }],
    output: {
      output_id: outputId,
      value_kind: contract.value_kind,
      unit: contract.unit,
      period: contract.period,
    },
  });
}

/** Create one explicitly non-reviewed derived proxy and its immutable local-test evidence. */
export function deriveSoloTestFormula(entry, physicalCandidate, authored = null) {
  if (physicalCandidate.formula_spec_id !== entry.formula_spec.formula_spec_id) {
    fail(`${entry.tool_id}: physical candidate identity does not match the current queue`);
  }
  const written = authoredFormula(physicalCandidate, authored);
  const formula = written || proxyFormula(physicalCandidate);
  const derivationSpec = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_provisional_formula_derivation_spec",
    assurance_class: PROVISIONAL_DERIVED_PROXY_ASSURANCE,
    derivation_spec_id: `${entry.prototype_id}.derived_proxy_v1`,
    persona_id: entry.persona_id,
    tool_id: entry.tool_id,
    prototype_id: entry.prototype_id,
    prototype_content_hash: entry.source_prototype.content_hash,
    authoring_candidate_hash: sha256(physicalCandidate),
    derivation_policy: written
      ? "ai_authored_method_formula_v1"
      : "first_declared_input_to_first_declared_output_identity_v1",
    input_contract_source: CANONICAL_SOLO_TEST_FACT_CONTRACTS[formula.inputs[0].operand.fact_id]
      ? "grounding_adapter_canonical_contract_v1"
      : "unknown_fact_fail_closed_proxy_scalar_v1",
    formula,
  });
  const derivationSpecHash = sha256(derivationSpec);
  const evidence = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_provisional_formula_derivation_evidence",
    assurance_class: PROVISIONAL_DERIVED_PROXY_ASSURANCE,
    review_status: SOLO_TEST_REVIEW_STATUS,
    intended_use: SOLO_TEST_INTENDED_USE,
    production_effect: "none",
    production_eligible: false,
    method_model_eligible: false,
    human_reviewer_ids: [],
    signature_count: 0,
    derivation_spec: derivationSpec,
    derivation_spec_hash: derivationSpecHash,
    limitations: [
      ...(written
        ? [
          "ai_authored_candidate_formula_not_human_reviewed",
          "thresholds_are_derived_from_published_method_writing_not_adjudicated",
        ]
        : [
          "mechanical_identity_proxy_not_the_named_investor_method",
          "first_declared_input_and_output_are_test_contract_choices_not_human_adjudication",
        ]),
      ...(derivationSpec.input_contract_source === "unknown_fact_fail_closed_proxy_scalar_v1"
        ? ["unknown_fact_proxy_scalar_unit_requires_a_local_test_adapter"]
        : []),
      "no_human_formula_review_or_cryptographic_approval_exists",
      "must_not_be_used_for_production_admission_release_or_method_model_claims",
    ],
  });
  const sourceIds = [`derived_proxy:${entry.prototype_id}`];
  const record = canonicalValue({
    schema_version: 1,
    dsl_version: FORMULA_DSL_VERSION,
    id: entry.tool_id,
    version: formula.version,
    kind: formula.kind,
    operation: formula.operation,
    on_missing: formula.on_missing,
    inputs: formula.inputs.map((input) => input.operand),
    input_contracts: formula.inputs.map(({ operand: _operand, ...contract }) => contract),
    output_id: formula.output.output_id,
    value_kind: formula.output.value_kind,
    unit: formula.output.unit,
    output_period: formula.output.period,
    source_ids: sourceIds,
    assurance_class: PROVISIONAL_DERIVED_PROXY_ASSURANCE,
    review_status: SOLO_TEST_REVIEW_STATUS,
    intended_use: SOLO_TEST_INTENDED_USE,
    production_eligible: false,
    derivation_spec_id: derivationSpec.derivation_spec_id,
    derivation_spec_hash: derivationSpecHash,
    derivation_evidence_hash: sha256(evidence),
  });
  const tool = Object.freeze(canonicalValue({ ...record, ...deterministicToolSchemaHashes(record) }));
  return Object.freeze({ tool, evidence: Object.freeze(evidence) });
}

/**
 * Verify the physical 52-entry pending queue and derive executable local-test proxies.
 * Formal approved compilation remains a separate path and is not consulted or weakened.
 */
export function planSoloTestFormulaCompilation({
  candidateRoot = DEFAULT_FORMULA_CANDIDATE_ROOT,
  root = defaultStagingRoot(),
} = {}) {
  const candidate = physicalStagingRoot(
    candidateRoot,
    FORMULA_CANDIDATE_DIRNAME,
    "formula candidate root",
  );
  const authoring = planPersonaV3FormulaPipeline({ root });
  if (authoring.errors.length) fail("formula prototype inventory is invalid", { errors: authoring.errors });

  const expectedSpecFiles = authoring.inventory.entries.map((entry) => (
    formulaSpecCandidateRelativePath(entry.persona_id, entry.tool_id).slice("specs/".length)
  )).sort();
  const actualSpecFiles = collectFiles(resolve(candidate, "specs"));
  if (JSON.stringify(actualSpecFiles) !== JSON.stringify(expectedSpecFiles)) {
    fail("solo formula compilation requires exactly the planned pending spec files, one per tool", {
      expected: expectedSpecFiles,
      actual: actualSpecFiles,
    });
  }
  const approvalFiles = collectFiles(resolve(candidate, "approvals"));
  if (approvalFiles.length) {
    fail("solo formula compilation refuses approval artifacts; use --compile-approved for reviewed specs", {
      approval_files: approvalFiles,
    });
  }

  const records = authoring.inventory.entries.map((entry) => {
    const spec = exactPendingCandidate(entry, candidate);
    const derived = deriveSoloTestFormula(entry, spec, authoredMethods[entry.persona_id] || null);
    return { entry, ...derived };
  });
  const tools = records.map((record) => record.tool);
  const ids = tools.map((tool) => tool.id);
  const outputs = tools.map((tool) => tool.output_id);
  // Derived from the authoring inventory rather than hardcoded, so a seat may declare a third
  // tool without the guard reading it as drift. The property that matters is unchanged: one
  // tool per planned entry, no id or output silently collapsing into another.
  const expectedToolCount = authoring.inventory.entries.length;
  if (tools.length !== expectedToolCount
    || new Set(ids).size !== expectedToolCount
    || new Set(outputs).size !== expectedToolCount) {
    fail("solo formula compilation must produce one unique tool and output per planned entry", {
      expected: expectedToolCount,
      tool_count: tools.length,
      unique_tool_count: new Set(ids).size,
      unique_output_count: new Set(outputs).size,
    });
  }
  const bindings = records.map(({ entry, tool }) => canonicalValue({
    persona_id: entry.persona_id,
    tool_id: tool.id,
    assurance_class: tool.assurance_class,
    review_status: tool.review_status,
    production_eligible: tool.production_eligible,
    derivation_spec_id: tool.derivation_spec_id,
    derivation_spec_hash: tool.derivation_spec_hash,
    derivation_evidence_hash: tool.derivation_evidence_hash,
    source_ids: tool.source_ids,
  }));
  const stable = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_solo_test_formula_compilation",
    mode: "check_only",
    assurance_class: PROVISIONAL_DERIVED_PROXY_ASSURANCE,
    review_status: SOLO_TEST_REVIEW_STATUS,
    intended_use: SOLO_TEST_INTENDED_USE,
    production_effect: "none",
    production_eligible: false,
    method_model_eligible: false,
    canonical_seat_count: CANONICAL_MASTER_COUNT,
    planned_tool_count: PLANNED_TOOL_COUNT,
    compiled_tool_count: tools.length,
    provisional_derivation_count: records.length,
    formula_approval_binding_count: 0,
    human_reviewer_count: 0,
    signature_count: 0,
    tool_ids: ids,
    bindings,
  });
  return Object.freeze({
    ...stable,
    compilation_hash: sha256(stable),
    tools: Object.freeze(tools),
    evidence: Object.freeze(records.map((record) => record.evidence)),
  });
}

function writeStable(file, content, result) {
  const parent = dirname(file);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (lstatSync(parent).isSymbolicLink() || !statSync(parent).isDirectory()) fail(`unsafe solo formula directory: ${parent}`);
  if (existsSync(file)) {
    if (lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) fail(`unsafe solo formula file: ${file}`);
    if (readFileSync(file, "utf8") === content) {
      result.unchanged.push(file);
      return;
    }
  }
  writeFileSync(file, content, { encoding: "utf8", mode: 0o644 });
  result.written.push(file);
}

/** Delete every regular file under `root` the compilation did not just account for. */
function pruneToWritten(root, keep) {
  const removed = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) fail(`unsafe solo formula entry: ${path}`);
      if (entry.isDirectory()) {
        walk(path);
        if (!readdirSync(path).length) { rmSync(path, { recursive: false }); removed.push(path); }
        continue;
      }
      if (!keep.has(path)) { rmSync(path); removed.push(path); }
    }
  };
  walk(root);
  return removed;
}

function evidenceLeaf(personaId, toolId) {
  const prefix = `${personaId}.`;
  if (!toolId.startsWith(prefix)) fail(`tool id is not prefixed by ${personaId}`);
  const leaf = toolId.slice(prefix.length);
  if (!/^[a-z][a-z0-9_.-]{1,119}$/u.test(leaf)) fail(`unsafe tool id: ${toolId}`);
  return `${leaf}.derived-proxy-evidence.json`;
}

/** Write the proxies only to an isolated solo-test tree; never to a production pack or release root. */
export function writeSoloTestFormulaCompilation({
  outputRoot = DEFAULT_SOLO_TEST_FORMULA_ROOT,
  ...options
} = {}) {
  const plan = planSoloTestFormulaCompilation(options);
  const root = physicalStagingRoot(
    outputRoot,
    SOLO_TEST_FORMULA_DIRNAME,
    "solo formula output root",
    { requireExisting: false },
  );
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const result = { written: [], unchanged: [] };
  for (const personaId of CANONICAL_MASTER_IDS) {
    const tools = plan.tools.filter((tool) => tool.id.startsWith(`${personaId}.`));
    const evidence = plan.evidence.filter((record) => record.derivation_spec.persona_id === personaId);
    writeStable(resolve(root, personaId, "components/tools.json"), `${JSON.stringify(tools, null, 2)}\n`, result);
    for (const record of evidence) {
      writeStable(
        resolve(root, personaId, "provisional-derivations", evidenceLeaf(personaId, record.derivation_spec.tool_id)),
        `${JSON.stringify(record, null, 2)}\n`,
        result,
      );
    }
  }
  const manifest = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_solo_test_formula_staging_tree",
    assurance_class: plan.assurance_class,
    review_status: plan.review_status,
    intended_use: plan.intended_use,
    production_effect: "none",
    production_eligible: false,
    method_model_eligible: false,
    canonical_seat_count: plan.canonical_seat_count,
    compiled_tool_count: plan.compiled_tool_count,
    provisional_derivation_count: plan.provisional_derivation_count,
    formula_approval_binding_count: 0,
    human_reviewer_count: 0,
    signature_count: 0,
    compilation_hash: plan.compilation_hash,
    bindings: plan.bindings,
  });
  writeStable(resolve(root, "compilation-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, result);
  // A tool that is renamed leaves its old evidence file behind, and the downstream review binds
  // the tree by exact file list -- so debris from a previous compilation reads as tampering
  // rather than as staleness. The compilation owns this tree entirely; anything it did not just
  // write does not belong in it.
  result.removed = pruneToWritten(root, new Set([...result.written, ...result.unchanged]));
  return Object.freeze(canonicalValue({
    ...manifest,
    mode: "write_isolated_solo_test_compilation",
    output_root: root,
    written: result.written.map((file) => relative(root, file).split(sep).join("/")),
    unchanged: result.unchanged.map((file) => relative(root, file).split(sep).join("/")),
  }));
}
