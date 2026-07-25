import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { invalidParams } from "./errors.mjs";

/**
 * Industry framing.
 *
 * A question like "how does memory look right now" cannot be answered by a pipeline whose
 * only entry point is a single ticker, and it cannot be answered honestly by asking a
 * model to list the participants either -- that produces the names it saw most often,
 * silently dropping the ones that do not file with the SEC. SK hynix and Kioxia are
 * exactly the companies such a list loses, and in memory they are most of the industry.
 *
 * So the participant list is data, hand-maintained and explicitly incomplete, and the map
 * carries the two things a model reliably gets wrong on its own: which link in the chain
 * currently binds, and who actually creates the orders.
 */
const MAP_PATH = fileURLToPath(new URL("../../data/industry-map.json", import.meta.url));

let cached = null;
function load() {
  if (!cached) cached = JSON.parse(readFileSync(MAP_PATH, "utf8"));
  return cached;
}

export function listIndustries() {
  const { industries } = load();
  return Object.entries(industries).map(([id, entry]) => ({
    id,
    title: entry.title,
    aliases: entry.aliases,
    participant_count: entry.layers.reduce((n, l) => n + l.participants.length, 0),
  }));
}

/** Resolve a free-text industry query against ids and aliases. */
export function resolveIndustry(query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) throw invalidParams("industry query is empty");
  const { industries } = load();
  for (const [id, entry] of Object.entries(industries)) {
    if (id === needle) return { id, ...entry };
    if (entry.aliases.some((a) => a.toLowerCase() === needle)) return { id, ...entry };
  }
  // Fall back to substring so "存储芯片行业" or "HBM memory" still lands.
  for (const [id, entry] of Object.entries(industries)) {
    if (entry.aliases.some((a) => needle.includes(a.toLowerCase()) || a.toLowerCase().includes(needle))) {
      return { id, ...entry };
    }
  }
  return null;
}

/**
 * Everything a research run needs to start on an industry rather than a ticker.
 *
 * Deliberately returns no verdict. It returns the frame: participants by chain position
 * with their market and filing regime, who drives demand, the questions that must be
 * answered, and how the industry behaves through a cycle -- because reading a cyclical's
 * low P/E as cheap is the most expensive mistake available here.
 */
export function industryBrief(query) {
  const entry = resolveIndustry(query);
  if (!entry) {
    const known = listIndustries().map((i) => `${i.id} (${i.aliases.slice(0, 3).join(", ")})`);
    throw invalidParams(`no industry map for "${query}". Mapped industries: ${known.join("; ") || "none"}. Add one in data/industry-map.json.`);
  }

  const participants = entry.layers.flatMap((layer) =>
    layer.participants.map((p) => ({ ...p, layer: layer.layer })));

  // Which names this pipeline can screen mechanically, and which it cannot. Saying so up
  // front stops a run from quietly becoming US-only.
  const secScreenable = participants.filter((p) => p.symbol && p.market.includes("US"));
  const needsOtherSource = participants.filter((p) => p.symbol && !p.market.includes("US"));
  const unlisted = participants.filter((p) => !p.symbol);

  return {
    id: entry.id,
    title: entry.title,
    layers: entry.layers,
    participants,
    demand_drivers: entry.demand_drivers,
    key_questions: entry.key_questions,
    cyclicality: entry.cyclicality,
    coverage: {
      sec_screenable: secScreenable.map((p) => p.symbol),
      needs_local_regulator_feed: needsOtherSource.map((p) => ({ symbol: p.symbol, market: p.market })),
      unlisted: unlisted.map((p) => p.name),
      note:
        "screen_ticker and the SEC concepts cover US filers only. Korean, Japanese and Taiwanese participants "
        + "have to be researched through search and their own regulators (DART, EDINET, MOPS), and unlisted "
        + "capacity still moves global supply. Treat any conclusion drawn only from the US-listed subset as "
        + "partial, and say so.",
    },
    how_to_use:
      "This is a frame, not an answer. Run the council on the participants that matter for the question asked, "
      + "check the demand drivers' own disclosures rather than press coverage of them, and answer the key "
      + "questions explicitly. Guidance is not an order: distinguish what a customer said it plans to spend "
      + "from what has actually been ordered and at what lead time.",
  };
}
