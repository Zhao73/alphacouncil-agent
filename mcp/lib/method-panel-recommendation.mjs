/**
 * Deterministic method-panel recommendation over the physical 26-pack capability manifests.
 *
 * A recommendation is advisory selection help, not consent and not an expert claim. The public
 * function has five decision inputs: catalog identity, instrument classification, typed-fact
 * coverage, objective and holding horizon. Pack capabilities and calibration are immutable
 * runtime data for the installed build.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { canonicalValue, sha256 } from "./personas-v3/canonical.mjs";
import { registry } from "./personas/registry.mjs";

const MANIFEST_ROOT = fileURLToPath(new URL("../../knowledge/solo-test/masters/", import.meta.url));
const CALIBRATION_FILE = fileURLToPath(new URL("../../data/method-panel-calibration.v2.json", import.meta.url));

const OBJECTIVE_FIT_RANK = Object.freeze({ none: 0, supporting: 1, primary: 2 });
const HORIZON_FIT_RANK = Object.freeze({ mismatch: 0, agnostic: 1, compatible: 2, exact: 3 });
const DURATION_HORIZONS = Object.freeze([
  "1_4_weeks",
  "3_6_months",
  "1_year",
  "3_5_years",
  "10_years_plus",
  "indefinite",
]);
const RISK_COVERAGE_ROLES = Object.freeze(new Set([
  "risk_overlay",
  "portfolio_overlay",
  "evidence_challenger",
]));

export const METHOD_PANEL_FAMILIES = Object.freeze([
  "quality_compounding",
  "deep_value_safety_margin",
  "macro_regime",
  "quantitative_systematic",
  "short_forensic",
  "growth_innovation",
  "tail_risk",
  "event_special_situations",
]);

const FAMILY_SIGNALS = Object.freeze({
  quality_compounding: Object.freeze([
    "operating_businesses", "business_quality", "long_duration_quality", "growth_quality",
    "management_integrity", "consumer_businesses", "product_value", "capital_allocation",
  ]),
  deep_value_safety_margin: Object.freeze([
    "deep_value", "asset_backed_securities", "capital_preservation", "distressed_value",
    "dhandho_value", "downside_protection", "intrinsic_valuation", "structural_mispricing",
  ]),
  macro_regime: Object.freeze([
    "macro_regimes", "global_macro", "debt_cycles", "credit_cycles", "liquidity",
    "cross_asset_risk", "reflexivity", "boom_bust", "risk_posture",
  ]),
  quantitative_systematic: Object.freeze([
    "systematic_signals", "statistical_arbitrage", "factor_investing", "portfolio_attribution",
    "probabilistic_edge", "position_sizing", "execution_costs", "index_funds",
    "exchange_traded_funds",
  ]),
  short_forensic: Object.freeze([
    "forensic_accounting", "accounting_forensics", "governance_red_flags", "shortability",
    "primary_document_research", "capital_structure", "failure_analysis",
  ]),
  growth_innovation: Object.freeze([
    "disruptive_innovation", "technology_adoption", "platform_convergence", "growth_valuation",
    "growth_quality", "young_companies", "structural_growth", "structural_penetration",
    "consumer_observation", "growth_categories",
  ]),
  tail_risk: Object.freeze([
    "tail_risk", "convexity", "fragility", "options", "options_pricing",
    "volatility_surface", "volatility_forecasting", "options_execution", "risk_posture",
    "capital_preservation", "failure_analysis",
  ]),
  event_special_situations: Object.freeze([
    "activism", "corporate_change", "special_situations", "catalyst_value", "catalyst_analysis",
    "arbitrage", "turnarounds", "complex_securities", "concentrated_odds",
  ]),
});

function loadCapabilities() {
  const catalogOrder = registry().ids("master");
  const order = new Map(catalogOrder.map((masterId, index) => [masterId, index]));
  const capabilities = readdirSync(MANIFEST_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^master_[a-z0-9_]+$/u.test(entry.name))
    .map((entry) => {
      const manifest = JSON.parse(readFileSync(join(MANIFEST_ROOT, entry.name, "manifest.json"), "utf8"));
      const masterId = manifest?.identity?.persona_id;
      if (masterId !== entry.name) throw new Error(`method capability manifest identity mismatch: ${entry.name}`);
      const domains = [...new Set(manifest?.capability?.domains || [])].sort();
      const requiredFacts = [...new Set(manifest?.capability?.required_fact_types || [])].sort();
      if (!domains.length || !requiredFacts.length) {
        throw new Error(`method capability manifest is incomplete: ${masterId}`);
      }
      return canonicalValue({
        master_id: masterId,
        domains,
        required_fact_types: requiredFacts,
        best_for: manifest?.selection?.best_for?.en || "",
      });
    });
  const missing = catalogOrder.filter((masterId) => !capabilities.some((entry) => entry.master_id === masterId));
  const unexpected = capabilities.filter((entry) => !order.has(entry.master_id)).map((entry) => entry.master_id);
  if (missing.length || unexpected.length) {
    throw new Error(`method capability/catalog mismatch: missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"}`);
  }
  return capabilities.sort((left, right) => order.get(left.master_id) - order.get(right.master_id));
}

let cachedCapabilities = null;

function capabilitySnapshot() {
  if (!cachedCapabilities) cachedCapabilities = Object.freeze(loadCapabilities());
  return cachedCapabilities;
}

function capabilityManifestHash(capabilities) {
  return sha256({
    hash_domain: "alphacouncil.method-panel-capabilities.v1",
    capabilities,
  });
}

function uniqueStrings(value, path) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${path} must be a non-empty array of strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${path} must not contain duplicates`);
  return [...value];
}

function exactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${path} keys must be exactly ${wanted.join(",")}`);
  }
}

function loadCalibration() {
  const raw = JSON.parse(readFileSync(CALIBRATION_FILE, "utf8"));
  exactKeys(raw, ["schema_version", "contract_id", "objectives", "holding_horizons", "roles", "methods"], "method calibration");
  if (raw.schema_version !== 2 || raw.contract_id !== "alphacouncil_method_panel_calibration_v2") {
    throw new Error("method calibration must use alphacouncil_method_panel_calibration_v2 schema version 2");
  }
  const objectives = uniqueStrings(raw.objectives, "method calibration objectives");
  const holdingHorizons = uniqueStrings(raw.holding_horizons, "method calibration holding_horizons");
  const roles = uniqueStrings(raw.roles, "method calibration roles");
  if (!holdingHorizons.includes("horizon_agnostic")) {
    throw new Error("method calibration holding_horizons must include horizon_agnostic");
  }
  if (!Array.isArray(raw.methods)) throw new Error("method calibration methods must be an array");

  const catalogOrder = registry().ids("master");
  const byId = new Map();
  for (const [index, method] of raw.methods.entries()) {
    const path = `method calibration methods[${index}]`;
    exactKeys(method, ["master_id", "roles", "primary_intents", "supporting_intents", "horizons"], path);
    if (typeof method.master_id !== "string" || !method.master_id) throw new Error(`${path}.master_id must be a string`);
    if (byId.has(method.master_id)) throw new Error(`method calibration duplicates ${method.master_id}`);
    const methodRoles = uniqueStrings(method.roles, `${path}.roles`);
    const primaryIntents = uniqueStrings(method.primary_intents, `${path}.primary_intents`);
    const supportingIntents = uniqueStrings(method.supporting_intents, `${path}.supporting_intents`);
    const horizons = uniqueStrings(method.horizons, `${path}.horizons`);
    const unknownRoles = methodRoles.filter((role) => !roles.includes(role));
    const unknownIntents = [...primaryIntents, ...supportingIntents]
      .filter((intent) => !objectives.includes(intent));
    const unknownHorizons = horizons.filter((horizon) => !holdingHorizons.includes(horizon));
    const overlappingIntents = primaryIntents.filter((intent) => supportingIntents.includes(intent));
    if (unknownRoles.length) throw new Error(`${path}.roles contains unsupported values: ${unknownRoles.join(",")}`);
    if (unknownIntents.length) throw new Error(`${path} contains unsupported intents: ${unknownIntents.join(",")}`);
    if (unknownHorizons.length) throw new Error(`${path}.horizons contains unsupported values: ${unknownHorizons.join(",")}`);
    if (overlappingIntents.length) throw new Error(`${path} repeats intents across primary/supporting: ${overlappingIntents.join(",")}`);
    byId.set(method.master_id, canonicalValue({
      master_id: method.master_id,
      roles: methodRoles,
      primary_intents: primaryIntents,
      supporting_intents: supportingIntents,
      horizons,
    }));
  }
  const missing = catalogOrder.filter((masterId) => !byId.has(masterId));
  const unexpected = [...byId.keys()].filter((masterId) => !catalogOrder.includes(masterId));
  if (missing.length || unexpected.length) {
    throw new Error(`method calibration/catalog mismatch: missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"}`);
  }
  return canonicalValue({
    schema_version: raw.schema_version,
    contract_id: raw.contract_id,
    objectives,
    holding_horizons: holdingHorizons,
    roles,
    methods: catalogOrder.map((masterId) => byId.get(masterId)),
  });
}

let cachedCalibration = null;

function calibrationSnapshot() {
  if (!cachedCalibration) cachedCalibration = Object.freeze(loadCalibration());
  return cachedCalibration;
}

/** Public enum surface for RPC schemas and selection-context validation. */
export function methodPanelCalibrationOptions() {
  const calibration = calibrationSnapshot();
  return Object.freeze({
    objectives: Object.freeze([...calibration.objectives]),
    holding_horizons: Object.freeze([...calibration.holding_horizons]),
  });
}

