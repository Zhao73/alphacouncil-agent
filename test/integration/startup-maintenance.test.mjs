import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer } from "../helpers/rpc-client.mjs";

test("server startup runs the bounded expired-selection cleanup", async () => {
  const dataDir = makeDataDir();
  const selectionId = "SEL-11111111-1111-4111-8111-111111111111";
  const selectionsDir = join(dataDir, "selections");
  const selectionFile = join(selectionsDir, `${selectionId}.json`);
  mkdirSync(join(selectionsDir, "receipts"), { recursive: true });
  writeFileSync(selectionFile, `${JSON.stringify({
    schema_version: 1,
    selection_id: selectionId,
    expires_at: "2000-01-01T00:00:00.000Z",
  })}\n`);

  const server = startServer({ dataDir });
  try {
    await server.request("initialize", {});
    assert.equal(existsSync(selectionFile), false);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("server startup terminalizes an orphaned background analysis", async () => {
  const dataDir = makeDataDir();
  const runId = `ORPHANED-BACKGROUND-${process.pid}`;
  const runDir = join(dataDir, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  const startedAt = "2026-07-27T00:00:00.000Z";
  writeFileSync(join(runDir, "evidence.json"), `${JSON.stringify({
    run_id: runId,
    symbol: "AAPL",
    as_of: "2026-07-27",
    language: "English",
    dry_run: false,
    execution_mode: "background_codex_exec",
    entry_tool: "analyze_symbol",
    visibility_required: false,
    started_at: startedAt,
    updated_at: startedAt,
    completed_at: null,
    status: "running",
    phase: "evidence",
    tasks: ["market_data"],
    task_status: { market_data: { task: "market_data", status: "running", pid: 999999 } },
    agent_status: {
      bull_researcher: { role: "bull_researcher", status: "pending" },
      bear_researcher: { role: "bear_researcher", status: "pending" },
      portfolio_manager: { role: "portfolio_manager", status: "pending" },
    },
    packets: [],
    masters: ["master_buffett"],
    master_selection: { status: "consumed", selection_id: "SEL-FIXTURE" },
    master_opinions: [],
    master_status: { master_buffett: { master: "master_buffett", status: "pending" } },
    verifier_verdicts: [],
    grounding: null,
    seat_weight_overrides: {},
  }, null, 2)}\n`);

  const server = startServer({ dataDir });
  try {
    await server.request("initialize", {});
    const response = await server.callTool("read_run", { run_id: runId });
    assert.ok(response.result);
    const status = response.result.structuredContent.status;
    assert.equal(status.status, "failed");
    assert.equal(status.phase, "server_interrupted");
    assert.ok(status.completed_at);

    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
    assert.equal(evidence.background_error, "AlphaCouncil MCP process ended before the background analysis reached a terminal state.");
    assert.equal(evidence.task_status.market_data.status, "failed");
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "background_run_interrupted").length, 1);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
