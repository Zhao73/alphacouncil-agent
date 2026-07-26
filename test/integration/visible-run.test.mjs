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
const noPmRunId = `SELFTEST-NOPM-${process.pid}`;
const pmLastRunId = `SELFTEST-PMLAST-${process.pid}`;
let visibleDir;
let incompleteDir;
let noPmDir;
let pmLastDir;
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
  noPmDir = join(dataDir, "runs", noPmRunId);
  pmLastDir = join(dataDir, "runs", pmLastRunId);
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

  // Full evidence + both researchers, but the PM is never recorded. This is the case
  // the old gate reported as complete.
  await server.callTool("plan_visible_run", { symbol: "NOK", run_id: noPmRunId, tasks: ["market_data"] });
  await server.callTool("record_visible_packet", {
    run_id: noPmRunId,
    task: "market_data",
    thread_id: "thread-nopm-market",
    packet: packet("evidence without a PM"),
  });
  for (const role of ["bull_researcher", "bear_researcher"]) {
    recorded[role] = structured(await server.callTool("record_visible_decision", {
      run_id: noPmRunId,
      role,
      thread_id: `thread-nopm-${role}`,
      packet: { verdict: "OK", rating: "Hold", winner: "balanced", summary: role, confidence: "medium" },
    }));
  }

  // The PM is the final call and nothing follows it. The visible run above is repaired
  // by its trailing late-packet calls, which masks an ordering bug in the gate; here
  // there is nothing to repair it.
  await server.callTool("plan_visible_run", { symbol: "NOK", run_id: pmLastRunId, tasks: ["market_data"] });
  await server.callTool("record_visible_packet", {
    run_id: pmLastRunId,
    task: "market_data",
    thread_id: "thread-pmlast-market",
    packet: packet("evidence"),
  });
  for (const role of ["bull_researcher", "bear_researcher"]) {
    await server.callTool("record_visible_decision", {
      run_id: pmLastRunId,
      role,
      thread_id: `thread-pmlast-${role}`,
      packet: { verdict: "OK", rating: "Hold", winner: "balanced", summary: role, confidence: "medium" },
    });
  }
  recorded.pmLast = structured(await server.callTool("record_visible_decision", {
    run_id: pmLastRunId,
    role: "portfolio_manager",
    thread_id: "thread-pmlast-pm",
    packet: {
      verdict: "OK", rating: "Hold", winner: "balanced", summary: "final",
      confidence: "medium", report_markdown: completeReport,
    },
  }));

  await server.close();
});

after(() => removeDataDir(dataDir));

test("the PM call that completes a run reports complete in its own response", () => {
  assert.equal(recorded.pmLast.status, "complete");
  assert.equal(recorded.pmLast.phase, "complete");
});

test("a run whose last call is the PM is persisted as complete", () => {
  const status = JSON.parse(readFileSync(join(pmLastDir, "status.json"), "utf8"));
  assert.equal(status.completeness, "complete");
  assert.equal(status.missing_debate_count, 0);
  assert.equal(status.status, "complete");
  assert.equal(status.phase, "complete");
});

test("a run with full evidence and both researchers but no PM is NOT complete", () => {
  const status = JSON.parse(readFileSync(join(noPmDir, "status.json"), "utf8"));
  assert.equal(status.completeness, "incomplete");
  assert.equal(status.missing_evidence_count, 0);
  assert.equal(status.missing_debate_count, 1, "only portfolio_manager should be missing");
  assert.notEqual(status.status, "complete");
});

test("recording the PM last flips a fully staffed run to complete", () => {
  const status = JSON.parse(readFileSync(join(visibleDir, "status.json"), "utf8"));
  assert.equal(status.completeness, "complete");
  assert.equal(status.missing_debate_count, 0);
  assert.equal(status.status, "complete");
});

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
  assert.equal(recorded.shortcut.status, "incomplete");
  assert.equal(recorded.shortcut.phase, "incomplete");

  const status = JSON.parse(readFileSync(join(incompleteDir, "status.json"), "utf8"));
  assert.equal(status.status, "incomplete");
  assert.equal(status.phase, "incomplete");
  assert.equal(status.completeness, "incomplete");
  assert.equal(status.missing_evidence_count, 1);
  // The PM itself was recorded, so only the two researchers are missing.
  assert.equal(status.missing_debate_count, 2);
});

test("an incomplete run banners the report without deleting the recorded body", () => {
  const report = readFileSync(join(incompleteDir, "final_report.md"), "utf8");
  assert.match(report, /Incomplete Council Run/);
  assert.match(report, /PM body/);

  const events = readFileSync(join(incompleteDir, "events.jsonl"), "utf8");
  assert.match(events, /"incomplete"/);
});