function calibrationManifestHash(calibration) {
  return sha256({
    hash_domain: "alphacouncil.method-panel-calibration.v2",
    calibration,
  });
}

function normalizeCalibrationRequest(objective, holdingHorizon) {
  const objectivePresent = objective !== undefined && objective !== null;
  const horizonPresent = holdingHorizon !== undefined && holdingHorizon !== null;
  if (objectivePresent !== horizonPresent) {
    throw new TypeError("objective and holding_horizon must be provided together for method-panel calibration v2");
  }
  if (!objectivePresent) return null;
  const calibration = calibrationSnapshot();
  if (typeof objective !== "string" || !calibration.objectives.includes(objective)) {
    throw new TypeError(`objective must be one of: ${calibration.objectives.join(", ")}`);
  }
  if (typeof holdingHorizon !== "string" || !calibration.holding_horizons.includes(holdingHorizon)) {
    throw new TypeError(`holding_horizon must be one of: ${calibration.holding_horizons.join(", ")}`);
  }
  return Object.freeze({
    objective,
    holding_horizon: holdingHorizon,
    contract: calibration,
    manifest_hash: calibrationManifestHash(calibration),
    methods: new Map(calibration.methods.map((method) => [method.master_id, method])),
  });
}

function normalizeClassification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const assetType = typeof value.asset_type === "string" ? value.asset_type.trim().toLowerCase() : "";
  const researchModel = typeof value.research_model === "string" ? value.research_model.trim().toLowerCase() : "";
  if (!assetType || !researchModel || assetType === "unknown" || researchModel === "unknown") return null;
  return canonicalValue({
    asset_type: assetType,
    classification_source: typeof value.classification_source === "string" && value.classification_source.trim()
      ? value.classification_source.trim() : null,
    research_model: researchModel,
  });
}

