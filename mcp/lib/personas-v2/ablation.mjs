/**
 * Experiments whose job is to prove the bench decorative.
 *
 * A feature that cannot fail its own test is a decoration. These are the cheapest and most
 * decisive of the battery in docs/persona-v2-spec.md:
 *
 *   name swap   -- change only the label. A real method does not notice.
 *   policy swap -- run Taleb's policy under Buffett's name. A real system follows the
 *                  policy; a performance follows the name.
 *
 * They are deterministic because the layer under test is deterministic: no model is called,
 * so a difference in outcome can only come from the module that was swapped.
 */

import { decide } from "./policy.mjs";

/** Fields a decision may legitimately carry that are identity rather than judgment. */
const IDENTITY_FIELDS = new Set(["persona_id"]);

/** The judgment, with identity stripped, so two decisions can be compared as verdicts. */
export function judgmentOf(decision) {
  const copy = {};
  for (const [key, value] of Object.entries(decision || {})) {
    if (IDENTITY_FIELDS.has(key)) continue;
    copy[key] = value;
  }
  return JSON.stringify(copy);
}

/**
 * Rename a pack without touching a single rule.
 *
 * If the verdict moves, the differentiation was in the label. In the deterministic layer
 * that is a structural guarantee rather than a hope, and that is the point of testing it
 * here: it pins the guarantee before the narrative layer, which cannot offer one, is added.
 */
export function nameSwap(pack, newId = "master_impostor", newName = "Impostor Method Model") {
  return { ...pack, persona_id: newId, display_name: { ...pack.display_name, en: newName } };
}

/** Keep the identity, take the other model's decision policy. */
export function policySwap(pack, donor) {
  return { ...pack, decision_policy: donor.decision_policy, _policy_from: donor.persona_id };
}

/** Keep the identity and policy, take the other model's evidence. */
export function evidenceSwap(factsA, factsB) {
  return [factsB, factsA];
}

/**
 * @returns {{stable: boolean, before: string, after: string}} stable === the verdict did
 * not move when only the name did. `false` means the system is acting.
 */
export function runNameSwap(pack, facts) {
  const before = decide(pack, facts);
  const after = decide(nameSwap(pack), facts);
  return {
    experiment: "name_swap",
    stable: judgmentOf(before) === judgmentOf(after),
    before: before.stance,
    after: after.stance,
    persona_id_before: before.persona_id,
    persona_id_after: after.persona_id,
  };
}

/**
 * @returns {{follows_policy: boolean}} true when the verdict tracked the donor policy
 * rather than the host name.
 */
export function runPolicySwap(host, donor, facts) {
  const hostOwn = decide(host, facts);
  const donorOwn = decide(donor, facts);
  const hybrid = decide(policySwap(host, donor), facts);
  return {
    experiment: "policy_swap",
    host: host.persona_id,
    donor: donor.persona_id,
    host_stance: hostOwn.stance,
    donor_stance: donorOwn.stance,
    hybrid_stance: hybrid.stance,
    follows_policy: judgmentOf(hybrid) === judgmentOf(donorOwn),
    follows_name: judgmentOf(hybrid) === judgmentOf(hostOwn) && judgmentOf(donorOwn) !== judgmentOf(hostOwn),
  };
}

/**
 * Do these models actually see different securities?
 *
 * Pairwise agreement across a case set. Compared against a model's agreement with itself,
 * this is what separates a bench from a chorus: if two models agree as often as one model
 * agrees with itself, the personas produced no differentiation and the report has to say so
 * rather than presenting them as independent seats.
 */
export function pairwiseAgreement(packs, cases) {
  const rows = [];
  for (let i = 0; i < packs.length; i += 1) {
    for (let j = i + 1; j < packs.length; j += 1) {
      let same = 0;
      for (const facts of cases) {
        if (decide(packs[i], facts).stance === decide(packs[j], facts).stance) same += 1;
      }
      rows.push({ a: packs[i].persona_id, b: packs[j].persona_id, agreement: cases.length ? same / cases.length : 0 });
    }
  }
  const mean = rows.length ? rows.reduce((sum, r) => sum + r.agreement, 0) / rows.length : 0;
  return { pairs: rows, mean_agreement: mean };
}

/**
 * Self-consistency of the deterministic layer is 1 by construction. It is computed rather
 * than asserted so the same diagnostic keeps working once a narrative layer -- which has no
 * such guarantee -- sits on top of it.
 */
export function selfConsistency(pack, cases, repeats = 3) {
  let agree = 0;
  let total = 0;
  for (const facts of cases) {
    const first = decide(pack, facts).stance;
    for (let r = 1; r < repeats; r += 1) {
      total += 1;
      if (decide(pack, facts).stance === first) agree += 1;
    }
  }
  return total ? agree / total : 1;
}

/**
 * The verdict the report must print.
 *
 * `none` means the seats cannot be told apart and must not be presented as a bench. The
 * threshold is a margin, not a hope: differentiation counts only when models disagree with
 * each other appreciably more than a model disagrees with itself.
 */
export function differentiation(packs, cases, { margin = 0.15 } = {}) {
  const pairwise = pairwiseAgreement(packs, cases);
  const self = packs.length ? packs.reduce((sum, p) => sum + selfConsistency(p, cases), 0) / packs.length : 1;
  const gap = self - pairwise.mean_agreement;
  const verdict = gap >= margin * 2 ? "effective" : gap >= margin ? "weak" : "none";
  return {
    self_consistency: self,
    mean_pairwise_agreement: pairwise.mean_agreement,
    gap,
    verdict,
    pairs: pairwise.pairs,
  };
}
