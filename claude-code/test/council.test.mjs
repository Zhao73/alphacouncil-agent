import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { debatePacket, evidencePacket, fakeGrounding, isolateHome, pmPacket } from "./helpers.mjs";

isolateHome();
const council = await import("../lib/council.mjs");

async function start(opts = {}) {
  const { run } = await council.startCouncil({ symbol: "TEST", grounding: fakeGrounding(), ...opts });
  return run.run_id;
}

function recordRound(runId, round) {
  const q = (role) => {
    const p = JSON.parse(readFileSync(join(process.env.ALPHACOUNCIL_HOME, "runs", runId, "packets", "debate", "r2", `${role}.json`), "utf8"));
    return p.packet.questions;
  };
  for (const [role, side, opp] of [["bull_researcher", "bull", "bear_researcher"], ["bear_researcher", "bear", "bull_researcher"]]) {
    const r = council.recordPacket(runId, { role, stage: "debate", round, packet: debatePacket(round, side, round === 3 ? q(opp) : []) });
    assert.ok(r.ok, JSON.stringify(r.errors));
  }
}

test("full run walks evidence -> 3 rounds -> pm -> complete report", async () => {
  const runId = await start({ language: "zh-CN" });
  let next = council.nextTasks(runId);
  assert.equal(next.stage, "evidence");
  assert.equal(next.tasks.length, 8);
  assert.match(next.tasks[0].prompt, /council_record/);
  assert.match(next.tasks[0].prompt, /Frozen grounding facts/);
  assert.match(next.tasks[0].handoff, /council_brief/);
  assert.equal(council.taskBrief(runId, next.tasks[0].task_id), next.tasks[0].prompt);
  for (const t of next.tasks) assert.ok(council.recordPacket(runId, { role: t.role, stage: "evidence", packet: evidencePacket(t.role) }).ok);

  // PM cannot record before the debate.
  const early = council.recordPacket(runId, { role: "portfolio_manager", stage: "pm", packet: pmPacket() });
  assert.equal(early.ok, false);
  assert.match(early.errors[0], /not open/);

  for (let r = 1; r <= 3; r += 1) {
    next = council.nextTasks(runId);
    assert.equal(next.stage, "debate");
    assert.equal(next.round, r);
    assert.deepEqual(next.tasks.map((t) => t.role).sort(), ["bear_researcher", "bull_researcher"]);
    recordRound(runId, r);
  }
  next = council.nextTasks(runId);
  assert.equal(next.stage, "pm");
  assert.match(next.tasks[0].prompt, /Deterministic method lenses/);
  assert.ok(council.recordPacket(runId, { role: "portfolio_manager", stage: "pm", packet: pmPacket() }).ok);
  next = council.nextTasks(runId);
  assert.equal(next.done, true);
  const fin = council.finalizeCouncil(runId);
  assert.equal(fin.state, "complete");
  assert.equal(fin.rating, "Overweight");
  const report = readFileSync(fin.files.report, "utf8");
  for (const heading of ["结论与评级", "分析师工作日志", "方法透镜席位", "多空辩论记录", "估值区间", "分周期观点", "数据缺口", "来源表"]) assert.match(report, new RegExp(heading));
  assert.equal(fin.quality.unresolved_citations.length, 0);
  assert.equal(fin.quality.passed, true);
});

test("round-3 answers must match the opponent's round-2 question IDs", async () => {
  const runId = await start();
  for (const t of council.nextTasks(runId).tasks) council.recordPacket(runId, { role: t.role, stage: "evidence", packet: evidencePacket(t.role) });
  for (let r = 1; r <= 2; r += 1) {
    council.nextTasks(runId);
    recordRound(runId, r);
  }
  council.nextTasks(runId);
  const bad = council.recordPacket(runId, { role: "bull_researcher", stage: "debate", round: 3, packet: debatePacket(3, "bull", [{ id: "Q1" }]) });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /Q2/.test(e)));
});

test("unknown citations and bad local source references are rejected with repair hints", async () => {
  const runId = await start();
  council.nextTasks(runId);
  const p = evidencePacket("market_data");
  p.findings[0].sources = ["S9"];
  const r = council.recordPacket(runId, { role: "market_data", stage: "evidence", packet: JSON.stringify(p) });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /S9/.test(e)));
});

test("a seat that never records is repaired once, then failed; low coverage ends incomplete", async () => {
  const runId = await start({ mode: "quick" });
  let next = council.nextTasks(runId);
  assert.equal(next.tasks.length, 4);
  council.recordPacket(runId, { role: "earnings_deep_dive", stage: "evidence", packet: evidencePacket("earnings_deep_dive") });
  council.recordPacket(runId, { role: "news_industry_management", stage: "evidence", packet: evidencePacket("news_industry_management") });
  next = council.nextTasks(runId);
  assert.deepEqual(next.tasks.map((t) => [t.role, t.attempt]).sort(), [["market_data", 2], ["valuation_long_short", 2]]);
  assert.match(next.tasks[0].prompt, /REPAIR/);
  next = council.nextTasks(runId);
  assert.equal(next.done, true);
  assert.match(next.reason, /coverage/);
  const fin = council.finalizeCouncil(runId, { reason: next.reason });
  assert.equal(fin.state, "incomplete");
  const report = readFileSync(fin.files.report, "utf8");
  assert.match(report, /market_data — seat failed/);
});

test("quick run with one failed optional seat finishes degraded, with 1 debate round", async () => {
  const runId = await start({ mode: "quick" });
  let next = council.nextTasks(runId);
  for (const t of next.tasks) if (t.role !== "news_industry_management") council.recordPacket(runId, { role: t.role, stage: "evidence", packet: evidencePacket(t.role) });
  next = council.nextTasks(runId); // repair news
  assert.equal(next.tasks.length, 1);
  next = council.nextTasks(runId); // news failed -> debate r1
  assert.equal(next.stage, "debate");
  recordRound(runId, 1);
  next = council.nextTasks(runId);
  assert.equal(next.stage, "pm");
  const pm = pmPacket();
  delete pm.horizons;
  assert.ok(council.recordPacket(runId, { role: "portfolio_manager", stage: "pm", packet: pm }).ok);
  assert.equal(council.nextTasks(runId).done, true);
  const fin = council.finalizeCouncil(runId);
  assert.equal(fin.state, "degraded");
  assert.ok(existsSync(fin.files.handoff));
  // A finalized run accepts nothing more.
  assert.equal(council.recordPacket(runId, { role: "portfolio_manager", stage: "pm", packet: pm }).ok, false);
});

test("the deadline stops an executor-enforced run", async () => {
  const runId = await start({ enforceDeadline: true });
  const path = join(process.env.ALPHACOUNCIL_HOME, "runs", runId, "run.json");
  const run = JSON.parse(readFileSync(path, "utf8"));
  run.deadline_at = new Date(Date.now() - 1000).toISOString();
  const { writeJson } = await import("../lib/store.mjs");
  writeJson(path, run);
  const next = council.nextTasks(runId);
  assert.equal(next.done, true);
  assert.match(next.reason, /deadline/);
});
