/**
 * Persona memory, with the time boundary that makes a backtest mean anything.
 *
 * Five layers: doctrine (immutable outside a release), episodic (append-only judgments),
 * belief (current positions, pointing back at episodes), postmortem (written only after the
 * horizon expires), working (discarded at the end of a run).
 *
 * The rule everything else exists to serve:
 *
 *     public_at <= as_of  AND  memory_created_at <= as_of
 *
 * Both clauses. The first keeps a model from reading a filing that had not been published.
 * The second keeps it from reading its own diary -- a note written in 2026 is not available
 * to a run dated 2024, however true it was. Drop the second clause and a model launders
 * hindsight through its own memory, every backtest built on it is fiction, and the returns
 * look wonderful for exactly the wrong reason.
 */

const LAYERS = ["doctrine", "episodic", "belief", "postmortem", "working"];
export const MEMORY_LAYERS = Object.freeze(LAYERS);

const day = 24 * 60 * 60 * 1000;
const toTime = (value) => {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : null;
};

export class LeakError extends Error {
  constructor(message) { super(message); this.name = "LeakError"; }
}

/**
 * Both clauses, applied to one record.
 *
 * A record missing either timestamp is *excluded*: an undated memory cannot be shown to be
 * in the past, and admitting it "because it is probably fine" is the whole failure mode.
 */
export function isVisible(record, asOf) {
  const cutoff = toTime(asOf);
  if (cutoff === null) throw new LeakError(`as_of is not a date: ${JSON.stringify(asOf)}`);
  const published = toTime(record?.public_at);
  const created = toTime(record?.memory_created_at);
  if (published === null || created === null) return false;
  return published <= cutoff && created <= cutoff;
}

/** The reading side of the leak rule. Everything a persona sees passes through here. */
export function visibleMemory(records, asOf, { layer } = {}) {
  return (records || [])
    .filter((r) => (layer ? r.layer === layer : true))
    .filter((r) => isVisible(r, asOf));
}

/**
 * Refuses to write a record that would be invisible to the run that created it.
 *
 * A memory dated after its own run is either a clock bug or hindsight being backdated
 * forwards; both should stop the run rather than settle quietly into the archive.
 */
export function assertWritable(record, asOf) {
  if (!LAYERS.includes(record?.layer)) throw new LeakError(`unknown memory layer: ${JSON.stringify(record?.layer)}`);
  const created = toTime(record?.memory_created_at);
  const cutoff = toTime(asOf);
  if (created === null) throw new LeakError("memory_created_at is required");
  if (cutoff === null) throw new LeakError(`as_of is not a date: ${JSON.stringify(asOf)}`);
  if (created > cutoff) throw new LeakError(`memory_created_at ${record.memory_created_at} is after as_of ${asOf}`);
  return true;
}

/** One judgment, as it was made, with the evidence it was allowed to see. */
export function episode({ persona_id, symbol, as_of, decision, evidence_ids = [], invalidation = [], horizon_days }) {
  return {
    layer: "episodic",
    persona_id,
    symbol,
    as_of,
    public_at: as_of,
    memory_created_at: as_of,
    stance: decision?.stance,
    reason: decision?.reason,
    score: decision?.score ? { score: decision.score.score, max_possible: decision.score.max_possible, coverage: decision.score.coverage } : null,
    evidence_ids,
    invalidation,
    horizon_days: horizon_days ?? null,
    expires_at: horizon_days ? new Date(toTime(as_of) + horizon_days * day).toISOString().slice(0, 10) : null,
  };
}

/**
 * A postmortem may not be written before the horizon it is judging has elapsed.
 *
 * Grading a call the day after making it is how a system convinces itself it was right: at
 * that distance the outcome is still mostly noise, and the note it leaves behind becomes a
 * belief that steers every later run.
 */
export function canWritePostmortem(ep, now) {
  const expires = toTime(ep?.expires_at);
  const t = toTime(now);
  if (expires === null) return { allowed: false, reason: "no_horizon" };
  if (t === null) return { allowed: false, reason: "no_clock" };
  return t >= expires ? { allowed: true } : { allowed: false, reason: "horizon_not_reached", expires_at: ep.expires_at };
}

export function postmortem({ episode: ep, now, outcome, failure_mode, rule_updates = [] }) {
  const gate = canWritePostmortem(ep, now);
  if (!gate.allowed) throw new LeakError(`postmortem refused: ${gate.reason}${gate.expires_at ? ` (expires ${gate.expires_at})` : ""}`);
  return {
    layer: "postmortem",
    persona_id: ep.persona_id,
    symbol: ep.symbol,
    as_of: ep.as_of,
    public_at: now,
    memory_created_at: now,
    outcome,
    // Which of the four it was matters more than whether the call made money: data, method,
    // timing and leakage each imply a different repair.
    failure_mode: failure_mode ?? null,
    rule_updates,
  };
}

/**
 * Current beliefs, each pointing back at the episode that formed it.
 *
 * Decayed rather than deleted: a stale belief is reported as stale so the reader can see
 * the model is running on an old read, which is different from having no view.
 */
export function currentBeliefs(records, asOf, { decay_days } = {}) {
  const cutoff = toTime(asOf);
  const visible = visibleMemory(records, asOf, { layer: "belief" });
  const latest = new Map();
  for (const record of visible) {
    const prev = latest.get(record.claim_id);
    if (!prev || toTime(record.memory_created_at) > toTime(prev.memory_created_at)) latest.set(record.claim_id, record);
  }
  return [...latest.values()].map((record) => {
    const age = decay_days ? Math.floor((cutoff - toTime(record.memory_created_at)) / day) : null;
    return { ...record, age_days: age, stale: decay_days ? age > decay_days : false };
  });
}

/**
 * What a persona is allowed to carry into a run at `as_of`.
 *
 * Working memory is never returned: it belongs to the run that made it and must not become
 * a long-term belief by default.
 */
export function recallFor(pack, records, asOf) {
  const decay = pack?.memory_policy?.belief_decay_days;
  return {
    episodic: visibleMemory(records, asOf, { layer: "episodic" }),
    beliefs: currentBeliefs(records, asOf, { decay_days: decay }),
    postmortems: visibleMemory(records, asOf, { layer: "postmortem" }),
    excluded_by_leak_rule: (records || []).filter((r) => r.layer !== "working" && !isVisible(r, asOf)).length,
  };
}
