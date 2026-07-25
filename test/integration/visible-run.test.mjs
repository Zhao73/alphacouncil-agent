import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";
import { completeReport } from "../helpers/fixtures.mjs";

let dataDir;
const visibleRunId = `SELFTEST-VISIBLE-${process.pid}`;
const incompleteRunId = `SELFTEST-INCOMPLETE-${process.pid}`;
let visibleDir;
let incompleteDir;
const recorded = {};

const packet = (summary, extra = {}) => ({
  summary,
  claims: [],
  metrics: {},
  sources: [],
  open_questions: [],
  confidence: "medium",
  ...extra,
});

before(async () => {
  dataDir = makeDataDir();
  visibleDir = join(dataDir, "runs", visibleRunId);
  incompleteDir = join(dataDir, "runs", incompleteRunId);
  const server = startServer({ dataDir });

  // A complete visible run: plan, record evidence, both researchers, then the PM.
  await server.callTool("plan_visible_run", { symbol: "NOK", run_id: visibleRunId, tasks: ["market_data"] });
  await server.callTool("record_visible_packet", {
    run_id: visibleRunId,
    task: "market_data",
    thread_id: "thread-visible-market",
    thread_title: "AlphaCouncil Agent NOK market_data",
    packet: packet("visible packet"),
  });
  await server.callTool("record_visible_decision", {
    run_id: visibleRunId,
    role: "bull_researcher",
    thread_id: "thread-visible-bull",
    thread_title: "AlphaCouncil Agent NOK bull_researcher",
    packet: { verdict: "BULL_OK", rating: "Buy", winner: "bull", summary: "visible bull", confidence: "medium" },
  });
  await server.callTool("record_visible_decision", {
    run_id: visibleRunId,
    role: "bear_researcher",
    thread_id: "thread-visible-bear",
    thread_title: "AlphaCouncil Agent NOK bear_researcher",
    packet: { verdict: "BEAR_OK", rating: "Sell", winner: "bear", summary: "visible bear", confidence: "medium" },
  });
  recorded.pm = structured(await server.callTool("record_visible_decision", {
    run_id: visibleRunId,
    role: "portfolio_manager",
    thread_id: "thread-visible-pm",
    thread_title: "AlphaCouncil Agent NOK portfolio_manager",
    packet: {
      verdict: "VISIBLE_OK",
      rating: "Hold",
      winner: "balanced",
      summary: "visible decision",
      confidence: "medium",
      report_markdown: completeReport,
    },
  }));

  // A late packet and a replay must not downgrade an already-complete run.
  recorded.late = structured(await server.callTool("record_visible_packet", {
    run_id: visibleRunId,
    task: "market_data",
    thread_id: "thread-visible-market",
    thread_title: "AlphaCouncil Agent NOK market_data",
    packet: packet("late visible packet update"),
  }));
  recorded.replay = structured(await server.callTool("record_visible_packet", {
    run_id: visibleRunId,
    task: "market_data",
    thread_id: "thread-visible-market",
    thread_title: "AlphaCouncil Agent NOK market_data",
    packet: packet("replayed visible packet", { raw_text: "original visible agent output" }),
  }));

  // An intentionally incomplete run: 2 tasks planned, 1 recorded, no researchers, then the PM.
  await server.callTool("plan_visible_run", {
    symbol: "NOK",
    run_id: incompleteRunId,
    tasks: ["market_data", "valuation_long_short"],
  });
  await server.callTool("record_visible_packet", {
    run_id: incompleteRunId,
    task: "market_data",
    thread_id: "thread-incomplete-market",
    thread_title: "AlphaCouncil Agent NOK market_data",
    packet: packet("only evidence packet"),
  });
  recorded.shortcut = structured(await server.callTool("record_visible_decision", {
    run_id: incompleteRunId,
    role: "portfolio_manager",
    thread_id: "thread-incomplete-pm",
    thread_title: "AlphaCouncil Agent NOK portfolio_manager",
    packet: {
      verdict: "SHORTCUT",
      rating: "Hold",
      winner: "balanced",
      summary: "shortcut decision",
      confidence: "low",
      report_markdown: "# PM body",
    },
  }));

  await server.close();
});

after(() => removeDataDir(dataDir));

test("the visible decision is recorded with its thread id", () => {
  assert.equal(recorded.pm.decision?.thread_id, "thread-visible-pm");
});

test("late and replayed packets do not downgrade a complete run", () => {
  assert.equal(recorded.late.status, "complete");
  assert.equal(recorded.replay.status, "complete");

  const status = JSON.parse(readFileSync(join(visibleDir, "status.json"), "utf8"));
  assert.equal(status.status, "complete");
  assert.equal(status.phase, "complete");
  assert.equal(status.report_quality, "passed");
  assert.equal(status.verification, "passed");
});

test("a replayed packet does not nest or rewrite raw_text", () => {
  const stored = JSON.parse(readFileSync(join(visibleDir, "market_data.json"), "utf8"));
  assert.equal(stored.raw_text, "original visible agent output");
});

test("visible thread ids reach the agent trace", () => {
  const trace = readFileSync(join(visibleDir, "all_agents.md"), "utf8");
  assert.match(trace, /Visible thread ID: thread-visible-market/);
  assert.match(trace, /Visible thread ID: thread-visible-pm/);
});

test("a visible run writes every promised artifact", () => {
  for (const file of ["user_response.md", "artifact_index.md", "report_quality.json", "market_data.md", "portfolio_manager.md"]) {
    assert.ok(existsSync(join(visibleDir, file)), `visible run did not write ${file}`);
  }
});

test("a PM recorded over missing evidence and missing researchers is flagged incomplete", () => {
  assert.equal(recorded.shortcut.run?.status, "incomplete");
  assert.equal(recorded.shortcut.run?.phase, "incomplete");

  const status = JSON.parse(readFileSync(join(incompleteDir, "status.json"), "utf8"));
  assert.equal(status.status, "incomplete");
  assert.equal(status.phase, "incomplete");
  assert.equal(status.completeness, "incomplete");
  assert.equal(status.missing_evidence_count, 1);
  assert.equal(status.missing_debate_count, 2);
});

test("an incomplete run banners the report without deleting the recorded body", () => {
  const report = readFileSync(join(incompleteDir, "final_report.md"), "utf8");
  assert.match(report, /Incomplete Council Run/);
  assert.match(report, /PM body/);

  const events = readFileSync(join(incompleteDir, "events.jsonl"), "utf8");
  assert.match(events, /"incomplete"/);
});
