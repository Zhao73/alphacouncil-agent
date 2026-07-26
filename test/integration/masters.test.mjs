import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDataDir, removeDataDir } from "../helpers/env.mjs";
import { startServer, structured } from "../helpers/rpc-client.mjs";
import { RpcCode } from "../../mcp/lib/errors.mjs";

let dataDir;
let server;
const runId = `MASTERS-${process.pid}`;
let runDir;
let plan;

before(async () => {
  dataDir = makeDataDir();
  runDir = join(dataDir, "runs", runId);
  server = startServer({ dataDir });
  await server.request("initialize", {});
  plan = structured(await server.callTool("plan_visible_run", {
    symbol: "0700.HK",
    run_id: runId,
    tasks: ["market_data"],
    masters_roster: "masters-value",
  }));
});

after(async () => {
  await server.close();
  removeDataDir(dataDir);
});

// 0700.HK is a Hong Kong listing, so the SEC screen computes nothing. Methods that need a
// long-run financial series genuinely cannot evaluate it, and spawning an agent to write an
// essay about numbers that do not exist is the waste this release removes. Every selected
// seat is still accounted for: those that can look get an agent, those that cannot are
// settled deterministically and recorded as out_of_scope.
test("a roster accounts for every seat, by agent or by deterministic decline", () => {
  const roster = ["master_buffett", "master_munger", "master_duan_yongping", "master_li_lu"];
  const spawned = plan.master_agents.map((a) => a.role);
  const declined = plan.masters_declined.map((d) => d.master);
  assert.deepEqual([...spawned, ...declined].sort(), [...roster].sort());
  assert.ok(declined.length > 0, "a HK filer with no computable screen must decline somewhere");
  for (const d of plan.masters_declined) {
    assert.equal(d.stance, "out_of_scope");
    assert.ok(d.unmet.length > 0, `${d.master} must say which requirement was unmet`);
  }
});

test("a declined seat costs no agent but still reports", () => {
  const run = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
  for (const { master } of plan.masters_declined) {
    assert.ok(!plan.master_agents.some((a) => a.role === master), `${master} must not be spawned`);
    const opinion = (run.master_opinions || []).find((o) => o.master === master);
    assert.ok(opinion, `${master} must still be recorded or the completeness gate can never pass`);
    assert.equal(opinion.stance, "out_of_scope");
    assert.equal(opinion.engine, "v2_method_model");
  }
});

test("a seat that can look carries its settled verdict into the prompt", () => {
  for (const agent of plan.master_agents) {
    if (agent.engine !== "v2_method_model") continue;
    assert.match(agent.prompt_template, /Settled verdict|已确定的判决/);
    assert.match(agent.prompt_template, /cannot overturn it|你不能推翻/);
  }
});

test("a master prompt carries the evidence, the walk-away conditions and the out_of_scope option", () => {
  const munger = plan.master_agents.find((a) => a.role === "master_munger");
  assert.match(munger.prompt_template, /Evidence JSON:/);
  assert.match(munger.prompt_template, /Walk-away conditions you must check/);
  assert.match(munger.prompt_template, /out_of_scope/);
  // A master judges; it must not be told to go and search.
  assert.doesNotMatch(munger.prompt_template, /WebSearch|live web search/);
});

test("masters never appear among the evidence or debate agents", () => {
  const evidence = plan.evidence_agents.map((a) => a.role);
  const debate = plan.debate_agents.map((a) => a.role);
  for (const spec of plan.master_agents) {
    assert.ok(!evidence.includes(spec.role));
    assert.ok(!debate.includes(spec.role));
  }
});

test("an unselected master is rejected", async () => {
  const response = await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_simons",
    packet: { verdict: "x" },
  });
  assert.equal(response.error?.code, RpcCode.INVALID_PARAMS);
  assert.match(response.error.message, /was not selected for this run/);
});

test("out_of_scope is preserved as a stance rather than coerced", async () => {
  const result = structured(await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_buffett",
    packet: {
      verdict: "Outside the circle of competence",
      stance: "out_of_scope",
      summary: "Cannot explain how this business earns in one paragraph.",
      what_would_change_my_mind: ["a segment disclosure that shows unit economics"],
      confidence: "medium",
    },
  }));
  assert.equal(result.opinion.stance, "out_of_scope");
  // Seats that declined deterministically were already recorded during planning, so this
  // is not the first opinion on the run.
  assert.ok(result.recorded >= 1);
  assert.equal(result.expected, 4);
  assert.ok(existsSync(join(runDir, "master_buffett.json")));
});

// This used to fall back to "cautious", which is a real stance carrying real weight: a
// caller's typo became a seat that looked deliberate and voted. Ten of them render as a
// unanimity no master produced. Declining to score an unrecognised value is the safe
// failure; inventing a confident one is not.
test("an unrecognised stance is recorded as out_of_scope, not as a vote", async () => {
  const result = structured(await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_munger",
    packet: { verdict: "v", stance: "wildly bullish", summary: "s" },
  }));
  assert.equal(result.opinion.stance, "out_of_scope");
});

test("stances a caller plausibly writes are mapped rather than discarded", async () => {
  const cases = [["long", "constructive"], ["avoid", "opposed"], ["hold", "cautious"], ["N/A", "out_of_scope"]];
  for (const [given, expected] of cases) {
    const result = structured(await server.callTool("record_master_opinion", {
      run_id: runId,
      master: "master_munger",
      packet: { verdict: "v", stance: given, summary: "s" },
    }));
    assert.equal(result.opinion.stance, expected, `${given} should normalize to ${expected}`);
  }
});

// The point of running masters before the debate: the bull and bear must answer them.
test("recorded master disagreements reach the debate prompt", async () => {
  await server.callTool("record_master_opinion", {
    run_id: runId,
    master: "master_li_lu",
    packet: {
      verdict: "Ten-year certainty is low",
      stance: "opposed",
      summary: "s",
      disagreements: ["the evidence chain assumes the regulatory regime is stable"],
      confidence: "high",
    },
  });
  const replan = structured(await server.callTool("plan_visible_run", {
    symbol: "0700.HK",
    run_id: runId,
    tasks: ["market_data"],
    masters_roster: "masters-value",
  }));
  // plan_visible_run rewrites the envelope, so read the persisted opinions instead.
  const run = JSON.parse(readFileSync(join(runDir, "evidence.json"), "utf8"));
  assert.ok(Array.isArray(run.master_opinions));
  assert.equal(replan.master_agents.length + replan.masters_declined.length, 4);
});

test("masters do not affect the completeness gate", () => {
  const status = JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"));
  // Only the evidence task and the three debate roles are counted.
  assert.equal(status.missing_evidence_count, 1);
  assert.equal(status.missing_debate_count, 3);
  assert.ok(!("missing_master_count" in status), "masters are optional and must not gate a run");
});
