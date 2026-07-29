import { CANONICAL_MASTER_COUNT } from "../../mcp/lib/personas-v3/staging.mjs";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { personaV3BuildSpecs } from "../../data/persona-v3-build-specs.v1.mjs";
import { knownSelectorCardIds } from "../../mcp/lib/master-catalog.mjs";
import { registry } from "../../mcp/lib/personas/registry.mjs";
import { loadPacks } from "../../mcp/lib/personas-v2/loader.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");
const FACT_ID = /^[a-z0-9_.:-]{3,160}$/;
const SAFE_ID = /^[a-z0-9_]+$/;
const URL = /(?:https?:\/\/|www\.)/i;
const CASE_MINIMUMS = Object.freeze({ decision: 5, failure: 3, counterfactual: 20, golden: 12 });
const PENDING = "pending_human_adjudication";

function add(errors, personaId, message) {
  errors.push(`${personaId ? `${personaId}: ` : ""}${message}`);
}

function duplicates(values) {
  const seen = new Set();
  const duplicate = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
}

function exactKeys(value, allowed, path, personaId, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    add(errors, personaId, `${path} must be an object`);
    return;
  }
  const present = Object.keys(value);
  const missing = allowed.filter((key) => !(key in value));
  const extra = present.filter((key) => !allowed.includes(key));
  if (missing.length) add(errors, personaId, `${path} is missing keys: ${missing.join(", ")}`);
  if (extra.length) add(errors, personaId, `${path} has unsupported keys: ${extra.join(", ")}`);
}

function stringsIn(value, path = "$", found = []) {
  if (typeof value === "string") found.push([path, value]);
  else if (Array.isArray(value)) value.forEach((item, index) => stringsIn(item, `${path}[${index}]`, found));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) stringsIn(item, `${path}.${key}`, found);
  }
  return found;
}

function keysIn(value, path = "$", found = []) {
  if (Array.isArray(value)) value.forEach((item, index) => keysIn(item, `${path}[${index}]`, found));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      found.push([`${path}.${key}`, key]);
      keysIn(item, `${path}.${key}`, found);
    }
  }
  return found;
}

function safeRepoFile(file, personaId, errors) {
  if (typeof file !== "string" || !file || isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
    add(errors, personaId, `unsafe repository path ${JSON.stringify(file)}`);
    return null;
  }
  const absolute = resolve(REPO_ROOT, file);
  const rel = relative(REPO_ROOT, absolute);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    add(errors, personaId, `path leaves repository ${JSON.stringify(file)}`);
    return null;
  }
  if (!existsSync(absolute)) {
    add(errors, personaId, `referenced material does not exist: ${file}`);
    return null;
  }
  const real = realpathSync(absolute);
  const realRel = relative(realpathSync(REPO_ROOT), real);
  if (!realRel || realRel.startsWith(`..${sep}`) || realRel === ".." || isAbsolute(realRel)) {
    add(errors, personaId, `referenced material resolves outside repository: ${file}`);
    return null;
  }
  return absolute;
}

function promptMetadata(file, personaId, errors) {
  const text = readFileSync(file, "utf8");
  const match = text.match(/^---json\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) {
    add(errors, personaId, "prompt has no JSON frontmatter");
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    add(errors, personaId, `prompt frontmatter is invalid JSON: ${error.message}`);
    return null;
  }
}

function requireStrings(values, minimum, path, personaId, errors, pattern = null) {
  if (!Array.isArray(values) || values.length < minimum) {
    add(errors, personaId, `${path} must contain at least ${minimum} entries`);
    return;
  }
  const invalid = values.filter((value) => typeof value !== "string" || value.trim().length < 3 || (pattern && !pattern.test(value)));
  if (invalid.length) add(errors, personaId, `${path} contains invalid strings`);
  const dupes = duplicates(values);
  if (dupes.length) add(errors, personaId, `${path} contains duplicates: ${dupes.join(", ")}`);
}

