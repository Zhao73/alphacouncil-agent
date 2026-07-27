/**
 * Read-only inspection for the hand-authored PersonaPack v3 production-candidate tree.
 *
 * This layer deliberately does not manufacture manifests or promote editorial drafts. A
 * candidate exists only after a real schema-v3 directory has been authored on disk. The
 * inspector then proves loader/compiler validity, computed admission and coverage of the 52
 * planned seat-specific tools. Immutable release assembly remains a later, separately signed
 * operation.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import buildInventory from "../../data/persona-v3-build-specs.v1.mjs";
import {
  defaultKnowledgeDir,
  inspectPersonaAdmission,
} from "../../mcp/lib/personas-v3/admission.mjs";
import { canonicalValue, sha256 } from "../../mcp/lib/personas-v3/canonical.mjs";
import { compilePersonaPack } from "../../mcp/lib/personas-v3/compiler.mjs";
import {
  formulaApprovalEvidenceRelativePath,
  parseTrustedFormulaReviewKeys,
  verifyFormulaApprovalBundle,
} from "../../mcp/lib/personas-v3/formula-review-attestations.mjs";
import { loadV3Pack } from "../../mcp/lib/personas-v3/loader.mjs";
import {
  CANONICAL_MASTER_COUNT,
  CANONICAL_MASTER_IDS,
  canonicalMasterBlueprints,
  defaultStagingRoot,
} from "../../mcp/lib/personas-v3/staging.mjs";
import { defaultPersonaDir } from "../../mcp/lib/personas/registry.mjs";
import { validateFormulaSpec } from "./persona-v3-formula-pipeline.mjs";

export const PRODUCTION_CANDIDATE_DIRNAME = "persona-v3-production-candidates";
export const DEFAULT_PRODUCTION_CANDIDATE_ROOT = resolve(
  defaultStagingRoot(),
  "..",
  PRODUCTION_CANDIDATE_DIRNAME,
);
export const ADMISSION_ORDER = Object.freeze([
  "prompt_lens",
  "operator_lens",
  "operational",
  "candidate",
  "method_model",
]);

export class PersonaV3ProductionCandidateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "PersonaV3ProductionCandidateError";
    this.details = canonicalValue(details);
  }
}

function fail(message, details = {}) {
  throw new PersonaV3ProductionCandidateError(message, details);
}

function inside(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function prospectivePhysicalPath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) fail(`cannot resolve an existing ancestor for ${path}`);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function hasPathSegment(path, segment) {
  return resolve(path).split(sep).includes(segment);
}

function disjointRoots(first, second) {
  return !inside(first, second) && !inside(second, first);
}

function safeOptionalRoot(root, productionRoot) {
  const resolved = resolve(root);
  if (basename(resolved) !== PRODUCTION_CANDIDATE_DIRNAME) {
    fail(`candidate root basename must be ${PRODUCTION_CANDIDATE_DIRNAME}`);
  }
  if (!hasPathSegment(resolved, "staging")) {
    fail("production candidates may only be inspected below a staging directory");
  }
  const candidateStat = lstatSync(resolved, { throwIfNoEntry: false });
  if (candidateStat?.isSymbolicLink()) fail("candidate root must be a plain directory");
  const physicalTarget = prospectivePhysicalPath(resolved);
  if (!hasPathSegment(physicalTarget, "staging")) {
    fail("production candidate root must physically resolve below a staging directory");
  }
  const physicalProduction = prospectivePhysicalPath(productionRoot);
  if (!disjointRoots(physicalTarget, physicalProduction)) {
    fail("production candidate and production knowledge roots must be physically disjoint");
  }
  if (!candidateStat) return { root: resolved, exists: false };
  if (!candidateStat.isDirectory()) fail("candidate root must be a plain directory");
  return { root: realpathSync(resolved), exists: true };
}

function errorRecord(error) {
  return canonicalValue({
    name: error?.name || "Error",
    message: error?.message || String(error),
  });
}

function toolRecords(pack) {
  const tools = Array.isArray(pack?.components?.tools) ? pack.components.tools : [];
  return tools.filter((tool) => tool && typeof tool === "object" && !Array.isArray(tool));
}

function readFormulaApprovalBundle(packDir, personaId, toolId) {
  const relativePath = formulaApprovalEvidenceRelativePath(personaId, toolId);
  const file = resolve(packDir, relativePath);
  if (!inside(packDir, file) || !existsSync(file)) throw new Error(`missing formula approval evidence: ${relativePath}`);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`formula approval evidence must be a plain file: ${relativePath}`);
  const physical = realpathSync(file);
  if (!inside(packDir, physical)) throw new Error(`formula approval evidence escapes the candidate pack: ${relativePath}`);
  try { return JSON.parse(readFileSync(physical, "utf8")); } catch (error) {
    throw new Error(`invalid formula approval evidence ${relativePath}: ${error.message}`);
  }
}

function verifyToolFormulaApproval({ tool, packDir, personaId, trustedFormulaReviewerKeys, now }) {
  const bundle = readFormulaApprovalBundle(packDir, personaId, tool.id);
  const specErrors = validateFormulaSpec(bundle?.formula_spec);
  if (specErrors.length) throw new Error(`formula spec is invalid: ${specErrors.join("; ")}`);
  const approval = verifyFormulaApprovalBundle(bundle, {
    trustedKeyRegistry: trustedFormulaReviewerKeys,
    now,
    expectedFormulaSpec: bundle.formula_spec,
  });
  if (!approval.valid) throw new Error(`formula approval is invalid: ${approval.reason}`);
  const expected = {
    id: bundle.formula_spec.tool_id,
    formula_spec_id: bundle.formula_spec.formula_spec_id,
    formula_spec_hash: approval.formula_spec_hash,
    formula_review_subject_hash: approval.review_subject_hash,
    approval_bundle_hash: approval.approval_bundle_hash,
    source_ids: bundle.source_ids,
  };
  for (const field of ["id", "formula_spec_id", "formula_spec_hash", "formula_review_subject_hash", "approval_bundle_hash"]) {
    if (tool[field] !== expected[field]) throw new Error(`${tool.id}.${field} does not match formula approval evidence`);
  }
  for (const field of ["source_ids"]) {
    if (JSON.stringify(tool[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`${tool.id}.${field} does not match formula approval evidence`);
    }
  }
  return canonicalValue({
    tool_id: tool.id,
    formula_spec_id: tool.formula_spec_id,
    formula_spec_hash: approval.formula_spec_hash,
    review_subject_hash: approval.review_subject_hash,
    approval_bundle_hash: approval.approval_bundle_hash,
    reviewer_principal_ids: approval.reviewer_principal_ids,
    signer_key_ids: approval.signer_key_ids,
    prototype_content_hash: bundle.prototype_content_hash,
    source_ids: bundle.source_ids,
  });
}

function expectedToolMap() {
  return new Map(buildInventory.seats.map((seat) => [
    seat.persona_id,
    seat.planned_dedicated_tools.map((tool) => tool.tool_id),
  ]));
}

function inspectSeat({
  root,
  blueprint,
  expectedToolIds,
  personaDir,
  loadPack,
  compilePack,
  inspectAdmission,
  trustedFormulaReviewerKeys,
  now,
}) {
  const packDir = resolve(root, blueprint.persona_id);
  const missing = {
    persona_id: blueprint.persona_id,
    status: "missing_physical_candidate",
    physical_pack_present: false,
    loader_valid: false,
    compiler_valid: false,
    admission_level: "prompt_lens",
    operational_clear: false,
    candidate_clear: false,
    method_model_ready: false,
    expected_tool_ids: expectedToolIds,
    present_expected_tool_ids: [],
    missing_expected_tool_ids: expectedToolIds,
    unexpected_tool_ids: [],
    duplicate_tool_ids: [],
    formula_approval_evidence_count: 0,
    formula_approval_bindings: [],
    formula_approval_errors: [],
    pack_hash: null,
    corpus_hash: null,
    policy_hash: null,
    tool_graph_hash: null,
    prompt_hash: null,
    delta_to_operational: {},
    delta_to_candidate: {},
    errors: [],
  };
  if (!existsSync(packDir)) return canonicalValue(missing);
  const stat = lstatSync(packDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return canonicalValue({
      ...missing,
      status: "invalid_physical_candidate",
      physical_pack_present: true,
      errors: [{ name: "UnsafePath", message: "candidate seat must be a plain directory" }],
    });
  }
  const physical = realpathSync(packDir);
  if (!inside(root, physical) || basename(physical) !== blueprint.persona_id) {
    return canonicalValue({
      ...missing,
      status: "invalid_physical_candidate",
      physical_pack_present: true,
      errors: [{ name: "UnsafePath", message: "candidate seat resolves outside its canonical path" }],
    });
  }

  let pack;
  try {
    pack = loadPack(physical);
  } catch (error) {
    return canonicalValue({
      ...missing,
      status: "invalid_physical_candidate",
      physical_pack_present: true,
      errors: [errorRecord(error)],
    });
  }

  const promptFile = resolve(personaDir, blueprint.canonical_prompt_file);
  let compiled;
  try {
    compiled = compilePack(pack, { promptFile });
  } catch (error) {
    return canonicalValue({
      ...missing,
      status: "invalid_physical_candidate",
      physical_pack_present: true,
      loader_valid: true,
      errors: [errorRecord(error)],
    });
  }

  let admission;
  try {
    admission = inspectAdmission({
      persona_id: blueprint.persona_id,
      prompt_file: promptFile,
      pack_dir: physical,
    });
  } catch (error) {
    return canonicalValue({
      ...missing,
      status: "invalid_physical_candidate",
      physical_pack_present: true,
      loader_valid: true,
      compiler_valid: true,
      pack_hash: compiled.pack_hash,
      corpus_hash: compiled.corpus_hash,
      policy_hash: compiled.policy_hash,
      tool_graph_hash: compiled.tool_graph_hash,
      prompt_hash: compiled.prompt_hash,
      errors: [errorRecord(error)],
    });
  }

  const rawTools = Array.isArray(pack?.components?.tools) ? pack.components.tools : [];
  const tools = toolRecords(pack);
  const actualToolIds = tools.map((tool) => tool?.id).filter((id) => typeof id === "string" && id.trim());
  const expectedSet = new Set(expectedToolIds);
  const duplicateToolIds = [...new Set(actualToolIds.filter((id, index) => actualToolIds.indexOf(id) !== index))].sort();
  const presentExpected = expectedToolIds.filter((id) => actualToolIds.includes(id));
  const missingExpected = expectedToolIds.filter((id) => !actualToolIds.includes(id));
  const unexpected = actualToolIds.filter((id) => !expectedSet.has(id));
  const errors = [];
  if (rawTools.length !== tools.length) errors.push({
    name: "InvalidToolEntryError",
    message: "every candidate tool entry must be one exact object",
  });
  if (missingExpected.length) errors.push({
    name: "PlannedToolCoverageError",
    message: `missing planned tools: ${missingExpected.join(", ")}`,
  });
  if (duplicateToolIds.length) errors.push({
    name: "DuplicatePlannedToolError",
    message: `duplicate planned tools: ${duplicateToolIds.join(", ")}`,
  });
  if (unexpected.length) errors.push({
    name: "UnexpectedToolError",
    message: `unexpected tools: ${unexpected.join(", ")}`,
  });
  const formulaApprovalBindings = [];
  const formulaApprovalErrors = [];
  for (const toolId of expectedToolIds) {
    const matching = tools.filter((tool) => tool.id === toolId);
    if (matching.length !== 1) continue;
    try {
      formulaApprovalBindings.push(verifyToolFormulaApproval({
        tool: matching[0], packDir: physical, personaId: blueprint.persona_id,
        trustedFormulaReviewerKeys, now,
      }));
    } catch (error) {
      formulaApprovalErrors.push({ tool_id: toolId, name: error?.name || "Error", message: error.message });
    }
  }
  if (formulaApprovalErrors.length) errors.push({
    name: "FormulaApprovalEvidenceError",
    message: formulaApprovalErrors.map((error) => `${error.tool_id}: ${error.message}`).join("; "),
  });
  if (admission.source_anchor_errors?.length) errors.push({
    name: "SourceAnchorError",
    message: admission.source_anchor_errors.join("; "),
  });
  const exactToolSet = rawTools.length === expectedToolIds.length
    && tools.length === expectedToolIds.length
    && actualToolIds.length === expectedToolIds.length
    && missingExpected.length === 0 && unexpected.length === 0 && duplicateToolIds.length === 0;
  const formulaEvidenceClear = formulaApprovalBindings.length === expectedToolIds.length
    && formulaApprovalErrors.length === 0;
  const operational = admission.operational_clear === true && exactToolSet && formulaEvidenceClear;
  const status = operational ? "operational_candidate_ready" : "physical_candidate_incomplete";
  return canonicalValue({
    persona_id: blueprint.persona_id,
    status,
    physical_pack_present: true,
    loader_valid: true,
    compiler_valid: true,
    admission_level: admission.admission_level,
    operational_clear: operational,
    candidate_clear: admission.candidate_clear === true && missingExpected.length === 0,
    method_model_ready: admission.method_model_ready === true && missingExpected.length === 0,
    expected_tool_ids: expectedToolIds,
    present_expected_tool_ids: presentExpected,
    missing_expected_tool_ids: missingExpected,
    unexpected_tool_ids: unexpected,
    duplicate_tool_ids: duplicateToolIds,
    formula_approval_evidence_count: formulaApprovalBindings.length,
    formula_approval_bindings: formulaApprovalBindings,
    formula_approval_errors: formulaApprovalErrors,
    pack_hash: compiled.pack_hash,
    corpus_hash: compiled.corpus_hash,
    policy_hash: compiled.policy_hash,
    tool_graph_hash: compiled.tool_graph_hash,
    prompt_hash: compiled.prompt_hash,
    delta_to_operational: admission.delta_to_operational,
    delta_to_candidate: admission.delta_to_candidate,
    errors,
  });
}

/**
 * Inspect an incremental candidate tree without granting production or release status.
 * Missing packs are reported as work items, not synthesized from editorial drafts.
 */
