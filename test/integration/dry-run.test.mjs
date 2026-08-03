import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

let dataDir;
let server;
let toolsList;
let analysis;
let analysisResponse;
let replay;
let replayResponse;
let backgroundReplay;
let backgroundReplayResponse;
let replayEventsUnchanged;
let runDir;

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });

  await server.request("initialize", {});
  const list = await server.request("tools/list", {});
  toolsList = list.result?.tools || [];

  const selection = await confirmMasterSelection(server, { symbol: "AAPL", selected_master_ids: ["master_buffett"] });
  analysisResponse = await server.callTool("analyze_symbol", {
    symbol: "AAPL",
    dry_run: true,
    tasks: ["market_data", "valuation_long_short"],
    selection_receipt: selection.selection_receipt,
  });
  analysis = structured(analysisResponse);
  runDir = join(dataDir, "runs", analysis.run.run_id);

  const eventsBeforeReplay = readFileSync(join(runDir, "events.jsonl"), "utf8");
  replayResponse = await server.callTool("analyze_symbol", {
    symbol: "AAPL",
    run_id: analysis.run.run_id,
    dry_run: true,
    tasks: ["market_data", "valuation_long_short"],
    selection_receipt: selection.selection_receipt,
  });
  replay = structured(replayResponse);
  backgroundReplayResponse = await server.callTool("analyze_symbol", {
    symbol: "AAPL",
    run_id: analysis.run.run_id,
    dry_run: true,
    wait_for_completion: false,
    tasks: ["market_data", "valuation_long_short"],
    selection_receipt: selection.selection_receipt,
  });
  backgroundReplay = structured(backgroundReplayResponse);
  replayEventsUnchanged = readFileSync(join(runDir, "events.jsonl"), "utf8") === eventsBeforeReplay;

  await server.close();
});

after(() => removeDataDir(dataDir));

test("tools/list exposes a coherent tool surface", () => {
  const names = toolsList.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length, "duplicate tool name");

  // Assert the invariants, not a hardcoded list: the surface grows, and a frozen array
  // just means every new tool arrives with a failing test that says nothing useful.
  const mustHave = [
    "begin_council_selection", "confirm_master_selection",
    "plan_visible_run", "record_visible_packet", "finalize_visible_run", "record_visible_decision",
    "collect_evidence", "analyze_symbol", "read_run",
  ];
  for (const name of mustHave) assert.ok(names.includes(name), `missing core tool: ${name}`);

  for (const tool of toolsList) {
    assert.ok(tool.description?.length > 40, `${tool.name} needs a description a host can act on`);
    assert.equal(tool.inputSchema?.type, "object", `${tool.name} needs an object input schema`);
  }

  // Anything that only reads must say so, or hosts cannot reason about side effects.
  for (const name of ["read_run", "get_quote", "get_macro_snapshot", "screen_ticker", "list_us_universe", "preflight_permissions"]) {
    const tool = toolsList.find((t) => t.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${name} must be annotated read-only`);
  }
});

test("analyze_symbol schema keeps dry_run opt-in and exposes language and tasks", () => {
  const analyze = toolsList.find((tool) => tool.name === "analyze_symbol");
  assert.equal(analyze?.inputSchema?.properties?.dry_run?.default, false);
  assert.equal(analyze?.inputSchema?.properties?.wait_for_completion?.default, false);
  assert.ok(analyze?.inputSchema?.properties?.language, "language selection must be exposed");
  assert.ok(analyze?.inputSchema?.properties?.tasks?.items?.enum?.includes("quant_factor"));

  const readRun = toolsList.find((tool) => tool.name === "read_run");
  assert.deepEqual(readRun?.inputSchema?.properties?.detail?.enum, ["compact", "full"]);
  assert.equal(readRun?.inputSchema?.properties?.detail?.default, "compact");
});

test("a dry run returns a DRY_RUN decision with both markdown payloads", () => {
  assert.equal(analysis.decision?.verdict, "DRY_RUN");
  assert.ok(analysis.final_report_markdown, "final_report_markdown must be returned");
  assert.ok(analysis.user_response_markdown, "user_response_markdown must be returned");
  assert.equal(analysis.report_quality?.status, "passed");
});

test("replaying analyze_symbol returns the existing analysis without spending the council again", () => {
  assert.equal(replay.idempotent_replay, true);
  assert.deepEqual(replay.decision, analysis.decision);
  assert.equal(backgroundReplay.idempotent_replay, true);
  assert.deepEqual(backgroundReplay.decision, analysis.decision);
  assert.equal(replayEventsUnchanged, true, "an idempotent replay must not append a second lifecycle");
});

test("text-only analyze_symbol terminal responses and terminal replays are the persisted handoff", () => {
  const persisted = readFileSync(join(runDir, "user_response.md"), "utf8");
  for (const response of [analysisResponse, replayResponse, backgroundReplayResponse]) {
    assert.equal(response.result.content[0].text, persisted);
    assert.ok(response.result.content[0].text.trimEnd().endsWith("<!-- alphacouncil:handoff-method-seat-tail:v1:end -->"));
  }
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
  assert.match(trace, /Evidence Analyst Subagent/);
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
  assert.equal(status.verification_scope, "source_id_presence_only");
  assert.equal(status.adversarial_verification, "not_run");
  assert.equal(status.verifier_verdict_count, 0);
  assert.equal(status.missing_source_count, 0);
  assert.equal(status.selected_master_count, 1);
  assert.equal(status.recorded_master_count, 1);
  assert.equal(status.missing_master_count, 0);
  assert.equal(status.master_selection_status, "consumed");

  const quality = JSON.parse(readFileSync(join(runDir, "report_quality.json"), "utf8"));
  assert.equal(quality.status, "passed");
});

test("events.jsonl records the run lifecycle", () => {
  const events = readFileSync(join(runDir, "events.jsonl"), "utf8");
  assert.match(events, /run_started/);
  assert.match(events, /run_complete/);
});
