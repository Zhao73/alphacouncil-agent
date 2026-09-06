import { readFileSync } from "node:fs";
import { buildFactPack } from "../../mcp/lib/personas-v3/typed-facts.mjs";
import { repoFile } from "./paths.mjs";

// Reuse the existing synthetic policy inputs so worker tests reach a scored decision.
// No-input fixtures intentionally abstain and no longer dispatch a headless voice worker.
export function methodVoiceFacts(asOf) {
  const simulation = JSON.parse(readFileSync(repoFile("knowledge/ai-assisted-solo/experiments/simulation-input.json"), "utf8"));
  const facts = [...new Map(simulation.seat_inputs.flatMap((seat) => seat.fact_pack.facts)
    .map((fact) => [fact.fact_id, { ...fact, as_of: asOf }])).values()];
  return {
    typed_fact_pack: buildFactPack(facts, { asOf }),
    typed_fact_sources: [{
      source_id: "synthetic:machine-simulation", source_kind: "market_snapshot",
      title: "Synthetic method fixture", url: "https://example.com/synthetic-facts",
      public_at: simulation.as_of, retrieved_at: asOf, locator: {},
    }],
  };
}