function validateSeat(seat, expectedId, legacyIds, errors) {
  const id = typeof seat?.persona_id === "string" ? seat.persona_id : expectedId;
  if (!seat || typeof seat !== "object" || Array.isArray(seat)) {
    add(errors, expectedId, "seat must be an object");
    return;
  }
  exactKeys(seat, [
    "persona_id", "build_status", "current_material", "method_scope", "required_fact_types",
    "native_decision_contract", "planned_dedicated_tools", "veto_families",
    "primary_source_acquisition_targets", "case_acquisition_targets", "known_limits",
    "human_adjudication",
  ], "seat", id, errors);
  if (id !== expectedId) add(errors, id, `catalog order mismatch; expected ${expectedId}`);
  if (!/^master_[a-z0-9_]+$/.test(id)) add(errors, id, "persona_id is invalid");
  if (seat.build_status !== "spec_only") add(errors, id, "build_status must remain spec_only");

  const material = seat.current_material || {};
  exactKeys(material, ["prompt_path", "material_level", "legacy_v2_manifest"], "current_material", id, errors);
  const promptFile = safeRepoFile(material.prompt_path, id, errors);
  if (promptFile) {
    const metadata = promptMetadata(promptFile, id, errors);
    if (metadata?.id !== id) add(errors, id, `prompt metadata id is ${JSON.stringify(metadata?.id)}`);
    if (metadata?.schema_version !== 1) add(errors, id, `build spec prompt must be legacy schema v1, got ${JSON.stringify(metadata?.schema_version)}`);
    if (metadata?.kind !== "master") add(errors, id, `prompt kind must be master, got ${JSON.stringify(metadata?.kind)}`);
  }
  const hasLegacyV2 = legacyIds.has(id);
  const expectedLevel = hasLegacyV2 ? "v2_operator" : "v1_prompt";
  if (material.material_level !== expectedLevel) add(errors, id, `material_level must be ${expectedLevel}`);
  if (hasLegacyV2) {
    const legacyFile = safeRepoFile(material.legacy_v2_manifest, id, errors);
    if (legacyFile) {
      const manifest = JSON.parse(readFileSync(legacyFile, "utf8"));
      if (manifest.persona_id !== id || manifest.schema_version !== 2) add(errors, id, "legacy_v2_manifest does not identify this v2 seat");
    }
  } else if (material.legacy_v2_manifest !== null) {
    add(errors, id, "legacy_v2_manifest must be null when no physical v2 pack exists");
  }

  const scope = seat.method_scope || {};
  exactKeys(scope, ["planning_hypothesis", "applicable_domains", "excluded_claims"], "method_scope", id, errors);
  if (typeof scope.planning_hypothesis !== "string" || scope.planning_hypothesis.length < 20) add(errors, id, "method scope must be a substantive planning hypothesis");
  requireStrings(scope.applicable_domains, 1, "method_scope.applicable_domains", id, errors);
  requireStrings(scope.excluded_claims, 2, "method_scope.excluded_claims", id, errors);
  requireStrings(seat.required_fact_types, 4, "required_fact_types", id, errors, FACT_ID);

  const decision = seat.native_decision_contract || {};
  exactKeys(decision, ["schema_id", "implementation_status", "eligibility_facts", "states", "required_outputs", "fail_closed_reasons"], "native_decision_contract", id, errors);
  if (!SAFE_ID.test(decision.schema_id || "") || !String(decision.schema_id || "").endsWith("_v1")) add(errors, id, "native decision schema_id is invalid");
  if (decision.implementation_status !== "planned_unverified") add(errors, id, "native decision must remain planned_unverified");
  requireStrings(decision.eligibility_facts, 2, "native_decision_contract.eligibility_facts", id, errors);
  requireStrings(decision.states, 4, "native_decision_contract.states", id, errors);
  requireStrings(decision.required_outputs, 3, "native_decision_contract.required_outputs", id, errors);
  requireStrings(decision.fail_closed_reasons, 3, "native_decision_contract.fail_closed_reasons", id, errors);

  if (!Array.isArray(seat.planned_dedicated_tools) || seat.planned_dedicated_tools.length < 2) {
    add(errors, id, "at least two dedicated tools must be planned");
  } else {
    for (const tool of seat.planned_dedicated_tools) {
      exactKeys(tool, ["tool_id", "purpose", "output_fact_types", "implementation_status"], "planned_dedicated_tools[]", id, errors);
      if (!String(tool?.tool_id || "").startsWith(`${id}.`)) add(errors, id, `tool is not seat-prefixed: ${JSON.stringify(tool?.tool_id)}`);
      if (tool?.implementation_status !== "planned_unverified") add(errors, id, `${tool?.tool_id} must remain planned_unverified`);
      if (typeof tool?.purpose !== "string" || tool.purpose.length < 12) add(errors, id, `${tool?.tool_id} has no substantive purpose`);
      requireStrings(tool?.output_fact_types, 1, `${tool?.tool_id}.output_fact_types`, id, errors, FACT_ID);
    }
    const duplicateTools = duplicates(seat.planned_dedicated_tools.map((tool) => tool.tool_id));
    if (duplicateTools.length) add(errors, id, `duplicate tool ids: ${duplicateTools.join(", ")}`);
  }

  if (!Array.isArray(seat.veto_families) || seat.veto_families.length < 3) add(errors, id, "at least three veto families are required");
  else for (const veto of seat.veto_families) {
    exactKeys(veto, ["veto_id", "candidate_rule", "human_adjudication_status"], "veto_families[]", id, errors);
    if (!String(veto?.veto_id || "").startsWith(`${id}.`)) add(errors, id, `veto is not seat-prefixed: ${JSON.stringify(veto?.veto_id)}`);
    if (typeof veto?.candidate_rule !== "string" || veto.candidate_rule.length < 12) add(errors, id, `${veto?.veto_id} has no substantive candidate rule`);
    if (veto?.human_adjudication_status !== PENDING) add(errors, id, `${veto?.veto_id} falsely implies adjudication`);
  }
  const duplicateVetoes = duplicates((seat.veto_families || []).map((veto) => veto?.veto_id));
  if (duplicateVetoes.length) add(errors, id, `duplicate veto ids: ${duplicateVetoes.join(", ")}`);

  if (!Array.isArray(seat.primary_source_acquisition_targets) || seat.primary_source_acquisition_targets.length < 3) {
    add(errors, id, "at least three source-acquisition targets are required");
  } else for (const target of seat.primary_source_acquisition_targets) {
    exactKeys(target, ["target_id", "source_family", "acquisition_target", "acquisition_status", "human_adjudication_status"], "primary_source_acquisition_targets[]", id, errors);
    if (!String(target?.target_id || "").startsWith(`${id}.source_`)) add(errors, id, `source target is not seat-prefixed: ${JSON.stringify(target?.target_id)}`);
    if (!new Set(["author_signed", "institutional_primary", "public_record", "published_work"]).has(target?.source_family)) add(errors, id, `${target?.target_id} has an invalid source_family`);
    if (typeof target?.acquisition_target !== "string" || target.acquisition_target.length < 16) add(errors, id, `${target?.target_id} has no substantive acquisition target`);
    if (target?.acquisition_status !== "not_started" || target?.human_adjudication_status !== PENDING) add(errors, id, `${target?.target_id} falsely implies acquired or adjudicated evidence`);
  }
  const duplicateSources = duplicates((seat.primary_source_acquisition_targets || []).map((target) => target?.target_id));
  if (duplicateSources.length) add(errors, id, `duplicate source target ids: ${duplicateSources.join(", ")}`);

  const caseFamilies = new Map((seat.case_acquisition_targets || []).map((target) => [target.case_family, target]));
  if (caseFamilies.size !== 4 || (seat.case_acquisition_targets || []).length !== 4) add(errors, id, "case targets must contain exactly decision, failure, counterfactual and golden");
  for (const [family, minimum] of Object.entries(CASE_MINIMUMS)) {
    const target = caseFamilies.get(family);
    if (!target) { add(errors, id, `missing ${family} case target`); continue; }
    exactKeys(target, ["case_family", "acquisition_target", "minimum_count", "acquisition_status", "human_adjudication_status"], "case_acquisition_targets[]", id, errors);
    if (target.minimum_count < minimum) add(errors, id, `${family} target minimum must be at least ${minimum}`);
    if (typeof target.acquisition_target !== "string" || target.acquisition_target.length < 16) add(errors, id, `${family} has no substantive acquisition target`);
    if (target.acquisition_status !== "not_started" || target.human_adjudication_status !== PENDING) add(errors, id, `${family} cases falsely imply acquired or adjudicated content`);
  }

  requireStrings(seat.known_limits, 2, "known_limits", id, errors);
  const human = seat.human_adjudication || {};
  exactKeys(human, ["method_attribution", "source_grade", "case_outcomes", "veto_thresholds", "counterfactual_labels", "reviewer_approvals", "experiment_status"], "human_adjudication", id, errors);
  for (const field of ["method_attribution", "source_grade", "case_outcomes", "veto_thresholds", "counterfactual_labels"]) {
    if (human[field] !== PENDING) add(errors, id, `human_adjudication.${field} must remain pending`);
  }
  if (human.reviewer_approvals !== "none") add(errors, id, "reviewer approvals must be none");
  if (human.experiment_status !== "not_started") add(errors, id, "experiment status must be not_started");

  for (const [path, value] of stringsIn(seat)) if (URL.test(value)) add(errors, id, `${path} contains a URL; build targets are not citations`);
  const forbiddenKeys = new Set(["url", "quote", "excerpt", "signature", "reviewer", "reviewers", "reviewer_id", "reviewer_ids", "experiment_results", "maturity", "admission_level", "pack_hash"]);
  for (const [path, key] of keysIn(seat)) if (forbiddenKeys.has(key)) add(errors, id, `${path} is forbidden in a planning-only build spec`);
}

