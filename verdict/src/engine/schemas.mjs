// JSON schemas for every model output. They are given to the model (structured output / strict
// tool) and re-checked in code by a small validator, so hosts that cannot enforce a schema
// (Claude Code subagents, Codex) get the same guarantees with repair instructions.

const str = (description) => ({ type: "string", description });
const strArr = (description) => ({ type: "array", items: { type: "string" }, description });
const obj = (properties, description) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false, ...(description ? { description } : {}) });
const en = (values, description) => ({ type: "string", enum: values, description });

export const RATINGS = ["Buy", "Overweight", "Hold", "Underweight", "Sell"];

export const DESK_SCHEMA = obj({
  summary: str("3-5 sentences: what matters most for the investment case and why"),
  stance: en(["bullish", "bearish", "neutral", "mixed"], "what this desk's evidence implies"),
  findings: {
    type: "array",
    description: "4-8 specific findings, each dated and numeric where possible",
    items: obj({
      claim: str("one specific, verifiable claim"),
      impact: en(["bullish", "bearish", "neutral", "mixed"], "direction for the stock"),
      sources: strArr("IDs: your own S1, S2... and/or snapshot IDs such as data:fundamentals, news:N3"),
    }),
  },
  key_numbers: {
    type: "array",
    description: "the figures that matter most (e.g. consensus EPS, price target range, bear/base/bull values, short interest), each with its source",
    items: obj({ label: str("what the number is"), value: str("the number with unit, e.g. 6.10 USD, 18%, 2.1x"), source: str("S1 or a snapshot ID") }),
  },
  sources: {
    type: "array",
    description: "documents you used beyond the snapshot, numbered S1, S2, ...",
    items: obj({ id: str("S1, S2, ..."), title: str("page or document title"), url: str("https URL"), date: str("YYYY-MM-DD, YYYY-MM or empty") }),
  },
  gaps: strArr("what you could not find or verify; empty if none"),
});

export const CASE_SCHEMA = obj({
  thesis: str("the case in 2-4 sentences: mechanism, timing, and why the price does not reflect it"),
  points: {
    type: "array",
    description: "3-6 arguments, strongest first",
    items: obj({ point: str("one argument"), evidence: strArr("IDs from the research record, e.g. business:S2, data:quote, news:N4, lens:garp") }),
  },
  answer_to_other_side: str("the other side's strongest point, and your answer to it"),
  would_change_my_mind: str("observable evidence that would prove this case wrong"),
});

export const DECISION_SCHEMA = obj({
  rating: en(RATINGS, "five-step rating over a 12-month horizon"),
  conclusion: str("the decision and the 2-3 facts that drive it, 3-6 sentences"),
  confidence: en(["low", "medium", "high"], "confidence in the decision"),
  confidence_reason: str("what limits or supports confidence"),
  debate_winner: en(["bull", "bear", "balanced", "none"], "who won the bull/bear debate; none if there was no debate"),
  debate_reason: str("why; which questions stay unresolved (empty if no debate)"),
  bull_case: str("the best long argument in 2-3 sentences"),
  bear_case: str("the best short argument in 2-3 sentences"),
  valuation: obj({
    currency: str("ISO currency of the quote, e.g. USD"),
    bear: { type: "number", description: "per-share value, bear case" },
    base: { type: "number", description: "per-share value, base case" },
    bull: { type: "number", description: "per-share value, bull case" },
    method: str("how the values were derived"),
  }),
  price_levels: {
    type: "array",
    description: "3-4 price bands: avoid above / start a position / add below",
    items: obj({ range: str("e.g. > 250, 180-210, < 150"), action: str("avoid / start / add / trim"), why: str("what this price implies") }),
  },
  catalysts: { type: "array", items: obj({ event: str("event"), timing: str("date or window"), direction: en(["positive", "negative", "either"], "expected direction") }) },
  risks: { type: "array", items: obj({ risk: str("risk"), severity: en(["low", "medium", "high"], "severity") }) },
  position: obj({ action: str("e.g. initiate small long / hold / avoid"), sizing: str("sizing guidance"), entry: str("entry plan"), exit: str("exit / trim plan") }),
  horizons: obj({ short_term: str("1-4 weeks"), medium_term: str("3-6 months"), long_term: str("12 months") }),
  invalidation: strArr("2-4 observable conditions that prove the decision wrong"),
  gaps: strArr("material data gaps that limit the decision; empty if none"),
  key_sources: strArr("3-12 IDs the decision rests on"),
});

/** Minimal JSON-schema check for the subset used above. Returns a list of errors. */
export function check(schema, value, path = "$") {
  const errors = [];
  const walk = (s, v, p) => {
    if (s.type === "object") {
      if (!v || typeof v !== "object" || Array.isArray(v)) return errors.push(`${p}: expected object`);
      for (const k of s.required || []) if (v[k] === undefined) errors.push(`${p}.${k}: missing`);
      for (const [k, sub] of Object.entries(s.properties || {})) if (v[k] !== undefined) walk(sub, v[k], `${p}.${k}`);
    } else if (s.type === "array") {
      if (!Array.isArray(v)) return errors.push(`${p}: expected array`);
      v.forEach((x, i) => walk(s.items, x, `${p}[${i}]`));
    } else if (s.type === "string") {
      if (typeof v !== "string") return errors.push(`${p}: expected string`);
      if (s.enum && !s.enum.includes(v)) errors.push(`${p}: must be one of ${s.enum.join(" | ")}`);
    } else if (s.type === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${p}: expected number`);
    }
    return undefined;
  };
  walk(schema, value, path);
  return errors;
}

/** Hosts sometimes send JSON as a string or inside a code fence. */
export function coerce(value) {
  if (typeof value !== "string") return value;
  const t = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    return value;
  }
}