export function inspectPersonaV3ProductionCandidates({
  root = DEFAULT_PRODUCTION_CANDIDATE_ROOT,
  productionRoot = defaultKnowledgeDir(),
  personaDir = defaultPersonaDir(),
  requiredAdmission = "operational",
  loadPack = loadV3Pack,
  compilePack = compilePersonaPack,
  inspectAdmission = inspectPersonaAdmission,
  trustedFormulaReviewerKeys = parseTrustedFormulaReviewKeys(),
  now = new Date(),
} = {}) {
  if (!ADMISSION_ORDER.slice(2).includes(requiredAdmission)) {
    fail("required admission must be operational, candidate or method_model");
  }
  const candidateRoot = safeOptionalRoot(root, productionRoot);
  const resolvedPersonaDir = resolve(personaDir);
  const blueprints = canonicalMasterBlueprints({ personaDir: resolvedPersonaDir });
  const expectedByPersona = expectedToolMap();
  const inventoryErrors = [];
  if (buildInventory.seat_count !== CANONICAL_MASTER_COUNT) inventoryErrors.push("build-spec seat count is not 26");
  const expectedToolCount = [...expectedByPersona.values()].reduce((total, ids) => total + ids.length, 0);
  if (expectedToolCount !== 52) inventoryErrors.push(`build-spec tool count is not 52: ${expectedToolCount}`);

  const actualEntries = candidateRoot.exists
    ? readdirSync(candidateRoot.root, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith("."))
    : [];
  const canonicalSet = new Set(CANONICAL_MASTER_IDS);
  const unexpectedEntries = actualEntries.map((entry) => entry.name)
    .filter((name) => !canonicalSet.has(name)).sort();
  if (unexpectedEntries.length) inventoryErrors.push(`unexpected candidate entries: ${unexpectedEntries.join(", ")}`);

  const seats = blueprints.map((blueprint) => inspectSeat({
    root: candidateRoot.root,
    blueprint,
    expectedToolIds: expectedByPersona.get(blueprint.persona_id) || [],
    personaDir: resolvedPersonaDir,
    loadPack,
    compilePack,
    inspectAdmission,
    trustedFormulaReviewerKeys,
    now,
  }));
  const physicalCount = seats.filter((seat) => seat.physical_pack_present).length;
  const loaderValidCount = seats.filter((seat) => seat.loader_valid).length;
  const operationalCount = seats.filter((seat) => seat.operational_clear).length;
  const candidateCount = seats.filter((seat) => seat.candidate_clear).length;
  const methodModelCount = seats.filter((seat) => seat.method_model_ready).length;
  const plannedToolCount = seats.reduce((total, seat) => total + seat.present_expected_tool_ids.length, 0);
  const formulaApprovalEvidenceCount = seats.reduce((total, seat) => total + seat.formula_approval_evidence_count, 0);
  const requiredCount = requiredAdmission === "operational"
    ? operationalCount : requiredAdmission === "candidate" ? candidateCount : methodModelCount;
  const gateClear = inventoryErrors.length === 0
    && requiredCount === CANONICAL_MASTER_COUNT
    && plannedToolCount === expectedToolCount
    && formulaApprovalEvidenceCount === expectedToolCount
    && seats.every((seat) => seat.unexpected_tool_ids.length === 0 && seat.duplicate_tool_ids.length === 0);
  const stable = canonicalValue({
    schema_version: 1,
    artifact_kind: "persona_v3_production_candidate_readiness",
    production_effect: "none",
    candidate_root: candidateRoot.root,
    candidate_root_exists: candidateRoot.exists,
    required_admission: requiredAdmission,
    canonical_seat_count: CANONICAL_MASTER_COUNT,
    expected_planned_tool_count: expectedToolCount,
    inventory_errors: inventoryErrors,
    unexpected_entries: unexpectedEntries,
    summary: {
      physical_candidate_count: physicalCount,
      loader_valid_count: loaderValidCount,
      operational_candidate_count: operationalCount,
      candidate_admission_count: candidateCount,
      method_model_count: methodModelCount,
      planned_tool_coverage_count: plannedToolCount,
      formula_approval_evidence_count: formulaApprovalEvidenceCount,
      missing_physical_candidate_count: CANONICAL_MASTER_COUNT - physicalCount,
      missing_planned_tool_count: expectedToolCount - plannedToolCount,
      missing_formula_approval_evidence_count: expectedToolCount - formulaApprovalEvidenceCount,
      gate_clear: gateClear,
      release_assembled: false,
      production_promoted: false,
    },
    seats,
  });
  return Object.freeze(canonicalValue({ ...stable, readiness_hash: sha256(stable) }));
}

