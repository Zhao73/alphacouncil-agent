import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { confirmMasterSelection, startServer, structured } from "../helpers/rpc-client.mjs";
import { completeReport } from "../helpers/fixtures.mjs";

let dataDir;
let server;
const selectedMaster = "master_simons";
const completeRunId = `SELFTEST-VISIBLE-${process.pid}`;
const noPmRunId = `SELFTEST-NOPM-${process.pid}`;
const shortcutRunId = `SELFTEST-SHORTCUT-${process.pid}`;
const languageRunId = `SELFTEST-LANGUAGE-${process.pid}`;
const barrierRunId = `SELFTEST-BARRIER-${process.pid}`;
const recorded = {};

const bullQuestions = [
  "Which operating metric would disprove the long thesis first?",
  "What valuation level compensates for the identified execution risk?",
  "Which dated catalyst can change the market view during this horizon?",
];
const bearQuestions = [
  "Which primary source directly supports the downside scenario described here?",
  "What evidence would show that current valuation already discounts this risk?",
  "Which measurable condition would invalidate the short thesis completely?",
];

const evidencePacket = (summary = "The visible analyst records sufficient English evidence for this integration protocol fixture.", extra = {}) => ({
  summary,
  claims: [],
  metrics: {},
  sources: [],
  open_questions: [],
  confidence: "medium",
  ...extra,
});

function debatePacket(role, round, extra = {}) {
  const ownQuestions = role === "bull_researcher" ? bullQuestions : bearQuestions;
  const opponentQuestions = role === "bull_researcher" ? bearQuestions : bullQuestions;
  return {
    verdict: `${role} provides a fully auditable round ${round} conclusion for the committee.`,
    rating: role === "bull_researcher" ? "Buy" : "Sell",
    winner: role === "bull_researcher" ? "bull" : "bear",
    summary: `The ${role} completes round ${round} with sourced reasoning, explicit uncertainty, and a clear testable conclusion.`,
    long_thesis: role === "bull_researcher" ? ["Operating evidence supports the constructive scenario under the stated conditions."] : [],
    short_thesis: role === "bear_researcher" ? ["Valuation and execution evidence support the cautious scenario under the stated conditions."] : [],
    questions: round >= 2 ? ownQuestions : [],
    questions_answered: round === 3
      ? opponentQuestions.map((question) => ({ question, answer: `The recorded evidence answers this exact question while preserving uncertainty: ${question}` }))
      : [],
    confidence: "medium",
    ...extra,
  };
}

async function selectionReceipt(symbol) {
  const selection = await confirmMasterSelection(server, {
    symbol,
    language: "English",
    selected_master_ids: [selectedMaster],
  });
  return selection.selection_receipt;
}

async function plan(runId, tasks = ["market_data"]) {
  return server.callTool("plan_visible_run", {
    symbol: "NOK",
    language: "English",
    run_id: runId,
    tasks,
    grounding: { facts_unavailable: true },
    selection_receipt: await selectionReceipt("NOK"),
  });
}

async function recordEvidence(runId, task = "market_data", packet = evidencePacket()) {
  return server.callTool("record_visible_packet", {
    run_id: runId,
    task,
    thread_id: `thread-${runId}-${task}`,
    thread_title: `AlphaCouncil Agent NOK ${task} evidence thread`,
    packet,
  });
}

async function recordMaster(runId, packet = {
  master: selectedMaster,
  acknowledged_stance: "out_of_scope",
  statement: "The selected method seat records uncertainty without manufacturing an unsupported investment claim.",
  key_findings: ["The fixture does not contain the required method-specific point-in-time facts."],
  disagreements: [],
  what_would_change_my_mind: ["Provide the missing method-critical facts from dated primary sources."],
  source_ids: [],
  confidence: "low",
}) {
  return server.callTool("record_master_opinion", {
    run_id: runId,
    master: selectedMaster,
    thread_id: `thread-${runId}-master`,
    packet,
  });
}

