import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const dataDir = mkdtempSync(join(tmpdir(), "alphacouncil-terminal-service-"));
process.env.ALPHACOUNCIL_AGENT_DATA_DIR = dataDir;
const service = await import("../service.mjs");
const { executeRun } = await import("../runner.mjs");
after(() => rmSync(dataDir, { recursive: true, force: true }));

function fixture(id, files) {
  const dir = join(dataDir, "runs", id);
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

test("an empty installation has a usable history and rejects unsafe run paths", () => {
  assert.deepEqual(service.listRuns(), []);
  assert.throws(() => service.loadRun(".."), /UNSAFE/);
  assert.throws(() => service.loadRun("../outside"), /run_id/);
  assert.throws(() => service.runnerPath(".."), /INVALID/);
});

test("details expose actual completed rounds and evidence without raw private traces", () => {
  fixture("DETAILS-1", {
    "status.json": { run_id: "DETAILS-1", symbol: "AAPL", language: "English", status: "running", council_mode: "full", tasks: [{ task: "market_data", status: "completed" }], masters: [] },
    "market_data.json": { task: "market_data", symbol: "AAPL", language: "English", summary: "Quoted market evidence", claims: [{ claim: "Published statement", evidence: "Filing", source_ids: ["S1"] }], sources: [{ id: "S1", url: "https://example.com/filing" }], raw_text: "PRIVATE_TRACE", thinking: "PRIVATE_THINKING", metrics: { close: 10, reasoning_content: "PRIVATE_NESTED" } },
    "bull_researcher.round-2.json": { role: "bull_researcher", round: 2, summary: "Round two summary", questions: ["Which filing supports the margin?"], questions_answered: [], raw_text: "PRIVATE_TRACE" },
    "bear_researcher.json": { debate_rounds: [{ round: 3, summary: "The final answer", questions_answered: ["The dated filing supports it."], raw_text: "PRIVATE_TRACE" }] },
    "final_report.md": "# Report\nPublic result\n\u001b[31mcolor\u001b[0m",
  });
  const items = service.listArtifacts("DETAILS-1");
  assert.equal(items.find((item) => item.id === "debate:bull_researcher:2").available, true);
  assert.equal(items.find((item) => item.id === "debate:bull_researcher:1").available, false);
  const evidence = service.readArtifact("DETAILS-1", "evidence:market_data").content;
  assert.match(evidence, /Published statement/);
  assert.match(evidence, /example.com\/filing/);
  assert.doesNotMatch(evidence, /PRIVATE_/);
  assert.match(service.readArtifact("DETAILS-1", "debate:bull_researcher:2").content, /Which filing/);
  assert.match(service.readArtifact("DETAILS-1", "debate:bear_researcher:3").content, /dated filing/);
  assert.doesNotMatch(service.readArtifact("DETAILS-1", "report").content, /\u001b/);
  assert.throws(() => service.readArtifact("DETAILS-1", "evidence.json"), /NOT_ALLOWED/);
  assert.throws(() => service.readArtifact("DETAILS-1", "debate:bull_researcher:1"), /NOT_READY/);
  assert.equal(service.loadRun("DETAILS-1").status.symbol, "AAPL");
});

test("a linked artifact cannot escape the allowed run directory", () => {
  const dir = fixture("SYMLINK-1", { "status.json": { language: "English", tasks: [], masters: [] } });
  const outside = join(dataDir, "outside.md");
  writeFileSync(outside, "outside");
  symlinkSync(outside, join(dir, "final_report.md"));
  assert.throws(() => service.readArtifact("SYMLINK-1", "report"), /UNSAFE/);
});

test("selection needs an actual display acknowledgement and confirmed receipt", async () => {
  const selection = await service.beginSelection({ symbol: "MSFT", language: "English", prompt: "Research MSFT", council_mode: "full" });
  assert.equal(selection.status, "awaiting_user_selection");
  assert.equal(selection.masters.length, 26);
  assert.match(selection.display_markdown, /MSFT/);
  await assert.rejects(service.confirmSelection(selection, { selected_master_ids: ["master_buffett"] }), /ACK_REQUIRED/);
  await assert.rejects(service.launch({ research: { symbol: "MSFT" } }), /MASTER_SELECTION_REQUIRED/);
  const confirmation = await service.confirmSelection(selection, { display_ack: true, selected_master_ids: ["master_buffett"], analyst_scope: "core", council_pace: "normal" });
  assert.equal(confirmation.selected_count, 1);
  assert.ok(confirmation.selection_receipt);
});

test("stop persists intent, aborts execution, and never labels it completed", async () => {
  const id = "STOP-1";
  service.writeRunnerState(id, { owner_token: "owned", pid: process.pid, state: "starting", symbol: "AAPL" });
  let observedSignal;
  let began;
  const ready = new Promise((resolve) => { began = resolve; });
  const work = executeRun({ run_id: id, owner_token: "owned", research: { symbol: "AAPL" }, connection: { provider: "fixture" }, apiKey: "PRIVATE_KEY" }, {
    notify(message) { if (message.type === "ready") began(); },
    async withConnection(_connection, operation, { apiKey, signal }) {
      assert.equal(apiKey, "PRIVATE_KEY");
      observedSignal = signal;
      return operation();
    },
    async dispatch() {
      await new Promise((resolve) => observedSignal.addEventListener("abort", resolve, { once: true }));
      return { error: { data: { reason: "CANCELLED" } } };
    },
  });
  await ready;
  assert.equal(service.stop(id).status, "stopping");
  await work;
  assert.equal(observedSignal.aborted, true);
  const stored = service.readRunnerState(id);
  assert.equal(stored.state, "stopped");
  assert.equal(stored.stop_reason, "user_cancelled");
  assert.doesNotMatch(readFileSync(service.runnerPath(id), "utf8"), /PRIVATE_KEY/);
});

test("a detached dry runner survives its launcher exit and preserves the real incomplete report", async () => {
  const research = { symbol: "TEST", language: "English", prompt: "Offline terminal lifecycle test", council_mode: "quick", dry_run: true };
  const selection = await service.beginSelection(research);
  const confirmation = await service.confirmSelection(selection, { display_ack: true, selected_master_ids: ["master_buffett"] });
  const script = `import { launch } from ${JSON.stringify(new URL("../service.mjs", import.meta.url).href)};
    const launched = await launch(${JSON.stringify({ research, confirmation })});
    console.log(JSON.stringify(launched));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { env: process.env, timeout: 15_000 });
  const launched = JSON.parse(stdout);
  assert.notEqual(launched.pid, process.pid);
  let run;
  const deadline = Date.now() + 10_000;
  do {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = service.loadRun(launched.run_id);
  } while (["starting", "running"].includes(run.runner.state) && Date.now() < deadline);
  assert.equal(run.runner.state, "completed");
  assert.equal(run.status.status, "incomplete");
  assert.equal(run.status.dry_run, true);
  assert.equal(run.status.run_id, launched.run_id);
  assert.equal(service.listRuns({ query: launched.run_id }).length, 1);
  assert.ok(service.readArtifact(launched.run_id, "report").content.length > 100);
  assert.match(service.readArtifact(launched.run_id, "method:master_buffett").content, /Buffett/);
  assert.doesNotMatch(service.readArtifact(launched.run_id, "decision").content, /PRIVATE_TRACE/);
});

test("terminal outcomes distinguish saved failure artifacts from successful research", () => {
  fixture("OUTCOME-1", {
    "status.json": { status: "incomplete", terminal: "incomplete", language: "中文", tasks: [{ task: "market_data", status: "completed" }, { task: "earnings_deep_dive", status: "timed_out" }], masters: [{ master: "master_buffett", status: "pending" }], stage_outcomes: { portfolio_manager: { absence_reason: "skipped_upstream_gate" } } },
    "market_data.json": { task: "market_data", summary: "Valid recorded evidence" },
    "earnings_deep_dive.json": { task: "earnings_deep_dive", summary: "Failure placeholder" },
    "earnings_deep_dive.attempt-1.failure.json": { task: "earnings_deep_dive", status: "parse_failed", schema_errors: [{ path: "/coverage_items/financials.earnings_call_qna", keyword: "gap_not_in_open_questions" }], diagnostic_excerpt: "PRIVATE_PRIMARY_BODY", parse_context: "PRIVATE_CONTEXT" },
    "earnings_deep_dive.failure.json": { task: "earnings_deep_dive", status: "timed_out", timeout_ms: 147606, raw_text: "PRIVATE_RAW", diagnostic_excerpt: "PRIVATE_STDERR" },
    "decision.json": { decision_available: false, rating: null },
    "final_report.md": "# Saved incomplete report",
    "user_response.md": "# 结论\n研究未完成；保留证据和缺口。",
  });
  service.writeRunnerState("OUTCOME-1", { state: "completed", owner_token: "PRIVATE_OWNER" });
  const run = service.loadRun("OUTCOME-1");
  assert.equal(run.status.terminal, "incomplete");
  assert.equal(run.items.filter((item) => item.kind === "evidence" && item.successful).length, 1);
  assert.equal(run.items.filter((item) => ["report", "decision"].includes(item.kind) && item.successful).length, 0);
  assert.equal(run.items.find((item) => item.id === "method:master_buffett").status, "skipped");
  assert.equal(run.items.find((item) => item.id === "decision").status, "skipped");
  assert.match(run.conclusion, /研究未完成/);
  const diagnostics = service.readArtifact("OUTCOME-1", "failure:earnings_deep_dive");
  assert.match(diagnostics.content, /gap_not_in_open_questions/);
  assert.match(diagnostics.content, /147606/);
  assert.doesNotMatch(JSON.stringify(run) + diagnostics.content, /PRIVATE_/);
});
