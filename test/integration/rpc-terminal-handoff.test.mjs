import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { compiledPersonaPacks } from "../../mcp/lib/personas-v3/registry.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";

const HANDOFF_END = "<!-- alphacouncil:handoff-method-seat-tail:v1:end -->";

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixedStatement(id, index) {
  const begin = `SEAT_${String(index + 1).padStart(2, "0")}_${id}_BEGIN|`;
  const end = `|SEAT_${String(index + 1).padStart(2, "0")}_${id}_END`;
  const statement = `${begin}${"X".repeat(2_048 - begin.length - end.length)}${end}`;
  assert.equal(statement.length, 2_048);
  return statement;
}

test("read_run defaults to a bounded compact payload while terminal text keeps the complete 26-seat handoff", async () => {
  const dataDir = makeDataDir();
  const runId = `RPC-LARGE-HANDOFF-${process.pid}`;
  const dir = join(dataDir, "runs", runId);
  mkdirSync(dir, { recursive: true });

  const ids = compiledPersonaPacks().ids();
  assert.equal(ids.length, 26);
  const statements = ids.map(fixedStatement);
  const handoff = [
    "# Large terminal handoff fixture",
    "",
    "<!-- alphacouncil:handoff-method-seat-tail:v1:begin -->",
    "## Final Per-Seat Method Statements — 26",
    ...ids.flatMap((id, index) => [
      `<!-- alphacouncil:handoff-method-seat:v1:${id} -->`,
      `- ${id}`,
      `  - Full statement: ${statements[index]}`,
    ]),
    HANDOFF_END,
  ].join("\n");
  const persistedHandoff = `${handoff}\n`;
  const evidenceBulk = `EVIDENCE_BULK_SENTINEL|${"E".repeat(Math.ceil(2.5 * 1024 * 1024))}`;
  const masterOpinions = ids.map((id, index) => ({
    master: id,
    stance: "cautious",
    confidence: "medium",
    voice_statement: statements[index],
  }));
  const evidence = {
    run_id: runId,
    symbol: "QQQ",
    as_of: "2026-08-03",
    language: "English",
    execution_mode: "background_codex_exec",
    entry_tool: "analyze_symbol",
    council_mode: "full",
    status: "complete",
    phase: "complete",
    tasks: ["market_data"],
    packets: [{ task: "market_data", summary: "fixture", claims: [], sources: [], open_questions: [] }],
    masters: ids,
    master_opinions: masterOpinions,
    grounding: { oversized_fixture: evidenceBulk },
  };
  const status = {
    run_id: runId,
    symbol: "QQQ",
    status: "complete",
    phase: "complete",
    report_contract: "full_v2",
    report_quality: "passed",
    selected_master_count: 26,
    recorded_master_count: 26,
    tasks: [{ task: "market_data", status: "completed" }],
    masters: ids.map((master) => ({ master, status: "completed" })),
  };
  const decision = {
    run_id: runId,
    role: "portfolio_manager",
    symbol: "QQQ",
    verdict: "Hold inside the bounded RPC fixture.",
    rating: "Hold",
    winner: "balanced",
    summary: `DECISION_SUMMARY|${"S".repeat(12_000)}`,
    valuation_range: "fixture range",
    position: "bounded fixture position",
    invalidation: ["fixture invalidation"],
    confidence: "medium",
    report_markdown: `DECISION_REPORT_BULK_SENTINEL|${"D".repeat(400_000)}`,
    raw_text: `DECISION_RAW_BULK_SENTINEL|${"R".repeat(400_000)}`,
  };
  const reportQuality = {
    schema_version: 3,
    contract_id: "full_v2",
    status: "passed",
    missing: [],
    handoff_method_statement_coverage: { selected_count: 26, full_statement_count: 26, status: "passed" },
  };

  writeJson(join(dir, "evidence.json"), evidence);
  writeJson(join(dir, "status.json"), status);
  writeJson(join(dir, "decision.json"), decision);
  writeJson(join(dir, "report_quality.json"), reportQuality);
  writeJson(join(dir, "source_manifest.json"), { sources: [] });
  writeFileSync(join(dir, "events.jsonl"), [
    JSON.stringify({ at: "2026-08-03T00:00:00.000Z", type: "background_run_queued" }),
    JSON.stringify({ at: "2026-08-03T00:01:00.000Z", type: "run_complete", status: "complete" }),
  ].join("\n") + "\n");
  writeFileSync(join(dir, "user_response.md"), persistedHandoff);
  writeFileSync(join(dir, "final_report.md"), `FINAL_REPORT_BULK_SENTINEL|${"F".repeat(600_000)}\n`);
  writeFileSync(join(dir, "all_agents.md"), `ALL_AGENTS_BULK_SENTINEL|${"A".repeat(600_000)}\n`);
  writeFileSync(join(dir, "artifact_index.md"), "# Artifact Index\n");

  const server = startServer({ dataDir });
  try {
    await server.request("initialize", {});
    const defaultResponse = await server.callTool("read_run", { run_id: runId });
    const explicitCompactResponse = await server.callTool("read_run", { run_id: runId, detail: "compact" });
    const compact = structured(defaultResponse);
    const explicitCompact = structured(explicitCompactResponse);

    assert.deepEqual(compact, explicitCompact, "omitting detail must remain compatible and select compact");
    assert.equal(defaultResponse.result.content[0].text, readFileSync(join(dir, "user_response.md"), "utf8"));
    assert.ok(defaultResponse.result.content[0].text.trimEnd().endsWith(HANDOFF_END));
    for (const statement of statements) assert.ok(defaultResponse.result.content[0].text.includes(statement));
    assert.deepEqual(Object.keys(compact).sort(), [
      "artifacts", "decision", "events_summary", "report_quality", "status", "user_response_markdown",
    ]);
    for (const omitted of ["evidence", "events", "source_manifest", "all_agents_markdown", "final_report_markdown"]) {
      assert.equal(omitted in compact, false, `${omitted} must stay out of compact structuredContent`);
    }
    assert.equal("report_markdown" in compact.decision, false);
    assert.equal("raw_text" in compact.decision, false);
    assert.equal(compact.decision.summary.length, 2_000, "compact decision prose is bounded");
    assert.deepEqual(compact.events_summary.type_counts, { background_run_queued: 1, run_complete: 1 });
    const compactBytes = Buffer.byteLength(JSON.stringify(compact));
    assert.ok(compactBytes < 128 * 1024, `compact structured payload was ${compactBytes} bytes`);
    assert.ok(!JSON.stringify(compact).includes("EVIDENCE_BULK_SENTINEL"));
    assert.ok(!JSON.stringify(compact).includes("FINAL_REPORT_BULK_SENTINEL"));

    const fullResponse = await server.callTool("read_run", { run_id: runId, detail: "full" });
    const full = structured(fullResponse);
    assert.equal(fullResponse.result.content[0].text, persistedHandoff);
    assert.ok(fullResponse.result.content[0].text.trimEnd().endsWith(HANDOFF_END));
    assert.equal(full.evidence.grounding.oversized_fixture, evidenceBulk);
    assert.match(full.all_agents_markdown, /^ALL_AGENTS_BULK_SENTINEL/);
    assert.match(full.final_report_markdown, /^FINAL_REPORT_BULK_SENTINEL/);
    assert.match(full.decision.report_markdown, /^DECISION_REPORT_BULK_SENTINEL/);
    assert.ok(Buffer.byteLength(JSON.stringify(full)) > 2.5 * 1024 * 1024, "detail=full must preserve the legacy large payload");
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
