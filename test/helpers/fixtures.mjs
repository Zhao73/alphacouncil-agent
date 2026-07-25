import { readFileSync } from "node:fs";
import { repoFile } from "./paths.mjs";
import { __test__ } from "../../mcp/server.mjs";

// Normalize line endings: a Windows checkout yields CRLF, which turns every
// `fixture.replace("...\n...")` in the tests into a silent no-op.
export const completeReport = readFileSync(repoFile("test/fixtures/complete-report.md"), "utf8")
  .replace(/\r\n/g, "\n")
  .trimEnd();

/** A normalized evidence packet whose single claim cites a source that exists. */
export function scopedPacket() {
  return __test__.normalizePacket({
    claims: [{ claim: "price", evidence: "source", confidence: "high", source_ids: ["S1"] }],
    sources: [{ id: "S1", title: "Quote", url: "https://example.com" }],
    confidence: "high",
  }, "market_data", "AAPL", "2026-06-22", "{}");
}

/** A run where every planned task and both researchers are recorded as completed. */
export function completeRun() {
  return {
    tasks: ["market_data"],
    task_status: { market_data: { task: "market_data", status: "completed" } },
    agent_status: {
      bull_researcher: { role: "bull_researcher", status: "completed" },
      bear_researcher: { role: "bear_researcher", status: "completed" },
      portfolio_manager: { role: "portfolio_manager", status: "pending" },
    },
    packets: [],
  };
}
