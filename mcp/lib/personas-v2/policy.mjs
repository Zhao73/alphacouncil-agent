/**
 * The deterministic half of a method model.
 *
 * Everything here runs before any model call and decides the things a language model must
 * not decide: whether the method can evaluate this security at all, what it scores, which
 * vetoes fire, and therefore what stance gets narrated. The model writes prose about a
 * verdict it did not choose.
 *
 * Pure by construction: no network, no clock, no filesystem. Same inputs, same decision.
 */

const OPS = {
  ">=": (a, b) => a >= b,
  ">": (a, b) => a > b,
  "<=": (a, b) => a <= b,
  "<": (a, b) => a < b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

/** `a.b.c` against a plain object. Returns undefined rather than throwing on a gap. */
export function readPath(facts, path) {
  return String(path || "").split(".").reduce((node, key) => (
    node && typeof node === "object" && key in node ? node[key] : undefined
  ), facts);
}

const MISSING = (v) => v === undefined || v === null || v === "" || (typeof v === "number" && !Number.isFinite(v));

/**
 * Can this method evaluate this security at all?
 *
 * A requirement whose input is missing fails the gate. That is deliberate and is the
 * opposite of the mechanical screen's rule for scoring: there, a missing input is `skipped`
 * and must never be read as a pass. Here, missing inputs are precisely the reason a method
 * should decline, and declining early costs nothing and says more than an essay would.
 */
export function evaluateEligibility(pack, facts) {
  const requires = pack?.decision_policy?.eligibility?.requires || [];
  const unmet = [];
  for (const requirement of requires) {
    const parsed = parseCondition(requirement);
    if (!parsed) { unmet.push({ requirement, reason: "unparsable" }); continue; }
    const actual = readPath(facts, parsed.path);
    if (MISSING(actual)) { unmet.push({ requirement, reason: "missing_input", path: parsed.path }); continue; }
    if (!compare(actual, parsed.op, parsed.value)) {
      unmet.push({ requirement, reason: "not_met", path: parsed.path, actual });
    }
  }
  return { eligible: unmet.length === 0, unmet };
}

/**
 * `path >= 4`, `path` (truthy), `!path` (falsy). Small on purpose: a condition language
 * that grows an evaluator grows a way to be wrong quietly.
 */
export function parseCondition(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const m = /^([A-Za-z0-9_.]+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/.exec(raw);
  if (m) return { path: m[1], op: m[2], value: literal(m[3]) };
  if (/^![A-Za-z0-9_.]+$/.test(raw)) return { path: raw.slice(1), op: "==", value: false };
  if (/^[A-Za-z0-9_.]+$/.test(raw)) return { path: raw, op: "==", value: true };
  return null;
}

function literal(text) {
  const t = String(text).trim().replace(/^["']|["']$/g, "");
  if (t === "true") return true;
  if (t === "false") return false;
  const n = Number(t);
  return Number.isFinite(n) && t !== "" ? n : t;
}

function compare(actual, op, expected) {
  if (typeof expected === "boolean") return op === "!=" ? Boolean(actual) !== expected : Boolean(actual) === expected;
  const fn = OPS[op];
  return fn ? fn(actual, expected) : false;
}

/**
 * Score the method's own rules.
 *
 * A rule whose input is missing is `uncomputable` -- never a miss, never a hit. Folding it
 * into either one is how a screen reports "6/7 passed" while hiding that the seventh was
 * never evaluated. `max_possible` therefore excludes uncomputable rules, so the ratio
 * describes what was actually measured, and `coverage` reports how much of the method ran.
 */
export function scoreMethod(pack, facts) {
  const scoring = pack?.decision_policy?.scoring;
  if (!scoring) return { score: 0, max_possible: 0, declared_max: 0, coverage: 0, hits: [], misses: [], uncomputable: [] };
  const hits = [];
  const misses = [];
  const uncomputable = [];
  let score = 0;
  let max_possible = 0;

  for (const rule of scoring.rules || []) {
    const actual = readPath(facts, rule.metric);
    if (MISSING(actual)) { uncomputable.push({ id: rule.id, metric: rule.metric }); continue; }
    max_possible += rule.points;
    if (compare(actual, rule.op, rule.value)) {
      score += rule.points;
      hits.push({ id: rule.id, metric: rule.metric, actual, threshold: rule.value, points: rule.points, provenance: rule.provenance });
    } else {
      misses.push({ id: rule.id, metric: rule.metric, actual, threshold: rule.value, points: rule.points, provenance: rule.provenance });
    }
  }
  const declared_max = scoring.max_score || 0;
  return {
    score,
    max_possible,
    declared_max,
    coverage: declared_max ? max_possible / declared_max : 0,
    hits,
    misses,
    uncomputable,
  };
}

/** Vetoes are absolute: one fires and the stance is opposed regardless of score. */
export function evaluateVetoes(pack, facts) {
  const triggered = [];
  for (const veto of pack?.decision_policy?.vetoes || []) {
    const parsed = parseCondition(veto.condition);
    if (!parsed) continue;
    const actual = readPath(facts, parsed.path);
    if (MISSING(actual)) continue;
    if (compare(actual, parsed.op, parsed.value)) {
      triggered.push({ id: veto.id, condition: veto.condition, actual, source_ids: veto.source_ids || [] });
    }
  }
  return triggered;
}

/** Highest band whose floor the ratio clears. */
export function stanceFromRatio(pack, ratio) {
  const bands = [...(pack?.decision_policy?.stance_bands || [])].sort((a, b) => b.min_ratio - a.min_ratio);
  for (const band of bands) if (ratio >= band.min_ratio) return band.stance;
  return "out_of_scope";
}

/**
 * The whole deterministic decision. `narratable` tells the caller whether spending a model
 * call is warranted at all -- an ineligible method has nothing for a model to say.
 */
export function decide(pack, facts, { min_coverage = 0.5 } = {}) {
  const eligibility = evaluateEligibility(pack, facts);
  if (!eligibility.eligible) {
    return {
      persona_id: pack?.persona_id,
      stance: "out_of_scope",
      reason: "eligibility",
      eligibility,
      narratable: false,
      score: null,
      vetoes_triggered: [],
    };
  }
  const scored = scoreMethod(pack, facts);
  // Enough of the method has to have run for its score to mean anything. A rule set that
  // could only evaluate a fifth of itself has not judged the company, it has sampled it.
  if (scored.declared_max && scored.coverage < min_coverage) {
    return {
      persona_id: pack?.persona_id,
      stance: "out_of_scope",
      reason: "insufficient_coverage",
      eligibility,
      score: scored,
      narratable: false,
      vetoes_triggered: [],
    };
  }
  const vetoes_triggered = evaluateVetoes(pack, facts);
  const ratio = scored.max_possible ? scored.score / scored.max_possible : 0;
  const stance = vetoes_triggered.length ? "opposed" : stanceFromRatio(pack, ratio);
  return {
    persona_id: pack?.persona_id,
    stance,
    reason: vetoes_triggered.length ? "veto" : "score",
    eligibility,
    score: scored,
    ratio,
    vetoes_triggered,
    narratable: true,
  };
}
