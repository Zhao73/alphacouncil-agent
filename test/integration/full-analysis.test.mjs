import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_TASKS } from "../../mcp/lib/constants.mjs";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";

const SELECTED_MASTERS = [
  "master_buffett",
  "master_druckenmiller",
  "master_damodaran",
  "master_taleb",
];

function fullReportBody() {
  const work = DEFAULT_TASKS
    .map((task) => `- ${task}: ANALYST_SENTINEL_${task}; completed the sourced fixture packet and preserved its explicit confidence and gaps.`)
    .join("\n");
  return `# QQQ Full Council Fixture

## Conclusion
Hold with medium confidence while the evidence-supported range and the next primary filing remain the controlling decision points.

## Analyst Work Log
${work}

## Bull/Bear Debate Record
Three rounds completed with two parallel sides per round, an inter-round dependency barrier, exactly three questions per side in round two, and exact question-bound answers in round three.

## Master Bench
The portfolio manager received the frozen method-seat results. This generic text must be replaced by the system-owned recorded bench.

## Market Expectations and Implied Thresholds
The market-expectations seat recorded the operating thresholds that must be met and kept reported facts separate from implied expectations.

## Analyst Rating and Target-Price Revisions
The forward and valuation packets distinguish sourced analyst changes from unsupported target-price inference.

## Earnings Call Management Signals
The earnings seat records management commitments, dated evidence, and unresolved questions without fabricating a transcript.

## Quant Factor / Technical Risk View
The quant seat records trend, factor exposure, liquidity and unavailable fields with explicit confidence.

## Recent Company and Industry News
The news seat records dated company and industry developments up to the as-of boundary and excludes future information.

## Short Interest / Borrow / Options Information
The quant packet records the available short-interest and market-risk evidence; unavailable fields remain explicit gaps.

## Strategic Transaction or Banking Event
The event-analysis seat records transaction, capital-structure and financing evidence and states when no material event is verified.

## Valuation Range
The valuation range is conditional on growth, margins, financing and dilution, not an unsupported point target.

## Price Levels
Above the evidence range, do not chase; inside the range, wait for confirmation; below the range, reassess only while the operating thesis and source evidence remain intact.

## Key Catalysts
The next primary filing, confirmed operating milestones and any verified financing update are the decision-relevant catalysts.

## Major Risks
Execution delays, financing needs, dilution, regime shifts and missing primary facts can invalidate the conclusion.

## Position Recommendation
Keep sizing bounded until the next primary filing resolves the highest-impact unknowns and confirms the operating thresholds.

## Short-Term 1-4 Week View
Treat price action as tactical and do not override the evidence boundary with momentum alone.

## Medium-Term 3-6 Month View
Require measurable operating progress and updated primary-source evidence before increasing exposure.

## Long-Term 12 Month View
The long-term view remains conditional on durable economics, financing discipline and the stated invalidation conditions.

## Data Gaps / Unavailable Data
The fixture has no additional evidence gap; a production run must list every missing or failed seat rather than invent a substitute.

## Invalidation Conditions
Invalidate the thesis if verified operating milestones fail, financing materially worsens, or cited primary evidence is contradicted.

## Confidence
medium and conditional on the cited full-council evidence.

## Source Table
- market_data:S1 — fixture quote and market evidence — 2026-07-28 — https://example.com/market
- earnings_deep_dive:S1 — fixture earnings evidence — 2026-07-28 — https://example.com/earnings
`;
}

function fakeFullCodex(dataDir, { evidenceDelayMs = 45, malformedTask = "forward_expectations" } = {}) {
  const driver = join(dataDir, "fake-full-codex.mjs");
  const log = join(dataDir, "full-worker-log.jsonl");
  const malformedState = join(dataDir, "malformed-once.state");
  writeFileSync(driver, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const regularTask = (${JSON.stringify(DEFAULT_TASKS)}).find((id) => prompt.includes("Task:" + id) || prompt.includes("Task: " + id));
const repairTask = /Target task:\\s*([a-z_]+)/u.exec(prompt)?.[1] || null;
const task = regularTask || repairTask;
const master = /dedicated, isolated method-seat explanation worker[^\\n]*\\((master_[a-z0-9_]+)\\)/iu.exec(prompt)?.[1] || null;
const role = /You are the portfolio_manager/i.test(prompt) ? "portfolio_manager"
  : /You are the bull_researcher/i.test(prompt) ? "bull_researcher"
  : /You are the bear_researcher/i.test(prompt) ? "bear_researcher"
  : master || task || "unknown";
const round = Number(/Debate round:\\s*(\\d+)/u.exec(prompt)?.[1] || 0);
const parseRepair = prompt.includes("PARSE-ONLY TRANSPORT REPAIR");
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ role, task, master, round, parseRepair, search: args.includes("--search"), at: Date.now(), pid: process.pid, prompt_chars: prompt.length }) + "\\n");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const lineJson = (prefix) => {
  const line = prompt.split("\\n").find((item) => item.startsWith(prefix));
  return line ? JSON.parse(line.slice(prefix.length)) : [];
};