export function renderPersonaV3ProductionCandidateReadiness(report) {
  const lines = [
    "# PersonaPack v3 production-candidate readiness",
    "",
    "> Read-only staging report. Physical presence is not source approval, experiment passage, release assembly or production promotion.",
    "",
    `Physical candidates: ${report.summary.physical_candidate_count}/26`,
    `Loader-valid candidates: ${report.summary.loader_valid_count}/26`,
    `Operational candidates: ${report.summary.operational_candidate_count}/26`,
    `Candidate admissions: ${report.summary.candidate_admission_count}/26`,
    `Method models: ${report.summary.method_model_count}/26`,
    `Planned tool coverage: ${report.summary.planned_tool_coverage_count}/52`,
    `Verified formula approvals: ${report.summary.formula_approval_evidence_count}/52`,
    `Required admission: ${report.required_admission}`,
    `Gate clear: ${report.summary.gate_clear}`,
    `Readiness hash: \`${report.readiness_hash}\``,
    "",
    "| Persona | Physical | Load | Admission | Planned tools | Status |",
    "|---|---:|---:|---|---:|---|",
  ];
  for (const seat of report.seats) {
    lines.push(`| \`${seat.persona_id}\` | ${seat.physical_pack_present ? "yes" : "no"} | ${seat.loader_valid ? "yes" : "no"} | \`${seat.admission_level}\` | ${seat.present_expected_tool_ids.length}/${seat.expected_tool_ids.length} | \`${seat.status}\` |`);
  }
  if (report.inventory_errors.length) {
    lines.push("", "Inventory errors:", "", ...report.inventory_errors.map((error) => `- ${error}`));
  }
  lines.push("");
  return lines.join("\n");
}