async function recordRound(runId, role, round, packet = debatePacket(role, round)) {
  return server.callTool("record_visible_decision", {
    run_id: runId,
    role,
    round,
    thread_id: `thread-${runId}-${role}-${round}`,
    thread_title: `AlphaCouncil Agent NOK ${role} round ${round}`,
    packet,
  });
}

async function recordFullDebate(runId) {
  for (const round of [1, 2, 3]) {
    for (const role of ["bull_researcher", "bear_researcher"]) {
      await recordRound(runId, role, round);
    }
  }
}

async function recordPm(runId) {
  return server.callTool("record_visible_decision", {
    run_id: runId,
    role: "portfolio_manager",
    thread_id: `thread-${runId}-pm`,
    thread_title: "AlphaCouncil Agent NOK portfolio manager decision",
    packet: {
      verdict: "The portfolio manager reaches a balanced conclusion after the complete audited debate.",
      rating: "Hold",
      winner: "balanced",
      summary: "The final decision weighs both completed sides, all exact questions, and the recorded evidence.",
      confidence: "medium",
      report_markdown: completeReport,
    },
  });
}

before(async () => {
  dataDir = makeDataDir();
  server = startServer({ dataDir });
  await server.request("initialize", {});

  recorded.plan = structured(await plan(completeRunId));
  await recordEvidence(completeRunId);
  await recordMaster(completeRunId);
  // Round 2 cannot start until both Round-1 sides exist.
  recorded.outOfOrder = await recordRound(completeRunId, "bull_researcher", 2);
  await recordRound(completeRunId, "bull_researcher", 1);
  recorded.idempotent = structured(await recordRound(completeRunId, "bull_researcher", 1));
  recorded.conflict = await recordRound(
    completeRunId,
    "bull_researcher",
    1,
    debatePacket("bull_researcher", 1, { summary: "A conflicting replay attempts to replace the immutable first round with different content." }),
  );
  await recordRound(completeRunId, "bear_researcher", 1);
  recorded.badRoundTwo = await recordRound(
    completeRunId,
    "bull_researcher",
    2,
    debatePacket("bull_researcher", 2, { questions: bullQuestions.slice(0, 2) }),
  );
  for (const role of ["bull_researcher", "bear_researcher"]) await recordRound(completeRunId, role, 2);
  for (const role of ["bull_researcher", "bear_researcher"]) await recordRound(completeRunId, role, 3);
  recorded.pm = structured(await recordPm(completeRunId));
  recorded.pmReplay = structured(await recordPm(completeRunId));

  await plan(noPmRunId);
  await recordEvidence(noPmRunId);
  await recordMaster(noPmRunId);
  await recordFullDebate(noPmRunId);

  await plan(shortcutRunId);
  await recordEvidence(shortcutRunId);
  await recordMaster(shortcutRunId);
  await recordRound(shortcutRunId, "bull_researcher", 1);
  await recordRound(shortcutRunId, "bear_researcher", 1);
  recorded.shortcut = await recordPm(shortcutRunId);

  await plan(languageRunId);
  const languageEvidencePath = join(dataDir, "runs", languageRunId, "evidence.json");
  recorded.beforeWrongEvidence = readFileSync(languageEvidencePath, "utf8");
  recorded.wrongEvidence = await recordEvidence(
    languageRunId,
    "market_data",
    evidencePacket("这是一份完全使用中文撰写的错误语言证据包，不能写入英文运行。"),
  );
  recorded.afterWrongEvidence = readFileSync(languageEvidencePath, "utf8");
  await recordEvidence(languageRunId);
  recorded.beforeWrongMaster = readFileSync(languageEvidencePath, "utf8");
  recorded.wrongMaster = await recordMaster(languageRunId, {
    master: selectedMaster,
    acknowledged_stance: "out_of_scope",
    statement: "这段中文内容不应进入要求英文输出的运行记录。",
    key_findings: ["本方法席无法依据当前证据给出方向性判断。"],
    disagreements: [],
    what_would_change_my_mind: [],
    source_ids: [],
    confidence: "low",
  });
  recorded.afterWrongMaster = readFileSync(languageEvidencePath, "utf8");
  await recordMaster(languageRunId);
  recorded.beforeWrongDebate = readFileSync(languageEvidencePath, "utf8");
  recorded.wrongDebate = await recordRound(
    languageRunId,
    "bull_researcher",
    1,
    debatePacket("bull_researcher", 1, { verdict: "这是一段错误语言的多头发言。", summary: "这段中文内容不得写入英文运行。", long_thesis: [] }),
  );
  recorded.afterWrongDebate = readFileSync(languageEvidencePath, "utf8");

  await plan(barrierRunId);
  recorded.earlyMaster = await recordMaster(barrierRunId);
  await recordEvidence(barrierRunId);
  recorded.earlyDebate = await recordRound(barrierRunId, "bull_researcher", 1);
  recorded.wrongFrozenStance = await recordMaster(barrierRunId, {
    master: selectedMaster,
    acknowledged_stance: "constructive",
    statement: "This packet attempts to replace the frozen deterministic stance and must be rejected.",
    key_findings: [], disagreements: [], what_would_change_my_mind: [], source_ids: [], confidence: "low",
  });
  await recordMaster(barrierRunId);
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

test("full visible completion requires the persisted three-round exact-Q&A chain", () => {
  assert.equal(recorded.pm.status, "complete");
  const dir = join(dataDir, "runs", completeRunId);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.equal(status.completeness, "complete");
  assert.equal(status.visible_debate_contract, "role_round_audit_v1");
  assert.equal(status.visible_debate_rounds_expected, 3);
  assert.deepEqual(status.visible_debate_rounds_recorded, {
    bull_researcher: [1, 2, 3],
    bear_researcher: [1, 2, 3],
  });
  assert.equal(status.visible_debate_qna_gate, "passed");
  for (const role of ["bull_researcher", "bear_researcher"]) {
    for (const round of [1, 2, 3]) assert.ok(existsSync(join(dir, `${role}.round-${round}.json`)));
  }
});

test("a declined seat is planned as a settled record, not as an explanation worker", () => {
  assert.deepEqual(recorded.plan.master_agents, []);
  const declined = recorded.plan.masters_declined.find((seat) => seat.master === selectedMaster);
  assert.ok(declined, "the seat must still appear in the plan as an explicit decline");
  assert.equal(declined.stance, "out_of_scope");
  assert.equal(declined.engine, "v3_method_runtime");
});

test("round ordering, exact questions, and conflicting replay fail closed", () => {
  assert.equal(recorded.outOfOrder.error?.data?.reason, "VISIBLE_DEBATE_ROUND_OUT_OF_ORDER");
  assert.equal(recorded.badRoundTwo.error?.data?.reason, "VISIBLE_DEBATE_QNA_INVALID");
  assert.equal(recorded.idempotent.idempotent_replay, true);
  assert.equal(recorded.conflict.error?.data?.reason, "VISIBLE_DEBATE_ROUND_CONFLICT");
});

// The method barrier itself is covered by gates.test.mjs against a `waiting` seat. It cannot
// be exercised from this fixture any more: its only seat declines deterministically, so it is
// settled before the debate opens and there is nothing left for the barrier to hold back.
test("visible evidence and frozen-stance barriers are enforced server-side", () => {
  assert.equal(recorded.earlyMaster.error?.data?.reason, "VISIBLE_MASTER_EVIDENCE_INCOMPLETE");
  assert.equal(recorded.wrongFrozenStance.error?.data?.reason, "VISIBLE_MASTER_FROZEN_STANCE_MISMATCH");
});

test("a full three-round debate without portfolio_manager remains incomplete", () => {
  const status = JSON.parse(readFileSync(join(dataDir, "runs", noPmRunId, "status.json"), "utf8"));
  assert.equal(status.completeness, "incomplete");
  assert.deepEqual(status.agents.find((agent) => agent.role === "bull_researcher").rounds_completed, [1, 2, 3]);
  assert.equal(status.missing_debate_count, 1);
  assert.equal(existsSync(join(dataDir, "runs", noPmRunId, "manager_synthesis.json")), false);
});

test("single-round plus PM is rejected without writing a decision", () => {
  assert.equal(recorded.shortcut.error?.data?.reason, "VISIBLE_PM_PREREQUISITES_INCOMPLETE");
  const dir = join(dataDir, "runs", shortcutRunId);
  assert.equal(existsSync(join(dir, "manager_synthesis.json")), false);
  assert.equal(existsSync(join(dir, "decision.json")), false);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  assert.notEqual(status.agents.find((agent) => agent.role === "portfolio_manager").status, "completed");
});

test("wrong-language visible packets are structured rejections with no completion write", () => {
  for (const response of [recorded.wrongEvidence, recorded.wrongMaster, recorded.wrongDebate]) {
    assert.equal(response.error?.data?.reason, "READER_LANGUAGE_MISMATCH");
    assert.equal(response.error?.code, -32602);
  }
  assert.equal(recorded.afterWrongEvidence, recorded.beforeWrongEvidence);
  assert.equal(recorded.afterWrongMaster, recorded.beforeWrongMaster);
  assert.equal(recorded.afterWrongDebate, recorded.beforeWrongDebate);
  const dir = join(dataDir, "runs", languageRunId);
  assert.equal(existsSync(join(dir, "bull_researcher.round-1.json")), false);
  const evidence = JSON.parse(readFileSync(join(dir, "evidence.json"), "utf8"));
  assert.match(evidence.packets[0].summary, /visible analyst records sufficient English evidence/);
  assert.doesNotMatch(evidence.master_opinions[0].summary, /这段中文/);
  assert.equal(evidence.master_status[selectedMaster].status, "completed");
  assert.equal(evidence.master_opinions[0].statement_origin, "visible_method_voice_worker");
  assert.equal(evidence.master_opinions[0].dedicated_worker.execution_mode, "visible_host_thread");
  assert.equal(evidence.agent_status.bull_researcher.status, "pending");
});

test("the completed run retains visible provenance and all promised artifacts", () => {
  const dir = join(dataDir, "runs", completeRunId);
  assert.equal(recorded.pm.decision?.thread_id, `thread-${completeRunId}-pm`);
  const trace = readFileSync(join(dir, "all_agents.md"), "utf8");
  assert.match(trace, new RegExp(`thread-${completeRunId}-market_data`));
  assert.match(trace, new RegExp(`thread-${completeRunId}-pm`));
  for (const file of [
    "user_response.md", "artifact_index.md", "report_quality.json", "market_data.md",
    "portfolio_manager.md", "bull_researcher.md", "bear_researcher.md",
  ]) assert.ok(existsSync(join(dir, file)), `visible run did not write ${file}`);
});

test("portfolio-manager completion returns the saved handoff inline, including the final method statement", () => {
  for (const response of [recorded.pm, recorded.pmReplay]) {
    assert.equal(response.handoff_contract, "inline_user_response_v1");
    assert.match(response.user_response_markdown, /Final Per-Seat Method Statements/);
    assert.match(response.user_response_markdown, new RegExp(selectedMaster));
    assert.ok(response.user_response_markdown.trimEnd().endsWith("]"));
  }
  assert.equal(recorded.pmReplay.idempotent_replay, true);
});

test("visible-host status never claims a plugin-enforced deadline or dedicated headless workers", () => {
  const status = JSON.parse(readFileSync(join(dataDir, "runs", completeRunId, "status.json"), "utf8"));
  assert.equal(status.execution_mode, "visible_host_threads");
  assert.equal(status.deadline_enforced, false);
  assert.equal(status.time_budget_ms, null);
  assert.equal(status.deadline_at, null);
  assert.equal(status.remaining_budget_ms, null);
  assert.equal(status.deadline_met, null);
  assert.equal(status.master_worker_contract, "host_managed_not_plugin_enforced");
});