let packet;
if (task) {
  if (!parseRepair && task === ${JSON.stringify(malformedTask)} && !existsSync(${JSON.stringify(malformedState)})) {
    writeFileSync(${JSON.stringify(malformedState)}, "attempted\\n");
    await sleep(${Number(evidenceDelayMs)});
    writeFileSync(output, "MALFORMED_EVIDENCE_SENTINEL");
    process.exit(0);
  }
  await sleep(${Number(evidenceDelayMs)});
  packet = {
    summary: "ANALYST_SENTINEL_" + task + " with dated evidence and explicit limits.",
    claims: [{ claim: task + " material fixture claim", evidence: "bounded fixture evidence", confidence: "medium", source_ids: ["S1"] }],
    metrics: task === "market_data" ? { price: 512.34, currency: "USD" } : { fixture: 1 },
    sources: [{ id: "S1", title: task + " fixture source", url: "https://example.com/" + task, published_at: "2026-07-28", retrieved_at: "2026-07-28" }],
    open_questions: [], confidence: "medium", information_richness: "B"
  };
} else if (master) {
  await sleep(45);
  const frozenLine = prompt.split("\\n").find((item) => item.startsWith("Frozen method result JSON: "));
  const frozen = JSON.parse(frozenLine.slice("Frozen method result JSON: ".length));
  packet = {
    master,
    acknowledged_stance: frozen.stance,
    statement: "MASTER_SENTINEL_" + master + " explains only the frozen " + frozen.stance + " result.",
    key_findings: ["MASTER_FINDING_" + master],
    disagreements: ["MASTER_DISAGREEMENT_" + master],
    what_would_change_my_mind: ["MASTER_CHANGE_" + master],
    source_ids: ["market_data:S1"],
    confidence: "medium"
  };
} else if (role === "portfolio_manager") {
  await sleep(45);
  packet = {
    verdict: "QQQ fixture Hold after the complete bounded council.", rating: "Hold", winner: "balanced",
    summary: "All required fixture stages completed.", long_thesis: ["operating evidence"], short_thesis: ["valuation risk"],
    valuation_range: "Conditional valuation range tied to evidence and dilution.", catalysts: ["next filing"], risks: ["execution"],
    position: "bounded position only", invalidation: ["verified milestones fail"],
    source_ids: ["market_data:S1", "earnings_deep_dive:S1"], confidence: "medium",
    report_markdown: ${JSON.stringify(fullReportBody())}
  };
} else {
  await sleep(55);
  const ownQuestions = [role + "_Q1", role + "_Q2", role + "_Q3"];
  const preserved = round === 3 ? lineJson("Your round 2 questions to preserve JSON: ") : (round === 2 ? ownQuestions : []);
  const opponent = round === 3 ? lineJson("Questions you must answer JSON: ") : [];
  packet = {
    verdict: role + " round " + round + " fixture case", rating: "Hold", winner: "unknown",
    summary: role + " completed round " + round, long_thesis: ["operating case"], short_thesis: ["risk case"],
    valuation_range: "conditional", catalysts: ["next filing"], risks: ["execution"], position: "bounded",
    invalidation: ["new primary evidence"], source_ids: ["market_data:S1"], confidence: "medium",
    questions: preserved,
    questions_answered: opponent.map((question, index) => ({ question, answer: role + "_A" + (index + 1) + " exact fixture answer" })),
    report_markdown: ""
  };
}
writeFileSync(output, JSON.stringify(packet));
`);
  if (process.platform !== "win32") {
    chmodSync(driver, 0o755);
    return { driver, log };
  }
  const wrapper = join(dataDir, "fake-full-codex.cmd");
  writeFileSync(wrapper, `@"${process.execPath}" "${driver}" %*\r\n`);
  return { driver: wrapper, log };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readJsonl(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("full council proves dedicated master workers, parallel barriers, exact Q&A, display coverage and no-search parse repair", async () => {
  const dataDir = makeDataDir();
  const fake = fakeFullCodex(dataDir);
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const prompt = "Run the complete QQQ full council fixture with every required stage.";
    const confirmed = await confirmMasterSelection(server, {
      symbol: "QQQ", language: "English", prompt, selected_master_ids: SELECTED_MASTERS,
    });
    const runId = `FULL-ANALYSIS-${process.pid}`;
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "English", prompt,
      council_mode: "full", total_timeout_ms: 30_000, timeout_ms: 2_000, synthesis_timeout_ms: 2_000,
      max_concurrency: 1,
      wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
      grounding: {
        quote: {
          price: 512.34, currency: "USD", quote_time: "2026-07-28T20:00:00Z", exchange: "NASDAQ",
          note: "fixture close", source_url: "https://example.com/qqq-quote",
        },
        facts_unavailable: true, unavailable: ["typed facts intentionally omitted by fixture"],
      },
    }, { timeoutMs: 45_000 }));

    const dir = join(dataDir, "runs", runId);
    assert.equal(result.run.status, "complete", JSON.stringify({
      task_status: result.run.task_status,
      master_status: result.run.master_status,
      agent_status: result.run.agent_status,
      quality: result.report_quality,
    }, null, 2));
    assert.equal(result.report_quality.status, "passed", result.report_quality.missing.join("; "));
    assert.equal(result.report_quality.contract_id, "full_v2");
    assert.deepEqual(result.run.tasks, DEFAULT_TASKS);
    assert.equal(result.run.master_opinions.length, SELECTED_MASTERS.length);

    const finalReport = readFileSync(join(dir, "final_report.md"), "utf8");
    const userResponse = readFileSync(join(dir, "user_response.md"), "utf8");
    const allAgents = readFileSync(join(dir, "all_agents.md"), "utf8");
    const artifactIndex = readFileSync(join(dir, "artifact_index.md"), "utf8");
    assert.match(finalReport, /512\.34 USD/);
    assert.match(userResponse, /512\.34 USD/);
    assert.equal((finalReport.match(/alphacouncil:recorded-price-snapshot:v1:begin/g) || []).length, 1);
    assert.match(userResponse, /Recent Company and Industry News/);
    assert.match(userResponse, /2026-07-28 — news_industry_management fixture source/);
    for (const task of DEFAULT_TASKS) {
      assert.match(userResponse, new RegExp("`" + task + "`[\\s\\S]*ANALYST_SENTINEL_" + task));
      assert.match(allAgents, new RegExp(`ANALYST_SENTINEL_${task}`));
      assert.match(artifactIndex, new RegExp(`${task}: .*${task}\\.md`));
      assert.equal(existsSync(join(dir, `${task}.md`)), true, task);
    }
    for (const id of SELECTED_MASTERS) {
      const sentinel = `MASTER_SENTINEL_${id}`;
      assert.match(readFileSync(join(dir, `${id}.md`), "utf8"), new RegExp(sentinel));
      assert.match(finalReport, new RegExp(sentinel));
      assert.match(userResponse, new RegExp(sentinel));
      assert.match(allAgents, new RegExp(sentinel));
      assert.match(artifactIndex, new RegExp(`${id} .*${id}\\.md`));
      assert.equal(result.run.master_status[id].status, "completed");
      assert.equal(result.run.master_status[id].worker_kind, "dedicated_method_worker");
      assert.equal(result.run.master_opinions.find((item) => item.master === id)?.dedicated_worker?.status, "completed");
    }

    const launches = readJsonl(fake.log);
    const evidence = launches.filter((item) => DEFAULT_TASKS.includes(item.role) && !item.parseRepair);
    assert.equal(evidence.length, DEFAULT_TASKS.length);
    assert.ok(Math.max(...evidence.map((item) => item.at)) - Math.min(...evidence.map((item) => item.at)) < 1_000,
      "all eight evidence seats must start in one parallel wave");
    assert.ok(evidence.every((item) => item.search === true), "initial evidence collection keeps native search");
    const repairs = launches.filter((item) => item.parseRepair && item.task === "forward_expectations");
    assert.equal(repairs.length, 1, "malformed evidence gets one bounded parse-only retry");
    assert.equal(repairs[0].search, false, "parse-only repair must not browse or search");

    const masterLaunches = launches.filter((item) => SELECTED_MASTERS.includes(item.master));
    assert.equal(masterLaunches.length, SELECTED_MASTERS.length, "one voice worker per selected v3 master");
    assert.equal(new Set(masterLaunches.map((item) => item.master)).size, SELECTED_MASTERS.length);
    assert.equal(new Set(masterLaunches.map((item) => item.pid)).size, SELECTED_MASTERS.length,
      "each selected method seat must run in its own process");
    assert.ok(Math.max(...masterLaunches.map((item) => item.at)) - Math.min(...masterLaunches.map((item) => item.at)) < 1_000,
      "max_concurrency=1 must not serialize the contract-required method wave");
    assert.ok(masterLaunches.every((item) => item.search === false), "method explanation workers cannot add web facts");

    const roundLaunches = (round) => launches.filter((item) =>
      ["bull_researcher", "bear_researcher"].includes(item.role) && item.round === round && !item.parseRepair);
    for (const round of [1, 2, 3]) {
      const pair = roundLaunches(round);
      assert.equal(pair.length, 2, `round ${round} must contain exactly two sides`);
      assert.ok(Math.abs(pair[0].at - pair[1].at) < 1_000, `round ${round} sides must launch in parallel`);
      assert.ok(pair.every((item) => item.search === false), `round ${round} must use frozen evidence only`);
    }
    assert.ok(Math.min(...roundLaunches(2).map((item) => item.at)) > Math.max(...roundLaunches(1).map((item) => item.at)),
      "round 2 must wait for both round-1 sides");
    assert.ok(Math.min(...roundLaunches(3).map((item) => item.at)) > Math.max(...roundLaunches(2).map((item) => item.at)),
      "round 3 must wait for both round-2 sides");
    const pm = launches.find((item) => item.role === "portfolio_manager" && !item.parseRepair);
    assert.ok(pm.at > Math.max(...roundLaunches(3).map((item) => item.at)), "PM must wait for both round-3 sides");
    assert.equal(pm.search, false);

    const bull = readJson(join(dir, "bull_researcher.json"));
    const bear = readJson(join(dir, "bear_researcher.json"));
    assert.equal(bull.debate_rounds[1].questions.length, 3);
    assert.equal(bear.debate_rounds[1].questions.length, 3);
    assert.deepEqual(bull.debate_rounds[2].questions, bull.debate_rounds[1].questions);
    assert.deepEqual(bear.debate_rounds[2].questions, bear.debate_rounds[1].questions);
    assert.deepEqual(bull.debate_rounds[2].questions_answered.map((item) => item.question), bear.debate_rounds[1].questions);
    assert.deepEqual(bear.debate_rounds[2].questions_answered.map((item) => item.question), bull.debate_rounds[1].questions);
    const events = readJsonl(join(dir, "events.jsonl"));
    assert.equal(events.find((event) => event.type === "debate_qna_gate")?.status, "passed");
    assert.deepEqual(events.filter((event) => event.type === "debate_round").map((event) => event.round), [1, 2, 3]);

    const status = readJson(join(dir, "status.json"));
    assert.equal(status.debate_format, "three_round_cross_exam_parallel_per_round");
    assert.equal(status.master_worker_contract, "one_isolated_worker_per_selected_method_v1");
    assert.equal(status.deadline_enforced, true);
    assert.equal(status.time_budget_ms, 30_000);
    assert.equal(status.deadline_met, true);
    assert.ok(status.elapsed_ms < 30_000, `fixture elapsed ${status.elapsed_ms}ms`);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});

test("a caller-lowered full-council budget fails closed and persists a terminal standard package before its deadline", async () => {
  const dataDir = makeDataDir();
  const fake = fakeFullCodex(dataDir, { evidenceDelayMs: 5_000, malformedTask: null });
  const server = startServer({ dataDir, env: { ALPHACOUNCIL_AGENT_CODEX_CMD: fake.driver } });
  try {
    await server.request("initialize", {});
    const prompt = "Prove a caller-lowered full deadline reaches durable terminal state.";
    const confirmed = await confirmMasterSelection(server, {
      symbol: "QQQ", language: "English", prompt, selected_master_ids: ["master_buffett"],
    });
    const runId = `FULL-DEADLINE-${process.pid}`;
    const started = Date.now();
    const result = structured(await server.callTool("analyze_symbol", {
      symbol: "QQQ", run_id: runId, as_of: "2026-07-28", language: "English", prompt,
      council_mode: "full", total_timeout_ms: 20_000, timeout_ms: 300, synthesis_timeout_ms: 300,
      wait_for_completion: true, selection_receipt: confirmed.selection_receipt,
      grounding: { facts_unavailable: true, unavailable: ["fixture"] },
    }, { timeoutMs: 15_000 }));
    const elapsed = Date.now() - started;
    const dir = join(dataDir, "runs", runId);
    assert.equal(result.run.status, "incomplete");
    assert.ok(elapsed < 20_000, `lowered 20000ms deadline returned after ${elapsed}ms`);
    for (const name of [
      "status.json", "evidence.json", "events.jsonl", "decision.json", "manager_synthesis.json",
      "final_report.md", "user_response.md", "report_quality.json", "artifact_index.md", "all_agents.md",
    ]) assert.equal(existsSync(join(dir, name)), true, name);
    const status = readJson(join(dir, "status.json"));
    assert.ok(["incomplete", "failed"].includes(status.status));
    assert.equal(status.time_budget_ms, 20_000);
    assert.equal(status.deadline_met, true);
    assert.ok(status.elapsed_ms <= 20_000, JSON.stringify(status, null, 2));
    assert.ok(Object.values(result.run.task_status).every((state) =>
      ["failed", "timed_out", "skipped", "completed"].includes(state.status)),
    JSON.stringify(result.run.task_status, null, 2));
    assert.match(readFileSync(join(dir, "user_response.md"), "utf8"), /NEEDS_MANAGER_REVIEW/);
  } finally {
    await server.close();
    removeDataDir(dataDir);
  }
});
