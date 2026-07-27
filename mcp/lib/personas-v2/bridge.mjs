/**
 * Where Persona v2 meets a live run.
 *
 * The grounding block a run already assembles carries almost everything a deterministic
 * gate needs; it is simply shaped for prompts rather than for predicates. This maps it onto
 * the fact paths the packs address, and nothing here invents a value: a field the grounding
 * does not carry stays absent, so the gate declines rather than guesses.
 *
 * A pack with no v2 manifest is not an error. Masters that have not been migrated keep
 * running as v1 prompt personas, and the run records which of the two produced each seat so
 * a reader is never left to assume.
 */

import { loadPacks } from "./loader.mjs";
import { decide } from "./policy.mjs";
import { sliceFor } from "./slice.mjs";

let cached = null;
export function packs() {
  if (!cached) cached = loadPacks();
  return cached;
}
export function resetPacks() { cached = null; }

const finite = (value) => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const firstFinite = (...values) => values.map(finite).find((value) => value !== undefined);

/**
 * Map the option-chain digest stored in grounding onto the deterministic policy contract.
 *
 * The canonical fields come directly from `summarizeChain`: reference_expiry.atm_iv and
 * skew_25delta.put_minus_call are decimal volatility values. The older NOK run artifact used
 * atm_iv_12d and skew_25d_put_minus_call, also decimals, so those aliases remain readable.
 * Fields suffixed `_points` are already volatility points and must not be multiplied again.
 *
 * Realised volatility, net edge after friction and event coverage are intentionally only
 * passed through when an upstream calculator explicitly supplied them. A chain snapshot does
 * not contain enough history or event data to derive any of the three.
 */
export function optionsFactsFromGrounding(raw = {}) {
  const termAtm = Array.isArray(raw.term_structure)
    ? raw.term_structure.map((entry) => entry?.atm_iv).find((value) => finite(value) !== undefined)
    : undefined;
  const atmIv = firstFinite(raw.reference_expiry?.atm_iv, raw.atm_iv, raw.atm_iv_12d, termAtm);
  const skewAlreadyPoints = firstFinite(raw.skew_25d_put_minus_call_points, raw.skew_25d_points);
  const skewDecimal = firstFinite(raw.skew_25delta?.put_minus_call, raw.skew_25d_put_minus_call);
  const chainAvailable = raw.available === false ? false : Boolean(
    raw.available === true
      || atmIv !== undefined
      || (Array.isArray(raw.term_structure) && raw.term_structure.length > 0)
      || (Array.isArray(raw.expiries) && raw.expiries.length > 0),
  );

  return {
    chain_available: chainAvailable,
    ...(atmIv !== undefined ? { atm_iv: atmIv } : {}),
    ...(skewAlreadyPoints !== undefined
      ? { skew_25d_points: skewAlreadyPoints }
      : skewDecimal !== undefined ? { skew_25d_points: skewDecimal * 100 } : {}),
    ...(finite(raw.realized_minus_implied_vol_points) !== undefined
      ? { realized_minus_implied_vol_points: finite(raw.realized_minus_implied_vol_points) } : {}),
    ...(finite(raw.net_edge_vol_points) !== undefined
      ? { net_edge_vol_points: finite(raw.net_edge_vol_points) } : {}),
    ...(typeof raw.expiry_covers_next_event === "boolean"
      ? { expiry_covers_next_event: raw.expiry_covers_next_event } : {}),
  };
}

/**
 * Grounding -> the fact shape packs address.
 *
 * `screen.rules_computed` is the load-bearing one: a 20-F filer yields zero computable
 * rules, which is exactly the condition a financial-series method must decline on.
 */
export function factsFromRun(run) {
  const g = run?.grounding || {};
  const screen = g.screen || {};
  const metrics = {};
  for (const metric of screen.metrics || []) {
    if (metric && typeof metric.rule === "string" && metric.value !== undefined) metrics[metric.rule] = metric.value;
  }
  const options = optionsFactsFromGrounding(g.options || {});
  return {
    symbol: run?.symbol,
    as_of: run?.as_of,
    quote: g.quote || {},
    filer: {
      ...(g.filer || {}),
      // The screen only computes anything when SEC structured financials cover the filer.
      structured_financials: Number(screen.rules_computed || 0) > 0,
    },
    screen: {
      rules_computed: Number(screen.rules_computed || 0),
      rules_total: Number(screen.rules_total || 0),
      metrics,
    },
    options,
    macro: g.macro || {},
  };
}

/**
 * The deterministic pass over every selected master, before a single agent is spawned.
 *
 * Seats that cannot look are settled here for free. `to_run` is what still needs a model;
 * `declined` is what does not, and both are recorded so the report can show the difference
 * between a method that judged and a method that could not.
 */
