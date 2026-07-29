/**
 * Every authored method, and the overlay that reconciles it with the build spec.
 *
 * A build spec plans two tools per seat with placeholder names like `owner_earnings_rebuilder`
 * and a guessed output. Authoring replaces the arithmetic, and the honest name for a tool that
 * divides owner earnings by market capitalisation is `owner_earnings_yield`, not the
 * placeholder. Rather than hand-editing fifty-four planned entries and keeping two files in
 * sync forever, the authored definition is the source of truth and the spec is overlaid from
 * it: the planned entry keeps its position and gains the authored id, output and purpose.
 *
 * The overlay is positional: tool N replaces planned tool N. A seat may author MORE tools
 * than it planned -- a method that needs a third step to state itself should be able to say
 * so, which is why the downstream tool counts are derived from this list rather than from
 * seats-times-two. It may not author fewer: that would silently drop a planned step.
 */

import { coreSeats } from "./core-seats.mjs";
import { growthSeats } from "./growth-seats.mjs";
import { quantSeats } from "./quant-seats.mjs";
import { valueSeats } from "./value-seats.mjs";

/**
 * Tool outputs must be unique across the whole bench, and several seats legitimately compute
 * the same quantity: market capitalisation is price times shares no matter who asks for it.
 * Rather than making every author invent a distinct name for the same arithmetic -- which
 * would make the files harder to read and the duplication harder to see -- the shared name is
 * scoped to its seat here, in both the tool and every condition that reads it.
 *
 * A tool output is only ever consumed inside its own seat's policy, so scoping is invisible
 * to everything except the uniqueness check it exists to satisfy.
 */
function scopeOutputs(personaId, method) {
  if (!method?.tools?.length) return method;
  const rename = new Map(method.tools.map((tool) => [tool.output_id, `${tool.output_id}.${personaId}`]));
  const rewrite = (node) => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === "output_id" && rename.has(value) ? rename.get(value) : rewrite(value);
    }
    return out;
  };
  return {
    ...method,
    tools: method.tools.map((tool) => ({ ...rewrite(tool), output_id: rename.get(tool.output_id) })),
    eligibility: rewrite(method.eligibility),
    hard_vetoes: rewrite(method.hard_vetoes),
    scoring: rewrite(method.scoring),
  };
}

export const authoredMethods = Object.freeze(Object.fromEntries(
  Object.entries({ ...coreSeats, ...valueSeats, ...quantSeats, ...growthSeats })
    .map(([personaId, method]) => [personaId, scopeOutputs(personaId, method)]),
));

/**
 * Facts a seat's policy reads. Tool inputs become required and hard-decline at the
 * pre-decision gate; facts used only in a condition become optional, so a missing one leaves
 * the seat able to speak about what it does have.
 */
export function authoredFactUse(method) {
  const inputs = new Set();
  for (const tool of method?.tools || []) {
    for (const operand of tool.inputs || []) if (operand?.fact_id) inputs.add(operand.fact_id);
  }
  const referenced = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.fact_id === "string") referenced.add(node.fact_id);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk({ e: method?.eligibility, v: method?.hard_vetoes, s: method?.scoring });
  return {
    required: [...inputs],
    optional: [...referenced].filter((factId) => !inputs.has(factId)),
  };
}

/** Apply the authored tools and fact contract to one build-spec seat. */
export function overlayAuthoredSeat(seat) {
  const method = authoredMethods[seat.persona_id];
  if (!method?.tools?.length) return seat;
  const planned = seat.planned_dedicated_tools;
  if (method.tools.length < planned.length) {
    throw new Error(
      `${seat.persona_id}: authored ${method.tools.length} tools but the spec plans ${planned.length};`
      + " a seat may add a step, not silently drop one",
    );
  }
  const { required, optional } = authoredFactUse(method);
  return {
    ...seat,
    // A union with the planned list, not a replacement. The runtime required set is derived
    // from tool inputs anyway; this field is the seat's declaration of everything its policy
    // may read, and a condition reading a fact the seat never declared is rejected. Keeping
    // the planned entries also preserves the spec's own minimum, which a method expressible
    // in three facts would otherwise fall below.
    required_fact_types: [...new Set([...required, ...optional, ...seat.required_fact_types])],
    // Extra authored tools extend the plan rather than being refused: a method that needs a
    // third step to state itself should declare one, and the downstream counts are derived
    // from this list rather than from seats-times-two precisely so it can.
    planned_dedicated_tools: method.tools.map((tool, index) => ({
      ...(planned[index] || planned[planned.length - 1]),
      tool_id: tool.tool_id,
      purpose: tool.purpose || planned[index]?.purpose || `Authored step ${index + 1}.`,
      output_fact_types: [tool.output_id],
    })),
  };
}