export function validatePersonaV3BuildSpecs(inventory = personaV3BuildSpecs) {
  const errors = [];
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) return { valid: false, errors: ["inventory must be an object"] };
  exactKeys(inventory, ["schema_version", "inventory_id", "inventory_status", "canonical_catalog_source", "seat_count", "adjudication_policy", "seats"], "inventory", null, errors);
  if (inventory.schema_version !== 1) add(errors, null, "schema_version must be 1");
  if (inventory.inventory_id !== "personapack-v3-build-specs") add(errors, null, "inventory_id is invalid");
  if (inventory.inventory_status !== "non_production_planning_only") add(errors, null, "inventory must remain non-production");
  if (inventory.canonical_catalog_source !== "mcp/lib/personas/registry.mjs") add(errors, null, "canonical catalog source changed");
  if (inventory.seat_count !== CANONICAL_MASTER_COUNT) add(errors, null, `seat_count must be ${CANONICAL_MASTER_COUNT}`);

  const policy = inventory.adjudication_policy || {};
  exactKeys(policy, ["method_attribution", "source_grading", "case_labels", "veto_thresholds", "reviewer_approvals", "experiments", "promotion_effect"], "adjudication_policy", null, errors);
  for (const field of ["method_attribution", "source_grading", "case_labels", "veto_thresholds"]) {
    if (policy[field] !== PENDING) add(errors, null, `adjudication_policy.${field} must remain pending`);
  }
  if (policy.reviewer_approvals !== "none" || policy.experiments !== "not_started" || policy.promotion_effect !== "none") {
    add(errors, null, "inventory cannot claim review, experiments or promotion");
  }

  const catalogIds = registry().ids("master");
  const selectorIds = knownSelectorCardIds();
  if (catalogIds.length !== CANONICAL_MASTER_COUNT) add(errors, null, `canonical registry has ${catalogIds.length} masters, expected ${CANONICAL_MASTER_COUNT}`);
  const missingCards = catalogIds.filter((id) => !selectorIds.includes(id));
  const extraCards = selectorIds.filter((id) => !catalogIds.includes(id));
  if (missingCards.length || extraCards.length) add(errors, null, `selector cards differ from registry; missing=${missingCards.join(",") || "none"}; extra=${extraCards.join(",") || "none"}`);
  if (!Array.isArray(inventory.seats) || inventory.seats.length !== catalogIds.length) {
    add(errors, null, `inventory has ${inventory.seats?.length ?? "no"} seats, expected ${catalogIds.length}`);
  }
  const seatIds = (inventory.seats || []).map((seat) => seat?.persona_id);
  const duplicateSeats = duplicates(seatIds);
  if (duplicateSeats.length) add(errors, null, `duplicate seats: ${duplicateSeats.join(", ")}`);

  const legacy = loadPacks();
  const legacyIds = new Set(legacy.packs.map((pack) => pack.persona_id));
  for (let index = 0; index < Math.max(catalogIds.length, (inventory.seats || []).length); index += 1) {
    validateSeat(inventory.seats?.[index], catalogIds[index], legacyIds, errors);
  }
  const schemaIds = (inventory.seats || []).map((seat) => seat?.native_decision_contract?.schema_id).filter(Boolean);
  const duplicateSchemas = duplicates(schemaIds);
  if (duplicateSchemas.length) add(errors, null, `native decision schema ids must be unique: ${duplicateSchemas.join(", ")}`);

  for (const [path, value] of stringsIn(inventory.adjudication_policy)) if (URL.test(value)) add(errors, null, `${path} contains a URL`);
  return {
    valid: errors.length === 0,
    errors,
    canonical_ids: catalogIds,
    legacy_v2_ids: [...legacyIds].sort(),
  };
}

