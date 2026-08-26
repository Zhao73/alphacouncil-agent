/**
 * Deterministic method-panel recommendation over the physical 26-pack capability manifests.
 *
 * A recommendation is advisory selection help, not consent and not an expert claim. The public
 * function has exactly three decision inputs: catalog identity, instrument classification and
 * typed-fact coverage. Pack capabilities are immutable runtime data for the installed build.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { canonicalValue, sha256 } from "./personas-v3/canonical.mjs";
import { registry } from "./personas/registry.mjs";

const MANIFEST_ROOT = fileURLToPath(new URL("../../knowledge/solo-test/masters/", import.meta.url));

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

/** Return a stable advisory decision for every physical method pack. */
export function recommendMethodPanel({
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
      .filter((candidate) => candidate.match)
      .sort((left, right) => right.match.score - left.match.score
        || stableCompare(left.capability.master_id, right.capability.master_id));
    const winner = ranked[0];
    if (!winner) throw new Error(`method panel family has no admitted manifest-derived candidate: ${familyId}`);
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
        : gate.admitted ? "another_manifest_match_filled_the_family" : gate.reason_code,
      reason: picked
        ? `Selected for ${picked.familyId} from declared capability domains and available typed facts.`
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

  const hashSubject = canonicalValue({
    hash_domain: "alphacouncil.method-panel-recommendation.v1",
    schema_version: 1,
    catalog_hash,
    capability_manifest_hash: manifestHash,
    instrument_classification: classification,
    typed_fact_coverage: facts,
    decisions,
  });
  const recommendationHash = sha256(hashSubject);
  const includedMasterIds = decisions.filter((decision) => decision.decision === "include")
    .map((decision) => decision.master_id);
  return Object.freeze(canonicalValue({
    schema_version: 1,
    status: "recommended",
    reason_code: null,
    catalog_hash,
    capability_manifest_hash: manifestHash,
    instrument_classification: classification,
    typed_fact_coverage: facts,
    recommendation_hash: recommendationHash,
    included_master_ids: includedMasterIds,
    family_assignments: METHOD_PANEL_FAMILIES.map((familyId) => {
      const decision = decisions.find((candidate) => candidate.family_id === familyId);
      return { family_id: familyId, master_id: decision.master_id };
    }),
    decisions,
    disclosure: "Advisory method-simulation prefill only; the full catalog remains selectable and no research starts without explicit confirmation.",
  }));
}
