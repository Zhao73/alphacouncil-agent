import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

test("headless failures stay out of evidence and every completed debate round is observable", async () => {
  const dataDir = makeDataDir();
  // Invoking Node with Codex CLI flags fails immediately and predictably without network
  // access. This exercises the real worker-failure path without a platform-specific shell.
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: process.execPath },
  });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "AAPL",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `HEADLESS-FAILURE-${process.pid}`;
    const response = await server.callTool("analyze_symbol", {
      symbol: "AAPL",
      run_id: runId,
      wait_for_completion: true,
      tasks: ["market_data"],
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
    });
    const result = structured(response);
    const runDir = join(dataDir, "runs", runId);
    const diagnosticPath = join(runDir, "market_data.failure.json");

    assert.ok(response.result, "the failed workers must still produce a bounded final run");
    assert.ok(existsSync(diagnosticPath), "worker diagnostics must be stored separately");
    assert.deepEqual(result.run.packets[0].claims, []);
    assert.equal(result.run.packets[0].raw_text, "");
    assert.equal(result.run.task_status.market_data.diagnostic, diagnosticPath);

    const evidenceText = readFileSync(join(runDir, "evidence.json"), "utf8");
    const manifestText = readFileSync(join(runDir, "source_manifest.json"), "utf8");
    const diagnosticText = readFileSync(diagnosticPath, "utf8");
    assert.doesNotMatch(evidenceText, /bad option|unknown option|Usage:/i);
    assert.doesNotMatch(manifestText, /bad option|unknown option|Usage:/i);
    assert.match(diagnosticText, /bad option|unknown option|Usage:/i);

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "evidence_complete"), false);
    assert.deepEqual(
      events.filter((event) => event.type === "evidence_partial")
        .map(({ successful, failed, total }) => ({ successful, failed, total })),
      [{ successful: 0, failed: 1, total: 1 }],
      "a failure packet must not be reported as completed evidence",
    );
    const completedRounds = events.filter((event) => event.type === "agent_round_completed");
    assert.deepEqual(
      completedRounds.map(({ role, round }) => `${role}:${round}`),
      [
        "bull_researcher:1",
        "bear_researcher:1",
        "bull_researcher:2",
        "bear_researcher:2",
        "bull_researcher:3",
        "bear_researcher:3",
      ],
      "round completion telemetry must prove the cross-rebuttal dependency order",
    );
    assert.deepEqual(
      events.filter((event) => event.type === "debate_qna_gate")
        .map(({ status }) => status),
      ["failed"],
      "empty question/answer arrays must fail the advertised Q&A gate",
    );
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