export function personaV3BuildSpecReport(inventory = personaV3BuildSpecs) {
  const validation = validatePersonaV3BuildSpecs(inventory);
  const seats = Array.isArray(inventory?.seats) ? inventory.seats : [];
  const totals = seats.reduce((sum, seat) => {
    sum.required_fact_types += seat?.required_fact_types?.length || 0;
    sum.planned_tools += seat?.planned_dedicated_tools?.length || 0;
    sum.veto_families += seat?.veto_families?.length || 0;
    sum.source_targets += seat?.primary_source_acquisition_targets?.length || 0;
    for (const target of seat?.case_acquisition_targets || []) sum.case_targets[target.case_family] += target.minimum_count || 0;
    return sum;
  }, { required_fact_types: 0, planned_tools: 0, veto_families: 0, source_targets: 0, case_targets: { decision: 0, failure: 0, counterfactual: 0, golden: 0 } });
  return {
    schema_version: 1,
    inventory_id: inventory?.inventory_id || null,
    inventory_status: inventory?.inventory_status || null,
    valid: validation.valid,
    errors: validation.errors,
    canonical_seats: validation.canonical_ids.length,
    build_specs: seats.length,
    current_material: {
      v1_prompt: seats.filter((seat) => seat?.current_material?.material_level === "v1_prompt").length,
      v2_operator: seats.filter((seat) => seat?.current_material?.material_level === "v2_operator").length,
      physical_v3: 0,
      method_model: 0,
    },
    adjudication: {
      pending_seats: seats.filter((seat) => seat?.human_adjudication?.method_attribution === PENDING).length,
      reviewer_approvals: 0,
      experiment_passes: 0,
      production_promotions: 0,
    },
    totals,
    seats: seats.map((seat) => ({
      persona_id: seat.persona_id,
      material_level: seat.current_material.material_level,
      required_fact_types: seat.required_fact_types.length,
      planned_tools: seat.planned_dedicated_tools.length,
      veto_families: seat.veto_families.length,
      source_targets: seat.primary_source_acquisition_targets.length,
      planned_cases: Object.fromEntries(seat.case_acquisition_targets.map((target) => [target.case_family, target.minimum_count])),
      human_adjudication: seat.human_adjudication.method_attribution,
    })),
  };
}

export { personaV3BuildSpecs };
