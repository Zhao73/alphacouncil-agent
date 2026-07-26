/**
 * Information asymmetry, enforced.
 *
 * The frozen fact pack is shared and identical for every model -- four methods must not
 * discover four market caps in the name of independence. What differs is what each one is
 * allowed to look at on top of it, and that is the only lever in this system that produces
 * disagreement from something other than tone.
 *
 * A model that never sees the price cannot anchor on the drawdown. That is the point, and
 * it only holds if the exclusion is applied here rather than requested in a prompt.
 */

/** Facts every model shares and none may overwrite. */
export const FROZEN_KEYS = Object.freeze(["quote", "filer", "screen", "as_of", "symbol"]);

export class SliceError extends Error {
  constructor(message) { super(message); this.name = "SliceError"; }
}

/**
 * The evidence one model may read: the frozen pack, plus only the analyst packets its
 * research policy names.
 *
 * @returns {{frozen: object, packets: object[], excluded: string[], slice: string[]}}
 */
export function sliceFor(pack, { frozen = {}, packets = [] } = {}) {
  const slice = pack?.research_policy?.evidence_slice;
  // No declared slice means the model sees everything. That is a legitimate configuration,
  // but it is recorded so a differentiation result can be read in the right light: seats
  // sharing all evidence should not then be credited for agreeing.
  const unrestricted = !Array.isArray(slice) || slice.length === 0;
  const allowed = new Set(unrestricted ? (packets || []).map((p) => p.task) : slice);
  const kept = (packets || []).filter((p) => allowed.has(p.task));
  const excluded = (packets || []).filter((p) => !allowed.has(p.task)).map((p) => p.task);
  return {
    persona_id: pack?.persona_id,
    frozen: pickFrozen(frozen),
    packets: kept,
    slice: unrestricted ? "unrestricted" : [...slice],
    excluded,
  };
}

function pickFrozen(frozen) {
  const out = {};
  for (const key of FROZEN_KEYS) if (key in (frozen || {})) out[key] = frozen[key];
  return out;
}

/**
 * A model may disagree with a derived number. It may not silently replace a filed one.
 *
 * Recomputation is where independence is supposed to live, so the check is on the write
 * rather than on the intent: a private figure that contradicts the frozen pack is kept and
 * flagged as a dispute, never merged over the top of it.
 */
export function reconcile(frozen, recomputed) {
  const disputes = [];
  const accepted = {};
  for (const [path, value] of Object.entries(recomputed || {})) {
    const filed = FROZEN_KEYS.some((key) => path === key || path.startsWith(`${key}.`))
      ? readPath(frozen, path)
      : undefined;
    if (filed !== undefined && filed !== null && filed !== value) {
      disputes.push({ path, filed, recomputed: value });
      continue;
    }
    accepted[path] = value;
  }
  return { accepted, disputes };
}

function readPath(node, path) {
  return String(path).split(".").reduce((n, k) => (n && typeof n === "object" && k in n ? n[k] : undefined), node);
}

/**
 * Round one carries no name and no style: evidence, computation, decision, confidence,
 * the abandonment condition, and where it is most likely wrong. Identity is attached
 * afterwards, so the debate argues with a judgment before it knows whose it is.
 */
export function anonymize(opinion) {
  const {
    persona_id, master, display_name, voice, // eslint-disable-line no-unused-vars
    ...rest
  } = opinion || {};
  return { ...rest, submitted_as: "anonymous" };
}

/** Two anonymous submissions are comparable only if identity really is gone. */
export function assertAnonymous(submission) {
  for (const key of ["persona_id", "master", "display_name", "voice"]) {
    if (key in (submission || {})) throw new SliceError(`anonymous submission still carries ${key}`);
  }
  return true;
}
