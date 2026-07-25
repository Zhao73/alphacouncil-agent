import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";

let dataDir;
let server;
let toolsList;
let analysis;
let runDir;

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });

  await server.request("initialize", {});
  const list = await server.request("tools/list", {});
  toolsList = list.result?.tools || [];

  const response = await server.callTool("analyze_symbol", {
    symbol: "AAPL",
    dry_run: true,
    tasks: ["market_data", "valuation_long_short"],
  });
  analysis = structured(response);
  runDir = join(dataDir, "runs", analysis.run.run_id);

  await server.close();
});

after(() => removeDataDir(dataDir));

test("tools/list exposes the full tool surface", () => {
  // Assert on names, not a count: a bare number tells a future reader nothing about
  // which tool went missing.
  assert.deepEqual(toolsList.map((tool) => tool.name).sort(), [
    "analyze_symbol",
    "collect_evidence",
    "compare_summary_modes",
    "get_quote",
    "plan_visible_run",
    "preflight_permissions",
    "read_run",
    "record_visible_decision",
    "record_visible_packet",
  ]);
});

test("analyze_symbol schema keeps dry_run opt-in and exposes language and tasks", () => {
  const analyze = toolsList.find((tool) => tool.name === "analyze_symbol");
  assert.equal(analyze?.inputSchema?.properties?.dry_run?.default, false);
  assert.ok(analyze?.inputSchema?.properties?.language, "language selection must be exposed");
  assert.ok(analyze?.inputSchema?.properties?.tasks?.items?.enum?.includes("quant_factor"));
});

test("a dry run returns a DRY_RUN decision with both markdown payloads", () => {
  assert.equal(analysis.decision?.verdict, "DRY_RUN");
  assert.ok(analysis.final_report_markdown, "final_report_markdown must be returned");
  assert.ok(analysis.user_response_markdown, "user_response_markdown must be returned");
  assert.equal(analysis.report_quality?.status, "passed");
});

test("a dry run writes every promised artifact", () => {
  const expected = [
    "all_agents.md",
    "status.json",
    "events.jsonl",
    "source_manifest.json",
    "final_report.md",
    "user_response.md",
    "artifact_index.md",
    "report_quality.json",
    "market_data.md",
    "portfolio_manager.md",
  ];
  for (const file of expected) {
    assert.ok(existsSync(join(runDir, file)), `${file} was not written`);
  }
});

test("the agent trace names the evidence subagents and the portfolio manager", () => {
  const trace = readFileSync(join(runDir, "all_agents.md"), "utf8");
  assert.match(trace, /Evidence Subagent/);
  assert.match(trace, /portfolio_manager/);
});

test("the final report covers the contract sections", () => {
  const report = readFileSync(join(runDir, "final_report.md"), "utf8");
  const requires = (zh, en) =>
    assert.ok(report.includes(zh) || report.includes(en), `final_report.md must include ${en}`);
  requires("数据缺口/未覆盖项", "Data Gaps / Unavailable Data");
  requires("分析师工作记录", "Analyst Work Log");
  requires("多空辩论记录", "Bull/Bear Debate Record");
  assert.match(report, /Market Expectations/);
  assert.match(report, /News and Company/);
});

test("the chat handoff points at the saved files", () => {
  const handoff = readFileSync(join(runDir, "user_response.md"), "utf8");
  assert.match(handoff, /Full report:/);
  assert.match(handoff, /Latest earnings:/);

  const index = readFileSync(join(runDir, "artifact_index.md"), "utf8");
  assert.match(index, /market_data\.md/);
  assert.match(index, /portfolio_manager\.md/);
});

test("status.json surfaces completion, quality, and verification", () => {
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
  assert.equal(status.status, "complete");
  assert.ok(status.tasks.every((task) => task.status === "completed"));
  assert.equal(status.report_quality, "passed");
  assert.equal(status.verification, "passed");
  assert.equal(status.missing_source_count, 0);

  const quality = JSON.parse(readFileSync(join(runDir, "report_quality.json"), "utf8"));
  assert.equal(quality.status, "passed");
});

test("events.jsonl records the run lifecycle", () => {
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /run_started/);
  assert.match(events, /run_complete/);
});
