import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { repoRoot } from "../helpers/paths.mjs";

test("an unexpected background orchestrator error still writes the standard failure package", () => {
  const dataDir = makeDataDir();
  const runId = `UNHANDLED-BACKGROUND-${process.pid}`;
  const dir = join(dataDir, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "evidence.json"), `${JSON.stringify({
    run_id: runId,
    symbol: "RKLB",
    as_of: "2026-07-28",
    language: "English",
    council_mode: "quick",
    execution_mode: "background_codex_exec",
    entry_tool: "analyze_symbol",
    status: "running",
    phase: "evidence",
    started_at: new Date().toISOString(),
    tasks: ["market_data"],
    task_status: { market_data: { task: "market_data", status: "running" } },
    agent_status: {
      bull_researcher: { role: "bull_researcher", status: "pending" },
      bear_researcher: { role: "bear_researcher", status: "pending" },
      portfolio_manager: { role: "portfolio_manager", status: "pending" },
    },
    packets: [],
    masters: ["master_buffett"],
    master_opinions: [],
    master_status: { master_buffett: { master: "master_buffett", status: "pending" } },
    verifier_verdicts: [],
    grounding: { facts_unavailable: true },
    seat_weight_overrides: {},
  }, null, 2)}\n`);
  writeFileSync(join(dir, "status.json"), `${JSON.stringify({
    tasks: [{
      task: "market_data",
      status: "completed",
      completed_at: "2026-07-28T00:01:00.000Z",
      updated_at: "2026-07-28T00:01:00.000Z",
    }],
    agents: [
      { role: "bull_researcher", status: "pending" },
      { role: "bear_researcher", status: "pending" },
      { role: "portfolio_manager", status: "pending" },
    ],
    masters: [{ master: "master_buffett", status: "pending" }],
  }, null, 2)}\n`);
  try {
    const moduleUrl = new URL("../../mcp/lib/orchestrator.mjs", import.meta.url).href;
    const script = `import { finalizeUnhandledBackgroundFailure } from ${JSON.stringify(moduleUrl)}; finalizeUnhandledBackgroundFailure(${JSON.stringify(runId)}, "fixture", new Error("SECRET_INTERNAL_STACK"));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: repoRoot,
      env: { ...process.env, ALPHACOUNCIL_AGENT_DATA_DIR: dataDir },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    for (const name of ["decision.json", "manager_synthesis.json", "final_report.md", "user_response.md", "report_quality.json", "artifact_index.md", "status.json", "events.jsonl"]) {
      assert.equal(existsSync(join(dir, name)), true, name);
    }
    const decision = JSON.parse(readFileSync(join(dir, "decision.json"), "utf8"));
    const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
    assert.equal(decision.decision_available, false);
    assert.equal(decision.rating, null);
    assert.equal(status.status, "failed");
    assert.equal(status.phase, "failed");
    assert.equal(status.tasks[0].status, "completed", "a newer terminal task state must survive finalization");
    assert.equal(status.masters[0].status, "skipped");
    assert.equal(status.masters[0].error, "not_run_upstream_evidence_failure");
    assert.equal(status.agents[0].status, "skipped");
    assert.doesNotMatch(readFileSync(join(dir, "final_report.md"), "utf8"), /SECRET_INTERNAL_STACK/);
  } finally {
    removeDataDir(dataDir);
  }
});
