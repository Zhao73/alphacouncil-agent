/**
 * Loads Persona v2 packs and enforces the admission bar in code.
 *
 * The bar is not a badge an author awards themselves. A pack that declares
 * `kind: "method_model"` on a thin corpus is downgraded to `operator_lens` here, and the
 * shortfall is carried on the pack so the report can say which one the reader is looking
 * at. Letting a manifest self-certify would reproduce, one layer up, the exact failure this
 * release exists to remove: a shape that looks like a judgment, holding none.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Minimum corpus for a pack to carry a person's name. See docs/persona-v2-spec.md. */
export const ADMISSION_BAR = Object.freeze({
  propositions: 25,
  primary_sources: 5,
  decision_cases: 5,
  failure_cases: 3,
  vetoes: 10,
  counterfactuals: 10,
});

export function defaultKnowledgeDir() {
  return process.env.ALPHACOUNCIL_KNOWLEDGE_DIR
    || fileURLToPath(new URL("../../../knowledge/masters/", import.meta.url));
}

/** Counted from the corpus, never from the manifest's own claim about itself. */
export function countAdmission(pack) {
  const sources = pack.sources || [];
  return {
    propositions: (pack.doctrine || []).length,
    primary_sources: sources.filter((s) => s.grade === "A" || s.grade === "B").length,
    decision_cases: (pack.decision_cases || []).length,
    failure_cases: (pack.failure_cases || []).length
      || (pack.doctrine || []).filter((d) => (d.counterexamples || []).length).length,
    vetoes: (pack.decision_policy?.vetoes || []).length,
    counterfactuals: (pack.counterfactuals || []).length,
  };
}

export function admissionShortfall(counts) {
  const short = {};
  for (const [key, required] of Object.entries(ADMISSION_BAR)) {
    const have = counts[key] || 0;
    if (have < required) short[key] = { have, required };
  }
  return short;
}

/**
 * A rule may only be defined by a grade A or B source. C supports, D stages, E is rejected.
 * A doctrine entry citing nothing loadable is dropped rather than quietly kept.
 */
export function validatePack(pack, file = "") {
  const errors = [];
  const fail = (m) => errors.push(`${file}: ${m}`);
  if (pack?.schema_version !== 2) fail(`schema_version must be 2, got ${JSON.stringify(pack?.schema_version)}`);
  if (!/^[a-z0-9_]{2,48}$/.test(pack?.persona_id || "")) fail(`persona_id invalid: ${JSON.stringify(pack?.persona_id)}`);
  if (!pack?.display_name?.en) fail("display_name.en is required");
  if (pack?.display_name?.en && !/model|lens/i.test(pack.display_name.en)) {
    // Naming discipline is a correctness property, not decoration: the product claim is a
    // method, and a display name that reads as a person overstates it on every surface.
    fail(`display_name.en must read as a method ("Buffett Method Model"), got ${JSON.stringify(pack.display_name.en)}`);
  }
  if (!pack?.decision_policy?.eligibility?.requires?.length) fail("decision_policy.eligibility.requires must be non-empty");
  if (!pack?.decision_policy?.stance_bands?.length) fail("decision_policy.stance_bands must be non-empty");

  const byId = new Map((pack?.sources || []).map((s) => [s.id, s]));
  for (const rule of pack?.doctrine || []) {
    if (!rule.source_ids?.length) { fail(`doctrine ${rule.rule_id}: no source_ids`); continue; }
    const defining = rule.source_ids.filter((id) => ["A", "B"].includes(byId.get(id)?.grade));
    if (!defining.length) fail(`doctrine ${rule.rule_id}: cites no grade A/B source, so it cannot define a rule`);
    for (const id of rule.source_ids) if (!byId.has(id)) fail(`doctrine ${rule.rule_id}: unknown source ${id}`);
  }
  for (const rule of pack?.decision_policy?.scoring?.rules || []) {
    if (!rule.provenance || rule.provenance.length < 8) {
      fail(`scoring rule ${rule.id}: threshold has no provenance; determinism moves the uncertainty into the constant`);
    }
  }
  const leak = pack?.memory_policy?.leak_rule;
  if (leak && leak !== "public_at <= as_of AND memory_created_at <= as_of") {
    fail("memory_policy.leak_rule must carry both clauses or a model reads the future through its own diary");
  }
  return errors;
}

/** Validates, counts, and downgrades kind when the corpus does not support the name. */
export function loadPack(file) {
  const pack = JSON.parse(readFileSync(file, "utf8"));
  const errors = validatePack(pack, file);
  if (errors.length) throw new Error(errors.join("\n"));
  const counts = countAdmission(pack);
  const shortfall = admissionShortfall(counts);
  const qualifies = Object.keys(shortfall).length === 0;
  return {
    ...pack,
    admission_counted: counts,
    admission_shortfall: shortfall,
    // The manifest's own `kind` is advisory. This one is enforced.
    kind: qualifies ? "method_model" : "operator_lens",
    kind_declared: pack.kind,
  };
}

export function loadPacks({ dir = defaultKnowledgeDir() } = {}) {
  if (!existsSync(dir)) return { packs: [], get: () => undefined };
  const packs = [];
  for (const entry of readdirSync(dir)) {
    const manifest = join(dir, entry, "manifest.json");
    if (statSync(join(dir, entry)).isDirectory() && existsSync(manifest)) packs.push(loadPack(manifest));
  }
  packs.sort((a, b) => a.persona_id.localeCompare(b.persona_id));
  const index = new Map(packs.map((p) => [p.persona_id, p]));
  return { packs, get: (id) => index.get(id) };
}