export function planMasters(run, masterIds) {
  const reg = packs();
  const facts = factsFromRun(run);
  const decisions = [];
  const to_run = [];
  const declined = [];
  // No grounding is not the same as a screen that computed nothing. A run that was never
  // grounded has not been measured, so the gate has no facts to judge on and must not read
  // their absence as a failing result -- doing so would silence the whole bench on every
  // run that skips grounding.
  const grounded = Boolean(run?.grounding && typeof run.grounding === "object");
  for (const id of masterIds || []) {
    const pack = reg.get(id);
    if (!pack || !grounded) { to_run.push({ id, engine: "v1_prompt" }); continue; }
    const decision = decide(pack, facts);
    decisions.push({ ...decision, persona_id: id, engine: "v2_method_model", kind: pack.kind });
    if (decision.narratable) to_run.push({ id, engine: "v2_method_model", decision });
    else declined.push({ id, engine: "v2_method_model", decision });
  }
  return { facts, decisions, to_run, declined };
}

/**
 * A declined seat still has to report, because the completeness gate counts every selected
 * master and a seat that is merely skipped would leave the run permanently incomplete.
 *
 * The deterministic pass already produced the verdict, so the opinion is written directly
 * and no agent is spawned. That is the whole saving: the seat is accounted for, the reader
 * sees why it could not look, and nothing was spent to find out.
 */
export function declinedOpinion(run, id, decision) {
  const unmet = (decision.eligibility?.unmet || [])
    .map((u) => `${u.requirement} [${u.reason}${u.actual !== undefined ? `: ${u.actual}` : ""}]`)
    .join("; ");
  const pack = packs().get(id);
  const name = pack?.display_name?.en || id;
  return {
    master: id,
    symbol: run.symbol,
    as_of: run.as_of,
    stance: "out_of_scope",
    verdict: `${name} cannot evaluate ${run.symbol}: ${decision.reason}`,
    summary: decision.reason === "eligibility"
      ? `This method's entry requirements are not met for ${run.symbol}, so it returns no judgment. Unmet: ${unmet || "n/a"}. Declining is a conclusion, not an abstention, and it was reached deterministically without spending a model call.`
      : `Too little of this method could be computed for ${run.symbol} to be judged rather than sampled (coverage ${Math.round((decision.score?.coverage || 0) * 100)}%), so it returns no judgment.`,
    key_findings: [],
    disagreements: [],
    disqualifiers_triggered: (decision.eligibility?.unmet || []).map((u) => u.requirement),
    what_would_change_my_mind: (decision.eligibility?.unmet || []).map((u) => `${u.requirement} becomes available and is met`),
    source_ids: [],
    confidence: "high",
    engine: "v2_method_model",
    deterministic_stance: "out_of_scope",
    decision_reason: decision.reason,
  };
}

/**
 * What one v2 seat is allowed to read, and the deterministic verdict it must narrate.
 *
 * Handed to the agent so the prompt describes a decision it cannot overturn: the model
 * explains, it does not choose.
 */
export function briefFor(run, masterId, evidencePackets) {
  const pack = packs().get(masterId);
  if (!pack) return null;
  const facts = factsFromRun(run);
  const decision = decide(pack, facts);
  const slice = sliceFor(pack, { frozen: facts, packets: evidencePackets || run?.packets || [] });
  return {
    persona_id: masterId,
    engine: "v2_method_model",
    kind: pack.kind,
    display_name: pack.display_name,
    decision,
    visible_tasks: slice.packets.map((p) => p.task),
    excluded_tasks: slice.excluded,
    admission_shortfall: pack.admission_shortfall,
  };
}

/**
 * A recorded opinion must not contradict the arithmetic that produced it.
 *
 * The model narrates; if its stance disagrees with the deterministic verdict, the
 * deterministic one stands and the disagreement is recorded rather than resolved silently.
 * This is the same rule that failed once already: a stance that survives normalization
 * without being checked is how ten seats came to read `cautious`.
 */
export function reconcileOpinion(run, masterId, opinion) {
  const pack = packs().get(masterId);
  // Same rule as the planner: an ungrounded run has no arithmetic to reconcile against, so
  // the narrated stance is all there is and overriding it would be inventing a verdict.
  if (!pack || !run?.grounding) return { opinion, engine: "v1_prompt", overridden: false };
  const decision = decide(pack, factsFromRun(run));
  if (opinion?.stance === decision.stance) {
    return { opinion: { ...opinion, engine: "v2_method_model", deterministic_stance: decision.stance }, engine: "v2_method_model", overridden: false };
  }
  return {
    engine: "v2_method_model",
    overridden: true,
    opinion: {
      ...opinion,
      stance: decision.stance,
      engine: "v2_method_model",
      deterministic_stance: decision.stance,
      narrated_stance: opinion?.stance,
      override_reason: `the deterministic ${pack.persona_id} policy returned ${decision.stance} (${decision.reason}); the narrated stance did not agree and does not govern`,
    },
  };
}
