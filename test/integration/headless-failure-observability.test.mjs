import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

function scriptedCodexCommand(dataDir, {
  targetTask = "forward_expectations",
  recoverOnSecondAttempt = false,
  failOnSecondAttempt = false,
  lateValidOnSecondAttempt = false,
  wrongLanguageBoth = false,
  locallyRepairableFirst = false,
  schemaInvalidFirst = false,
  multiPayloadRepair = false,
} = {}) {
  const driver = join(dataDir, "fake-codex-malformed.mjs");
  const counter = join(dataDir, "fake-codex-attempts.txt");
  const promptLog = join(dataDir, "fake-codex-prompts.jsonl");
  const malformed = '{"summary":"first-object"}{"summary":"second-object"}';
  const recovered = JSON.stringify({
    summary: "The bounded retry recovered a valid evidence packet without changing any facts or source identifiers.",
    claims: [],
    metrics: {},
    sources: [],
    open_questions: ["The malformed first attempt contained no recoverable sourced claim."],
    confidence: "low",
    information_richness: "C",
  });
  const locallyRepairable = `${recovered.slice(0, -1)},}`;
  const schemaInvalid = JSON.stringify({
    summary: "The first packet is valid JSON but violates the evidence schema.",
    claims: [{
      claim: "A claim cannot be accepted without at least one source id.",
      evidence: "The fixture deliberately leaves source_ids empty.",
      confidence: "low",
      source_ids: [],
    }],
    metrics: {},
    sources: [],
    open_questions: [],
    confidence: "low",
    information_richness: "C",
  });
  const wrongLanguage = JSON.stringify({
    summary: "This valid evidence packet uses the wrong reader language on every bounded attempt.",
    claims: [{
      claim: "The worker returned valid JSON but ignored the requested reader language.",
      evidence: "The fixture intentionally preserves this English sentence for the language gate.",
      confidence: "low",
      source_ids: ["S1"],
    }],
    metrics: {},
    sources: [{
      id: "S1",
      title: "Local language fixture",
      url: "https://example.com/language-fixture",
      published_at: "2026-07-28",
      retrieved_at: "2026-07-28"
    }],
    open_questions: ["The requested reader language still needs a valid response."],
    confidence: "low",
    information_richness: "C",
  });
  // Pre-create the counter so a heavily loaded test runner reports an informative 0/1
  // attempt mismatch instead of ENOENT if process startup itself exceeds the fixture cap.
  writeFileSync(counter, "0");
  writeFileSync(promptLog, "");
  writeFileSync(driver, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("-o");
if (outputIndex === -1 || !args[outputIndex + 1]) process.exit(2);
const outputPath = args[outputIndex + 1];
const counterPath = ${JSON.stringify(counter)};
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString();
const tasks = ${JSON.stringify(DEFAULT_TASKS)};
const task = tasks.find((id) => prompt.includes("Task:" + id) || prompt.includes("Task: " + id) || prompt.includes(id))
  || /Target task:\\s*([a-z_]+)/u.exec(prompt)?.[1]
  || null;
const tracked = task === ${JSON.stringify(targetTask)};
const attempt = tracked
  ? (existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1)
  : 0;
if (tracked) writeFileSync(counterPath, String(attempt));
appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ attempt, task, search: args.includes("--search"), prompt }) + "\\n");
if (!tracked) {
  const asOf = /as[-_ ]of(?: date)?\\s*:\\s*(\\d{4}-\\d{2}-\\d{2})/iu.exec(prompt)?.[1] || "2026-08-04";
  const chinese = /Reader-facing language:\\s*中文|读者语言：中文|请使用中文/u.test(prompt);
  const baseline = {
    summary: chinese ? "该非目标分析席已完成有界测试并保留明确限制。" : "This non-target analyst completed the bounded fixture with explicit limits.",
    claims: [], metrics: {}, sources: [],
    open_questions: [chinese ? "该非目标测试席没有额外可核验论断。" : "This non-target fixture carries no additional sourced claim."],
    confidence: "low", information_richness: "C",
  };
  if (task === "news_industry_management") {
    const source = { id: "S1", title: "Official fixture item", url: "https://example.com/official-item", published_at: asOf, retrieved_at: asOf };
    const item = { title: source.title, url: source.url, published_at: asOf, source_id: "S1" };
    baseline.sources = [source];
    baseline.official_source_coverage = {
      status: "complete",
      regulator: { status: "complete", entry_url: "https://example.com/regulator", checked_through: asOf, latest_dated_item: item, dated_items_checked: [item], gap: null },
      issuer: { status: "complete", entry_url: "https://example.com/issuer", checked_through: asOf, latest_dated_item: item, dated_items_checked: [item], gap: null },
    };
  }
  writeFileSync(outputPath, JSON.stringify(baseline));
  process.exit(0);
}
if (${JSON.stringify(failOnSecondAttempt)} && attempt === 2) process.exit(17);
if (${JSON.stringify(lateValidOnSecondAttempt)} && attempt === 2) {
  process.on("SIGTERM", () => {
    writeFileSync(outputPath, JSON.stringify({
      summary: "LATE-AFTER-TIMEOUT",
      claims: [{ claim: "late claim", evidence: "late evidence", confidence: "high", source_ids: [] }],
      metrics: {},
      sources: [],
      open_questions: [],
      confidence: "high",
      information_richness: "A",
    }));
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
}
const output = ${wrongLanguageBoth
  ? JSON.stringify(wrongLanguage)
  : locallyRepairableFirst
    ? JSON.stringify(locallyRepairable)
  : schemaInvalidFirst
    ? `attempt === 1 ? ${JSON.stringify(schemaInvalid)} : ${JSON.stringify(recovered)}`
  : multiPayloadRepair
    ? `attempt === 2 ? ${JSON.stringify(`${recovered}\n${JSON.stringify({ repair_note: "transport only" })}`)} : ${JSON.stringify(malformed)}`
  : recoverOnSecondAttempt
    ? `attempt === 2 ? ${JSON.stringify(recovered)} : ${JSON.stringify(malformed)}`
    : JSON.stringify(malformed)};
writeFileSync(outputPath, output);
`);
  if (process.platform !== "win32") {
    chmodSync(driver, 0o755);
    return { command: driver, counter, promptLog };
  }
  const wrapper = join(dataDir, "fake-codex-malformed.cmd");
  writeFileSync(wrapper, `@"${process.execPath}" "${driver}" %*\r\n`);
  return { command: wrapper, counter, promptLog };
}

test("headless failures stay out of evidence and full council stops before expensive downstream synthesis", async () => {
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
      [{ successful: 0, failed: DEFAULT_TASKS.length, total: DEFAULT_TASKS.length }],
      "a failure packet must not be reported as completed evidence",
    );
    assert.equal(events.some((event) => event.type === "debate_started"), false);
    assert.equal(events.some((event) => event.type === "agent_round_completed"), false);
    assert.equal(events.some((event) => event.type === "debate_qna_gate"), false);
    const terminal = events.findLast((event) => event.type === "incomplete");
    assert.equal(terminal?.reason, "evidence_gate_failed");
    assert.equal(terminal?.downstream_model_calls_skipped, true);
    assert.deepEqual(terminal?.missing_evidence, DEFAULT_TASKS);
    for (const role of ["bull_researcher", "bear_researcher", "portfolio_manager"]) {
      assert.equal(result.run.agent_status[role].status, "skipped");
    }
  } finally {
    await server.close();
    removeDataDir(dataDir);
}
});

function packetFor(run, task) {
  const packet = run.packets.find((candidate) => candidate.task === task);
  assert.ok(packet, `missing packet for ${task}`);
  return packet;
}

test("a safe local syntax repair avoids a second Codex worker", async () => {
  const dataDir = makeDataDir();
  const fake = scriptedCodexCommand(dataDir, { locallyRepairableFirst: true });
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.command },
  });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "RKLB",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `HEADLESS-LOCAL-REPAIR-${process.pid}`;
    const run = structured(await server.callTool("collect_evidence", {
      symbol: "RKLB",
      run_id: runId,
      tasks: ["forward_expectations"],
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
      timeout_ms: 5_000,
    }));
    assert.equal(readFileSync(fake.counter, "utf8"), "1", "local syntax repair must not spend a model retry");
    assert.equal(run.status, "evidence_complete");
    assert.equal(run.task_status.forward_expectations.status, "completed");
    assert.equal(run.task_status.forward_expectations.attempts, 1);
    assert.equal(packetFor(run, "forward_expectations").summary, "The bounded retry recovered a valid evidence packet without changing any facts or source identifiers.");
    assert.equal(existsSync(join(dataDir, "runs", runId, "forward_expectations.attempt-1.failure.json")), false);
    const events = readFileSync(join(dataDir, "runs", runId, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.type === "task_retry"), false);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("schema repair receives bounded validator paths and a pace-aware budget", async () => {
  const dataDir = makeDataDir();
  const fake = scriptedCodexCommand(dataDir, { schemaInvalidFirst: true, targetTask: "insider_sec" });
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.command },
  });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "TST",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `HEADLESS-SCHEMA-GUIDANCE-${process.pid}`;
    const run = structured(await server.callTool("collect_evidence", {
      symbol: "TST",
      run_id: runId,
      tasks: ["insider_sec"],
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
    }));
    assert.equal(run.status, "evidence_complete");
    assert.equal(run.task_status.insider_sec.attempts, 2);

    const dir = join(dataDir, "runs", runId);
    const diagnostic = JSON.parse(readFileSync(join(dir, "insider_sec.attempt-1.failure.json"), "utf8"));
    assert.equal(diagnostic.schema_id, "runtime-evidence-packet-v1");
    assert.equal(diagnostic.schema_kind, "evidence");
    assert.ok(diagnostic.schema_error_count >= diagnostic.schema_errors.length);
    assert.ok(diagnostic.schema_errors.length >= 1 && diagnostic.schema_errors.length <= 8);
    assert.ok(diagnostic.schema_errors.some((issue) => (
      issue.path === "/claims/0/source_ids"
      && issue.keyword === "minItems"
      && /fewer than 1/u.test(issue.message)
    )));

    const launches = readFileSync(fake.promptLog, "utf8")
      .trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const repair = launches.find((item) => item.attempt === 2);
    assert.ok(repair);
    assert.equal(repair.search, false);
    assert.match(repair.prompt, /\/claims\/0\/source_ids \[minItems\]/u);
    assert.match(repair.prompt, /required top-level fields are summary/u);
    assert.match(repair.prompt, /source_ids containing at least one non-empty source id/u);
    assert.match(repair.prompt, /Never invent a source id or fact/u);

    const events = readFileSync(join(dir, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const retry = events.find((event) => event.type === "task_retry" && event.task === "insider_sec");
    assert.ok(retry.remaining_ms > 30_000, `repair budget stayed fixed at ${retry.remaining_ms}ms`);
    assert.ok(retry.remaining_ms <= 4 * 60 * 1_000);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("a code-zero malformed worker response is isolated in a failure artifact", async () => {
  const dataDir = makeDataDir();
  const fake = scriptedCodexCommand(dataDir);
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.command },
  });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "RKLB",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `HEADLESS-PARSE-FAILURE-${process.pid}`;
    const response = await server.callTool("collect_evidence", {
      symbol: "RKLB",
      run_id: runId,
      tasks: ["forward_expectations"],
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
    });
    const result = structured(response);
    const runDir = join(dataDir, "runs", runId);
    const diagnosticPath = join(runDir, "forward_expectations.failure.json");
    const firstDiagnosticPath = join(runDir, "forward_expectations.attempt-1.failure.json");

    assert.ok(response.result);
    assert.ok(existsSync(diagnosticPath), "parse failures need a separate diagnostic");
    assert.ok(existsSync(firstDiagnosticPath), "the first malformed attempt must remain independently diagnosable");
    if (process.platform !== "win32") {
      assert.equal(statSync(diagnosticPath).mode & 0o777, 0o600, "worker diagnostics must be owner-only");
      assert.equal(statSync(firstDiagnosticPath).mode & 0o777, 0o600, "retry diagnostics must be owner-only");
    }
    assert.equal(readFileSync(fake.counter, "utf8"), "2", "a parse failure gets exactly one retry");
    assert.deepEqual(packetFor(result, "forward_expectations").claims, []);
    assert.deepEqual(packetFor(result, "forward_expectations").sources, []);
    assert.equal(packetFor(result, "forward_expectations").raw_text, "");
    assert.equal(result.task_status.forward_expectations.diagnostic, diagnosticPath);
    assert.equal(result.task_status.forward_expectations.retry_diagnostic, firstDiagnosticPath);
    assert.equal(result.task_status.forward_expectations.attempts, 2);
    assert.equal(result.task_status.forward_expectations.error, "parse_failed");

    const evidenceText = readFileSync(join(runDir, "evidence.json"), "utf8");
    const manifestText = readFileSync(join(runDir, "source_manifest.json"), "utf8");
    const diagnostic = JSON.parse(readFileSync(diagnosticPath, "utf8"));
    assert.doesNotMatch(evidenceText, /first-object|second-object/);
    assert.doesNotMatch(manifestText, /first-object|second-object/);
    assert.equal(diagnostic.status, "parse_failed");
    assert.match(diagnostic.parse_context, /}\{/);
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.type === "task_retry").length, 1);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("valid JSON in the wrong reader language remains reader_language_mismatch after one bounded repair", async () => {
  const dataDir = makeDataDir();
  const fake = scriptedCodexCommand(dataDir, { wrongLanguageBoth: true });
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.command },
  });
  try {
    await server.request("initialize", {});
    const prompt = "请使用中文完成证据分析。";
    const selection = await confirmMasterSelection(server, {
      symbol: "RKLB", language: "中文", prompt,
      selected_master_ids: ["master_buffett"],
    });
    const runId = `HEADLESS-LANGUAGE-MISMATCH-${process.pid}`;
    const run = structured(await server.callTool("collect_evidence", {
      symbol: "RKLB", run_id: runId, language: "中文", prompt,
      tasks: ["forward_expectations"],
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
      timeout_ms: 5_000,
    }));
    const runDir = join(dataDir, "runs", runId);
    const diagnostic = JSON.parse(readFileSync(join(runDir, "forward_expectations.failure.json"), "utf8"));
    const firstDiagnostic = JSON.parse(readFileSync(join(runDir, "forward_expectations.attempt-1.failure.json"), "utf8"));

    assert.equal(readFileSync(fake.counter, "utf8"), "2");
    assert.equal(run.task_status.forward_expectations.status, "failed");
    assert.equal(run.task_status.forward_expectations.error, "reader_language_mismatch");
    assert.equal(diagnostic.status, "reader_language_mismatch");
    assert.equal(firstDiagnostic.status, "reader_language_mismatch");
    assert.match(diagnostic.reader_language_error, /reader language mismatch/);
    assert.match(packetFor(run, "forward_expectations").summary, /错误语言/);
    assert.deepEqual(packetFor(run, "forward_expectations").claims, []);
    assert.equal(packetFor(run, "forward_expectations").raw_text, "");
    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    const retry = events.filter((event) => event.type === "task_retry");
    assert.equal(retry.length, 1);
    assert.equal(retry[0].reason, "reader_language_mismatch");
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("a transport failure on the parse retry remains empty evidence", async () => {
  const dataDir = makeDataDir();
  const fake = scriptedCodexCommand(dataDir, { failOnSecondAttempt: true });
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.command },
  });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "RKLB",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `HEADLESS-PARSE-RETRY-TRANSPORT-${process.pid}`;
    const response = await server.callTool("collect_evidence", {
      symbol: "RKLB",
      run_id: runId,
      tasks: ["forward_expectations"],
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
      timeout_ms: 5_000,
    });
    const run = structured(response);
    const runDir = join(dataDir, "runs", runId);
    const evidence = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
    const manifestText = readFileSync(join(runDir, "source_manifest.json"), "utf8");

    assert.equal(readFileSync(fake.counter, "utf8"), "2");
    assert.equal(run.task_status.forward_expectations.status, "failed");
    assert.equal(run.task_status.forward_expectations.attempts, 2);
    assert.equal(run.task_status.forward_expectations.error, "exit code 17");
    assert.deepEqual(packetFor(evidence, "forward_expectations").claims, []);
    assert.deepEqual(packetFor(evidence, "forward_expectations").sources, []);
    assert.equal(packetFor(evidence, "forward_expectations").raw_text, "");
    assert.doesNotMatch(JSON.stringify(evidence), /first-object|second-object/);
    assert.doesNotMatch(manifestText, /first-object|second-object/);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("a worker that exits zero with valid JSON after its timeout is still rejected", {
  skip: process.platform === "win32" ? "the fixture relies on POSIX SIGTERM handling" : false,
}, async () => {
  const dataDir = makeDataDir();
  const fake = scriptedCodexCommand(dataDir, { lateValidOnSecondAttempt: true });
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.command },
  });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "RKLB",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `HEADLESS-DEADLINE-REJECTION-${process.pid}`;
    const response = await server.callTool("collect_evidence", {
      symbol: "RKLB",
      run_id: runId,
      tasks: ["forward_expectations"],
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
      timeout_ms: 5_000,
    });
    const run = structured(response);
    const runDir = join(dataDir, "runs", runId);
    const evidenceText = readFileSync(join(runDir, "evidence.json"), "utf8");
    const manifestText = readFileSync(join(runDir, "source_manifest.json"), "utf8");

    assert.equal(readFileSync(fake.counter, "utf8"), "2");
    assert.equal(run.task_status.forward_expectations.status, "timed_out");
    assert.equal(run.task_status.forward_expectations.attempts, 2);
    assert.equal(run.task_status.forward_expectations.error, "timeout");
    assert.deepEqual(packetFor(run, "forward_expectations").claims, []);
    assert.equal(packetFor(run, "forward_expectations").raw_text, "");
    assert.doesNotMatch(evidenceText, /LATE-AFTER-TIMEOUT|late claim|late evidence/);
    assert.doesNotMatch(manifestText, /LATE-AFTER-TIMEOUT|late claim|late evidence/);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("one bounded parse-only retry can recover a valid evidence packet", async () => {
  const dataDir = makeDataDir();
  const fake = scriptedCodexCommand(dataDir, { recoverOnSecondAttempt: true });
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.command },
  });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "RKLB",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `HEADLESS-PARSE-RETRY-${process.pid}`;
    const response = await server.callTool("collect_evidence", {
      symbol: "RKLB",
      run_id: runId,
      tasks: ["forward_expectations"],
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
      timeout_ms: 5_000,
    });
    const run = structured(response);
    const runDir = join(dataDir, "runs", runId);
    const retryDiagnostic = join(runDir, "forward_expectations.attempt-1.failure.json");

    assert.equal(readFileSync(fake.counter, "utf8"), "2", "the retry must be exactly one extra attempt");
    assert.equal(run.status, "evidence_complete");
    assert.equal(run.task_status.forward_expectations.status, "completed");
    assert.equal(run.task_status.forward_expectations.attempts, 2);
    assert.equal(run.task_status.forward_expectations.retry_diagnostic, retryDiagnostic);
    assert.equal(packetFor(run, "forward_expectations").summary, "The bounded retry recovered a valid evidence packet without changing any facts or source identifiers.");
    assert.equal(packetFor(run, "forward_expectations").raw_text.includes("first-object"), false);
    assert.ok(existsSync(retryDiagnostic));
    assert.equal(existsSync(join(runDir, "forward_expectations.failure.json")), false);

    const events = readFileSync(join(runDir, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      events.filter((event) => event.type === "task_retry")
        .map(({ task, attempt, max_attempts, reason }) => ({ task, attempt, max_attempts, reason })),
      [{ task: "forward_expectations", attempt: 2, max_attempts: 2, reason: "parse_failed" }],
    );
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("parse-only retry accepts one schema-valid packet beside non-contract JSON noise", async () => {
  const dataDir = makeDataDir();
  const fake = scriptedCodexCommand(dataDir, { multiPayloadRepair: true });
  const server = startServer({
    dataDir,
    env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.command },
  });
  try {
    await server.request("initialize", {});
    const selection = await confirmMasterSelection(server, {
      symbol: "RKLB",
      selected_master_ids: ["master_buffett"],
    });
    const runId = `HEADLESS-MULTI-ROOT-REPAIR-${process.pid}`;
    const run = structured(await server.callTool("collect_evidence", {
      symbol: "RKLB",
      run_id: runId,
      tasks: ["forward_expectations"],
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
      selection_receipt: selection.selection_receipt,
      timeout_ms: 5_000,
    }));
    const dir = join(dataDir, "runs", runId);
    assert.equal(readFileSync(fake.counter, "utf8"), "2");
    assert.equal(run.status, "evidence_complete");
    assert.equal(run.task_status.forward_expectations.status, "completed");
    assert.equal(run.task_status.forward_expectations.attempts, 2);
    assert.equal(packetFor(run, "forward_expectations").summary, "The bounded retry recovered a valid evidence packet without changing any facts or source identifiers.");
    assert.equal(existsSync(join(dir, "forward_expectations.failure.json")), false);
    assert.equal(existsSync(join(dir, "forward_expectations.attempt-1.failure.json")), true);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
