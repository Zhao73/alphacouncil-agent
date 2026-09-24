import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fakeBackend, fakeSnapshot, isolateHome } from "./helpers.mjs";

isolateHome();
const { research, ask, loadRun, reportPath, recentRun } = await import("../src/core/pipeline.mjs");

test("deep: 4 desks → bull/bear → decision, normalized and reported", async () => {
  const backend = fakeBackend();
  const events = [];
  const run = await research({ symbol: "TEST", language: "zh-CN", question: "值得买吗？", backend, snapshot: await fakeSnapshot(), onEvent: (e) => events.push(e) });
  assert.equal(run.state, "complete");
  assert.equal(run.rating, "Overweight");
  assert.equal(backend.calls.filter((c) => c.tier === "research").length, 4);
  assert.ok(backend.calls.filter((c) => c.tier === "research").every((c) => c.web && c.schema));
  assert.equal(backend.calls.filter((c) => c.tier === "debate").length, 2);
  // Unsourced finding dropped, bad source dropped, unknown citations removed, valuation ordered.
  assert.equal(run.desks.business.findings.length, 3);
  assert.deepEqual(run.desks.business.findings[2].sources, ["data:quote"]);
  assert.equal(run.desks.business.sources.length, 1);
  assert.deepEqual(run.cases.bull.points[1].evidence, ["lens:garp"]);
  assert.deepEqual(run.decision.key_sources, ["business:S1", "data:quote"]);
  assert.deepEqual([run.decision.valuation.bear, run.decision.valuation.base, run.decision.valuation.bull], [80, 115, 140]);
  assert.ok(run.warnings.decision.some((w) => /re-ordered/.test(w)));
  assert.ok(Math.abs(run.cost_usd - 0.7) < 1e-9);
  // Events a UI needs.
  assert.deepEqual([...new Set(events.filter((e) => e.type === "stage").map((e) => e.stage))], ["snapshot", "desks", "debate", "decision"]);
  assert.ok(events.some((e) => e.type === "activity" && e.task === "street"));
  assert.equal(events.at(-1).type, "done");
  const md = readFileSync(reportPath(run.run_id), "utf8");
  for (const h of ["## 结论", "## 多空对决", "## 估值与价格条件", "## 研究台发现", "## 方法透镜", "## 来源"]) assert.ok(md.includes(h), h);
  assert.match(md, /\+15%/);
  const loaded = loadRun(run.run_id);
  assert.equal(loaded.decision.rating, "Overweight");
});

test("fast: one combined desk, no debate", async () => {
  const backend = fakeBackend();
  const run = await research({ symbol: "TEST", mode: "fast", backend, snapshot: await fakeSnapshot() });
  assert.equal(run.state, "complete");
  assert.deepEqual(Object.keys(run.desks), ["all"]);
  assert.equal(run.cases, null);
  assert.equal(backend.calls.length, 2);
});

test("a failed desk and a failed side degrade the run but still decide", async () => {
  const run = await research({ symbol: "TEST", backend: fakeBackend({ fail: ["Positioning & risk", "bear"] }), snapshot: await fakeSnapshot() });
  assert.equal(run.state, "degraded");
  assert.equal(run.desks.risk, null);
  assert.equal(run.cases.bear, null);
  assert.match(run.failures.risk, /exploded/);
  const md = readFileSync(reportPath(run.run_id), "utf8");
  assert.match(md, /risk: desk failed/);
});

test("too little coverage ends incomplete without a decision call", async () => {
  const backend = fakeBackend({ fail: ["Business & earnings", "Expectations & valuation", "News, industry & catalysts"] });
  const run = await research({ symbol: "TEST", backend, snapshot: await fakeSnapshot() });
  assert.equal(run.state, "incomplete");
  assert.match(run.reason, /coverage/);
  assert.equal(backend.calls.some((c) => c.tier === "decision"), false);
  assert.ok(existsSync(reportPath(run.run_id)));
});

test("follow-up questions are answered from the report and remembered", async () => {
  const backend = fakeBackend();
  const run = await research({ symbol: "TEST", backend, snapshot: await fakeSnapshot() });
  const a = await ask({ runId: run.run_id, question: "What if rates rise?", backend });
  assert.match(a.text, /rates rise/);
  await ask({ runId: run.run_id, question: "And the dividend?", backend });
  const last = backend.calls.at(-1);
  assert.equal(last.tier, "chat");
  assert.match(last.user, /# Report/);
  assert.match(last.user, /Q: What if rates rise\?/);
});

test("recent finished runs are found for reuse", async () => {
  const run = await research({ symbol: "REUSE", backend: fakeBackend(), snapshot: await fakeSnapshot("REUSE") });
  assert.equal(recentRun({ symbol: "reuse", mode: "deep", language: "en" }).run_id, run.run_id);
  assert.equal(recentRun({ symbol: "reuse", mode: "fast", language: "en" }), null);
});