function normalizeFacts(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string")
    .map((item) => item.trim()).filter(Boolean))].sort();
}

function anyFact(facts, prefixes) {
  return facts.some((factId) => prefixes.some((prefix) => factId.startsWith(prefix)));
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function objectiveFit(method, objective) {
  if (method.primary_intents.includes(objective)) return "primary";
  if (method.supporting_intents.includes(objective)) return "supporting";
  return "none";
}

function horizonFit(method, holdingHorizon) {
  if (holdingHorizon === "horizon_agnostic") return "agnostic";
  if (method.horizons.includes(holdingHorizon)) return "exact";
  if (method.horizons.includes("horizon_agnostic")) return "agnostic";
  const requestedIndex = DURATION_HORIZONS.indexOf(holdingHorizon);
  const nearest = method.horizons
    .map((horizon) => DURATION_HORIZONS.indexOf(horizon))
    .filter((index) => index >= 0)
    .reduce((distance, index) => Math.min(distance, Math.abs(index - requestedIndex)), Number.POSITIVE_INFINITY);
  return nearest === 1 ? "compatible" : "mismatch";
}

function methodCalibration(method, request) {
  const objective = objectiveFit(method, request.objective);
  const horizon = horizonFit(method, request.holding_horizon);
  const primaryDirection = request.objective === "directional_rating"
    && method.roles.includes("directional_core")
    && objective === "primary"
    && ["exact", "compatible"].includes(horizon);
  const supportingDirection = request.objective === "directional_rating"
    && objective !== "none"
    && horizon !== "mismatch";
  return {
    roles: method.roles,
    objective_fit: objective,
    horizon_fit: horizon,
    rating_contribution: primaryDirection ? "primary" : supportingDirection ? "supporting" : "none",
  };
}

function calibratedCandidateCompare(left, right) {
  return OBJECTIVE_FIT_RANK[right.calibration.objective_fit]
      - OBJECTIVE_FIT_RANK[left.calibration.objective_fit]
    || HORIZON_FIT_RANK[right.calibration.horizon_fit]
      - HORIZON_FIT_RANK[left.calibration.horizon_fit]
    || right.match.score - left.match.score
    || stableCompare(left.capability.master_id, right.capability.master_id);
}

function specialistAdmission(capability, classification, facts) {
  const domains = new Set(capability.domains);
  const fundSpecialist = domains.has("index_funds") || domains.has("exchange_traded_funds");
  if (fundSpecialist) {
    const admitted = ["etf", "mutual_fund", "index"].includes(classification.asset_type)
      || ["fund_lookthrough", "index_aggregate"].includes(classification.research_model);
    return admitted
      ? { admitted: true, reason_code: "fund_or_index_classification_present" }
      : { admitted: false, reason_code: "fund_or_index_classification_required" };
  }

  const optionSpecialist = capability.domains.some((domain) => [
    "options", "options_pricing", "volatility_surface", "volatility_forecasting", "options_execution",
  ].includes(domain));
  if (optionSpecialist) {
    const classified = ["option", "options"].includes(classification.asset_type)
      || /derivative|option|volatility/u.test(classification.research_model);
    const covered = anyFact(facts, ["options.", "execution.", "payoff."]);
    return classified && covered
      ? { admitted: true, reason_code: "options_classification_and_facts_present" }
      : { admitted: false, reason_code: "options_classification_and_facts_required" };
  }

  const activistSpecialist = domains.has("activism") || domains.has("corporate_change");
  if (activistSpecialist) {
    return anyFact(facts, ["ib_event.", "event.", "corporate_action."])
      ? { admitted: true, reason_code: "event_facts_present" }
      : { admitted: false, reason_code: "event_facts_required" };
  }

  const shortSpecialist = domains.has("shortability");
  if (shortSpecialist) {
    return anyFact(facts, ["short.", "borrow.", "execution.borrow"])
      ? { admitted: true, reason_code: "shortability_facts_present" }
      : { admitted: false, reason_code: "shortability_facts_required" };
  }

  return { admitted: true, reason_code: "general_method_admitted" };
}

function familyScore(capability, familyId, facts, classification) {
  const signals = new Set(FAMILY_SIGNALS[familyId]);
  const matchedDomains = capability.domains.filter((domain) => signals.has(domain));
  if (!matchedDomains.length) return null;
  const coveredFacts = capability.required_fact_types.filter((factId) => facts.includes(factId));
  const missingFacts = capability.required_fact_types.filter((factId) => !facts.includes(factId));
  let score = matchedDomains.length * 100 + coveredFacts.length * 12 - missingFacts.length * 3;
  if ((classification.asset_type === "etf" || classification.asset_type === "index")
    && capability.domains.some((domain) => ["index_funds", "exchange_traded_funds"].includes(domain))) {
    score += 250;
  }
  if ((classification.asset_type === "option" || /derivative|option|volatility/u.test(classification.research_model))
    && capability.domains.some((domain) => /options|volatility|tail_risk/u.test(domain))) {
    score += 180;
  }
  return { score, matchedDomains, coveredFacts, missingFacts };
}

function failClosed(catalogHash, facts, capabilities, manifestHash) {
  return Object.freeze(canonicalValue({
    schema_version: 1,
    status: "not_evaluable",
    reason_code: "instrument_classification_missing",
    catalog_hash: typeof catalogHash === "string" ? catalogHash : null,
    capability_manifest_hash: manifestHash,
    instrument_classification: null,
    typed_fact_coverage: facts,
    recommendation_hash: null,
    included_master_ids: [],
    family_assignments: [],
    decisions: capabilities.map((capability) => ({
      master_id: capability.master_id,
      decision: "exclude",
      family_id: null,
      reason_code: "instrument_classification_missing",
      reason: "No method panel is recommended until the instrument classification is known.",
      missing_facts: capability.required_fact_types.filter((factId) => !facts.includes(factId)),
      capability_basis: { domains: [], required_fact_types: [] },
    })),
    disclosure: "Advisory method-simulation prefill only; it is not consent, a human-expert roster, or a profit claim.",
  }));
}

function failClosedCalibrated(catalogHash, facts, capabilities, manifestHash, request) {
  return Object.freeze(canonicalValue({
    schema_version: 3,
    calibration_version: 2,
    status: "not_evaluable",
    reason_code: "instrument_classification_missing",
    catalog_hash: typeof catalogHash === "string" ? catalogHash : null,
    capability_manifest_hash: manifestHash,
    calibration_manifest_hash: request.manifest_hash,
    objective: request.objective,
    holding_horizon: request.holding_horizon,
    instrument_classification: null,
    typed_fact_coverage: facts,
    recommendation_hash: null,
    included_master_ids: [],
    directional_rating_master_ids: [],
    risk_coverage_master_ids: [],
    context_only_master_ids: [],
    directional_rating_evaluable: request.objective === "directional_rating" ? false : null,
    family_assignments: [],
    unfilled_families: [...METHOD_PANEL_FAMILIES],
    decisions: capabilities.map((capability) => {
      const calibration = methodCalibration(request.methods.get(capability.master_id), request);
      return {
        master_id: capability.master_id,
        decision: "exclude",
        family_id: null,
        reason_code: "instrument_classification_missing",
        reason: "No method panel is recommended until the instrument classification is known.",
        missing_facts: capability.required_fact_types.filter((factId) => !facts.includes(factId)),
        capability_basis: { domains: [], required_fact_types: [] },
        ...calibration,
      };
    }),
    disclosure: "Advisory method-simulation prefill only; it is not consent, a human-expert roster, a directional vote count, or a profit claim.",
  }));
}

/** Return a stable advisory decision for every physical method pack. */
function recommendLegacyMethodPanel({
  catalog_hash,
  instrument_classification,
  typed_fact_coverage,
} = {}) {
  const capabilities = capabilitySnapshot();
  const manifestHash = capabilityManifestHash(capabilities);
  const facts = normalizeFacts(typed_fact_coverage);
  const classification = normalizeClassification(instrument_classification);
  if (!classification) return failClosed(catalog_hash, facts, capabilities, manifestHash);

  const admission = new Map(capabilities.map((capability) => [
    capability.master_id,
    specialistAdmission(capability, classification, facts),
  ]));
  const selected = new Map();
  const used = new Set();

  for (const familyId of METHOD_PANEL_FAMILIES) {
    const ranked = capabilities
      .filter((capability) => !used.has(capability.master_id) && admission.get(capability.master_id).admitted)
      .map((capability) => ({ capability, match: familyScore(capability, familyId, facts, classification) }))
      .filter((candidate) => candidate.match && candidate.match.missingFacts.length === 0)
      .sort((left, right) => right.match.score - left.match.score
        || stableCompare(left.capability.master_id, right.capability.master_id));
    const winner = ranked[0];
    if (!winner) continue;
    used.add(winner.capability.master_id);
    selected.set(winner.capability.master_id, { familyId, ...winner.match });
  }

  const decisions = capabilities.map((capability) => {
    const picked = selected.get(capability.master_id);
    const gate = admission.get(capability.master_id);
    const allMatches = METHOD_PANEL_FAMILIES.map((familyId) => ({
      familyId,
      match: familyScore(capability, familyId, facts, classification),
    })).filter((entry) => entry.match).sort((left, right) => right.match.score - left.match.score
      || stableCompare(left.familyId, right.familyId));
    const best = picked || allMatches[0]?.match || {
      matchedDomains: [], coveredFacts: [], missingFacts: capability.required_fact_types,
    };
    return canonicalValue({
      master_id: capability.master_id,
      decision: picked ? "include" : "exclude",
      family_id: picked?.familyId || null,
      reason_code: picked
        ? "highest_scoring_admitted_manifest_match"
        : best.missingFacts.length ? "required_facts_missing"
          : gate.admitted ? "another_manifest_match_filled_the_family" : gate.reason_code,
      reason: picked
        ? `Selected for ${picked.familyId} from declared capability domains and available typed facts.`
        : best.missingFacts.length
          ? "The pack remains selectable, but it is not recommended because required typed facts are missing."
          : gate.admitted
            ? "The pack remains selectable, but another admitted manifest match filled the advisory family slot."
            : "The pack remains selectable, but its specialist admission predicate is not satisfied for this advisory panel.",
      missing_facts: best.missingFacts,
      capability_basis: {
        domains: best.matchedDomains,
        required_fact_types: best.coveredFacts,
      },
    });
  });

  const familyAssignments = METHOD_PANEL_FAMILIES.map((familyId) => {
    const decision = decisions.find((candidate) => candidate.family_id === familyId);
    return { family_id: familyId, master_id: decision?.master_id || null };
  });
  const unfilledFamilies = familyAssignments
    .filter((assignment) => assignment.master_id === null)
    .map((assignment) => assignment.family_id);

  const hashSubject = canonicalValue({
    hash_domain: "alphacouncil.method-panel-recommendation.v2",
    schema_version: 2,
    catalog_hash,
    capability_manifest_hash: manifestHash,
    instrument_classification: classification,
    typed_fact_coverage: facts,
    decisions,
    unfilled_families: unfilledFamilies,
  });
  const recommendationHash = sha256(hashSubject);
  const includedMasterIds = decisions.filter((decision) => decision.decision === "include")
    .map((decision) => decision.master_id);
  return Object.freeze(canonicalValue({
    schema_version: 2,
    status: "recommended",
    reason_code: null,
    catalog_hash,
    capability_manifest_hash: manifestHash,
    instrument_classification: classification,
    typed_fact_coverage: facts,
    recommendation_hash: recommendationHash,
    included_master_ids: includedMasterIds,
    family_assignments: familyAssignments,
    unfilled_families: unfilledFamilies,
    decisions,
    disclosure: "Advisory method-simulation prefill only; the full catalog remains selectable and no research starts without explicit confirmation.",
  }));
}

function recommendCalibratedMethodPanel({
  catalogHash,
  classification,
  facts,
  capabilities,
  manifestHash,
  request,
}) {
  const admission = new Map(capabilities.map((capability) => [
    capability.master_id,
    specialistAdmission(capability, classification, facts),
  ]));
  const selected = new Map();
  const used = new Set();

  for (const familyId of METHOD_PANEL_FAMILIES) {
    const ranked = capabilities
      .filter((capability) => !used.has(capability.master_id) && admission.get(capability.master_id).admitted)
      .map((capability) => ({
        capability,
        match: familyScore(capability, familyId, facts, classification),
        calibration: methodCalibration(request.methods.get(capability.master_id), request),
      }))
      .filter((candidate) => candidate.match && candidate.match.missingFacts.length === 0)
      .sort(calibratedCandidateCompare);
    const winner = ranked[0];
    if (!winner) continue;
    used.add(winner.capability.master_id);
    selected.set(winner.capability.master_id, {
      familyId,
      ...winner.match,
      calibration: winner.calibration,
    });
  }

  const decisions = capabilities.map((capability) => {
    const picked = selected.get(capability.master_id);
    const gate = admission.get(capability.master_id);
    const calibration = methodCalibration(request.methods.get(capability.master_id), request);
    const allMatches = METHOD_PANEL_FAMILIES.map((familyId) => ({
      capability,
      familyId,
      match: familyScore(capability, familyId, facts, classification),
      calibration,
    })).filter((entry) => entry.match).sort(calibratedCandidateCompare);
    const best = picked || allMatches[0]?.match || {
      matchedDomains: [], coveredFacts: [], missingFacts: capability.required_fact_types,
    };
    return canonicalValue({
      master_id: capability.master_id,
      decision: picked ? "include" : "exclude",
      family_id: picked?.familyId || null,
      reason_code: picked
        ? "highest_calibrated_admitted_manifest_match"
        : best.missingFacts.length ? "required_facts_missing"
          : gate.admitted ? "another_calibrated_match_filled_the_family" : gate.reason_code,
      reason: picked
        ? `Selected for ${picked.familyId} after objective, horizon, capability and typed-fact calibration.`
        : best.missingFacts.length
          ? "The pack remains selectable, but it is not recommended because required typed facts are missing."
          : gate.admitted
            ? "The pack remains selectable, but another admitted method had a closer objective and horizon fit for the advisory family slot."
            : "The pack remains selectable, but its specialist admission predicate is not satisfied for this advisory panel.",
      missing_facts: best.missingFacts,
      capability_basis: {
        domains: best.matchedDomains,
        required_fact_types: best.coveredFacts,
      },
      ...calibration,
    });
  });

  const familyAssignments = METHOD_PANEL_FAMILIES.map((familyId) => {
    const decision = decisions.find((candidate) => candidate.family_id === familyId);
    return { family_id: familyId, master_id: decision?.master_id || null };
  });
  const unfilledFamilies = familyAssignments
    .filter((assignment) => assignment.master_id === null)
    .map((assignment) => assignment.family_id);
  const included = decisions.filter((decision) => decision.decision === "include");
  const directionalRatingMasterIds = included
    .filter((decision) => decision.rating_contribution === "primary")
    .map((decision) => decision.master_id);
  const riskCoverageMasterIds = included
    .filter((decision) => decision.rating_contribution !== "primary"
      && decision.roles.some((role) => RISK_COVERAGE_ROLES.has(role)))
    .map((decision) => decision.master_id);
  const grouped = new Set([...directionalRatingMasterIds, ...riskCoverageMasterIds]);
  const contextOnlyMasterIds = included
    .filter((decision) => !grouped.has(decision.master_id))
    .map((decision) => decision.master_id);
  const includedMasterIds = included.map((decision) => decision.master_id);
  const directionalRatingEvaluable = request.objective === "directional_rating"
    ? directionalRatingMasterIds.length > 0 : null;

  const hashSubject = canonicalValue({
    hash_domain: "alphacouncil.method-panel-recommendation.v3",
    schema_version: 3,
    calibration_version: 2,
    catalog_hash: catalogHash,
    capability_manifest_hash: manifestHash,
    calibration_manifest_hash: request.manifest_hash,
    objective: request.objective,
    holding_horizon: request.holding_horizon,
    instrument_classification: classification,
    typed_fact_coverage: facts,
    decisions,
    family_assignments: familyAssignments,
    unfilled_families: unfilledFamilies,
    directional_rating_master_ids: directionalRatingMasterIds,
    risk_coverage_master_ids: riskCoverageMasterIds,
    context_only_master_ids: contextOnlyMasterIds,
    directional_rating_evaluable: directionalRatingEvaluable,
  });
  const recommendationHash = sha256(hashSubject);
  return Object.freeze(canonicalValue({
    schema_version: 3,
    calibration_version: 2,
    status: "recommended",
    reason_code: null,
    catalog_hash: catalogHash,
    capability_manifest_hash: manifestHash,
    calibration_manifest_hash: request.manifest_hash,
    objective: request.objective,
    holding_horizon: request.holding_horizon,
    instrument_classification: classification,
    typed_fact_coverage: facts,
    recommendation_hash: recommendationHash,
    included_master_ids: includedMasterIds,
    directional_rating_master_ids: directionalRatingMasterIds,
    risk_coverage_master_ids: riskCoverageMasterIds,
    context_only_master_ids: contextOnlyMasterIds,
    directional_rating_evaluable: directionalRatingEvaluable,
    family_assignments: familyAssignments,
    unfilled_families: unfilledFamilies,
    decisions,
    disclosure: "Advisory method-simulation prefill only; directional contributors, risk coverage and context are separate, the full catalog remains selectable, and no research starts without explicit confirmation.",
  }));
}

/**
 * Return either the byte-compatible legacy v2 recommendation or the explicitly scoped
 * calibration-v2/schema-v3 recommendation. Partial calibration is rejected rather than guessed.
 */
export function recommendMethodPanel(args = {}) {
  const request = normalizeCalibrationRequest(args.objective, args.holding_horizon);
  if (!request) return recommendLegacyMethodPanel(args);

  const capabilities = capabilitySnapshot();
  const manifestHash = capabilityManifestHash(capabilities);
  const facts = normalizeFacts(args.typed_fact_coverage);
  const classification = normalizeClassification(args.instrument_classification);
  if (!classification) {
    return failClosedCalibrated(args.catalog_hash, facts, capabilities, manifestHash, request);
  }
  return recommendCalibratedMethodPanel({
    catalogHash: args.catalog_hash,
    classification,
    facts,
    capabilities,
    manifestHash,
    request,
  });
}
