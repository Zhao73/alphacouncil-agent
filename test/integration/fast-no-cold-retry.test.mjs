import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("fast stalled debate and PM never start a sub-grace cold retry", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "alphacouncil-fast-no-cold-retry-"));
  const driver = join(dataDir, "stall-codex.mjs");
  const launchLog = join(dataDir, "launches.jsonl");
  const previousDataDir = process.env.ALPHACOUNCIL_AGENT_DATA_DIR;
  const previousCodexCommand = process.env.ALPHACOUNCIL_AGENT_CODEX_CMD;
  writeFileSync(driver, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(launchLog)}, JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }) + "\\n");
for await (const chunk of process.stdin) void chunk;
await new Promise((resolve) => setTimeout(resolve, 2_000));
`);
  let command = driver;
  if (process.platform === "win32") {
    command = join(dataDir, "stall-codex.cmd");
    writeFileSync(command, `@"${process.execPath}" "${driver}" %*\r\n`);
  } else {
    chmodSync(driver, 0o755);
  }
  process.env.ALPHACOUNCIL_AGENT_DATA_DIR = dataDir;
  process.env.ALPHACOUNCIL_AGENT_CODEX_CMD = command;

  try {
    const [{ runDebateRole }, { runPath }] = await Promise.all([
      import("../../mcp/lib/orchestrator.mjs"),
      import("../../mcp/lib/run-store.mjs"),
    ]);
    const run = {
      run_id: "FAST-NO-COLD-RETRY",
      symbol: "QQQ",
      as_of: "2026-08-28",
      language: "English",
      council_mode: "full",
      council_pace: "fast",
      execution_mode: "headless",
      time_budget_ms: 900_000,
      deadline_at: new Date(Date.now() + 900_000).toISOString(),
      started_at: new Date().toISOString(),
      status: "running",
      phase: "debate",
      dry_run: false,
      decision_requested: true,
      tasks: [],
      task_status: {},
      masters: [],
      master_status: {},
      master_opinions: [],
      packets: [],
      verifier_verdicts: [],
      agent_status: {},
      grounding: { instrument: { research_model: "fund_lookthrough" } },
    };
    mkdirSync(runPath(run.run_id), { recursive: true });

    const debate = await runDebateRole(run, "bull_researcher", {
      round: 1,
      brief: "long",
      retryOnTimeout: true,
    }, 1_000);
    const manager = await runDebateRole(run, "portfolio_manager", {
      bull: {},
      bear: {},
      outputMode: "public_equity",
      structuredDecisionOnly: true,
      retryOnTimeout: true,
      reserveRepair: true,
    }, 1_000);

    assert.equal(debate.result.timedOut, true);
    assert.equal(manager.result.timedOut, true);
    assert.equal(debate.attempts, 1);
    assert.equal(manager.attempts, 1);
    const launches = readFileSync(launchLog, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(launches.length, 2, "one launch for debate and one for PM");
    const events = readFileSync(join(runPath(run.run_id), "events.jsonl"), "utf8");
    assert.doesNotMatch(events, /"type":"agent_retry"/u);
    assert.doesNotMatch(events, /"attempt_kind":"timeout_retry"/u);
  } finally {
    if (previousDataDir === undefined) delete process.env.ALPHACOUNCIL_AGENT_DATA_DIR;
    else process.env.ALPHACOUNCIL_AGENT_DATA_DIR = previousDataDir;
    if (previousCodexCommand === undefined) delete process.env.ALPHACOUNCIL_AGENT_CODEX_CMD;
    else process.env.ALPHACOUNCIL_AGENT_CODEX_CMD = previousCodexCommand;
    // A Windows .cmd shim can release its executing script a fraction after the wrapper exits.
    // Let Node's bounded rimraf retry only that transient lock; assertion failures remain fatal.
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
